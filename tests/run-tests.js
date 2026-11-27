// Node unit + live tests for Phase 2. Run: node tests/run-tests.js
// No dependencies. Live tests hit api.crossref.org / api.openalex.org
// (real network). Synthetic JCR/SJR/MJL values in tests/*.csv are
// INVENTED for testing only — they are NOT real JCR/SJR data and
// must never be quoted as real.
"use strict";
const fs = require("fs");
const path = require("path");
const DATA = require("../jcr.js");
const XLSX = require("../xlsx.js");

const DIR = __dirname;
let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS " + name); }
  else { fail++; failures.push(name); console.log("  FAIL " + name + (detail ? " — " + detail : "")); }
}
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Crossref drops requests under load (empty body / 429) — retry once.
async function fetchJsonRetry(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.json();
    } catch (err) {
      if (attempt === 2) throw err;
      await sleep(1500);
    }
  }
}

async function main() {
  console.log("== 1. ISSN helpers ==");
  check("normaliseIssn strips hyphen", DATA.normaliseIssn("0028-0836") === "00280836");
  check("normaliseIssn rejects short", DATA.normaliseIssn("123") === "");
  check("parseIssnList splits print/electronic", eq(DATA.parseIssnList("0028-0836 (print), 1476-4687 (electronic)"), ["00280836", "14764687"]));
  check("formatIssn adds hyphen", DATA.formatIssn("00280836") === "0028-0836");

  console.log("== 2. CSV parser ==");
  const csv = 'a,"b,c","d""e"\r\n1,2,3\n';
  const parsed = DATA.parseCsv(csv);
  check("quoted comma + escaped quote", eq(parsed[0], ["a", "b,c", 'd"e']) && eq(parsed[1], ["1", "2", "3"]));

  console.log("== 3. JCR category export (synthetic) ==");
  const catText = fs.readFileSync(path.join(DIR, "synthetic-jcr-category.csv"), "utf8");
  const cat = DATA.parseJcrText(catText, { editionYear: 2021, fileName: "synthetic-jcr-category.csv" });
  check("category export parses 6 journals = 10 ISSN rows (2 journals share print/online ISSN)", cat.rows.length === 10, "got " + cat.rows.length);
  const nature = cat.rows.find((r) => r.issn === "00280836");
  check("Nature row: Q1, JIF 49.962, W", nature && nature.quartile === "Q1" && nature.jif === 49.962 && nature.wosCategory === "W" && nature.year === 2021,
    JSON.stringify(nature));
  const fsfs = cat.rows.find((r) => r.issn === "2571581X");
  check("ESCI row gives category X", fsfs && fsfs.wosCategory === "X", JSON.stringify(fsfs));
  const micres = cat.rows.find((r) => r.issn === "09445013");
  check("Microbiological Research row: Q2, JIF 5.07", micres && micres.quartile === "Q2" && micres.jif === 5.07);

  console.log("== 4. JCR All-Years export (synthetic, ISSN from file name context) ==");
  const ayText = fs.readFileSync(path.join(DIR, "synthetic-jcr-allyears.csv"), "utf8");
  // All-Years files carry no ISSN column; the importer keys by title
  // only if a journal column exists — this file has none, so it must
  // skip rows rather than invent a key.
  const ay = DATA.parseJcrText(ayText, { editionYear: null, fileName: "synthetic-jcr-allyears.csv" });
  check("All-Years file without ISSN/journal is skipped, not guessed", ay.rows.length === 0 && ay.skipped === 3,
    "rows=" + ay.rows.length + " skipped=" + ay.skipped);

  console.log("== 5. JCR canonical simple format ==");
  const canText = fs.readFileSync(path.join(DIR, "synthetic-jcr-canonical.csv"), "utf8");
  const can = DATA.parseJcrText(canText, { fileName: "synthetic-jcr-canonical.csv" });
  check("canonical format parses 3 rows", can.rows.length === 3, "got " + can.rows.length);
  check("canonical Nature 2015 Q1", can.rows.some((r) => r.issn === "00280836" && r.year === 2015 && r.quartile === "Q1"));

  console.log("== 6. Merge: two files, same ISSN different years + duplicate overwrite ==");
  const store = new DATA.MemoryStore();
  await store.putJcr(cat.rows, { fileName: "cat", editionYear: 2021, rows: cat.rows.length });
  await store.putJcr(can.rows, { fileName: "can", editionYear: null, rows: can.rows.length });
  const meta = await store.getMeta();
  check("merged store holds both editions", meta.jcrRows === 10 + 3, "got " + meta.jcrRows);
  const rank2015 = await store.getRank(["00280836"], 2015);
  check("lookup Nature 2015 -> JCR Q1 JIF 38.138", rank2015 && rank2015.source === "JCR" && rank2015.quartile === "Q1" && rank2015.jif === 38.138,
    JSON.stringify(rank2015));
  const rank2021 = await store.getRank(["00280836"], 2021);
  check("lookup Nature 2021 -> JCR Q1 JIF 49.962 (other year, not 2015's)", rank2021 && rank2021.source === "JCR" && rank2021.jif === 49.962,
    JSON.stringify(rank2021));
  const rank2017 = await store.getRank(["09445013"], 2017);
  check("lookup Microbiological Research 2017 -> Q2", rank2017 && rank2017.source === "JCR" && rank2017.quartile === "Q2",
    JSON.stringify(rank2017));
  const rankMissing = await store.getRank(["00280836"], 2019);
  check("lookup Nature 2019 -> source none (never another year's rank)", rankMissing && rankMissing.source === "none",
    JSON.stringify(rankMissing));

  console.log("== 7. SJR fallback (synthetic) ==");
  const sjrText = fs.readFileSync(path.join(DIR, "synthetic-sjr.csv"), "utf8");
  const sjr = DATA.parseSjrText(sjrText, { fileName: "synthetic-sjr.csv" });
  check("SJR parses 4 rows", sjr.rows.length === 4, "got " + sjr.rows.length);
  await store.putSjr(sjr.rows, { fileName: "sjr", rows: sjr.rows.length });
  const sjrRank = await store.getRank(["2571581X"], 2021);
  check("FSFS 2021 has JCR (ESCI row) so JCR wins over SJR", sjrRank && sjrRank.source === "JCR",
    JSON.stringify(sjrRank));
  const sjrOnly = await store.getRank(["00280836"], 2015);
  check("Nature 2015: JCR present, SJR not used", sjrOnly && sjrOnly.source === "JCR");
  // Remove JCR for a journal/year that only SJR covers: Cell 2020
  // is in the SJR file but not in the JCR store for 2020.
  const jpgr = await store.getRank(["07217595"], 2022);
  check("J Plant Growth Regul 2022 -> SJR fallback only, labelled SJR, quartile Q2", jpgr && jpgr.source === "SJR" && jpgr.quartile === "Q2",
    JSON.stringify(jpgr));

  console.log("== 8. MJL import (synthetic) ==");
  const mjlText = fs.readFileSync(path.join(DIR, "synthetic-mjl.csv"), "utf8");
  const mjl = DATA.parseMJLText(mjlText, { fileName: "synthetic-mjl.csv" });
  check("MJL parses 4 journals = 7 ISSN rows", mjl.rows.length === 7, "got " + mjl.rows.length);
  await store.putMjl(mjl.rows, { fileName: "mjl", rows: mjl.rows.length });
  const ksu = await store.getRank(["10183647"], 2019);
  check("MJL-only journal -> source none but category W", ksu && ksu.source === "none" && ksu.wosCategory === "W",
    JSON.stringify(ksu));

  console.log("== 9. Article-list CSV (real Naqqash file) ==");
  const listText = fs.readFileSync(path.join(DIR, "..", "test-set.csv"), "utf8");
  const list = DATA.parseArticleListText(listText);
  check("Naqqash CSV parses 67 rows", list.rows.length === 67, "got " + list.rows.length);
  check("row 1 title/journal/year", list.rows[0].title.startsWith("Rhizosphere engineering") && list.rows[0].journal === "Frontiers in Sustainable Food Systems" && list.rows[0].year === 2021,
    JSON.stringify(list.rows[0]));
  const seen = new Set();
  const unique = list.rows.filter((r) => {
    const k = r.title.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (seen.has(k)) return false; seen.add(k); return true;
  });
  // Title dedupe catches 2 pairs (57/58, 59/60). The other two
  // Scholar duplicates (19/63, 33/66) have TRUNCATED titles on the
  // profile itself, so they only collapse once their DOIs resolve
  // to the same DOI in the batch — 63 unique works after that.
  check("dedupe Scholar duplicates by title -> 65 unique", unique.length === 65, "got " + unique.length);

  console.log("== 10. XLSX reader (synthetic file) ==");
  const xlsxBuf = fs.readFileSync(path.join(DIR, "synthetic-test.xlsx"));
  const xrows = await XLSX.readXlsx(xlsxBuf.buffer.slice(xlsxBuf.byteOffset, xlsxBuf.byteOffset + xlsxBuf.byteLength));
  check("xlsx reads 3 rows", xrows.length === 3, "got " + xrows.length);
  check("xlsx header row", eq(xrows[0], ["title", "journal", "year", "doi"]), JSON.stringify(xrows[0]));
  check("xlsx row 2 title + year + doi", xrows[1][0].startsWith("Rhizosphere engineering") && xrows[1][2] === "2021" && xrows[1][3] === "10.3389/fsufs.2021.617157",
    JSON.stringify(xrows[1]));
  const xcsv = XLSX.rowsToCsvText(xrows);
  const xlist = DATA.parseArticleListText(xcsv);
  check("xlsx -> CSV -> article list parses 2 rows", xlist.rows.length === 2, "got " + xlist.rows.length);

  console.log("== 11. HTML-table .xls fallback ==");
  const html = '<html><body><table><tr><th>issn</th><th>year</th><th>quartile</th><th>jif</th></tr><tr><td>0028-0836</td><td>2015</td><td>Q1</td><td>38.138</td></tr></table></body></html>';
  const hrows = XLSX.spreadsheetHtmlToRows(html);
  check("HTML table rows extracted", hrows && hrows.length === 2 && hrows[1][0] === "0028-0836", JSON.stringify(hrows));
  const hjcr = DATA.parseJcrText(XLSX.rowsToCsvText(hrows), { fileName: "fake.xls" });
  check("HTML table -> JCR parse works", hjcr.rows.length === 1 && hjcr.rows[0].quartile === "Q1");

  console.log("== 12. Results CSV export round-trip ==");
  const sample = [{
    title: "Deep learning", journal: "Nature", year: "2015", issn: "0028-0836",
    doi: "10.1038/nature14539",
    rank: { source: "JCR", quartile: "Q1", jif: 38.138, wosCategory: "W" }, note: "",
  }];
  const outCsv = DATA.resultsToCsv(sample);
  check("export header has labelled columns", outCsv.startsWith("Title,Journal,Year,ISSN,DOI,JCR quartile (year),Impact Factor - JCR (year),WoS category,SJR quartile - fallback NOT JCR (year),Source,Notes"));
  check("export row carries JCR values", outCsv.indexOf("Q1,38.138,W") !== -1, outCsv.trim());

  console.log("== 13. Live Crossref DOI lookups (6 known DOIs) ==");
  const liveDois = [
    ["10.1038/nature14539", "Deep learning", "Nature", "2015"],
    ["10.1016/j.chemosphere.2020.128054", "triazophos", "Chemosphere", "2020"],
    ["10.1016/j.cell.2020.02.052", "SARS-CoV-2", "Cell", "2020"],
    ["10.1038/s41586-020-2649-2", "NumPy", "Nature", "2020"],
    ["10.1038/nature12373", "thermometry", "Nature", "2013"],
    ["10.1016/j.micres.2017.08.011", "carrier materials", "Microbiological Research", "2017"],
  ];
  for (const [doi, frag, journal, year] of liveDois) {
    try {
      const json = await fetchJsonRetry(`https://api.crossref.org/works/${encodeURIComponent(doi)}?mailto=mubeennasir117@gmail.com`);
      const m = json.message || {};
      const title = (m.title && m.title[0]) || "";
      const jname = (m["container-title"] && m["container-title"][0]) || "";
      const y = ((m["published-print"] || m["published-online"] || {} )["date-parts"] || [[null]])[0][0];
      check(`Crossref ${doi}`, title.toLowerCase().includes(frag.toLowerCase()) && jname === journal && String(y) === year,
        `title=${title} journal=${jname} year=${y}`);
    } catch (err) {
      check(`Crossref ${doi}`, false, String(err));
    }
    await sleep(250);
  }

  console.log("== 14. Live batch: first 10 Scholar rows, title search ==");
  const first10 = list.rows.slice(0, 10);
  let resolved = 0;
  for (const row of first10) {
    try {
      const params = new URLSearchParams();
      params.set("query.bibliographic", row.title);
      if (row.journal) params.set("query.container-title", row.journal);
      if (row.year) params.set("filter", `from-pub-date:${row.year}-01-01,until-pub-date:${row.year}-12-31`);
      params.set("rows", "3");
      params.set("select", "DOI,title");
      params.set("mailto", "mubeennasir117@gmail.com");
      const json = await fetchJsonRetry(`https://api.crossref.org/works?${params.toString()}`);
      const items = (json.message && json.message.items) || [];
      const hit = items.length && items[0].DOI;
      if (hit) resolved++;
      console.log(`    ${hit ? "DOI " + items[0].DOI : "NO MATCH"} — ${row.title.slice(0, 55)}`);
    } catch (err) {
      console.log("    ERROR — " + row.title.slice(0, 55) + ": " + String(err));
    }
    await sleep(500);
  }
  check("batch first 10: at least 8 resolve a DOI by title search", resolved >= 8, "resolved " + resolved + "/10");

  console.log("== 15. Live manual entry (Scholar row 1) ==");
  try {
    const params = new URLSearchParams();
    params.set("query.bibliographic", "Rhizosphere engineering with plant growth-promoting microorganisms for agriculture and ecological sustainability");
    params.set("query.container-title", "Frontiers in Sustainable Food Systems");
    params.set("filter", "from-pub-date:2021-01-01,until-pub-date:2021-12-31");
    params.set("rows", "3");
    params.set("mailto", "mubeennasir117@gmail.com");
    const json = await fetchJsonRetry(`https://api.crossref.org/works?${params.toString()}`);
    const top = (json.message && json.message.items && json.message.items[0]) || {};
    check("manual entry finds DOI 10.3389/fsufs.2021.617157", top.DOI === "10.3389/fsufs.2021.617157", "got " + top.DOI);
  } catch (err) {
    check("manual entry finds DOI", false, String(err));
  }

  console.log("== 16. Label audit (sidepanel.html) ==");
  const html2 = fs.readFileSync(path.join(DIR, "..", "sidepanel.html"), "utf8");
  const requiredLabels = [
    "DOI or article link", "Enter details manually",
    "Upload a list (Excel / CSV)",
    "Import JCR data",
    "Import SJR data",
    "Import WoS journal list",
    "Look up", "Upload and check all articles", "Import JCR file",
    "Download results as CSV", "Use the Naqqash test set (67 articles)",
    "Data year this export covers",
    "JCR quartile (year)", "Impact Factor — JCR (year)",
  ];
  requiredLabels.forEach((label) => check(`label present: "${label}"`, html2.indexOf(label) !== -1));
  // Merged 27 Nov 2026: "Lookup by DOI" and "Lookup by article link"
  // are no longer separate tabs. One option, "DOI or article link",
  // accepts a bare DOI, a doi.org link, or a publisher article URL.
  check("no separate 'Lookup by DOI' tab label", html2.indexOf("Lookup by DOI") === -1);
  check("no separate 'Lookup by article link' tab label", html2.indexOf("Lookup by article link") === -1);
  check("merged label description present", html2.indexOf("Bare DOI, doi.org link, or publisher article URL.") !== -1);
  const js = fs.readFileSync(path.join(DIR, "..", "popup.js"), "utf8");
  check("result label: SJR quartile — fallback, NOT JCR", js.indexOf("SJR quartile — fallback, NOT JCR") !== -1);
  check("result label: No JCR data for this year", js.indexOf("No JCR data for this year") !== -1);
  check("no bare 'Submit' or 'Go' button labels", !/>(Submit|Go)</.test(html2));

  console.log("== 17. Full-tab button bug (27 Nov 2026) ==");
  // The bug: "Open in a full tab" was still shown when the page was
  // ALREADY a full tab, and clicking it opened ANOTHER new tab.
  // Fix: hide the button in a full tab (URL marker ?view=fulltab,
  // plus chrome.tabs.getCurrent as backup) and refuse to open
  // anything from a full tab; the button opens exactly one tab via
  // chrome.tabs.create. The pure detection helpers live in shared.js
  // so Node can test them directly.
  const SHARED = require("../shared.js");
  check("isFullTabUrl: sidepanel.html?view=fulltab is a full tab",
    SHARED.isFullTabUrl("chrome-extension://fgkamfamhijbkaiddhhdinhlkjghmnlk/sidepanel.html?view=fulltab"));
  check("isFullTabUrl: plain sidepanel.html (side panel) is NOT a full tab",
    !SHARED.isFullTabUrl("chrome-extension://fgkamfamhijbkaiddhhdinhlkjghmnlk/sidepanel.html"));
  check("isFullTabUrl: ?view=sidepanel is NOT a full tab",
    !SHARED.isFullTabUrl("chrome-extension://fgkamfamhijbkaiddhhdinhlkjghmnlk/sidepanel.html?view=sidepanel"));
  check("isFullTabUrl: marker among other params still counts",
    SHARED.isFullTabUrl("chrome-extension://x/sidepanel.html?x=1&view=fulltab"));
  check("isFullTabUrl: empty / null is NOT a full tab",
    !SHARED.isFullTabUrl("") && !SHARED.isFullTabUrl(null));
  check("isFullTabUrl: relative sidepanel.html is NOT a full tab",
    !SHARED.isFullTabUrl("sidepanel.html"));
  check("buildFullTabUrl adds ?view=fulltab",
    SHARED.buildFullTabUrl("chrome-extension://x/sidepanel.html") === "chrome-extension://x/sidepanel.html?view=fulltab");
  check("buildFullTabUrl keeps existing query with &view=fulltab",
    SHARED.buildFullTabUrl("chrome-extension://x/sidepanel.html?x=1") === "chrome-extension://x/sidepanel.html?x=1&view=fulltab");
  check("buildFullTabUrl is idempotent on an already-marked URL",
    SHARED.buildFullTabUrl("chrome-extension://x/sidepanel.html?view=fulltab") === "chrome-extension://x/sidepanel.html?view=fulltab");
  const popupJs = fs.readFileSync(path.join(DIR, "..", "popup.js"), "utf8");
  check("popup.js hides the button when the page is a full tab", popupJs.indexOf("openTabBtn.hidden = true") !== -1);
  check("popup.js checks the ?view=fulltab marker", popupJs.indexOf("isFullTabUrl(window.location.href)") !== -1);
  check("popup.js falls back to chrome.tabs.getCurrent for a directly-opened tab", popupJs.indexOf("chrome.tabs.getCurrent") !== -1);
  check("popup.js click handler refuses to open a tab from a full tab",
    popupJs.indexOf('if (isFullTabUrl(window.location.href)) return;') !== -1);
  check("popup.js opens the full tab with chrome.tabs.create (exactly one call site)",
    (popupJs.match(/chrome\.tabs\.create\(/g) || []).length === 1);
  check("popup.js opens the marked URL (buildFullTabUrl)", popupJs.indexOf("buildFullTabUrl(base)") !== -1);
  const css = fs.readFileSync(path.join(DIR, "..", "popup.css"), "utf8");
  check("popup.css: [hidden] actually hides (author display rules beat the UA style)",
    /\[hidden\]\s*\{\s*display:\s*none\s*!important/.test(css));
  const manifest = JSON.parse(fs.readFileSync(path.join(DIR, "..", "manifest.json"), "utf8"));
  check("manifest name is Phase 2, not Phase 1", manifest.name === "Journal Quartile Extension — Phase 2");
  const panelHtml = fs.readFileSync(path.join(DIR, "..", "sidepanel.html"), "utf8");
  check("sidepanel title is Phase 2, not Phase 1 Spike",
    panelHtml.indexOf("<title>Journal Quartile Extension — Phase 2</title>") !== -1
    && panelHtml.indexOf("Phase 1 Spike") === -1);

  console.log("== 18. Merged DOI / article-link lookup (27 Nov 2026) ==");
  // User correction: DOI and article link are ONE option, as in
  // Phase 1. One input, one tab, one lookup handler that accepts a
  // bare DOI, a doi.org link, or a publisher article URL.
  check("exactly two single-article mode tabs (DOI/link + manual)",
    (panelHtml.match(/id="mode-/g) || []).length === 2
    && panelHtml.indexOf('id="mode-doi"') !== -1
    && panelHtml.indexOf('id="mode-manual"') !== -1);
  check("no mode-link tab, pane-link, input-link or lookup-link ids left",
    panelHtml.indexOf("mode-link") === -1 && panelHtml.indexOf("pane-link") === -1
    && panelHtml.indexOf("input-link") === -1 && panelHtml.indexOf("lookup-link") === -1);
  check("merged pane keeps Check this page", panelHtml.indexOf('id="check-page"') !== -1);
  check("merged pane label is 'DOI or article link'",
    panelHtml.indexOf('<label for="input">DOI or article link</label>') !== -1);
  check("popup.js MODES has only doi and manual",
    /const MODES = \["doi", "manual"\]/.test(popupJs));
  check("popup.js has no link-mode handler or link input left",
    popupJs.indexOf("onLookupLinkClick") === -1 && popupJs.indexOf("input-link") === -1
    && popupJs.indexOf("lookup-link") === -1);
  check("popup.js merged handler tries DOI then a URL",
    popupJs.indexOf("extractDoi(raw)") !== -1 && popupJs.indexOf("resolveDoiFromUrl(raw)") !== -1);
  check("popup.js no longer mentions the old separate tab names",
    popupJs.indexOf("Lookup by DOI") === -1 && popupJs.indexOf("Lookup by article link") === -1);

  console.log("== 19. Minimal UI text (27 Nov 2026) ==");
  // Function oriented, not too much text: short labels only, no
  // long explanations. Result labels (source + year) are data and
  // are NOT trimmed.
  check("no long single-article intro left", panelHtml.indexOf("Pick how you want to find the article") === -1);
  check("no long batch explanation left", panelHtml.indexOf("A missing DOI is fine") === -1);
  check("no long JCR explanation left", panelHtml.indexOf("JCR is subscription-only") === -1);
  check("no long SJR explanation left", panelHtml.indexOf("scimagojr.com") === -1);
  check("no long WoS explanation left", panelHtml.indexOf("Master Journal List export (CSV)") === -1);
  check("no Check-this-page hint paragraph left", panelHtml.indexOf("Already on the article page?") === -1);
  check("short batch heading present", panelHtml.indexOf("Upload a list (Excel / CSV)") !== -1);
  check("short JCR heading present", panelHtml.indexOf("<h2 id=\"jcr-heading\">Import JCR data</h2>") !== -1);
  check("result labels kept: JCR quartile with year", popupJs.indexOf("JCR quartile (\" + year + \")") !== -1);
  check("result labels kept: SJR fallback NOT JCR", popupJs.indexOf("SJR quartile — fallback, NOT JCR") !== -1);

  console.log("== 20. Fast, robust, dynamic (27 Nov 2026) ==");
  // net.js: timeout + one retry, bounded cache with in-flight
  // dedup. popup.js uses it; batch renders per row live.
  const NET = require("../net.js");
  const okJson = (obj) => ({
    ok: true, status: 200,
    text: async () => JSON.stringify(obj),
  });
  // Retry on 429, then succeed.
  let calls429 = 0;
  const fetch429 = async () => {
    calls429++;
    if (calls429 === 1) return { ok: false, status: 429, text: async () => "" };
    return okJson({ ok: true });
  };
  const out429 = await NET.fetchJson("https://example.invalid/x", { fetchFn: fetch429, timeoutMs: 5000, retries: 1 });
  check("fetchJson retries once on 429 then succeeds", out429.ok === true && calls429 === 2, "calls " + calls429);
  // Empty body is retried, then reported as an error, not a blank result.
  let callsEmpty = 0;
  const fetchEmpty = async () => { callsEmpty++; return { ok: true, status: 200, text: async () => "" }; };
  let emptyErr = null;
  try { await NET.fetchJson("https://example.invalid/y", { fetchFn: fetchEmpty, timeoutMs: 5000, retries: 1 }); }
  catch (err) { emptyErr = err; }
  check("fetchJson retries an empty body then throws a short error", callsEmpty === 2 && emptyErr && emptyErr.message.length < 60, "calls " + callsEmpty);
  // Timeout aborts a hung request instead of freezing the panel.
  const fetchHang = () => new Promise(() => {});
  let timeoutErr = null;
  try { await NET.fetchJson("https://example.invalid/z", { fetchFn: fetchHang, timeoutMs: 50, retries: 0 }); }
  catch (err) { timeoutErr = err; }
  check("fetchJson aborts a hung request with a timeout error", timeoutErr && timeoutErr.message === "Request timed out");
  // Persistent failure throws after the retry, never a blank result.
  let callsFail = 0;
  const fetchFail = async () => { callsFail++; throw new Error("network down"); };
  let failErr = null;
  try { await NET.fetchJson("https://example.invalid/w", { fetchFn: fetchFail, timeoutMs: 5000, retries: 1 }); }
  catch (err) { failErr = err; }
  check("fetchJson throws after retries are exhausted", callsFail === 2 && failErr !== null, "calls " + callsFail);
  // Cache: one fetch for two identical lookups; LRU eviction.
  const cache = new NET.ArticleCache(2);
  let fetchCount = 0;
  const loader = async () => { fetchCount++; return { n: fetchCount }; };
  const first = await cache.getOrFetch("doi:10.1/x", loader);
  const second = await cache.getOrFetch("doi:10.1/x", loader);
  check("cache returns the stored result without re-fetching", first === second && fetchCount === 1, "fetches " + fetchCount);
  const [a, b] = await Promise.all([
    cache.getOrFetch("doi:10.1/a", loader),
    cache.getOrFetch("doi:10.1/a", loader),
  ]);
  check("cache dedupes two identical lookups started together", a === b && fetchCount === 2, "fetches " + fetchCount);
  await cache.getOrFetch("doi:10.1/b", loader);
  await cache.getOrFetch("doi:10.1/c", loader);
  check("cache evicts the oldest entry past its limit", cache.get("doi:10.1/x") === undefined && cache.get("doi:10.1/b") !== undefined);
  // Wiring in popup.js and the panel.
  check("popup.js uses net.js fetchJson", popupJs.indexOf("NET.fetchJson(url)") !== -1);
  check("popup.js caches DOI lookups", popupJs.indexOf('articleCache.getOrFetch("doi:"') !== -1);
  check("popup.js caches title lookups", popupJs.indexOf('articleCache.getOrFetch(key, run)') !== -1);
  check("popup.js shows live status while checking the ranking", popupJs.indexOf("Found article. Checking ranking") !== -1);
  check("popup.js publisher fetch has a 10s timeout", popupJs.indexOf("setTimeout(() => controller.abort(), 10000)") !== -1);
  check("popup.js falls back to in-memory storage with a note", popupJs.indexOf("showStorageFallbackNote()") !== -1);
  check("batch renders each row as it arrives", popupJs.indexOf("batchTbodyEl.appendChild(renderBatchRow(result))") !== -1);
  check("sidepanel loads net.js", panelHtml.indexOf('<script src="net.js"></script>') !== -1);
  check("sidepanel has a storage-fallback note element", panelHtml.indexOf('id="storage-note"') !== -1);

  console.log("== 21. Free data without JCR: freedata.js pure functions (27 Nov 2026) ==");
  // WoS category and the SJR fallback come from free sources, not
  // JCR. These are pure URL builders / parsers — no live fetch
  // here, because the MJL search times out and SJR is
  // Cloudflare-blocked from this VM.
  const FREE = require("../freedata.js");
  check("mjlSearchUrl hyphenates the ISSN", FREE.mjlSearchUrl("14712180") === "https://mjl.clarivate.com/search-results?issn=1471-2180");
  check("mjlSearchUrl accepts a hyphenated ISSN", FREE.mjlSearchUrl("1471-2180") === "https://mjl.clarivate.com/search-results?issn=1471-2180");
  check("mjlSearchUrl: Journal of Membrane Science ISSN", FREE.mjlSearchUrl("03767388") === "https://mjl.clarivate.com/search-results?issn=0376-7388");
  const mjlEsci = '<html><body><p>Found 1 results</p><div>Web of Science Core Collection: Emerging Sources Citation Index</div></body></html>';
  const parsedEsci = FREE.parseMjlSearchHtml(mjlEsci);
  check("MJL search: ESCI parses to X", parsedEsci.index === "ESCI" && parsedEsci.category === "X" && parsedEsci.found === "result", JSON.stringify(parsedEsci));
  const mjlScie = '<div>Web of Science Core Collection: Science Citation Index Expanded</div><p>Found 1 results</p>';
  const parsedScie = FREE.parseMjlSearchHtml(mjlScie);
  check("MJL search: SCIE parses to W", parsedScie.index === "SCIE" && parsedScie.category === "W" && parsedScie.found === "result", JSON.stringify(parsedScie));
  const mjlSsci = '<div>Web of Science Core Collection: Social Sciences Citation Index</div>';
  check("MJL search: SSCI parses to W", FREE.parseMjlSearchHtml(mjlSsci).category === "W");
  const mjlAhci = '<div>Web of Science Core Collection: Arts &amp; Humanities Citation Index</div>';
  check("MJL search: AHCI parses to W", FREE.parseMjlSearchHtml(mjlAhci).category === "W");
  // THE FAQ TRAP: the same page lists all four indexes in one
  // sentence with NO colon after "Core Collection". A parser that
  // merely searches for index names always finds SCIE first and
  // is wrong. This one must return no index at all.
  const mjlFaq = '<div>What Is Master Journal List? The Master Journal List includes the complete list of journal in the Web of Science Core Collection (including Science Citation Index Expanded, Social Sciences Citation Index, Arts &amp; Humanities Citation Index, and Emerging Sources Citation Index).</div>';
  const parsedFaq = FREE.parseMjlSearchHtml(mjlFaq);
  check("MJL search: FAQ listing all four indexes does NOT parse as SCIE", parsedFaq.index === "" && parsedFaq.category === "" && parsedFaq.found === "unknown", JSON.stringify(parsedFaq));
  check("MJL search: 0 results is not-indexed", FREE.parseMjlSearchHtml("<p>Found 0 results</p>").found === "not-indexed");
  check("MJL search: result with no index line is unreadable", FREE.parseMjlSearchHtml("<p>Found 1 results</p><div>Some journal</div>").found === "unreadable");
  check("indexNameToCategory: ESCI is X, SCIE/SSCI/AHCI are W",
    FREE.indexNameToCategory("Emerging Sources Citation Index") === "X"
    && FREE.indexNameToCategory("Science Citation Index Expanded") === "W"
    && FREE.indexNameToCategory("SSCI") === "W" && FREE.indexNameToCategory("AHCI") === "W"
    && FREE.indexNameToCategory("") === "");
  check("sjrLatestYear: Nov 2026 -> 2025 (June release)", FREE.sjrLatestYear(new Date("2026-11-27")) === 2025);
  check("sjrLatestYear: Jan 2027 -> 2025 (June not yet passed)", FREE.sjrLatestYear(new Date("2027-01-15")) === 2025);
  check("sjrLatestYear: Jul 2027 -> 2026", FREE.sjrLatestYear(new Date("2027-07-01")) === 2026);
  check("sjrLatestYear: Jun 2027 -> 2026", FREE.sjrLatestYear(new Date("2027-06-01")) === 2026);
  check("sjrExportUrl uses out=csv", FREE.sjrExportUrl(2025) === "https://www.scimagojr.com/journalrank.php?year=2025&type=j&out=csv");
  check("sjrExportUrlAlt uses export=csv", FREE.sjrExportUrlAlt(2025) === "https://www.scimagojr.com/journalrank.php?year=2025&type=j&export=csv");
  check("isSjrCsv accepts a real SJR header", FREE.isSjrCsv("Rank;Title;Issn;SJR;SJR Best Quartile;H index\n1;Nature;0028-0836;17.5;Q1;500"));
  check("isSjrCsv rejects an HTML page", !FREE.isSjrCsv("<!DOCTYPE html><html><body>Verify you are human</body></html>"));
  check("isSjrCsv rejects text without the SJR columns", !FREE.isSjrCsv("Rank,Title,Publisher\n1,Nature,Springer"));
  check("looksBlocked: 403 / 429 are blocks", FREE.looksBlocked("", 403) && FREE.looksBlocked("", 429));
  check("looksBlocked: Cloudflare human check is a block", FREE.looksBlocked("Verify you are human", 200));
  check("looksBlocked: a normal 200 page is not a block", !FREE.looksBlocked("Rank,Title,Issn", 200));
  check("mjlDownloadsPage is the Clarivate collection list page", FREE.mjlDownloadsPage === "https://mjl.clarivate.com/collection-list-downloads");
  check("isMjlLoginWall detects the login wall text", FREE.isMjlLoginWall("You will need a free Master Journal List login to access the download files"));
  check("isMjlLoginWall: a plain page is not a wall", !FREE.isMjlLoginWall("<html><body>Downloads</body></html>"));
  const dlLinks = FREE.findMjlDownloadLinks('<a href="/downloads/scie.xlsx">Science Citation Index Expanded</a><a href="https://mjl.clarivate.com/downloads/esci.xlsx">Emerging Sources Citation Index</a>');
  check("findMjlDownloadLinks resolves relative links and keeps labels", dlLinks.length === 2
    && dlLinks[0].url === "https://mjl.clarivate.com/downloads/scie.xlsx"
    && dlLinks[0].label.indexOf("Science Citation Index Expanded") !== -1, JSON.stringify(dlLinks));
  check("findMjlDownloadLinks ignores non-download links", FREE.findMjlDownloadLinks('<a href="/search">Search</a>').length === 0);
  check("mjlCollectionIndex maps collection labels", FREE.mjlCollectionIndex("Science Citation Index Expanded") === "SCIE"
    && FREE.mjlCollectionIndex("Emerging Sources Citation Index") === "ESCI"
    && FREE.mjlCollectionIndex("Social Sciences Citation Index") === "SSCI"
    && FREE.mjlCollectionIndex("Arts & Humanities Citation Index") === "AHCI"
    && FREE.mjlCollectionIndex("Something else") === "");

  console.log("== 22. Auto-fetch wiring, expiry, file types, UI polish (27 Nov 2026) ==");
  // Expiry: stored WoS/SJR data is reused until the next list is
  // published (about a year) and only re-fetched after expiry.
  check("sjrExpiresAt: Nov 2026 import expires June 2027", DATA.sjrExpiresAt("2026-11-27") === "2027-06-01T00:00:00.000Z");
  check("sjrExpiresAt: Feb 2027 import expires June 2027", DATA.sjrExpiresAt("2027-02-10") === "2027-06-01T00:00:00.000Z");
  check("sjrExpiresAt: Aug 2027 import expires June 2028", DATA.sjrExpiresAt("2027-08-10") === "2028-06-01T00:00:00.000Z");
  check("mjlExpiresAt: Nov 2026 import expires Nov 2027", DATA.mjlExpiresAt("2026-11-27") === "2027-11-27T00:00:00.000Z");
  check("monthsLeft: Nov 2026 to June 2027 is 7", DATA.monthsLeft("2027-06-01T00:00:00.000Z", "2026-11-27") === 7);
  check("monthsLeftText: 7 months left", DATA.monthsLeftText("2027-06-01T00:00:00.000Z", "2026-11-27") === "7 months left");
  check("monthsLeftText: 12 months left for the WoS list", DATA.monthsLeftText("2027-11-27T00:00:00.000Z", "2026-11-27") === "12 months left");
  check("monthsLeftText: 1 month left", DATA.monthsLeftText("2027-06-01T00:00:00.000Z", "2027-05-15") === "1 month left");
  check("monthsLeftText: past expiry is expired", DATA.monthsLeftText("2027-06-01T00:00:00.000Z", "2027-07-01") === "expired");
  check("expiryMonthLabel: June 2027", DATA.expiryMonthLabel("2027-06-01T00:00:00.000Z") === "June 2027");
  check("validUntilText SJR: Valid until June 2027, 7 months left", DATA.validUntilText("2026-11-27", "sjr", "2026-11-27") === "Valid until June 2027, 7 months left");
  check("validUntilText MJL: Valid until November 2027, 12 months left", DATA.validUntilText("2026-11-27", "mjl", "2026-11-27") === "Valid until November 2027, 12 months left");
  check("isExpired: SJR Nov 2026 is expired by Jul 2027, not by Nov 2026",
    DATA.isExpired("2026-11-27", "sjr", "2027-07-01") && !DATA.isExpired("2026-11-27", "sjr", "2026-11-27"));
  // Wiring: auto-fetch toggle, fetch buttons, status lines.
  check("panel has the Auto-fetch free data toggle, on by default",
    panelHtml.indexOf('id="auto-fetch"') !== -1 && panelHtml.indexOf("Auto-fetch free data") !== -1
    && panelHtml.indexOf('<input id="auto-fetch" type="checkbox" checked>') !== -1);
  check("panel has a free-data status line element", panelHtml.indexOf('id="free-data-status"') !== -1);
  check("panel has Get free SJR data button + year select",
    panelHtml.indexOf('id="sjr-fetch"') !== -1 && panelHtml.indexOf("Get free SJR data") !== -1
    && panelHtml.indexOf('id="sjr-year"') !== -1);
  check("panel has Get WoS category (free) button", panelHtml.indexOf('id="mjl-fetch"') !== -1 && panelHtml.indexOf("Get WoS category (free)") !== -1);
  check("panel has Get WoS categories (free) batch button", panelHtml.indexOf('id="batch-mjl"') !== -1 && panelHtml.indexOf("Get WoS categories (free)") !== -1);
  check("popup.js loads the auto-fetch toggle and triggers a first-run fetch",
    popupJs.indexOf("loadAutoFetchToggle()") !== -1 && popupJs.indexOf('sendBackgroundMessage({ type: "autoFetchFreeData"') !== -1);
  check("popup.js SJR button tries background fetch, then the browser-tab download",
    popupJs.indexOf('sendBackgroundMessage({ type: "fetchSjrExport"') !== -1
    && popupJs.indexOf('sendBackgroundMessage({ type: "fetchSjrViaTab"') !== -1);
  check("popup.js SJR button does not re-fetch valid stored data",
    popupJs.indexOf("data already stored") !== -1 && popupJs.indexOf('DATA.isExpired(latest.importedAt, "sjr")') !== -1);
  check("popup.js shows remaining time in the status lines",
    (popupJs.match(/DATA\.validUntilText\(/g) || []).length >= 4);
  check("popup.js batch WoS button checks each row and stores the answer",
    popupJs.indexOf('batchMjlBtn.addEventListener("click"') !== -1
    && popupJs.indexOf("fetchMjlCategory(r.issns)") !== -1);
  check("popup.js stores an expiry with every SJR/MJL import",
    popupJs.indexOf("expires: DATA.sjrExpiresAt(importedAt)") !== -1
    && popupJs.indexOf("expires: DATA.mjlExpiresAt(importedAt)") !== -1);
  check("old 'Unknown, needs WoS / JCR data' wording is gone from panel and popup",
    popupJs.indexOf("needs WoS / JCR data") === -1 && panelHtml.indexOf("needs WoS / JCR data") === -1);
  const bgJs = fs.readFileSync(path.join(DIR, "..", "background.js"), "utf8");
  check("background has the one-click browser-tab SJR download (clearance tab, then worker fetch)",
    bgJs.indexOf("fetchSjrViaTab") !== -1 && bgJs.indexOf("chrome.tabs.create({ url: FREE.sjrHomeUrl, active: false })") !== -1
    && bgJs.indexOf('message.type === "fetchSjrViaTab"') !== -1);
  check("background closes the download tab afterwards", bgJs.indexOf("chrome.tabs.remove(tabId)") !== -1);
  check("background auto-fetch skips a source whose stored data is still valid",
    bgJs.indexOf("storedFreeDataValid(meta, \"sjr\")") !== -1 && bgJs.indexOf("storedFreeDataValid(meta, \"mjl\")") !== -1
    && bgJs.indexOf('"already stored"') !== -1);
  check("background yearly check re-runs early only when stored data expired",
    bgJs.indexOf("FDATA.isExpired(sjrFile.importedAt, \"sjr\")") !== -1
    && bgJs.indexOf("FDATA.isExpired(mjlFile.importedAt, \"mjl\")") !== -1);
  check("background handles fetchMjlCategory and fetchSjrExport messages",
    bgJs.indexOf('message.type === "fetchMjlCategory"') !== -1
    && bgJs.indexOf('message.type === "fetchSjrExport"') !== -1);
  check("manifest is 0.4.1 with MJL and SJR host permissions",
    manifest.version === "0.4.1"
    && manifest.host_permissions.indexOf("https://mjl.clarivate.com/*") !== -1
    && manifest.host_permissions.indexOf("https://www.scimagojr.com/*") !== -1
    && manifest.host_permissions.indexOf("https://scimagojr.com/*") !== -1);
  // File types: each upload button takes only its own types.
  check("shared fileExtension: .XLSX lowercased, no extension is empty",
    SHARED.fileExtension("Report.XLSX") === ".xlsx" && SHARED.fileExtension("data.csv") === ".csv"
    && SHARED.fileExtension("noext") === "" && SHARED.fileExtension("archive.tar.gz") === ".gz");
  check("shared isAllowedFileType: case-insensitive, rejects .pdf for CSV",
    SHARED.isAllowedFileType("a.CSV", [".csv"]) && !SHARED.isAllowedFileType("a.pdf", [".csv"])
    && SHARED.isAllowedFileType("a.xls", [".csv", ".xlsx", ".xls"])
    && !SHARED.isAllowedFileType("a.xlsx", [".csv"]));
  check("article list picker takes .csv, .xlsx, .xls only",
    /id="batch-file"[^>]*accept="\.csv,\.xlsx,\.xls"/.test(panelHtml));
  check("JCR picker takes .csv, .xlsx, .xls only",
    /id="jcr-file"[^>]*accept="\.csv,\.xlsx,\.xls"/.test(panelHtml));
  check("SJR picker takes .csv only",
    /id="sjr-file"[^>]*accept="\.csv"/.test(panelHtml));
  check("WoS list picker takes .csv, .xlsx, .xls only",
    /id="mjl-file"[^>]*accept="\.csv,\.xlsx,\.xls"/.test(panelHtml));
  check("popup.js defines the per-button allowed type lists",
    /const ARTICLE_FILE_TYPES = \["\.csv", "\.xlsx", "\.xls"\]/.test(popupJs)
    && /const JCR_FILE_TYPES = \["\.csv", "\.xlsx", "\.xls"\]/.test(popupJs)
    && /const SJR_FILE_TYPES = \["\.csv"\]/.test(popupJs)
    && /const MJL_FILE_TYPES = \["\.csv", "\.xlsx", "\.xls"\]/.test(popupJs));
  check("popup.js rejects a wrong file type with a short plain error",
    popupJs.indexOf("wrongTypeMessage") !== -1
    && popupJs.indexOf("Use a ${list} file for ${what}.") !== -1);
  check("popup.js checks the type when a file is chosen (all four buttons)",
    popupJs.indexOf("wrongTypeMessage(file, ARTICLE_FILE_TYPES") !== -1
    && popupJs.indexOf("wrongTypeMessage(f, JCR_FILE_TYPES") !== -1
    && popupJs.indexOf("wrongTypeMessage(f, SJR_FILE_TYPES") !== -1
    && popupJs.indexOf("wrongTypeMessage(f, MJL_FILE_TYPES") !== -1);
  check("popup.js SJR import re-checks the type before reading the file",
    popupJs.indexOf("files.find((f) => wrongTypeMessage(f, SJR_FILE_TYPES") !== -1);
  check("spreadsheet reader rejects other types and names all three",
    popupJs.indexOf("Unsupported file type — use a .csv, .xlsx or .xls file.") !== -1);
  // UI polish: buttons (upload stands out), hierarchy, scanability.
  check("upload button stands out: flame gradient, taller, stronger shadow",
    /#batch-run\s*\{[^}]*background:\s*linear-gradient\(135deg, #FF9500, #FF5A1F 55%, #FF2D55\)[^}]*min-height:\s*46px[^}]*box-shadow:\s*0 2px 6px/.test(css));
  check("primary buttons share one style with a soft shadow",
    /\.primary\s*\{[^}]*box-shadow:\s*0 1px 3px/.test(css));
  check("file-choose buttons are consistent inline-flex tap targets",
    /\.file-label\s*\{[^}]*display:\s*inline-flex[^}]*min-height:\s*36px/.test(css));
  check("checkbox toggle has its own rule (not the full-width input style)",
    /\.toggle\s*\{[^}]*display:\s*flex/.test(css) && /\.toggle input\s*\{[^}]*width:\s*auto/.test(css));
  check("sections are divided by a thin rule", css.indexOf("main > section + section") !== -1);
  check("batch table has zebra rows for scanning", css.indexOf("tbody tr:nth-child(even)") !== -1);
  check("result card is lifted with a soft shadow", /\.result\s*\{[^}]*box-shadow:\s*0 1px 4px/.test(css));
  check("mode tabs and ghost buttons meet a 36px tap target",
    /\.mode-tab\s*\{[^}]*min-height:\s*40px/.test(css) && /\.ghost\s*\{[^}]*min-height:\s*36px/.test(css));

  console.log("== 23. Free-data fix: rendered MJL tab, SJR clearance cookie, Flame Q theme (27 Nov 2026) ==");
  // ROOT CAUSE 1 (WoS): the MJL search page is an Angular SPA.
  // A plain fetch returns only the 11 KB HTML shell — verified
  // live from this VM — so the old fetch-and-parse path always
  // answered "unreadable". The label only exists after the
  // page's JavaScript renders in a real browser tab.
  const mjlShell = '<!DOCTYPE html><html lang="en"><head><base href="/"/><meta charset="UTF-8"/></head><body><div id="root"></div><script src="/mjl/main.js"></script></body></html>';
  check("MJL SPA shell HTML has no result info at all (unknown), never a category",
    FREE.parseMjlSearchHtml(mjlShell).found === "unknown" && FREE.parseMjlSearchHtml(mjlShell).category === "");
  // The same parser on RENDERED page text (innerText) finds the label.
  const mjlRendered = 'BMC Microbiology\nFound 1 results\nWeb of Science Core Collection: Science Citation Index Expanded\nISSN / eISSN: 1471-2180';
  const parsedRendered = FREE.parseMjlSearchHtml(mjlRendered);
  check("MJL rendered text: SCIE parses to W (BMC Microbiology, 1471-2180)",
    parsedRendered.index === "SCIE" && parsedRendered.category === "W" && parsedRendered.found === "result", JSON.stringify(parsedRendered));
  const mjlRenderedEsci = 'Found 1 results\nWeb of Science Core Collection: Emerging Sources Citation Index';
  check("MJL rendered text: ESCI parses to X", FREE.parseMjlSearchHtml(mjlRenderedEsci).category === "X");
  const mjlRenderedZero = 'Search results\nFound 0 results';
  check("MJL rendered text: 0 results is not-indexed", FREE.parseMjlSearchHtml(mjlRenderedZero).found === "not-indexed");
  check("freedata exposes the SJR home URL for the clearance tab",
    FREE.sjrHomeUrl === "https://www.scimagojr.com/");
  check("freedata sjrExportUrls returns both spellings",
    eq(FREE.sjrExportUrls(2025), ["https://www.scimagojr.com/journalrank.php?year=2025&type=j&out=csv", "https://www.scimagojr.com/journalrank.php?year=2025&type=j&export=csv"]));
  // ROOT CAUSE 2 (SJR): Cloudflare 403s automated fetches
  // (verified live from this VM for both URL spellings).
  check("looksBlocked: SJR Cloudflare challenge page is a block",
    FREE.looksBlocked("<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>challenges.cloudflare.com</body></html>", 403));
  // Wiring: background worker.
  check("background reads the rendered MJL page in a background tab",
    bgJs.indexOf("fetchMjlCategoryViaTab") !== -1
    && bgJs.indexOf("chrome.tabs.create({ url: FREE.mjlSearchUrl(issn), active: false })") !== -1
    && bgJs.indexOf("parseMjlSearchHtml(text)") !== -1
    && bgJs.indexOf("chrome.scripting.executeScript") !== -1);
  check("background always closes the MJL tab afterwards",
    bgJs.indexOf("chrome.tabs.remove(tabId)") !== -1);
  check("background caches WoS answers in memory so a batch does not re-tab the same journal",
    bgJs.indexOf("mjlCategoryCache") !== -1 && bgJs.indexOf("mjlCategoryCache.has(cacheKey)") !== -1);
  check("background SJR tab path opens the SJR home page (clearance), not the CSV URL",
    bgJs.indexOf("chrome.tabs.create({ url: FREE.sjrHomeUrl, active: false })") !== -1
    && bgJs.indexOf("chrome.tabs.create({ url, active: false })") === -1);
  check("background SJR fetch sends cookies (clearance) with the request",
    bgJs.indexOf('credentials: credentials || "same-origin"') !== -1
    && bgJs.indexOf('fetchTextTimeout(url, 60000, "text/csv, */*", "include")') !== -1);
  check("background auto-fetch retries a blocked SJR download through the browser tab",
    bgJs.indexOf("fetchSjrViaTab(sjrYear)") !== -1);
  check("background keeps the direct MJL fetch as the fast path before the tab",
    bgJs.indexOf("fetchTextTimeout(FREE.mjlSearchUrl(issn)") !== -1);
  // Wiring: popup.
  check("popup gives the MJL tab fallback 90s, not 25s",
    popupJs.indexOf('sendBackgroundMessage({ type: "fetchMjlCategory", issns: issns || [] }, 90000)') !== -1);
  check("popup shows a distinct message when the WoS site blocks the check",
    popupJs.indexOf("Unknown — WoS site blocked the check") !== -1);
  // Flame Q theme: no teal or navy left in the stylesheet.
  check("Flame Q theme: no teal (#0f766e) or navy (#12324f) left in popup.css",
    css.indexOf("#0f766e") === -1 && css.indexOf("#12324f") === -1 && css.indexOf("#0b5e57") === -1);
  check("Flame Q theme: primary buttons use the flame gradient",
    /\.primary\s*\{[^}]*background:\s*linear-gradient\(135deg, #FF9500, #FF5A1F 55%, #FF2D55\)/.test(css));
  check("Flame Q theme: upload button keeps the flame gradient, taller, stronger shadow",
    /#batch-run\s*\{[^}]*background:\s*linear-gradient\(135deg, #FF9500, #FF5A1F 55%, #FF2D55\)[^}]*min-height:\s*46px[^}]*box-shadow:\s*0 2px 6px/.test(css));
  check("Flame Q theme: headings use dark burgundy, progress bar is flame",
    /h1\s*\{[^}]*color:\s*#571B1B/.test(css) && css.indexOf("linear-gradient(90deg, #FF9500, #FF5A1F 55%, #FF2D55)") !== -1);
  check("Flame Q theme: focus ring and toggle use flame orange",
    css.indexOf("rgba(255, 90, 31, 0.18)") !== -1 && css.indexOf("accent-color: #FF5A1F") !== -1);

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  if (failures.length) console.log("Failures:\n - " + failures.join("\n - "));
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(2); });
