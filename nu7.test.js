// Tests for nu7.js, the page's pure logic. Run: node --test nu7.test.js (Node 18 or later, no dependencies).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const NU7 = require("./nu7.js");

const targets = JSON.parse(fs.readFileSync(`${__dirname}/targets.json`, "utf8"));
const text = (a) => [a.headline, a.summary, ...a.lines].join(" ");

test("branch IDs have names", () => {
  assert.equal(NU7.branchName("0x77190AD9"), "NU7");
  assert.equal(NU7.branchName("77190ad9"), "NU7");
  assert.equal(NU7.branchName("0x37a5165b"), "NU6.3");
  assert.equal(NU7.branchName("0x77190ad8"), "the retired early NU7 proposal");
  assert.equal(NU7.branchName("0x12345678"), null);
});

test("the picker lists rows with a user block, by label", () => {
  const rows = [
    { id: "b", name: "B", status: "fixed", user: { label: "Zeta" } },
    { id: "c", name: "C", status: "fixed" },
    { id: "a", name: "A", status: "broken", user: { label: "Alpha" } },
  ];
  assert.deepEqual(NU7.pickerRows(rows), [{ id: "a", label: "Alpha" }, { id: "b", label: "Zeta" }]);
});

test("fixed with no pending release: yes, with the version to have", () => {
  const a = NU7.sendAnswer({ id: "x", name: "X", status: "fixed", user: { label: "X Wallet", update: "X 2.0 or later" } });
  assert.equal(a.verdict, "yes");
  assert.match(text(a), /X Wallet/);
  assert.match(text(a), /X 2\.0 or later/);
  assert.equal(a.rowId, "x");
});

test("fixed upstream but the release is pending: not yet, funds safe", () => {
  const a = NU7.sendAnswer({ id: "x", name: "X", status: "fixed",
    user: { label: "X", pending: "The fix is not in a release yet.", checked: "2026-11-16" } });
  assert.equal(a.verdict, "not-yet");
  assert.match(text(a), /not in a release yet/);
  assert.match(text(a), /checked 2026-11-16/);
  assert.match(text(a), /not lost/);
});

test("in review and broken: not yet, with advice and funds safe", () => {
  const r = NU7.sendAnswer({ id: "x", name: "X", status: "in-review", user: { label: "X" } });
  assert.equal(r.verdict, "no");
  assert.match(text(r), /fix is open/);
  assert.match(text(r), /not lost/);
  const b = NU7.sendAnswer({ id: "x", name: "X", status: "broken", user: { label: "X" } });
  assert.equal(b.verdict, "no");
  assert.match(text(b), /Wait for an update/);
  assert.match(text(b), /not lost/);
  const own = NU7.sendAnswer({ id: "x", name: "X", status: "broken", user: { label: "X", advice: "Do this instead." } });
  assert.match(text(own), /Do this instead\./);
  assert.doesNotMatch(text(own), /Wait for an update/);
});

test("watch and unknown are not guessed", () => {
  assert.equal(NU7.sendAnswer({ id: "x", name: "X", status: "watch", user: { label: "X" } }).verdict, "unclear");
  const u = NU7.sendAnswer({ id: "x", name: "X", status: "unknown", user: { label: "X" } });
  assert.equal(u.verdict, "unknown");
  assert.match(text(u), /couldn't read/);
});

test("stale data says so", () => {
  const a = NU7.sendAnswer({ id: "x", name: "X", status: "fixed", user: { label: "X" } }, { stale: true });
  assert.match(text(a), /more than 8 hours old/);
});

test("Trust Wallet's Chrome extension: not yet, update to a v5 build, funds not lost", () => {
  const row = targets.rows.find((r) => r.id === "trust-wallet-extension");
  const a = NU7.sendAnswer({ ...row, status: "broken" });
  assert.equal(a.verdict, "no");
  assert.match(text(a), /Wallet Core 4\.9\.1/);
  assert.match(text(a), /not lost/);
  // If issue #4910 closes before the extension ships, the row could read fixed: the answer still names the build to have.
  const fixed = NU7.sendAnswer({ ...row, status: "fixed" });
  assert.match(text(fixed), /Wallet Core 4\.9\.1/);
});

test("every picker row answers for every status", () => {
  for (const row of targets.rows.filter((r) => r.user)) {
    for (const status of ["fixed", "in-review", "broken", "watch", "unknown"]) {
      const a = NU7.sendAnswer({ ...row, status });
      assert.ok(a.headline && a.summary, `${row.id} ${status}`);
      assert.ok(Array.isArray(a.lines));
    }
  }
});

test("decoder: the v4 rejection, as a Trust Wallet extension user saw it", () => {
  const msg = '-25: failed to validate tx: transaction::Hash("private"), error: transaction did not pass consensus validation: transaction version 4 not supported by the network upgrade Nu7';
  const d = NU7.decodeError(msg);
  assert.equal(d.id, "v4");
  assert.match(d.lines.join(" "), /3,543,405/);
  assert.match(d.lines.join(" "), /Nothing was sent/);
  assert.match(d.source, /zebra/);
});

test("decoder: Zebra's wrong branch ID", () => {
  const d = NU7.decodeError("transaction did not pass consensus validation: transaction uses an incorrect consensus branch id");
  assert.equal(d.id, "branch-id");
  assert.match(d.lines.join(" "), /0x77190AD9/);
});

test("decoder: zcashd's branch ID mismatch names both IDs and who is behind", () => {
  const wallet = NU7.decodeError("ContextualCheckTransaction(): transaction's consensus branch id (37a5165b) does not match the current consensus branch (77190ad9)");
  assert.equal(wallet.id, "branch-id");
  assert.match(wallet.lines.join(" "), /NU6\.3/);
  assert.doesNotMatch(wallet.lines.join(" "), /isn't on NU7 either/);
  const both = NU7.decodeError("transaction's consensus branch id (5437f330) does not match the current consensus branch (37a5165b)");
  assert.match(both.lines.join(" "), /NU6\.2/);
  assert.match(both.lines.join(" "), /isn't on NU7 either/);
  // A txid that happens to contain a branch ID's digits isn't read as one.
  const z = NU7.decodeError("transaction uses an incorrect consensus branch id, tx 00ab37a5165bcd");
  assert.doesNotMatch(z.lines.join(" "), /IDs in your message/);
  assert.match(NU7.decodeError("transaction uses an incorrect consensus branch id (0x37a5165b)").lines.join(" "), /0x37A5165B \(NU6\.3\)/);
  const node = NU7.decodeError("bad-tx-consensus-branch-id-mismatch: transaction's consensus branch id (77190ad9) does not match the current consensus branch (37a5165b)");
  assert.equal(node.id, "node-behind");
  assert.match(node.lines.join(" "), /behind NU7/);
});

test("decoder: software that can't read NU7's branch ID", () => {
  const old = NU7.decodeError("invalid consensus branch id 0x77190ad9");
  assert.equal(old.id, "unknown-branch-id");
  assert.match(old.lines.join(" "), /doesn't know NU7/);
  const retired = NU7.decodeError("Error: invalid consensus branch id 0x77190ad8");
  assert.equal(retired.id, "unknown-branch-id");
  assert.match(retired.lines.join(" "), /retired/);
  assert.equal(NU7.decodeError("Unknown consensus branch ID").id, "unknown-branch-id");
});

test("decoder: expiry errors", () => {
  for (const m of [
    "transaction must not be mined at a block Height(3600000) greater than its expiry Height(3599990), failing transaction Hash(\"ab\")",
    "best chain tip has reached transaction expiry height",
    "16: tx-overwinter-expired",
    "ContextualCheckTransaction(): transaction is expired. Resending when caught up with the blockchain, or manually setting the zcashd txexpirydelta parameter may help.",
  ]) assert.equal(NU7.decodeError(m).id, "expired", m);
  for (const m of [
    "expiry Height(500000000) must be less than the maximum Height(499999999) coinbase: false, block: Height(3600000), failing transaction: Hash(\"ab\")",
    "bad-tx-expiry-height-too-high",
  ]) assert.equal(NU7.decodeError(m).id, "expiry-too-high", m);
});

test("decoder: Zebra's end-of-support halt", () => {
  assert.equal(NU7.decodeError("Zebra refuses to run if the release date is older than 56 days.").id, "zebra-eos");
  assert.equal(NU7.decodeError("Your Zebra release is too old and it will stop running at block 3684728.").id, "zebra-eos");
});

test("decoder: blank and unrecognised input", () => {
  assert.equal(NU7.decodeError(""), null);
  assert.equal(NU7.decodeError("   \n"), null);
  const d = NU7.decodeError("something else went wrong");
  assert.equal(d.id, "unknown");
  assert.equal(d.source, null);
  for (const m of ["transaction version 4 not supported by the network upgrade Nu7", "tx-overwinter-expired", "invalid consensus branch id 0x77190ad9"]) {
    assert.match(NU7.decodeError(m).source, /^https:\/\/github\.com\//);
  }
});

test("Zebra 7.0.0 end of support, from its source constants", () => {
  // ESTIMATED_RELEASE_HEIGHT 3,526,000 + 56 days: 17,404 blocks at 75 s up to NU7, then 25 s blocks.
  assert.equal(NU7.ZEBRA_EOS.lastHeight, 3_684_728);
  assert.equal(NU7.ZEBRA_EOS.warnAfter, 3_636_344);
  assert.equal(NU7.eosHeight(56), 3_684_728);
  assert.equal(NU7.eosHeight(42), 3_636_344);
});

test("estimated dates at 25-second blocks", () => {
  const at = "2026-11-15T09:43:42Z";
  assert.equal(NU7.estimateTime(3_575_374 + 4, 3_575_374, at), Date.parse(at) + 100_000);
  assert.equal(NU7.fmtDay(NU7.estimateTime(3_684_729, 3_575_374, at)), "17 Dec 2026");
  assert.equal(NU7.fmtDay(NU7.estimateTime(3_636_345, 3_575_374, at)), "3 Dec 2026");
  assert.equal(NU7.estimateTime(3_684_729, null, at), null);
});

test("deadlines: Zebra halt dated from the tip, NU8 proposed only", () => {
  const ds = NU7.deadlines({ tip: 3_575_374 }, "2026-11-15T09:43:42Z");
  const z = ds.find((d) => d.id === "zebra-7-eos");
  assert.equal(z.status, "upcoming");
  assert.match(z.lines.join(" "), /3,684,729/);
  assert.match(z.lines.join(" "), /17 Dec 2026/);
  assert.match(z.lines.join(" "), /3 Dec 2026/);
  const nu8 = ds.find((d) => d.id === "nu8");
  assert.equal(nu8.status, "proposed");
  assert.match(nu8.lines.join(" "), /not scheduled/);
  assert.ok(nu8.links.some((l) => l.href === "https://forum.zcashcommunity.com/t/59124"));
  // No reading: dated from the board's last known height instead, and still about 17 Dec.
  assert.match(NU7.deadlines({ tip: null }, "2026-11-20T00:00:00Z").find((d) => d.id === "zebra-7-eos").lines.join(" "), /17 Dec 2026/);
  // Past the height: shown as passed.
  assert.equal(NU7.deadlines({ tip: 3_700_000 }, "2026-12-20T00:00:00Z").find((d) => d.id === "zebra-7-eos").status, "passed");
});
