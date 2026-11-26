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

// ---------- Element handles ----------
const inputEl = document.getElementById("input");
const inputLinkEl = document.getElementById("input-link");
const lookupBtn = document.getElementById("lookup");
const lookupLinkBtn = document.getElementById("lookup-link");
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
const batchProgressEl = document.getElementById("batch-progress");
const batchProgressBarEl = document.getElementById("batch-progress-bar");
const batchResultsEl = document.getElementById("batch-results");
const batchTbodyEl = document.getElementById("batch-tbody");
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

// ---------- Ranking store (IndexedDB, memory fallback) ----------
let store = null;
function getStore() {
  if (store) return store;
  try {
    store = new DATA.IdbStore();
  } catch (err) {
    store = new DATA.MemoryStore();
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
    try { return await store.getRank(issns, year); } catch (e) { return null; }
  }
}

// ---------- Mode tabs ----------
const MODES = ["doi", "link", "manual"];
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
    const response = await fetch(url, { headers: { Accept: "text/html" } });
    if (response.ok) {
      const doi = parseDoiFromHtml(await response.text());
      if (doi) return { doi, blocked: false };
    } else if (response.status === 403 || response.status === 429) {
      return { doi: null, blocked: true, host, status: response.status };
    }
  } catch (err) { /* ignore */ }
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
function rankingRows(data, rank) {
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
  } else {
    rows.push(["JCR quartile (" + year + ")", "No JCR data for this year"]);
    rows.push(["Impact Factor — JCR (" + year + ")", "No JCR data for this year"]);
  }
  rows.push(["WoS category", wos ? wos + (wos === "W" ? " — SCIE, SSCI or AHCI" : " — ESCI (Emerging)") : "Unknown — needs WoS / JCR data"]);
  if (rank && rank.source !== "none" && rank.sourceFile) {
    rows.push(["Ranking data from", escapeHtml(rank.sourceFile)]);
  }
  return rows;
}

async function showResult(data, sourceName) {
  const rank = (data.issns && data.issns.length && data.year)
    ? await safeGetRank(data.issns, parseInt(data.year, 10))
    : null;
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
  rankingRows(data, rank).forEach(([k, v]) => rows.push([k, v]));
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
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
    chrome.storage.local.set({ lastLookup: { input: inputEl.value, data, sourceName, rank: rankForExport } });
  }
  return rankForExport;
}

function showError(message) {
  statusEl.textContent = message;
  statusEl.classList.add("error");
  resultEl.hidden = true;
  resultEl.innerHTML = "";
}

function setLoading(loading, message) {
  lookupBtn.disabled = loading;
  if (lookupLinkBtn) lookupLinkBtn.disabled = loading;
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
  // One retry after a short pause: Crossref occasionally drops a
  // request (empty response) on the anonymous tier; the polite
  // pool (mailto=) plus a retry keeps a batch from losing rows.
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(url, { headers: { Accept: "application/json" } });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      return await response.json();
    } catch (err) {
      lastError = err;
      // 429 / dropped connection: wait longer before the one retry.
      if (attempt === 0) await sleep(err && err.status === 429 ? 2000 : 1200);
    }
  }
  throw lastError;
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// Fetch one article by DOI: Crossref first, OpenAlex fallback.
// Returns { data, sourceName } or null when not found.
async function fetchArticleByDoi(doi) {
  try {
    const data = await fetchJson(
      `https://api.crossref.org/works/${encodeURIComponent(doi)}?mailto=${encodeURIComponent(MAILTO)}`
    );
    if (data && data.message) return { data: normaliseCrossref(data.message), sourceName: "Crossref" };
  } catch (err) { /* fall through to OpenAlex */ }
  try {
    const work = await fetchJson(
      `https://api.openalex.org/works/doi:${encodeURIComponent(doi)}?mailto=${encodeURIComponent(MAILTO)}`
    );
    if (work && work.display_name) return { data: normaliseOpenAlex(work), sourceName: "OpenAlex" };
  } catch (err) { /* not found */ }
  return null;
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
// Returns { data, sourceName, resolvedBy } or null.
async function fetchArticleByTitle(title, journal, year) {
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
      if (titleOverlap(title, candidateTitle) >= 0.4) {
        // Re-fetch the full record so the normaliser sees all fields.
        const full = await fetchArticleByDoi(item.DOI);
        if (full) { full.resolvedBy = "title search (Crossref)"; return full; }
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
      if (titleOverlap(title, item.display_name || item.title) >= 0.4) {
        return { data: normaliseOpenAlex(item), sourceName: "OpenAlex", resolvedBy: "title search (OpenAlex)" };
      }
    }
  } catch (err) { /* not found */ }
  return null;
}

async function lookup(doi) {
  setLoading(true, `Looking up ${doi} …`);
  resultEl.hidden = true;
  try {
    const found = await fetchArticleByDoi(doi);
    if (found) {
      statusEl.textContent = "";
      statusEl.classList.remove("loading");
      await showResult(found.data, found.sourceName);
      return;
    }
    showError(`Not found: no record for ${doi} in Crossref or OpenAlex. Check the DOI and try again.`);
  } catch (err) {
    showError("Network error: could not reach Crossref or OpenAlex. Check your connection and try again.");
  } finally {
    setLoading(false);
  }
}

async function onLookupClick() {
  let doi = extractDoi(inputEl.value);
  if (!doi) {
    showError("No DOI found. Paste a DOI like 10.1038/nature14539 — or switch to “Lookup by article link” for a publisher URL, or “Enter details manually” for an article with no DOI.");
    return;
  }
  lookup(doi);
}

async function onLookupLinkClick() {
  const raw = (inputLinkEl.value || "").trim();
  if (!/^https?:\/\//i.test(raw)) {
    showError("Paste a full article link, starting with https:// — for example a nature.com or ScienceDirect article link.");
    return;
  }
  setLoading(true, "No DOI in the link — checking the article page …");
  try {
    const resolved = await resolveDoiFromUrl(raw);
    if (resolved.blocked) {
      setLoading(false);
      showError(
        `That publisher (${resolved.host || "this site"}) blocked the automatic page read` +
        (resolved.status ? ` (HTTP ${resolved.status}, bot check)` : " (bot check)") +
        `. The DOI could not be read from the page. If the article is open in a tab, tap “Check this page — read the DOI from the open article tab” — it reads the DOI from the open page instead. Otherwise, open the article in Chrome and copy the DOI from the page itself, then paste the DOI here.`
      );
      return;
    }
    if (!resolved.doi) {
      setLoading(false);
      showError("No DOI found on that page. Copy the DOI from the article page and use “Lookup by DOI”, or enter the details manually.");
      return;
    }
    inputEl.value = resolved.doi;
    await lookup(resolved.doi);
  } finally {
    setLoading(false);
  }
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
    showError("Enter the article title, the journal name and the year published — all three are needed to search without a DOI.");
    return;
  }
  setLoading(true, `Searching Crossref for “${title.slice(0, 60)}…” …`);
  resultEl.hidden = true;
  try {
    const found = await fetchArticleByTitle(title, journal, year);
    if (found) {
      statusEl.textContent = "";
      statusEl.classList.remove("loading");
      const data = found.data;
      if (issn && (!data.issns || !data.issns.length)) {
        data.issns = [issn];
        data.issn = DATA.formatIssn(issn);
      }
      if (!data.year) data.year = String(year);
      await showResult(data, found.sourceName + (found.resolvedBy ? " — " + found.resolvedBy : ""));
      return;
    }
    showError(`Not found: no article matching that title in ${journal} (${year}) in Crossref or OpenAlex. Check the spelling of the title and journal, and the year.`);
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
      showError("“Check this page” needs the extension running in Chrome — paste the DOI or link above instead.");
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
      showError("No answer from the extension background — reload the extension and try again.");
      return;
    }
    if (response.doi) {
      inputEl.value = response.doi;
      setMode("doi");
      await lookup(response.doi);
      return;
    }
    if (response.error === "no-article-tab") {
      showError("No article tab found. Open the article in a Chrome tab first, then tap “Check this page”.");
    } else if (response.error === "no-scripting") {
      showError("This browser doesn't support the script injection “Check this page” needs. Copy the DOI from the article page and paste it above.");
    } else if (response.error === "inject-shared-failed" || response.error === "inject-extract-failed" || response.error === "no-permission") {
      const detail = response.detail ? ` Chrome said: ${response.detail}` : "";
      showError(`Chrome couldn't read that tab${response.host ? ` (${response.host})` : ""}.${detail} Try reloading the article tab, then click the extension icon while you're on that tab and tap “Check this page” again. If it still fails, copy the DOI from the page and paste it above.`);
    } else if (response.error) {
      const detail = response.detail ? ` Chrome said: ${response.detail}` : "";
      showError(`Couldn't read this page.${detail} Copy the DOI from the article page and paste it above.`);
    } else {
      showError(`No DOI found on this page${response.host ? ` (${response.host})` : ""}. It may not be an article page, or it may not carry a DOI tag. Copy the DOI from the page and paste it above.`);
    }
  } finally {
    setLoading(false);
  }
}

lookupBtn.addEventListener("click", onLookupClick);
if (lookupLinkBtn) lookupLinkBtn.addEventListener("click", onLookupLinkClick);
if (lookupManualBtn) lookupManualBtn.addEventListener("click", onLookupManualClick);
if (checkPageBtn) checkPageBtn.addEventListener("click", onCheckPageClick);
inputEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter") onLookupClick();
});
if (inputLinkEl) inputLinkEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter") onLookupLinkClick();
});

if (openTabBtn) {
  openTabBtn.addEventListener("click", () => {
    const url = (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL)
      ? chrome.runtime.getURL("sidepanel.html")
      : "sidepanel.html";
    window.open(url, "_blank");
  });
}

// Restore the last lookup when the panel / tab is reopened.
if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
  chrome.storage.local.get("lastLookup", (result) => {
    const last = result && result.lastLookup;
    if (!last || !last.data) return;
    if (last.input) inputEl.value = last.input;
    showResult(last.data, last.sourceName || "Crossref");
  });
}

// ---------- File reading: CSV / XLSX / old .xls ----------
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
  throw new Error("Unsupported file type — use a .csv or .xlsx file.");
}

function fileNameOf(input) {
  const files = input && input.files;
  return files && files.length ? Array.from(files).map((f) => f.name).join(", ") : "";
}

// ---------- JCR / SJR / MJL import ----------
function refreshImportStatus() {
  getStore().getMeta().then((meta) => {
    const expiry = DATA.nextJcrExpiry(meta.importedAt || undefined);
    if (meta.jcrRows) {
      const editions = meta.jcrFiles.map((f) => `${f.fileName} (${f.editionYear || "year not set"}, ${f.rows} rows)`).join("; ");
      jcrStatusEl.textContent = `JCR data: ${meta.jcrRows} journal-year rows stored. Files: ${editions}. Uploaded ${meta.importedAt ? new Date(meta.importedAt).toLocaleDateString() : "—"}. Current until the next JCR release (about ${expiry}) — re-import after that.`;
      jcrStatusEl.classList.remove("error");
    } else {
      jcrStatusEl.textContent = "JCR data: nothing imported yet — no quartile or Impact Factor can be shown until you import a file.";
    }
    if (meta.sjrRows) {
      sjrStatusEl.textContent = `SJR data: ${meta.sjrRows} journal-year rows stored (fallback only — never shown as JCR). Files: ${meta.sjrFiles.map((f) => f.fileName).join(", ")}.`;
    } else {
      sjrStatusEl.textContent = "SJR data: nothing imported yet.";
    }
    if (meta.mjlRows) {
      mjlStatusEl.textContent = `WoS journal list: ${meta.mjlRows} journals stored (for category W / X). Files: ${meta.mjlFiles.map((f) => f.fileName).join(", ")}.`;
    } else {
      mjlStatusEl.textContent = "WoS journal list: nothing imported yet.";
    }
  }).catch(() => { /* status stays as the default text */ });
}

jcrFileEl.addEventListener("change", () => {
  jcrFileNameEl.textContent = fileNameOf(jcrFileEl) || "No file chosen yet.";
  jcrImportBtn.disabled = !jcrFileEl.files.length;
});
sjrFileEl.addEventListener("change", () => {
  sjrFileNameEl.textContent = fileNameOf(sjrFileEl) || "No file chosen yet.";
  sjrImportBtn.disabled = !sjrFileEl.files.length;
});
mjlFileEl.addEventListener("change", () => {
  mjlFileNameEl.textContent = fileNameOf(mjlFileEl) || "No file chosen yet.";
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
        await getStore().putJcr(parsed.rows, { fileName: file.name, editionYear, rows: parsed.rows.length, importedAt: new Date().toISOString() });
        total += parsed.rows.length;
      }
      skipped += parsed.skipped;
      parsed.warnings.forEach((w) => warnings.push(`${file.name}: ${w}`));
    }
    jcrStatusEl.textContent = total
      ? `Imported ${total} journal-year rows from ${files.length} file(s) for data year ${editionYear} (${skipped} rows skipped). ${warnings.length ? "Warnings: " + warnings.join(" ") : ""} Check the numbers against the JCR export before relying on them — this importer has not yet been tested against a real JCR file.`
      : `Nothing imported — no usable rows found. ${warnings.join(" ")} Check that the file is a JCR export (CSV or Excel) with ISSN, quartile and Impact Factor columns.`;
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
  sjrStatusEl.textContent = "Importing SJR file…";
  try {
    let total = 0, skipped = 0;
    const warnings = [];
    for (const file of files) {
      const text = await file.text();
      const parsed = DATA.parseSjrText(text, { fileName: file.name });
      if (parsed.rows.length) {
        await getStore().putSjr(parsed.rows, { fileName: file.name, rows: parsed.rows.length, importedAt: new Date().toISOString() });
        total += parsed.rows.length;
      }
      skipped += parsed.skipped;
      parsed.warnings.forEach((w) => warnings.push(`${file.name}: ${w}`));
    }
    sjrStatusEl.textContent = total
      ? `Imported ${total} SJR journal-year rows (${skipped} skipped). These are fallback only — every SJR value is labelled “SJR quartile — fallback, NOT JCR”. ${warnings.join(" ")}`
      : `Nothing imported. ${warnings.join(" ")} Check that the file is an SJR CSV from scimagojr.com with ISSN and SJR Best Quartile columns.`;
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
        await getStore().putMjl(parsed.rows, { fileName: file.name, rows: parsed.rows.length, importedAt: new Date().toISOString() });
        total += parsed.rows.length;
      }
      skipped += parsed.skipped;
      parsed.warnings.forEach((w) => warnings.push(`${file.name}: ${w}`));
    }
    mjlStatusEl.textContent = total
      ? `Imported ${total} journals from the WoS journal list (${skipped} skipped). Category W = SCIE/SSCI/AHCI, X = ESCI (Emerging). ${warnings.join(" ")}`
      : `Nothing imported. ${warnings.join(" ")} Check that the file is a Master Journal List export with an index column (SCIE / SSCI / AHCI / ESCI).`;
    if (!total) mjlStatusEl.classList.add("error"); else mjlStatusEl.classList.remove("error");
  } catch (err) {
    mjlStatusEl.textContent = `Import failed: ${err.message}`;
    mjlStatusEl.classList.add("error");
  } finally {
    mjlImportBtn.disabled = false;
    refreshImportStatus();
  }
});

clearDataBtn.addEventListener("click", async () => {
  if (!window.confirm("Clear all imported data? This deletes every imported JCR, SJR and WoS journal-list row from the extension. The files on your computer are not affected.")) return;
  try {
    await getStore().clear();
    refreshImportStatus();
    jcrStatusEl.textContent = "JCR data: nothing imported yet — no quartile or Impact Factor can be shown until you import a file.";
    sjrStatusEl.textContent = "SJR data: nothing imported yet.";
    mjlStatusEl.textContent = "WoS journal list: nothing imported yet.";
  } catch (err) {
    jcrStatusEl.textContent = `Could not clear the data: ${err.message}`;
  }
});

// ---------- Batch: upload a list of articles ----------
let batchResults = [];
let batchFileRows = null;

batchFileEl.addEventListener("change", async () => {
  const file = batchFileEl.files && batchFileEl.files[0];
  batchFileNameEl.textContent = file ? file.name : "No file chosen yet.";
  batchRunBtn.disabled = !file;
  batchFileRows = null;
  if (!file) return;
  try {
    const text = await readSpreadsheetFile(file);
    const parsed = DATA.parseArticleListText(text);
    batchFileRows = parsed.rows;
    batchStatusEl.textContent = parsed.rows.length
      ? `${parsed.rows.length} article(s) found in ${file.name}. Press “Upload and check all articles” to look them all up.`
      : `No articles found in ${file.name}. ${parsed.warnings.join(" ")} Check the columns: title, journal, year, DOI if known.`;
    batchStatusEl.classList.toggle("error", !parsed.rows.length);
  } catch (err) {
    batchStatusEl.textContent = `Could not read ${file.name}: ${err.message}`;
    batchStatusEl.classList.add("error");
  }
});

function batchRowToResult(row, found, rank, note) {
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
  };
}

function renderBatchRow(result) {
  const tr = document.createElement("tr");
  const rank = result.rank || {};
  const cells = [
    result.title, result.journal, result.year,
    rank.source === "JCR" ? (rank.quartile || "—") : (rank.source === "SJR" ? "— (see SJR)" : "No JCR data"),
    rank.source === "JCR" ? ((rank.jif === null || rank.jif === undefined) ? "—" : String(rank.jif)) : "No JCR data",
    rank.wosCategory || "Unknown",
    rank.source === "JCR" ? "JCR" : rank.source === "SJR" ? `SJR fallback — NOT JCR (${rank.quartile || ""})` : (result.note || "Not found"),
  ];
  cells.forEach((text) => {
    const td = document.createElement("td");
    td.textContent = text;
    tr.appendChild(td);
  });
  return tr;
}

async function runBatch(rows) {
  batchResults = [];
  batchTbodyEl.innerHTML = "";
  batchResultsEl.hidden = false;
  batchProgressEl.hidden = false;
  batchRunBtn.disabled = true;
  batchTestsetBtn.disabled = true;
  let resolvedDoi = 0, found = 0;
  const seenDois = new Map(); // DOI -> first row number (Scholar lists some works twice)
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    batchStatusEl.textContent = `Checking article ${i + 1} of ${rows.length}: ${row.title.slice(0, 60)}…`;
    batchProgressBarEl.style.width = Math.round((i / rows.length) * 100) + "%";
    let result;
    try {
      let article = null;
      if (row.doi) {
        article = await fetchArticleByDoi(row.doi);
        if (article) resolvedDoi++;
      }
      if (!article && row.title) {
        article = await fetchArticleByTitle(row.title, row.journal, row.year);
        if (article) { resolvedDoi++; }
      }
      if (article) {
        found++;
        const issns = (article.data.issns && article.data.issns.length)
          ? article.data.issns
          : (row.issn ? [row.issn] : []);
        const year = article.data.year ? parseInt(article.data.year, 10) : (row.year || null);
        const rank = (issns.length && year) ? await safeGetRank(issns, year) : null;
        let note = article.resolvedBy || "";
        const doiKey = (article.data.doi || "").toLowerCase();
        if (doiKey) {
          if (seenDois.has(doiKey)) {
            note = (note ? note + ". " : "") + `Same article as row ${seenDois.get(doiKey)} (same DOI) — Scholar lists it twice`;
          } else {
            seenDois.set(doiKey, i + 1);
          }
        }
        result = batchRowToResult(row, article, rank, note);
      } else {
        result = batchRowToResult(row, null, null, "Article not found in Crossref or OpenAlex");
      }
    } catch (err) {
      result = batchRowToResult(row, null, null, "Network error: " + String(err.message || err));
    }
    batchResults.push(result);
    batchTbodyEl.appendChild(renderBatchRow(result));
    await sleep(500); // polite pacing for the Crossref polite pool
  }
  batchProgressBarEl.style.width = "100%";
  batchStatusEl.textContent = `Done: ${rows.length} article(s) checked, ${found} found in Crossref/OpenAlex, ${resolvedDoi} with a DOI. ${batchResults.filter((r) => r.rank && r.rank.source === "JCR").length} have JCR data, ${batchResults.filter((r) => r.rank && r.rank.source === "SJR").length} have only the SJR fallback, ${batchResults.filter((r) => !r.rank || r.rank.source === "none").length} have no ranking data yet. Press “Download results as CSV” to save them.`;
  batchRunBtn.disabled = false;
  batchTestsetBtn.disabled = false;
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
    batchStatusEl.textContent = `Naqqash test set loaded: ${parsed.rows.length} rows, ${unique.length} unique by title after removing Scholar duplicates (2 more are the same work with truncated titles — they collapse to the same DOI once checked). Running now.`;
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

// Show the current import status when the panel opens.
refreshImportStatus();
