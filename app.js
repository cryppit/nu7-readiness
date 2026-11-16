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
  unknown: ["The checker", "retries at the next hourly run."],
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
  const what = el("span", { class: "what" }, state);
  if (text && text !== s.ref) what.append(` · ${text}`);
  const d = s.kind === "manual" ? `checked ${short(s.checked)}` : short(day(s.updated_at));
  return el("li", {},
    el("span", { class: "kind" }, KIND[s.kind] || s.kind),
    el("span", {}, el("a", { href: s.url, rel: "noopener" }, s.ref || text), what),
    el("span", { class: "d" }, d));
}

function render() {
  const rows = document.getElementById("rows");
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
  const all = el("button", { type: "button", class: "chip all", "data-f": "all", "aria-pressed": "true" }, `All ${data.rows.length}`);
  const chips = ORDER.filter((s) => s !== "unknown" || data.counts.unknown)
    .map((s) => el("button", { type: "button", class: "chip", "data-f": s, "aria-pressed": "false" }, cell(s), `${LABEL[s]} ${data.counts[s] || 0}`));
  for (const b of [all, ...chips]) b.addEventListener("click", () => { filter = b.dataset.f; render(); });
  box.replaceChildren(all, ...chips);
  document.getElementById("q").addEventListener("input", (e) => { query = e.target.value; render(); });
}

function strip() {
  const c = data.chain || {};
  document.getElementById("tip").textContent = fmt(c.tip);
  const total = data.rows.length;
  const ready = data.counts.fixed || 0;
  document.getElementById("live-text").textContent = c.active
    ? `NU7 is live · ${ready} of ${total} tracked projects are ready`
    : `NU7 is not active yet · ${ready} of ${total} tracked projects are ready`;
  const bar = document.getElementById("bar");
  bar.setAttribute("aria-label", ORDER.map((s) => `${LABEL[s]} ${data.counts[s] || 0}`).join(", "));
  bar.replaceChildren(...["fixed", "in-review", "watch", "unknown", "broken"].filter((s) => data.counts[s])
    .map((s) => el("span", { class: `b-${s}`, style: `width:${(100 * data.counts[s]) / total}%`, title: `${LABEL[s]}: ${data.counts[s]}` })));
  const tally = (s) => el("span", {}, cell(s), el("b", {}, String(data.counts[s] || 0)), LABEL[s].toLowerCase());
  document.getElementById("tally").replaceChildren(...["fixed", "in-review", "watch", "broken"].map(tally));
  document.getElementById("legend").replaceChildren(...ORDER.map((s) => el("span", { title: MEANS[s] }, cell(s), `${LABEL[s]}: ${MEANS[s]}`)));
  const banners = document.getElementById("banners");
  if (stale()) banners.append(el("p", { class: "banner" }, `This data is from ${when(data.checked_at)}, more than 8 hours ago. Statuses may have changed.`));
  if (c.error) banners.append(el("p", { class: "banner" }, "The chain height could not be read in the last check."));
  document.getElementById("checked").textContent = `Last checked: ${when(data.checked_at)}. Re-checked every hour.`;
}

function answerBox(box, cls, status, title, lines, extra) {
  box.className = `answer ${cls}`;
  box.replaceChildren(el("p", { class: "verdict" }, cell(status), title), ...lines.map((l, i) => el("p", i === 0 ? { class: "summary" } : {}, l)), ...extra);
}

const VERDICT_CELL = { yes: "fixed", "not-yet": "in-review", no: "broken", unclear: "watch", unknown: "unknown" };
function sendCheck() {
  const select = document.getElementById("wallet");
  const choices = NU7.pickerRows(data.rows);
  select.replaceChildren(el("option", { value: "" }, "Choose…"), ...choices.map((c) => el("option", { value: c.id }, c.label)));
  select.disabled = false;
  select.addEventListener("change", () => {
    const box = document.getElementById("answer");
    const row = data.rows.find((r) => r.id === select.value);
    if (!row) { box.replaceChildren(); return; }
    const a = NU7.sendAnswer(row, { stale: stale() });
    const [who, what] = NEXT[a.verdict] || NEXT.unknown;
    const next = el("p", { class: "next" }, "Who acts next: ", el("b", {}, who), ` · ${what}`);
    const link = el("p", { class: "next" }, el("a", { href: `#${row.id}` }, "See the evidence on the board"));
    link.firstChild.addEventListener("click", () => {
      filter = "all"; query = ""; document.getElementById("q").value = ""; render();
      const d = document.getElementById(row.id); if (d) d.open = true;
    });
    answerBox(box, `a-${a.verdict}`, VERDICT_CELL[a.verdict] || "unknown", a.headline, [a.summary, ...a.lines], [next, link]);
  });
}

function decode() {
  const box = document.getElementById("decoded");
  const d = NU7.decodeError(document.getElementById("err").value);
  if (!d) { box.replaceChildren(); return; }
  const link = d.source ? el("p", { class: "next" }, "Source: ", el("a", { href: d.source, rel: "noopener" }, d.source.replace("https://github.com/", ""))) : null;
  answerBox(box, d.id === "unknown" ? "a-unknown" : "a-decoded", d.id === "unknown" ? "unknown" : "watch", d.title, d.lines, [link]);
}
document.getElementById("explain").addEventListener("click", decode);
document.getElementById("err").addEventListener("paste", () => setTimeout(decode, 0));

function deadlinesList(chain, checkedAt) {
  const STATUS = { upcoming: "Upcoming", proposed: "Proposed", passed: "Passed" };
  document.getElementById("deadlines").replaceChildren(...NU7.deadlines(chain, checkedAt).map((d) => {
    const links = el("p", { class: "links" });
    d.links.forEach((l, i) => { if (i) links.append(" · "); links.append(el("a", { href: l.href, rel: "noopener" }, l.text)); });
    const glyph = el("span", { class: `cell c-${d.status}`, "aria-hidden": "true" }, d.status === "upcoming" ? "!" : d.status === "passed" ? "✓" : "?");
    return el("li", { class: "panel card" }, el("h3", {}, glyph, d.title, el("span", { class: "tag" }, STATUS[d.status])), ...d.lines.map((t) => el("p", {}, t)), links);
  }));
}
deadlinesList(null, null);

// Open the row named in the URL hash (links from posts point at #row-id).
function openFromHash() {
  const id = decodeURIComponent(location.hash.slice(1));
  const d = id && document.getElementById(id);
  if (d && d.tagName === "DETAILS") { d.open = true; d.scrollIntoView(); }
}

fetch("data/status.json", { cache: "no-store" })
  .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
  .then((d) => { data = d; strip(); filters(); render(); sendCheck(); deadlinesList(d.chain, d.checked_at); openFromHash(); })
  .catch((e) => {
    document.getElementById("live-text").textContent = "The latest check could not be loaded";
    document.getElementById("rows").replaceChildren(el("p", { class: "empty error" }, `The latest check could not be loaded (${e.message}).`));
    document.getElementById("wallet").replaceChildren(el("option", { value: "" }, "Unavailable: the latest check could not be loaded"));
  });
