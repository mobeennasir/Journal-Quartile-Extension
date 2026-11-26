// Phase 2: background service worker.
// Two jobs:
//  1. Fetch an article page and extract its DOI from the page
//     metadata (generic path, any publisher — see shared.js).
//     A service-worker fetch with host_permissions is CORS-exempt,
//     so this works for publisher pages where a popup fetch would
//     be blocked by CORS. No data is stored; the DOI is returned
//     to the lookup page and the page HTML is discarded.
//  2. Open the side panel when the extension icon is clicked
//     (the side panel, unlike a popup, stays open when you click
//     elsewhere in the browser).

importScripts("shared.js");
importScripts("freedata.js");
importScripts("jcr.js");
importScripts("xlsx.js");

// ---------- Free data, fetched automatically (no JCR) ----------
// "Auto-fetch free data" (on by default): on first run, and once
// a year after, the worker fetches the two free files from their
// official URLs — the SJR CSV and the WoS Master Journal List
// file — parses them and saves them in IndexedDB. No user action,
// no server. Status is kept in chrome.storage.local under
// "autoFreeData" so the panel can show it ("WoS list: ready,
// 2026" / "SJR: ready, 2025").
//
// Honest limits, found 27 Nov 2026:
//   * SJR blocks automated downloads with a Cloudflare
//     human-verification page from datacenter IPs. It may work
//     from a real browser, or it may not — a block is reported
//     plainly and the one-click download / manual import remain.
//   * The MJL file download needs a free MJL login (and the full
//     list is subscriber-only, per Clarivate), so the file fetch
//     normally fails at the login wall. When it does, the WoS
//     category is still checked automatically per article from
//     the PUBLIC MJL search page (no login), which is what
//     fetchMjlCategory below does. No values are ever invented.
const FREE = (typeof JournalQuartileFreeData !== "undefined") ? JournalQuartileFreeData : null;
const FDATA = (typeof JournalQuartileData !== "undefined") ? JournalQuartileData : null;
const FXLSX = (typeof JournalQuartileXlsx !== "undefined") ? JournalQuartileXlsx : null;
const AUTO_FETCH_INTERVAL_MS = 335 * 24 * 60 * 60 * 1000; // ~11 months

function fetchTextTimeout(url, timeoutMs, accept) {
  const controller = (typeof AbortController !== "undefined") ? new AbortController() : null;
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      if (controller) controller.abort();
      reject(new Error("Request timed out"));
    }, timeoutMs || 30000);
  });
  const run = fetch(url, {
    headers: { Accept: accept || "text/html, text/csv, */*" },
    signal: controller ? controller.signal : undefined,
  }).then(async (response) => ({ status: response.status, ok: response.ok, text: await response.text() }));
  return Promise.race([run, timeoutPromise]).finally(() => { if (timer) clearTimeout(timer); });
}

function fetchBinaryTimeout(url, timeoutMs) {
  const controller = (typeof AbortController !== "undefined") ? new AbortController() : null;
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      if (controller) controller.abort();
      reject(new Error("Request timed out"));
    }, timeoutMs || 60000);
  });
  const run = fetch(url, { signal: controller ? controller.signal : undefined })
    .then(async (response) => ({ status: response.status, ok: response.ok, buf: await response.arrayBuffer() }));
  return Promise.race([run, timeoutPromise]).finally(() => { if (timer) clearTimeout(timer); });
}

function autoStatusGet() {
  return new Promise((resolve) => {
    if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) { resolve({}); return; }
    chrome.storage.local.get(["autoFreeData", "autoFetchFreeData", "autoFetchFreeDataLastRun"], (r) => {
      resolve({
        status: (r && r.autoFreeData) || {},
        enabled: !r || r.autoFetchFreeData === undefined ? true : !!r.autoFetchFreeData,
        lastRun: (r && r.autoFetchFreeDataLastRun) || null,
      });
    });
  });
}

function autoStatusSave(patch) {
  return autoStatusGet().then((cur) => {
    const status = Object.assign({}, cur.status, patch.status || {});
    const save = { autoFreeData: status };
    if (patch.lastRun) save.autoFetchFreeDataLastRun = patch.lastRun;
    if (patch.enabled !== undefined) save.autoFetchFreeData = patch.enabled;
    return new Promise((resolve) => {
      if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) { resolve(status); return; }
      chrome.storage.local.set(save, () => resolve(status));
    });
  });
}

// SJR CSV for one year: try out=csv, then export=csv.
async function fetchSjrYear(year) {
  const urls = [FREE.sjrExportUrl(year), FREE.sjrExportUrlAlt(year)];
  let lastBlocked = false;
  for (const url of urls) {
    let res;
    try {
      res = await fetchTextTimeout(url, 60000, "text/csv, */*");
    } catch (err) {
      continue; // network/timeout: try the alternate spelling
    }
    if (FREE.looksBlocked(res.text, res.status)) { lastBlocked = true; continue; }
    if (!res.ok) continue;
    if (FREE.isSjrCsv(res.text)) return { text: res.text, url };
    // Got a page, not a CSV — the alternate spelling is the only
    // other try; a second non-CSV answer means the format moved.
    lastBlocked = false;
  }
  return { error: lastBlocked ? "blocked" : "not-csv" };
}

async function importSjrText(text, year) {
  const parsed = FDATA.parseSjrText(text, { fileName: "SJR " + year + " (auto-fetch)", year });
  if (!parsed.rows.length) return { rows: 0, skipped: parsed.skipped, warnings: parsed.warnings };
  const store = new FDATA.IdbStore();
  const importedAt = new Date().toISOString();
  // Stored until expiry (next June release), like every other
  // import path — reused for every lookup until then, re-fetched
  // only after expiry.
  await store.putSjr(parsed.rows, { fileName: "SJR " + year + " (auto-fetch)", year, rows: parsed.rows.length, importedAt, expires: FDATA.sjrExpiresAt(importedAt) });
  return { rows: parsed.rows.length, skipped: parsed.skipped, warnings: parsed.warnings };
}

// MJL file: fetch the Collection List Downloads page, take the
// collection .xlsx links, download and store them. Normally the
// page is login-walled (no links) — that is reported, not hidden.
async function fetchMjlFile() {
  let page;
  try {
    page = await fetchTextTimeout(FREE.mjlDownloadsPage, 20000, "text/html, */*");
  } catch (err) {
    return { error: "network", detail: String(err && err.message || err) };
  }
  if (FREE.looksBlocked(page.text, page.status) || FREE.isMjlLoginWall(page.text)) {
    return { error: "login", detail: "MJL file needs a free MJL login" };
  }
  const links = FREE.findMjlDownloadLinks(page.text);
  if (!links.length) {
    return { error: "login", detail: "MJL file needs a free MJL login" };
  }
  const store = new FDATA.IdbStore();
  let total = 0;
  const used = [];
  for (const link of links.slice(0, 4)) {
    const indexCode = FREE.mjlCollectionIndex(link.label);
    if (!indexCode) continue;
    let file;
    try {
      file = await fetchBinaryTimeout(link.url, 60000);
    } catch (err) {
      continue;
    }
    if (!file.ok) continue;
    let rows;
    try {
      rows = await FXLSX.readXlsx(file.buf);
    } catch (err) {
      continue;
    }
    // MJL xlsx columns: Journal Title, ISSN, eISSN, publisher...
    // No index column in the file — the collection IS the index.
    const csv = FXLSX.rowsToCsvText(rows);
    const table = FDATA.parseCsv(csv);
    if (!table.length) continue;
    let headerIdx = -1;
    for (let i = 0; i < Math.min(table.length, 5); i++) {
      const norm = table[i].map((h) => String(h || "").trim().toLowerCase().replace(/[^a-z0-9]/g, ""));
      if (norm.indexOf("issn") !== -1) { headerIdx = i; break; }
    }
    if (headerIdx === -1) continue;
    const headers = table[headerIdx];
    const colIssn = headers.findIndex((h) => String(h || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "") === "issn");
    const colEissn = headers.findIndex((h) => String(h || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "") === "eissn");
    const colTitle = headers.findIndex((h) => /journal|title/.test(String(h || "").toLowerCase()));
    const mjlRows = [];
    const category = indexCode === "ESCI" ? "X" : "W";
    for (let r = headerIdx + 1; r < table.length; r++) {
      const row = table[r];
      if (!row) continue;
      const issns = [];
      [colIssn, colEissn].forEach((c) => {
        if (c >= 0) FDATA.parseIssnList(String(row[c] || "")).forEach((x) => { if (issns.indexOf(x) === -1) issns.push(x); });
      });
      const journal = colTitle >= 0 ? String(row[colTitle] || "").trim() : "";
      if (!issns.length && !journal) continue;
      (issns.length ? issns : [""]).forEach((issn) => {
        mjlRows.push({ issn, journal, year: null, quartile: "", jif: null, wosIndex: indexCode, wosCategory: category, category: "", sourceFile: "MJL " + indexCode + " (auto-fetch)", editionYear: null });
      });
    }
    if (mjlRows.length) {
      const importedAt = new Date().toISOString();
      await store.putMjl(mjlRows, { fileName: "MJL " + indexCode + " (auto-fetch)", rows: mjlRows.length, importedAt, expires: FDATA.mjlExpiresAt(importedAt) });
      total += mjlRows.length;
      used.push(indexCode);
    }
  }
  if (!total) return { error: "login", detail: "MJL file needs a free MJL login" };
  return { rows: total, collections: used };
}

// Run the automatic free-data fetch (SJR + MJL file). One source
// failing never blocks the other. Returns the status object.
// Latest stored file of one kind, or null.
function latestFileMeta(files) {
  if (!files || !files.length) return null;
  return files[files.length - 1];
}

// Is stored free data of one kind still valid (downloaded and
// not yet expired)? Used so a re-fetch only happens after expiry.
function storedFreeDataValid(meta, kind) {
  if (!meta) return false;
  const files = kind === "sjr" ? meta.sjrFiles : meta.mjlFiles;
  const latest = latestFileMeta(files);
  if (!latest || !latest.importedAt) return false;
  return !FDATA.isExpired(latest.importedAt, kind);
}

async function autoFetchFreeData() {
  const now = new Date().toISOString();
  const status = {};
  let meta = null;
  try {
    meta = await new FDATA.IdbStore().getMeta();
  } catch (err) { meta = null; }
  // SJR first. Still-valid stored data is reused, not re-fetched.
  const sjrYear = FREE.sjrLatestYear();
  const sjrStored = storedFreeDataValid(meta, "sjr");
  if (sjrStored) {
    const latest = latestFileMeta(meta.sjrFiles);
    status.sjr = { state: "ready", year: latest.year || sjrYear, rows: meta.sjrRows, at: latest.importedAt, detail: "already stored" };
  }
  if (!sjrStored) {
  try {
    const fetched = await fetchSjrYear(sjrYear);
    if (fetched.error) {
      status.sjr = fetched.error === "blocked"
        ? { state: "blocked", year: sjrYear, at: now, detail: "SJR blocked the download (bot check)" }
        : { state: "failed", year: sjrYear, at: now, detail: "SJR did not return a CSV file" };
    } else {
      const done = await importSjrText(fetched.text, sjrYear);
      status.sjr = done.rows
        ? { state: "ready", year: sjrYear, rows: done.rows, at: now }
        : { state: "failed", year: sjrYear, at: now, detail: "SJR file had no usable rows" };
    }
  } catch (err) {
    status.sjr = { state: "failed", year: sjrYear, at: now, detail: String(err && err.message || err) };
  }
  }
  // MJL file second. Still-valid stored data is reused, not re-fetched.
  const mjlStored = storedFreeDataValid(meta, "mjl");
  if (mjlStored) {
    const latest = latestFileMeta(meta.mjlFiles);
    status.mjl = { state: "ready", year: new Date(latest.importedAt).getFullYear(), rows: meta.mjlRows, at: latest.importedAt, source: "file", detail: "already stored" };
  }
  if (!mjlStored) {
  try {
    const mjl = await fetchMjlFile();
    if (mjl.error) {
      status.mjl = { state: "login", source: "per-article", at: now, detail: mjl.detail || "MJL file needs a free MJL login" };
    } else {
      status.mjl = { state: "ready", year: new Date().getFullYear(), rows: mjl.rows, collections: mjl.collections, at: now, source: "file" };
    }
  } catch (err) {
    status.mjl = { state: "failed", source: "per-article", at: now, detail: String(err && err.message || err) };
  }
  }
  await autoStatusSave({ status, lastRun: now });
  return status;
}

async function maybeAutoFetch() {
  try {
    const cur = await autoStatusGet();
    if (!cur.enabled) return;
    let due = true;
    if (cur.lastRun) {
      const age = Date.now() - new Date(cur.lastRun).getTime();
      due = age >= AUTO_FETCH_INTERVAL_MS;
    }
    if (!due) {
      // Re-fetch early only when stored free data has expired.
      // "No data at all" does not count as expired — a blocked
      // SJR or a login-walled MJL file must not re-run on every
      // worker wake; the user can tap the button instead.
      try {
        const meta = await new FDATA.IdbStore().getMeta();
        const sjrFile = latestFileMeta(meta.sjrFiles);
        const mjlFile = latestFileMeta(meta.mjlFiles);
        const sjrExpired = sjrFile && sjrFile.importedAt && FDATA.isExpired(sjrFile.importedAt, "sjr");
        const mjlExpired = mjlFile && mjlFile.importedAt && FDATA.isExpired(mjlFile.importedAt, "mjl");
        due = !!(sjrExpired || mjlExpired);
      } catch (err) { due = false; }
    }
    if (!due) return;
    await autoFetchFreeData();
  } catch (err) { /* auto-fetch must never break the worker */ }
}

// WoS category for one article, from the PUBLIC MJL search page
// (no login): try each ISSN in turn. Returns { category, index,
// issn } or { error, notIndexed }.
async function fetchMjlCategory(issns) {
  const list = (issns || []).filter(Boolean);
  let sawUnreadable = false;
  for (const issn of list) {
    let res;
    try {
      res = await fetchTextTimeout(FREE.mjlSearchUrl(issn), 20000, "text/html, */*");
    } catch (err) {
      continue;
    }
    if (FREE.looksBlocked(res.text, res.status)) { sawUnreadable = true; continue; }
    if (!res.ok) continue;
    const parsed = FREE.parseMjlSearchHtml(res.text);
    if (parsed.found === "result" && parsed.category) {
      return { category: parsed.category, index: parsed.index, issn };
    }
    if (parsed.found === "not-indexed") return { category: "", index: "", issn, notIndexed: true };
    sawUnreadable = true;
  }
  return { error: sawUnreadable ? "unreadable" : "network" };
}

// One-click download + import (fallback when the background
// fetch is blocked): open the SJR export URL in a background
// tab in the USER's browser — Cloudflare sees a real browser,
// not a datacenter fetch — read the CSV text from the rendered
// page, and import it into IndexedDB, stored until expiry like
// every other import. If the page is a bot check instead of a
// CSV, that is reported as blocked, never guessed. The tab is
// always closed afterwards. Returns { rows, year, via } or
// { error, year }.
async function fetchSjrViaTab(year) {
  const urls = [FREE.sjrExportUrl(year), FREE.sjrExportUrlAlt(year)];
  for (const url of urls) {
    let tabId = null;
    try {
      const tab = await chrome.tabs.create({ url, active: false });
      tabId = tab.id;
      const loaded = await new Promise((resolve) => {
        let done = false;
        const timer = setTimeout(() => { if (!done) { done = true; resolve(false); } }, 60000);
        const listener = (id, info) => {
          if (id === tabId && info.status === "complete" && !done) {
            done = true;
            clearTimeout(timer);
            chrome.tabs.onUpdated.removeListener(listener);
            resolve(true);
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
      });
      if (!loaded) return { error: "timeout", year };
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => (document.body ? document.body.innerText : ""),
      });
      const text = results && results[0] && results[0].result;
      if (!text) continue; // blank page: try the alternate URL spelling
      if (FREE.looksBlocked(text, 200)) return { error: "blocked", year };
      if (!FREE.isSjrCsv(text)) continue; // not a CSV: try the alternate spelling
      const done = await importSjrText(text, year);
      if (!done.rows) return { error: "not-csv", year };
      return { rows: done.rows, skipped: done.skipped, year, via: "browser-download" };
    } catch (err) {
      return { error: "failed", year, detail: String(err && err.message || err) };
    } finally {
      if (tabId !== null && chrome.tabs && chrome.tabs.remove) {
        try { await chrome.tabs.remove(tabId); } catch (e) { /* already closed */ }
      }
    }
  }
  return { error: "not-csv", year };
}

// "Check this page": read the DOI from the live DOM of the article
// tab the user is already on. The page is already loaded by the user,
// so no fetch happens and a publisher bot check cannot apply.
//
// ROOT CAUSE of the v4/v5 failures (26–27 Nov 2026, ScienceDirect):
// v4 made ONE executeScript call with BOTH files: ["shared.js"] AND
// func — invalid, exactly one of `files`/`func` may be specified, so
// the extractor never ran. The v5 "fix" split it into two calls:
// step 1 injected shared.js, step 2 called the global it defined.
// That is fragile too: top-level `const`/`function` declarations in
// an injected file do NOT reliably persist across separate
// executeScript calls in the tab's isolated world — step 2's
// `typeof extractDoiFromDocument === "function"` can be false (or
// the call can throw because the `const DOI_PATTERN` it closes over
// is gone), so it silently returned null — "No DOI found on this
// page" — even though step 1 "succeeded" and the DOI was on the
// page. The user confirmed this on 27 Nov 2026: pasting the
// ScienceDirect link (background fetch) worked, "Check this page"
// still did nothing.
//
// The fix below is ONE executeScript call with ONLY `func`, and the
// func is FULLY SELF-CONTAINED: the whole DOI extraction lives
// inside it (same priority order as shared.js extractDoiFromDocument
// — citation_doi, DC.Identifier, JSON-LD, og:url, canonical, head
// doi.org link). Nothing is injected by a previous call and nothing
// is read from any closure, so there is no cross-call persistence
// to fail.
//
// Permission path: this does NOT rely on activeTab alone. The
// manifest grants host_permissions for the publisher origins
// (*.sciencedirect.com, *.nature.com, etc.), and
// chrome.scripting.executeScript is allowed on any origin the
// extension has a host permission for — no activeTab grant needed.
// activeTab is only a fallback for origins outside that list.
async function checkThisPage(sendResponse) {
  try {
    if (!chrome.scripting || !chrome.scripting.executeScript) {
      sendResponse({ doi: null, error: "no-scripting", detail: "chrome.scripting is unavailable in this browser." });
      return;
    }
    // Pick the article tab. When the side panel is open, the panel
    // is not a tab, so the active tab in the window IS the article
    // tab the user is looking at. When the lookup page itself is
    // open as a full tab, it is the active tab, so fall back to the
    // most recently used http(s) tab in this window instead.
    // (Needs the "tabs" permission so tab URLs are visible here.)
    let tab = null;
    try {
      const active = await chrome.tabs.query({ active: true, currentWindow: true });
      const first = active && active[0];
      if (first && first.id && first.url && /^https?:\/\//.test(first.url)) {
        tab = first;
      }
    } catch (err) { /* fall through to the all-tabs search */ }
    if (!tab) {
      const all = await chrome.tabs.query({ currentWindow: true });
      const candidates = (all || []).filter((t) => t && t.id && t.url && /^https?:\/\//.test(t.url));
      candidates.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
      tab = candidates[0] || null;
    }
    if (!tab || !tab.id || !tab.url || !/^https?:\/\//.test(tab.url)) {
      sendResponse({ doi: null, error: "no-article-tab" });
      return;
    }
    let host = "";
    try { host = new URL(tab.url).hostname; } catch (err) { /* ignore */ }

    // ONE executeScript call, `func` only — no `files`. The func is
    // fully self-contained (see the root-cause note above): it
    // defines everything it needs inside itself and only touches
    // the page's own `document`. It returns the DOI string or null.
    let results;
    try {
      results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          try {
            const DOI_PATTERN = /10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i;
            const pick = (value) => {
              if (!value) return null;
              const d = String(value).match(DOI_PATTERN);
              return d ? d[0] : null;
            };
            const metaContent = (selector) => {
              const el = document.querySelector(selector);
              return el ? el.getAttribute("content") : null;
            };
            let doi = pick(metaContent('meta[name="citation_doi"]'))
              || pick(metaContent('meta[property="citation_doi"]'))
              || pick(metaContent('meta[name="DC.Identifier"]'))
              || pick(metaContent('meta[name="dc.identifier"]'));
            if (doi) return doi;
            // JSON-LD blocks: "doi", or an "@id" pointing at doi.org.
            const scripts = document.querySelectorAll('script[type="application/ld+json"]');
            for (const script of scripts) {
              try {
                const data = JSON.parse(script.textContent || "");
                const candidates = Array.isArray(data) ? data : [data];
                for (const item of candidates) {
                  if (!item || typeof item !== "object") continue;
                  doi = pick(item.doi) || pick(item["@id"]);
                  if (doi) return doi;
                }
              } catch (e) { /* not JSON — skip this block */ }
            }
            doi = pick(metaContent('meta[property="og:url"]'));
            if (doi) return doi;
            const canonical = document.querySelector('link[rel="canonical"]');
            if (canonical) {
              doi = pick(canonical.getAttribute("href"));
              if (doi) return doi;
            }
            // A doi.org link inside <head> only — references live
            // in the body, so scanning the whole page would risk a
            // cited DOI.
            const headLinks = document.head ? document.head.querySelectorAll("a[href]") : [];
            for (const a of headLinks) {
              doi = pick(a.getAttribute("href"));
              if (doi) return doi;
            }
            return null;
          } catch (e) {
            return null;
          }
        },
      });
    } catch (err) {
      sendResponse({
        doi: null, error: "inject-extract-failed", host,
        detail: String(err && err.message || err),
      });
      return;
    }
    const firstResult = results && results[0];
    if (firstResult && firstResult.error) {
      sendResponse({
        doi: null, error: "inject-extract-failed", host,
        detail: String(firstResult.error.message || firstResult.error),
      });
      return;
    }
    const doi = firstResult && firstResult.result;
    sendResponse({ doi: doi || null, host, url: tab.url });
  } catch (err) {
    sendResponse({ doi: null, error: String(err && err.message || err) });
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.type === "checkThisPage") {
    checkThisPage(sendResponse);
    return true; // async sendResponse
  }
  // Free data, no JCR (see the auto-fetch block above):
  // auto-fetch (first run + yearly), per-article MJL search, and
  // one-click SJR download. Order is always auto-fetch first,
  // then one-click download+import, then manual import.
  if (message && message.type === "fetchMjlCategory") {
    fetchMjlCategory(message.issns || (message.issn ? [message.issn] : []))
      .then((r) => sendResponse(r))
      .catch((err) => sendResponse({ error: "network", detail: String(err && err.message || err) }));
    return true;
  }
  if (message && message.type === "fetchSjrExport") {
    (async () => {
      const year = message.year || FREE.sjrLatestYear();
      const fetched = await fetchSjrYear(year);
      if (fetched.error) {
        sendResponse({ error: fetched.error, year });
        return;
      }
      try {
        const done = await importSjrText(fetched.text, year);
        sendResponse({ rows: done.rows, skipped: done.skipped, warnings: done.warnings, year });
      } catch (err) {
        sendResponse({ error: "failed", year, detail: String(err && err.message || err) });
      }
    })().catch((err) => sendResponse({ error: "failed", detail: String(err && err.message || err) }));
    return true;
  }
  if (message && message.type === "fetchSjrViaTab") {
    fetchSjrViaTab(message.year || FREE.sjrLatestYear())
      .then((r) => sendResponse(r))
      .catch((err) => sendResponse({ error: "failed", detail: String(err && err.message || err) }));
    return true;
  }
  if (message && message.type === "autoFetchFreeData") {
    autoFetchFreeData()
      .then((status) => sendResponse({ status }))
      .catch((err) => sendResponse({ error: String(err && err.message || err) }));
    return true;
  }
  if (!message || message.type !== "fetchPageDoi" || !message.url) {
    sendResponse({ doi: null });
    return false;
  }
  let url;
  try {
    url = new URL(message.url);
  } catch (err) {
    sendResponse({ doi: null, error: "bad url" });
    return false;
  }
  fetch(url.toString(), { headers: { Accept: "text/html" } })
    .then(async (response) => {
      const html = await response.text();
      if (!response.ok || isBlockedPage(html, response.status)) {
        sendResponse({ doi: null, blocked: true, status: response.status });
        return;
      }
      sendResponse({ doi: parseDoiFromHtml(html) });
    })
    .catch((err) => sendResponse({ doi: null, error: String(err && err.message || err) }));
  return true; // async sendResponse
});

// Side panel: clicking the toolbar icon opens the panel, not a popup.
if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  const enablePanel = () => {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {
      // Older Chrome without setPanelBehavior: fall back to onClicked.
    });
  };
  chrome.runtime.onInstalled.addListener(enablePanel);
  chrome.runtime.onInstalled.addListener(() => { maybeAutoFetch(); });
  chrome.runtime.onStartup.addListener(enablePanel);
  chrome.runtime.onStartup.addListener(() => { maybeAutoFetch(); });
  enablePanel();
}
if (chrome.action && chrome.action.onClicked) {
  chrome.action.onClicked.addListener((tab) => {
    if (chrome.sidePanel && chrome.sidePanel.open) {
      chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
    }
  });
}

// Free data: check on every worker wake whether the yearly
// auto-fetch is due (cheap: one storage read, then it stops).
maybeAutoFetch();
