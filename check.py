#!/usr/bin/env python3
"""NU7 readiness checker: reads targets.json, asks GitHub and a public Zcash explorer, writes data/status.json.

Read-only by construction: HTTP GETs only (GitHub REST, Blockchair stats). Nothing is posted, signed or sent.
Python stdlib only. A GITHUB_TOKEN in the environment raises GitHub's rate limit; none is needed for a run or two.

Usage: python3 -I check.py [--targets targets.json] [--out data/status.json]
"""
from __future__ import annotations

import datetime as dt
import json
import os
import re
import sys
import urllib.request
from typing import Any, Callable

NU7_HEIGHT = 3_543_405  # ZIP 259, Mainnet
NU7_BRANCH_ID = "0x77190AD9"
PRE_NU7_BLOCK_SECONDS = 75
CHAIN_STATS = "https://api.blockchair.com/zcash/stats"  # keyless; its terms allow non-commercial projects
UA = "cryppit-nu7-readiness/1 (read-only; github.com/cryppit/nu7-readiness)"
STATUSES = ("fixed", "in-review", "broken", "watch", "unknown")

Fetch = Callable[[str], Any]


def http_json(url: str) -> Any:
    headers = {"User-Agent": UA, "Accept": "application/vnd.github+json" if "api.github.com" in url else "application/json"}
    token = os.environ.get("GITHUB_TOKEN")
    if token and url.startswith("https://api.github.com/"):
        headers["Authorization"] = f"Bearer {token}"
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=30) as r:
        # A source file (raw.githubusercontent.com) comes back as text, everything else as JSON.
        return r.read().decode() if url.startswith("https://raw.githubusercontent.com/") else json.load(r)


def api_url(kind: str, ref: str) -> tuple[str, str]:
    """(fetch URL, human URL) for `owner/repo#n` (issue or PR), `owner/repo@tag` (release) or `owner/repo:path` (a
    file on the default branch)."""
    if kind == "release":
        repo, tag = ref.split("@", 1)
        return f"https://api.github.com/repos/{repo}/releases/tags/{tag}", f"https://github.com/{repo}/releases/tag/{tag}"
    if kind == "code":
        repo, path = ref.split(":", 1)
        return f"https://raw.githubusercontent.com/{repo}/HEAD/{path}", f"https://github.com/{repo}/blob/HEAD/{path}"
    repo, n = ref.split("#", 1)
    if kind == "fix":
        return f"https://api.github.com/repos/{repo}/pulls/{n}", f"https://github.com/{repo}/pull/{n}"
    return f"https://api.github.com/repos/{repo}/issues/{n}", f"https://github.com/{repo}/issues/{n}"


def signal_state(kind: str, obj: Any, pattern: str | None = None) -> str:
    if kind == "code":
        return "found" if re.search(pattern or "", obj) else "not_found"
    if kind == "release":
        return "released" if obj.get("tag_name") and not obj.get("draft") else "absent"
    if kind == "fix":
        if obj.get("merged_at"):
            return "merged"
        return "open" if obj.get("state") == "open" else "closed"
    if obj.get("state") == "open":
        return "open"
    return "completed" if obj.get("state_reason") in (None, "completed") else "not_planned"


def row_status(signals: list[dict]) -> str:
    """The row's verdict from its evidence. A merged fix or a published release means fixed upstream (a release or a
    deploy may still be pending); an open fix means in review; an open blocker with no fix means broken. A failed
    lookup never counts as evidence either way. Code evidence: a pattern that `means` fixed (or broken) is found, or
    not. A manual report decides the row only when it `means` fixed (a maintainer saying it works with no change).
    Context links are shown but never decide the row."""
    states = [(s["kind"], s["state"], s.get("means")) for s in signals if s["kind"] != "context"]
    fixed = any(st in ("merged", "released") or (k == "code" and m == "fixed" and st == "found")
                or (k == "manual" and m == "fixed") for k, st, m in states)
    if fixed:
        return "fixed"
    if any(k == "fix" and st == "open" for k, st, _ in states):
        return "in-review"
    if any((k == "blocker" and st == "open") or (k == "code" and (m, st) in (("broken", "found"), ("fixed", "not_found")))
           for k, st, m in states):
        return "broken"
    blockers = [st for k, st, _ in states if k == "blocker"]
    if blockers and all(st == "completed" for st in blockers) and not any(st == "error" for _, st, _ in states):
        return "fixed"
    if (any(st == "not_planned" or k == "manual" or (k == "code" and st == "not_found") for k, st, _ in states)
            or len(states) < len(signals)):
        return "watch"
    return "unknown"


def countdown(tip: int, now: dt.datetime) -> dict:
    left = max(0, NU7_HEIGHT - tip)
    eta = now + dt.timedelta(seconds=left * PRE_NU7_BLOCK_SECONDS)
    return {"tip": tip, "height": NU7_HEIGHT, "blocks_left": left, "active": tip >= NU7_HEIGHT,
            "eta_utc": eta.strftime("%Y-%m-%dT%H:%M:%SZ")}


def iso(t: dt.datetime) -> str:
    return t.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def evaluate(targets: dict, fetch: Fetch, now: dt.datetime) -> dict:
    rows = []
    for row in targets["rows"]:
        signals = []
        for sig in row["signals"]:
            kind = sig["kind"]
            if kind == "manual":
                out = {"kind": kind, "state": "noted", "label": sig["label"], "url": sig["url"], "checked": sig["checked"]}
                if "means" in sig:
                    out["means"] = sig["means"]
                signals.append(out)
                continue
            api, url = api_url(kind, sig["ref"])
            out = {"kind": kind, "ref": sig["ref"], "url": url, "label": sig.get("label")}
            if kind == "code":
                out["means"] = sig["means"]
            try:
                obj = fetch(api)
                out["state"] = signal_state(kind, obj, sig.get("pattern"))
                if isinstance(obj, dict):
                    out["title"] = obj.get("title") or obj.get("name") or obj.get("tag_name")
                    out["updated_at"] = obj.get("updated_at") or obj.get("published_at")
            except Exception as e:  # noqa: BLE001  (any failure is reported, never guessed)
                out["state"] = "error"
                out["error"] = re.sub(r"\s+", " ", str(e))[:160]
            signals.append(out)
        rows.append({**{k: row[k] for k in ("id", "name", "category", "note")}, "status": row_status(signals), "signals": signals})
    try:
        chain = countdown(int(fetch(CHAIN_STATS)["data"]["best_block_height"]), now)
    except Exception as e:  # noqa: BLE001
        chain = {"tip": None, "height": NU7_HEIGHT, "error": str(e)[:160]}
    counts = {s: sum(1 for r in rows if r["status"] == s) for s in STATUSES}
    return {"checked_at": iso(now), "branch_id": NU7_BRANCH_ID, "chain": chain, "counts": counts, "rows": rows}


def main(argv: list[str]) -> int:
    def arg(name: str, default: str) -> str:
        return argv[argv.index(name) + 1] if name in argv else default

    targets_path, out_path = arg("--targets", "targets.json"), arg("--out", "data/status.json")
    with open(targets_path) as f:
        targets = json.load(f)
    result = evaluate(targets, http_json, dt.datetime.now(dt.timezone.utc))
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(result, f, indent=1)
        f.write("\n")
    errors = [s["ref"] for r in result["rows"] for s in r["signals"] if s.get("state") == "error"]
    print(f"{len(result['rows'])} rows: {result['counts']}; chain {result['chain'].get('tip')}; errors: {errors or 'none'}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
