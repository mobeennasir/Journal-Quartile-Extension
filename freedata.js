// freedata.js — ranking data the extension can get WITHOUT JCR.
//
// Two free sources, both checked automatically in the user's
// browser (background worker fetch, CORS-exempt via host
// permissions). No login, no subscription, no JCR file needed:
//
//   * WoS category W/X — from the Clarivate Master Journal List
//     (MJL) public search. The MJL search page is public and shows
//     the journal's Web of Science Core Collection index
//     (SCIE / SSCI / AHCI / ESCI) for an ISSN. The MJL *file*
//     download, by contrast, needs a free MJL login (and the full
//     download is subscriber-only, per Clarivate support), so the
//     extension does NOT download the file — it reads the public
//     search page for the one journal being looked up, and stores
//     the answer. W = SCIE/SSCI/AHCI, X = ESCI.
//   * SJR quartile (fallback, NOT JCR) — from the SCImago CSV
//     download on the journal ranking page
//     (journalrank.php?year=Y&type=j&out=csv, with export=csv as
//     the alternate parameter spelling found in the research
//     notes). SJR blocks automated fetches with a Cloudflare
//     human-verification page, so the download may fail — the
//     failure is reported plainly and the manual file import
//     stays as backup. Nothing is ever invented.
//
// Pure functions only (no DOM, no network here): the background
// worker does the fetching, this file builds the URLs and parses
// the responses. Node-testable via the module.exports guard.

(function (root) {
  "use strict";

  // ---------- MJL (WoS category) ----------

  // ROOT CAUSE, found 27 Nov 2026 (user's real Chrome showed
  // "Unknown — WoS list could not be read"): the MJL search page
  // is an Angular single-page app. A plain fetch returns only the
  // 11 KB HTML shell — no journal, no "Core Collection:" label,
  // nothing to parse — so the old fetch-and-parse path always
  // answered "unreadable". The label only exists AFTER the page's
  // JavaScript runs in a real browser tab. The background worker
  // therefore reads the RENDERED page in a background tab
  // (fetchMjlCategoryViaTab in background.js) and parses that
  // text with the same parseMjlSearchHtml below. The MJL JSON API
  // (/api/jprof/public/rank-search, POST) was also tried and is
  // NOT usable: it 404s even with the site's cookies, so it is
  // undocumented/private and is not called. OpenAlex cannot
  // replace it either: its source record has no WoS index field
  // (verified 27 Nov 2026 for ISSN 1471-2180 and 0944-5013).

  var MJL_SEARCH_BASE = "https://mjl.clarivate.com/search-results?issn=";

  // SJR journal ranking page for one year (the HTML page, not
  // the CSV): this is the page Cloudflare actually challenges.
  // The home page does NOT challenge (verified 27 Nov 2026: the
  // home page returns HTTP 200 with real HTML from a datacenter
  // IP, while journalrank.php returns 403 "Just a moment..."),
  // so opening the home page as a "clearance tab" never earns
  // any clearance — that is why the old fix failed in the user's
  // real Chrome 4-5 times in a row.
  function sjrRankPageUrl(year) {
    return "https://www.scimagojr.com/journalrank.php?year=" + encodeURIComponent(String(year));
  }

  // Is this text a Cloudflare challenge page ("Just a moment...",
  // "Verify you are human") rather than the real page? Used to
  // poll a background tab until the managed challenge clears.
  function isChallengeText(text) {
    if (!text) return true;
    return /just a moment|verify you are human|checking your browser|cf-challenge|attention required/i.test(String(text).slice(0, 20000));
  }

  function formatIssnHyphen(compact) {
    const s = String(compact || "").replace(/[^0-9X]/gi, "").toUpperCase();
    return s.length === 8 ? s.slice(0, 4) + "-" + s.slice(4) : "";
  }

  // mjl.clarivate.com/search-results?issn=0376-7388 — the ISSN
  // with a hyphen, as Clarivate's own search links use it.
  function mjlSearchUrl(issnCompact) {
    return MJL_SEARCH_BASE + encodeURIComponent(formatIssnHyphen(issnCompact) || String(issnCompact || ""));
  }

  // Map a WoS index name to the HEC category: W = SCIE/SSCI/AHCI,
  // X = ESCI (Emerging). Order matters: check Emerging first, then
  // Arts, then Social Sciences, then Science Citation Index.
  function indexNameToCategory(name) {
    if (!name) return "";
    const v = String(name).toUpperCase();
    if (v.indexOf("EMERGING SOURCES") !== -1 || v === "ESCI") return "X";
    if (v.indexOf("ARTS") !== -1 || v === "AHCI") return "W";
    if (v.indexOf("SOCIAL SCIENCES") !== -1 || v === "SSCI") return "W";
    if (v.indexOf("SCIENCE CITATION INDEX") !== -1 || v === "SCIE") return "W";
    return "";
  }

  function indexNameToCode(name) {
    if (!name) return "";
    const v = String(name).toUpperCase();
    if (v.indexOf("EMERGING SOURCES") !== -1 || v === "ESCI") return "ESCI";
    if (v.indexOf("ARTS") !== -1 || v === "AHCI") return "AHCI";
    if (v.indexOf("SOCIAL SCIENCES") !== -1 || v === "SSCI") return "SSCI";
    if (v.indexOf("SCIENCE CITATION INDEX") !== -1 || v === "SCIE") return "SCIE";
    return "";
  }

  // Parse an MJL search-results page (HTML) for the journal's WoS
  // Core Collection index.
  //
  // The result block on the page reads, verbatim from Clarivate:
  //   "Web of Science Core Collection: Emerging Sources Citation Index"
  // (or Science Citation Index Expanded / Social Sciences Citation
  // Index / Arts & Humanities Citation Index). That labelled line
  // is what is parsed — the FIRST "Core Collection:" label on the
  // page.
  //
  // TRAP: the same page also carries an FAQ ("What Is Master
  // Journal List?") that lists ALL FOUR indexes in one sentence:
  // "including the complete list of journal in the Web of Science
  // Core Collection (including Science Citation Index Expanded,
  // Social Sciences Citation Index, Arts & Humanities Citation
  // Index, and Emerging Sources Citation Index)". That sentence
  // has NO colon after "Core Collection", so a parser that only
  // accepts the "Core Collection:" label never matches it. A
  // parser that merely searches for index names would always
  // find SCIE first and be wrong — this one does not do that.
  //
  // Returns { index, category, found }:
  //   index: "SCIE" | "SSCI" | "AHCI" | "ESCI" | ""
  //   category: "W" | "X" | ""
  //   found: "result" (a journal was found and its index read),
  //          "not-indexed" (the search returned 0 results),
  //          "unreadable" (a result exists but no index line
  //          could be read — layout changed, login wall, or a
  //          bot check), "unknown" (no result information at all).
  function parseMjlSearchHtml(html) {
    const out = { index: "", category: "", found: "unknown" };
    if (!html) return out;
    const text = String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ");
    const zero = /found\s+0\s+results/i.test(text) || /no results found/i.test(text);
    if (zero) { out.found = "not-indexed"; return out; }
    const hasResult = /found\s+[1-9][0-9]*\s+results?/i.test(text)
      || /exact match found/i.test(text);
    // First "Web of Science Core Collection:" label only.
    const m = text.match(/Web of Science\s*\*?\s*Core Collection\s*:\s*([A-Za-z][A-Za-z &\-]{2,60})/i);
    if (m) {
      const code = indexNameToCode(m[1]);
      if (code) {
        out.index = code;
        out.category = indexNameToCategory(m[1]);
        out.found = "result";
        return out;
      }
    }
    out.found = hasResult ? "unreadable" : "unknown";
    return out;
  }

  // ---------- SJR (fallback quartile) ----------

  // SJR CSV download on the journal ranking page.
  //
  // ROOT CAUSE, found 27 Nov 2026 (verified live, twice): the
  // extension fetched `?year=Y&type=j&out=csv` and
  // `?year=Y&type=j&export=csv` — but a plain GET of EITHER
  // returns the HTML ranking page, not a CSV (checked with the
  // page crawler: both spellings return the rendered table).
  // The site's own Download button points to
  // `journalrank.php?year=Y&out=xls`, and THAT URL returns the
  // full semicolon CSV (verified: the 2023 file, 86,207 lines,
  // starting with the exact header `Rank;Sourceid;Title;...;
  // SJR Best Quartile;...`). So `out=xls` is the working
  // spelling — the in-tab fetch tried two URLs that could never
  // return a file, the validation correctly rejected the HTML,
  // and the tab opened and closed with no download. That is the
  // open-close-without-download the user saw in every batch.
  // Order: the site's own link first (see findSjrDownloadLinks),
  // then out=xls, then the two HTML-returning spellings as a
  // last resort (kept in case the site changes its mind).
  function sjrExportUrl(year) {
    return "https://www.scimagojr.com/journalrank.php?year=" + encodeURIComponent(String(year)) + "&out=xls";
  }
  function sjrExportUrlAlt(year) {
    return "https://www.scimagojr.com/journalrank.php?year=" + encodeURIComponent(String(year)) + "&out=csv";
  }
  function sjrExportUrlDownload(year) {
    return "https://www.scimagojr.com/journalrank.php?download=csv&year=" + encodeURIComponent(String(year));
  }
  function sjrExportUrls(year) {
    return [sjrExportUrl(year), sjrExportUrlAlt(year), sjrExportUrlDownload(year)];
  }

  // Find the SJR Download link(s) in a ranking page's HTML: the
  // site's own button, so the extension fetches the URL the site
  // actually serves instead of guessing a spelling. Matches
  // anchors whose href asks for an export (out=xls, out=csv,
  // download=csv) or whose text says Download. Relative hrefs
  // are resolved against scimagojr.com. Returns absolute URLs,
  // in page order, deduplicated.
  function findSjrDownloadLinks(html) {
    const out = [];
    if (!html) return out;
    const re = /<a[^>]*href="([^"]+)"[^>]*>([\s\S]{0,120}?)<\/a>/gi;
    let m;
    while ((m = re.exec(String(html))) !== null) {
      const href = m[1] || "";
      const label = (m[2] || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      const isExport = /out=(xls|csv)|download=csv/i.test(href);
      const isDownloadLabel = /download/i.test(label);
      if (!isExport && !isDownloadLabel) continue;
      let url = href;
      if (url.indexOf("http") !== 0) {
        url = "https://www.scimagojr.com" + (url.charAt(0) === "/" ? "" : "/") + url;
      }
      if (url.indexOf("scimagojr.com/journalrank.php") === -1) continue;
      if (out.indexOf(url) === -1) out.push(url);
    }
    return out;
  }

  // Does this downloaded text look like the SJR CSV (sjrdata
  // columns: year, rank, sourceid, title, type, issn, publisher,
  // sjr, sjr_best_quartile, h_index, ...)? A Cloudflare bot page
  // or an HTML page fails this check. Note the header in the real
  // downloaded file spells it "SJR Best Quartile" (spaces), while
  // the sjrdata republish uses underscores — both are accepted.
  function isSjrCsv(text) {
    if (!text) return false;
    const head = String(text).slice(0, 2000).toLowerCase();
    if (head.trim().startsWith("<")) return false;
    const flat = head.replace(/_/g, " ");
    return flat.indexOf("issn") !== -1 && flat.indexOf("sjr best quartile") !== -1;
  }

  // The year the SJR export file itself describes, from its
  // header ("Total Docs. (2025)"). The export has no Year column,
  // so this header is the only year the file carries — it is the
  // ground truth the auto-fetch checks a downloaded file against.
  // Returns the year, or null when the header carries no year
  // (a synthetic file, or a header the site has changed).
  function sjrCsvYear(text) {
    if (!text) return null;
    const m = String(text).slice(0, 2000).match(/Total Docs\. \((\d{4})\)/);
    if (!m) return null;
    const y = parseInt(m[1], 10);
    return y >= 1999 && y <= 2100 ? y : null;
  }

  // Bot / access block: HTTP 403/429/401, or a human-verification
  // page (Cloudflare "Verify you are human", captcha, etc.).
  function looksBlocked(html, status) {
    if (status === 403 || status === 429 || status === 401) return true;
    if (!html) return false;
    return /verify you are human|performing security verification|cloudflare|are you a robot|captcha|access denied|verify your identity/i.test(String(html).slice(0, 20000));
  }

  // ---------- MJL file download (attempted, usually login-walled) ----------
  // The Collection List Downloads page:
  //   https://mjl.clarivate.com/collection-list-downloads
  // Verified 27 Nov 2026: the page says the lists are "available
  // for download to Web of Science subscribers" and "You will need
  // a free Master Journal List login to access the download files",
  // and it lists NO file links to an anonymous visitor. So a
  // direct file fetch will normally fail at the login wall — the
  // extension tries it once a year anyway (a logged-in user, or a
  // future open list, would succeed), and when it fails it says so
  // plainly and falls back to the per-article public search above,
  // which needs no login at all.
  var MJL_DOWNLOADS_PAGE = "https://mjl.clarivate.com/collection-list-downloads";

  // Is this the downloads page behind its login wall?
  function isMjlLoginWall(html) {
    if (!html) return true;
    return /log in to access the download files|need a free .* login to access|sign in to download/i.test(String(html).slice(0, 20000));
  }

  // Find direct collection-file links on the MJL downloads page.
  // Returns [{ url, label }] with relative links resolved. The
  // label names the collection (SCIE / SSCI / AHCI / ESCI).
  function findMjlDownloadLinks(html) {
    const out = [];
    if (!html) return out;
    const re = /<a[^>]*href="([^"]+)"[^>]*>([\s\S]{0,200}?)<\/a>/gi;
    let m;
    while ((m = re.exec(String(html))) !== null) {
      const href = m[1];
      if (!/\.xlsx?(\?|#|$)/i.test(href) && href.toLowerCase().indexOf("download") === -1) continue;
      let url = href;
      if (url.indexOf("http") !== 0) {
        url = "https://mjl.clarivate.com" + (url.charAt(0) === "/" ? "" : "/") + url;
      }
      const label = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      if (out.some((x) => x.url === url)) continue;
      out.push({ url: url, label: label });
    }
    return out;
  }

  // Which WoS index a collection file (or link label) is for.
  function mjlCollectionIndex(label) {
    if (!label) return "";
    const v = String(label);
    if (/Emerging Sources/i.test(v)) return "ESCI";
    if (/Arts/i.test(v)) return "AHCI";
    if (/Social Sciences/i.test(v)) return "SSCI";
    if (/Science Citation Index Expanded/i.test(v)) return "SCIE";
    return "";
  }

  // ---------- SJR latest year ----------
  // SJR releases each June: the data for year Y appears in June
  // Y+1. So the latest complete year is last year from June on,
  // and the year before that in January-May.
  function sjrLatestYear(fromDate) {
    const d = fromDate ? new Date(fromDate) : new Date();
    return d.getMonth() >= 5 ? d.getFullYear() - 1 : d.getFullYear() - 2;
  }

  const api = {
    mjlSearchUrl: mjlSearchUrl,
    sjrRankPageUrl: sjrRankPageUrl,
    isChallengeText: isChallengeText,
    parseMjlSearchHtml: parseMjlSearchHtml,
    indexNameToCategory: indexNameToCategory,
    mjlDownloadsPage: MJL_DOWNLOADS_PAGE,
    isMjlLoginWall: isMjlLoginWall,
    findMjlDownloadLinks: findMjlDownloadLinks,
    mjlCollectionIndex: mjlCollectionIndex,
    sjrLatestYear: sjrLatestYear,
    sjrExportUrl: sjrExportUrl,
    sjrExportUrlAlt: sjrExportUrlAlt,
    sjrExportUrlDownload: sjrExportUrlDownload,
    sjrExportUrls: sjrExportUrls,
    findSjrDownloadLinks: findSjrDownloadLinks,
    isSjrCsv: isSjrCsv,
    sjrCsvYear: sjrCsvYear,
    looksBlocked: looksBlocked,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else if (typeof window !== "undefined") {
    window.JournalQuartileFreeData = api;
  } else if (typeof self !== "undefined") {
    self.JournalQuartileFreeData = api;
  }
})(typeof self !== "undefined" ? self : (typeof window !== "undefined" ? window : this));
