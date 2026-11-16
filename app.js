// NU7 readiness page. Everything is built with text nodes (el), never innerHTML: row data and pasted text stay text.
"use strict";
const STALE_MS = 8 * 60 * 60 * 1000;
const LABEL = { fixed: "Fixed", "in-review": "In review", broken: "Broken", watch: "Watch", unknown: "Unknown" };
const GLYPH = { fixed: "✓", "in-review": "◐", broken: "✗", watch: "!", unknown: "?" };
const MEANS = {
  fixed: "A fix is merged, released, in the source, or the issue was closed as done. A release to users may still be pending; the note says so.",
  "in-review": "A fix is open and not merged yet.",
  broken: "An open issue or the current source shows the problem, and no fix is open.",
  watch: "No machine-checkable evidence either way: a dated report, a conflicting source or a related change.",
  unknown: "A lookup failed this hour. A failed lookup never counts as fixed or broken.",
};
const ORDER = ["broken", "in-review", "watch", "unknown", "fixed"];
const KIND = { blocker: "Issue", fix: "Fix", release: "Release", code: "Code", context: "Related", manual: "Report" };
const STATE = {
  open: "open", merged: "merged", closed: "closed, not merged", completed: "closed as done", not_planned: "closed as not planned",
  released: "published", absent: "not published", found: "found", not_found: "not found", error: "lookup failed", noted: "noted",
};
const NEXT = {
  yes: ["You", "make sure you're on the version named above, then send as usual."],
  "not-yet": ["The wallet's team", "has to ship the release. Your ZEC stays safe meanwhile."],
  no: ["The wallet's team", "has to ship a fix. Your ZEC stays safe meanwhile."],
  unclear: ["Nobody can say yet", "open the board row for the evidence."],
  unknown: ["The checker", "retries at the next automatic check."],
};
let data = null;
let filter = "all";
let query = "";

function el(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
  for (const k of kids) if (k != null) n.append(k);
  return n;
}
function cell(status) {
  return el("span", { class: `cell c-${status}`, title: `${LABEL[status] || status}: ${MEANS[status] || ""}`, "aria-hidden": "true" }, GLYPH[status] || "?");
}
function fmt(n) { return n == null ? "unavailable" : Number(n).toLocaleString("en-US"); }
function day(s) { return s ? s.slice(0, 10) : ""; }
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function short(d) { const m = /^(\d{4})-(\d\d)-(\d\d)/.exec(d || ""); return m ? `${+m[3]} ${MON[+m[2] - 1]}${m[1] === "2026" ? "" : ` ${m[1]}`}` : d || ""; }
function when(iso) { return iso.replace("T", " ").replace(/:\d\d(\.\d+)?Z$/, " UTC").replace("Z", " UTC"); }
function stale() { return !(Date.now() - Date.parse(data.checked_at) < STALE_MS); }

function latest(r) {
  const days = r.signals.map((s) => day(s.updated_at) || s.checked || "").filter(Boolean).sort();
  return days.length ? days[days.length - 1] : "";
}

function signalItem(s) {
  let state = STATE[s.state] || s.state;
  if (s.kind === "context" && (s.state === "completed" || s.state === "not_planned")) state = "closed";
  const text = s.kind === "manual" ? s.label : (s.label || s.title);
  const linkText = s.ref || text;
  const what = el("span", { class: "what" }, state);
  if (text && text !== linkText) what.append(` · ${text}`);
  const d = s.kind === "manual" ? `checked ${short(s.checked)}` : short(day(s.updated_at));
  return el("li", {},
    el("span", { class: "kind" }, KIND[s.kind] || s.kind),
    el("span", {}, el("a", { href: s.url, rel: "noopener" }, linkText), what),
    el("span", { class: "d" }, d));
}

function render() {
  const rows = document.getElementById("rows");
  if (!rows) return;
  const q = query.trim().toLowerCase();
  const list = data.rows
    .filter((r) => filter === "all" || r.status === filter)
    .filter((r) => !q || `${r.name} ${r.category} ${r.note}`.toLowerCase().includes(q))
    .sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || a.name.localeCompare(b.name));
  rows.replaceChildren(...list.map((r) => {
    const n = r.signals.length;
    const d = latest(r);
    const det = el("details", { class: "r", id: r.id },
      el("summary", {},
        el("span", { class: "name" }, r.name, el("small", {}, r.category)),
        el("span", { class: "st" }, cell(r.status), LABEL[r.status]),
        el("span", { class: "note" }, r.note),
        el("span", { class: "when" }, d ? `updated ${short(d)}` : "", el("span", { class: "more" }, `${n} source${n === 1 ? "" : "s"}`))),
      el("ul", { class: "ev" }, ...r.signals.map(signalItem)));
    return det;
  }));
  if (!list.length) rows.append(el("p", { class: "empty" }, q ? `Nothing matches "${query.trim()}".` : "Nothing in this group right now."));
  for (const b of document.querySelectorAll("#filters button")) b.setAttribute("aria-pressed", String(b.dataset.f === filter));
}

function filters() {
  const box = document.getElementById("filters");
  if (!box) return;
  $("legend").replaceChildren(...ORDER.map((s) => el("span", { title: MEANS[s] }, cell(s), `${LABEL[s]}: ${MEANS[s]}`)));
  const all = el("button", { type: "button", class: "chip all", "data-f": "all", "aria-pressed": "true" }, `All ${data.rows.length}`);
  const chips = ORDER.filter((s) => s !== "unknown" || data.counts.unknown)
    .map((s) => el("button", { type: "button", class: "chip", "data-f": s, "aria-pressed": "false" }, cell(s), `${LABEL[s]} ${data.counts[s] || 0}`));
  for (const b of [all, ...chips]) b.addEventListener("click", () => { filter = b.dataset.f; render(); });
  box.replaceChildren(all, ...chips);
  document.getElementById("q").addEventListener("input", (e) => { query = e.target.value; render(); });
}

function $(id) { return document.getElementById(id); }
function strip() {
  const c = data.chain || {};
  const total = data.rows.length;
  const ready = data.counts.fixed || 0;
  $("checked").textContent = `Last checked: ${when(data.checked_at)}. Re-checked automatically several times a day.`;
  $("top-checked").textContent = `checked ${short(day(data.checked_at))}, ${data.checked_at.slice(11, 16)} UTC`;
  if ($("go-board")) $("go-board").textContent = `${total} projects: ${ready} ready, ${total - ready} not yet. Every status with its evidence.`;
  if (!$("tip")) return;
  $("tip").textContent = fmt(c.tip);
  document.getElementById("live-text").textContent = c.active
    ? `NU7 is live · ${ready} of ${total} tracked projects are ready`
    : `NU7 is not active yet · ${ready} of ${total} tracked projects are ready`;
  const bar = document.getElementById("bar");
  bar.setAttribute("aria-label", ORDER.map((s) => `${LABEL[s]} ${data.counts[s] || 0}`).join(", "));
  bar.replaceChildren(...["fixed", "in-review", "watch", "unknown", "broken"].filter((s) => data.counts[s])
    .map((s) => { const b = el("span", { class: `b-${s}`, title: `${LABEL[s]}: ${data.counts[s]}` }); b.style.width = `${(100 * data.counts[s]) / total}%`; return b; }));
  const tally = (s) => el("span", {}, cell(s), el("b", {}, String(data.counts[s] || 0)), LABEL[s].toLowerCase());
  document.getElementById("tally").replaceChildren(...["fixed", "in-review", "watch", "broken"].map(tally));
  const banners = document.getElementById("banners");
  if (stale()) banners.append(el("p", { class: "banner" }, `This data is from ${when(data.checked_at)}, more than 8 hours ago. Statuses may have changed.`));
  if (c.error) banners.append(el("p", { class: "banner" }, "The chain height could not be read in the last check."));
}

function answerBox(box, cls, status, title, lines, extra) {
  box.className = `answer ${cls}`;
  box.replaceChildren(el("p", { class: "verdict" }, cell(status), title), ...lines.map((l, i) => el("p", i === 0 ? { class: "summary" } : {}, l)), ...extra);
}

const VERDICT_CELL = { yes: "fixed", "not-yet": "in-review", no: "broken", unclear: "watch", unknown: "unknown" };
const PICK_GROUPS = [
  ["yes", "Can send now", "Works under NU7's rules"],
  ["not-yet", "Not yet", "Waiting on a release or a fix"],
  ["unclear", "Not clear", "The public evidence doesn't settle it"],
];
const PICK_WORD = { yes: "Yes", "not-yet": "Not yet", no: "Not yet", unclear: "Not clear", unknown: "Unknown" };
function logoFor(id, name) {
  return LOGO[id]
    ? el("span", { class: "pick-logo has-logo", "aria-hidden": "true" }, el("img", { src: `logos/${LOGO[id]}`, alt: "" }))
    : el("span", { class: "pick-logo", "aria-hidden": "true" }, name.replace(/^(an?|the) /i, "").slice(0, 1).toUpperCase());
}
// "Can it send?": a searchable picker in the Cryppit style (button + listbox), grouped by the answer, with logos.
// Focus stays in the search box; arrow keys move through the list, Enter picks, Escape closes. The pick is kept in
// the link (#w=<row id>) so an answer can be shared; nothing else is stored or sent.
function sendCheck() {
  const btn = document.getElementById("wallet-btn");
  if (!btn) return;
  const menu = $("wallet-menu"), search = $("wallet-search"), list = $("wallet-list"), box = $("answer");
  const items = NU7.pickerRows(data.rows).map((c) => {
    const row = data.rows.find((r) => r.id === c.id);
    const a = NU7.sendAnswer(row, { stale: stale() });
    return { id: c.id, label: c.label, row, answer: a, group: a.verdict === "no" ? "not-yet" : a.verdict };
  });
  let shown = [], active = -1, chosen = null;

  function answer(item) {
    const a = item.answer, row = item.row;
    const [who, what] = NEXT[a.verdict] || NEXT.unknown;
    const next = el("p", { class: "next" }, "Who acts next: ", el("b", {}, who), ` · ${what}`);
    const link = el("p", { class: "next" }, el("a", { href: `board.html#${row.id}` }, "See the evidence on the board"));
    answerBox(box, `a-${a.verdict}`, VERDICT_CELL[a.verdict] || "unknown", a.headline, [a.summary, ...a.lines], [next, link]);
  }
  function choose(item, focusBtn) {
    chosen = item;
    btn.classList.remove("empty");
    $("wallet-logo").replaceWith(Object.assign(logoFor(item.id, item.label), { id: "wallet-logo" }));
    $("wallet-name").textContent = item.label;
    $("wallet-status").replaceChildren(cell(VERDICT_CELL[item.answer.verdict] || "unknown"), ` ${PICK_WORD[item.answer.verdict] || ""}`);
    answer(item);
    try { history.replaceState(null, "", `#w=${encodeURIComponent(item.id)}`); } catch { /* the link just won't carry the pick */ }
    close(focusBtn);
  }
  function setActive(i) {
    active = i;
    list.querySelectorAll("[role=option]").forEach((o, j) => o.classList.toggle("active", j === i));
    const opt = list.querySelectorAll("[role=option]")[i];
    if (opt) { search.setAttribute("aria-activedescendant", opt.id); opt.scrollIntoView({ block: "nearest" }); }
    else search.removeAttribute("aria-activedescendant");
  }
  function render() {
    const q = search.value.trim().toLowerCase();
    const match = items.filter((it) => !q || it.label.toLowerCase().includes(q) || it.row.name.toLowerCase().includes(q));
    shown = [];
    const parts = [];
    for (const [g, title, note] of PICK_GROUPS) {
      const inGroup = match.filter((it) => it.group === g);
      if (!inGroup.length) continue;
      parts.push(el("li", { class: "pick-group", role: "presentation" }, el("b", {}, title), el("small", {}, note)));
      for (const it of inGroup) {
        const opt = el("li", { class: `pick-row${chosen === it ? " on" : ""}`, role: "option", id: `w-opt-${it.id}`, "aria-selected": String(chosen === it) },
          logoFor(it.id, it.label), el("span", { class: "pick-label" }, it.label),
          el("em", {}, cell(VERDICT_CELL[it.answer.verdict] || "unknown"), ` ${PICK_WORD[it.answer.verdict] || ""}`));
        const idx = shown.length;
        opt.addEventListener("mousedown", (e) => e.preventDefault());
        opt.addEventListener("click", () => choose(it, true));
        opt.addEventListener("mousemove", () => { if (active !== idx) setActive(idx); });
        shown.push(it);
        parts.push(opt);
      }
    }
    list.replaceChildren(...(parts.length ? parts : [el("li", { class: "pick-none", role: "presentation" }, "No wallet or app matches. The board lists every tracked project.")]));
    setActive(shown.length ? Math.max(0, shown.indexOf(chosen)) : -1);
  }
  function open() {
    menu.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    search.value = "";
    render();
    search.focus();
  }
  function close(focusBtn) {
    if (menu.hidden) return;
    menu.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    if (focusBtn) btn.focus();
  }

  search.placeholder = `Search ${items.length} wallets and apps`;
  btn.disabled = false;
  $("wallet-name").textContent = "Choose your wallet or app";
  btn.addEventListener("click", () => (menu.hidden ? open() : close(true)));
  btn.addEventListener("keydown", (e) => { if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); open(); } });
  search.addEventListener("input", render);
  search.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); if (shown.length) setActive((active + 1) % shown.length); }
    else if (e.key === "ArrowUp") { e.preventDefault(); if (shown.length) setActive((active - 1 + shown.length) % shown.length); }
    else if (e.key === "Enter") { e.preventDefault(); if (shown[active]) choose(shown[active], true); }
    else if (e.key === "Escape") { e.preventDefault(); close(true); }
    else if (e.key === "Tab") close(false);
  });
  document.addEventListener("click", (e) => { if (!$("wallet-pick").contains(e.target)) close(false); });

  const m = /^#w=([\w.-]+)$/.exec(location.hash);
  const fromLink = m && items.find((it) => it.id === decodeURIComponent(m[1]));
  if (fromLink) choose(fromLink, false);
}

function decode() {
  const box = document.getElementById("decoded");
  const d = NU7.decodeError(document.getElementById("err").value);
  if (!d) { box.replaceChildren(); return; }
  const link = d.source ? el("p", { class: "next" }, "Source: ", el("a", { href: d.source, rel: "noopener" }, d.source.replace("https://github.com/", ""))) : null;
  answerBox(box, d.id === "unknown" ? "a-unknown" : "a-decoded", d.id === "unknown" ? "unknown" : "watch", d.title, d.lines, [link]);
}
if ($("explain")) {
  $("explain").addEventListener("click", decode);
  $("err").addEventListener("paste", () => setTimeout(decode, 0));
}

function deadlinesList(chain, checkedAt) {
  if (!document.getElementById("deadlines")) return;
  const STATUS = { upcoming: "Upcoming", proposed: "Proposed", passed: "Passed" };
  document.getElementById("deadlines").replaceChildren(...NU7.deadlines(chain, checkedAt).map((d) => {
    const links = el("p", { class: "links" });
    d.links.forEach((l, i) => { if (i) links.append(" · "); links.append(el("a", { href: l.href, rel: "noopener" }, l.text)); });
    const glyph = el("span", { class: `cell c-${d.status}`, "aria-hidden": "true" }, d.status === "upcoming" ? "!" : d.status === "passed" ? "✓" : "?");
    return el("li", { class: "panel card" }, el("h3", {}, glyph, d.title, el("span", { class: "tag" }, STATUS[d.status])), ...d.lines.map((t) => el("p", {}, t)), links);
  }));
}
deadlinesList(null, null);

// The wheel on the overview: every tracked project, ready ones on the outer ring, the rest on the inner ring.
const LOGO = {
  "trust-wallet-core": "trust.svg", "trust-wallet-extension": "trust.svg", "trezor-suite": "trezor.svg", "trezor-firmware": "trezor.svg",
  "swapkit-trezor": "trezor.svg", "zondax-ledger": "ledger.svg", "ledger-live": "ledger.svg", "ledger-hw-app-btc": "ledger.svg",
  edge: "edge.png", zingolib: "zingo.png", "zodl-android": "zodl.png", "zodl-ios": "zodl.png", keystone: "keystone.png",
  "vultisig-swapkit": "vultisig.png", thorchain: "rune.svg", "omni-zec": "near-protocol.svg", "near-omni-tx": "near-protocol.svg",
  "defuse-utxo-lib": "near-protocol.svg",
};
function wheel() {
  const box = $("wheel");
  if (!box) return;
  const tip = $("w-tip");
  const ready = data.rows.filter((r) => r.status === "fixed").sort((a, b) => a.name.localeCompare(b.name));
  const rest = data.rows.filter((r) => r.status !== "fixed").sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || a.name.localeCompare(b.name));
  const label = el("div", { class: "w-label", hidden: "", "aria-hidden": "true" });
  // The name floats just above the hovered logo. The rings stop turning on hover, so the spot stays put.
  const place = (coin, r) => {
    const w = box.getBoundingClientRect(), c = coin.getBoundingClientRect();
    // The wheel's frame cuts off anything outside it, so the card is measured first and kept inside the frame:
    // above the logo when there's room, otherwise below it, and slid back in near any edge.
    const frame = (box.closest(".wheel-box") || box).getBoundingClientRect();
    label.replaceChildren(r.name, el("small", {}, LABEL[r.status]));
    label.hidden = false;
    const width = label.offsetWidth, height = label.offsetHeight, gap = 10, pad = 6;
    let top = c.top - gap - height;
    if (top < frame.top + pad) top = c.bottom + gap;
    top = Math.min(Math.max(top, frame.top + pad), frame.bottom - pad - height);
    const left = Math.min(Math.max(c.left + c.width / 2 - width / 2, frame.left + pad), frame.right - pad - width);
    label.style.left = `${left - w.left}px`;
    label.style.top = `${top - w.top}px`;
  };
  const show = (r) => tip.replaceChildren(el("b", {}, r.name), ` · ${LABEL[r.status]} · ${r.category}`);
  const rings = [["outer", ready], ["inner", rest]].map(([kind, list]) => {
    const ring = el("div", { class: `w-ring ${kind}` });
    list.forEach((r, i) => {
      const face = el("span", { class: `w-face s-${r.status}${LOGO[r.id] ? " has-logo" : ""}` },
        LOGO[r.id] ? el("img", { src: `logos/${LOGO[r.id]}`, alt: "" }) : r.name.replace(/^the /i, "").slice(0, 1).toUpperCase(),
        el("span", { class: `dot s-${r.status}`, "aria-hidden": "true" }, GLYPH[r.status]));
      const coin = el("a", { class: "w-coin", href: `board.html#${r.id}`, "aria-label": `${r.name}: ${LABEL[r.status]}`, title: `${r.name}: ${LABEL[r.status]}` }, face);
      coin.style.setProperty("--a", `${(360 / list.length) * i}deg`);
      coin.addEventListener("mouseenter", () => { show(r); place(coin, r); });
      coin.addEventListener("focus", () => { show(r); place(coin, r); });
      coin.addEventListener("mouseleave", () => { label.hidden = true; });
      coin.addEventListener("blur", () => { label.hidden = true; });
      ring.append(coin);
    });
    return ring;
  });
  box.replaceChildren(...rings, label, el("div", { class: "w-hub" },
    el("img", { src: "logos/token-zec.svg", alt: "" }), el("b", {}, `${ready.length} / ${data.rows.length}`), el("small", {}, "ready for NU7")));
  $("w-key").replaceChildren(...["fixed", "in-review", "watch", "broken"].filter((s) => data.counts[s])
    .map((s) => el("span", {}, cell(s), `${LABEL[s]} ${data.counts[s]}`)));
}

// Open the row named in the URL hash (links from posts point at #row-id).
function openFromHash() {
  const id = decodeURIComponent(location.hash.slice(1));
  // Links from before the board had its own page point at /#row-id: send them to the board.
  if (id && document.body.dataset.page === "home" && data.rows.some((r) => r.id === id)) { location.replace(`board.html#${encodeURIComponent(id)}`); return; }
  const d = id && document.getElementById(id);
  if (d && d.tagName === "DETAILS") { d.open = true; d.scrollIntoView(); }
}

function changesList() {
  const box = $("changes");
  if (!box) return;
  const say = (t) => box.replaceChildren(el("li", { class: "muted" }, t));
  fetch("data/changes.json", { cache: "no-store" })
    .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
    .then((c) => {
      const evs = c.events.slice(0, 10);
      if (!evs.length) { say(`No row has changed status since the daily snapshots began on ${short(c.since)}.`); return; }
      const name = (e) => (e.to ? el("a", { href: `board.html#${encodeURIComponent(e.id)}` }, e.name) : e.name);
      const st = (s) => [el("span", {}, cell(s), ` ${LABEL[s] || s}`)];
      box.replaceChildren(...evs.map((e) => {
        const li = el("li", {}, el("span", { class: "d" }, short(e.date)), el("span", {}, name(e), ":"));
        if (!e.from) li.append("added as", ...st(e.to));
        else if (!e.to) li.append("removed, was", ...st(e.from));
        else li.append(...st(e.from), el("span", { class: "to", "aria-label": "to" }, "→"), ...st(e.to));
        return li;
      }));
      $("chg-note").textContent = `A snapshot of every row is saved once a day, since ${short(c.since)}. Showing the latest ${evs.length} of ${c.events.length} changes.`;
    })
    .catch(() => say("The change log is not available right now. It starts with the first daily snapshot."));
}
changesList();

fetch("data/status.json", { cache: "no-store" })
  .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
  .then((d) => { data = d; strip(); wheel(); filters(); render(); sendCheck(); deadlinesList(d.chain, d.checked_at); openFromHash(); })
  .catch((e) => {
    const msg = `The latest check could not be loaded (${e.message}).`;
    if ($("live-text")) $("live-text").textContent = "The latest check could not be loaded";
    if ($("rows")) $("rows").replaceChildren(el("p", { class: "empty error" }, msg));
    if ($("wheel")) $("w-tip").textContent = msg;
    if ($("wallet-name")) $("wallet-name").textContent = "Unavailable: the latest check could not be loaded";
  });
