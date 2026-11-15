// Pure logic for the NU7 readiness page: the "Can my wallet send after NU7?" answer, the node error decoder and the
// upcoming deadlines. No DOM, no network, no clock: index.html renders what these return (as text, never as HTML), and
// nu7.test.js tests them with `node --test nu7.test.js`.
"use strict";

const NU7 = (() => {
  const NU7_HEIGHT = 3_543_405; // ZIP 259, Mainnet
  const SPACING_BEFORE_NU7 = 75; // seconds per block (Blossom to NU7)
  const SPACING_NU7 = 25; // seconds per block from NU7 (ZIP 218)

  // Consensus branch IDs, from Zebra 7.0.0 zebra-chain/src/parameters/network_upgrade.rs (CONSENSUS_BRANCH_IDS) and,
  // for the two IDs that are no longer valid, librustzcash components/zcash_protocol/src/consensus.rs
  // (test nu7_branch_id_round_trip_and_retired_ids, main at b0e6e347eb52).
  const BRANCH_IDS = {
    "5ba81b19": "Overwinter", "76b809bb": "Sapling", "2bb40e60": "Blossom", "f5b9230b": "Heartwood",
    e9ff75a6: "Canopy", c2d6d0b4: "NU5", c8e71055: "NU6", "4dec4df0": "NU6.1", "5437f330": "NU6.2",
    "37a5165b": "NU6.3", "77190ad9": "NU7",
    "77190ad8": "the retired early NU7 proposal", ffffffff: "the placeholder used before NU7 had an ID",
  };

  function branchName(hex) {
    const k = String(hex || "").toLowerCase().replace(/^0x/, "");
    return Object.prototype.hasOwnProperty.call(BRANCH_IDS, k) ? BRANCH_IDS[k] : null;
  }
  function idText(hex) {
    const k = String(hex).toLowerCase().replace(/^0x/, "");
    const name = branchName(k);
    return `0x${k.toUpperCase()}${name ? ` (${name})` : " (no known upgrade)"}`;
  }

  // ---- Can my wallet send after NU7? ----

  const FUNDS_SAFE = "Your ZEC is not lost. A send that the wallet refuses to sign, or that the network rejects, moves " +
    "nothing: the coins stay at your address until you send them with software that is ready.";
  const DEFAULT_ADVICE = "Wait for an update from the wallet; this board re-checks it several times a day. If you need " +
    "to send sooner, restore the same recovery phrase in a wallet this board shows as able to send, if it supports " +
    "your kind of address. Only type a recovery phrase into wallet software you trust, downloaded from its official " +
    "site or app store.";

  function pickerRows(rows) {
    return rows.filter((r) => r.user && r.user.label)
      .map((r) => ({ id: r.id, label: r.user.label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  // The answer for one board row, from its status and its optional `user` block (targets.json).
  function sendAnswer(row, opts) {
    const u = row.user || {};
    const name = u.label || row.name;
    const lines = [];
    let verdict;
    let headline;
    let summary;
    const advice = u.advice || DEFAULT_ADVICE;
    if (row.status === "fixed" && !u.pending) {
      verdict = "yes";
      headline = "Yes";
      summary = `${name} works under NU7's rules.`;
      if (u.update) lines.push(`Make sure you have ${u.update}. Older versions build transactions the network now rejects.`);
      if (u.caveat) lines.push(u.caveat);
    } else if (row.status === "fixed") {
      verdict = "not-yet";
      headline = "Not yet";
      summary = `${name} is fixed in its code, but not in a release you can install yet.`;
      lines.push(`${u.pending} (checked ${u.checked})`);
      if (u.update) lines.push(`Look for ${u.update}.`);
      lines.push(advice, FUNDS_SAFE);
    } else if (row.status === "in-review" || row.status === "broken") {
      verdict = "no";
      headline = "Not yet";
      summary = row.status === "in-review"
        ? `${name} can't send under NU7's rules yet. A fix is open but not merged or released.`
        : `${name} can't send under NU7's rules yet, and no fix for it is open.`;
      if (u.update) lines.push(`It can send once you have ${u.update}.`);
      lines.push(advice, FUNDS_SAFE);
    } else if (row.status === "watch") {
      verdict = "unclear";
      headline = "Not clear";
      summary = `The public evidence for ${name} doesn't settle it either way.`;
      if (u.advice) lines.push(u.advice);
      if (u.caveat) lines.push(u.caveat);
      lines.push("The board row below has the details and links.");
    } else {
      verdict = "unknown";
      headline = "Unknown right now";
      summary = `The last check couldn't read the evidence for ${name}. A failed lookup never counts as ready or broken; try again after the next check.`;
    }
    if (opts && opts.stale) lines.push("This answer uses data more than 8 hours old, so the status may have changed.");
    return { verdict, headline, summary, lines, rowId: row.id };
  }

  // ---- Node error decoder ----
  // Every pattern below is a message verified in source; the file and line are cited next to it. Nothing is invented:
  // a message that couldn't be found in source is left out. Matching is case-insensitive and on substrings, because
  // wallets and servers wrap node errors in their own text (an RPC code, "failed to validate tx", and so on).

  const SRC = {
    zebraError: "https://github.com/ZcashFoundation/zebra/blob/v7.0.0/zebra-consensus/src/error.rs",
    zebraStorage: "https://github.com/ZcashFoundation/zebra/blob/v7.0.0/zebrad/src/components/mempool/storage.rs",
    zebraEos: "https://github.com/ZcashFoundation/zebra/blob/v7.0.0/zebrad/src/components/sync/end_of_support.rs",
    zcashdMain: "https://github.com/zcash/zcash/blob/558f68659958/src/main.cpp",
    librustzcashTx: "https://github.com/zcash/librustzcash/blob/b0e6e347eb52/zcash_primitives/src/transaction/mod.rs",
  };
  const NOTHING_SENT = "Nothing was sent: the network didn't accept the transaction, so the ZEC is still at your address.";
  const HEX_ID = /\b(?:0x)?([0-9a-f]{8})\b/gi; // whole tokens only, never 8 digits inside a txid

  function decodeError(input) {
    const t = String(input || "").trim();
    if (!t) return null;
    let m;

    // Zebra 7.0.0 zebra-consensus/src/error.rs:125
    //   #[error("transaction version {0} not supported by the network upgrade {1:?}")] UnsupportedByNetworkUpgrade
    // raised for every v4 transaction from NU7 in zebra-consensus/src/transaction.rs:1086 (ZIP 2003).
    if ((m = /transaction version (\d+) not supported by the network upgrade (\w+)/i.exec(t))) {
      const [, version, upgrade] = m;
      const lines = [];
      if (version === "4" && /^nu7$/i.test(upgrade)) {
        lines.push("Your wallet built a version 4 transaction. Since NU7 activated on 6 November 2026 at block " +
          "3,543,405, the network accepts only versions 5 and 6 (ZIP 2003), so every node rejects it.");
      } else {
        lines.push(`Your wallet built a version ${version} transaction, which the network upgrade ${upgrade} doesn't accept.`);
      }
      lines.push(NOTHING_SENT, "What to do: update the wallet to a version that builds v5 transactions. Pick your " +
        "wallet under \"Can my wallet send after NU7?\" to see which version that is.");
      return { id: "v4", title: "The wallet still builds version 4 transactions", lines, source: SRC.zebraError };
    }

    // Zebra's end-of-support check, zebrad/src/components/sync/end_of_support.rs:33 and :36
    //   EOS_PANIC_MESSAGE_HEADER = "Zebra refuses to run"
    //   EOS_WARN_MESSAGE_HEADER = "Your Zebra release is too old and it will stop running"
    if (/zebra refuses to run|your zebra release is too old and it will stop running/i.test(t)) {
      return {
        id: "zebra-eos", title: "A Zebra node's end-of-support check",
        lines: [
          "Each Zebra release stops itself on Mainnet about 8 weeks after it ships, and warns for the last 2 weeks. " +
          "Zebra 7.0.0 runs up to block 3,684,728 and warns after block 3,636,344.",
          "What to do (node operators): install the latest Zebra release. If a wallet or service shows this, its " +
          "node needs that update; your funds are not affected.",
        ],
        source: SRC.zebraEos,
      };
    }

    // zcashd src/main.cpp:1191, reject reason "bad-tx-consensus-branch-id-mismatch":
    //   "ContextualCheckTransaction(): transaction's consensus branch id (%08x) does not match the current consensus branch (%08x)"
    // The first ID is the transaction's, the second the node's.
    if ((m = /consensus branch id \(([0-9a-f]{8})\) does not match the current consensus branch \(([0-9a-f]{8})\)/i.exec(t))) {
      const [, txId, nodeId] = m;
      if (txId.toLowerCase() === "77190ad9") {
        return {
          id: "node-behind", title: "The node is behind NU7, not your wallet",
          lines: [
            `Your transaction is signed for NU7 (${idText(txId)}), but the node that answered is still on ${idText(nodeId)}. ` +
            "This wording comes from zcashd, whose last code knows no upgrade after NU6.2, so that node is behind NU7.",
            NOTHING_SENT, "What to do: send through a server that runs a current Zebra node, or ask the service to upgrade its node.",
          ],
          source: SRC.zcashdMain,
        };
      }
      const lines = [`Your transaction carries the consensus branch ID ${idText(txId)}, and the node expects ` +
        `${idText(nodeId)}. Signatures commit to this ID, so the wallet's network-upgrade constants are out of date.`];
      if (nodeId.toLowerCase() !== "77190ad9") {
        lines.push("The node isn't on NU7 either. This wording comes from zcashd, whose last code knows no upgrade " +
          "after NU6.2, so send through a server that runs a current Zebra node.");
      }
      lines.push(NOTHING_SENT, "What to do: update the wallet; NU7's branch ID is 0x77190AD9.");
      return { id: "branch-id", title: "The transaction is signed for an older network upgrade", lines, source: SRC.zcashdMain };
    }

    // Zebra 7.0.0 zebra-consensus/src/error.rs:279
    //   #[error("transaction uses an incorrect consensus branch id")] WrongConsensusBranchId
    // raised in zebra-consensus/src/transaction/check.rs when a v5+ transaction's branch ID isn't the current upgrade's.
    // zcashd: reject reason "bad-tx-consensus-branch-id-mismatch" (src/main.cpp:1193), and
    // "old-consensus-branch-id (Expected %s, found %s)" (src/main.cpp:1406).
    if (/transaction uses an incorrect consensus branch id|bad-tx-consensus-branch-id-mismatch|old-consensus-branch-id/i.test(t)) {
      const ids = [...t.matchAll(HEX_ID)].map((x) => x[1]).filter((h) => branchName(h));
      const lines = ["Your wallet signed the transaction for an earlier network upgrade: it carries an old consensus " +
        "branch ID (often NU6.3's 0x37A5165B) instead of NU7's 0x77190AD9. Signatures commit to this ID, so the network rejects it."];
      if (ids.length) lines.push(`IDs in your message: ${ids.map(idText).join(", ")}.`);
      lines.push(NOTHING_SENT, "What to do: update the wallet, or its signing library, to a version with NU7's branch ID.");
      return { id: "branch-id", title: "The transaction is signed for an older network upgrade", lines,
        source: /old-consensus|bad-tx-consensus/i.test(t) ? SRC.zcashdMain : SRC.zebraError };
    }

    // librustzcash zcash_primitives/src/transaction/mod.rs:1158-1161 (read_header_fragment):
    //   "invalid consensus branch id" / format!("invalid consensus branch id 0x{}", ...)
    // and zcash_protocol's BranchId::try_from error "Unknown consensus branch ID" (consensus.rs:912).
    if ((m = /invalid consensus branch id(?:\s+0x([0-9a-f]{8}))?|unknown consensus branch id/i.exec(t))) {
      const hex = m[1] ? m[1].toLowerCase() : null;
      const lines = [];
      if (hex === "77190ad9") {
        lines.push("The software that showed this doesn't know NU7: it read a transaction or block that uses NU7's " +
          "branch ID 0x77190AD9 and couldn't parse it. This is the wallet, or its light-wallet server, being out of date.");
      } else if (hex === "77190ad8" || hex === "ffffffff") {
        lines.push(`${idText(hex)} is not a valid branch ID: it is ${branchName(hex)}, now retired. The software was ` +
          "built from a pre-release; NU7's final ID is 0x77190AD9.");
      } else if (hex) {
        lines.push(`${idText(hex)} is not a branch ID the Zcash libraries accept.`);
      } else {
        lines.push("The software read a consensus branch ID it doesn't recognise. After NU7 this usually means it " +
          "predates NU7 and can't read NU7 transactions (0x77190AD9).");
      }
      lines.push("Your funds are not affected by this message. What to do: update the wallet; if it uses a " +
        "light-wallet server, that server may need updating too.");
      return { id: "unknown-branch-id", title: "The software can't read this consensus branch ID", lines, source: SRC.librustzcashTx };
    }

    // Zebra 7.0.0 zebra-consensus/src/error.rs:97-99 MaximumExpiryHeight:
    //   "expiry {expiry_height:?} must be less than the maximum {MAX_EXPIRY_HEIGHT:?} ..." (MAX_EXPIRY_HEIGHT = 499,999,999)
    // zcashd src/main.cpp:1216-1217: "CheckTransaction(): expiry height is too high", "bad-tx-expiry-height-too-high"
    if (/must be less than the maximum|expiry height is too high|bad-tx-expiry-height-too-high/i.test(t)) {
      return {
        id: "expiry-too-high", title: "The expiry height is above the protocol's limit",
        lines: ["The wallet set the transaction's expiry height above the maximum the protocol allows (block 499,999,999). " +
          "That is a wallet bug.", NOTHING_SENT, "What to do: update the wallet, or report the message to its developers."],
        source: /must be less than the maximum/i.test(t) ? SRC.zebraError : SRC.zcashdMain,
      };
    }

    // Zebra 7.0.0 zebra-consensus/src/error.rs:108-111 ExpiredTransaction:
    //   "transaction must not be mined at a block {block_height:?} greater than its expiry {expiry_height:?}, ..."
    // Zebra 7.0.0 zebrad/src/components/mempool/storage.rs:100: "best chain tip has reached transaction expiry height"
    // zcashd src/main.cpp:942-943: "ContextualCheckTransaction(): transaction is expired. ...", "tx-overwinter-expired"
    if (/greater than its expiry|reached transaction expiry height|tx-overwinter-expired|transaction is expired/i.test(t)) {
      return {
        id: "expired", title: "The transaction expired before it was mined",
        lines: [
          "Every transaction carries an expiry height, a block after which it can't be mined. This one was built " +
          "for blocks that have already passed. Since NU7, blocks come every 25 seconds instead of 75, so the same " +
          "number of blocks passes three times faster.",
          NOTHING_SENT,
          "What to do: build and send it again; most wallets do this when you retry. If it keeps happening, sign " +
          "and send soon after building (hardware and group signing take time), and check that the wallet's server " +
          "is in sync, because a server that lags gives the wallet an old height.",
        ],
        source: /tx-overwinter-expired|transaction is expired/i.test(t) ? SRC.zcashdMain
          : /reached transaction expiry height/i.test(t) ? SRC.zebraStorage : SRC.zebraError,
      };
    }

    return {
      id: "unknown", title: "This page doesn't recognise that message",
      lines: [
        "It decodes the NU7 version 4 rejection, consensus branch ID errors, expiry errors and Zebra's end-of-support " +
        "message, as Zebra, zcashd and the Rust Zcash libraries word them.",
        "If your wallet says the send was rejected or failed to broadcast, the network didn't accept it and nothing " +
        "moved. Pick your wallet under \"Can my wallet send after NU7?\", or send the full message to the wallet's support.",
      ],
      source: null,
    };
  }

  // ---- Upcoming deadlines ----

  // Zebra 7.0.0 zebrad/src/components/sync/end_of_support.rs: ESTIMATED_RELEASE_HEIGHT = 3_526_000 (line 17),
  // EOS_PANIC_AFTER = 56 days (line 27), EOS_WARN_AFTER = 56 - 14 (line 30). The height N days on is estimated with
  // NetworkChainTipHeightEstimator (zebra-chain/src/chain_tip/network_chain_tip_height_estimator.rs): 75 s blocks up to
  // the block before NU7 activates, then 25 s blocks. The node panics once the tip is above that height (line 91).
  const ZEBRA_RELEASE_HEIGHT = 3_526_000;
  function eosHeight(days) {
    const toNu7 = (NU7_HEIGHT - 1 - ZEBRA_RELEASE_HEIGHT) * SPACING_BEFORE_NU7;
    return NU7_HEIGHT - 1 + Math.floor((days * 86_400 - toNu7) / SPACING_NU7);
  }
  const ZEBRA_EOS = { release: ZEBRA_RELEASE_HEIGHT, warnAfter: eosHeight(42), lastHeight: eosHeight(56) };
  // When the board has no chain reading, dates are estimated from its last known one (the 15 Nov hand check).
  const KNOWN_TIP = { tip: 3_575_374, at: "2026-11-15T09:43:42Z" };

  function estimateTime(height, tip, atIso) {
    if (tip == null || !atIso) return null;
    return Date.parse(atIso) + (height - tip) * SPACING_NU7 * 1000;
  }
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function fmtDay(ms) {
    const d = new Date(ms);
    return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  }
  function fmtNum(n) { return Number(n).toLocaleString("en-US"); }

  function deadlines(chain, checkedAt) {
    const reading = chain && chain.tip != null;
    const tip = reading ? chain.tip : KNOWN_TIP.tip;
    const at = reading ? checkedAt : KNOWN_TIP.at;
    const halt = ZEBRA_EOS.lastHeight + 1;
    const warn = ZEBRA_EOS.warnAfter + 1;
    const passed = reading && chain.tip > ZEBRA_EOS.lastHeight;
    const zebra = {
      id: "zebra-7-eos", title: "Zebra 7.0.0 stops itself", status: passed ? "passed" : "upcoming",
      lines: [
        `Zebra 7.0.0 refuses to run on Mainnet once the chain passes block ${fmtNum(ZEBRA_EOS.lastHeight)}, so from block ` +
        `${fmtNum(halt)}, about ${fmtDay(estimateTime(halt, tip, at))} (UTC) at 25-second blocks. It warns from block ` +
        `${fmtNum(warn)}, about ${fmtDay(estimateTime(warn, tip, at))}.`,
        "This comes from the release's end-of-support check: its estimated release height (3,526,000) plus 56 days. " +
        "Node operators, and services that run Zebra, need the next Zebra release before then; wallets that use " +
        "those nodes stop syncing and sending if the node stops.",
      ],
      links: [
        { text: "end_of_support.rs in Zebra 7.0.0", href: SRC.zebraEos },
        { text: "Zebra releases", href: "https://github.com/ZcashFoundation/zebra/releases" },
      ],
    };
    if (passed) zebra.lines[0] = `The chain passed block ${fmtNum(ZEBRA_EOS.lastHeight)}: Zebra 7.0.0 no longer runs on Mainnet. Nodes need a later release.`;
    const nu8 = {
      id: "nu8", title: "NU8: proposed, not scheduled", status: "proposed",
      lines: [
        "A forum proposal (9 Nov) suggests NU8 for late January 2027. It is not scheduled: no activation height or " +
        "node release is set, and what it would contain is still being debated.",
      ],
      links: [{ text: "forum: Vision for January 2027", href: "https://forum.zcashcommunity.com/t/59124" }],
    };
    return [zebra, nu8];
  }

  return { NU7_HEIGHT, branchName, pickerRows, sendAnswer, decodeError, ZEBRA_EOS, eosHeight,
    estimateTime, fmtDay, deadlines };
})();

if (typeof module !== "undefined" && module.exports) module.exports = NU7;
