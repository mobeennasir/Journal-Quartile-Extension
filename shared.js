// Shared DOI logic — loaded by the lookup page (shared.js + popup.js)
// and by the background service worker (importScripts). One copy
// only; do not duplicate these functions elsewhere.
// No DOM access here, so it is safe to load in both contexts.

const DOI_PATTERN = /10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i;

function extractDoi(raw) {
  let text = (raw || "").trim();
  if (!text) return null;
  // A DOI never ends in punctuation or a slash: copy-paste from
  // a sentence or a doi.org link with a trailing slash must not
  // leave one behind, or Crossref answers 404 for it.
  text = text.replace(/[.,;)\]\/]+$/, "");
  const doiOrg = text.match(/doi\.org\/(10\.\d{4,9}\/[-._;()/:A-Z0-9]+)/i);
  if (doiOrg) return doiOrg[1].replace(/[.,;)\]\/]+$/, "");
  const match = text.match(DOI_PATTERN);
  return match ? match[0].replace(/[.,;)\]\/]+$/, "") : null;
}

// Publisher slug -> DOI mapping. This is a FALLBACK only, never the
// main mechanism — the generic page-metadata path below is tried
// first. Only mappings that are certain are listed; never guess a
// DOI prefix for another publisher.
function doiFromSlug(raw) {
  const text = (raw || "").trim();
  const nature = text.match(/(?:^|:\/\/)(?:www\.)?nature\.com\/articles\/([A-Za-z0-9][A-Za-z0-9\-]*)/i);
  if (nature) return `10.1038/${nature[1].replace(/[.,;)\]]+$/, "")}`;
  return null;
}

// Does this fetched page look like a bot / access block rather than
// the article? ScienceDirect and MDPI return such pages to automated
// fetches (HTTP 403 + captcha text, no article metadata).
function isBlockedPage(html, status) {
  if (status === 403 || status === 429 || status === 401) return true;
  if (!html) return false;
  return /are you a robot|captcha|access denied|verify you are human|cloudflare|please verify|bot detection|unusual traffic/i.test(html.slice(0, 20000));
}

// DOM version of parseDoiFromHtml — same priority order, for the
// "Check this page" path. Runs inside the already-loaded article
// tab (shared.js is injected there by the background worker), so it
// reads the live DOM and no fetch — and no bot check — can apply.
// Pure DOM reads, no network, no writes.
function extractDoiFromDocument(doc) {
  if (!doc) return null;
  const pick = (value) => {
    if (!value) return null;
    const d = String(value).match(DOI_PATTERN);
    return d ? d[0] : null;
  };
  const metaContent = (selector) => {
    const el = doc.querySelector(selector);
    return el ? el.getAttribute("content") : null;
  };
  let doi = pick(metaContent('meta[name="citation_doi"]'))
    || pick(metaContent('meta[property="citation_doi"]'))
    || pick(metaContent('meta[name="DC.Identifier"]'))
    || pick(metaContent('meta[name="dc.identifier"]'));
  if (doi) return doi;
  // JSON-LD blocks: "doi", or an "@id" pointing at doi.org.
  const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
  for (const script of scripts) {
    try {
      const data = JSON.parse(script.textContent || "");
      const candidates = Array.isArray(data) ? data : [data];
      for (const item of candidates) {
        if (!item || typeof item !== "object") continue;
        doi = pick(item.doi) || pick(item["@id"]);
        if (doi) return doi;
      }
    } catch (err) { /* not JSON — skip this block */ }
  }
  doi = pick(metaContent('meta[property="og:url"]'));
  if (doi) return doi;
  const canonical = doc.querySelector('link[rel="canonical"]');
  if (canonical) {
    doi = pick(canonical.getAttribute("href"));
    if (doi) return doi;
  }
  // A doi.org link inside <head> only — references live in the body.
  const headLinks = doc.head ? doc.head.querySelectorAll("a[href]") : [];
  for (const a of headLinks) {
    doi = pick(a.getAttribute("href"));
    if (doi) return doi;
  }
  return null;
}

// Parse a DOI out of an article page's HTML — the generic mechanism
// that works for any publisher. Order:
//  1. <meta name="citation_doi"> (either attribute order, name or
//     property) — the article's own DOI. Reference lists use
//     citation_doi=... inside a content attribute, not as a meta
//     name, so this cannot pick up a cited DOI.
//  2. <meta name="DC.Identifier" / "dc.identifier"> starting 10.
//  3. JSON-LD "doi" or "@id" pointing at doi.org.
//  4. <meta property="og:url"> containing doi.org.
//  5. <link rel="canonical"> containing a DOI.
//  6. A doi.org link inside <head> only — references live in the
//     body, so scanning the whole page would risk a cited DOI.
function parseDoiFromHtml(html) {
  if (!html) return null;
  const pick = (value) => {
    if (!value) return null;
    const d = value.match(DOI_PATTERN);
    return d ? d[0] : null;
  };
  let m = html.match(/<meta[^>]+(?:name|property)=["']citation_doi["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']citation_doi["']/i);
  if (m && pick(m[1])) return pick(m[1]);
  m = html.match(/<meta[^>]+(?:name|property)=["'](?:DC\.Identifier|dc\.identifier)["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["'](?:DC\.Identifier|dc\.identifier)["']/i);
  if (m && pick(m[1])) return pick(m[1]);
  m = html.match(/"doi"\s*:\s*"([^"]*10\.\d{4,9}\/[^"]*)"/i)
    || html.match(/"@id"\s*:\s*"https?:\/\/doi\.org\/(10\.\d{4,9}\/[^"]*)"/i);
  if (m && pick(m[1])) return pick(m[1]);
  m = html.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']*doi\.org\/[^"']*)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']*doi\.org\/[^"']*)["'][^>]+property=["']og:url["']/i);
  if (m && pick(m[1])) return pick(m[1]);
  m = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)
    || html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i);
  if (m && pick(m[1])) return pick(m[1]);
  const head = html.split(/<\/head>/i)[0];
  m = head.match(/doi\.org\/(10\.\d{4,9}\/[-._;()/:A-Z0-9]+)/i);
  return m ? m[1] : null;
}

// ---------- Full-tab detection ----------
// The lookup page runs in two contexts: the Chrome side panel (not a
// tab) and a full browser tab (opened by "Open in a full tab"). The
// "Open in a full tab" button must only show in the side panel — in
// a full tab it would open yet another tab, which is the bug reported
// 27 Nov 2026. Two detections, both pure so the Node tests can check
// them:
//  1. URL marker: the button opens sidepanel.html?view=fulltab, so
//     a full tab opened that way carries the marker.
//  2. chrome.tabs.getCurrent (in popup.js): in a full tab it returns
//     the tab; in the side panel it returns undefined, because the
//     panel is not a tab. That covers a sidepanel.html tab opened
//     directly, with no marker.
function isFullTabUrl(urlString) {
  if (!urlString) return false;
  try {
    const params = new URL(urlString, "https://example.invalid").searchParams;
    return params.get("view") === "fulltab";
  } catch (err) {
    return false;
  }
}

// The URL the "Open in a full tab" button opens: the same page with
// the ?view=fulltab marker, so the new tab knows it is a full tab.
// If the marker is already there, the URL is returned unchanged.
function buildFullTabUrl(baseUrl) {
  const url = String(baseUrl || "sidepanel.html");
  if (isFullTabUrl(url)) return url;
  return url + (url.indexOf("?") === -1 ? "?view=fulltab" : "&view=fulltab");
}

// ---------- Upload file-type guard ----------
// Each upload button only takes specific file types. The file
// input's accept attribute limits the picker, but "All files" can
// bypass it, so the code checks the extension too and rejects
// anything else with a short plain error. Pure, Node-testable.
function fileExtension(fileName) {
  const name = String(fileName || "").trim();
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

function isAllowedFileType(fileName, allowed) {
  return (allowed || []).indexOf(fileExtension(fileName)) !== -1;
}

// ---------- Title matching (shared, Node-testable) ----------
// How much of the wanted title appears in the candidate title
// (word overlap). Guards the title search against returning a
// different article with a similar title. Unicode-aware: words
// are Unicode letters/numbers, so an Urdu or Arabic title is
// matched on its own words instead of being stripped to nothing.
// Very short titles ("Bee gut") have no long words, so the
// filter falls back to all words longer than one character.
function titleWords(s) {
  const all = String(s || "").toLowerCase().replace(/[^\p{L}\p{N} ]/gu, " ").split(/\s+/).filter(Boolean);
  const long = all.filter((w) => w.length > 3 || /[^\x00-\x7F]/.test(w));
  return long.length ? long : all.filter((w) => w.length > 1);
}

function titleOverlap(wanted, candidate) {
  const want = titleWords(wanted);
  if (!want.length) return 0;
  const cand = new Set(titleWords(candidate));
  const hits = want.filter((w) => cand.has(w)).length;
  return hits / want.length;
}

// ---------- Upload file-size guard ----------
// A huge file (a 100 MB CSV, a bloated .xlsx) would freeze the
// panel while it is read into memory. "" when the size is fine,
// else a short plain error. Pure, Node-testable.
function fileSizeError(sizeBytes, maxBytes, what) {
  const size = Number(sizeBytes) || 0;
  if (size <= maxBytes) return "";
  const mb = Math.round(size / 1048576);
  const maxMb = Math.round(maxBytes / 1048576);
  return "That file is too large (" + mb + " MB). Use a file under " + maxMb + " MB for " + what + ".";
}

// Max upload sizes: an article list is small text (65 rows is
// ~12 KB); an SJR export is the biggest real file (~11 MB).
const MAX_ARTICLE_LIST_BYTES = 10 * 1048576;
const MAX_IMPORT_BYTES = 50 * 1048576;

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    extractDoi: extractDoi,
    doiFromSlug: doiFromSlug,
    isBlockedPage: isBlockedPage,
    extractDoiFromDocument: extractDoiFromDocument,
    parseDoiFromHtml: parseDoiFromHtml,
    isFullTabUrl: isFullTabUrl,
    buildFullTabUrl: buildFullTabUrl,
    fileExtension: fileExtension,
    isAllowedFileType: isAllowedFileType,
    titleWords: titleWords,
    titleOverlap: titleOverlap,
    fileSizeError: fileSizeError,
    MAX_ARTICLE_LIST_BYTES: MAX_ARTICLE_LIST_BYTES,
    MAX_IMPORT_BYTES: MAX_IMPORT_BYTES,
  };
}
