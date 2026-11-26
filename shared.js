// Shared DOI logic — loaded by the lookup page (shared.js + popup.js)
// and by the background service worker (importScripts). One copy
// only; do not duplicate these functions elsewhere.
// No DOM access here, so it is safe to load in both contexts.

const DOI_PATTERN = /10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i;

function extractDoi(raw) {
  let text = (raw || "").trim();
  if (!text) return null;
  text = text.replace(/[.,;)\]]+$/, "");
  const doiOrg = text.match(/doi\.org\/(10\.\d{4,9}\/[-._;()/:A-Z0-9]+)/i);
  if (doiOrg) return doiOrg[1];
  const match = text.match(DOI_PATTERN);
  return match ? match[0] : null;
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
