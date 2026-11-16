#!/usr/bin/env python3
"""The board's once-a-day jobs, run by .github/workflows/daily.yml. Python stdlib only.

  snapshot  save today's statuses to history/YYYY-MM-DD.json (the daily commit also keeps GitHub's scheduler alive:
            it turns scheduled workflows off after 60 days without repository activity)
  publish   build data/changes.json (every status move between daily snapshots) and feed.xml (Atom) for the page
  discover  search public GitHub for new issues and PRs that mention NU7 and open one issue listing the ones we have
            not seen, for a person to review. It never changes a row: a wrong "Fixed" is worse than a late one.
  watchdog  open (or update) a "[watchdog]" issue when a lookup failed, the chain height is missing or stuck, a daily
            snapshot was missed or the published data is over 24 hours old; close it again once everything is healthy

Reads GitHub and the board's own published data only. Writes files under history/ and _site/, and issues in this repo.
"""
from __future__ import annotations

import datetime as dt
import glob
import json
import os
import sys
import urllib.parse
import urllib.request
from typing import Any
from xml.sax.saxutils import escape

STATUSES = ("fixed", "in-review", "broken", "watch", "unknown")
LABEL = {"fixed": "Fixed", "in-review": "In review", "broken": "Broken", "watch": "Watch", "unknown": "Unknown"}
SITE = "https://cryppit.github.io/nu7-readiness/"
UA = "cryppit-nu7-readiness/1 (read-only; github.com/cryppit/nu7-readiness)"
OWN_REPO = "cryppit/nu7-readiness"
# Each query is limited to items created since the last run. Tried on 16 Nov: these found real candidates (Flux SSP,
# GLEEC coins, Nozy, Hosh) with some noise (docs and portfolio sites), which a person filters.
QUERIES = ("77190ad9", "NU7 zcash", "NU7 ZEC", 'zcash "v4 transaction"', 'zcash "branch id"')
MAX_EVENTS = 300
MAX_SEEN = 5000
STALE_HOURS = 24
MON = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
WATCHDOG = "[watchdog]"


# ---------- snapshots, changes and the feed (pure) ----------

def snapshot(status: dict) -> dict:
    return {
        "date": status["checked_at"][:10],
        "checked_at": status["checked_at"],
        "tip": (status.get("chain") or {}).get("tip"),
        "counts": {s: status["counts"].get(s, 0) for s in STATUSES},
        "rows": {r["id"]: {"status": r["status"], "name": r["name"]} for r in status["rows"]},
    }


def diff(prev: dict, cur: dict) -> list[dict]:
    """Status moves from one snapshot to the next; a row that appears comes `from` None, one that goes `to` None."""
    out = []
    for rid in sorted(set(prev["rows"]) | set(cur["rows"])):
        a, b = prev["rows"].get(rid), cur["rows"].get(rid)
        if a and b and a["status"] == b["status"]:
            continue
        out.append({"date": cur["date"], "id": rid, "name": (b or a)["name"],
                    "from": a["status"] if a else None, "to": b["status"] if b else None})
    return out


def changes(snaps: list[dict]) -> dict:
    snaps = sorted(snaps, key=lambda s: s["date"])
    events = [e for a, b in zip(snaps, snaps[1:]) for e in diff(a, b)]
    events.sort(key=lambda e: e["date"], reverse=True)  # stable: names stay in order within a day
    return {"since": snaps[0]["date"] if snaps else None, "latest": snaps[-1]["date"] if snaps else None,
            "events": events[:MAX_EVENTS]}


def long_day(d: str) -> str:
    y, m, dd = d.split("-")
    return f"{int(dd)} {MON[int(m) - 1]} {y}"


def describe(e: dict) -> str:
    if e["from"] is None:
        return f"{e['name']}: added to the board as {LABEL.get(e['to'], e['to'])}"
    if e["to"] is None:
        return f"{e['name']}: removed from the board (was {LABEL.get(e['from'], e['from'])})"
    return f"{e['name']}: {LABEL.get(e['from'], e['from'])} → {LABEL.get(e['to'], e['to'])}"


def iso(t: dt.datetime) -> str:
    return t.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def atom(events: list[dict], now: dt.datetime) -> str:
    days: dict[str, list[dict]] = {}
    for e in events:
        days.setdefault(e["date"], []).append(e)
    parts = ['<?xml version="1.0" encoding="utf-8"?>',
             '<feed xmlns="http://www.w3.org/2005/Atom">',
             "<title>NU7 readiness: status changes</title>",
             "<subtitle>Zcash wallets, libraries, bridges and swaps whose NU7 status changed, from the daily snapshot. "
             "By Cryppit.</subtitle>",
             f'<link rel="alternate" href="{SITE}"/>',
             f'<link rel="self" href="{SITE}feed.xml"/>',
             "<id>tag:cryppit.github.io,2026:nu7-readiness/changes</id>",
             f"<updated>{iso(now)}</updated>",
             "<author><name>Cryppit</name></author>"]
    for d in sorted(days, reverse=True):
        evs = days[d]
        n = len(evs)
        lines = "\n".join(describe(e) for e in evs)
        parts += ["<entry>",
                  f"<title>{long_day(d)}: {n} status change{'s' if n != 1 else ''}</title>",
                  f"<id>tag:cryppit.github.io,2026:nu7-readiness/changes/{d}</id>",
                  f"<updated>{d}T00:00:00Z</updated>",
                  f'<link rel="alternate" href="{SITE}board.html"/>',
                  f'<content type="text">{escape(lines)}\n\nEvidence for every row: {SITE}board.html</content>',
                  "</entry>"]
    parts.append("</feed>")
    return "\n".join(parts) + "\n"


# ---------- discovery (pure) ----------

def tracked(targets: dict) -> tuple[set[str], set[str]]:
    """(issue and PR refs the board already cites, repos the board already follows)."""
    refs, repos = set(), set()
    for row in targets["rows"]:
        for s in row["signals"]:
            ref = s.get("ref")
            if not ref:
                continue
            if "#" in ref:
                refs.add(ref)
            repos.add(ref.split("#")[0].split("@")[0].split(":")[0])
    return refs, repos


def candidates(items: list[dict], targets: dict, seen: set[str]) -> list[dict]:
    refs, repos = tracked(targets)
    out, keys = [], set()
    for it in items:
        repo = it["repository_url"].split("/repos/", 1)[1]
        key = f"{repo}#{it['number']}"
        if repo == OWN_REPO or key in refs or key in seen or key in keys:
            continue
        keys.add(key)
        out.append({"key": key, "url": it["html_url"], "title": it["title"], "created": it["created_at"][:10],
                    "on_board": repo in repos, "kind": "PR" if "pull_request" in it else "issue"})
    return out


def discovery_body(cands: list[dict], date: str) -> str:
    def lines(group: list[dict]) -> list[str]:
        return [f"- [ ] {c['kind']} [{c['key']}]({c['url']}): {c['title']} ({c['created']})" for c in group]

    on, new = [c for c in cands if c["on_board"]], [c for c in cands if not c["on_board"]]
    body = [f"The daily scan on {date} found public GitHub items that mention NU7 and that the board does not cite yet. "
            "They are not reviewed: many are docs or unrelated. For each one, open it and decide whether it changes a "
            "row, needs a new row, or can be ignored. Close this issue when done.", ""]
    if on:
        body += ["### Repos already on the board", *lines(on), ""]
    if new:
        body += ["### New repos", *lines(new), ""]
    body.append(f"Searches: {', '.join(f'`{q}`' for q in QUERIES)}.")
    return "\n".join(body)


# ---------- watchdog (pure) ----------

def health(status: dict, prev: dict | None, live_checked_at: str | None, now: dt.datetime) -> list[str]:
    problems = []
    errors = [s.get("ref") or s.get("url") for r in status["rows"] for s in r["signals"] if s.get("state") == "error"]
    if errors:
        problems.append(f"{len(errors)} lookup(s) failed: {', '.join(errors)}")
    unknown = [r["id"] for r in status["rows"] if r["status"] == "unknown"]
    if unknown:
        problems.append(f"rows with no verdict: {', '.join(unknown)}")
    tip = (status.get("chain") or {}).get("tip")
    if tip is None:
        problems.append("the chain height could not be read (Blockchair)")
    elif prev and prev.get("tip") == tip:
        problems.append(f"the chain height did not move since the {prev['date']} snapshot ({tip:,})")
    today = dt.date.fromisoformat(status["checked_at"][:10])
    if prev and (today - dt.date.fromisoformat(prev["date"])).days > 1:
        problems.append(f"the daily snapshot was missed: the previous one is from {prev['date']}")
    if live_checked_at is None:
        problems.append(f"the published board data could not be read ({SITE}data/status.json)")
    else:
        age = (now - dt.datetime.fromisoformat(live_checked_at.replace("Z", "+00:00"))).total_seconds() / 3600
        if age > STALE_HOURS:
            problems.append(f"the published board data is {int(age)} hours old: the scheduled publish job has not run since")
    return problems


# ---------- I/O ----------

def http(method: str, url: str, body: Any = None, auth: bool = True) -> Any:
    headers = {"User-Agent": UA, "Accept": "application/vnd.github+json" if "api.github.com" in url else "application/json"}
    token = os.environ.get("GITHUB_TOKEN")
    if auth and token and url.startswith("https://api.github.com/"):
        headers["Authorization"] = f"Bearer {token}"
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=30) as r:
        raw = r.read()
        return json.loads(raw) if raw else None


def gh(method: str, path: str, body: Any = None) -> Any:
    return http(method, f"https://api.github.com/{path}", body)


def read_json(path: str, default: Any = None) -> Any:
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def write_json(path: str, obj: Any, indent: int | None = 1) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w") as f:
        json.dump(obj, f, indent=indent, ensure_ascii=False)
        f.write("\n")


def load_snaps(d: str) -> list[dict]:
    return [read_json(p) for p in sorted(glob.glob(os.path.join(d, "20[0-9][0-9]-[0-9][0-9]-[0-9][0-9].json")))]


def arg(argv: list[str], name: str, default: str | None = None) -> str | None:
    return argv[argv.index(name) + 1] if name in argv else default


def cmd_snapshot(argv: list[str]) -> int:
    snap = snapshot(read_json(arg(argv, "--status", "data/status.json")))
    path = os.path.join(arg(argv, "--dir", "history"), f"{snap['date']}.json")
    write_json(path, snap)
    print(f"wrote {path}: {snap['counts']}")
    return 0


def cmd_publish(argv: list[str]) -> int:
    snaps = load_snaps(arg(argv, "--dir", "history"))
    out = changes(snaps)
    write_json(arg(argv, "--changes", "_site/data/changes.json"), out)
    feed = arg(argv, "--feed", "_site/feed.xml")
    os.makedirs(os.path.dirname(feed) or ".", exist_ok=True)
    with open(feed, "w") as f:
        f.write(atom(out["events"], dt.datetime.now(dt.timezone.utc)))
    print(f"{len(snaps)} snapshots, {len(out['events'])} changes since {out['since']}")
    return 0


def cmd_discover(argv: list[str]) -> int:
    targets = read_json(arg(argv, "--targets", "targets.json"))
    seen_path = arg(argv, "--seen", "history/discovery-seen.json")
    seen = read_json(seen_path, [])
    today = dt.datetime.now(dt.timezone.utc).date()
    since = arg(argv, "--since", (today - dt.timedelta(days=2)).isoformat())
    items = []
    for q in QUERIES:
        query = urllib.parse.quote(f"{q} created:>={since}")
        # Anonymous on purpose: with the Actions token, GitHub's search leaves out pull requests from other repos.
        # Five queries a day are well inside the anonymous search limit (10 a minute).
        items += http("GET", f"https://api.github.com/search/issues?q={query}&sort=created&order=desc&per_page=50",
                      auth=False)["items"]
    cands = candidates(items, targets, set(seen))
    print(f"{len(items)} search hits, {len(cands)} new")
    if not cands:
        return 0
    body = discovery_body(cands, today.isoformat())
    if "--dry-run" in argv:
        print(body)
        return 0
    issue = gh("POST", f"repos/{arg(argv, '--repo', OWN_REPO)}/issues",
               {"title": f"Discovery {today.isoformat()}: {len(cands)} new public items mention NU7", "body": body})
    print(f"opened {issue['html_url']}")
    write_json(seen_path, (seen + [c["key"] for c in cands])[-MAX_SEEN:], indent=0)
    return 0


def cmd_watchdog(argv: list[str]) -> int:
    repo = arg(argv, "--repo", OWN_REPO)
    now = dt.datetime.now(dt.timezone.utc)
    failed = arg(argv, "--failed")
    if failed:
        problems = [f"the daily job failed: {failed}"]
        date = now.date().isoformat()
    else:
        status = read_json(arg(argv, "--status", "data/status.json"))
        date = status["checked_at"][:10]
        prev = next((s for s in reversed(load_snaps(arg(argv, "--dir", "history"))) if s["date"] < date), None)
        try:
            live = http("GET", arg(argv, "--live", f"{SITE}data/status.json"))["checked_at"]
        except Exception:  # noqa: BLE001  (unreadable is itself a finding)
            live = None
        problems = health(status, prev, live, now)
    print("\n".join(problems) or "healthy")
    if "--dry-run" in argv:
        return 0
    open_issues = [i for i in gh("GET", f"repos/{repo}/issues?state=open&per_page=100")
                   if "pull_request" not in i and i["title"].startswith(WATCHDOG)]
    report = "\n".join(f"- {p}" for p in problems)
    if problems and open_issues:
        gh("POST", f"repos/{repo}/issues/{open_issues[0]['number']}/comments", {"body": f"Still failing on {date}:\n\n{report}"})
    elif problems:
        gh("POST", f"repos/{repo}/issues", {
            "title": f"{WATCHDOG} The NU7 board needs a look",
            "body": f"The daily watchdog found a problem on {date}:\n\n{report}\n\nIt comments here each day this "
                    "continues and closes the issue itself once everything is healthy."})
    elif open_issues:
        n = open_issues[0]["number"]
        gh("POST", f"repos/{repo}/issues/{n}/comments", {"body": f"Healthy again on {date}. Closing."})
        gh("PATCH", f"repos/{repo}/issues/{n}", {"state": "closed", "state_reason": "completed"})
    return 0


def main(argv: list[str]) -> int:
    cmds = {"snapshot": cmd_snapshot, "publish": cmd_publish, "discover": cmd_discover, "watchdog": cmd_watchdog}
    if not argv or argv[0] not in cmds:
        print(f"usage: daily.py {{{','.join(cmds)}}} [options]", file=sys.stderr)
        return 2
    return cmds[argv[0]](argv[1:])


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
