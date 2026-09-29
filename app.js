/* PokeSniper web dashboard.
 *
 * A static page: everything goes straight from this browser to GitHub's API
 * with the access token you sign in with. Nothing else is involved.
 *   - Run: starts the scan workflow, shows its steps live, lists past runs
 *   - Results: what each run found, read from the private repo's `results`
 *     branch (written by publish_results.py after every run)
 *   - Cards / Settings / Schedule: edit cards.json, settings.json and the
 *     workflow's schedule, each saved as a commit on `main`. Cards also
 *     browses catalog/ (every set from Base Set on, built by
 *     catalog.py) by set or by Pokemon, and ticking a card there adds it
 *     to cards.json
 */
"use strict";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
const safeUrl = u => /^https:\/\//i.test(u || "") ? u : "#";
const num = v => (v == null || v === "" || isNaN(+v)) ? null : +v;
const money = v => v == null ? "—" : "$" + Number(v).toFixed(2);
const plural = (n, w, ws = w + "s") => `${n.toLocaleString()} ${n === 1 ? w : ws}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const store = {
  get(k, d) { try { const v = localStorage.getItem("ps_" + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem("ps_" + k, JSON.stringify(v)); } catch (e) {} },
  del(k) { try { localStorage.removeItem("ps_" + k); } catch (e) {} },
};

const API = "https://api.github.com";
const WORKFLOW = "scan.yml";
const WORKFLOW_PATH = ".github/workflows/" + WORKFLOW;
const EBAY_DAILY = 5000;
const ACTIONS_MONTHLY = 2000;        // free plan, private repo
// ETB Scanner: one eBay call per promo that's switched on, plus the token
const etbCalls = () => (S.promos.length ? S.promos.filter(p => !shared().etbOff.has(p.key)).length : 27) + 1;
const LANGS = ["japanese", "korean", "chinese", "thai", "indonesian", "italian"];
const DEMO = new URLSearchParams(location.search).has("demo");

const S = {
  token: "", repo: "",
  cfg: null, cfgSha: null,           // cards.json
  prices: {cards: {}},
  promos: [],                        // promos.json: the ETB Scanner's promos
  settings: {}, settingsSha: null,
  yml: "", ymlSha: null,
  changelog: null,
  refs: new Set(),                   // card keys with reference art in references/
  actions: [],                       // workflow runs, newest first
  selectedRun: null, jobs: {},       // run id -> jobs API answer
  results: null,                     // runs.json from the results branch (null = none yet)
  runData: new Map(),                // results run id -> {hits, etb}
  view: "run",
};

/* ------------------------------------------------------------------ helpers */
function toast(title, msg = "", kind = "") {
  const el = document.createElement("div");
  el.className = "toast " + kind;
  el.innerHTML = `<b>${esc(title)}</b>${esc(msg)}`;
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), kind === "bad" ? 9000 : 5000);
}
function patch(el, html) { if (el && el._html !== html) { el.innerHTML = html; el._html = html; } }
function fmtClock(d) { return d.toLocaleTimeString([], {hour: "numeric", minute: "2-digit"}); }
function fmtDay(d) {
  const today = new Date(), y = new Date(Date.now() - 864e5);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], {weekday: "short", month: "short", day: "numeric"});
}
function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return sec + "s";
  const m = Math.floor(sec / 60), s = sec % 60;
  return m < 60 ? `${m}m ${String(s).padStart(2, "0")}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
function fmtIn(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return "any minute";
  if (m < 60) return `in ${m} min`;
  return `in ${Math.floor(m / 60)}h ${m % 60}m`;
}
function meter(el, frac, invert) {
  const f = Math.max(0, Math.min(1, frac));
  el.firstElementChild.style.width = (f * 100).toFixed(1) + "%";
  const bad = invert ? f > 0.9 : f < 0.1, mid = invert ? f > 0.7 : f < 0.3;
  el.classList.toggle("low", bad); el.classList.toggle("mid", !bad && mid);
}

/* ------------------------------------------------------------------ GitHub API */
function b64decode(b64) {
  const bin = atob(b64.replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}
function b64encode(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

class GhError extends Error { constructor(msg, status) { super(msg); this.status = status; } }

async function gh(path, {method = "GET", body, raw = false} = {}) {
  if (DEMO) return window.PS_DEMO.handle(path, {method, body, raw});
  let res;
  try {
    res = await fetch(API + path, {
      method, cache: "no-store",
      headers: {
        Authorization: `Bearer ${S.token}`,
        Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? {"Content-Type": "application/json"} : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new GhError("Couldn't reach GitHub. Check your connection.", 0);
  }
  if (res.status === 401) { signOut("GitHub didn't accept the token (expired or revoked?). Sign in with a new one."); throw new GhError("Signed out", 401); }
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).message || msg; } catch (e) {}
    if (res.status === 403 && /Resource not accessible/i.test(msg))
      msg += " — the token is missing a permission (needs Actions, Contents and Workflows: Read and write).";
    throw new GhError(msg, res.status);
  }
  if (res.status === 204 || res.status === 202) return null;
  return raw ? res.text() : res.json();
}
const repoPath = p => `/repos/${S.repo}${p}`;
const contentsPath = (p, ref) => repoPath(`/contents/${p.split("/").map(encodeURIComponent).join("/")}` + (ref ? `?ref=${ref}` : ""));

async function getFile(path, ref = "main") {
  const j = await gh(contentsPath(path, ref));
  return {text: b64decode(j.content || ""), sha: j.sha};
}
async function getRaw(path, ref) { return gh(contentsPath(path, ref), {raw: true}); }

/* Read-modify-write one file on main. mutate(text) returns the new text;
 * on a conflict (someone else saved first) it re-reads and re-applies once. */
async function saveFile(path, mutate, message) {
  for (let attempt = 0; ; attempt++) {
    const cur = await getFile(path);
    const next = mutate(cur.text);
    if (next === cur.text) return cur;
    try {
      const r = await gh(contentsPath(path), {method: "PUT", body: {
        message, content: b64encode(next), sha: cur.sha, branch: "main"}});
      return {text: next, sha: r.content.sha};
    } catch (e) {
      if ((e.status === 409 || e.status === 422) && attempt === 0) continue;
      throw e;
    }
  }
}

/* ------------------------------------------------------------------ loading */
async function loadConfig() {
  // Prices: the newest run's copy, else whatever was last pushed to main
  const [cards, prices, settings, yml, changelog, tree, promos] = await Promise.allSettled([
    getFile("cards.json"), getRaw("prices.json", "results").catch(() => getRaw("prices.json", "main")), getFile("settings.json"),
    getFile(WORKFLOW_PATH), getRaw("changelog.json", "main"),
    gh(repoPath("/git/trees/main?recursive=1")), getRaw("promos.json", "main"),
  ]);
  if (promos.status === "fulfilled") try {
    S.promos = JSON.parse(promos.value).promos.map(p => ({...p, key: `${p.name} ${p.number}`}));
  } catch (e) {}
  if (cards.status === "rejected") throw cards.reason;
  S.cfg = JSON.parse(cards.value.text); S.cfgSha = cards.value.sha;
  if (prices.status === "fulfilled") try { S.prices = JSON.parse(prices.value); } catch (e) {}
  if (settings.status === "fulfilled") { S.settings = JSON.parse(settings.value.text || "{}"); S.settingsSha = settings.value.sha; }
  if (yml.status === "fulfilled") { S.yml = yml.value.text; S.ymlSha = yml.value.sha; }
  if (changelog.status === "fulfilled") try { S.changelog = JSON.parse(changelog.value); } catch (e) {}
  if (tree.status === "fulfilled") {
    S.refs = new Set();
    for (const t of tree.value.tree || []) {
      const m = /^references\/([^/]+)\/[^/]+\.(png|jpe?g|webp)$/i.exec(t.path);
      if (m) S.refs.add(m[1]);
    }
  }
}
async function loadActions() {
  const j = await gh(repoPath(`/actions/workflows/${WORKFLOW}/runs?per_page=25`));
  const before = new Map(S.actions.map(r => [r.id, r.status]));
  S.actions = j.workflow_runs || [];
  const finished = S.actions.filter(r => r.status === "completed" && before.has(r.id) && before.get(r.id) !== "completed");
  return finished;
}
async function loadResults() {
  try {
    S.results = JSON.parse(await getRaw("runs.json", "results"));
  } catch (e) {
    if (e.status === 404) S.results = null; else throw e;
  }
}
async function runData(id) {
  if (!S.runData.has(id)) {
    const [hits, etb] = await Promise.all([
      getRaw(`runs/${id}/hits.json`, "results").then(JSON.parse).catch(() => []),
      getRaw(`runs/${id}/etb.json`, "results").then(JSON.parse).catch(() => []),
    ]);
    S.runData.set(id, {hits, etb});
  }
  return S.runData.get(id);
}

/* ------------------------------------------------------------------ cards model */
function cardRows(pendingAware = true) {
  const table = (S.prices && S.prices.cards) || {};
  const pct = num(S.settings?.cloud?.price_pct) ?? num(S.cfg?.defaults?.price_pct) ?? 100;
  const adds = pendingAware ? [...Cd.adds.values()].filter(c => Cd.pending.get(c.key)) : [];
  return [...(S.cfg?.cards || []), ...adds].map(c => {
    const p = table[c.key] || {};
    const market = num(p.market) ?? num(c._market) ?? num(CAT.market.get(c.key));
    let cap = num(c.max_price), source = "manual";
    if (cap == null) { cap = market != null ? Math.round(market * pct) / 100 : num(S.cfg?.defaults?.max_price); source = market != null ? "market" : "default"; }
    const label = c.label || c.key;
    const [nameNum, setName] = label.split(" — ");
    const m = /-(\d+)-[a-z-]+$/.exec(c.key);
    const saved = !c._new && c.enabled !== false;
    const enabled = pendingAware && Cd.pending.has(c.key) ? Cd.pending.get(c.key) : saved;
    return {
      key: c.key, label, name: (nameNum || label).replace(/\s+[A-Z]*\d+[a-z]?$/, "").trim(),
      number: p.number || (m ? m[1] : ""), set: setName || "Other", rarity: p.rarity || "",
      enabled, saved, queries: (c.queries || [c.key]).length,
      market, cap, source, tcg: p.tcgplayer_id || c.tcgplayer_id,
      // Card Hunter fetches TCGplayer's scan for a card that has a product id
      hasRef: S.refs.has(c.key) || !!c.tcgplayer_id,
    };
  });
}
const tcgImg = (id, size = "200w") => id ? `https://tcgplayer-cdn.tcgplayer.com/product/${id}_${size}.jpg` : "";
const enabledCards = () => cardRows(false).filter(c => c.enabled);
// Buy It Now listed-within + auctions: card_hunter searches each query
// twice, newest-first and soonest-ending. Default: the scheduled runs' options.
const splitSearch = (type, newHours) => (type || "both") === "both" && num(newHours) > 0;
const cloudSplit = () => splitSearch(S.settings?.cloud?.type, S.settings?.cloud?.new_hours);
const callsPerRun = (cards, etb = true, split = cloudSplit()) =>
  cards.reduce((n, c) => n + c.queries, 0) * (split ? 2 : 1) + (etb ? etbCalls() : 0);

/* Average billed minutes of recent successful runs, else a guess from card count */
function minutesPerRun() {
  const done = S.actions.filter(r => r.status === "completed" && r.conclusion === "success" && r.run_started_at).slice(0, 10);
  if (done.length) {
    const avg = done.reduce((n, r) => n + (Date.parse(r.updated_at) - Date.parse(r.run_started_at)) / 60000, 0) / done.length;
    return Math.max(1, avg);
  }
  return 2 + enabledCards().length * 0.03;
}

/* ------------------------------------------------------------------ header */
function lastReset(now = new Date()) {       // eBay's quota resets 07:00 UTC
  const r = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 7));
  if (r > now) r.setUTCDate(r.getUTCDate() - 1);
  return r;
}
function renderQuota() {
  const last = (S.results || []).find(r => r.api_left != null);
  if (!last) { $("#q-num").textContent = "—"; $("#q-sub").textContent = "Shows after the first published run"; meter($("#q-meter"), 0); return; }
  const at = new Date(last.finished || last.started);
  const reset = at < lastReset();
  const left = reset ? EBAY_DAILY : last.api_left;
  $("#q-num").textContent = left.toLocaleString();
  $("#q-sub").textContent = reset ? "Reset since the last run" : `As of the ${fmtClock(at)} run · resets 3 AM Eastern`;
  meter($("#q-meter"), left / EBAY_DAILY);
}
function renderVersion() {
  const v = S.changelog?.versions?.[0]?.version;
  const b = $("#ver");
  b.classList.toggle("hidden", !v);
  if (v) b.textContent = "v" + v;
}
$("#ver").onclick = () => {
  const vs = S.changelog?.versions || [];
  $("#cl-body").innerHTML = vs.map(v => `<div class="rel"><div class="rel-head"><span class="rel-v">v${esc(v.version)}</span>
      <span class="rel-t">${esc(v.title)}</span><span class="rel-d">${esc(v.date)}</span></div>
      <ul>${(v.notes || []).map(n => `<li>${esc(n)}</li>`).join("")}</ul></div>`).join("");
  $("#cl").classList.remove("hidden");
};
$("#cl-close").onclick = () => $("#cl").classList.add("hidden");
$("#cl").onclick = e => { if (e.target.id === "cl") $("#cl").classList.add("hidden"); };

(function theme() {
  const saved = store.get("theme", null);
  if (saved) document.documentElement.dataset.theme = saved;
  $("#theme-btn").onclick = () => {
    const cur = document.documentElement.dataset.theme ||
      (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
    const next = cur === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    store.set("theme", next);
  };
})();

function show(view) {
  S.view = view;
  $$("#nav button").forEach(b => b.classList.toggle("active", b.dataset.view === view));
  $$(".view").forEach(v => v.classList.toggle("hidden", v.id !== "view-" + view));
  store.set("view", view);
  ({run: renderRun, results: renderResults, cards: () => { renderCards(); loadCatalog(); }, schedule: renderSchedule, settings: renderSettings}[view] || (() => {}))();
}
$("#nav").onclick = e => { const b = e.target.closest("[data-view]"); if (b) show(b.dataset.view); };
document.addEventListener("click", e => { const b = e.target.closest("[data-goto]"); if (b) show(b.dataset.goto); });

/* ================================================================== RUN */
const RN = {cards: [], sel: -1, ready: false};

// The options start as the scheduled runs' (Settings tab), and a run sends
// only what's different: auto_run.py puts it on top of those.
function usualRun() {
  const c = S.settings?.cloud || {};
  return {type: c.type || "both", newh: num(c.new_hours) || 0, hours: num(c.auction_hours) ?? 5,
          pct: num(c.price_pct) ?? num(S.cfg?.defaults?.price_pct) ?? 100};
}
function initRunForm() {
  if (RN.ready || !S.cfg || !S.settings) return;
  RN.ready = true;
  const u = usualRun();
  $("#rn-bin").checked = u.type !== "auction";
  $("#rn-auc").checked = u.type !== "buy-now";
  $("#rn-new-on").checked = u.newh > 0;
  $("#rn-new").value = u.newh || 24;
  $("#rn-auc-on").checked = u.hours > 0;
  $("#rn-hours").value = u.hours || 5;
  $("#rn-pct").value = u.pct;
  $("#rn-score").placeholder = S.cfg?.defaults?.min_score ?? 55;
}
function runForm() {
  const bin = $("#rn-bin").checked, auc = $("#rn-auc").checked;
  return {bin, auc, type: bin && auc ? "both" : bin ? "buy-now" : auc ? "auction" : "",
          newh: bin && $("#rn-new-on").checked ? num($("#rn-new").value) : 0,
          hours: auc && $("#rn-auc-on").checked ? num($("#rn-hours").value) : 0,
          price: num($("#rn-price").value), pct: num($("#rn-pct").value), score: num($("#rn-score").value)};
}
function runArgs() {
  const f = runForm(), u = usualRun(), a = [];
  RN.cards.forEach(k => a.push("--card", k));
  if (f.type !== u.type) a.push("--type", f.type);
  if (f.bin && f.newh !== u.newh) a.push("--new-hours", String(f.newh));
  if (f.auc && f.hours !== u.hours) a.push("--auction-hours", String(f.hours));
  if (f.price != null) a.push("--max-price", String(f.price));
  else if (f.pct != null && f.pct !== u.pct) a.push("--price-pct", String(f.pct));
  if (f.score != null) a.push("--min-score", String(Math.round(f.score)));
  if ($("#rn-all").checked) a.push("--all");
  return a;
}
// why the run can't start yet, if it can't
function runProblem() {
  if (!$("#rn-etb").checked && !$("#rn-hunter").checked) return "Nothing selected";
  if (!$("#rn-hunter").checked) return "";
  const f = runForm();
  if (!f.type) return "Pick Buy It Now, Auctions or both";
  if (f.bin && $("#rn-new-on").checked && !(f.newh >= 1)) return "Listed within: at least 1 hour";
  if (f.auc && $("#rn-auc-on").checked && !(f.hours >= 1)) return "Ending within: at least 1 hour";
  if ($("#rn-price").value.trim() && !(f.price > 0)) return "Max price must be over $0";
  if (f.price == null && $("#rn-pct").value.trim() && !(f.pct > 0)) return "% of market must be over 0";
  if ($("#rn-score").value.trim() && !(f.score >= 0 && f.score <= 100)) return "Min score goes from 0 to 100";
  return "";
}
function syncRunForm() {
  const bin = $("#rn-bin").checked, auc = $("#rn-auc").checked;
  $("#rn-new-on").disabled = !bin;
  $("#rn-new").disabled = !bin || !$("#rn-new-on").checked;
  $("#rn-new").closest(".lfilter").classList.toggle("off", !bin);
  $("#rn-auc-on").disabled = !auc;
  $("#rn-hours").disabled = !auc || !$("#rn-auc-on").checked;
  $("#rn-hours").closest(".lfilter").classList.toggle("off", !auc);
  $("#rn-pct").disabled = $("#rn-price").value.trim() !== "";          // a flat cap replaces it
  $("#rn-etb-tool").classList.toggle("off", !$("#rn-etb").checked);
  $("#rn-hunter-tool").classList.toggle("off", !$("#rn-hunter").checked);
  renderRunCost();
}
function renderRunCost() {
  const etb = $("#rn-etb").checked, hunter = $("#rn-hunter").checked;
  const cards = RN.cards.length ? cardRows(false).filter(c => RN.cards.includes(c.key)) : enabledCards();
  const f = runForm(), hunterCalls = callsPerRun(cards, false, splitSearch(f.type, f.newh));
  const problem = runProblem();
  $("#rn-etb-cost").textContent = `≈ ${plural(etbCalls(), "eBay call")}`;
  $("#rn-hunter-cost").textContent = `${plural(cards.length, "card")} · ≈ ${plural(hunterCalls, "eBay call")}` +
    (splitSearch(f.type, f.newh) ? " (each search runs twice: newest Buy It Now, then auctions)" : "");
  $("#rn-cost").textContent = problem || `≈ ${((hunter ? hunterCalls : 0) + (etb ? etbCalls() : 0)).toLocaleString()} eBay calls`;
  $("#rn-cost").classList.toggle("bad-t", !!problem && problem !== "Nothing selected");
  $("#rn-go").disabled = !!problem;
}
["input", "change"].forEach(ev => $("#view-run").addEventListener(ev, e => {
  if (e.target.closest(".tool") && /^rn-(etb|hunter|email|price|score|pct|bin|auc|new|hours|all)/.test(e.target.id || "")) syncRunForm();
}));

// Saved for every run, scheduled ones too, as on the PC: the ZIP, the
// languages and the ETB promos. A change saves a moment later, so a burst of
// ticks is one commit; SV.want holds it until then.
const SV = {want: null, note: "", timer: null};
function shared() {
  if (SV.want) return SV.want;
  const s = S.settings || {};
  return {zip: s.ship_to_zip || "", off: new Set(s.exclude_languages || []), condOff: new Set(s.exclude_conditions || []),
          graded: {include_graded: s.include_graded === true, etb_include_graded: s.etb_include_graded === true},
          etbOff: new Set(s.etb_off || [])};
}
function changeShared(fn, note) {
  const w = shared();
  SV.want = {zip: w.zip, off: new Set(w.off), condOff: new Set(w.condOff), graded: {...w.graded}, etbOff: new Set(w.etbOff)};
  fn(SV.want);
  SV.note = SV.note && SV.note !== note ? "run settings" : note;
  clearTimeout(SV.timer);
  SV.timer = setTimeout(flushShared, 1200);
  renderRunShared(); renderRunCost();
}
async function flushShared() {
  clearTimeout(SV.timer); SV.timer = null;
  const w = SV.want, note = SV.note;
  if (!w) return;
  SV.note = "";
  try {
    const r = await saveFile("settings.json", text => {
      const d = JSON.parse(text || "{}");
      d.ship_to_zip = w.zip;
      d.exclude_languages = LANGS.filter(l => w.off.has(l));
      d.exclude_conditions = CONDS.map(([c]) => c).filter(c => w.condOff.has(c));
      d.include_graded = w.graded.include_graded;
      d.etb_include_graded = w.graded.etb_include_graded;
      if (S.promos.length) d.etb_off = S.promos.map(p => p.key).filter(k => w.etbOff.has(k));
      return JSON.stringify(d, null, 2) + "\n";
    }, `Dashboard: ${note}`);
    S.settings = JSON.parse(r.text); S.settingsSha = r.sha;
    if (!SV.timer) SV.want = null;               // nothing newer waiting
    toast("Saved", "Every run uses it from now on.", "good");
  } catch (e) {
    if (e.status !== 401) toast("Couldn't save", e.message, "bad");
  }
  renderRunShared(); renderRunCost();
}
document.addEventListener("visibilitychange", () => { if (document.hidden && SV.timer) flushShared(); });

function renderRunShared() {
  const w = shared();
  if (document.activeElement?.id !== "rn-zip") $("#rn-zip").value = w.zip;
  $("#rn-zip-notice").classList.toggle("hidden", !!w.zip);
  const cap = l => l[0].toUpperCase() + l.slice(1);
  patch($("#rn-langs"), `<label class="dd-item" title="Always included"><input type="checkbox" checked disabled> English</label>` +
    LANGS.map(l => `<label class="dd-item"><input type="checkbox" data-lang="${l}" ${w.off.has(l) ? "" : "checked"}> ${cap(l)}</label>`).join(""));
  const langsOn = LANGS.filter(l => !w.off.has(l));
  $("#lang-dd-label").textContent = langsOn.length === LANGS.length ? "All languages" : langsOn.length ? `English + ${langsOn.map(cap).join(", ")}` : "English only";
  patch($("#rn-conds"), CONDS.map(([c, name]) =>
    `<label class="dd-item"><input type="checkbox" data-cond="${c}" ${w.condOff.has(c) ? "" : "checked"}> ${name}<span class="num">${c}</span></label>`).join(""));
  const condsOn = CONDS.map(([c]) => c).filter(c => !w.condOff.has(c));
  $("#cond-dd-label").textContent = condsOn.length === CONDS.length ? "All conditions" : condsOn.length ? condsOn.join(", ") : "None: every listing is dropped";
  // graded slabs: one tick per tool, left out unless ticked
  $$("[data-graded]").forEach(b => b.checked = w.graded[b.dataset.graded]);
  $("#cond-dd-btn").classList.toggle("none", !condsOn.length);
  const at = S.prices?.updated ? new Date(S.prices.updated) : null;
  $("#rn-prices-age").textContent = at && !isNaN(at)
    ? `Market prices from ${at.toLocaleString([], {month: "short", day: "numeric", hour: "numeric", minute: "2-digit"})}. Each day's first run refreshes them.`
    : "No market prices yet. The next run fetches them.";
  renderPromos();
}
$("#rn-zip").addEventListener("change", e => {
  const v = e.target.value.trim();
  if (v && !/^\d{5}$/.test(v)) { toast("ZIP must be 5 digits", "", "bad"); e.target.value = shared().zip; return; }
  if (v !== shared().zip) changeShared(w => { w.zip = v; }, v ? `ship to ${v}` : "clear the ship-to ZIP");
});
$("#rn-langs").addEventListener("change", e => {
  const l = e.target.dataset.lang; if (!l) return;
  changeShared(w => { if (e.target.checked) w.off.delete(l); else w.off.add(l); }, "languages");
});
$("#rn-conds").addEventListener("change", e => {
  const c = e.target.dataset.cond; if (!c) return;
  changeShared(w => { if (e.target.checked) w.condOff.delete(c); else w.condOff.add(c); }, "conditions");
});
$$("[data-graded]").forEach(b => b.addEventListener("change", e => {
  const key = e.target.dataset.graded, tool = key === "include_graded" ? "Card Hunter" : "ETB Scanner";
  changeShared(w => { w.graded[key] = e.target.checked; },
    `${tool}: ${e.target.checked ? "include" : "leave out"} graded slabs`);
}));
for (const id of ["lang", "cond"]) $(`#${id}-dd-btn`).onclick = () => {
  const open = $(`#${id}-dd-panel`).classList.toggle("hidden") === false;
  $(`#${id}-dd-btn`).setAttribute("aria-expanded", open);
};

// ETB promos: every one is on unless it's in settings.json's etb_off
function renderPromos() {
  const list = S.promos, off = shared().etbOff, on = list.filter(p => !off.has(p.key)).length;
  $("#etb-dd-label").textContent = !list.length ? "Couldn't load promos.json" : on === list.length ? `All ${list.length} promos` :
    on === 0 ? "No promos selected: the ETB Scanner will search nothing" : `${on} of ${list.length} promos`;
  $("#etb-dd-btn").classList.toggle("none", list.length > 0 && on === 0);
  $("#etb-dd-count").textContent = `${on} of ${list.length} on`;
  let html = "", set = null;
  for (const p of list) {
    if (p.set !== set) { set = p.set; html += `<div class="dd-set">${esc(set)}</div>`; }
    html += `<label class="dd-item"><input type="checkbox" data-promo="${esc(p.key)}" ${off.has(p.key) ? "" : "checked"}>
      <span>${esc(p.name)}</span><span class="num">${esc(p.number)}</span></label>`;
  }
  const el = $("#etb-dd-list"), top = el.scrollTop;
  patch(el, html);
  el.scrollTop = top;
}
$("#etb-dd-btn").onclick = () => {
  const open = $("#etb-dd-panel").classList.toggle("hidden") === false;
  $("#etb-dd-btn").setAttribute("aria-expanded", open);
};
$("#etb-dd-list").addEventListener("change", e => {
  const k = e.target.dataset.promo; if (!k) return;
  changeShared(w => { if (e.target.checked) w.etbOff.delete(k); else w.etbOff.add(k); }, "ETB promos");
});
$("#etb-all").onclick = () => changeShared(w => { w.etbOff.clear(); }, "ETB promos");
$("#etb-none").onclick = () => changeShared(w => { w.etbOff = new Set(S.promos.map(p => p.key)); }, "ETB promos");

// card picker
function renderChips() {
  const rows = cardRows(false);
  $("#rn-chips").innerHTML = RN.cards.map(k => {
    const c = rows.find(r => r.key === k);
    return `<span class="chip">${esc(c ? c.label : k)}<button data-unpick="${esc(k)}" title="Remove">×</button></span>`;
  }).join("");
  $("#rn-card-input").placeholder = RN.cards.length ? "Add another card…" :
    `All ${enabledCards().length} cards switched on — type to pick specific ones`;
  renderRunCost();
}
function renderSuggest() {
  const q = $("#rn-card-input").value.trim().toLowerCase();
  const box = $("#rn-suggest");
  if (!q) { box.classList.add("hidden"); return; }
  const words = q.split(/\s+/);
  const hits = cardRows(false).filter(c => !RN.cards.includes(c.key) &&
    words.every(w => (c.label + " " + c.key).toLowerCase().includes(w))).slice(0, 12);
  RN.sel = Math.min(RN.sel, hits.length - 1);
  box.innerHTML = hits.map((c, i) => `<div data-pick="${esc(c.key)}" class="${i === RN.sel ? "on" : ""}">${esc(c.label)}<small>${c.enabled ? "" : "off"}</small></div>`).join("")
    || `<div class="muted">No card matches</div>`;
  box.classList.remove("hidden");
}
function pick(key) { if (key && !RN.cards.includes(key)) RN.cards.push(key); $("#rn-card-input").value = ""; RN.sel = -1; renderSuggest(); renderChips(); }
$("#rn-card-input").addEventListener("input", () => { RN.sel = 0; renderSuggest(); });
$("#rn-card-input").addEventListener("keydown", e => {
  const items = $$("#rn-suggest [data-pick]");
  if (e.key === "ArrowDown") { RN.sel = Math.min(items.length - 1, RN.sel + 1); renderSuggest(); e.preventDefault(); }
  else if (e.key === "ArrowUp") { RN.sel = Math.max(0, RN.sel - 1); renderSuggest(); e.preventDefault(); }
  else if (e.key === "Enter" && items[RN.sel]) { pick(items[RN.sel].dataset.pick); e.preventDefault(); }
  else if (e.key === "Escape") { $("#rn-suggest").classList.add("hidden"); }
});
$("#rn-card-input").addEventListener("blur", () => setTimeout(() => $("#rn-suggest").classList.add("hidden"), 150));
$("#rn-suggest").addEventListener("mousedown", e => { const d = e.target.closest("[data-pick]"); if (d) { e.preventDefault(); pick(d.dataset.pick); } });
$("#rn-chips").onclick = e => { const b = e.target.closest("[data-unpick]"); if (b) { RN.cards = RN.cards.filter(k => k !== b.dataset.unpick); renderChips(); } };

$("#rn-go").onclick = async () => {
  const active = S.actions.find(r => r.status !== "completed");
  if (active && !confirm("A run is already going. Start another? It will wait until that one finishes.")) return;
  const btn = $("#rn-go");
  btn.disabled = true; btn.textContent = "Starting…";
  const clicked = Date.now(), known = new Set(S.actions.map(r => r.id));
  try {
    await gh(repoPath(`/actions/workflows/${WORKFLOW}/dispatches`), {method: "POST", body: {ref: "main", inputs: {
      etb: String($("#rn-etb").checked), hunter: String($("#rn-hunter").checked),
      email: String($("#rn-email").checked), hunter_args: runArgs().join(" "),
    }}});
    // GitHub doesn't say which run it started; watch for it to appear
    let found = null;
    for (let i = 0; i < 12 && !found; i++) {
      await sleep(i ? 2500 : 1500);
      await loadActions();
      found = S.actions.find(r => !known.has(r.id) && r.event === "workflow_dispatch" && Date.parse(r.created_at) > clicked - 60000);
    }
    if (found) { S.selectedRun = found.id; toast("Run started", "Watch it here, or close the page — it runs on GitHub either way.", "good"); }
    else toast("Run requested", "GitHub hasn't listed it yet; it'll appear here shortly.");
    renderRun(); schedulePoll(1000);
  } catch (e) {
    if (e.status !== 401) toast("Couldn't start the run", e.message, "bad");
  } finally {
    btn.textContent = "Run now"; renderRunCost();
  }
};

function runDot(r) {
  if (r.status !== "completed") return "run";
  return r.conclusion === "success" ? "ok" : r.conclusion === "cancelled" ? "stop" : "fail";
}
const runLabel = r => r.event === "workflow_dispatch" ? "Manual" : r.event === "schedule" ? "Scheduled" : r.event;
const runTime = r => new Date(r.run_started_at || r.created_at);
const resultFor = r => (S.results || []).find(x => x.run_id === r.id);

function typicalSeconds() {
  const done = S.actions.filter(r => r.status === "completed" && r.conclusion === "success" && r.run_started_at).slice(0, 8);
  if (!done.length) return 420;
  return done.reduce((n, r) => n + (Date.parse(r.updated_at) - Date.parse(r.run_started_at)) / 1000, 0) / done.length;
}

function renderRun() {
  initRunForm();
  renderRunShared();
  syncRunForm();
  renderNext();
  const runs = S.actions;
  const running = runs.filter(r => r.status !== "completed").length;
  const badge = $("#nav-running");
  badge.classList.toggle("hidden", !running); badge.textContent = running;
  if (!runs.length) {
    patch($("#runs-pills"), "");
    patch($("#run-status"), `<span class="muted">No runs yet</span>`);
    patch($("#run-steps"), `<div class="empty"><div>No runs yet. Press <b>Run now</b>, or wait for the schedule.</div></div>`);
    return;
  }
  if (!runs.some(r => r.id === S.selectedRun)) S.selectedRun = (runs.find(r => r.status !== "completed") || runs[0]).id;
  patch($("#runs-pills"), runs.slice(0, 15).map(r => {
    const t = runTime(r);
    return `<button class="job-pill ${r.id === S.selectedRun ? "active" : ""}" data-run="${r.id}" title="${esc(runLabel(r))} run #${r.run_number}">
      <span class="dot ${runDot(r)}"></span>${esc(fmtDay(t) === "Today" ? fmtClock(t) : fmtDay(t) + " " + fmtClock(t))}</button>`;
  }).join(""));
  renderRunDetail();
}
$("#runs-pills").onclick = e => {
  const b = e.target.closest("[data-run]"); if (!b) return;
  S.selectedRun = +b.dataset.run; renderRun();
  const r = S.actions.find(x => x.id === S.selectedRun);
  if (r && !S.jobs[r.id]) loadJobs(r).then(renderRunDetail);
};
$("#runs-refresh").onclick = () => pollTick(true);

async function loadJobs(r) {
  try { S.jobs[r.id] = await gh(repoPath(`/actions/runs/${r.id}/jobs`)); } catch (e) {}
}

const ICON = {
  ok: `<svg viewBox="0 0 24 24" fill="none" stroke="var(--good)" stroke-width="2.5"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`,
  fail: `<svg viewBox="0 0 24 24" fill="none" stroke="var(--bad)" stroke-width="2.5"><path d="M6 6l12 12M18 6L6 18"/></svg>`,
  skip: `<svg viewBox="0 0 24 24" fill="none" stroke="var(--faint)" stroke-width="2"><path d="M6 12h12"/></svg>`,
  run: `<svg class="spin" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2.5"><path d="M12 3a9 9 0 1 0 9 9"/></svg>`,
  wait: `<svg viewBox="0 0 24 24" fill="none" stroke="var(--faint)" stroke-width="2"><circle cx="12" cy="12" r="7"/></svg>`,
};
// GitHub's own housekeeping steps; only ours are worth showing
const HIDDEN_STEPS = /^(Set up job|Complete job|Post |Run actions\/|pip install|Run pip install)/;

function renderRunDetail() {
  const r = S.actions.find(x => x.id === S.selectedRun);
  if (!r) return;
  const t = runTime(r), active = r.status !== "completed";
  const elapsed = ((active ? Date.now() : Date.parse(r.updated_at)) - t) / 1000;
  const state = active ? (r.status === "queued" || r.status === "waiting" ? "Waiting to start" : "Running") :
    {success: "Finished", failure: "Failed", cancelled: "Cancelled", timed_out: "Timed out"}[r.conclusion] || r.conclusion;
  const res = resultFor(r);
  const typical = typicalSeconds();
  const bar = active && r.status === "in_progress"
    ? `<div class="meter"><div style="width:${Math.min(95, 100 * elapsed / typical).toFixed(0)}%"></div></div>` : "";
  patch($("#run-status"), `<span class="dot ${runDot(r)}"></span>
    <span class="title">${esc(runLabel(r))} run #${r.run_number} · ${esc(fmtDay(t))} ${esc(fmtClock(t))}</span>
    <span class="muted">${esc(state)} · ${fmtDur(elapsed)}${active && r.status === "in_progress" ? ` of ~${fmtDur(typical)}` : ""}</span>
    ${bar}
    <span class="actions">
      ${active ? `<button class="btn sm danger" id="run-cancel">Cancel</button>` : ""}
      ${res ? `<button class="btn sm" data-open-result="${esc(res.id)}">View results</button>` : ""}
      <a class="btn sm" href="${esc(safeUrl(r.html_url))}" target="_blank" rel="noopener">Log on GitHub ↗</a>
    </span>`);
  const cancel = $("#run-cancel");
  if (cancel) cancel.onclick = async () => {
    if (!confirm("Cancel this run? Anything it already found stays marked as seen only if it got that far.")) return;
    try { await gh(repoPath(`/actions/runs/${r.id}/cancel`), {method: "POST"}); toast("Cancelling…"); schedulePoll(1500); }
    catch (e) { toast("Couldn't cancel", e.message, "bad"); }
  };

  const job = (S.jobs[r.id]?.jobs || [])[0];
  let html = "";
  if (res) {
    const bits = [];
    if (res.stamped) bits.push(`<span class="badge stamped">${res.stamped} stamped</span>`);
    bits.push(`<span class="badge ${res.matches ? "cards" : "quiet"}">${plural(res.matches, "match", "matches")}</span>`);
    if (res.deals) bits.push(`<span class="badge deal">${res.deals} at ≤60% of market</span>`);
    if (res.failures?.length) bits.push(`<span class="badge fail">${esc(res.failures.join(" & "))} failed</span>`);
    bits.push(`<span class="muted">${res.emailed ? "Emailed" : res.email_error ? "Email failed: " + esc(res.email_error) : (res.matches || res.stamped) ? "Not emailed" : "Nothing new, no email"}</span>`);
    if (res.api_used != null) bits.push(`<span class="muted">· ${res.api_used} eBay calls</span>`);
    html += `<div class="run-sum">${bits.join("")}</div>`;
  } else if (!active && r.conclusion === "success") {
    html += `<div class="run-sum muted">This run finished before the dashboard existed, or its results aren't published yet.</div>`;
  }
  if (job) {
    const steps = job.steps.filter(s => !HIDDEN_STEPS.test(s.name));
    html += steps.map(s => {
      const st = s.status !== "completed" ? (s.status === "in_progress" ? "run" : "wait") :
        s.conclusion === "success" ? "ok" : s.conclusion === "skipped" ? "skip" : "fail";
      const cls = st === "run" ? "active" : st === "wait" ? "pending" : st === "fail" ? "failed" : "";
      const dur = s.started_at ? ((s.completed_at ? Date.parse(s.completed_at) : Date.now()) - Date.parse(s.started_at)) / 1000 : null;
      return `<div class="step ${cls}"><span class="ico">${ICON[st]}</span><span class="nm">${esc(stepName(s.name))}</span>
        <span class="tm">${dur != null && st !== "skip" ? fmtDur(dur) : ""}</span></div>`;
    }).join("");
  } else if (r.status === "queued" || r.status === "waiting") {
    html += `<div class="empty"><div>Waiting for GitHub to start it. Usually under a minute; longer if another run is still going.</div></div>`;
  } else {
    html += `<div class="empty"><div class="muted">Loading steps…</div></div>`;
  }
  patch($("#run-steps"), html);
}
function stepName(n) {
  return {"Scan and email": "Scan eBay, check photos, email", "Publish results for the dashboard": "Publish results for this dashboard",
          "Restore seen lists from the last run": "Load the seen lists", "Save seen lists for the next run": "Save the seen lists",
          "Keep the reports and logs for 14 days": "Keep the reports and logs"}[n] || n;
}
document.addEventListener("click", e => {
  const b = e.target.closest("[data-open-result]");
  if (b) { RS.sel = b.dataset.openResult; show("results"); }
});

/* ---- next scheduled run (Run tab card) */
function renderNext() {
  const sch = parseSchedule(S.yml);
  const s = $("#nx-summary"), n = $("#nx-next");
  if (!sch.ok) { s.textContent = "Couldn't read the schedule"; n.textContent = ""; return; }
  if (sch.paused) { s.textContent = "Paused — only Run now starts runs."; n.textContent = ""; return; }
  s.textContent = sch.every ? describeEvery(sch) : "Custom schedule";
  const next = nextRun(sch);
  n.textContent = next ? `Next: ${fmtDay(next)} ${fmtClock(next)} (${fmtIn(next - Date.now())}), if GitHub is on time.` : "";
}

/* ================================================================== RESULTS */
// pct: hide listings over this % of market (0 = any); starts at 100
const RS = {sel: null, list: "", filter: "finds", q: "", sort: "deal", pct: 100, items: [], shown: [], limit: 240};
Object.assign(RS, store.get("results", {}), {sel: null, q: "", limit: 240});

function runBadges(r) {
  const b = [];
  if (r.failures?.length) b.push(`<span class="badge fail" title="${esc(r.failures.join(", "))} failed">failed</span>`);
  if (r.stamped) b.push(`<span class="badge stamped">${r.stamped} stamped</span>`);
  if (r.matches) b.push(`<span class="badge cards">${plural(r.matches, "match", "matches")}</span>`);
  if (r.deals) b.push(`<span class="badge deal">${r.deals} deal${r.deals === 1 ? "" : "s"}</span>`);
  if (!b.length) b.push(`<span class="badge quiet">nothing new</span>`);
  return b.join("");
}
function recentRuns(hours = 24) { return (S.results || []).filter(r => Date.now() - Date.parse(r.started) < hours * 3600e3); }

function renderResultList() {
  $$("#rl-filters button").forEach(b => b.classList.toggle("active", b.dataset.f === RS.list));
  if (S.results == null) {
    patch($("#rl-body"), `<div class="empty"><div>No published runs yet.<br><span class="hint">Each run publishes here once it finishes.</span></div></div>`);
    return;
  }
  const recent = recentRuns();
  const agg = recent.reduce((a, r) => ({stamped: a.stamped + r.stamped, matches: a.matches + r.matches, deals: a.deals + r.deals}), {stamped: 0, matches: 0, deals: 0});
  let html = `<div class="ritem ${RS.sel === "__24h" ? "active" : ""}" data-res="__24h">
      <div class="r1"><b>Last 24 hours</b>${runBadges(agg)}</div>
      <div class="r2">${plural(recent.length, "run")} combined</div></div>`;
  let day = null;
  for (const r of S.results) {
    if (RS.list === "finds" && !(r.matches || r.stamped)) continue;
    if (RS.list === "stamped" && !r.stamped) continue;
    const t = new Date(r.started), d = fmtDay(t);
    if (d !== day) { html += `<div class="rdate">${esc(d)}</div>`; day = d; }
    html += `<div class="ritem ${RS.sel === r.id ? "active" : ""}" data-res="${esc(r.id)}">
      <div class="r1"><b>${esc(fmtClock(t))}</b><span class="muted">${r.event === "workflow_dispatch" ? "manual" : r.event === "schedule" ? "scheduled" : esc(r.event)}</span>${runBadges(r)}</div>
      <div class="r2" title="${esc(r.info)}">${esc(r.info || "")}</div></div>`;
  }
  patch($("#rl-body"), html);
}
$("#rl-filters").onclick = e => { const b = e.target.closest("[data-f]"); if (b) { RS.list = b.dataset.f; saveRS(); renderResultList(); } };
$("#rl-body").onclick = e => { const d = e.target.closest("[data-res]"); if (d) { RS.sel = d.dataset.res; RS.limit = 240; renderResults(); } };
function saveRS() { store.set("results", {list: RS.list, filter: RS.filter, sort: RS.sort, pct: RS.pct}); }

/* One shape for Card Hunter matches and ETB listings */
function normalize(kind, r, runId) {
  const it = r.item || {};
  const price = num(it.price?.value) ?? num(it.currentBidPrice?.value);
  const ships = (it.shippingOptions || []).map(o => num(o.shippingCost?.value)).filter(v => v != null);
  const ship = ships.length ? Math.min(...ships) : null;
  const total = price == null ? null : Math.round((price + (ship || 0)) * 100) / 100;
  const market = kind === "hunt" ? num(r.market) : null;
  const pct = total != null && market ? Math.round(100 * total / market) : null;
  const opts = it.buyingOptions || [];
  const auction = opts.includes("AUCTION");
  const img = it.image?.imageUrl || "";
  const minScore = num(r.min_score) ?? 55;
  return {
    kind, runId, id: it.itemId || Math.random().toString(36), title: it.title || "(no title)",
    url: safeUrl(it.itemWebUrl), img: img.replace(/s-l\d+/, "s-l500"),
    photo: kind === "hunt" && r.photo ? r.photo : img.replace(/s-l\d+/, "s-l1600"),
    card: kind === "hunt" ? (r.label || r.card) : r.card, key: kind === "hunt" ? r.card : null,
    score: num(r.score), strong: kind === "hunt" && (num(r.score) || 0) >= Math.min(95, minScore + 15),
    verdict: kind === "etb" ? (r.verdict || {}) : null,
    stamped: kind === "etb" && r.verdict?.verdict === "stamped",
    price, ship, shipKnown: ships.length > 0, total, market, pct, auction,
    bestOffer: opts.includes("BEST_OFFER"), bids: it.bidCount, end: auction && it.itemEndDate ? Date.parse(it.itemEndDate) : null,
    seller: it.seller?.username, feedback: it.seller?.feedbackPercentage, condition: it.condition,
    // the card condition Card Hunter priced it by (NM ... DMG), when it read one
    cond: kind === "hunt" ? r.condition || null : null,
    // "PSA 9" for a graded slab, which has no market price to compare
    grade: kind === "hunt" ? r.grade || null : null,
  };
}
const FILTERS = [
  ["finds", "Finds", x => x.kind === "hunt" || x.stamped],
  ["stamped", "Stamped", x => x.stamped],
  ["strong", "Strong matches", x => x.strong],
  ["auction", "Auctions", x => x.auction && (x.kind === "hunt" || x.stamped)],
  ["bin", "Buy It Now", x => !x.auction && (x.kind === "hunt" || x.stamped)],
  ["etb", "All ETB listings", x => x.kind === "etb"],
];
const SORTS = {
  deal: (a, b) => (b.stamped - a.stamped) || ((a.pct ?? 1e4) - (b.pct ?? 1e4)) || ((a.total ?? 1e9) - (b.total ?? 1e9)),
  price: (a, b) => (a.total ?? 1e9) - (b.total ?? 1e9),
  score: (a, b) => (b.stamped - a.stamped) || ((b.score ?? 0) - (a.score ?? 0)),
  ending: (a, b) => (a.end ?? 9e15) - (b.end ?? 9e15),
};

async function renderResults() {
  // "deals" (≤60%) was a filter before the market % slider replaced it
  if (!FILTERS.some(x => x[0] === RS.filter)) RS.filter = "finds";
  if (!(RS.pct === 0 || (RS.pct >= 10 && RS.pct < PCT_ANY))) RS.pct = 100;
  renderResultList();
  if (S.results == null) {
    $("#rv-title").textContent = "Results";
    $("#rv-sub").textContent = "";
    patch($("#rv-filters"), "");
    patch($("#rv-grid"), `<div class="empty" style="grid-column:1/-1"><div>Nothing published yet. The next run after this update puts its results here.</div></div>`);
    return;
  }
  if (!RS.sel) RS.sel = "__24h";
  const runs = RS.sel === "__24h" ? recentRuns() : S.results.filter(r => r.id === RS.sel);
  const want = runs.map(r => r.id);
  const key = want.join("|");
  if (RS.key !== key) {
    RS.key = key;
    patch($("#rv-grid"), `<div class="empty" style="grid-column:1/-1"><div class="muted">Loading…</div></div>`);
    const data = await Promise.all(want.map(id => runData(id).then(d => ({id, d}))));
    if (RS.key !== key) return;       // clicked something else meanwhile
    RS.items = data.flatMap(({id, d}) => [...d.etb.map(e => normalize("etb", e, id)), ...d.hits.map(h => normalize("hunt", h, id))]);
  }
  if (RS.sel === "__24h") {
    $("#rv-title").textContent = "Last 24 hours";
    $("#rv-sub").textContent = `${plural(runs.length, "run")} combined`;
  } else {
    const r = runs[0], t = new Date(r.started);
    $("#rv-title").textContent = `${fmtDay(t)} ${fmtClock(t)} · ${r.event === "workflow_dispatch" ? "manual run" : "scheduled run"}`;
    $("#rv-sub").textContent = [r.info, r.emailed ? "emailed" : "", r.failures?.length ? r.failures.join(" & ") + " failed" : ""].filter(Boolean).join(" · ");
  }
  patch($("#rv-filters"), FILTERS.map(([k, t, f]) => {
    const n = RS.items.filter(f).length;
    return k === "stamped" && !n && RS.filter !== k ? "" :
      `<button data-rf="${k}" class="${RS.filter === k ? "active" : ""}">${esc(t)}<span class="n">${n}</span></button>`;
  }).join(""));
  $("#rv-sort").value = RS.sort;
  const f = (FILTERS.find(x => x[0] === RS.filter) || FILTERS[0])[2];
  const words = RS.q.toLowerCase().split(/\s+/).filter(Boolean);
  // a listing with no market price has nothing to compare, so it stays
  const underPct = x => !RS.pct || x.pct == null || x.pct <= RS.pct;
  renderPctSlider();
  RS.shown = RS.items.filter(f).filter(underPct)
    .filter(x => words.every(w => (x.card + " " + x.title).toLowerCase().includes(w))).sort(SORTS[RS.sort]);
  if (!RS.shown.length) {
    patch($("#rv-grid"), `<div class="empty" style="grid-column:1/-1"><div>${RS.items.length ? "Nothing matches these filters." : "This run found nothing new."}</div></div>`);
    return;
  }
  const more = RS.shown.length > RS.limit
    ? `<div style="grid-column:1/-1;text-align:center;padding:8px"><button class="btn" id="rv-more">Show all ${RS.shown.length}</button></div>` : "";
  patch($("#rv-grid"), RS.shown.slice(0, RS.limit).map((x, i) => listingCard(x, i)).join("") + more);
  const m = $("#rv-more"); if (m) m.onclick = () => { RS.limit = 1e9; renderResults(); };
}
function priceBits(x) {
  const head = x.total == null ? "?" : money(x.total);
  const sub = x.price == null ? "" : !x.shipKnown ? "+ shipping ?" : x.ship === 0 ? "free shipping" : `${money(x.price)} + ${money(x.ship)} ship`;
  let mk = "", cls = "";
  if (x.market) {
    mk = `${COND_NAMES[x.cond] ? COND_NAMES[x.cond] + " market" : "Market"} ${money(x.market)}` +
      (x.pct != null ? ` · ${x.pct}%${x.shipKnown ? "" : "+"} of market` : "");
    cls = x.pct == null ? "" : x.pct <= 60 ? "deal" : x.pct <= 90 ? "good" : x.pct > 100 ? "over" : "";
  } else if (x.grade) {
    mk = `${x.grade} slab · no graded price`;
  }
  return {head, sub, mk, cls};
}
function kindText(x) {
  if (!x.auction) return "Buy It Now" + (x.bestOffer ? " · offers" : "");
  let s = "Auction";
  if (x.end) {
    const h = (x.end - Date.now()) / 3600e3;
    s += h <= 0 ? " · ended" : h < 1 ? ` · ${Math.round(h * 60)}m left` : ` · ${Math.floor(h)}h ${Math.round(h % 1 * 60)}m left`;
  }
  if (x.bids != null) s += ` · ${plural(x.bids, "bid")}`;
  return s;
}
function scoreBadge(x) {
  if (x.kind === "etb") return x.stamped ? `<span class="sbadge stamp">Stamped ${(x.verdict.score || 0).toFixed(2)}</span>`
    : `<span class="sbadge plain">${esc({no_stamp: "No stamp", unclear: "Unclear"}[x.verdict.verdict] || "Unchecked")}</span>`;
  return `<span class="sbadge ${x.strong ? "strong" : "ok"}">${x.strong ? "Strong" : "Art"} match ${x.score ?? ""}</span>`;
}
function listingCard(x, i) {
  const p = priceBits(x);
  return `<div class="lcard ${x.stamped ? "stamped" : ""}" data-i="${i}">
    <div class="ph"><img loading="lazy" src="${esc(safeUrl(x.img))}" alt="" referrerpolicy="no-referrer"></div>
    <div class="bd">
      <div class="cd">${esc(x.card)}</div>
      <div class="tt" title="${esc(x.title)}">${esc(x.title)}</div>
      <div class="pr"><b>${esc(p.head)}</b><small>${esc(p.sub)}</small></div>
      ${p.mk ? `<div class="mk ${p.cls}">${esc(p.mk)}</div>` : ""}
      <div class="ft">${scoreBadge(x)}<span>${esc(kindText(x))}</span></div>
    </div></div>`;
}
$("#rv-filters").onclick = e => { const b = e.target.closest("[data-rf]"); if (b) { RS.filter = b.dataset.rf; RS.limit = 240; saveRS(); renderResults(); } };
$("#rv-sort").onchange = e => { RS.sort = e.target.value; saveRS(); renderResults(); };
const PCT_ANY = 160;                  // the slider's far right = any
function renderPctSlider() {
  $("#rv-pct").value = String(RS.pct || PCT_ANY);
  $("#rv-pct-v").textContent = RS.pct ? `≤ ${RS.pct}%` : "any";
}
$("#rv-pct").addEventListener("input", e => {
  const v = +e.target.value;
  RS.pct = v >= PCT_ANY ? 0 : v; RS.limit = 240;
  saveRS(); renderResults();
});
$("#rv-search").addEventListener("input", e => { RS.q = e.target.value; renderResults(); });
$("#rv-grid").onclick = e => { const c = e.target.closest("[data-i]"); if (c) openReview(+c.dataset.i); };

/* ---- review mode: listing photo next to the card it should be */
const RV = {i: 0};
function refImage(x) {
  if (x.kind !== "hunt") return "";
  const p = S.prices?.cards?.[x.key];
  return p?.tcgplayer_id ? tcgImg(p.tcgplayer_id, "in_1000x1000") : "";
}
function openReview(i) { RV.i = i; renderReview(); $("#rv").classList.remove("hidden"); }
function closeReview() { $("#rv").classList.add("hidden"); $("#rv-photo").src = ""; }
function renderReview() {
  const list = RS.shown, x = list[RV.i];
  if (!x) return closeReview();
  const p = priceBits(x);
  $("#rv-count").textContent = `${RV.i + 1} / ${list.length}`;
  $("#rv-ttl").textContent = x.card;
  $("#rv-photo").src = safeUrl(x.photo);
  const ref = refImage(x), refImg = $("#rv-ref");
  $("#rv-ref-fig").classList.toggle("hidden", !ref);
  refImg.dataset.try = "0";
  refImg.src = ref;
  $("#rv-info").innerHTML = `<span class="pr"><b>${esc(p.head)}</b> <span style="color:#8e96a6">${esc(p.sub)}</span></span>
    ${p.mk ? `<span class="mk ${p.cls}">${esc(p.mk)}</span>` : ""}
    ${scoreBadge(x)}<span style="color:#8e96a6">${esc(kindText(x))}</span>
    ${x.seller ? `<span style="color:#8e96a6">Seller ${esc(x.seller)}${x.feedback ? ` (${esc(x.feedback)}%)` : ""}</span>` : ""}
    <span style="flex-basis:100%;color:#c9ced8">${esc(x.title)}</span>
    ${x.verdict?.reason ? `<span style="flex-basis:100%;color:#8e96a6">${esc(x.verdict.reason)}</span>` : ""}
    <a class="btn primary" href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">Open on eBay ↗</a>`;
}
// TCGplayer's big image isn't there for every product; step down a size
$("#rv-ref").addEventListener("error", e => {
  const img = e.target, tries = ["in_1000x1000", "400w", "200w"], n = +img.dataset.try + 1;
  if (n < tries.length && img.src) { img.dataset.try = n; img.src = img.src.replace(/_(in_1000x1000|400w|200w)\.jpg$/, `_${tries[n]}.jpg`); }
  else $("#rv-ref-fig").classList.add("hidden");
});
$("#rv-close").onclick = closeReview;
$("#rv-prev").onclick = () => { RV.i = (RV.i - 1 + RS.shown.length) % RS.shown.length; renderReview(); };
$("#rv-next").onclick = () => { RV.i = (RV.i + 1) % RS.shown.length; renderReview(); };
document.addEventListener("keydown", e => {
  if ($("#rv").classList.contains("hidden")) return;
  if (e.key === "Escape") closeReview();
  else if (e.key === "ArrowLeft") $("#rv-prev").click();
  else if (e.key === "ArrowRight") $("#rv-next").click();
  else if (e.key === "Enter") { const x = RS.shown[RV.i]; if (x && x.url !== "#") window.open(x.url, "_blank", "noopener"); }
});
(function swipe() {
  let x0 = null;
  $("#rv").addEventListener("touchstart", e => { x0 = e.touches[0].clientX; }, {passive: true});
  $("#rv").addEventListener("touchend", e => {
    if (x0 == null) return;
    const dx = e.changedTouches[0].clientX - x0; x0 = null;
    if (dx < -50) $("#rv-next").click(); else if (dx > 50) $("#rv-prev").click();
  });
})();

/* ================================================================== CARDS */
// pending: key -> on/off, not saved yet. adds: catalog cards being switched
// on that aren't in cards.json yet, as the entries Save will add.
const Cd = {q: "", set: "", status: "", sort: "set", pending: new Map(), adds: new Map()};
Object.assign(Cd, store.get("cardsView", {}), {q: "", pending: new Map(), adds: new Map()});
const cardNum = c => parseInt(String(c.number).split("/")[0], 10) || 0;

function visibleCards() {
  const words = Cd.q.toLowerCase().split(/\s+/).filter(Boolean);
  const list = cardRows().filter(c =>
    (!Cd.set || c.set === Cd.set) && (!Cd.status || (Cd.status === "on") === mineOn(c)) &&
    words.every(w => [c.name, c.number, c.set, c.rarity, c.key].join(" ").toLowerCase().includes(w)));
  const by = {
    set: (a, b) => a.set.localeCompare(b.set) || cardNum(a) - cardNum(b),
    name: (a, b) => a.name.localeCompare(b.name) || cardNum(a) - cardNum(b),
    "market-desc": (a, b) => (b.market ?? -1) - (a.market ?? -1),
    "market-asc": (a, b) => (a.market ?? 1e9) - (b.market ?? 1e9),
  }[Cd.sort] || (() => 0);
  return list.sort(by);
}
function cardRow(c) {
  const img = c.tcg ? `<img class="thumb" loading="lazy" src="${esc(tcgImg(c.tcg))}" alt="">` : `<div class="thumb"></div>`;
  const cap = money(c.cap) + (c.source === "manual" ? `<span class="tag" title="Fixed by hand in cards.json">fixed</span>` :
                              c.source === "default" ? `<span class="tag" title="No market price found; using the default cap">default</span>` : "");
  const noRef = c.hasRef ? "" : `<span class="tag warn" title="No reference image in references/${esc(c.key)}/ — Card Hunter skips it">no art</span>`;
  const link = c.tcg ? ` <a href="https://www.tcgplayer.com/product/${esc(c.tcg)}" target="_blank" rel="noopener">↗</a>` : "";
  const on = mineOn(c);
  return `<tr class="${on ? "" : "off"} ${!PE && c.enabled !== c.saved ? "changed" : ""}">
    <td><input type="checkbox" data-card="${esc(c.key)}" ${on ? "checked" : ""}></td>
    <td>${img}</td>
    <td>${esc(c.name)}${noRef}<div class="sub">${esc(c.key)}</div></td>
    <td class="num">${esc(c.number)}</td><td class="hide-sm">${esc(c.set)}</td><td class="hide-sm">${esc(c.rarity)}</td>
    <td class="money">${money(c.market)}${link}</td><td class="money">${cap}</td></tr>`;
}
function renderCards() {
  if (!S.cfg) return;
  const all = cardRows(), list = visibleCards();
  const sets = [...new Set(all.map(c => c.set))].sort();
  $("#c-sets").innerHTML = [["", "All sets"], ...sets.map(s => [s, s])].map(([v, t]) =>
    `<button data-set="${esc(v)}" class="${Cd.set === v ? "active" : ""}">${esc(t)}</button>`).join("");
  $$("#c-status button").forEach(b => b.classList.toggle("active", b.dataset.status === Cd.status));
  $("#c-sort").value = Cd.sort;
  const on = all.filter(c => c.enabled);
  $("#c-count").textContent = `${on.length} of ${all.length} cards hunting` + (list.length !== all.length ? ` · ${list.length} shown` : "");
  const perDay = runsPerDay(parseSchedule(S.yml));
  const daily = callsPerRun(on) * perDay;
  $("#c-budget").innerHTML = perDay
    ? `≈ ${callsPerRun(on).toLocaleString()} eBay calls a run · <span class="${daily > EBAY_DAILY ? "bad-t" : daily > EBAY_DAILY * .8 ? "warn-t" : ""}">${Math.round(daily).toLocaleString()} a day</span> of ${EBAY_DAILY.toLocaleString()}`
    : `≈ ${callsPerRun(on).toLocaleString()} eBay calls a run (schedule paused)`;
  let html = "", group = null;
  for (const c of list) {
    if (Cd.sort === "set" && c.set !== group) {
      group = c.set;
      const inSet = list.filter(x => x.set === group), setOn = inSet.filter(mineOn).length;
      html += `<tr class="grp"><td><input type="checkbox" data-set-toggle="${esc(group)}" ${setOn === inSet.length ? "checked" : ""}
                 ${setOn && setOn < inSet.length ? "data-mixed" : ""} title="Turn the whole set on or off"></td>
               <td colspan="7">${esc(group)}<span class="hint">${plural(inSet.length, "card")} · ${setOn} hunting</span></td></tr>`;
    }
    html += cardRow(c);
  }
  $("#c-rows").innerHTML = html || `<tr><td colspan="8" class="empty">No cards match.</td></tr>`;
  $$("[data-mixed]").forEach(el => el.indeterminate = true);
  $("#c-mine-n").textContent = on.length;
  renderCatalog();
  const n = Cd.pending.size;
  $("#c-savebar").classList.toggle("hidden", !n);
  $("#c-pending").textContent = n ? `${plural(n, "unsaved change")}` : "";
  renderPresets();
}
function setEnabled(keys, enabled) {
  const saved = new Map(cardRows(false).map(c => [c.key, c.enabled]));
  for (const k of keys) {
    if (Cd.adds.has(k) && !enabled) { Cd.adds.delete(k); Cd.pending.delete(k); }   // never saved: just drop it
    else if (saved.get(k) === enabled) Cd.pending.delete(k); else Cd.pending.set(k, enabled);
  }
  renderCards();
}
function saveCardsView() { store.set("cardsView", {set: Cd.set, status: Cd.status, sort: Cd.sort}); }
$("#c-search").addEventListener("input", e => { Cd.q = e.target.value; renderCards(); });
$("#c-sort").onchange = e => { Cd.sort = e.target.value; saveCardsView(); renderCards(); };
$("#c-sets").onclick = e => { const b = e.target.closest("[data-set]"); if (b) { Cd.set = b.dataset.set; saveCardsView(); renderCards(); } };
$("#c-status").onclick = e => { const b = e.target.closest("[data-status]"); if (b) { Cd.status = b.dataset.status; saveCardsView(); renderCards(); } };
$("#c-rows").addEventListener("change", e => {
  const t = e.target;
  const turn = PE ? presetPick : setEnabled;
  if (t.dataset.card) turn([t.dataset.card], t.checked);
  else if (t.dataset.setToggle != null) turn(visibleCards().filter(c => c.set === t.dataset.setToggle).map(c => c.key), t.checked);
});
$("#c-on").onclick = () => PE ? presetPick(visibleCards().map(c => c.key), true)
                             : setEnabled(visibleCards().filter(c => !c.enabled).map(c => c.key), true);
$("#c-off").onclick = () => {
  if (PE) return presetPick(visibleCards().map(c => c.key), false);
  const keys = visibleCards().filter(c => c.enabled).map(c => c.key);
  if (keys.length > 10 && !confirm(`Turn off all ${keys.length} cards shown?`)) return;
  setEnabled(keys, false);
};
$("#c-discard").onclick = () => { Cd.pending.clear(); Cd.adds.clear(); renderCards(); };
$("#c-save").onclick = async () => {
  const changes = new Map(Cd.pending), btn = $("#c-save");
  const adds = [...Cd.adds.values()].filter(c => changes.get(c.key));
  const added = adds.length, on = [...changes.values()].filter(Boolean).length - added, off = changes.size - added - on;
  const msg = "Dashboard: " + [added && `add ${plural(added, "card")}`, on && `turn on ${plural(on, "card")}`,
                               off && `turn off ${plural(off, "card")}`].filter(Boolean).join(", ");
  btn.disabled = true; btn.textContent = "Saving…";
  try {
    const r = await saveFile("cards.json", text => {
      const cfg = JSON.parse(text);
      const have = new Set();
      for (const c of cfg.cards) {
        have.add(c.key);
        if (c.tcgplayer_id) have.add("#" + c.tcgplayer_id);
        if (!changes.has(c.key)) continue;
        if (changes.get(c.key)) delete c.enabled; else c.enabled = false;
      }
      for (const a of adds) {
        if (have.has(a.key) || have.has("#" + a.tcgplayer_id)) continue;     // added elsewhere meanwhile
        cfg.cards.push(Object.fromEntries(Object.entries(a).filter(([k]) => !k.startsWith("_"))));
      }
      return JSON.stringify(cfg, null, 2) + "\n";
    }, msg);
    S.cfg = JSON.parse(r.text); S.cfgSha = r.sha;
    Cd.pending.clear(); Cd.adds.clear();
    toast("Saved", "The next run uses these cards.", "good");
  } catch (e) {
    if (e.status !== 401) toast("Couldn't save", e.message, "bad");
  } finally {
    btn.disabled = false; btn.textContent = "Save";
    renderCards(); renderChips();
  }
};
window.addEventListener("beforeunload", e => { if (Cd.pending.size || SC.dirty || ST.dirty || SV.timer) { e.preventDefault(); e.returnValue = ""; } });

/* ------------------------------------------------------------------ presets */
// Named groups of cards, kept in cards.json as "presets"; the PC dashboard
// has the same code. Ticking one changes its cards like any other tick
// (Save sends them); making, editing or deleting one saves straight away.
const presetList = () => S.cfg?.presets || [];
const presetCards = () => cardRows();
async function catalogReady() {
  loadCatalog();
  while (!CAT.sets) await sleep(100);
}
// cards not in My cards yet are added, like ticking them in a set
async function turnCards(keys, on) {
  const have = new Set(cardRows().map(c => c.key));
  const missing = on ? keys.filter(k => !have.has(k)) : [];
  if (missing.length) {
    await catalogReady();
    const want = new Set(missing);
    const sets = await loadSets([...new Set(missing.map(setOfKey).filter(Boolean))]);
    for (const d of sets) if (d) for (const c of d.cards)
      if (want.has(c.key)) { Cd.adds.set(c.key, catalogEntry(c, d.name)); Cd.pending.set(c.key, true); }
  }
  const flip = keys.filter(k => have.has(k));
  if (flip.length) setEnabled(flip, on); else renderCards();
}
async function putPresets(list, note) {
  const btn = $("#pe-save");
  if (btn) btn.disabled = true;
  try {
    const r = await saveFile("cards.json", text => {
      const cfg = JSON.parse(text);
      if (list.length) cfg.presets = list; else delete cfg.presets;
      return JSON.stringify(cfg, null, 2) + "\n";
    }, "Dashboard: " + note);
    S.cfg = JSON.parse(r.text); S.cfgSha = r.sha;
  } catch (e) {
    if (e.status !== 401) toast("Couldn't save", e.message, "bad");
    return false;
  } finally {
    if (btn) btn.disabled = false;
  }
  renderPresets();
  return true;
}
// A preset is ticked when all its cards are on and half-ticked when only
// some are. Ticking turns them all on (adding any that aren't in My cards
// yet); unticking turns them off, except cards that are also in another
// preset that's ticked. Several can be on at once. Cards not in any preset
// are left as they are.
const PENCIL = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4"/></svg>`;

// The preset being made or edited: {i, name, keys}, or null. While there is
// one, the Cards tab picks cards for it: a card's tick means "in the
// preset", and clicking a card (or an "all shown" button) adds it or takes
// it out instead of hunting it. Every view, search and filter works as usual.
let PE = null;
const catKey = (c, row) => row ? row.key : c.key;
const catOn = (c, row) => PE ? PE.keys.has(catKey(c, row)) : !!(row && row.enabled);
const mineOn = c => PE ? PE.keys.has(c.key) : c.enabled;
function shownPresetKeys() {
  const m = mine();
  return (CS.shown || []).map(c => catKey(c, rowFor(c, m)));
}
function presetPick(keys, add) {
  for (const k of keys) if (add) PE.keys.add(k); else PE.keys.delete(k);
  renderCards();
}
// the buttons and filters say what they do while picking
const PICK_LABELS = {
  "#cs-on": "Add all shown", "#cs-off": "Remove all shown", "#c-on": "Add all shown", "#c-off": "Remove all shown",
  '#cs-status [data-status="on"]': "In preset", '#cs-status [data-status="off"]': "Not in preset",
  '#c-status [data-status="on"]': "In preset", '#c-status [data-status="off"]': "Not in preset",
};
function pickLabels() {
  for (const [sel, alt] of Object.entries(PICK_LABELS)) {
    const el = $(sel);
    if (!el) continue;
    if (el.dataset.label == null) el.dataset.label = el.textContent;
    el.textContent = PE ? alt : el.dataset.label;
  }
}

const cardsOn = () => new Map(presetCards().map(c => [c.key, c.enabled]));
function presetState(p, on = cardsOn()) {
  const n = p.cards.filter(k => on.get(k)).length;
  return {keys: p.cards, on: n, full: p.cards.length > 0 && n === p.cards.length};
}
function renderPresets() {
  const box = $("#c-presets");
  if (!box) return;
  $("#view-cards").classList.toggle("picking", !!PE);
  pickLabels();
  if (PE) {
    // built once, so typing in the name box isn't interrupted
    if (!$("#pe-name", box)) box.innerHTML = `<span class="pe-tag">${PE.i >= 0 ? "Editing preset" : "New preset"}</span>
      <input type="text" id="pe-name" placeholder="Preset name" maxlength="60" autocomplete="off" value="${esc(PE.name)}">
      <span class="hint" id="pe-count"></span>
      <span class="spacer"></span>
      ${PE.i >= 0 ? `<button class="btn danger sm" id="pe-delete">Delete</button>` : ""}
      <button class="btn sm" id="pe-cancel">Cancel</button>
      <button class="btn primary sm" id="pe-save">Save preset</button>
      <span class="hint pe-help">Pick cards below: selecting one adds it to the preset or takes it out. Browse sets and Pokémon, search and filter as usual.</span>`;
    const n = PE.keys.size;
    $("#pe-count").textContent = `${n} card${n === 1 ? "" : "s"} in it`;
    return;
  }
  const list = presetList(), on = cardsOn();
  box.innerHTML = `<span class="hint">Presets</span>` + list.map((p, i) => {
    const s = presetState(p, on);
    return `<span class="preset${s.full ? " on" : ""}">
      <label title="${s.full ? "Turn these cards off" : "Turn all of these cards on"}"><input type="checkbox" data-preset="${i}"
        ${s.full ? "checked" : ""} ${s.on && !s.full ? "data-mixed" : ""} ${s.keys.length ? "" : "disabled"}>
        ${esc(p.name)} <span class="pn">${s.on}/${s.keys.length}</span></label><button class="pe" data-preset-edit="${i}" title="Edit ${esc(p.name)}">${PENCIL}</button></span>`;
  }).join("") + `<button class="btn ghost sm" data-preset-new>+ New preset</button>` +
    (list.length ? "" : `<span class="hint">Group cards to turn them on and off together.</span>`);
  $$("#c-presets [data-mixed]").forEach(el => el.indeterminate = true);
}
function togglePreset(i, want) {
  const list = presetList(), on = cardsOn();
  const s = presetState(list[i], on);
  if (want) return turnCards(s.keys.filter(k => !on.get(k)), true);
  const keep = new Set();
  list.forEach((q, j) => { if (j !== i) { const t = presetState(q, on); if (t.full) t.keys.forEach(k => keep.add(k)); } });
  const kept = s.keys.filter(k => on.get(k) && keep.has(k)).length;
  if (kept) toast(`${kept} card${kept === 1 ? "" : "s"} kept on`, "They're also in another preset that's ticked.");
  turnCards(s.keys.filter(k => on.get(k) && !keep.has(k)), false);
}
function startPreset(i) {
  const p = presetList()[i];
  PE = {i: p ? i : -1, name: p ? p.name : "", keys: new Set(p ? p.cards : [])};
  $("#c-presets").innerHTML = "";
  renderCards();
  if (!p) $("#pe-name").focus();
}
function stopPreset() {
  PE = null;
  renderCards();
}
async function savePreset() {
  const name = $("#pe-name").value.trim().replace(/\s+/g, " ");
  if (!name) { toast("Give the preset a name"); return $("#pe-name").focus(); }
  const list = presetList().map(p => ({name: p.name, cards: [...p.cards]}));
  if (list.some((p, j) => j !== PE.i && p.name.toLowerCase() === name.toLowerCase()))
    return toast("Name taken", `There's already a preset called ${name}.`, "bad");
  const cards = [...PE.keys];
  if (!cards.length) return toast("Pick some cards", "Select the cards this preset should turn on.");
  if (PE.i >= 0) list[PE.i] = {name, cards}; else list.push({name, cards});
  if (await putPresets(list, `${PE.i >= 0 ? "edit" : "add"} preset ${name}`)) stopPreset();
}
async function deletePreset() {
  const list = presetList().map(p => ({name: p.name, cards: [...p.cards]}));
  const [gone] = list.splice(PE.i, 1);
  if (!gone || !confirm(`Delete the preset "${gone.name}"? Its cards stay as they are.`)) return;
  if (await putPresets(list, `delete preset ${gone.name}`)) stopPreset();
}
$("#c-presets").addEventListener("change", e => {
  const t = e.target.closest("[data-preset]");
  if (t) togglePreset(+t.dataset.preset, t.checked);
});
$("#c-presets").addEventListener("click", e => {
  const ed = e.target.closest("[data-preset-edit]");
  if (ed) startPreset(+ed.dataset.presetEdit);
  else if (e.target.closest("[data-preset-new]")) startPreset(-1);
  else if (e.target.closest("#pe-save")) savePreset();
  else if (e.target.closest("#pe-cancel")) stopPreset();
  else if (e.target.closest("#pe-delete")) deletePreset();
});
$("#c-presets").addEventListener("input", e => { if (e.target.id === "pe-name" && PE) PE.name = e.target.value; });
$("#c-presets").addEventListener("keydown", e => { if (e.target.id === "pe-name" && e.key === "Enter") savePreset(); });

/* ================================================================== CATALOG */
// catalog/ on main, built by catalog.py: eras -> sets -> every card, from
// Base Set through Mega Evolution. Loaded on first visit to Cards.
// market: the catalog's price per key, for cards added since the last run.
// today: every catalog card's price from today, by TCGplayer product id
// (catalog_prices.json on the results branch, refreshed daily by the runs)
const CAT = {sets: null, bySlug: new Map(), data: new Map(), ready: new Map(), all: null, allDone: null, error: "", market: new Map(), today: {}, todayAt: null};
// modes: sets (every set) -> set (one), dex (every Pokemon) -> mon (one), mine
const CS = {mode: "sets", slug: null, dex: null, q: "", gq: "", dq: "", gen: 0, rarity: "", status: "", variants: false, ntl: false, reprints: false, sort: "number", monSort: "number", shown: []};
Object.assign(CS, store.get("catalogView", {}), {q: "", gq: "", dq: "", slug: null, dex: null, shown: []});
const saveCatalogView = () => store.set("catalogView", {mode: {set: "sets", mon: "dex"}[CS.mode] || CS.mode, gen: CS.gen, variants: CS.variants, ntl: CS.ntl, reprints: CS.reprints, sort: CS.sort, monSort: CS.monSort});
const TICK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`;
const fmtRelease = iso => new Date(iso + "T12:00:00").toLocaleDateString([], {month: "long", day: "numeric", year: "numeric"});

async function loadCatalog() {
  if (CAT.sets || CAT.loading) return;
  CAT.loading = true;
  try {
    const [setsText, today] = await Promise.all([getRaw("catalog/sets.json", "main"),
      getRaw("catalog_prices.json", "results").then(JSON.parse).catch(() => null)]);
    CAT.sets = JSON.parse(setsText);
    if (today && today.prices) { CAT.today = today.prices; CAT.todayAt = today.updated; }
    for (const era of CAT.sets.eras || []) for (const st of era.sets) CAT.bySlug.set(st.slug, {...st, era: era.name});
    // prices for cards added since the last run live in their set's file
    const table = S.prices?.cards || {};
    const sets = new Set((S.cfg?.cards || []).filter(c => c.tcgplayer_id && !table[c.key]).map(c => setOfKey(c.key)).filter(Boolean));
    Promise.all([...sets].map(sl => loadSet(sl).catch(() => null))).then(() => sets.size && renderCards());
  } catch (e) {
    CAT.error = e.status === 404 ? "none" : e.message;
    CAT.sets = {eras: []};
  } finally { CAT.loading = false; }
  renderCatalog();
}
async function loadSet(slug) {
  if (!CAT.data.has(slug)) CAT.data.set(slug, getRaw(`catalog/sets/${slug}.json`, "main").then(JSON.parse)
    .then(d => {
      for (const c of d.cards) {
        c.market = CAT.today[c.id] ?? c.market;
        if (c.market != null) CAT.market.set(c.key, c.market);
      }
      CAT.ready.set(slug, d);
      return d;
    })
    .catch(e => { CAT.data.delete(slug); throw e; }));
  return CAT.data.get(slug);
}
// a few at a time: 150 files at once is rude to GitHub and slow on a phone
async function loadSets(slugs) {
  const out = new Array(slugs.length);
  let next = 0;
  await Promise.all(Array.from({length: 6}, async () => {
    while (next < slugs.length) { const i = next++; out[i] = await loadSet(slugs[i]).catch(() => null); }
  }));
  return out;
}
async function loadAllSets() {
  if (!CAT.bySlug.size) return [];                     // sets.json not loaded yet
  if (!CAT.all) CAT.all = loadSets([...CAT.bySlug.keys()]).then(out => (CAT.allDone = out));
  return CAT.all;
}
// The set a cards.json key belongs to: the longest slug it ends with, since
// "-promo" (Scarlet & Violet) is also the end of "-me-promo"
function setOfKey(key) {
  let best = "";
  for (const slug of CAT.bySlug.keys()) if (slug.length > best.length && key.endsWith("-" + slug)) best = slug;
  return best;
}
function mine() {
  const byKey = new Map(), byId = new Map();
  for (const c of cardRows()) { byKey.set(c.key, c); if (c.tcg) byId.set(+c.tcg, c); }
  return {byKey, byId};
}
// the cards.json row a catalog card is, if any; the product id catches a card
// added by hand under a different key
const rowFor = (c, m) => m.byKey.get(c.key) || m.byId.get(+c.id);

// The same entry catalog.py's card_entry() writes: same label, same two searches
const NOTES_RX = /\(([^)]*)\)|\[([^\]]*)\]/g;
const slugify = t => t.normalize("NFKD").replace(/[^\x00-\x7f]/g, "").toLowerCase().replace(/['’`.]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const searchName = n => n.replace(NOTES_RX, "").replace(/\s+/g, " ").trim().toLowerCase();
function numberKey(n) { const h = String(n).split("/")[0].trim(); return /^\d+$/.test(h) ? (h.replace(/^0+/, "") || "0") : slugify(h); }
function catalogEntry(c, setName) {
  const num = c.number ? numberKey(c.number) : "", full = searchName(c.name);
  const bare = full.replace(/\s+(ex|gx|v|vmax|vstar|v-union|break|lv\.?\s*x)$/i, "");
  return {key: c.key, label: [c.name, num.toUpperCase()].filter(Boolean).join(" ") + " — " + setName,
          queries: [bare, ...(num ? [`${full} ${num}`] : [])], tcgplayer_id: c.id, tcgplayer_group: c.group,
          _new: true, _market: c.market};
}

function renderCatalog() {
  if (!$("#cs-sets")) return;
  $$("#c-mode button").forEach(b => b.classList.toggle("active", b.dataset.mode === ({set: "sets", mon: "dex"}[CS.mode] || CS.mode)));
  // searching every set keeps the search box and shows the results below it
  const searching = CS.mode === "sets" && !!CS.gq;
  $("#cm-sets").classList.toggle("hidden", CS.mode !== "sets");
  $("#cm-sets").classList.toggle("searching", searching);
  $("#cs-sets").classList.toggle("hidden", searching);
  $("#cm-dex").classList.toggle("hidden", CS.mode !== "dex");
  $("#cm-set").classList.toggle("hidden", !(CS.mode === "set" || CS.mode === "mon" || searching));
  $("#cm-set").classList.toggle("global", searching);
  $("#cm-mine").classList.toggle("hidden", CS.mode !== "mine");
  $("#cs-back-t").textContent = CS.mode === "mon" ? "All Pokémon" : "All sets";
  if (CS.mode === "sets" && !searching) renderSetTiles();
  else if (CS.mode === "dex") renderDexTiles();
  else if (CS.mode === "set" || CS.mode === "mon" || searching) renderSetCards();
}

function renderSetTiles() {
  if (!CAT.sets) { $("#cs-sets").innerHTML = `<div class="empty">Loading sets…</div>`; return; }
  const eras = CAT.sets.eras || [];
  if (!eras.length) {
    $("#cs-sets").innerHTML = `<div class="empty"><div>${CAT.error === "none" || !CAT.error
      ? "No card catalog in the repo yet.<br><span class=\"muted\">Run <span class=\"mono\">python catalog.py</span> on the PC, then Push to GitHub.</span>"
      : "Couldn't load the card catalog: " + esc(CAT.error)}</div></div>`;
    return;
  }
  const counts = new Map();
  for (const c of cardRows()) if (c.enabled) { const sl = setOfKey(c.key); counts.set(sl, (counts.get(sl) || 0) + 1); }
  const nSets = eras.reduce((n, e) => n + e.sets.length, 0);
  const at = CAT.todayAt || CAT.sets.updated;
  $("#cs-summary").textContent = `${(CAT.sets.cards || 0).toLocaleString()} cards in ${nSets} sets` +
    (at ? ` · prices from ${fmtDay(new Date(at))}` : "");
  const tile = st => {
    const n = counts.get(st.slug) || 0;
    return `<button class="stile" data-slug="${esc(st.slug)}">
      ${st.logo ? `<div class="slogo"><img src="${esc(safeUrl(st.logo))}" alt="" loading="lazy"></div>` : ""}
      <div class="sinfo"><div class="sname">${esc(st.name)}</div><div class="sdate">${esc(fmtRelease(st.date))}</div>
        <div class="sfoot"><span>${plural(st.count, "card")}</span>${n ? `<span class="hunting">${n} hunting</span>` : ""}
          ${st.code ? `<span class="code">${esc(st.code)}</span>` : ""}</div></div></button>`;
  };
  // sets with a logo by era; the ones without (McDonald's, trainer kits,
  // reprint groups) together at the bottom, still by era
  const main = eras.map(era => [era, era.sets.filter(st => st.logo)]).filter(([, sets]) => sets.length);
  const more = eras.map(era => [era, era.sets.filter(st => !st.logo)]).filter(([, sets]) => sets.length);
  patch($("#cs-sets"), main.map(([era, sets]) => `<div class="era"><h3>${esc(era.name)}</h3><div class="sgrid">${sets.map(tile).join("")}</div></div>`).join("") +
    (more.length ? `<div class="era more"><h3>More sets<span class="hint">promos, trainer kits and reprints</span></h3>${more.map(([era, sets]) =>
      `<h4>${esc(era.name)}</h4><div class="sgrid bare">${sets.map(tile).join("")}</div>`).join("")}</div>` : ""));
}

/* ------------------------------------------------------------------ pokemon: generations -> pokemon -> cards */
// catalog/pokemon.json (catalog.py) lists all 1,025; each catalog card's
// "dex" says which Pokemon are on it. Pictures are PokeAPI's sprites.
const DEX = {data: null, byDex: new Map(), loading: null};
const SPRITES = "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon";
const sprite = n => `${SPRITES}/${n}.png`;
const artwork = n => `${SPRITES}/other/official-artwork/${n}.png`;
const dexNo = n => "#" + String(n).padStart(4, "0");
const ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI"];
const genName = g => `Generation ${ROMAN[g.gen] || g.gen}${g.region ? " · " + g.region : ""}`;
const foldName = s => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/’/g, "'").toLowerCase();

function loadPokemon() {
  if (!DEX.loading) DEX.loading = getRaw("catalog/pokemon.json", "main").then(JSON.parse).then(d => {
    for (const g of d.generations || []) for (const p of g.pokemon) DEX.byDex.set(p.dex, {...p, gen: g.gen, region: g.region});
    DEX.data = d;
  }).catch(e => { DEX.loading = null; throw e; });
  return DEX.loading;
}
// Dex number -> cards being hunted, once the sets they're in are loaded
// (null till then). Only those sets: every set is 150 files.
const huntSlugs = () => [...new Set(cardRows().map(c => setOfKey(c.key)).filter(Boolean))];
function huntingByDex() {
  const slugs = huntSlugs();
  if (!slugs.every(s => CAT.ready.has(s))) return null;
  const m = mine(), out = new Map();
  for (const d of slugs.map(s => CAT.ready.get(s))) for (const c of d.cards) {
    if (!c.dex) continue;
    const r = rowFor(c, m);
    if (r && r.enabled) for (const n of c.dex) out.set(n, (out.get(n) || 0) + 1);
  }
  return out;
}

async function renderDexTiles() {
  const el = $("#cs-dex");
  if (!DEX.data) {
    el.innerHTML = `<div class="empty">Loading Pokémon…</div>`; el._html = null;
    try { await loadPokemon(); } catch (e) {
      el.innerHTML = e.status === 404
        ? `<div class="empty"><div>No Pokémon list in the repo yet.<br><span class="muted">Run <span class="mono">python catalog.py</span> on the PC, then Push to GitHub.</span></div></div>`
        : e.status === 401 ? "" : `<div class="empty">Couldn't load the Pokémon: ${esc(e.message)}</div>`;
      return;
    }
    if (CS.mode !== "dex") return;
  }
  const gens = DEX.data.generations || [];
  const hunting = huntingByDex();
  if (!hunting && CAT.bySlug.size && !DEX.huntLoading) {
    DEX.huntLoading = true;                          // once: a set that won't load mustn't loop
    loadSets(huntSlugs()).then(() => CS.mode === "dex" && renderDexTiles());
  }
  if (!gens.some(g => g.gen === CS.gen)) CS.gen = 0;
  patch($("#cs-gens"), [[0, "All"], ...gens.map(g => [g.gen, ROMAN[g.gen] || g.gen])].map(([v, t]) =>
    `<button data-gen="${v}" class="${CS.gen === v ? "active" : ""}" title="${v ? esc(genName(gens.find(g => g.gen === v))) : "Every generation"}">${t}</button>`).join(""));
  $("#cs-dsummary").textContent = `${(DEX.data.count || 0).toLocaleString()} Pokémon · ${(DEX.data.with_cards || 0).toLocaleString()} have cards`;
  const q = foldName(CS.dq.trim().replace(/^#/, ""));
  const isNum = /^\d+$/.test(q);
  const match = p => !q || (isNum ? String(p.dex).startsWith(String(+q)) : foldName(p.name).includes(q));
  patch(el, gens.filter(g => !CS.gen || g.gen === CS.gen).map(g => {
    const list = g.pokemon.filter(match);
    return list.length ? `<div class="era"><h3>${esc(genName(g))}</h3><div class="pgrid">${list.map(p => {
      const n = hunting ? hunting.get(p.dex) || 0 : 0;
      const title = p.cards ? `${p.name}: ${plural(p.cards, "card")}` : `No ${p.name} cards yet`;
      return `<button class="ptile ${p.cards ? "" : "none"}" data-dex="${p.dex}" title="${esc(title)}">
        <div class="psprite"><img src="${sprite(p.dex)}" alt="" loading="lazy"></div>
        <div class="pnum">${dexNo(p.dex)}</div><div class="pname">${esc(p.name)}</div>
        <div class="pfoot"><span>${plural(p.cards, "card")}</span>${n ? `<span class="hunting">${n} hunting</span>` : ""}</div></button>`;
    }).join("")}</div></div>` : "";
  }).join("") || `<div class="empty">No Pokémon match.</div>`);
}

// every card with this Pokemon on it, oldest first: by its set's release
// date, or its own for promos (catalog.py estimates those from the number).
// pokemon.json says which sets it's in, so only those are loaded.
function monSlugs(p) {
  const all = [...CAT.bySlug.keys()];
  if (!p.in || !DEX.data.sets) return all;
  const want = new Set(p.in.map(i => DEX.data.sets[i]));
  return all.filter(s => want.has(s));                // sets.json's order: newest first
}
async function monCards(p) {
  const sets = await loadSets(monSlugs(p));
  const out = [];
  for (const d of [...sets].reverse()) {
    if (!d) continue;
    const released = (CAT.bySlug.get(d.slug) || {}).date || "";
    for (const c of d.cards) if (c.dex && c.dex.includes(p.dex)) out.push({...c, _set: d.name, _date: c.date || released});
  }
  return out.sort((a, b) => a._date.localeCompare(b._date));      // stable: same day keeps set order
}

const catNum = c => { const m = /(\d+)/.exec(String(c.number)); return m ? +m[1] : 0; };
// A set's cards with their Prize Pack, League and other stamped reprints
// (catalog.py's "of") slotted in after the card they reprint and its own
// pattern variants
function withReprints(own, sets) {
  const at = new Map(own.map((c, i) => [c.key, i])), after = new Map();
  for (const d of sets) if (d) for (const c of d.cards) {
    if (!at.has(c.of)) continue;
    let i = at.get(c.of);
    while (i + 1 < own.length && own[i + 1].number === own[i].number) i++;
    if (!after.has(i)) after.set(i, []);
    after.get(i).push({...c, _set: d.name, _rep: true});
  }
  return own.flatMap((c, i) => [c, ...(after.get(i) || [])]);
}
async function renderSetCards() {
  const global = CS.mode === "sets" && !!CS.gq, mon = CS.mode === "mon";
  let cards, st = null;
  if (global) {
    if (!CAT.all) $("#cs-cards").innerHTML = `<div class="empty">Loading every set…</div>`;
    const sets = await loadAllSets();
    if (!(CS.mode === "sets" && CS.gq)) return;            // changed while loading
    cards = sets.filter(Boolean).flatMap(d => d.cards.map(c => ({...c, _set: d.name})));
  } else if (mon) {
    const p = DEX.byDex.get(CS.dex);
    if (!p) { CS.mode = "dex"; return renderCatalog(); }
    $("#cs-title").innerHTML = `<img class="mon" src="${artwork(p.dex)}" alt="">` +
      `<div><b>${esc(p.name)}</b><div class="hint">${dexNo(p.dex)} · ${esc(genName(p))} · ${plural(p.cards, "card")}</div></div>`;
    if (!monSlugs(p).every(s => CAT.ready.has(s))) { $("#cs-cards").innerHTML = `<div class="empty">Loading every ${esc(p.name)} card…</div>`; $("#cs-cards")._html = null; }
    cards = await monCards(p);
    if (CS.mode !== "mon" || CS.dex !== p.dex) return;
  } else {
    st = CAT.bySlug.get(CS.slug);
    if (!st) { CS.mode = "sets"; return renderCatalog(); }
    $("#cs-title").innerHTML = (st.logo ? `<img src="${esc(safeUrl(st.logo))}" alt="">` : "") +
      `<div><b>${esc(st.name)}</b><div class="hint">${esc(st.era)} · ${esc(fmtRelease(st.date))} · ${plural(st.count, "card")}${st.code ? " · " + esc(st.code) : ""}</div></div>`;
    if (!CAT.data.has(CS.slug)) $("#cs-cards").innerHTML = `<div class="empty">Loading ${esc(st.name)}…</div>`;
    let data;
    try { data = await loadSet(CS.slug); } catch (e) {
      if (e.status !== 401) $("#cs-cards").innerHTML = `<div class="empty">Couldn't load this set: ${esc(e.message)}</div>`;
      return;
    }
    if (CS.mode !== "set" || CS.slug !== st.slug) return;
    cards = data.cards.map(c => ({...c, _set: data.name}));
    if (CS.reprints && (st.reprinted_in || []).length) {
      const more = await loadSets(st.reprinted_in);
      if (CS.mode !== "set" || CS.slug !== st.slug) return;
      cards = withReprints(cards, more);
    }
  }
  const m = mine();
  const words = (global ? CS.gq : CS.q).toLowerCase().split(/\s+/).filter(Boolean);
  const nVariants = cards.filter(c => c.variant).length;
  $("#cs-variants-l").classList.toggle("hidden", !nVariants);
  $("#cs-variants").checked = CS.variants;
  $("#cs-variants-t").textContent = `Variants (${nVariants.toLocaleString()})`;
  const nNtl = cards.filter(c => c.ntl && (CS.variants || !c.variant)).length;
  $("#cs-ntl-l").classList.toggle("hidden", !nNtl);
  $("#cs-ntl").checked = CS.ntl;
  $("#cs-ntl-t").textContent = `Not tournament legal (${nNtl.toLocaleString()})`;
  // on a set's page, the reprints of its cards from other groups; elsewhere
  // every reprint. A reprint group's own page always shows its cards.
  const isRep = c => st ? c._rep : !!c.of;
  const nRep = st && !CS.reprints ? st.reprints || 0 : cards.filter(c => isRep(c) && (CS.variants || !c.variant) && (CS.ntl || !c.ntl)).length;
  $("#cs-rep-l").classList.toggle("hidden", !nRep);
  $("#cs-rep").checked = CS.reprints;
  $("#cs-rep-t").textContent = `Reprints (${nRep.toLocaleString()})`;
  const rarities = [...new Set(cards.map(c => c.rarity).filter(Boolean))];
  if (CS.rarity && !rarities.includes(CS.rarity)) CS.rarity = "";
  $("#cs-rarity").innerHTML = [["", "All rarities"], ...rarities.map(r => [r, r])].map(([v, t]) =>
    `<option value="${esc(v)}" ${CS.rarity === v ? "selected" : ""}>${esc(t)}</option>`).join("");
  $$("#cs-status button").forEach(b => b.classList.toggle("active", b.dataset.status === CS.status));
  $("#cs-search").placeholder = mon ? "Search these cards…" : "Search this set…";
  // a Pokemon's cards come from every set, so "number" is release order there
  const sorts = [...(mon ? [["number", "Oldest first"], ["newest", "Newest first"]] : [["number", "Number"]]),
    ["market-desc", "Market price, high → low"], ["market-asc", "Market price, low → high"], ["name", "Name"]];
  const want = mon ? CS.monSort : CS.sort;            // a Pokemon keeps its own: release order unless changed
  const sort = sorts.some(([v]) => v === want) ? want : "number";
  patch($("#cs-sort"), sorts.map(([v, t]) => `<option value="${v}">${t}</option>`).join(""));
  $("#cs-sort").value = sort;

  let list = cards.filter(c => {
    const row = rowFor(c, m), on = catOn(c, row);
    return (CS.variants || !c.variant) && (CS.ntl || !c.ntl) && (CS.reprints || !isRep(c)) && (!CS.rarity || c.rarity === CS.rarity) && (!CS.status || (CS.status === "on") === on) &&
      words.every(w => [c.name, c.number, c.rarity, c.variant || "", global || mon ? c._set : ""].join(" ").toLowerCase().includes(w));
  });
  const by = {
    name: (a, b) => a.name.localeCompare(b.name) || catNum(a) - catNum(b),
    "market-desc": (a, b) => (b.market ?? -1) - (a.market ?? -1),
    "market-asc": (a, b) => (a.market ?? 1e9) - (b.market ?? 1e9),
  }[sort];                                      // "number": the catalog is already in set order
  if (by) list = [...list].sort(by);
  else if (sort === "newest") list = [...list].reverse();
  const shown = global ? list.slice(0, 300) : list;
  const onHere = list.filter(c => catOn(c, rowFor(c, m))).length;
  $("#cs-count").textContent = `${plural(list.length, "card")}${shown.length < list.length ? ` (first ${shown.length} shown)` : ""} · ${onHere} ${PE ? "in the preset" : "hunting"}`;
  CS.shown = list;
  patch($("#cs-cards"), shown.map(c => {
    const row = rowFor(c, m), on = catOn(c, row), changed = !PE && !!row && row.enabled !== row.saved;
    const tip = PE ? (on ? "In the preset. Tap to take it out." : "Tap to add it to the preset.") : on ? "Hunting. Tap to stop." : "Tap to hunt this card.";
    return `<button class="ccard ${on ? "on" : ""} ${changed ? "changed" : ""}" data-key="${esc(c.key)}" data-id="${esc(c.id)}"
        title="${esc(`${c.name} ${c.number}${c.variant ? " · " + c.variant : ""} · ${c.rarity}\nTap for a close-up with its prices by condition.`)}">
      <div class="art"><img loading="lazy" src="${esc(tcgImg(c.id))}" alt=""></div>
      <span class="tick" title="${esc(tip)}">${TICK}</span>
      <div class="nm">${esc(c.name)}</div>
      <div class="meta"><span>${esc(c.number)}</span><span class="rar">${esc(c.rarity)}</span><span class="mk">${money(c.market)}</span></div>
      ${c.variant ? `<div class="var">${esc(c.variant)}</div>` : ""}
      ${global || mon || c._rep ? `<div class="from">${esc(c._set)}</div>` : ""}</button>`;
  }).join("") || `<div class="empty">${mon && !cards.length ? "No cards of this Pokémon yet." : "No cards match."}</div>`);
}

// Tick or untick catalog cards: ones already in cards.json flip like the
// table's checkboxes; new ones queue up as entries to add on Save
function huntCatalog(cards, on) {
  const m = mine();
  const flip = [];
  for (const c of cards) {
    const row = rowFor(c, m);
    if (row && !Cd.adds.has(row.key)) { flip.push(row.key); continue; }
    if (on) { Cd.adds.set(c.key, catalogEntry(c, c._set)); Cd.pending.set(c.key, true); }
    else { Cd.adds.delete(c.key); Cd.pending.delete(c.key); }
  }
  if (flip.length) setEnabled(flip, on); else renderCards();
}
function openSet(slug) {
  CS.mode = "set"; CS.slug = slug; CS.q = ""; CS.rarity = ""; CS.status = ""; $("#cs-search").value = "";
  renderCatalog(); window.scrollTo(0, 0); $("#cm-set .cdb-body").scrollTop = 0;
}
function openMon(dex) {
  CS.dexScroll = [$("#cs-dex").scrollTop, window.scrollY];     // hidden, it forgets; back puts it back
  CS.mode = "mon"; CS.dex = dex; CS.q = ""; CS.rarity = ""; CS.status = ""; $("#cs-search").value = "";
  renderCatalog(); window.scrollTo(0, 0); $("#cm-set .cdb-body").scrollTop = 0;
}
$("#cs-dex").onclick = e => { const t = e.target.closest("[data-dex]"); if (t) openMon(+t.dataset.dex); };
$("#cs-gens").onclick = e => {
  const b = e.target.closest("[data-gen]");
  if (b) { CS.gen = +b.dataset.gen; saveCatalogView(); renderDexTiles(); $("#cs-dex").scrollTop = 0; }
};
$("#cs-dsearch").addEventListener("input", e => { CS.dq = e.target.value; renderDexTiles(); });
$("#c-mode").onclick = e => {
  const b = e.target.closest("[data-mode]");
  if (!b) return;
  CS.mode = b.dataset.mode; CS.gq = ""; $("#cs-gsearch").value = "";
  saveCatalogView(); renderCatalog();
};
$("#cs-sets").onclick = e => { const t = e.target.closest("[data-slug]"); if (t) openSet(t.dataset.slug); };
$("#cs-back").onclick = () => {
  if (CS.mode === "mon") {
    const [top, y] = CS.dexScroll || [0, 0];
    CS.mode = "dex"; renderCatalog(); $("#cs-dex").scrollTop = top; window.scrollTo(0, y);
    return;
  }
  CS.mode = "sets"; CS.gq = ""; $("#cs-gsearch").value = ""; renderCatalog();
};
let gsTimer = null;
$("#cs-gsearch").addEventListener("input", e => {
  clearTimeout(gsTimer);
  gsTimer = setTimeout(() => { const v = e.target.value.trim(); CS.gq = v.length >= 2 ? v : ""; renderCatalog(); }, 250);
});
$("#cs-search").addEventListener("input", e => { CS.q = e.target.value; renderSetCards(); });
$("#cs-rarity").onchange = e => { CS.rarity = e.target.value; renderSetCards(); };
$("#cs-sort").onchange = e => { CS[CS.mode === "mon" ? "monSort" : "sort"] = e.target.value; saveCatalogView(); renderSetCards(); };
$("#cs-variants").onchange = e => { CS.variants = e.target.checked; saveCatalogView(); renderSetCards(); };
$("#cs-ntl").onchange = e => { CS.ntl = e.target.checked; saveCatalogView(); renderSetCards(); };
$("#cs-rep").onchange = e => { CS.reprints = e.target.checked; saveCatalogView(); renderSetCards(); };
$("#cs-status").onclick = e => { const b = e.target.closest("[data-status]"); if (b) { CS.status = b.dataset.status; renderSetCards(); } };
// the tick hunts a card (or picks it for the preset); anywhere else on it opens the close-up
$("#cs-cards").onclick = e => {
  const t = e.target.closest("[data-key]");
  if (!t) return;
  const c = CS.shown.find(x => x.key === t.dataset.key);
  if (!c) return;
  if (!e.target.closest(".tick")) openCard(c);
  else if (PE) presetPick([catKey(c, rowFor(c, mine()))], !t.classList.contains("on"));
  else huntCatalog([c], !t.classList.contains("on"));
};

// --- a card close up: TCGplayer's big picture and its prices by condition,
// from conditions/<set>.json on the results branch (catalog.py's CONDITION
// PRICES: each run refreshes the stalest, so none is more than a week old)
const NM_ONLY = new Set(["Mega Evolution", "Scarlet & Violet"]);     // catalog.NM_ONLY_ERAS
const CONDS = [["NM", "Near Mint"], ["LP", "Lightly Played"], ["MP", "Moderately Played"], ["HP", "Heavily Played"], ["DMG", "Damaged"]];
const COND_NAMES = Object.fromEntries(CONDS);
// card: the one open; i: where it is in the cards shown, which can change under it
const CD = {card: null, i: -1, shards: new Map()};
function cdSlug(c) { return c._slug || CS.slug; }
function cdIndex() {
  const at = CS.shown.findIndex(x => x.id === CD.card.id && x.key === CD.card.key);
  if (at >= 0) CD.i = at;
  return CD.i;
}
function cdPrices(c) {
  const slug = cdSlug(c);
  if (!CD.shards.has(slug)) CD.shards.set(slug, getRaw(`conditions/${slug}.json`, "results").then(JSON.parse)
    .catch(e => {
      if (e.status === 404) return {cards: {}};           // none fetched for this set yet
      CD.shards.delete(slug);                             // try again next time
      return {error: e.message};
    }));
  return CD.shards.get(slug).then(d => d.error ? d : (d.cards || {})[c.id] || null);
}
function openCard(c) {
  CD.card = c; cdIndex();
  $("#cd").classList.remove("hidden");
  renderCardDetail();
}
function closeCard() { $("#cd").classList.add("hidden"); CD.card = null; }
function condTable(p) {
  if (p === undefined) return `<div class="cd-note">Loading prices by condition…</div>`;
  if (p === null) return `<div class="cd-note">No prices by condition for this card yet. Each run fetches a few thousand cards' worth, so it'll be here within a day.</div>`;
  if (p.error) return `<div class="cd-note">Couldn't load prices by condition: ${esc(p.error)}</div>`;
  const printings = Object.keys(p.v || {}).sort((a, b) => /reverse/i.test(a) - /reverse/i.test(b) || a.localeCompare(b));
  if (!printings.length) return `<div class="cd-note">TCGplayer has no sales of this card in the last month, so no prices by condition.</div>`;
  const rows = CONDS.map(([code, name]) => `<tr><td>${name}</td>${printings.map(v => {
    const x = (p.v[v] || {})[code];
    return x ? `<td><b>${money(x[0])}</b><span class="n">${Number(x[1]).toLocaleString()} sold</span></td>` : `<td class="none">—</td>`;
  }).join("")}</tr>`).join("");
  const at = new Date(p.at + "T12:00:00");
  return `<table class="cd-conds"><thead><tr><th>Condition</th>${printings.map(v => `<th>${esc(v)}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table>
    <div class="cd-note">TCGplayer market price by condition, and copies sold there in the last 30 days · as of ${esc(isNaN(at) ? p.at : at.toLocaleDateString([], {year: "numeric", month: "short", day: "numeric"}))}</div>`;
}
async function renderCardDetail() {
  const c = CD.card;
  if (!c) return closeCard();
  const st = CAT.bySlug.get(cdSlug(c)) || {};
  const row = rowFor(c, mine()), on = catOn(c, row);
  const n = CS.shown.length, i = cdIndex();
  $("#cd-img").src = tcgImg(c.id, "in_1000x1000");
  const act = PE ? (on ? "Take out of the preset" : "Add to the preset") : on ? "Stop hunting" : "Hunt this card";
  const rule = NM_ONLY.has(st.era)
    ? `Card Hunter prices ${esc(st.era)} cards as Near Mint whatever their condition: almost every one goes straight from the pack into a sleeve.`
    : `Card Hunter compares each listing to the price for its condition, from the title or the condition the seller picked on eBay. A worn copy has to beat a worn copy's price.`;
  const draw = p => {
    if (CD.card !== c) return;                            // moved on meanwhile
    $("#cd-info").innerHTML = `
      <h2 id="cd-name">${esc(c.name)}</h2>
      <div class="cd-sub">${[c.number, c.rarity, c.variant].filter(Boolean).map(esc).join(" · ")}</div>
      <div class="cd-sub">${esc(c._set || st.name || "")}${st.era ? " · " + esc(st.era) : ""}${st.date ? " · " + esc(fmtRelease(st.date)) : ""}</div>
      <div class="cd-mk"><b>${money(c.market)}</b><span class="muted">market${c.market != null ? " (Near Mint)" : ""}</span></div>
      ${condTable(p)}
      <div class="cd-note">${rule}</div>
      <div class="cd-actions">
        <button class="btn ${on ? "" : "primary"}" id="cd-hunt">${act}</button>
        <a class="btn ghost" href="https://www.tcgplayer.com/product/${esc(c.id)}" target="_blank" rel="noopener">TCGplayer ↗</a>
        <span class="spacer"></span>
        <button class="btn ghost icon" id="cd-prev" title="Previous card (←)" ${i > 0 ? "" : "disabled"}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M15 6l-6 6 6 6"/></svg></button>
        <span class="hint">${(i + 1).toLocaleString()} of ${n.toLocaleString()}</span>
        <button class="btn ghost icon" id="cd-next" title="Next card (→)" ${i < n - 1 ? "" : "disabled"}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 6l6 6-6 6"/></svg></button>
      </div>`;
  };
  draw(undefined);
  draw(await cdPrices(c));
}
function stepCard(d) {
  const j = cdIndex() + d;
  if (j >= 0 && j < CS.shown.length) { CD.card = CS.shown[j]; CD.i = j; renderCardDetail(); }
}
$("#cd-close").onclick = closeCard;
$("#cd").addEventListener("click", e => {
  if (e.target.id === "cd") return closeCard();
  if (e.target.closest("#cd-prev")) return stepCard(-1);
  if (e.target.closest("#cd-next")) return stepCard(1);
  if (e.target.closest("#cd-hunt")) {
    const c = CD.card, row = rowFor(c, mine()), on = catOn(c, row);
    if (PE) presetPick([catKey(c, row)], !on); else huntCatalog([c], !on);
    renderCardDetail();
  }
});
document.addEventListener("keydown", e => {
  if ($("#cd").classList.contains("hidden")) return;
  if (e.key === "Escape") closeCard();
  else if (e.key === "ArrowLeft") stepCard(-1);
  else if (e.key === "ArrowRight") stepCard(1);
});
(function swipe() {
  let x0 = null;
  $("#cd").addEventListener("touchstart", e => { x0 = e.touches[0].clientX; }, {passive: true});
  $("#cd").addEventListener("touchend", e => {
    if (x0 == null) return;
    const dx = e.changedTouches[0].clientX - x0; x0 = null;
    if (Math.abs(dx) > 60) stepCard(dx < 0 ? 1 : -1);
  }, {passive: true});
})();
function shownWhere(on) {
  const m = mine();
  return CS.shown.filter(c => { const r = rowFor(c, m); return !!(r && r.enabled) === on; });
}
$("#cs-on").onclick = () => {
  if (PE) return presetPick(shownPresetKeys(), true);
  const cards = shownWhere(false);
  const perDay = runsPerDay(parseSchedule(S.yml)) || 1;
  if (cards.length > 25 && !confirm(`Hunt all ${cards.length} cards shown? That's about ${(cards.length * 2 * perDay).toLocaleString()} more eBay calls a day (you get ${EBAY_DAILY.toLocaleString()}).`)) return;
  huntCatalog(cards, true);
};
$("#cs-off").onclick = () => {
  if (PE) return presetPick(shownPresetKeys(), false);
  const cards = shownWhere(true);
  if (cards.length > 10 && !confirm(`Stop hunting all ${cards.length} cards shown?`)) return;
  huntCatalog(cards, false);
};

/* ================================================================== SCHEDULE */
const SCHED_RE = /(  # --- schedule start ---\r?\n)([\s\S]*?)(  # --- schedule end ---)/;
const EVERY = [2, 3, 4, 6, 8, 12, 24];

function expandHours(h) {
  if (h === "*") return [...Array(24).keys()];
  let m = /^\*\/(\d+)$/.exec(h);
  if (m) { const n = +m[1]; return [...Array(24).keys()].filter(x => x % n === 0); }
  const out = new Set();
  for (const part of h.split(",")) {
    m = /^(\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part);
    if (!m) return null;
    const a = +m[1], b = m[2] != null ? +m[2] : a, step = m[3] ? +m[3] : 1;
    for (let x = a; x <= b; x += step) if (x < 24) out.add(x);
  }
  return [...out].sort((a, b) => a - b);
}
/* The workflow's schedule, as {ok, paused, custom, minute, hoursUtc, every, startLocal} */
function parseSchedule(yml) {
  const m = SCHED_RE.exec(yml || "");
  if (!m) return {ok: false};
  const crons = [...m[2].matchAll(/^\s*-\s*cron:\s*["']([^"']+)["']/gm)].map(x => x[1].trim());
  if (!crons.length) return {ok: true, paused: true, crons};
  if (crons.length === 1) {
    const f = crons[0].split(/\s+/);
    if (f.length === 5 && /^\d+$/.test(f[0]) && f.slice(2).every(x => x === "*")) {
      const hoursUtc = expandHours(f[1]);
      if (hoursUtc && hoursUtc.length) {
        const sch = {ok: true, paused: false, minute: +f[0], hoursUtc, crons};
        // Evenly spaced in local time? Then it's "every N hours from H"
        const local = localTimes(sch).map(d => d.getHours() * 60 + d.getMinutes()).sort((a, b) => a - b);
        const n = 24 / local.length;
        const even = local.every((t, i) => i === 0 || t - local[i - 1] === n * 60);
        if (EVERY.includes(n) && even) { sch.every = n; sch.startLocal = Math.floor(local[0] / 60); }
        else sch.custom = true;
        return sch;
      }
    }
  }
  return {ok: true, custom: true, crons};
}
/* Today's run times as local Dates */
function localTimes(sch) {
  const now = new Date();
  return (sch.hoursUtc || []).map(h => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, sch.minute)));
}
function nextRun(sch) {
  if (!sch.ok || sch.paused || !sch.hoursUtc) return null;
  const now = Date.now();
  for (let day = 0; day < 2; day++)
    for (const d of localTimes(sch).map(d => new Date(+d + day * 864e5)).sort((a, b) => a - b))
      if (+d > now) return d;
  return null;
}
function runsPerDay(sch) { return !sch.ok || sch.paused ? 0 : sch.hoursUtc ? sch.hoursUtc.length : 6; }
function describeEvery(sch) {
  const first = localTimes(sch).sort((a, b) => a.getHours() * 60 + a.getMinutes() - (b.getHours() * 60 + b.getMinutes()))[0];
  return sch.every === 24 ? `Once a day at ${fmtClock(first)}` : `Every ${sch.every} hours, from ${fmtClock(first)}`;
}
/* Everything between the markers for the chosen schedule */
function scheduleBlock(every, startLocal, minute = 17) {
  if (!every) return "  # Paused on the dashboard. Pick a schedule there to turn it back on.\n";
  const off = new Date().getTimezoneOffset();          // minutes to add to local for UTC
  const hours = new Set();
  let min = null;
  for (let h = startLocal; h < startLocal + 24; h += every) {
    const utc = ((h % 24) * 60 + minute + off + 1440 * 2) % 1440;
    hours.add(Math.floor(utc / 60)); min = utc % 60;
  }
  const sorted = [...hours].sort((a, b) => a - b);
  const tz = -off / 60;
  const desc = every === 24 ? "once a day" : `every ${every} hours`;
  return `  schedule:\n` +
    `    # Set on the dashboard: ${desc} from ${fmtClock(new Date(2000, 0, 1, startLocal, minute))} (UTC${tz >= 0 ? "+" : ""}${tz}).\n` +
    `    # Hours below are UTC. Change it on the dashboard's Schedule tab.\n` +
    `    - cron: "${min} ${sorted.join(",")} * * *"\n`;
}
const SC = {every: null, start: 0, dirty: false};

function scheduleFromForm() {
  const block = scheduleBlock(SC.every, SC.start);
  const m = SCHED_RE.exec(S.yml);
  return m ? S.yml.replace(SCHED_RE, `$1${block}$3`) : null;
}
function renderSchedule() {
  const cur = parseSchedule(S.yml);
  if (!SC.dirty) {
    SC.every = cur.paused ? 0 : cur.every ?? null;
    SC.start = cur.startLocal ?? 0;
  }
  $$("#sc-every button").forEach(b => b.classList.toggle("active", +b.dataset.v === SC.every));
  const custom = $("#sc-custom");
  custom.classList.toggle("hidden", !(cur.custom && !SC.dirty));
  if (cur.custom) custom.textContent = `The workflow file has a custom schedule (${(cur.crons || []).join("; ")}). Pick one above to replace it.`;
  if (!cur.ok) { custom.classList.remove("hidden"); custom.textContent = "Couldn't find the schedule markers in the workflow file."; }

  const every = SC.every;
  $("#sc-start-row").classList.toggle("hidden", !every);
  if (every) {
    $("#sc-start-label").textContent = every === 24 ? "Time" : "Runs start from";
    const opts = [...Array(every === 24 ? 24 : every).keys()];
    $("#sc-start").innerHTML = opts.map(h => {
      const times = every === 24 ? fmtClock(new Date(2000, 0, 1, h, 17)) :
        [0, 1].map(k => fmtClock(new Date(2000, 0, 1, h + k * every, 17))).join(", ") + ", …";
      return `<option value="${h}" ${h === SC.start ? "selected" : ""}>${esc(times)}</option>`;
    }).join("");
  }
  const preview = every ? parseSchedule(scheduleFromForm() || "") : every === 0 ? {ok: true, paused: true} : cur;
  const times = preview.ok && preview.hoursUtc ? localTimes(preview).sort((a, b) => (a.getHours() * 60 + a.getMinutes()) - (b.getHours() * 60 + b.getMinutes())) : [];
  $("#sc-times").innerHTML = preview.paused ? `<span>Paused — only Run now starts runs</span>` :
    times.map(d => `<span>${esc(fmtClock(d))}</span>`).join("") || `<span class="muted">—</span>`;

  const perDay = runsPerDay(preview);
  const cards = enabledCards();
  const calls = callsPerRun(cards) * perDay;
  const mins = Math.ceil(minutesPerRun()) * perDay * 30;
  $("#sc-calls").innerHTML = `${Math.round(calls).toLocaleString()} <small>of ${EBAY_DAILY.toLocaleString()}</small>`;
  meter($("#sc-calls-m"), calls / EBAY_DAILY, true);
  $("#sc-calls-h").textContent = `${plural(perDay, "run")} × ~${callsPerRun(cards).toLocaleString()} calls (${plural(cards.length, "card")} + ETB promos)`;
  $("#sc-mins").innerHTML = `${Math.round(mins).toLocaleString()} <small>of ${ACTIONS_MONTHLY.toLocaleString()}</small>`;
  meter($("#sc-mins-m"), mins / ACTIONS_MONTHLY, true);
  $("#sc-mins-h").textContent = `~${Math.ceil(minutesPerRun())} min a run, rounded up the way GitHub bills it`;
  $("#sc-window").textContent = every
    ? `Auctions get reported once they're within ${every + 1} hours of ending (the gap between runs plus an hour, so none close unseen). Saving updates that too.`
    : "";
  const over = calls > EBAY_DAILY || mins > ACTIONS_MONTHLY;
  $("#sc-state").innerHTML = over ? `<span class="bad-t">Over a limit — runs would start failing partway.</span>` : SC.dirty ? "Unsaved changes" : "";
  $("#sc-save").disabled = !SC.dirty || SC.every == null || !cur.ok;
}
$("#sc-every").onclick = e => {
  const b = e.target.closest("[data-v]"); if (!b) return;
  const v = +b.dataset.v;
  if (v && SC.every && v !== SC.every) SC.start = SC.start % Math.min(v, 24);
  SC.every = v; SC.dirty = true; renderSchedule();
};
$("#sc-start").onchange = e => { SC.start = +e.target.value; SC.dirty = true; renderSchedule(); };
$("#sc-save").onclick = async () => {
  const btn = $("#sc-save"), every = SC.every, start = SC.start;
  btn.disabled = true; btn.textContent = "Saving…";
  try {
    const desc = every ? (every === 24 ? "once a day" : `every ${every} hours`) : "paused";
    const r = await saveFile(WORKFLOW_PATH, text => {
      if (!SCHED_RE.test(text)) throw new Error("The workflow file has no schedule markers.");
      return text.replace(SCHED_RE, `$1${scheduleBlock(every, start)}$3`);
    }, `Dashboard: schedule ${desc}`);
    S.yml = r.text; S.ymlSha = r.sha;
    if (every) {
      const s = await saveFile("settings.json", text => {
        const d = JSON.parse(text || "{}");
        d.cloud = {...(d.cloud || {}), auction_hours: every + 1};
        return JSON.stringify(d, null, 2) + "\n";
      }, `Dashboard: report auctions ending within ${every + 1}h`);
      S.settings = JSON.parse(s.text); S.settingsSha = s.sha; ST.dirty = false;
    }
    SC.dirty = false;
    toast("Schedule saved", every ? "GitHub can take a few minutes to pick up a new schedule." : "Automatic runs are off until you pick a schedule.", "good");
  } catch (e) {
    if (e.status !== 401) toast("Couldn't save the schedule", e.message, "bad");
  } finally {
    btn.textContent = "Save schedule"; renderSchedule(); renderNext();
  }
};

/* ================================================================== SETTINGS */
const ST = {dirty: false, form: null};
function settingsForm() {
  const s = S.settings || {}, c = s.cloud || {};
  return {type: c.type || "both", hours: c.auction_hours ?? 5, newh: c.new_hours ?? "", pct: c.price_pct ?? ""};
}
function renderSettings() {
  if (!ST.dirty || !ST.form) ST.form = settingsForm();
  const f = ST.form;
  $$("#st-type button").forEach(b => b.classList.toggle("active", b.dataset.v === f.type));
  if (document.activeElement?.id !== "st-hours") $("#st-hours").value = f.hours;
  if (document.activeElement?.id !== "st-new") $("#st-new").value = f.newh;
  $("#st-new").disabled = f.type === "auction";
  $("#st-hours").disabled = f.type === "buy-now";
  if (document.activeElement?.id !== "st-pct") $("#st-pct").value = f.pct;
  $("#st-save").disabled = !ST.dirty;
  $("#st-state").textContent = ST.dirty ? "Unsaved changes" : "";
  $("#st-account").innerHTML = `Signed in to <b>${esc(S.repo)}</b>${DEMO ? " (demo data)" : ""}. The token is saved in this browser only.
    To use the dashboard on another device, sign in there with the same token.`;
}
function stDirty() { ST.dirty = true; renderSettings(); }

$("#st-type").onclick = e => { const b = e.target.closest("[data-v]"); if (b) { ST.form.type = b.dataset.v; stDirty(); } };
$("#st-hours").addEventListener("input", e => { ST.form.hours = e.target.value; stDirty(); });
$("#st-new").addEventListener("input", e => { ST.form.newh = e.target.value; stDirty(); });
$("#st-pct").addEventListener("input", e => { ST.form.pct = e.target.value; stDirty(); });
$("#st-save").onclick = async () => {
  const f = ST.form;
  const hours = num(f.hours), pct = f.pct === "" ? null : num(f.pct);
  const newh = String(f.newh).trim() === "" ? null : num(f.newh);
  if (hours == null || hours < 1) return toast("Auction window must be at least 1 hour", "", "bad");
  if (newh != null && !(newh >= 1)) return toast("Buy It Now window must be at least 1 hour, or blank for any age", "", "bad");
  if (f.pct !== "" && (pct == null || pct <= 0)) return toast("Price cap must be a positive %", "", "bad");
  const btn = $("#st-save");
  btn.disabled = true; btn.textContent = "Saving…";
  try {
    const r = await saveFile("settings.json", text => {
      const d = JSON.parse(text || "{}");
      d.cloud = {...(d.cloud || {}), auction_hours: hours, new_hours: newh, price_pct: pct === 100 ? null : pct, type: f.type};
      return JSON.stringify(d, null, 2) + "\n";
    }, "Dashboard: update settings");
    S.settings = JSON.parse(r.text); S.settingsSha = r.sha;
    ST.dirty = false;
    toast("Settings saved", "The next run uses them.", "good");
  } catch (e) {
    if (e.status !== 401) toast("Couldn't save settings", e.message, "bad");
  } finally {
    btn.textContent = "Save settings"; renderSettings(); renderCards(); RN.ready = false; renderRun();
  }
};
$("#st-signout").onclick = () => { if (confirm("Sign out on this device? You'll need the token to sign back in.")) signOut(); };

/* ================================================================== POLLING */
let pollTimer = null;
function schedulePoll(ms) {
  clearTimeout(pollTimer);
  const active = S.actions.some(r => r.status !== "completed");
  pollTimer = setTimeout(pollTick, ms ?? (document.hidden ? 120000 : active ? 6000 : 60000));
}
async function pollTick(manual) {
  try {
    const finished = await loadActions();
    const sel = S.actions.find(r => r.id === S.selectedRun);
    const active = S.actions.filter(r => r.status !== "completed");
    await Promise.all([...new Set([sel, ...active].filter(Boolean))].map(loadJobs));
    if (finished.length) {
      await loadResults();
      RS.key = null;
      for (const r of finished) {
        const res = resultFor(r);
        if (r.conclusion === "success") toast("Run finished", res ? `${res.stamped ? res.stamped + " stamped · " : ""}${plural(res.matches, "match", "matches")}` : "", "good");
        else toast("Run " + (r.conclusion || "ended"), "Open it on the Run tab for details.", r.conclusion === "cancelled" ? "warn" : "bad");
      }
      renderQuota();
      if (S.view === "results") renderResults();
    }
    if (manual === true) toast("Up to date");
  } catch (e) {
    if (e.status === 401) return;
    if (manual === true) toast("Couldn't refresh", e.message, "bad");
  }
  if (S.view === "run") renderRun(); else renderRunBadge();
  schedulePoll();
}
function renderRunBadge() {
  const running = S.actions.filter(r => r.status !== "completed").length;
  $("#nav-running").classList.toggle("hidden", !running); $("#nav-running").textContent = running;
}
document.addEventListener("visibilitychange", () => { if (!document.hidden && S.token) schedulePoll(300); });
setInterval(() => { if (S.view === "run" && S.actions.some(r => r.status !== "completed")) renderRunDetail(); }, 1000);

/* ================================================================== SIGN IN */
function showSignin(err) {
  $("#signin").classList.remove("hidden");
  $("#hdr").classList.add("hidden"); $("#app").classList.add("hidden");
  $("#si-error").classList.toggle("hidden", !err);
  $("#si-error").textContent = err || "";
  $("#si-repo").value = store.get("repo", "giraffeo182/PokeSniper");
  setTimeout(() => $("#si-token").focus(), 50);
}
function signOut(reason) {
  store.del("token"); S.token = "";
  clearTimeout(pollTimer);
  showSignin(reason);
}
async function signIn(token, repo) {
  S.token = token.trim(); S.repo = repo.trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/$/, "");
  const r = await gh(repoPath(""));
  if (!r.permissions?.push) throw new GhError("This token can read the repo but not change it. Give it Contents, Actions and Workflows: Read and write.", 403);
  if (!r.private && !DEMO) toast("Heads up: this repo is public", "Anyone can see its cards and results.", "warn");
  store.set("token", S.token); store.set("repo", S.repo);
}
$("#si-go").onclick = async () => {
  const token = $("#si-token").value, repo = $("#si-repo").value;
  if (!token.trim()) return showSignin("Paste your token first.");
  const btn = $("#si-go");
  btn.disabled = true; btn.textContent = "Checking…";
  try { await signIn(token, repo); $("#si-token").value = ""; await start(); }
  catch (e) {
    showSignin(e.status === 404 ? `Can't see ${S.repo}. Check the name, and that the token has access to that repo.` :
               e.status === 401 ? "GitHub didn't accept that token. Copy it again — it starts with github_pat_." : e.message);
  } finally { btn.disabled = false; btn.textContent = "Sign in"; }
};
$("#si-token").addEventListener("keydown", e => { if (e.key === "Enter") $("#si-go").click(); });

async function start() {
  $("#signin").classList.add("hidden");
  $("#hdr").classList.remove("hidden"); $("#app").classList.remove("hidden");
  patch($("#run-status"), `<span class="muted">Loading from GitHub…</span>`);
  const [cfg, acts, res] = await Promise.allSettled([loadConfig(), loadActions(), loadResults()]);
  for (const x of [cfg, acts, res]) if (x.status === "rejected" && x.reason?.status !== 401) toast("Couldn't load everything", x.reason?.message || String(x.reason), "bad");
  if (cfg.status === "rejected" && cfg.reason?.status === 401) return;
  renderVersion(); renderQuota(); renderChips();
  show(store.get("view", "run"));
  const sel = S.actions.find(r => r.status !== "completed") || S.actions[0];
  if (sel) { S.selectedRun = sel.id; await loadJobs(sel); if (S.view === "run") renderRunDetail(); }
  schedulePoll();
}

(async function boot() {
  if (DEMO) {
    await new Promise((ok, fail) => { const s = document.createElement("script"); s.src = "demo.js"; s.onload = ok; s.onerror = fail; document.head.appendChild(s); });
    await window.PS_DEMO.ready;
    S.token = "demo"; S.repo = "demo/PokeSniper";
    return start();
  }
  const token = store.get("token", "");
  if (!token) return showSignin();
  try { await signIn(token, store.get("repo", "giraffeo182/PokeSniper")); await start(); }
  catch (e) { if (e.status !== 401) showSignin(e.message); }
})();
