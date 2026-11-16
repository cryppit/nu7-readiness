import datetime as dt
import unittest
import xml.etree.ElementTree as ET

import daily

NOW = dt.datetime(2026, 11, 17, 3, 41, tzinfo=dt.timezone.utc)


def status(checked_at, rows, tip=3_560_000, errors=()):
    return {
        "checked_at": checked_at,
        "chain": {"tip": tip},
        "counts": {s: sum(1 for r in rows if r[1] == s) for s in daily.STATUSES},
        "rows": [{"id": i, "name": n, "status": s,
                  "signals": [{"kind": "fix", "ref": f"o/{i}#1", "state": "error" if i in errors else "open"}]}
                 for i, s, n in ((r[0], r[1], r[2]) for r in rows)],
    }


class SnapshotAndDiff(unittest.TestCase):
    def test_snapshot_keeps_date_counts_tip_and_row_statuses(self):
        s = daily.snapshot(status("2026-11-17T03:41:00Z", [("zapp", "fixed", "Zapp")]))
        self.assertEqual(s["date"], "2026-11-17")
        self.assertEqual(s["tip"], 3_560_000)
        self.assertEqual(s["rows"], {"zapp": {"status": "fixed", "name": "Zapp"}})
        self.assertEqual(s["counts"]["fixed"], 1)

    def test_diff_reports_moves_additions_and_removals_only(self):
        a = daily.snapshot(status("2026-11-16T03:00:00Z", [("zapp", "in-review", "Zapp"), ("old", "broken", "Old"),
                                                          ("same", "fixed", "Same")]))
        b = daily.snapshot(status("2026-11-17T03:00:00Z", [("zapp", "fixed", "Zapp"), ("new", "watch", "New"),
                                                          ("same", "fixed", "Same")]))
        ev = daily.diff(a, b)
        self.assertEqual([(e["id"], e["from"], e["to"]) for e in ev],
                         [("new", None, "watch"), ("old", "broken", None), ("zapp", "in-review", "fixed")])
        self.assertTrue(all(e["date"] == "2026-11-17" for e in ev))

    def test_changes_are_newest_first_across_all_snapshots(self):
        snaps = [daily.snapshot(status(f"2026-11-{d}T03:00:00Z", [("zapp", s, "Zapp")]))
                 for d, s in (("15", "broken"), ("16", "in-review"), ("17", "fixed"))]
        out = daily.changes(snaps)
        self.assertEqual(out["since"], "2026-11-15")
        self.assertEqual(out["latest"], "2026-11-17")
        self.assertEqual([(e["date"], e["to"]) for e in out["events"]], [("2026-11-17", "fixed"), ("2026-11-16", "in-review")])

    def test_changes_with_one_snapshot_has_no_events(self):
        out = daily.changes([daily.snapshot(status("2026-11-16T03:00:00Z", [("a", "fixed", "A")]))])
        self.assertEqual(out["events"], [])
        self.assertEqual(out["since"], "2026-11-16")


class Feed(unittest.TestCase):
    def test_atom_is_valid_xml_with_one_entry_per_day_and_escaped_names(self):
        events = [{"date": "2026-11-17", "id": "a", "name": "A & <B>", "from": "in-review", "to": "fixed"},
                  {"date": "2026-11-17", "id": "c", "name": "C", "from": None, "to": "watch"},
                  {"date": "2026-11-16", "id": "d", "name": "D", "from": "broken", "to": None}]
        xml = daily.atom(events, NOW)
        root = ET.fromstring(xml)
        ns = {"a": "http://www.w3.org/2005/Atom"}
        entries = root.findall("a:entry", ns)
        self.assertEqual(len(entries), 2)
        self.assertEqual(entries[0].find("a:title", ns).text, "17 Nov 2026: 2 status changes")
        body = entries[0].find("a:content", ns).text
        self.assertIn("A & <B>: In review → Fixed", body)
        self.assertIn("C: added to the board as Watch", body)
        self.assertIn("removed from the board", entries[1].find("a:content", ns).text)
        self.assertEqual(root.find("a:updated", ns).text, "2026-11-17T03:41:00Z")

    def test_atom_without_events_is_still_a_valid_feed(self):
        root = ET.fromstring(daily.atom([], NOW))
        self.assertEqual(root.findall("{http://www.w3.org/2005/Atom}entry"), [])


class Discovery(unittest.TestCase):
    TARGETS = {"rows": [{"id": "tw", "signals": [{"kind": "blocker", "ref": "trustwallet/wallet-core#4910"},
                                                  {"kind": "code", "ref": "zingolabs/zaino:src/x.rs"},
                                                  {"kind": "manual", "url": "https://x"}]}]}

    def item(self, repo, n, title="t", pr=False):
        it = {"repository_url": f"https://api.github.com/repos/{repo}", "number": n, "title": title,
              "html_url": f"https://github.com/{repo}/issues/{n}", "created_at": "2026-11-16T10:00:00Z"}
        if pr:
            it["pull_request"] = {}
        return it

    def test_tracked_lists_refs_and_repos(self):
        refs, repos = daily.tracked(self.TARGETS)
        self.assertEqual(refs, {"trustwallet/wallet-core#4910"})
        self.assertEqual(repos, {"trustwallet/wallet-core", "zingolabs/zaino"})

    def test_candidates_drop_tracked_seen_own_and_duplicate_items(self):
        items = [self.item("trustwallet/wallet-core", 4910), self.item("trustwallet/wallet-core", 4999, "new report"),
                 self.item("acme/wallet", 7, "NU7 send fails", pr=True), self.item("acme/wallet", 7),
                 self.item("cryppit/nu7-readiness", 9), self.item("seen/repo", 1)]
        out = daily.candidates(items, self.TARGETS, seen={"seen/repo#1"})
        self.assertEqual([(c["key"], c["on_board"], c["kind"]) for c in out],
                         [("trustwallet/wallet-core#4999", True, "issue"), ("acme/wallet#7", False, "PR")])

    def test_issue_body_groups_by_board_repo_and_says_it_is_unreviewed(self):
        cands = [{"key": "a/b#1", "url": "https://github.com/a/b/issues/1", "title": "x", "created": "2026-11-16",
                  "on_board": False, "kind": "issue"},
                 {"key": "c/d#2", "url": "https://github.com/c/d/pull/2", "title": "y", "created": "2026-11-16",
                  "on_board": True, "kind": "PR"}]
        body = daily.discovery_body(cands, "2026-11-17")
        self.assertIn("not reviewed", body)
        self.assertLess(body.index("Repos already on the board"), body.index("c/d#2"))
        self.assertLess(body.index("New repos"), body.index("a/b#1"))


class Watchdog(unittest.TestCase):
    def prev(self, date="2026-11-16", tip=3_559_000):
        return {"date": date, "tip": tip, "rows": {}, "counts": {}}

    def test_healthy(self):
        s = status("2026-11-17T03:40:00Z", [("a", "fixed", "A")])
        self.assertEqual(daily.health(s, self.prev(), "2026-11-17T01:00:00Z", NOW), [])

    def test_problems(self):
        s = status("2026-11-17T03:40:00Z", [("a", "unknown", "A")], tip=None, errors={"a"})
        p = daily.health(s, self.prev(date="2026-11-13"), "2026-11-15T20:00:00Z", NOW)
        text = "\n".join(p)
        self.assertIn("o/a#1", text)
        self.assertIn("chain height could not be read", text)
        self.assertIn("2026-11-13", text)
        self.assertIn("published board data is 31 hours old", text)

    def test_stuck_chain_height(self):
        s = status("2026-11-17T03:40:00Z", [("a", "fixed", "A")], tip=3_559_000)
        self.assertIn("did not move", "\n".join(daily.health(s, self.prev(), "2026-11-17T01:00:00Z", NOW)))

    def test_unreadable_live_data(self):
        s = status("2026-11-17T03:40:00Z", [("a", "fixed", "A")])
        self.assertIn("could not be read", "\n".join(daily.health(s, None, None, NOW)))


if __name__ == "__main__":
    unittest.main()
