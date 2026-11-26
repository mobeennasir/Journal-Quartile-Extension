// Phase 1 spike: DOI / article-link lookup only. Shared lookup page
// used by the side panel and by a full tab (sidepanel.html).
// Crossref first, OpenAlex fallback. No quartile, no Impact Factor,
// no category in this spike — those are added in later phases.
// Only data returned by the API is displayed; nothing is invented.
// DOI extraction / parsing lives in shared.js (one copy, also used
// by the background service worker).

const MAILTO = "mubeennasir117@gmail.com";

const inputEl = document.getElementById("input");
const lookupBtn = document.getElementById("lookup");
const statusEl = document.getElementById("status");
const resultEl = document.getElementById("result");
const openTabBtn = document.getElementById("open-tab");

// Resolve a publisher URL that contains no literal DOI.
// MAIN mechanism (generic, any publisher): fetch the article page
// via the background service worker and parse its metadata
// (citation_doi first, then DC.Identifier, JSON-LD, og:url,
// canonical, head doi.org link). Slug mapping is only a FALLBACK
// afterwards. Direct popup fetch is a last resort.
async function resolveDoiFromUrl(raw) {
  const url = (raw || "").trim();
  if (!/^https?:\/\//i.test(url)) return { doi: null, blocked: false };
  let host = "";
  try { host = new URL(url).hostname; } catch (err) { /* ignore */ }
  // Background service worker path (preferred, CORS-exempt).
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
    } catch (err) {
      // Fall through to slug mapping / direct fetch below.
    }
  }
  // Fallback: known slug mapping (Nature only, certain by construction).
  const slugDoi = doiFromSlug(url);
  if (slugDoi) return { doi: slugDoi, blocked: false };
  // Last resort: direct fetch (works only where the publisher allows it).
  try {
    const response = await fetch(url, { headers: { Accept: "text/html" } });
    if (response.ok) {
      const doi = parseDoiFromHtml(await response.text());
      if (doi) return { doi, blocked: false };
    } else if (response.status === 403 || response.status === 429) {
      return { doi: null, blocked: true, host, status: response.status };
    }
  } catch (err) {
    // Ignore; the caller shows the generic error.
  }
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

function issnFromCrossref(message) {
  const list = message.ISSN || [];
  if (!Array.isArray(list)) return "";
  const values = list.map((entry) => {
    if (typeof entry === "string") return entry;
    if (entry && entry.value) {
      return entry["issn-type"] ? `${entry.value} (${entry["issn-type"]})` : entry.value;
    }
    return "";
  }).filter(Boolean);
  return values.join(", ");
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
    issn: issnFromCrossref(message),
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
  if (source.issn_l) issns.push(`${source.issn_l} (ISSN-L)`);
  (source.issn || []).forEach((issn) => { if (issn !== source.issn_l) issns.push(issn); });
  const doi = (work.doi || "").replace(/^https?:\/\/doi\.org\//i, "");
  return {
    title: work.display_name || work.title || "",
    journal: source.display_name || "",
    issn: issns.join(", "),
    year: work.publication_year ? String(work.publication_year) : "",
    publisher: source.host_organization_name || "",
    biblio: pages.join(", "),
    doi,
    url: work.doi || "",
  };
}

function showResult(data, sourceName) {
  const rows = [
    ["Title", escapeHtml(data.title || "—")],
    ["Journal", escapeHtml(data.journal || "—")],
    ["ISSN", escapeHtml(data.issn || "—")],
    ["Year", escapeHtml(data.year || "—")],
    ["Publisher", escapeHtml(data.publisher || "—")],
    ["Volume / issue / pages", escapeHtml(data.biblio || "—")],
    ["DOI", data.doi
      ? `<a href="https://doi.org/${encodeURIComponent(data.doi)}" target="_blank" rel="noopener">https://doi.org/${escapeHtml(data.doi)}</a>`
      : "—"],
  ];
  const sourceClass = sourceName === "OpenAlex" ? "source openalex" : "source";
  resultEl.innerHTML =
    `<span class="${sourceClass}">Source: ${escapeHtml(sourceName)}</span>` +
    "<dl>" + rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("") + "</dl>";
  resultEl.hidden = false;
  // Persist so a reopened side panel / tab restores the last result.
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
    chrome.storage.local.set({ lastLookup: { input: inputEl.value, data, sourceName } });
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
  lookupBtn.textContent = loading ? "Looking up…" : "Lookup";
  lookupBtn.setAttribute("aria-busy", loading ? "true" : "false");
  statusEl.classList.toggle("loading", loading);
  if (loading && message) {
    statusEl.classList.remove("error");
    statusEl.textContent = message;
  }
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function lookup(doi) {
  setLoading(true, `Looking up ${doi} …`);
  resultEl.hidden = true;
  try {
    // Crossref first.
    try {
      const data = await fetchJson(
        `https://api.crossref.org/works/${encodeURIComponent(doi)}?mailto=${encodeURIComponent(MAILTO)}`
      );
      if (data && data.message) {
        statusEl.textContent = "";
        statusEl.classList.remove("loading");
        showResult(normaliseCrossref(data.message), "Crossref");
        return;
      }
    } catch (err) {
      // 404 / other Crossref failure: fall through to OpenAlex.
    }
    // OpenAlex fallback.
    try {
      const work = await fetchJson(
        `https://api.openalex.org/works/doi:${encodeURIComponent(doi)}?mailto=${encodeURIComponent(MAILTO)}`
      );
      if (work && work.display_name) {
        statusEl.textContent = "";
        statusEl.classList.remove("loading");
        showResult(normaliseOpenAlex(work), "OpenAlex");
        return;
      }
    } catch (err) {
      if (err && err.status === 404) {
        showError(`Not found: no record for ${doi} in Crossref or OpenAlex. Check the DOI and try again.`);
        return;
      }
      throw err;
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
    // No literal DOI in the input — it may be a publisher URL whose
    // address carries only a slug or a PII (e.g. nature.com, or a
    // ScienceDirect pii/ link). Resolve it via the article page's
    // own metadata first; slug mapping is only a fallback.
    const raw = (inputEl.value || "").trim();
    if (/^https?:\/\//i.test(raw)) {
      setLoading(true, "No DOI in the link — checking the article page …");
      try {
        const resolved = await resolveDoiFromUrl(raw);
        if (resolved.blocked) {
          setLoading(false);
          showError(
            `That publisher (${resolved.host || "this site"}) blocked the automatic page read` +
            (resolved.status ? ` (HTTP ${resolved.status}, bot check)` : " (bot check)") +
            `. The DOI could not be read from the page. Open the article in Chrome and copy the DOI from the page itself, then paste the DOI here.`
          );
          return;
        }
        doi = resolved.doi;
      } finally {
        setLoading(false);
      }
    }
  }
  if (!doi) {
    showError("No DOI found. Paste a DOI like 10.1038/nature14539, a doi.org link, or any publisher article URL (e.g. a nature.com or ScienceDirect link).");
    return;
  }
  lookup(doi);
}

lookupBtn.addEventListener("click", onLookupClick);
inputEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter") onLookupClick();
});

if (openTabBtn) {
  openTabBtn.addEventListener("click", () => {
    // Open this same lookup page in a full browser tab — it stays
    // open no matter where you click, and restores the last result.
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
