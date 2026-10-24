"""Tests for check.py. Run: python3 -m unittest -v test_check (from this folder; -I would drop this folder from the import path)."""
from __future__ import annotations

import datetime as dt
import unittest

import check

NOW = dt.datetime(2026, 10, 24, 6, 0, tzinfo=dt.timezone.utc)


def pr(state="open", merged=False):
    return {"state": state, "merged_at": "2026-10-20T00:00:00Z" if merged else None, "title": "t", "updated_at": "2026-10-23T00:00:00Z"}


def issue(state="open", reason=None):
    return {"state": state, "state_reason": reason, "title": "t", "updated_at": "2026-10-23T00:00:00Z"}


class SignalState(unittest.TestCase):
    def test_pull_request_states(self):
        self.assertEqual(check.signal_state("fix", pr("open")), "open")
        self.assertEqual(check.signal_state("fix", pr("closed", merged=True)), "merged")
        self.assertEqual(check.signal_state("fix", pr("closed")), "closed")

    def test_issue_states(self):
        self.assertEqual(check.signal_state("blocker", issue("open")), "open")
        self.assertEqual(check.signal_state("blocker", issue("closed", "completed")), "completed")
        self.assertEqual(check.signal_state("blocker", issue("closed", "not_planned")), "not_planned")

    def test_release(self):
        self.assertEqual(check.signal_state("release", {"tag_name": "v7.0.0", "draft": False}), "released")
        self.assertEqual(check.signal_state("release", {"tag_name": "v7.0.0", "draft": True}), "absent")


class RowStatus(unittest.TestCase):
    def s(self, kind, state):
        return {"kind": kind, "state": state}

    def test_open_blocker_and_no_fix_is_broken(self):
        self.assertEqual(check.row_status([self.s("blocker", "open")]), "broken")

    def test_open_fix_is_in_review_even_with_open_blocker(self):
        self.assertEqual(check.row_status([self.s("blocker", "open"), self.s("fix", "open")]), "in-review")

    def test_merged_fix_wins_over_an_issue_left_open(self):
        self.assertEqual(check.row_status([self.s("blocker", "open"), self.s("fix", "merged")]), "fixed")

    def test_blocker_closed_as_completed_is_fixed(self):
        self.assertEqual(check.row_status([self.s("blocker", "completed")]), "fixed")

    def test_blocker_closed_not_planned_needs_a_look(self):
        self.assertEqual(check.row_status([self.s("blocker", "not_planned")]), "watch")

    def test_a_published_release_is_fixed(self):
        self.assertEqual(check.row_status([self.s("release", "released")]), "fixed")

    def test_manual_only_row_is_watch(self):
        self.assertEqual(check.row_status([self.s("manual", "noted")]), "watch")

    def test_an_error_never_reads_as_fixed_or_broken(self):
        self.assertEqual(check.row_status([self.s("fix", "error")]), "unknown")
        self.assertEqual(check.row_status([self.s("blocker", "error"), self.s("fix", "open")]), "in-review")

    def test_closed_unmerged_fix_with_nothing_else_is_unknown(self):
        self.assertEqual(check.row_status([self.s("fix", "closed")]), "unknown")

    def code(self, means, state):
        return {"kind": "code", "means": means, "state": state}

    def test_code_that_proves_a_fix_is_fixed(self):
        self.assertEqual(check.row_status([self.s("blocker", "open"), self.code("fixed", "found")]), "fixed")

    def test_code_that_proves_breakage_is_broken(self):
        self.assertEqual(check.row_status([self.code("broken", "found")]), "broken")

    def test_missing_fix_code_is_broken(self):
        self.assertEqual(check.row_status([self.code("fixed", "not_found")]), "broken")

    def test_broken_pattern_gone_is_not_proof_of_a_fix(self):
        self.assertEqual(check.row_status([self.code("broken", "not_found")]), "watch")

    def test_open_fix_beats_code_breakage(self):
        self.assertEqual(check.row_status([self.code("broken", "found"), self.s("fix", "open")]), "in-review")

    def test_context_never_decides(self):
        self.assertEqual(check.row_status([self.s("context", "open")]), "watch")
        self.assertEqual(check.row_status([self.s("context", "merged"), self.s("blocker", "open")]), "broken")


class Countdown(unittest.TestCase):
    def test_before_activation(self):
        c = check.countdown(3_528_654, NOW)
        self.assertFalse(c["active"])
        self.assertEqual(c["blocks_left"], 14_751)
        # 14,751 blocks at 75 s = 1,106,325 s = 12 d 19 h 18 m 45 s
        self.assertEqual(c["eta_utc"], "2026-11-06T01:18:45Z")

    def test_at_and_after_activation(self):
        self.assertTrue(check.countdown(3_543_405, NOW)["active"])
        self.assertEqual(check.countdown(3_543_500, NOW)["blocks_left"], 0)


class Evaluate(unittest.TestCase):
    def test_builds_rows_from_github_answers_and_marks_failures(self):
        targets = {
            "rows": [
                {"id": "a", "name": "Lib A", "category": "Library", "note": "n", "signals": [
                    {"kind": "blocker", "ref": "o/a#1"}, {"kind": "fix", "ref": "o/a#2"}]},
                {"id": "b", "name": "Node B", "category": "Node", "note": "n", "signals": [{"kind": "release", "ref": "o/b@v7.0.0"}]},
                {"id": "c", "name": "Broken C", "category": "Wallet", "note": "n", "signals": [{"kind": "blocker", "ref": "o/c#9"}]},
                {"id": "d", "name": "Manual D", "category": "Swap", "note": "n", "signals": [
                    {"kind": "manual", "label": "Forum post", "url": "https://example.org/x", "checked": "2026-10-24"}]},
                {"id": "e", "name": "Code E", "category": "Library", "note": "n", "signals": [
                    {"kind": "code", "ref": "o/e:src/tx.rs", "pattern": "VERSION_4", "means": "broken", "label": "builds v4"},
                    {"kind": "context", "ref": "o/e#5"}]},
            ]
        }
        answers = {
            "https://api.github.com/repos/o/a/issues/1": issue("open"),
            "https://api.github.com/repos/o/a/pulls/2": pr("open"),
            "https://api.github.com/repos/o/b/releases/tags/v7.0.0": {"tag_name": "v7.0.0", "draft": False, "published_at": "2026-10-22T00:00:00Z"},
            "https://api.blockchair.com/zcash/stats": {"data": {"best_block_height": 3_528_654}},
            "https://raw.githubusercontent.com/o/e/HEAD/src/tx.rs": "version: TRANSACTION_VERSION_4 | OVERWINTERED_FLAG,",
            "https://api.github.com/repos/o/e/issues/5": issue("open"),
        }

        def fake_fetch(url):
            if url in answers:
                return answers[url]
            raise OSError("HTTP 404")

        out = check.evaluate(targets, fake_fetch, NOW)
        rows = {r["id"]: r for r in out["rows"]}
        self.assertEqual(rows["a"]["status"], "in-review")
        self.assertEqual(rows["a"]["signals"][1]["url"], "https://github.com/o/a/pull/2")
        self.assertEqual(rows["b"]["status"], "fixed")
        self.assertEqual(rows["c"]["status"], "unknown")
        self.assertEqual(rows["c"]["signals"][0]["state"], "error")
        self.assertEqual(rows["d"]["status"], "watch")
        self.assertEqual(rows["e"]["status"], "broken")
        self.assertEqual(rows["e"]["signals"][0]["state"], "found")
        self.assertEqual(rows["e"]["signals"][0]["url"], "https://github.com/o/e/blob/HEAD/src/tx.rs")
        self.assertEqual(rows["e"]["signals"][1]["url"], "https://github.com/o/e/issues/5")
        self.assertEqual(out["chain"]["blocks_left"], 14_751)
        self.assertEqual(out["checked_at"], "2026-10-24T06:00:00Z")
        self.assertEqual(out["counts"], {"fixed": 1, "in-review": 1, "broken": 1, "watch": 1, "unknown": 1})

    def test_chain_failure_is_reported_not_guessed(self):
        def failing(url):
            raise OSError("down")

        out = check.evaluate({"rows": []}, failing, NOW)
        self.assertIsNone(out["chain"]["tip"])
        self.assertIn("error", out["chain"])


if __name__ == "__main__":
    unittest.main()
