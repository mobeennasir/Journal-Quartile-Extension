// Phase 2: DOI / article-link / manual lookup + year-correct
// ranking (JCR import, SJR labelled fallback, WoS category W/X)
// + batch upload (Excel / CSV) with CSV export.
// Shared lookup page used by the side panel and by a full tab
// (sidepanel.html). Crossref first, OpenAlex fallback for the
// article metadata. Only data returned by an API is displayed;
// nothing is invented. DOI extraction lives in shared.js; ranking
// data logic lives in jcr.js; the .xlsx reader lives in xlsx.js.

const MAILTO = "mubeennasir117@gmail.com";
const DATA = (typeof JournalQuartileData !== "undefined") ? JournalQuartileData : null;
const XLSX = (typeof JournalQuartileXlsx !== "undefined") ? JournalQuartileXlsx : null;
const NET = (typeof JournalQuartileNet !== "undefined") ? JournalQuartileNet : null;
const FREE = (typeof JournalQuartileFreeData !== "undefined") ? JournalQuartileFreeData : null;
// SJR years currently being fetched (one promise per year), so a
// batch with many rows from the same year fetches it once.
const sjrFetchInFlight = new Map();
// Cache of fetched articles (DOI and title lookups), so a repeat
// lookup returns instantly without re-fetching.
const articleCache = NET ? new NET.ArticleCache(200) : null;

// ---------- Element handles ----------
const inputEl = document.getElementById("input");
const lookupBtn = document.getElementById("lookup");
const statusEl = document.getElementById("status");
const resultEl = document.getElementById("result");
const openTabBtn = document.getElementById("open-tab");
const checkPageBtn = document.getElementById("check-page");
const manualTitleEl = document.getElementById("manual-title");
const manualJournalEl = document.getElementById("manual-journal");
const manualYearEl = document.getElementById("manual-year");
const manualDoiEl = document.getElementById("manual-doi");
const manualIssnEl = document.getElementById("manual-issn");
const lookupManualBtn = document.getElementById("lookup-manual");
const batchFileEl = document.getElementById("batch-file");
const batchFileNameEl = document.getElementById("batch-file-name");
const batchRunBtn = document.getElementById("batch-run");
const batchTestsetBtn = document.getElementById("batch-testset");
const batchStatusEl = document.getElementById("batch-status");
const batchSjrStatusEl = document.getElementById("batch-sjr-status");
const batchProgressEl = document.getElementById("batch-progress");
const batchProgressBarEl = document.getElementById("batch-progress-bar");
const batchResultsEl = document.getElementById("batch-results");
const batchDownloadBtn = document.getElementById("batch-download");
const jcrYearEl = document.getElementById("jcr-year");
const jcrFileEl = document.getElementById("jcr-file");
const jcrFileNameEl = document.getElementById("jcr-file-name");
const jcrImportBtn = document.getElementById("jcr-import");
const jcrStatusEl = document.getElementById("jcr-status");
const sjrFileEl = document.getElementById("sjr-file");
const sjrFileNameEl = document.getElementById("sjr-file-name");
const sjrImportBtn = document.getElementById("sjr-import");
const sjrStatusEl = document.getElementById("sjr-status");
const mjlFileEl = document.getElementById("mjl-file");
const mjlFileNameEl = document.getElementById("mjl-file-name");
const mjlImportBtn = document.getElementById("mjl-import");
const mjlStatusEl = document.getElementById("mjl-status");
const clearDataBtn = document.getElementById("clear-data");
const storageNoteEl = document.getElementById("storage-note");
const autoFetchToggleEl = document.getElementById("auto-fetch");
const freeDataStatusEl = document.getElementById("free-data-status");
const sjrYearEl = document.getElementById("sjr-year");
const sjrFetchBtn = document.getElementById("sjr-fetch");
const sjrOpenPageBtn = document.getElementById("sjr-open-page");
const mjlFetchBtn = document.getElementById("mjl-fetch");
const batchMjlBtn = document.getElementById("batch-mjl");

// Last article shown, for the "Get WoS category (free)" retry.
let lastShown = null;

// Show a short note when imported data cannot persist (IndexedDB
// unavailable, e.g. private mode): lookups still work, but imports
// are kept in memory for this session only.
function showStorageFallbackNote() {
  if (storageNoteEl) {
    storageNoteEl.textContent = "Storage: in-memory only. Imported data will not persist after the panel closes.";
    storageNoteEl.hidden = false;
  }
}

// ---------- Ranking store (IndexedDB, memory fallback) ----------
let store = null;
function getStore() {
  if (store) return store;
  try {
    store = new DATA.IdbStore();
  } catch (err) {
    store = new DATA.MemoryStore();
    showStorageFallbackNote();
  }
  return store;
}
async function safeGetRank(issns, year) {
  try {
    const rank = await getStore().getRank(issns, year);
    return rank;
  } catch (err) {
    // IndexedDB unavailable (e.g. private mode): fall back to a
    // fresh in-memory store — imported data won't persist, but the
    // lookup still works for this session.
    store = new DATA.MemoryStore();
    showStorageFallbackNote();
    try { return await store.getRank(issns, year); } catch (e) { return null; }
  }
}

// ---------- SJR year, set automatically from the article ----------
// A lookup must never need the user to pick the SJR year by hand:
// the year comes from the article's publication year, and the
// extension fetches SJR data for exactly that year when it is not
// already stored. Batch rows fetch each distinct year once.
function sjrLatestYear() {
  if (FREE && FREE.sjrLatestYear) return FREE.sjrLatestYear();
  const d = new Date();
  return d.getMonth() >= 5 ? d.getFullYear() - 1 : d.getFullYear() - 2;
}

// Fetch SJR data for one publication year, unless it is already
// stored (and unexpired) or not released yet. Returns
// { state, year }: "ready" (already stored), "fetched",
// "not-released" (year after the latest SJR release — SJR data
// for year Y appears in June Y+1), "challenge" (the human check
// never cleared), "blocked" (the download was blocked), "failed".
// Concurrent calls for the same year share one fetch.
async function ensureSjrYear(year) {
  const y = parseInt(year, 10);
  if (!y) return { state: "invalid", year: y };
  if (y > sjrLatestYear()) return { state: "not-released", year: y };
  try {
    const meta = await getStore().getMeta();
    if (DATA.sjrFilesCoverYear(meta, y)) return { state: "ready", year: y };
  } catch (err) { /* fall through and try the fetch */ }
  if (sjrFetchInFlight.has(y)) return sjrFetchInFlight.get(y);
  const run = (async () => {
    let res = await sendBackgroundMessage({ type: "fetchSjrExport", year: y }, 90000);
    if (res && res.rows) {
      refreshImportStatus();
      return { state: "fetched", year: y, rows: res.rows };
    }
    if (res && (res.error === "blocked" || res.error === "not-csv" || res.error === "failed" || res.error === "timeout")) {
      res = await sendBackgroundMessage({ type: "fetchSjrViaTab", year: y }, 120000);
      if (res && res.rows) {
        refreshImportStatus();
        return { state: "fetched", year: y, rows: res.rows };
      }
      if (res && res.error === "challenge") return { state: "challenge", year: y };
      return { state: "blocked", year: y };
    }
    return { state: "failed", year: y };
  })();
  sjrFetchInFlight.set(y, run);
  try { return await run; } finally { sjrFetchInFlight.delete(y); }
}

// ---------- Mode tabs ----------
// Two modes only: "DOI or article link" (one input that accepts a
// bare DOI, a doi.org link, or a publisher article URL, as in
// Phase 1) and "Enter details manually".
const MODES = ["doi", "manual"];
function setMode(mode) {
  MODES.forEach((m) => {
    const tab = document.getElementById("mode-" + m);
    const pane = document.getElementById("pane-" + m);
    const active = m === mode;
    if (tab) { tab.classList.toggle("active", active); tab.setAttribute("aria-selected", active ? "true" : "false"); }
    if (pane) pane.hidden = !active;
  });
}
MODES.forEach((m) => {
  const tab = document.getElementById("mode-" + m);
  if (tab) tab.addEventListener("click", () => setMode(m));
});

// ---------- DOI resolution from a publisher URL (unchanged from v3) ----------
async function resolveDoiFromUrl(raw) {
  const url = (raw || "").trim();
  if (!/^https?:\/\//i.test(url)) return { doi: null, blocked: false };
  let host = "";
  try { host = new URL(url).hostname; } catch (err) { /* ignore */ }
  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
    try {
      const response = await new Promise((resolve) => {
        let done = false;
        const timer = setTimeout(() => { if (!done) { done = true; resolve(null); } }, 20000);
        chrome.runtime.sendMessage({ type: "fetchPageDoi", url }, (res) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(res || null);
        });
      });
      if (response && response.doi) return { doi: response.doi, blocked: false };
      if (response && response.blocked) return { doi: null, blocked: true, host, status: response.status };
    } catch (err) { /* fall through */ }
  }
  const slugDoi = doiFromSlug(url);
  if (slugDoi) return { doi: slugDoi, blocked: false };
  try {
    // 10s timeout: a hung publisher fetch must not freeze the panel.
    const controller = (typeof AbortController !== "undefined") ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 10000) : null;
    let response;
    try {
      response = await fetch(url, { headers: { Accept: "text/html" }, signal: controller ? controller.signal : undefined });
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (response.ok) {
      const doi = parseDoiFromHtml(await response.text());
      if (doi) return { doi, blocked: false };
    } else if (response.status === 403 || response.status === 429) {
      return { doi: null, blocked: true, host, status: response.status };
    }
  } catch (err) { /* ignore: timeout or network error means no DOI from this page */ }
  return { doi: null, blocked: false };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function yearFromCrossref(message) {
  const part = message["published-print"] || message["published-online"] || message.created;
  const parts = part && part["date-parts"] && part["date-parts"][0];
  return parts && parts[0] ? String(parts[0]) : "";
}

function issnListFromCrossref(message) {
  const list = message.ISSN || [];
  if (!Array.isArray(list)) return [];
  const out = [];
  list.forEach((entry) => {
    const value = typeof entry === "string" ? entry : (entry && entry.value) || "";
    DATA.parseIssnList(value).forEach((x) => { if (out.indexOf(x) === -1) out.push(x); });
  });
  return out;
}

function normaliseCrossref(message) {
  const biblio = [];
  if (message.volume) biblio.push(`Vol. ${message.volume}`);
  if (message.issue) biblio.push(`Issue ${message.issue}`);
  if (message.page) biblio.push(`pp. ${message.page}`);
  if (message["article-number"]) biblio.push(`Art. ${message["article-number"]}`);
  return {
    title: (message.title && message.title[0]) || "",
    journal: (message["container-title"] && message["container-title"][0]) || "",
    issns: issnListFromCrossref(message),
    issn: issnListFromCrossref(message).map((x) => DATA.formatIssn(x)).join(", "),
    year: yearFromCrossref(message),
    publisher: message.publisher || "",
    biblio: biblio.join(", "),
    doi: message.DOI || "",
    url: message.URL || "",
  };
}

function normaliseOpenAlex(work) {
  const source = (work.primary_location && work.primary_location.source) || {};
  const biblio = work.biblio || {};
  const pages = [];
  if (biblio.volume) pages.push(`Vol. ${biblio.volume}`);
  if (biblio.issue) pages.push(`Issue ${biblio.issue}`);
  if (biblio.first_page) {
    pages.push(biblio.last_page && biblio.last_page !== biblio.first_page
      ? `pp. ${biblio.first_page}–${biblio.last_page}`
      : `p. ${biblio.first_page}`);
  }
  const issns = [];
  if (source.issn_l) DATA.parseIssnList(source.issn_l).forEach((x) => issns.push(x));
  (source.issn || []).forEach((issn) => {
    DATA.parseIssnList(issn).forEach((x) => { if (issns.indexOf(x) === -1) issns.push(x); });
  });
  const doi = (work.doi || "").replace(/^https?:\/\/doi\.org\//i, "");
  return {
    title: work.display_name || work.title || "",
    journal: source.display_name || "",
    issns: issns,
    issn: issns.map((x) => DATA.formatIssn(x)).join(", "),
    year: work.publication_year ? String(work.publication_year) : "",
    publisher: source.host_organization_name || "",
    biblio: pages.join(", "),
    doi,
    url: work.doi || "",
  };
}

// ---------- Ranking rows for a single result ----------
// Every number carries its source and year. A missing JCR value is
// stated as missing — never another year's rank.
// sjrNote (from ensureSjrYear): "not-released" or "blocked" —
// the SJR row then says why, instead of the generic no-data line.
function rankingRows(data, rank, sjrNote) {
  const year = data.year || "";
  const rows = [];
  const wos = rank && rank.wosCategory ? rank.wosCategory : "";
  if (rank && rank.source === "JCR") {
    rows.push(["JCR quartile (" + year + ")", rank.quartile ? "Q" + rank.quartile.replace(/^Q/, "") : "—"]);
    rows.push(["Impact Factor — JCR (" + year + ")", (rank.jif === null || rank.jif === undefined) ? "—" : String(rank.jif)]);
  } else if (rank && rank.source === "SJR") {
    rows.push(["JCR quartile (" + year + ")", "No JCR data for this year"]);
    rows.push(["Impact Factor — JCR (" + year + ")", "No JCR data for this year"]);
    rows.push(["SJR quartile — fallback, NOT JCR (" + year + ")",
      rank.quartile + (rank.sjr !== null && rank.sjr !== undefined ? " (SJR " + rank.sjr + ")" : "")]);
    // Per-year store, stated plainly: this year's SJR data is
    // saved in the DB, so the lookup used it with no re-import.
    rows.push(["SJR data", "Saved for " + year]);
  } else {
    rows.push(["JCR quartile (" + year + ")", "No JCR data for this year"]);
    rows.push(["Impact Factor — JCR (" + year + ")", "No JCR data for this year"]);
    rows.push(["SJR quartile — fallback, NOT JCR (" + year + ")",
      sjrNote === "not-released" ? "No SJR data for " + year + " yet"
      : sjrNote === "blocked" ? "SJR " + year + " could not be downloaded automatically — tap Get free SJR data or Open SJR download page"
      : "No SJR data for this year"]);
  }
  rows.push(["WoS category", wos ? wos + (wos === "W" ? " — SCIE, SSCI or AHCI" : " — ESCI (Emerging)") : "Unknown — checking free WoS list…"]);
  if (rank && rank.source !== "none" && rank.sourceFile) {
    rows.push(["Ranking data from", escapeHtml(rank.sourceFile)]);
  }
  return rows;
}

async function showResult(data, sourceName, opts) {
  const autoFetchSjr = !opts || opts.autoFetchSjr !== false;
  let rank = (data.issns && data.issns.length && data.year)
    ? await safeGetRank(data.issns, parseInt(data.year, 10))
    : null;
  let sjrNote = null;
  // No SJR row for the article's year? Fetch that year now — the
  // year comes from the article, never from the user. JCR and SJR
  // rows already stored need no fetch at all.
  if (autoFetchSjr && data.year && (!rank || rank.source === "none")) {
    if (statusEl) statusEl.textContent = `Getting SJR data for ${data.year}…`;
    const ensured = await ensureSjrYear(parseInt(data.year, 10));
    if (ensured.state === "fetched" || ensured.state === "ready") {
      rank = await safeGetRank(data.issns, parseInt(data.year, 10));
      if (ensured.state === "fetched" && statusEl) {
        statusEl.textContent = `SJR ${data.year} saved${ensured.rows ? ", " + Number(ensured.rows).toLocaleString("en-US") + " rows" : ""}.`;
      }
    } else if (ensured.state === "not-released" || ensured.state === "blocked" || ensured.state === "challenge") {
      sjrNote = ensured.state === "not-released" ? "not-released" : "blocked";
      if (statusEl) {
        statusEl.textContent = ensured.state === "not-released"
          ? `No SJR data for ${data.year} yet.`
          : `SJR ${data.year} could not be downloaded automatically — tap Get free SJR data or Open SJR download page.`;
      }
      // Point the manual import at this year: set the SJR year
      // select to the article's year, so "Get free SJR data" and
      // "Import SJR file" below act on the year that is missing.
      if (sjrNote === "blocked" && sjrYearEl) {
        const hasOption = Array.from(sjrYearEl.options || []).some((o) => o.value === String(data.year));
        if (hasOption) sjrYearEl.value = String(data.year);
      }
    }
  }
  const rankForExport = rank || { source: "none", quartile: "", jif: null, wosCategory: "" };
  const rows = [
    ["Title", escapeHtml(data.title || "—")],
    ["Journal", escapeHtml(data.journal || "—")],
    ["ISSN", escapeHtml(data.issn || "—")],
    ["Year (publication year)", escapeHtml(data.year || "—")],
    ["Publisher", escapeHtml(data.publisher || "—")],
    ["Volume / issue / pages", escapeHtml(data.biblio || "—")],
    ["DOI", data.doi
      ? `<a href="https://doi.org/${encodeURIComponent(data.doi)}" target="_blank" rel="noopener">https://doi.org/${escapeHtml(data.doi)}</a>`
      : "—"],
  ];
  rankingRows(data, rank, sjrNote).forEach(([k, v]) => rows.push([k, v]));
  const sourceClass = sourceName === "OpenAlex" ? "source openalex" : "source";
  const rankBadge = rank && rank.source === "JCR"
    ? `<span class="source jcr">Ranking: JCR</span>`
    : rank && rank.source === "SJR"
      ? `<span class="source sjr">Ranking: SJR fallback — NOT JCR</span>`
      : `<span class="source none">Ranking: no JCR data for this year</span>`;
  resultEl.innerHTML =
    `<span class="${sourceClass}">Source: ${escapeHtml(sourceName)}</span> ` + rankBadge +
    "<dl>" + rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${v}</dd>`).join("") + "</dl>";
  resultEl.hidden = false;
  lastShown = { data, rank: rankForExport };
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
    chrome.storage.local.set({ lastLookup: { input: inputEl.value, data, sourceName, rank: rankForExport } });
  }
  // WoS category is free and needs no JCR: check it automatically
  // from the public Master Journal List (background worker). The
  // result row updates live when the answer comes back.
  updateWosCategory(data, rankForExport);
  return rankForExport;
}

// ---------- Free WoS category (no JCR, no login) ----------
// The background worker reads the public MJL search page for the
// article's ISSN and returns W (SCIE/SSCI/AHCI) or X (ESCI).
// Order: auto-fetch (yearly file, if it ever succeeds) first,
// then this per-article check, then manual import, then unknown.
function wosDdEl() {
  if (!resultEl) return null;
  const dts = resultEl.querySelectorAll("dt");
  for (const dt of dts) {
    if (dt.textContent === "WoS category") return dt.nextElementSibling;
  }
  return null;
}

function sendBackgroundMessage(message, timeoutMs) {
  return new Promise((resolve) => {
    if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) {
      resolve({ error: "no-background" });
      return;
    }
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve({ error: "timeout" }); } }, timeoutMs || 25000);
    try {
      chrome.runtime.sendMessage(message, (res) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(res || { error: "no-answer" });
      });
    } catch (err) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ error: "network", detail: String(err && err.message || err) });
    }
  });
}

async function fetchMjlCategory(issns) {
  // 90s: the rendered-tab fallback (background tab + Angular
  // render) can take ~30s per journal.
  return sendBackgroundMessage({ type: "fetchMjlCategory", issns: issns || [] }, 90000);
}

function wosCategoryText(category) {
  return category === "W" ? "W — SCIE, SSCI or AHCI"
    : category === "X" ? "X — ESCI (Emerging)" : "";
}

async function updateWosCategory(data, rank) {
  if (!data || !data.issns || !data.issns.length) return;
  if (rank && rank.wosCategory) return; // already known from JCR / MJL import
  const dd = wosDdEl();
  if (dd) dd.textContent = "Checking free WoS list…";
  const res = await fetchMjlCategory(data.issns);
  const ddNow = wosDdEl();
  if (res && res.category) {
    // Store it, so the next lookup for this journal is instant.
    try {
      const rows = data.issns.map((issn) => ({
        issn, journal: data.journal || "", year: null, quartile: "",
        jif: null, wosIndex: res.index || "", wosCategory: res.category,
        category: "", sourceFile: "Master Journal List (automatic)", editionYear: null,
      }));
      await getStore().putMjl(rows, { fileName: "Master Journal List (automatic)", rows: rows.length, importedAt: new Date().toISOString(), expires: DATA.mjlExpiresAt(new Date().toISOString()) });
    } catch (err) { /* storage failure: the displayed value still stands */ }
    if (ddNow) ddNow.textContent = wosCategoryText(res.category);
    if (lastShown && lastShown.data === data) lastShown.rank.wosCategory = res.category;
    refreshImportStatus();
    return;
  }
  if (ddNow) {
    ddNow.textContent = res && res.notIndexed
      ? "Not in the WoS list"
      : res && res.error === "blocked"
      ? "Unknown — WoS site blocked the check"
      : "Unknown — WoS list could not be read";
  }
}

function showError(message) {
  statusEl.textContent = message;
  statusEl.classList.add("error");
  resultEl.hidden = true;
  resultEl.innerHTML = "";
}

function setLoading(loading, message) {
  lookupBtn.disabled = loading;
  if (lookupManualBtn) lookupManualBtn.disabled = loading;
  lookupBtn.textContent = loading ? "Looking up…" : "Look up";
  lookupBtn.setAttribute("aria-busy", loading ? "true" : "false");
  statusEl.classList.toggle("loading", loading);
  if (loading && message) {
    statusEl.classList.remove("error");
    statusEl.textContent = message;
  }
}

async function fetchJson(url) {
  // Timeout + one retry live in net.js: a 429, a dropped
  // connection, an empty body, or a hung request is retried once
  // and then reported as a short error, never a blank result.
  if (NET) return NET.fetchJson(url);
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error("HTTP " + response.status);
  return response.json();
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// Fetch one article by DOI: Crossref first, OpenAlex fallback.
// Returns { data, sourceName } on success, or
// { notFound: true, reason } on failure — reason "no-record"
// when both APIs answered 404 (the DOI does not exist in
// either), "network" when the check itself could not complete
// (timeout / dropped connection / 5xx), so a failed check is
// never reported as a missing article. Results are cached, so
// looking up the same DOI twice does not re-fetch.
async function fetchArticleByDoi(doi) {
  const run = async () => {
    let saw404 = false, sawOther = false;
    try {
      const data = await fetchJson(
        `https://api.crossref.org/works/${encodeURIComponent(doi)}?mailto=${encodeURIComponent(MAILTO)}`
      );
      if (data && data.message) return { data: normaliseCrossref(data.message), sourceName: "Crossref" };
      saw404 = true; // 200 with no record: the DOI is not there
    } catch (err) { if (err && err.status === 404) saw404 = true; else sawOther = true; }
    try {
      const work = await fetchJson(
        `https://api.openalex.org/works/doi:${encodeURIComponent(doi)}?mailto=${encodeURIComponent(MAILTO)}`
      );
      if (work && work.display_name) return { data: normaliseOpenAlex(work), sourceName: "OpenAlex" };
      saw404 = true;
    } catch (err) { if (err && err.status === 404) saw404 = true; else sawOther = true; }
    return { notFound: true, reason: (!sawOther && saw404) ? "no-record" : "network" };
  };
  if (articleCache) return articleCache.getOrFetch("doi:" + doi.toLowerCase(), run);
  return run();
}

// How much of the wanted title appears in the candidate title
// (word overlap, ignoring short words). Guards the title search
// against returning a different article with a similar title.
function titleOverlap(wanted, candidate) {
  const words = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 3);
  const want = words(wanted);
  if (!want.length) return 0;
  const cand = new Set(words(candidate));
  const hits = want.filter((w) => cand.has(w)).length;
  return hits / want.length;
}

// Find an article by title (+ journal + year when known).
// Returns { data, sourceName, resolvedBy } on success, or
// { notFound: true, reason: "no-title-match", bestOverlap,
// bestTitle } on failure — bestOverlap is the highest word
// overlap any candidate reached (threshold 0.40), so the
// caller can say how close the search came instead of a bare
// "not found". Cached by title + journal + year, so batch rows
// for the same article share one search instead of re-fetching.
async function fetchArticleByTitle(title, journal, year) {
  const key = "title:" + String(title || "").toLowerCase() + "|" + String(journal || "").toLowerCase() + "|" + (year || "");
  const run = async () => {
  let bestOverlap = 0, bestTitle = "";
  const consider = (candidate) => {
    const overlap = titleOverlap(title, candidate);
    if (overlap > bestOverlap) { bestOverlap = overlap; bestTitle = candidate || ""; }
    return overlap;
  };
  // Crossref title search.
  try {
    const params = new URLSearchParams();
    params.set("query.bibliographic", title);
    if (journal) params.set("query.container-title", journal);
    if (year) params.set("filter", `from-pub-date:${year}-01-01,until-pub-date:${year}-12-31`);
    params.set("rows", "3");
    params.set("select", "DOI,title,container-title,ISSN,published-print,published-online,score");
    params.set("mailto", MAILTO);
    const data = await fetchJson(`https://api.crossref.org/works?${params.toString()}`);
    const items = (data && data.message && data.message.items) || [];
    for (const item of items) {
      const candidateTitle = (item.title && item.title[0]) || "";
      if (consider(candidateTitle) >= 0.4) {
        // Re-fetch the full record so the normaliser sees all fields.
        const full = await fetchArticleByDoi(item.DOI);
        if (full && full.data) { full.resolvedBy = "title search (Crossref)"; return full; }
        return { data: normaliseCrossref(item), sourceName: "Crossref", resolvedBy: "title search (Crossref)" };
      }
    }
  } catch (err) { /* fall through to OpenAlex */ }
  // OpenAlex title search.
  try {
    const params = new URLSearchParams();
    params.set("search", title);
    if (year) params.set("filter", `publication_year:${year}`);
    params.set("per-page", "3");
    params.set("mailto", MAILTO);
    const data = await fetchJson(`https://api.openalex.org/works?${params.toString()}`);
    const items = (data && data.results) || [];
    for (const item of items) {
      if (consider(item.display_name || item.title) >= 0.4) {
        return { data: normaliseOpenAlex(item), sourceName: "OpenAlex", resolvedBy: "title search (OpenAlex)" };
      }
    }
  } catch (err) { /* not found */ }
  return { notFound: true, reason: "no-title-match", bestOverlap, bestTitle: bestTitle ? bestTitle.slice(0, 60) : "" };
  };
  if (articleCache) return articleCache.getOrFetch(key, run);
  return run();
}

async function lookup(doi) {
  setLoading(true, `Looking up ${doi} …`);
  resultEl.hidden = true;
  try {
    const found = await fetchArticleByDoi(doi);
    if (found && found.data) {
      statusEl.textContent = "Found article. Checking ranking…";
      statusEl.classList.add("loading");
      await showResult(found.data, found.sourceName);
      statusEl.textContent = "";
      statusEl.classList.remove("loading");
      return;
    }
    if (found && found.reason === "network") {
      showError("Network error: could not reach Crossref or OpenAlex to check that DOI. Check your connection and try again.");
    } else {
      showError(`Not found: no record for ${doi} in Crossref or OpenAlex. Check the DOI and try again.`);
    }
  } catch (err) {
    showError("Network error: could not reach Crossref or OpenAlex. Check your connection and try again.");
  } finally {
    setLoading(false);
  }
}

async function onLookupClick() {
  const raw = (inputEl.value || "").trim();
  // One input for all three: a bare DOI, a doi.org link, or a
  // publisher article URL. The DOI logic itself lives in shared.js
  // and is unchanged; only the UI tabs were merged.
  const doi = extractDoi(raw);
  if (doi) {
    lookup(doi);
    return;
  }
  if (/^https?:\/\//i.test(raw)) {
    setLoading(true, "No DOI in the link — checking the article page …");
    try {
      const resolved = await resolveDoiFromUrl(raw);
      if (resolved.blocked) {
        setLoading(false);
        showError(
          `That publisher (${resolved.host || "this site"}) blocked the page read` +
          (resolved.status ? ` (HTTP ${resolved.status})` : "") +
          `. Open the article in a tab and tap “Check this page”, or copy the DOI from the page and paste it here.`
        );
        return;
      }
      if (!resolved.doi) {
        setLoading(false);
        showError("No DOI found on that page. Copy the DOI from the article page, or enter the details manually.");
        return;
      }
      inputEl.value = resolved.doi;
      await lookup(resolved.doi);
    } finally {
      setLoading(false);
    }
    return;
  }
  showError("No DOI found. Paste a DOI, a doi.org link, or a publisher article URL. Or enter the details manually.");
}

async function onLookupManualClick() {
  const title = (manualTitleEl.value || "").trim();
  const journal = (manualJournalEl.value || "").trim();
  const yearText = (manualYearEl.value || "").trim();
  const doi = extractDoi(manualDoiEl.value || "");
  const issn = DATA.normaliseIssn(manualIssnEl.value || "");
  const year = DATA.parseYear(yearText);
  if (doi) {
    inputEl.value = doi;
    await lookup(doi);
    return;
  }
  if (!title || !journal || !year) {
    showError("Enter the title, journal and year. All three are needed.");
    return;
  }
  setLoading(true, `Searching Crossref for “${title.slice(0, 60)}…” …`);
  resultEl.hidden = true;
  try {
    const found = await fetchArticleByTitle(title, journal, year);
    if (found && found.data) {
      statusEl.textContent = "Found article. Checking ranking…";
      const data = found.data;
      if (issn && (!data.issns || !data.issns.length)) {
        data.issns = [issn];
        data.issn = DATA.formatIssn(issn);
      }
      if (!data.year) data.year = String(year);
      await showResult(data, found.sourceName + (found.resolvedBy ? " — " + found.resolvedBy : ""));
      statusEl.textContent = "";
      statusEl.classList.remove("loading");
      return;
    }
    const best = (found && found.bestOverlap)
      ? ` (best match ${found.bestOverlap.toFixed(2)} word overlap, needs 0.40)`
      : " (no candidates returned)";
    showError(`Not found: no article matching that title in ${journal} (${year})${best}. Check the title, journal and year.`);
  } catch (err) {
    showError("Network error: could not reach Crossref or OpenAlex. Check your connection and try again.");
  } finally {
    setLoading(false);
  }
}

async function onCheckPageClick() {
  setLoading(true, "Reading this page …");
  try {
    if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) {
      showError("“Check this page” needs the extension running in Chrome. Paste the DOI or link above instead.");
      return;
    }
    const response = await new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; resolve(null); } }, 20000);
      chrome.runtime.sendMessage({ type: "checkThisPage" }, (res) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(res || null);
      });
    });
    if (!response) {
      showError("No answer from the extension. Reload the extension and try again.");
      return;
    }
    if (response.doi) {
      inputEl.value = response.doi;
      setMode("doi");
      await lookup(response.doi);
      return;
    }
    if (response.error === "no-article-tab") {
      showError("No article tab found. Open the article in a tab first, then tap “Check this page”.");
    } else if (response.error === "no-scripting") {
      showError("This browser does not support “Check this page”. Copy the DOI from the article page and paste it above.");
    } else if (response.error === "inject-shared-failed" || response.error === "inject-extract-failed" || response.error === "no-permission") {
      const detail = response.detail ? ` Chrome said: ${response.detail}` : "";
      showError(`Chrome could not read that tab${response.host ? ` (${response.host})` : ""}.${detail} Reload the article tab and try again. If it still fails, copy the DOI and paste it above.`);
    } else if (response.error) {
      const detail = response.detail ? ` Chrome said: ${response.detail}` : "";
      showError(`Could not read this page.${detail} Copy the DOI and paste it above.`);
    } else {
      showError(`No DOI found on this page${response.host ? ` (${response.host})` : ""}. Copy the DOI from the page and paste it above.`);
    }
  } finally {
    setLoading(false);
  }
}

lookupBtn.addEventListener("click", onLookupClick);
if (lookupManualBtn) lookupManualBtn.addEventListener("click", onLookupManualClick);
if (checkPageBtn) checkPageBtn.addEventListener("click", onCheckPageClick);
inputEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter") onLookupClick();
});

// ---------- "Open in a full tab" ----------
// BUG reported 27 Nov 2026: the button was still shown when the page
// was ALREADY open as a full tab, and clicking it opened ANOTHER new
// tab. Fix, two layers:
//  1. Hide the button in a full tab. Detection: the ?view=fulltab
//     marker in the URL (the button opens sidepanel.html?view=fulltab),
//     plus chrome.tabs.getCurrent as a backup — it returns the tab in
//     a full tab and undefined in the side panel, so a sidepanel.html
//     tab opened directly (no marker) is still caught.
//  2. The click handler itself refuses to open anything when the
//     page is already a full tab, so even a stray click can never
//     open a second tab.
// The button opens exactly ONE tab, via chrome.tabs.create (the
// "tabs" permission is in the manifest); window.open is only the
// fallback when chrome.tabs is unavailable.
function hideOpenTabButtonIfFullTab() {
  if (!openTabBtn) return;
  if (isFullTabUrl(window.location.href)) {
    openTabBtn.hidden = true;
    return;
  }
  if (typeof chrome !== "undefined" && chrome.tabs && chrome.tabs.getCurrent) {
    try {
      chrome.tabs.getCurrent((tab) => {
        if (tab && tab.id !== undefined) openTabBtn.hidden = true;
      });
    } catch (err) { /* side panel: leave the button visible */ }
  }
}
hideOpenTabButtonIfFullTab();

if (openTabBtn) {
  openTabBtn.addEventListener("click", () => {
    if (isFullTabUrl(window.location.href)) return; // already a full tab: do nothing
    const base = (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL)
      ? chrome.runtime.getURL("sidepanel.html")
      : "sidepanel.html";
    const url = buildFullTabUrl(base);
    if (typeof chrome !== "undefined" && chrome.tabs && chrome.tabs.create) {
      chrome.tabs.create({ url });
    } else {
      window.open(url, "_blank");
    }
  });
}

// Restore the last lookup when the panel / tab is reopened.
if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
  chrome.storage.local.get("lastLookup", (result) => {
    const last = result && result.lastLookup;
    if (!last || !last.data) return;
    if (last.input) inputEl.value = last.input;
    // Restore only: do not re-fetch SJR data on panel reopen.
    showResult(last.data, last.sourceName || "Crossref", { autoFetchSjr: false });
  });
}

// ---------- File reading: CSV / XLSX / old .xls ----------
// What each upload button takes. The picker's accept attribute
// limits the choice, but "All files" can bypass it, so the code
// checks the extension too (isAllowedFileType in shared.js) and
// rejects anything else with a short plain error.
const ARTICLE_FILE_TYPES = [".csv", ".xlsx", ".xls"]; // article list
const JCR_FILE_TYPES = [".csv", ".xlsx", ".xls"];     // JCR import
const SJR_FILE_TYPES = [".csv"];                      // SJR import
const MJL_FILE_TYPES = [".csv", ".xlsx", ".xls"];     // WoS list import

// "" when the file type is fine, else a short plain error.
function wrongTypeMessage(file, allowed, what) {
  if (!file || isAllowedFileType(file.name, allowed)) return "";
  const list = allowed.length === 1 ? allowed[0]
    : allowed.slice(0, -1).join(", ") + " or " + allowed[allowed.length - 1];
  return `Use a ${list} file for ${what}.`;
}

async function readSpreadsheetFile(file) {
  const name = (file.name || "").toLowerCase();
  if (name.endsWith(".csv")) {
    return await file.text();
  }
  if (name.endsWith(".xlsx")) {
    if (!XLSX) throw new Error("The .xlsx reader did not load. Save the file as .csv in Excel instead.");
    const rows = await XLSX.readXlsx(await file.arrayBuffer());
    return XLSX.rowsToCsvText(rows);
  }
  if (name.endsWith(".xls")) {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    // A real .xlsx renamed to .xls is a ZIP ("PK").
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
      if (!XLSX) throw new Error("The .xlsx reader did not load. Save the file as .csv in Excel instead.");
      const rows = await XLSX.readXlsx(buf);
      return XLSX.rowsToCsvText(rows);
    }
    const text = new TextDecoder("utf-8").decode(bytes);
    if (XLSX) {
      const rows = XLSX.spreadsheetHtmlToRows(text);
      if (rows) return XLSX.rowsToCsvText(rows);
    }
    throw new Error("This .xls file is an old binary Excel file, which the extension cannot read. In Excel, save it as .xlsx or .csv and import that instead.");
  }
  throw new Error("Unsupported file type — use a .csv, .xlsx or .xls file.");
}

function fileNameOf(input) {
  const files = input && input.files;
  return files && files.length ? Array.from(files).map((f) => f.name).join(", ") : "";
}

// ---------- JCR / SJR / MJL import ----------
function latestFile(files) {
  return files && files.length ? files[files.length - 1] : null;
}

function refreshImportStatus() {
  getStore().getMeta().then((meta) => {
    const jcrFile = latestFile(meta.jcrFiles);
    const jcrImportedAt = (jcrFile && jcrFile.importedAt) || meta.importedAt;
    const expiry = DATA.nextJcrExpiry(jcrImportedAt || undefined);
    if (meta.jcrRows) {
      const editions = meta.jcrFiles.map((f) => `${f.fileName} (${f.editionYear || "year not set"}, ${f.rows} rows)`).join("; ");
      const jcrLeft = jcrImportedAt ? DATA.monthsLeftText(DATA.sjrExpiresAt(jcrImportedAt)) : "";
      jcrStatusEl.textContent = `JCR data: ${meta.jcrRows} rows. ${editions}. Uploaded ${jcrImportedAt ? new Date(jcrImportedAt).toLocaleDateString() : "—"}. Valid until the next JCR release (${expiry}${jcrLeft ? ", " + jcrLeft : ""}).`;
      jcrStatusEl.classList.remove("error");
    } else {
      jcrStatusEl.textContent = "No JCR data imported yet.";
    }
    const sjrFile = latestFile(meta.sjrFiles);
    if (meta.sjrRows && sjrFile && sjrFile.importedAt) {
      sjrStatusEl.textContent = `SJR data: ${meta.sjrRows} rows (fallback only, never shown as JCR). ${DATA.validUntilText(sjrFile.importedAt, "sjr")}.`;
    } else if (meta.sjrRows) {
      sjrStatusEl.textContent = `SJR data: ${meta.sjrRows} rows (fallback only, never shown as JCR).`;
    } else {
      sjrStatusEl.textContent = "No SJR data imported yet.";
    }
    const mjlFile = latestFile(meta.mjlFiles);
    if (meta.mjlRows && mjlFile && mjlFile.importedAt) {
      mjlStatusEl.textContent = `WoS list: ${meta.mjlRows} journals stored. ${DATA.validUntilText(mjlFile.importedAt, "mjl")}.`;
    } else if (meta.mjlRows) {
      mjlStatusEl.textContent = `WoS list: ${meta.mjlRows} journals stored.`;
    } else {
      mjlStatusEl.textContent = "No WoS list imported yet.";
    }
    renderFreeDataStatus(meta);
  }).catch(() => { /* status stays as the default text */ });
}

// Short status lines for the free data: what worked, which path,
// and how long it lasts. One line per source.
function renderFreeDataStatus(meta) {
  if (!freeDataStatusEl) return;
  const setLines = (auto) => {
    const sjrFile = latestFile(meta.sjrFiles);
    const mjlFile = latestFile(meta.mjlFiles);
    let sjrLine, mjlLine;
    if (meta.sjrRows && sjrFile && sjrFile.importedAt) {
      const year = DATA.sjrFileYear(sjrFile);
      sjrLine = `SJR: ready${year ? ", " + year : ""}. ${DATA.validUntilText(sjrFile.importedAt, "sjr")}.`;
    } else if (auto && auto.sjr && auto.sjr.state === "blocked") {
      sjrLine = "SJR: auto-fetch blocked (bot check). Tap Get free SJR data.";
    } else if (auto && auto.sjr && auto.sjr.state === "failed") {
      sjrLine = "SJR: auto-fetch failed. Tap Get free SJR data.";
    } else {
      sjrLine = "SJR: checking…";
    }
    if (meta.mjlRows && mjlFile && mjlFile.importedAt) {
      mjlLine = `WoS list: ready. ${DATA.validUntilText(mjlFile.importedAt, "mjl")}.`;
    } else if (auto && auto.mjl && auto.mjl.state === "login") {
      mjlLine = "WoS list: file needs MJL login. Category checked per article (free).";
    } else if (auto && auto.mjl && auto.mjl.state === "failed") {
      mjlLine = "WoS list: auto-fetch failed. Category checked per article (free).";
    } else {
      mjlLine = "WoS list: checking…";
    }
    freeDataStatusEl.innerHTML = escapeHtml(mjlLine) + "<br>" + escapeHtml(sjrLine);
  };
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get("autoFreeData", (r) => setLines(r && r.autoFreeData));
  } else {
    setLines(null);
  }
}

jcrFileEl.addEventListener("change", () => {
  jcrFileNameEl.textContent = fileNameOf(jcrFileEl) || "No file chosen.";
  const bad = Array.from(jcrFileEl.files || []).find((f) => wrongTypeMessage(f, JCR_FILE_TYPES, "the JCR import"));
  if (bad) {
    jcrStatusEl.textContent = wrongTypeMessage(bad, JCR_FILE_TYPES, "the JCR import");
    jcrStatusEl.classList.add("error");
    jcrImportBtn.disabled = true;
    return;
  }
  jcrStatusEl.classList.remove("error");
  jcrImportBtn.disabled = !jcrFileEl.files.length;
});
sjrFileEl.addEventListener("change", () => {
  sjrFileNameEl.textContent = fileNameOf(sjrFileEl) || "No file chosen.";
  const bad = Array.from(sjrFileEl.files || []).find((f) => wrongTypeMessage(f, SJR_FILE_TYPES, "the SJR import"));
  if (bad) {
    sjrStatusEl.textContent = wrongTypeMessage(bad, SJR_FILE_TYPES, "the SJR import");
    sjrStatusEl.classList.add("error");
    sjrImportBtn.disabled = true;
    return;
  }
  sjrStatusEl.classList.remove("error");
  sjrImportBtn.disabled = !sjrFileEl.files.length;
});
mjlFileEl.addEventListener("change", () => {
  mjlFileNameEl.textContent = fileNameOf(mjlFileEl) || "No file chosen.";
  const bad = Array.from(mjlFileEl.files || []).find((f) => wrongTypeMessage(f, MJL_FILE_TYPES, "the WoS list import"));
  if (bad) {
    mjlStatusEl.textContent = wrongTypeMessage(bad, MJL_FILE_TYPES, "the WoS list import");
    mjlStatusEl.classList.add("error");
    mjlImportBtn.disabled = true;
    return;
  }
  mjlStatusEl.classList.remove("error");
  mjlImportBtn.disabled = !mjlFileEl.files.length;
});

jcrImportBtn.addEventListener("click", async () => {
  const files = Array.from(jcrFileEl.files || []);
  if (!files.length) return;
  const editionYear = parseInt(jcrYearEl.value, 10);
  jcrImportBtn.disabled = true;
  jcrStatusEl.textContent = `Importing ${files.length} JCR file(s) for data year ${editionYear}…`;
  let total = 0, skipped = 0;
  const warnings = [];
  try {
    for (const file of files) {
      const text = await readSpreadsheetFile(file);
      const parsed = DATA.parseJcrText(text, { editionYear, fileName: file.name });
      if (parsed.rows.length) {
        const importedAt = new Date().toISOString();
        await getStore().putJcr(parsed.rows, { fileName: file.name, editionYear, rows: parsed.rows.length, importedAt, expires: DATA.sjrExpiresAt(importedAt) });
        total += parsed.rows.length;
      }
      skipped += parsed.skipped;
      parsed.warnings.forEach((w) => warnings.push(`${file.name}: ${w}`));
    }
    jcrStatusEl.textContent = total
      ? `Imported ${total} rows for data year ${editionYear} (${skipped} skipped). ${warnings.length ? "Warnings: " + warnings.join(" ") : ""} Check the numbers against the JCR export. This importer has not yet been tested against a real JCR file.`
      : `Nothing imported, no usable rows found. ${warnings.join(" ")} Check the file is a JCR export with ISSN, quartile and Impact Factor columns.`;
    if (!total) jcrStatusEl.classList.add("error"); else jcrStatusEl.classList.remove("error");
  } catch (err) {
    jcrStatusEl.textContent = `Import failed: ${err.message}`;
    jcrStatusEl.classList.add("error");
  } finally {
    jcrImportBtn.disabled = false;
    refreshImportStatus();
  }
});

sjrImportBtn.addEventListener("click", async () => {
  const files = Array.from(sjrFileEl.files || []);
  if (!files.length) return;
  sjrImportBtn.disabled = true;
  const bad = files.find((f) => wrongTypeMessage(f, SJR_FILE_TYPES, "the SJR import"));
  if (bad) {
    sjrStatusEl.textContent = wrongTypeMessage(bad, SJR_FILE_TYPES, "the SJR import");
    sjrStatusEl.classList.add("error");
    sjrImportBtn.disabled = false;
    return;
  }
  sjrStatusEl.textContent = "Importing SJR file…";
  try {
    let total = 0, skipped = 0;
    const warnings = [];
    for (const file of files) {
      const text = await file.text();
      // Year from the file name when the file itself has none
      // (the real SCImago export has no Year column — the year
      // is in the headers or the file name, e.g. scimagojr_2025).
      const parsed = DATA.parseSjrText(text, { fileName: file.name, year: DATA.parseYear(file.name) });
      if (parsed.rows.length) {
        const importedAt = new Date().toISOString();
        // The year this file covers (most common row year) and its
        // expiry (next June release): stored until expiry, reused
        // for every lookup until then, like the auto-fetch path.
        const yearCounts = {};
        parsed.rows.forEach((r) => { if (r.year) yearCounts[r.year] = (yearCounts[r.year] || 0) + 1; });
        const topYear = Object.keys(yearCounts).sort((a, b) => yearCounts[b] - yearCounts[a])[0];
        await getStore().putSjr(parsed.rows, { fileName: file.name, year: topYear ? parseInt(topYear, 10) : null, rows: parsed.rows.length, importedAt, expires: DATA.sjrExpiresAt(importedAt) });
        total += parsed.rows.length;
      }
      skipped += parsed.skipped;
      parsed.warnings.forEach((w) => warnings.push(`${file.name}: ${w}`));
    }
    sjrStatusEl.textContent = total
      ? `Imported ${total} SJR rows (${skipped} skipped). Fallback only, always labelled NOT JCR. ${warnings.join(" ")}`
      : `Nothing imported — ${skipped} row(s) read but skipped. ${warnings.join(" ")} Check the file is an SJR CSV with ISSN and SJR Best Quartile columns.`;
    if (!total) sjrStatusEl.classList.add("error"); else sjrStatusEl.classList.remove("error");
  } catch (err) {
    sjrStatusEl.textContent = `Import failed: ${err.message}`;
    sjrStatusEl.classList.add("error");
  } finally {
    sjrImportBtn.disabled = false;
    refreshImportStatus();
  }
});

mjlImportBtn.addEventListener("click", async () => {
  const files = Array.from(mjlFileEl.files || []);
  if (!files.length) return;
  mjlImportBtn.disabled = true;
  mjlStatusEl.textContent = "Importing WoS journal list…";
  try {
    let total = 0, skipped = 0;
    const warnings = [];
    for (const file of files) {
      const text = await readSpreadsheetFile(file);
      const parsed = DATA.parseMJLText(text, { fileName: file.name });
      if (parsed.rows.length) {
        const importedAt = new Date().toISOString();
        await getStore().putMjl(parsed.rows, { fileName: file.name, rows: parsed.rows.length, importedAt, expires: DATA.mjlExpiresAt(importedAt) });
        total += parsed.rows.length;
      }
      skipped += parsed.skipped;
      parsed.warnings.forEach((w) => warnings.push(`${file.name}: ${w}`));
    }
    mjlStatusEl.textContent = total
      ? `Imported ${total} journals. W = SCIE/SSCI/AHCI, X = ESCI (Emerging). ${warnings.join(" ")}`
      : `Nothing imported. ${warnings.join(" ")} Check the file is a Master Journal List export with an index column (SCIE / SSCI / AHCI / ESCI).`;
    if (!total) mjlStatusEl.classList.add("error"); else mjlStatusEl.classList.remove("error");
  } catch (err) {
    mjlStatusEl.textContent = `Import failed: ${err.message}`;
    mjlStatusEl.classList.add("error");
  } finally {
    mjlImportBtn.disabled = false;
    refreshImportStatus();
  }
});

// ---------- Auto-fetch free data (on by default) ----------
// First run, and once a year after, the background worker fetches
// the free SJR CSV and the WoS list itself and stores them until
// they expire. No user action, no server. Turning it off stops
// future fetches; already stored data stays until expiry.
function loadAutoFetchToggle() {
  if (!autoFetchToggleEl) return;
  if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return;
  chrome.storage.local.get(["autoFetchFreeData", "autoFreeData", "autoFetchFreeDataLastRun"], (r) => {
    autoFetchToggleEl.checked = !r || r.autoFetchFreeData === undefined ? true : !!r.autoFetchFreeData;
    // First run: nothing fetched yet — trigger it now so the
    // status lines fill in without waiting for a worker wake.
    if (autoFetchToggleEl.checked && r && !r.autoFreeData && !r.autoFetchFreeDataLastRun) {
      sendBackgroundMessage({ type: "autoFetchFreeData" }, 120000).then(() => refreshImportStatus());
    }
  });
}
if (autoFetchToggleEl) {
  autoFetchToggleEl.addEventListener("change", () => {
    const enabled = autoFetchToggleEl.checked;
    if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return;
    chrome.storage.local.set({ autoFetchFreeData: enabled }, () => {
      if (enabled) {
        if (freeDataStatusEl) freeDataStatusEl.innerHTML = "WoS list: checking…<br>SJR: checking…";
        sendBackgroundMessage({ type: "autoFetchFreeData" }, 120000).then(() => refreshImportStatus());
      }
      refreshImportStatus();
    });
  });
  loadAutoFetchToggle();
}

// "Get free SJR data": auto-fetch first (background fetch), then
// one-click download in the user's browser (imported
// automatically), then manual import as last resort. Data from
// any path is stored until expiry and reused for every lookup —
// never used once and discarded. Re-fetch happens only after
// expiry.
if (sjrFetchBtn) {
  sjrFetchBtn.addEventListener("click", async () => {
    const year = parseInt(sjrYearEl.value, 10) || new Date().getFullYear() - 1;
    sjrFetchBtn.disabled = true;
    try {
      const meta = await getStore().getMeta();
      // Already stored for the chosen year (any file, not just the
      // latest)? Then there is nothing to fetch for that year.
      if (DATA.sjrFilesCoverYear(meta, year)) {
        const file = meta.sjrFiles.find((f) => DATA.sjrFileYear(f) === year);
        sjrStatusEl.textContent = `SJR ${year} data already stored. ${DATA.validUntilText(file.importedAt, "sjr")}.`;
        sjrStatusEl.classList.remove("error");
        return;
      }
    } catch (err) { /* fall through and try the fetch */ }
    try {
      sjrStatusEl.textContent = `Getting free SJR data for ${year}…`;
      let res = await sendBackgroundMessage({ type: "fetchSjrExport", year }, 90000);
      if (res && res.rows) {
        sjrStatusEl.textContent = `SJR data: ${res.rows} rows for ${year}, saved. ${DATA.validUntilText(new Date().toISOString(), "sjr")}.`;
        sjrStatusEl.classList.remove("error");
        refreshImportStatus();
        return;
      }
      if (res && (res.error === "blocked" || res.error === "not-csv" || res.error === "failed" || res.error === "timeout")) {
        sjrStatusEl.textContent = "Direct download blocked. Trying the download in your browser…";
        res = await sendBackgroundMessage({ type: "fetchSjrViaTab", year }, 120000);
        if (res && res.rows) {
          sjrStatusEl.textContent = `SJR data: ${res.rows} rows for ${year}, saved from the browser download. ${DATA.validUntilText(new Date().toISOString(), "sjr")}.`;
          sjrStatusEl.classList.remove("error");
          refreshImportStatus();
          return;
        }
      }
      // Every failure now names its real reason and the one
      // working next step: open the SJR download page, download
      // the CSV for this year, then use Import SJR file below.
      // "challenge" = the human check never cleared in the tab;
      // anything else = the CSV fetch itself was still blocked.
      sjrStatusEl.textContent = res && res.error === "challenge"
        ? `SJR asked for a human check that did not clear. Tap “Open SJR download page”, download the CSV for ${year}, then use Import SJR file below.`
        : `SJR blocked the download (bot check). Tap “Open SJR download page”, download the CSV for ${year}, then use Import SJR file below.`;
      sjrStatusEl.classList.add("error");
      refreshImportStatus();
    } finally {
      sjrFetchBtn.disabled = false;
    }
  });
}

// "Open SJR download page": the one-click manual fallback when
// the automatic fetch is blocked. Opens the SJR journal ranking
// page for the chosen year in a VISIBLE tab, so the user can
// pass the human check themselves and download the CSV, then
// import it with "Choose SJR file" + "Import SJR file" below.
if (sjrOpenPageBtn) {
  sjrOpenPageBtn.addEventListener("click", () => {
    const year = parseInt(sjrYearEl.value, 10) || new Date().getFullYear() - 1;
    const url = `https://www.scimagojr.com/journalrank.php?year=${year}`;
    if (typeof chrome !== "undefined" && chrome.tabs && chrome.tabs.create) {
      chrome.tabs.create({ url, active: true });
    } else {
      window.open(url, "_blank");
    }
    sjrStatusEl.textContent = `Opened the SJR download page for ${year}. Download the CSV, then use Import SJR file below.`;
    sjrStatusEl.classList.remove("error");
  });
}

// "Get WoS category (free)": re-check the category for the
// article shown above, from the free public MJL search. The
// answer is stored, so the next lookup for the journal is instant.
if (mjlFetchBtn) {
  mjlFetchBtn.addEventListener("click", async () => {
    if (!lastShown || !lastShown.data || !lastShown.data.issns || !lastShown.data.issns.length) {
      mjlStatusEl.textContent = "Look up an article first, then tap this button.";
      return;
    }
    mjlStatusEl.textContent = "Checking the free WoS list…";
    await updateWosCategory(lastShown.data, lastShown.rank);
    mjlStatusEl.textContent = "WoS category checked for the article above.";
    refreshImportStatus();
  });
}

clearDataBtn.addEventListener("click", async () => {
  if (!window.confirm("Clear all imported data? This deletes every imported JCR, SJR and WoS row from the extension.")) return;
  try {
    await getStore().clear();
    refreshImportStatus();
    jcrStatusEl.textContent = "No JCR data imported yet.";
    sjrStatusEl.textContent = "No SJR data imported yet.";
    mjlStatusEl.textContent = "No WoS list imported yet.";
  } catch (err) {
    jcrStatusEl.textContent = `Could not clear the data: ${err.message}`;
  }
});

// ---------- Batch: upload a list of articles ----------
let batchResults = [];
let batchFileRows = null;

batchFileEl.addEventListener("change", async () => {
  const file = batchFileEl.files && batchFileEl.files[0];
  batchFileNameEl.textContent = file ? file.name : "No file chosen.";
  batchRunBtn.disabled = !file;
  batchFileRows = null;
  if (!file) return;
  const typeError = wrongTypeMessage(file, ARTICLE_FILE_TYPES, "the article list");
  if (typeError) {
    batchStatusEl.textContent = typeError;
    batchStatusEl.classList.add("error");
    batchRunBtn.disabled = true;
    return;
  }
  try {
    const text = await readSpreadsheetFile(file);
    const parsed = DATA.parseArticleListText(text);
    batchFileRows = parsed.rows;
    batchStatusEl.textContent = parsed.rows.length
      ? `${parsed.rows.length} article(s) in ${file.name}. Press “Upload and check all articles”.`
      : `No articles found in ${file.name}. ${parsed.warnings.join(" ")} Check the columns: title, journal, year, DOI.`;
    batchStatusEl.classList.toggle("error", !parsed.rows.length);
  } catch (err) {
    batchStatusEl.textContent = `Could not read ${file.name}: ${err.message}`;
    batchStatusEl.classList.add("error");
  }
});

function batchRowToResult(row, found, rank, note, sjrState) {
  const data = found ? found.data : null;
  return {
    title: (data && data.title) || row.title || "",
    journal: (data && data.journal) || row.journal || "",
    year: (data && data.year) || (row.year ? String(row.year) : ""),
    issn: (data && data.issn) || (row.issn ? DATA.formatIssn(row.issn) : ""),
    issns: (data && data.issns) || (row.issn ? [row.issn] : []),
    doi: (data && data.doi) || row.doi || "",
    rank: rank || { source: "none", quartile: "", jif: null, wosCategory: "" },
    note: note || "",
    // Row outcome for the CSV "Status / note" column and the
    // finished summary: "found", "duplicate" (same DOI as an
    // earlier row), or "not-found" with notFoundKind naming why
    // ("no-title-match" / "no-doi-record" / "no-doi-or-title" /
    // "network"). No skipped row is left unexplained.
    status: found ? "found" : "not-found",
    notFoundKind: "",
    // How this row's SJR year was obtained ("ready" = already
    // stored, "fetched" = fresh download, "blocked" etc.) — the
    // SJR cell says so instead of going blank.
    sjrState: sjrState || "",
  };
}

// No per-row table in the panel (user, 27 Nov 2026: the long
// table just makes scrolling too much). Batch results live only
// in the downloaded CSV — see DATA.resultsToCsv.

// Live SJR status line under the batch status: one short outcome
// per distinct year, so the user can see the auto-fetch working
// (or blocked) instead of watching SJR tabs open and close.
function updateBatchSjrStatus(outcomes) {
  if (!batchSjrStatusEl) return;
  const lines = [...outcomes.entries()].sort((a, b) => a[0] - b[0])
    .map(([year, o]) => DATA.sjrOutcomeText(o.state, year, o.rows)).filter(Boolean);
  batchSjrStatusEl.textContent = lines.length ? "SJR: " + lines.join("; ") + "." : "";
}

async function runBatch(rows) {
  batchResults = [];
  // No per-row table in the panel: during a batch the panel shows
  // only the status line and progress bar. The results section
  // (download button) stays hidden until the whole file finishes.
  batchResultsEl.hidden = true;
  batchProgressEl.hidden = false;
  // The download button must not be there until the whole file
  // finishes: hiding it here also hides the previous batch's
  // button when a new batch starts.
  batchDownloadBtn.hidden = true;
  if (batchMjlBtn) batchMjlBtn.hidden = true;
  if (batchSjrStatusEl) batchSjrStatusEl.textContent = "";
  batchRunBtn.disabled = true;
  batchTestsetBtn.disabled = true;
  let resolvedDoi = 0, found = 0;
  const seenDois = new Map(); // DOI -> first row number (Scholar lists some works twice)
  const sjrYearsFetched = new Set(); // publication years whose SJR data was fetched during this run
  const sjrYearOutcomes = new Map(); // year -> ensureSjrYear outcome (one attempt per distinct year)
  let finished = false;
  try {
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    batchStatusEl.textContent = `Checking article ${i + 1} of ${rows.length}: ${row.title.slice(0, 60)}…`;
    batchProgressBarEl.style.width = Math.round((i / rows.length) * 100) + "%";
    let result;
    try {
      let article = null;
      let notFoundReason = null; // { kind, detail } — every
      // skipped row keeps its real reason, through to the CSV.
      if (row.doi) {
        const byDoi = await fetchArticleByDoi(row.doi);
        if (byDoi && byDoi.data) { article = byDoi; resolvedDoi++; }
        else if (byDoi && byDoi.notFound) {
          notFoundReason = byDoi.reason === "no-record"
            ? { kind: "no-doi-record", detail: "no record for this DOI in Crossref or OpenAlex" }
            : { kind: "network", detail: "could not reach Crossref or OpenAlex to check this DOI" };
        }
      }
      if (!article && row.title) {
        const byTitle = await fetchArticleByTitle(row.title, row.journal, row.year);
        if (byTitle && byTitle.data) { article = byTitle; resolvedDoi++; }
        else if (byTitle && byTitle.notFound) {
          // Scholar list titles are sometimes truncated on the
          // profile page — a truncated title can never match, so
          // say so instead of a bare "not found".
          const truncated = /[…\u2026]$|\.\.\.$/.test(String(row.title || "").trim());
          notFoundReason = {
            kind: "no-title-match",
            detail: "no title match" + (byTitle.bestOverlap
              ? " (best " + byTitle.bestOverlap.toFixed(2) + " overlap, needs 0.40)"
              : " (no candidates returned)") + (truncated ? " — title looks truncated, try the full title" : ""),
          };
        }
      }
      if (!article && !row.doi && !row.title) {
        notFoundReason = { kind: "no-doi-or-title", detail: "row has no DOI and no title to search" };
      }
      if (article) {
        found++;
        const issns = (article.data.issns && article.data.issns.length)
          ? article.data.issns
          : (row.issn ? [row.issn] : []);
        const year = article.data.year ? parseInt(article.data.year, 10) : (row.year || null);
        let rank = (issns.length && year) ? await safeGetRank(issns, year) : null;
        let sjrState = "";
        if (rank && rank.source === "SJR") sjrState = "ready";
        else if (rank && rank.source === "JCR") sjrState = "jcr";
        // No SJR row for this row's publication year? Fetch that
        // year now — the year comes from the article, never from
        // the user. ensureSjrYear fetches each distinct year once
        // per run and skips years already stored; a year already
        // tried in this run (e.g. blocked) is NOT tried again,
        // so a blocked year does not open one SJR tab per article.
        if (rank && rank.source === "none" && year) {
          let ensured;
          if (sjrYearOutcomes.has(year)) {
            ensured = sjrYearOutcomes.get(year);
          } else {
            batchStatusEl.textContent = `Checking article ${i + 1} of ${rows.length}: getting SJR data for ${year}…`;
            ensured = await ensureSjrYear(year);
            sjrYearOutcomes.set(year, ensured);
            updateBatchSjrStatus(sjrYearOutcomes);
          }
          sjrState = ensured.state;
          if (ensured.state === "fetched") {
            sjrYearsFetched.add(year);
            rank = await safeGetRank(issns, year);
          }
        }
        let note = article.resolvedBy || "Found by DOI";
        const doiKey = (article.data.doi || "").toLowerCase();
        let isDuplicate = false;
        if (doiKey) {
          if (seenDois.has(doiKey)) {
            isDuplicate = true;
            note = (note ? note + ". " : "") + `Same article as row ${seenDois.get(doiKey)} (same DOI) — Scholar lists it twice`;
          } else {
            seenDois.set(doiKey, i + 1);
          }
        }
        result = batchRowToResult(row, article, rank, note, sjrState);
        if (isDuplicate) result.status = "duplicate";
      } else {
        result = batchRowToResult(row, null, null, "Not found — " + (notFoundReason ? notFoundReason.detail : "no record in Crossref or OpenAlex"));
        result.notFoundKind = notFoundReason ? notFoundReason.kind : "no-title-match";
      }
    } catch (err) {
      result = batchRowToResult(row, null, null, "Network error: " + String(err.message || err));
      result.notFoundKind = "network";
    }
    batchResults.push(result);
    // No table row: the panel just counts — "12 of 65 articles
    // done" — and the per-row results live only in the CSV.
    batchStatusEl.textContent = `${i + 1} of ${rows.length} articles done`;
    await sleep(500); // polite pacing for the Crossref polite pool
  }
    finished = true;
  } finally {
    batchRunBtn.disabled = false;
    batchTestsetBtn.disabled = false;
  }
  if (!finished) {
    // The loop stopped early (unexpected error outside a row):
    // results are incomplete, so the download stays hidden.
    batchStatusEl.textContent = "Batch stopped early — results are incomplete, download is hidden.";
    return;
  }
  // Only now, with every row done, is the download shown.
  batchResultsEl.hidden = false;
  batchDownloadBtn.hidden = false;
  if (batchMjlBtn) batchMjlBtn.hidden = false;
  batchProgressBarEl.style.width = "100%";
  updateBatchSjrStatus(sjrYearOutcomes);
  // The summary adds up: found rows split into JCR / SJR /
  // found-but-no-ranking, then every not-found row broken down
  // by its real reason, then duplicates named separately.
  const foundRows = batchResults.filter((r) => r.status === "found" || r.status === "duplicate");
  const jcrCount = foundRows.filter((r) => r.rank && r.rank.source === "JCR").length;
  const sjrCount = foundRows.filter((r) => r.rank && r.rank.source === "SJR").length;
  const noRankCount = foundRows.length - jcrCount - sjrCount;
  const notFoundText = DATA.notFoundBreakdown(batchResults);
  const dupCount = batchResults.filter((r) => r.status === "duplicate").length;
  batchStatusEl.textContent = `Done: ${rows.length} articles. ${foundRows.length} found (${jcrCount} JCR, ${sjrCount} SJR fallback, ${noRankCount} found but no ranking data)${notFoundText ? ", " + notFoundText : ""}.${dupCount ? ` ${dupCount} duplicate row${dupCount === 1 ? "" : "s"} of earlier rows.` : ""}${sjrYearsFetched.size ? ` SJR data fetched for ${[...sjrYearsFetched].sort().join(", ")}.` : ""}`;
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
    chrome.storage.local.set({ lastBatch: batchResults });
  }
}

batchRunBtn.addEventListener("click", async () => {
  if (!batchFileRows || !batchFileRows.length) {
    batchStatusEl.textContent = "Choose an Excel or CSV file first.";
    return;
  }
  await runBatch(batchFileRows);
});

batchTestsetBtn.addEventListener("click", async () => {
  batchStatusEl.textContent = "Loading the Naqqash test set (67 articles)…";
  try {
    const url = (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL)
      ? chrome.runtime.getURL("test-set.csv")
      : "test-set.csv";
    const text = await (await fetch(url)).text();
    const parsed = DATA.parseArticleListText(text);
    // Dedupe the Scholar duplicates (same title twice): keep first.
    const seen = new Set();
    const unique = parsed.rows.filter((r) => {
      const key = r.title.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    batchStatusEl.textContent = `Naqqash test set loaded: ${parsed.rows.length} rows, ${unique.length} unique by title. Running now.`;
    batchFileRows = unique;
    await runBatch(unique);
  } catch (err) {
    batchStatusEl.textContent = `Could not load the built-in test set: ${err.message}`;
    batchStatusEl.classList.add("error");
  }
});

batchDownloadBtn.addEventListener("click", () => {
  if (!batchResults.length) return;
  const csv = DATA.resultsToCsv(batchResults);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "journal-quartile-results.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

// "Get WoS categories (free)": check the category for every
// batch row that has an ISSN and no category yet, from the free
// public MJL search. Answers are stored until expiry, so the
// next batch for the same journals is instant.
if (batchMjlBtn) {
  batchMjlBtn.addEventListener("click", async () => {
    if (!batchResults.length) return;
    batchMjlBtn.disabled = true;
    let checked = 0, found = 0;
    try {
      for (let i = 0; i < batchResults.length; i++) {
        const r = batchResults[i];
        if (!r.issns || !r.issns.length || (r.rank && r.rank.wosCategory)) continue;
        const res = await fetchMjlCategory(r.issns);
        checked++;
        if (res && res.category) {
          found++;
          r.rank = r.rank || { source: "none", quartile: "", jif: null, wosCategory: "" };
          r.rank.wosCategory = res.category;
          try {
            const importedAt = new Date().toISOString();
            const rows = r.issns.map((issn) => ({
              issn, journal: r.journal || "", year: null, quartile: "",
              jif: null, wosIndex: res.index || "", wosCategory: res.category,
              category: "", sourceFile: "Master Journal List (automatic)", editionYear: null,
            }));
            await getStore().putMjl(rows, { fileName: "Master Journal List (automatic)", rows: rows.length, importedAt, expires: DATA.mjlExpiresAt(importedAt) });
          } catch (err) { /* the displayed value still stands */ }
          // No panel table any more: the enriched category lives
          // in the downloaded CSV, not in a row on screen.
        }
        await sleep(300); // polite pacing for the MJL search
      }
      batchStatusEl.textContent = `WoS categories: ${found} found of ${checked} checked.`;
    } finally {
      batchMjlBtn.disabled = false;
      refreshImportStatus();
    }
  });
}

// Show the current import status when the panel opens.
refreshImportStatus();
