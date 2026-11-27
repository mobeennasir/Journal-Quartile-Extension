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
  check("export header has labelled columns", outCsv.startsWith("Title,Journal,Year,ISSN,DOI,JCR quartile (year),Impact Factor - JCR (year),WoS category,SJR quartile - fallback NOT JCR (year),Source,Status / note"));
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
  ];
  requiredLabels.forEach((label) => check(`label present: "${label}"`, html2.indexOf(label) !== -1));
  // "JCR quartile (year)" / "Impact Factor — JCR (year)" were
  // batch-table headers (table removed 27 Nov 2026); the labels
  // still appear in the single-lookup result rows (popup.js).
  const popupJsEarly = fs.readFileSync(path.join(DIR, "..", "popup.js"), "utf8");
  check("single-lookup result still labels the JCR quartile and IF with the year",
    popupJsEarly.indexOf('"JCR quartile (" + year + ")"') !== -1
    && popupJsEarly.indexOf('"Impact Factor — JCR (" + year + ")"') !== -1);
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
  check("popup.js opens tabs with chrome.tabs.create (exactly two call sites: full tab + SJR download page)",
    (popupJs.match(/chrome\.tabs\.create\(/g) || []).length === 2
    && popupJs.indexOf("chrome.tabs.create({ url })") !== -1
    && popupJs.indexOf("chrome.tabs.create({ url, active: true })") !== -1);
  check("popup.js opens the marked URL (buildFullTabUrl)", popupJs.indexOf("buildFullTabUrl(base)") !== -1);
  const css = fs.readFileSync(path.join(DIR, "..", "popup.css"), "utf8");
  check("popup.css: [hidden] actually hides (author display rules beat the UA style)",
    /\[hidden\]\s*\{\s*display:\s*none\s*!important/.test(css));
  const manifest = JSON.parse(fs.readFileSync(path.join(DIR, "..", "manifest.json"), "utf8"));
  check("manifest name is the owner-facing name, no Phase label", manifest.name === "Journal Quartile Extension");
  const panelHtml = fs.readFileSync(path.join(DIR, "..", "sidepanel.html"), "utf8");
  check("sidepanel title is the owner-facing name, no Phase label",
    panelHtml.indexOf("<title>Journal Quartile Extension</title>") !== -1
    && panelHtml.indexOf("Phase 1 Spike") === -1 && panelHtml.indexOf("Phase 2") === -1);

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
  check("batch renders NO rows in the panel (table removed 27 Nov 2026: rows live only in the CSV)",
    popupJs.indexOf("batchTbodyEl") === -1 && popupJs.indexOf("renderBatchRow") === -1
    && panelHtml.indexOf("batch-table") === -1 && panelHtml.indexOf("batch-tbody") === -1);
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
  check("sjrExportUrl uses out=xls (verified working spelling, 27 Nov 2026)", FREE.sjrExportUrl(2025) === "https://www.scimagojr.com/journalrank.php?year=2025&out=xls");
  check("sjrExportUrlAlt uses out=csv (no type=j)", FREE.sjrExportUrlAlt(2025) === "https://www.scimagojr.com/journalrank.php?year=2025&out=csv");
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
    popupJs.indexOf("data already stored") !== -1 && popupJs.indexOf("DATA.sjrFilesCoverYear(meta, year)") !== -1);
  check("popup.js shows remaining time in the status lines",
    (popupJs.match(/DATA\.validUntilText\(/g) || []).length >= 4);
  check("popup.js batch WoS button checks each row (the worker stores the answer)",
    popupJs.indexOf('batchMjlBtn.addEventListener("click"') !== -1
    && popupJs.indexOf("fetchMjlCategory(r.issns, r.journal)") !== -1);
  check("popup.js stores an expiry with every SJR/MJL import",
    popupJs.indexOf("expires: DATA.sjrExpiresAt(importedAt)") !== -1
    && popupJs.indexOf("expires: DATA.mjlExpiresAt(importedAt)") !== -1);
  check("old 'Unknown, needs WoS / JCR data' wording is gone from panel and popup",
    popupJs.indexOf("needs WoS / JCR data") === -1 && panelHtml.indexOf("needs WoS / JCR data") === -1);
  const bgJs = fs.readFileSync(path.join(DIR, "..", "background.js"), "utf8");
  check("background has the one-click browser-tab SJR download (challenged ranking page, in-tab CSV fetch)",
    bgJs.indexOf("fetchSjrViaTab") !== -1 && bgJs.indexOf("fetchSjrCsvInTab") !== -1
    && bgJs.indexOf("chrome.tabs.create({ url: FREE.sjrRankPageUrl(year), active: true })") !== -1
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
  check("manifest is 0.4.2 with MJL and SJR host permissions",
    manifest.version === "0.4.2"
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
  check("batch table CSS removed with the table (no dead .batch-table rules)",
    css.indexOf(".batch-table") === -1 && css.indexOf(".batch-actions") !== -1);
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
  check("freedata exposes the SJR ranking page URL for the tab fetch",
    FREE.sjrRankPageUrl(2025) === "https://www.scimagojr.com/journalrank.php?year=2025");
  check("freedata sjrExportUrls returns the verified spellings (out=xls first)",
    eq(FREE.sjrExportUrls(2025), ["https://www.scimagojr.com/journalrank.php?year=2025&out=xls", "https://www.scimagojr.com/journalrank.php?year=2025&out=csv", "https://www.scimagojr.com/journalrank.php?download=csv&year=2025"]));
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
  check("background SJR tab path opens the challenged ranking page, not the home page",
    bgJs.indexOf("chrome.tabs.create({ url: FREE.sjrRankPageUrl(year), active: true })") !== -1
    && bgJs.indexOf("FREE.sjrHomeUrl") === -1);
  check("background SJR fetch sends cookies (clearance) with the request",
    bgJs.indexOf('credentials: credentials || "same-origin"') !== -1
    && bgJs.indexOf('fetchTextTimeout(url, 15000, "text/csv, */*", "include")') !== -1);
  check("background auto-fetch retries a blocked SJR download through the browser tab",
    bgJs.indexOf("fetchSjrViaTab(sjrYear)") !== -1);
  check("background keeps the direct MJL fetch as the fast path before the tab",
    bgJs.indexOf("fetchTextTimeout(FREE.mjlSearchUrl(issn)") !== -1);
  // Wiring: popup.
  check("popup gives the MJL tab fallback 90s, not 25s",
    popupJs.indexOf('sendBackgroundMessage({ type: "fetchMjlCategory", issns: issns || [], journal: journal || "" }, 90000)') !== -1);
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

  console.log("== 24. SJR fetch fix: in-tab CSV fetch, challenge polling, manual download button (27 Nov 2026) ==");
  // ROOT CAUSE (verified live from this VM): the SJR home page
  // is NOT challenged (HTTP 200, real HTML, datacenter IP),
  // while journalrank.php (HTML and CSV) is 403 "Just a
  // moment...". The old fix opened the home page as a
  // "clearance tab", so no clearance was ever earned — the
  // user's real Chrome failed 4-5 times. And a Lax clearance
  // cookie is never sent on a cross-origin worker fetch, so
  // the worker re-fetch could not have worked even with one.
  check("isChallengeText: Cloudflare challenge page is a challenge",
    FREE.isChallengeText("<title>Just a moment...</title><body>Verify you are human</body>"));
  check("isChallengeText: rendered ranking page is not a challenge",
    !FREE.isChallengeText("SCImago Journal & Country Rank\nJournal Title SJR SJR Best Quartile H index"));
  check("isChallengeText: empty text counts as not cleared (never proceed on nothing)",
    FREE.isChallengeText(""));
  check("background fetches the SJR CSV FROM THE TAB (same origin, cookies attached)",
    bgJs.indexOf("fetchSjrCsvInTab") !== -1
    && bgJs.indexOf('fetch(url, { credentials: "include"') !== -1
    && bgJs.indexOf("FREE.sjrExportUrls(year)") !== -1);
  // The injected fetch itself is one self-contained function
  // (same rule as checkThisPage: no cross-call persistence to
  // fail for the FETCH). The CSV it returns is a different
  // matter — see section 33: an ~11 MB file must not come back
  // in one executeScript result, so the text is stored on the
  // tab's window and read back in small slices instead.
  check("background in-tab fetch is one self-contained function (no cross-call persistence for the fetch)",
    bgJs.indexOf("async function sjrInTabFetch(urls, year, mode, budgetMs)") !== -1
    && bgJs.indexOf("chrome.scripting.executeScript({") !== -1
    && bgJs.indexOf("target: { tabId },") !== -1
    && bgJs.indexOf('args: [urls, year, "store", 90000]') !== -1);
  check("background polls the tab until the challenge clears, then reports 'challenge' if it never does",
    bgJs.indexOf("FREE.isChallengeText(text)") !== -1
    && bgJs.indexOf('error: "challenge", year') !== -1);
  check("background always closes the SJR tab afterwards",
    bgJs.indexOf("fetchSjrViaTab") !== -1 && bgJs.indexOf("chrome.tabs.remove(tabId)") !== -1);
  check("background imports the in-tab CSV text with the normal importer (stored until expiry)",
    bgJs.indexOf("importSjrText(fetched.text, year)") !== -1);
  // Wiring: popup + panel.
  check("popup gives the SJR tab fetch 180s (load + poll + in-tab fetch budgets fit), not 120s",
    popupJs.indexOf('sendBackgroundMessage({ type: "fetchSjrViaTab", year }, 180000)') !== -1);
  check("popup names the real failure reason: challenge vs blocked",
    popupJs.indexOf("SJR asked for a human check that did not clear") !== -1
    && popupJs.indexOf("SJR blocked the download (bot check)") !== -1);
  check("panel has an Open SJR download page button (one-click manual fallback)",
    html2.indexOf('id="sjr-open-page"') !== -1);
  check("popup wires the Open SJR download page button to the ranking page for the chosen year, in a visible tab",
    popupJs.indexOf('getElementById("sjr-open-page")') !== -1
    && popupJs.indexOf("journalrank.php?year=${year}") !== -1
    && popupJs.indexOf("chrome.tabs.create({ url, active: true })") !== -1);

  console.log("== 25. SJR year is automatic from the article's publication year (27 Nov 2026) ==");
  // CURRENT BEHAVIOUR BEFORE THIS FIX (verified in code): the
  // store lookup was already year-correct (exact issn|year, never
  // another year's rank), but NOTHING ever fetched SJR data for
  // the article's year — auto-fetch only downloaded the latest
  // year (sjrLatestYear), and a 2021 article with only 2025 SJR
  // stored showed "No SJR data for this year". The only way to
  // get 2021 data was the manual button with the year select
  // changed by hand. Now showResult/runBatch fetch the article's
  // year themselves when it is missing.
  // Pure helpers (jcr.js).
  check("sjrFileYear: recorded year wins",
    DATA.sjrFileYear({ fileName: "SJR 2025 (auto-fetch)", year: 2021 }) === 2021);
  check("sjrFileYear: auto-fetch file name gives the year",
    DATA.sjrFileYear({ fileName: "SJR 2025 (auto-fetch)" }) === 2025);
  check("sjrFileYear: no year anywhere gives null",
    DATA.sjrFileYear({ fileName: "scimagojr.csv" }) === null);
  const sjrMeta2021 = { sjrFiles: [{ fileName: "SJR 2021 (auto-fetch)", year: 2021, importedAt: "2026-01-15T00:00:00.000Z" }] };
  check("sjrFilesCoverYear: stored unexpired 2021 covers 2021",
    DATA.sjrFilesCoverYear(sjrMeta2021, 2021, "2026-03-01"));
  check("sjrFilesCoverYear: stored 2021 does NOT cover 2019",
    !DATA.sjrFilesCoverYear(sjrMeta2021, 2019, "2026-03-01"));
  check("sjrFilesCoverYear: expired file (imported Jan 2026, checked Dec 2026) does NOT cover",
    !DATA.sjrFilesCoverYear(sjrMeta2021, 2021, "2026-12-01"));
  check("sjrFilesCoverYear: no files covers nothing",
    !DATA.sjrFilesCoverYear({ sjrFiles: [] }, 2021, "2026-03-01"));
  // Latest SJR year rule (June release): data for year Y appears
  // in June Y+1.
  check("sjrLatestYear: 1 June 2026 -> 2025", FREE.sjrLatestYear("2026-06-01") === 2025);
  check("sjrLatestYear: 31 May 2026 -> 2024", FREE.sjrLatestYear("2026-05-31") === 2024);
  check("sjrLatestYear: 15 Jan 2027 -> 2025", FREE.sjrLatestYear("2027-01-15") === 2025);
  // Store behaviour: a year with no SJR rows is "none", never
  // another year's quartile — the auto-fetch must fill the gap,
  // not the lookup.
  const sjrStore2021 = new DATA.MemoryStore();
  await sjrStore2021.putSjr(sjr.rows, { fileName: "sjr", rows: sjr.rows.length });
  check("SJR stored for 2022 only: 2022 lookup finds it (J Plant Growth Regul, Q2)",
    (await sjrStore2021.getRank(["07217595"], 2022)).source === "SJR");
  check("SJR stored for 2022 only: 2019 lookup is none, never 2022's quartile",
    (await sjrStore2021.getRank(["07217595"], 2019)).source === "none");
  // Wiring: popup.js.
  check("popup defines ensureSjrYear and checks stored coverage before fetching",
    popupJs.indexOf("async function ensureSjrYear(year)") !== -1
    && popupJs.indexOf("DATA.sjrFilesCoverYear(meta, y)") !== -1);
  check("popup ensureSjrYear returns not-released for a year after the latest SJR release",
    popupJs.indexOf('if (y > sjrLatestYear()) return { state: "not-released", year: y }') !== -1);
  check("popup ensureSjrYear shares one fetch per year (in-flight dedupe)",
    popupJs.indexOf("sjrFetchInFlight.has(y)") !== -1 && popupJs.indexOf("sjrFetchInFlight.set(y, run)") !== -1);
  check("popup ensureSjrYear tries the background fetch, then the browser-tab download",
    popupJs.indexOf('sendBackgroundMessage({ type: "fetchSjrExport", year: y }, 90000)') !== -1
    && popupJs.indexOf('sendBackgroundMessage({ type: "fetchSjrViaTab", year: y }, 180000)') !== -1);
  check("popup showResult fetches the article's SJR year when the rank is missing",
    popupJs.indexOf('if (autoFetchSjr && data.year && (!rank || rank.source === "none"))') !== -1
    && popupJs.indexOf("const ensured = await ensureSjrYear(parseInt(data.year, 10))") !== -1
    && popupJs.indexOf("rank = await safeGetRank(data.issns, parseInt(data.year, 10))") !== -1);
  check("popup showResult does NOT auto-fetch on restore (last lookup reopen)",
    popupJs.indexOf('showResult(last.data, last.sourceName || "Crossref", { autoFetchSjr: false })') !== -1);
  check("popup SJR row says plainly when the year's data is not released yet",
    popupJs.indexOf('"No SJR data for " + year + " yet"') !== -1);
  check("popup SJR row says plainly when the download could not be done automatically",
    popupJs.indexOf('"SJR " + year + " could not be downloaded automatically — tap Get free SJR data or Open SJR download page"') !== -1);
  check("popup batch fetches each row's publication year when its rank is missing",
    popupJs.indexOf('if (rank && rank.source === "none" && year)') !== -1
    && popupJs.indexOf("await ensureSjrYear(year)") !== -1
    && popupJs.indexOf("sjrYearsFetched.add(year)") !== -1);
  check("popup batch final status lists the SJR years fetched",
    popupJs.indexOf("SJR data fetched for ${[...sjrYearsFetched].sort().join(") !== -1);
  check("panel loads freedata.js so the panel can use sjrLatestYear",
    panelHtml.indexOf('<script src="freedata.js"></script>') !== -1);
  check("popup SJR button pre-check uses stored-year coverage, not just the latest file",
    popupJs.indexOf("DATA.sjrFilesCoverYear(meta, year)") !== -1
    && popupJs.indexOf("DATA.isExpired(latest.importedAt, \"sjr\")") === -1);

  console.log("== 26. Real SJR export format: semicolons, decimal commas, no Year column (27 Nov 2026) ==");
  // ROOT CAUSE of the user's failed import (real file
  // scimagojr_2025_0_ipmx.csv, 11.25 MB, 32,193 journals):
  // parseSjrText returned 0 rows, 32,193 skipped, no warnings.
  // The real export is semicolon-separated with quoted fields
  // and decimal commas — the parser only split on commas, so
  // the whole line was one field and every row failed the
  // ISSN/quartile check. Fixture: the real file's header + first
  // 20 rows, copied verbatim.
  const realSjrText = fs.readFileSync(path.join(DIR, "real-sjr-2025-sample.csv"), "utf8");
  const realSjr = DATA.parseSjrText(realSjrText, { fileName: "scimagojr_2025_0_ipmx.csv" });
  check("real SJR sample: 20 journals -> 38 ISSN rows (18 with two ISSNs, 2 with one)",
    realSjr.rows.length === 38, "got " + realSjr.rows.length);
  check("real SJR sample: no rows skipped, no warnings",
    realSjr.skipped === 0 && realSjr.warnings.length === 0, "skipped=" + realSjr.skipped + " warnings=" + JSON.stringify(realSjr.warnings));
  check("real SJR sample: year comes from the headers (Total Docs. (2025)), no Year column",
    realSjr.rows.every((r) => r.year === 2025));
  const realCaa = realSjr.rows.filter((r) => r.issn === "15424863" || r.issn === "00079235");
  check("real SJR sample: Ca-A Cancer Journal for Clinicians, both ISSNs, Q1, SJR 104.065 (decimal comma, not 104065)",
    realCaa.length === 2 && realCaa.every((r) => r.quartile === "Q1" && Math.abs(r.sjr - 104.065) < 0.001), JSON.stringify(realCaa));
  const realNrmcb = realSjr.rows.find((r) => r.issn === "14710072");
  check("real SJR sample: Nature Reviews Molecular Cell Biology Q1, SJR 35.568",
    realNrmcb && realNrmcb.quartile === "Q1" && Math.abs(realNrmcb.sjr - 35.568) < 0.001, JSON.stringify(realNrmcb));
  check("parseSjrScore: decimal comma 104,065 -> 104.065", DATA.parseSjrScore("104,065") === 104.065);
  check("parseSjrScore: Anglo dot 17.5 -> 17.5", DATA.parseSjrScore("17.5") === 17.5);
  check("parseSjrScore: 0,85 -> 0.85", DATA.parseSjrScore("0,85") === 0.85);
  // Delimiter detection: semicolon file vs comma file.
  check("parseCsv auto-detects semicolons (quoted field with a semicolon inside stays one field)",
    eq(DATA.parseCsv('a;b;"x;y"\n1;2;3\n'), [["a", "b", "x;y"], ["1", "2", "3"]]));
  check("parseCsv still splits comma files",
    eq(DATA.parseCsv('a,b\n1,2\n'), [["a", "b"], ["1", "2"]]));
  // A file with no year anywhere: rows are skipped WITH a warning
  // naming the reason, never silently.
  const noYear = DATA.parseSjrText("Rank,Title,Issn,SJR,SJR Best Quartile\n1,Test Journal,0028-0836,17.5,Q1\n", { fileName: "sjr.csv" });
  check("SJR file with no year anywhere: 0 rows, warning names the missing year",
    noYear.rows.length === 0 && noYear.warnings.some((w) => w.indexOf("No year") !== -1), JSON.stringify(noYear.warnings));
  // Store round-trip on the real sample (year present vs absent):
  // year present -> saved rows look up by ISSN; year absent ->
  // source none, never another year's quartile.
  const realStore = new DATA.MemoryStore();
  await realStore.putSjr(realSjr.rows, { fileName: "scimagojr_2025_0_ipmx.csv", year: 2025, rows: realSjr.rows.length, importedAt: "2026-11-27T00:00:00.000Z", expires: DATA.sjrExpiresAt("2026-11-27") });
  const realMeta = await realStore.getMeta();
  check("store: real sample saved, meta shows 2025 file with June 2027 expiry",
    realMeta.sjrRows === 38 && DATA.sjrFilesCoverYear(realMeta, 2025, "2026-11-27") && !DATA.sjrFilesCoverYear(realMeta, 2024, "2026-11-27"),
    JSON.stringify(realMeta.sjrFiles));
  const storedCaa = await realStore.getRank(["15424863"], 2025);
  check("store: Ca-A 2025 looks up from the store (SJR Q1, saved)",
    storedCaa && storedCaa.source === "SJR" && storedCaa.quartile === "Q1" && Math.abs(storedCaa.sjr - 104.065) < 0.001, JSON.stringify(storedCaa));
  check("store: Ca-A 2024 (year absent) is none, never 2025's quartile",
    (await realStore.getRank(["15424863"], 2024)).source === "none");
  // Wiring: popup says the year is saved, and points the manual
  // import at the missing year when the fetch is blocked.
  check("popup result says 'SJR data Saved for {year}' when the year's SJR data is stored",
    popupJs.indexOf('rows.push(["SJR data", "Saved for " + year])') !== -1);
  check("popup sets the SJR year select to the article's year when the fetch is blocked",
    popupJs.indexOf("sjrYearEl.value = String(data.year)") !== -1);
  check("batch results CSV carries the SJR quartile + year (the panel table is gone, the CSV is the only per-row view)",
    DATA.RESULTS_HEADER.indexOf("SJR quartile - fallback NOT JCR (year)") !== -1
    && DATA.resultsToCsv([{ title: "T", journal: "J", year: "2021", issn: "", doi: "", rank: { source: "SJR", quartile: "Q1", jif: null, wosCategory: "W" }, note: "" }]).indexOf("Q1") !== -1);
  check("popup manual SJR import reads the year from the file name",
    popupJs.indexOf("year: DATA.parseYear(file.name)") !== -1);
  check("popup import failure names how many rows were read but skipped",
    popupJs.indexOf("row(s) read but skipped") !== -1);
  check("background auto-fetch failure names how many rows were skipped",
    bgJs.indexOf("SJR file had no usable rows (${done.skipped} skipped)") !== -1);

  console.log("== 27. Batch Download button only after the whole file finishes (27 Nov 2026) ==");
  // User report: the "Download results as CSV" button was visible
  // while the batch was still on article 2 or 3. Root cause:
  // runBatch unhid the whole #batch-results section (button
  // included) before the first row was checked. The button is
  // now hidden at batch start and shown only after the last row.
  const runBatchSrc = popupJs.slice(popupJs.indexOf("async function runBatch"));
  check("runBatch hides the download button at the start (so a new batch hides the old one)",
    runBatchSrc.indexOf("batchDownloadBtn.hidden = true") !== -1
    && runBatchSrc.indexOf("batchDownloadBtn.hidden = true") < runBatchSrc.indexOf("for (let i = startIndex; i < rows.length; i++)"));
  check("runBatch shows the download button only after the loop, guarded by a finished flag",
    runBatchSrc.indexOf("if (!finished)") !== -1
    && runBatchSrc.indexOf("batchDownloadBtn.hidden = false") !== -1
    && runBatchSrc.indexOf("batchDownloadBtn.hidden = false") > runBatchSrc.indexOf("if (!finished)"));
  check("runBatch re-enables the run buttons in a finally, so a stopped batch does not strand them disabled",
    runBatchSrc.indexOf("} finally {") !== -1
    && runBatchSrc.indexOf("batchRunBtn.disabled = false") !== -1);
  check("runBatch on an early stop says the results are incomplete and the download is hidden",
    runBatchSrc.indexOf("Batch stopped early") !== -1);
  check("download click still guards against an empty batch (no partial CSV from a single lookup)",
    popupJs.indexOf("if (!batchResults.length) return;") !== -1);
  check("single-lookup path never touches the batch download button (only its getElementById declaration sits before runBatch)",
    popupJs.slice(0, popupJs.indexOf("async function runBatch")).split("batchDownloadBtn").length === 2
    && popupJs.slice(0, popupJs.indexOf("async function runBatch")).indexOf('getElementById("batch-download")') !== -1);

  console.log("== 28. Batch: no row table in the panel, results only in the CSV (27 Nov 2026) ==");
  // User correction: the long empty table just makes scrolling
  // too much. During/after a batch the panel shows only the
  // live status ("12 of 65 articles done"), the progress bar,
  // the SJR status line, and the download button when done.
  // The per-row results (SJR quartile + year, JCR quartile,
  // IF, WoS category, source) live ONLY in the downloaded CSV.
  check("panel has no batch table or tbody any more",
    panelHtml.indexOf("batch-table") === -1 && panelHtml.indexOf("batch-tbody") === -1);
  check("runBatch hides the results section at the start and shows it only after the last row",
    runBatchSrc.indexOf("batchResultsEl.hidden = true") !== -1
    && runBatchSrc.indexOf("batchResultsEl.hidden = false") !== -1
    && runBatchSrc.indexOf("batchResultsEl.hidden = false") > runBatchSrc.indexOf("if (!finished)"));
  check("runBatch shows a live 'N of M articles done' status per row, not a table row",
    runBatchSrc.indexOf("`${i + 1} of ${rows.length} articles done`") !== -1
    && runBatchSrc.indexOf("appendChild(renderBatchRow") === -1);
  check("runBatch final status is one short summary line",
    runBatchSrc.indexOf("`Done: ${rows.length} articles.") !== -1);
  check("WoS button handler no longer touches table rows (no children[] index to go stale)",
    popupJs.indexOf("tr.children") === -1 && popupJs.indexOf("batchTbodyEl") === -1);
  check("batch SJR status line exists in the panel and is cleared at batch start",
    panelHtml.indexOf('id="batch-sjr-status"') !== -1
    && runBatchSrc.indexOf('if (batchSjrStatusEl) batchSjrStatusEl.textContent = ""') !== -1);
  // Per-year SJR outcomes, honest and visible.
  check("sjrOutcomeText: ready = already saved, fetched names the row count",
    DATA.sjrOutcomeText("ready", 2021) === "SJR 2021 already saved"
    && DATA.sjrOutcomeText("fetched", 2021, 51835) === "SJR 2021 saved, 51,835 rows");
  check("sjrOutcomeText: blocked/challenge/failed say plainly the auto-download failed and name both manual buttons",
    DATA.sjrOutcomeText("blocked", 2021) === "SJR 2021 could not be downloaded automatically — tap Get free SJR data or Open SJR download page"
    && DATA.sjrOutcomeText("challenge", 2021) === DATA.sjrOutcomeText("blocked", 2021)
    && DATA.sjrOutcomeText("failed", 2021) === DATA.sjrOutcomeText("blocked", 2021));
  check("sjrOutcomeText: not-released names the year",
    DATA.sjrOutcomeText("not-released", 2026) === "No SJR data for 2026 yet");
  check("runBatch does not re-try a year already tried in this run (one SJR tab per year, not per article)",
    runBatchSrc.indexOf("sjrYearOutcomes.has(year)") !== -1
    && runBatchSrc.indexOf("sjrYearOutcomes.set(year, ensured)") !== -1
    && runBatchSrc.indexOf("updateBatchSjrStatus(sjrYearOutcomes)") !== -1);
  check("ensureSjrYear returns the fetched row count so the status can prove the download",
    popupJs.indexOf('return { state: "fetched", year: y, rows: res.rows }') !== -1);
  // CSV is the only per-row view: every row and every column.
  const csvResults = [
    { title: "A", journal: "J1", year: "2021", issn: "0000-0001", doi: "10.1/a", rank: { source: "JCR", quartile: "Q2", jif: 5.07, wosCategory: "W" }, note: "" },
    { title: "B", journal: "J2", year: "2021", issn: "0000-0002", doi: "10.1/b", rank: { source: "SJR", quartile: "Q1", jif: null, sjr: 2.5, wosCategory: "W" }, note: "" },
    { title: "C", journal: "J3", year: "2019", issn: "", doi: "", rank: { source: "none", quartile: "", jif: null, wosCategory: "" }, note: "Not found" },
  ];
  const csvParsed = DATA.parseCsv(DATA.resultsToCsv(csvResults));
  check("batch CSV: header + all 3 rows, SJR quartile in the SJR column, JCR quartile in the JCR column",
    csvParsed.length === 4
    && csvParsed[0].indexOf("SJR quartile - fallback NOT JCR (year)") === 8
    && csvParsed[1][5] === "Q2" && csvParsed[2][8] === "Q1" && csvParsed[3][0] === "C",
    JSON.stringify(csvParsed));

  console.log("== 29. SJR auto-download: out=xls is the working export URL (27 Nov 2026) ==");
  // ROOT CAUSE of the open-close-without-download: the extension
  // fetched ?type=j&out=csv and ?type=j&export=csv, but a plain
  // GET of either returns the HTML ranking page, not a CSV
  // (verified with the page crawler, both spellings). The
  // site's own Download button points to ?year=Y&out=xls, and
  // that URL returns the full semicolon CSV (verified: the 2023
  // file, 86,207 lines). The validation correctly rejected the
  // HTML, so the tab opened, loaded, fetched HTML twice, and
  // closed with no data — exactly the user's symptom.
  check("sjrExportUrls: out=xls first, then out=csv, then download=csv — no type=j, no export=csv",
    eq(FREE.sjrExportUrls(2023), [
      "https://www.scimagojr.com/journalrank.php?year=2023&out=xls",
      "https://www.scimagojr.com/journalrank.php?year=2023&out=csv",
      "https://www.scimagojr.com/journalrank.php?download=csv&year=2023",
    ]), JSON.stringify(FREE.sjrExportUrls(2023)));
  const sjrPageHtml = '<a href="/journalrank.php?year=2023&out=xls"><img src="x.svg">Download</a><a href="https://example.com/other">Other</a><a href="journalrank.php?year=2023">Rankings</a>';
  check("findSjrDownloadLinks: the site's own Download link, resolved absolute, others ignored",
    eq(FREE.findSjrDownloadLinks(sjrPageHtml), ["https://www.scimagojr.com/journalrank.php?year=2023&out=xls"]),
    JSON.stringify(FREE.findSjrDownloadLinks(sjrPageHtml)));
  check("findSjrDownloadLinks: no download links gives an empty list, not a crash",
    eq(FREE.findSjrDownloadLinks("<p>no links here</p>"), []));
  check("background in-tab fetch reads the site's Download link from the rendered page before the hardcoded list",
    bgJs.indexOf('document.querySelectorAll("a[href]")') !== -1
    && bgJs.indexOf("out=(xls|csv)|download=csv") !== -1);
  check("background in-tab fetch reports per-attempt diagnosis (csv/html/http-error/timeout/wrong-year), not a bare blocked",
    bgJs.indexOf('kind: "html"') !== -1 && bgJs.indexOf('kind: "http-error"') !== -1
    && bgJs.indexOf('kind: "wrong-year"') !== -1
    && bgJs.indexOf('"no candidate returned the CSV: " + summary') !== -1);
  check("background worker direct fetch uses the same verified URL list",
    bgJs.indexOf("const urls = FREE.sjrExportUrls(year);") !== -1);
  check("background tab fetch passes the diagnosis detail through to the caller",
    bgJs.indexOf('detail: fetched.detail') !== -1);
  check("background import failure names the 0-row parse instead of a bare not-csv",
    bgJs.indexOf('"downloaded text parsed to 0 rows (" + done.skipped') !== -1
    && bgJs.indexOf('"wrong-year: SJR returned the " + done.wrongYear') !== -1);

  console.log("== 30. Batch: every skipped row carries its reason, in the CSV and the summary (27 Nov 2026) ==");
  // The user's batch said "Done: 65 checked, 57 found" and the 8
  // skipped rows were unexplained. The real skip paths in runBatch
  // are: DOI given but no record in either API, title search with
  // no candidate over the 0.40 overlap threshold, a row with
  // neither DOI nor title, a network error, and a duplicate DOI
  // (found, but the same article as an earlier row). Each one now
  // keeps its reason on the result (status + notFoundKind) through
  // to the CSV "Status / note" column and the finished summary.
  const skipped = [
    { title: "Truncated title on Scholar…", journal: "Nature", year: "2021", issn: "", doi: "",
      rank: { source: "none", quartile: "", jif: null, wosCategory: "" },
      note: "Not found — no title match (best 0.31 overlap, needs 0.40) — title looks truncated, try the full title",
      status: "not-found", notFoundKind: "no-title-match", sjrState: "" },
    { title: "Second paper", journal: "Cell", year: "2020", issn: "", doi: "10.9999/does-not-exist",
      rank: { source: "none", quartile: "", jif: null, wosCategory: "" },
      note: "Not found — no record for this DOI in Crossref or OpenAlex",
      status: "not-found", notFoundKind: "no-doi-record", sjrState: "" },
    { title: "Third paper", journal: "", year: "", issn: "", doi: "",
      rank: { source: "none", quartile: "", jif: null, wosCategory: "" },
      note: "Not found — row has no DOI and no title to search",
      status: "not-found", notFoundKind: "no-doi-or-title", sjrState: "" },
    { title: "Fourth paper", journal: "Science", year: "2019", issn: "", doi: "",
      rank: { source: "none", quartile: "", jif: null, wosCategory: "" },
      note: "Network error: Request timed out",
      status: "not-found", notFoundKind: "network", sjrState: "" },
    { title: "Deep learning", journal: "Nature", year: "2015", issn: "0028-0836", doi: "10.1038/nature14539",
      rank: { source: "JCR", quartile: "Q1", jif: 38.138, wosCategory: "W" },
      note: "Found by DOI", status: "found", notFoundKind: "", sjrState: "" },
    { title: "Deep learning (again)", journal: "Nature", year: "2015", issn: "0028-0836", doi: "10.1038/nature14539",
      rank: { source: "JCR", quartile: "Q1", jif: 38.138, wosCategory: "W" },
      note: "Found by DOI. Same article as row 5 (same DOI) — Scholar lists it twice",
      status: "duplicate", notFoundKind: "", sjrState: "" },
  ];
  check("notFoundBreakdown: 4 not found, broken down by real reason",
    DATA.notFoundBreakdown(skipped) === "4 not found: 1 no title match, 1 no record for DOI, 1 no DOI or title, 1 network error",
    DATA.notFoundBreakdown(skipped));
  check("notFoundBreakdown: duplicates are not counted as not found",
    DATA.notFoundBreakdown(skipped).indexOf("duplicate") === -1);
  check("notFoundBreakdown: nothing skipped gives an empty string",
    DATA.notFoundBreakdown(skipped.filter((r) => r.status !== "not-found")) === "");
  check("notFoundBreakdown: unknown kind is still shown, not dropped",
    DATA.notFoundBreakdown([{ status: "not-found", notFoundKind: "weird-kind" }]) === "1 not found: 1 weird-kind");
  const skippedCsv = DATA.resultsToCsv(skipped);
  check("CSV Status / note column carries each skipped row's reason",
    skippedCsv.indexOf("no title match (best 0.31 overlap, needs 0.40)") !== -1
    && skippedCsv.indexOf("no record for this DOI in Crossref or OpenAlex") !== -1
    && skippedCsv.indexOf("row has no DOI and no title to search") !== -1
    && skippedCsv.indexOf("Network error: Request timed out") !== -1
    && skippedCsv.indexOf("Same article as row 5 (same DOI)") !== -1);
  check("CSV still has every row and every column (6 rows, 11 columns)",
    skippedCsv.trim().split("\n").length === 7
    && skippedCsv.trim().split("\n").every((line) => line.split(",").length >= 11));
  check("runBatch records a notFoundKind on the not-found result and a duplicate status on the repeat DOI",
    popupJs.indexOf('result.notFoundKind = notFoundReason ? notFoundReason.kind : "no-title-match"') !== -1
    && popupJs.indexOf('result.status = "duplicate"') !== -1
    && popupJs.indexOf('result.notFoundKind = "network"') !== -1);
  check("runBatch detects a truncated Scholar title (ends with … or ...) and says so in the reason",
    popupJs.indexOf('/[…\\u2026]$|\\.\\.\\.$/') !== -1
    && popupJs.indexOf("title looks truncated, try the full title") !== -1);
  check("runBatch distinguishes a DOI with no record from a failed check (network)",
    popupJs.indexOf('kind: "no-doi-record"') !== -1
    && popupJs.indexOf('kind: "network", detail: "could not reach Crossref or OpenAlex to check this DOI"') !== -1);
  check("runBatch distinguishes a row with no DOI and no title from a failed title search",
    popupJs.indexOf('kind: "no-doi-or-title"') !== -1);
  check("fetchArticleByDoi returns no-record only when both APIs 404, network otherwise",
    popupJs.indexOf('return { notFound: true, reason: (!sawOther && saw404) ? "no-record" : "network" };') !== -1
    && popupJs.indexOf("err.status === 404") !== -1);
  check("fetchArticleByTitle returns the best overlap so the reason can say how close it came",
    popupJs.indexOf('return { notFound: true, reason: "no-title-match", bestOverlap, bestTitle:') !== -1);
  check("single DOI lookup tells a network failure apart from a missing DOI",
    popupJs.indexOf('found.reason === "network"') !== -1
    && popupJs.indexOf("could not reach Crossref or OpenAlex to check that DOI") !== -1);
  check("single title lookup shows the best overlap in its not-found message",
    popupJs.indexOf("best match ${found.bestOverlap.toFixed(2)} word overlap, needs 0.40") !== -1);
  check("finished batch summary breaks the not-found count down by reason and names duplicates",
    popupJs.indexOf("DATA.notFoundBreakdown(batchResults)") !== -1
    && popupJs.indexOf("duplicate row") !== -1
    && popupJs.indexOf("found but no ranking data") !== -1);
  check("finished summary counts no-ranking only among found rows, not the not-found rows",
    popupJs.indexOf('const foundRows = batchResults.filter((r) => r.status === "found" || r.status === "duplicate");') !== -1);

  console.log("== 31. SJR auto-fetch actually completes: visible tab, budgets that fit, late-store recovery (27 Nov 2026) ==");
  // Root causes, each with live evidence behind it:
  // (a) ?year=Y&out=xls DOES return the full CSV (verified live:
  // the site's own Download link resolves to it, 86,468 lines for
  // 2021) — the URL was never the problem. (b) The tab was opened
  // in the BACKGROUND, where Cloudflare's managed challenge does
  // not reliably clear; the page loads fine visibly. (c) The
  // popup's 120s budget was shorter than the worst-case tab flow
  // (load 20s + poll 40s + in-tab fetch 4x30s = 180s), so it
  // recorded "blocked" while the worker was still fetching.
  // (d) The worker's direct fetch could eat the whole 90s budget
  // (60s x 3 URLs) before the tab path was ever tried.
  const bgJs31 = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
  check("fetchSjrViaTab opens a VISIBLE tab so the challenge can clear (active: true)",
    bgJs31.indexOf('chrome.tabs.create({ url: FREE.sjrRankPageUrl(year), active: true })') !== -1
    && bgJs31.indexOf('chrome.tabs.create({ url: FREE.sjrRankPageUrl(year), active: false })') === -1);
  check("challenge poll is capped at 30s (15 x 2s), not 40s",
    bgJs31.indexOf("for (let i = 0; i < 15; i++)") !== -1);
  check("in-tab CSV fetch has a total ~90s deadline (first candidate up to 60s, rest share the remainder)",
    bgJs31.indexOf("(budgetMs || 90000)") !== -1
    && bgJs31.indexOf("Math.min(60000, remaining)") !== -1);
  check("waitForTabLoad checks the tab's current status first instead of waiting out the full timeout on an already-loaded tab",
    bgJs31.indexOf("const tab = await chrome.tabs.get(tabId);") !== -1
    && bgJs31.indexOf('if (tab && tab.status === "complete") return true;') !== -1);
  check("worker direct SJR fetch fails fast (15s per URL, not 60s) so the tab path is reached inside the popup budget",
    bgJs31.indexOf("fetchTextTimeout(url, 15000, \"text/csv, */*\", \"include\")") !== -1
    && bgJs31.indexOf("fetchTextTimeout(url, 60000, \"text/csv, */*\", \"include\")") === -1);
  check("tab-fetch outcome is recorded in storage so a timed-out popup can recover it",
    bgJs31.indexOf("recordSjrTabFetch(outcome)") !== -1
    && bgJs31.indexOf('"sjrTabFetch:" + outcome.year') !== -1);
  check("ensureSjrYear gives the tab call a 180s budget (load 20s + poll 30s + fetch 90s = 140s worst case)",
    popupJs.indexOf('sendBackgroundMessage({ type: "fetchSjrViaTab", year: y }, 180000)') !== -1);
  check("ensureSjrYear re-checks the store after a timed-out tab call, so a late worker store is still a saved year",
    popupJs.indexOf("const meta2 = await getStore().getMeta();") !== -1
    && popupJs.indexOf("if (DATA.sjrFilesCoverYear(meta2, y)) {") !== -1);
  check("Get free SJR data button uses the same 180s tab budget and the same late-store re-check",
    popupJs.indexOf('sendBackgroundMessage({ type: "fetchSjrViaTab", year }, 180000)') !== -1
    && popupJs.indexOf("if (DATA.sjrFilesCoverYear(meta2, year)) {") !== -1);
  check("batch still tries each distinct SJR year only once per run (dedupe untouched)",
    popupJs.indexOf("if (sjrYearOutcomes.has(year)) {") !== -1
    && popupJs.indexOf("sjrYearOutcomes.set(year, ensured);") !== -1);
  // Real-file round trip: the user's actual 2025 export, parsed
  // and stored through the same store the auto-fetch writes to.
  // 2025 lookup returns Q1; 2021 lookup returns none — never
  // another year's quartile.
  const realSjrFull = fs.readFileSync("/home/hatch/workspace/user/files/scimagojr_2025_0_ipmx.csv", "utf8");
  const realParsed = DATA.parseSjrText(realSjrFull, { fileName: "scimagojr_2025_0_ipmx.csv", year: 2025 });
  check("real 2025 export parses to 51,835 ISSN rows", realParsed.rows.length === 51835, "got " + realParsed.rows.length);
  const rtStore = new DATA.MemoryStore();
  const rtAt = new Date().toISOString();
  await rtStore.putSjr(realParsed.rows, { fileName: "SJR 2025 (auto-fetch)", year: 2025, rows: realParsed.rows.length, importedAt: rtAt, expires: DATA.sjrExpiresAt(rtAt) });
  const rtMeta = await rtStore.getMeta();
  check("stored file covers 2025 and not 2021", DATA.sjrFilesCoverYear(rtMeta, 2025) && !DATA.sjrFilesCoverYear(rtMeta, 2021));
  const rtRank = await rtStore.getRank(["15424863", "00079235"], 2025);
  check("stored 2025 data: Ca-A Cancer Journal for Clinicians is SJR Q1, 104.065",
    rtRank && rtRank.source === "SJR" && rtRank.quartile === "Q1" && rtRank.sjr === 104.065, JSON.stringify(rtRank));
  const rtMiss = await rtStore.getRank(["15424863"], 2021);
  check("stored 2025 data never answers a 2021 lookup", rtMiss && rtMiss.source === "none");
  // The in-tab CSV validation accepts the real export header.
  check("isSjrCsv accepts the real semicolon export header",
    (() => { const FREE = require("../freedata.js"); return FREE.isSjrCsv(realSjrFull); })());

  console.log("== 32. WoS category fetched per article is SAVED in the store (27 Nov 2026) ==");
  // Bug the user saw: every Naqqash article fetched its WoS
  // category in the batch, but the panel showed only "WoS list:
  // 6 journals stored" — the 6 he had checked manually. The
  // save lived in the panel (single lookup + batch button), where
  // a failed write was silently swallowed and a caller could show
  // the category without ever storing it. Now the worker is the
  // single save point: fetchMjlCategory checks the store first,
  // then saves every successful result itself.
  check("worker fetchMjlCategory checks the store BEFORE any live fetch",
    bgJs31.indexOf("new FDATA.IdbStore().getMjl(list)") !== -1
    && bgJs31.indexOf("new FDATA.IdbStore().getMjl(list)") < bgJs31.indexOf('fetchTextTimeout(FREE.mjlSearchUrl(issn), 20000'));
  check("worker fetchMjlCategory saves every successful category result (single save point)",
    bgJs31.indexOf("await saveMjlCategory(result, list, journal);") !== -1
    && bgJs31.indexOf("async function saveMjlCategory(result, issns, journal)") !== -1);
  check("worker save stamps import date + 12-month expiry and saves under every ISSN of the journal",
    bgJs31.indexOf("expires: FDATA.mjlExpiresAt(importedAt)") !== -1
    && bgJs31.indexOf("const rows = (issns || []).filter(Boolean).map((issn) => ({") !== -1);
  check("worker passes the journal name through so the stored row carries it",
    bgJs31.indexOf('fetchMjlCategory(message.issns || (message.issn ? [message.issn] : []), message.journal || "")') !== -1
    && popupJs.indexOf("async function fetchMjlCategory(issns, journal)") !== -1
    && popupJs.indexOf("fetchMjlCategory(data.issns, data.journal)") !== -1
    && popupJs.indexOf("fetchMjlCategory(r.issns, r.journal)") !== -1);
  check("panel no longer saves MJL itself (only the manual file import keeps putMjl)",
    popupJs.indexOf("Master Journal List (automatic)\", rows: rows.length, importedAt: new Date().toISOString(), expires: DATA.mjlExpiresAt(new Date().toISOString()) });") === -1
    || (popupJs.match(/putMjl\(/g) || []).length === 1);
  check("batch WoS summary counts how many were saved, not just found",
    popupJs.indexOf("let checked = 0, found = 0, saved = 0;") !== -1
    && popupJs.indexOf("WoS categories: ${found} found of ${checked} checked${found ? `, ${saved} saved.` : \".\"}`") !== -1);
  // Store behaviour (MemoryStore shares the IdbStore keying).
  const wosStore = new DATA.MemoryStore();
  const wosAt = new Date().toISOString();
  const wosRows = [
    { issn: "14712180", journal: "BMC Microbiology", year: null, quartile: "", jif: null, wosIndex: "SCIE", wosCategory: "W", category: "", sourceFile: "Master Journal List (automatic)", editionYear: null, importedAt: wosAt, expires: DATA.mjlExpiresAt(wosAt) },
    { issn: "14712181", journal: "BMC Microbiology", year: null, quartile: "", jif: null, wosIndex: "SCIE", wosCategory: "W", category: "", sourceFile: "Master Journal List (automatic)", editionYear: null, importedAt: wosAt, expires: DATA.mjlExpiresAt(wosAt) },
    { issn: "09445013", journal: "Microbiological Research", year: null, quartile: "", jif: null, wosIndex: "SCIE", wosCategory: "W", category: "", sourceFile: "Master Journal List (automatic)", editionYear: null, importedAt: wosAt, expires: DATA.mjlExpiresAt(wosAt) },
  ];
  await wosStore.putMjl(wosRows, { fileName: "Master Journal List (automatic)", rows: wosRows.length, importedAt: wosAt, expires: DATA.mjlExpiresAt(wosAt) });
  const wosMeta = await wosStore.getMeta();
  check("saved WoS rows count grows: 3 journals stored, 1 file entry", wosMeta.mjlRows === 3 && wosMeta.mjlFiles.length === 1, JSON.stringify({ rows: wosMeta.mjlRows, files: wosMeta.mjlFiles.length }));
  check("getMjl answers a stored ISSN with no tab (BMC Microbiology print ISSN)",
    eq(await wosStore.getMjl(["14712180"]), { category: "W", index: "SCIE", issn: "14712180" }));
  check("getMjl answers the online ISSN of the same journal",
    eq(await wosStore.getMjl(["14712181"]), { category: "W", index: "SCIE", issn: "14712181" }));
  check("getMjl returns null for an unknown ISSN", (await wosStore.getMjl(["00000000"])) === null);
  check("getRank reads the stored WoS category (next lookup needs no fetch)",
    (await wosStore.getRank(["14712180"], 2021)).wosCategory === "W");
  await wosStore.putMjl(wosRows, { fileName: "Master Journal List (automatic)", rows: wosRows.length, importedAt: wosAt, expires: DATA.mjlExpiresAt(wosAt) });
  const wosMeta2 = await wosStore.getMeta();
  check("re-saving the same ISSNs does not duplicate rows or file entries",
    wosMeta2.mjlRows === 3 && wosMeta2.mjlFiles.length === 1, JSON.stringify({ rows: wosMeta2.mjlRows, files: wosMeta2.mjlFiles.length }));
  const wosOld = new DATA.MemoryStore();
  await wosOld.putMjl([{ issn: "12345678", journal: "Old", year: null, quartile: "", jif: null, wosIndex: "SCIE", wosCategory: "W", category: "", sourceFile: "Master Journal List (automatic)", editionYear: null, importedAt: "2024-01-01T00:00:00.000Z", expires: "2025-01-01T00:00:00.000Z" }], { fileName: "Master Journal List (automatic)", rows: 1, importedAt: "2024-01-01T00:00:00.000Z", expires: "2025-01-01T00:00:00.000Z" });
  check("expired WoS row does not answer getMjl", (await wosOld.getMjl(["12345678"])) === null);
  check("expired WoS row does not answer getRank", (await wosOld.getRank(["12345678"], 2024)).wosCategory === "");
  const wosNoExp = new DATA.MemoryStore();
  await wosNoExp.putMjl([{ issn: "87654321", journal: "Manual", year: null, quartile: "", jif: null, wosIndex: "ESCI", wosCategory: "X", category: "", sourceFile: "manual.csv", editionYear: null }], { fileName: "manual.csv", rows: 1, importedAt: wosAt });
  check("row without an expiry (manual import) stays valid", (await wosNoExp.getMjl(["87654321"])).category === "X");

  console.log("== 33. SJR auto-fetch with clearance present: chunked return, wrong-year rejection, named failure reason (27 Nov 2026) ==");
  // User correction 27 Nov 2026 11:27 PKT: after he downloaded
  // one file manually, Cloudflare was resolved for ALL pages the
  // extension opened in the background — no captcha ever appeared
  // in a background tab, not even once — and the auto-fetch STILL
  // did not work. The challenge was never the blocker.
  //
  // Re-diagnosis, with evidence:
  // (a) The export URLs are correct and year-respected: a plain
  // GET of journalrank.php?year=2020&out=xls returns the real
  // 2020 CSV (verified live 27 Nov 2026, header "Total Docs.
  // (2020)"), and ?out=xls with no year returns the latest
  // (2025) file.
  // (b) The old code returned the whole ~11 MB CSV as ONE
  // executeScript result — the one step that differs from the
  // manual import, which works (FileReader in the panel, no
  // executeScript). MV3 guidance says to keep executeScript
  // results small and to stream many-megabyte payloads in
  // chunks instead. The CSV is now stored on the tab's window
  // and read back in 512 KB slices.
  // (c) Second bug, proven the same day: the site's own Download
  // link is `journalrank.php?out=xls` with NO year parameter —
  // it exports the site's default (latest) year. The old code
  // tried it FIRST, so a 2020 request got the 2025 file, which
  // passed validation and was stored AS 2020. Now the link is
  // used only when it carries the requested year, and every CSV
  // is checked against its own header year before it is
  // accepted.
  const FREE33 = require("../freedata.js");
  check("sjrCsvYear reads the year from the real 2025 export header", FREE33.sjrCsvYear(realSjrFull) === 2025);
  check("sjrCsvYear reads 2020 from a 2020 header", FREE33.sjrCsvYear("Rank;Title;Total Docs. (2020);Total Docs. (3years)\n1;X;5;6") === 2020);
  check("sjrCsvYear returns null when the header carries no year", FREE33.sjrCsvYear("Rank;Title;Total Docs. (3years)\n1;X;5") === null);
  check("sjrCsvYear returns null for empty text", FREE33.sjrCsvYear("") === null);
  // Extract the REAL injected function from background.js and
  // run it with mocks: clearance present (fetch returns 200
  // CSV, no challenge page), document carrying the site's own
  // year-less Download link.
  function extractSjrInTabFetch(src) {
    const marker = "async function sjrInTabFetch(urls, year, mode, budgetMs) {";
    const start = src.indexOf(marker);
    if (start === -1) return null;
    let i = src.indexOf("{", start);
    let depth = 0;
    for (let j = i; j < src.length; j++) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}") { depth--; if (depth === 0) return src.slice(start, j + 1); }
    }
    return null;
  }
  const bgJs33 = fs.readFileSync(path.join(DIR, "..", "background.js"), "utf8");
  const sjrInTabSrc = extractSjrInTabFetch(bgJs33);
  check("sjrInTabFetch is extractable from background.js (self-contained)", sjrInTabSrc !== null && sjrInTabSrc.indexOf("window.__sjrCsv") !== -1);
  const sjrInTabFetch = sjrInTabSrc ? eval("(" + sjrInTabSrc + ")") : null;
  const synth2020 = "Rank;Sourceid;Title;Type;Issn;Publisher;SJR;SJR Best Quartile;H index;Total Docs. (2020)\n1;123;Test Journal;journal;12345678;Test Pub;1,234;Q2;10;5\n";
  const urlsForYear = (y) => [
    "https://www.scimagojr.com/journalrank.php?year=" + y + "&out=xls",
    "https://www.scimagojr.com/journalrank.php?year=" + y + "&out=csv",
    "https://www.scimagojr.com/journalrank.php?download=csv&year=" + y,
  ];
  function mockTab(fetchMap, pageYear) {
    global.document = {
      baseURI: "https://www.scimagojr.com/journalrank.php?year=" + pageYear,
      querySelectorAll: () => [
        { getAttribute: () => "journalrank.php?out=xls", textContent: "Download" },
        { getAttribute: () => "journalrank.php?year=" + pageYear, textContent: String(pageYear) },
      ],
    };
    global.window = {};
    global.fetch = async (url) => ({ ok: true, status: 200, text: async () => fetchMap(String(url)) });
  }
  if (sjrInTabFetch) {
    // Case A — clearance present, latest year: the fetch works,
    // and the return is a SMALL ack (no 11 MB text in it).
    mockTab(() => realSjrFull, 2025);
    const rA = await sjrInTabFetch(urlsForYear(2025), 2025, "store", 90000);
    check("clearance present, 2025: in-tab fetch returns ok with a small ack, not the whole CSV",
      rA.ok === true && !("text" in rA) && rA.length === realSjrFull.length && rA.year === 2025,
      "length " + rA.length + ", year " + rA.year);
    check("clearance present, 2025: the CSV is stored on the tab window for chunked read-back",
      (global.window.__sjrCsv || "") === realSjrFull);
    // Chunked read-back: 512 KB slices rejoin to the identical text.
    const CHUNK = 512 * 1024;
    let back = "";
    for (let s = 0; s < rA.length; s += CHUNK) back += (global.window.__sjrCsv || "").slice(s, s + CHUNK);
    check("chunked read-back (512 KB slices) rejoins to the identical CSV",
      back === realSjrFull, "slices " + Math.ceil(rA.length / CHUNK));
    // Case B — 2020: the site's year-less Download link is
    // skipped and the year-specific URL supplies the 2020 file.
    mockTab((u) => (u.indexOf("year=2020") !== -1 ? synth2020 : realSjrFull), 2020);
    const rB = await sjrInTabFetch(urlsForYear(2020), 2020, "store", 90000);
    check("2020: year-less site link is skipped, year URL supplies the 2020 file",
      rB.ok === true && rB.year === 2020 && (global.window.__sjrCsv || "").indexOf("Total Docs. (2020)") !== -1,
      "year " + rB.year);
    // Case C — 2020, but every URL returns the 2025 file: the
    // wrong-year file is refused, never stored.
    mockTab(() => realSjrFull, 2020);
    const rC = await sjrInTabFetch(urlsForYear(2020), 2020, "store", 90000);
    check("2020 with only the 2025 file on offer: refused as wrong-year, nothing stored",
      rC.ok === false && (rC.tried || []).every((t) => t.kind === "wrong-year") && !global.window.__sjrCsv,
      JSON.stringify((rC.tried || []).map((t) => t.kind)));
    delete global.window;
    delete global.document;
    delete global.fetch;
  }
  // The worker guards the same year check at import time, and
  // the failure reason now travels to the panel instead of a
  // bare "blocked".
  check("worker importSjrText rejects a wrong-year file before storing (header-year guard)",
    bgJs33.indexOf("FREE.sjrCsvYear(text)") !== -1
    && bgJs33.indexOf("wrongYear: fileYear") !== -1);
  check("worker reads the stored CSV back in 512 KB slices, with a single-return fallback",
    bgJs33.indexOf("const CHUNK = 512 * 1024;") !== -1
    && bgJs33.indexOf('func: (s, l) => (window.__sjrCsv || "").slice(s, s + l)') !== -1
    && bgJs33.indexOf("async function fetchSjrCsvInTabSingle(tabId, year)") !== -1);
  check("tab-fetch outcome records the failure detail for late recovery",
    bgJs33.indexOf('detail: outcome.detail || ""') !== -1);
  check("sjrBlockReason maps wrong-year / 403 / timeout / html to one short phrase",
    DATA.sjrBlockReason("no candidate returned the CSV: wrong-year (https://www.scimagojr.com/journalrank.php?year=2020&out=xls)") === "SJR returned another year's file"
    && DATA.sjrBlockReason("no candidate returned the CSV: http-error 403 (https://www.scimagojr.com/journalrank.php?year=2020&out=xls)") === "SJR blocked the download (bot check)"
    && DATA.sjrBlockReason("no candidate returned the CSV: timeout (https://www.scimagojr.com/journalrank.php?year=2020&out=xls)") === "SJR download timed out"
    && DATA.sjrBlockReason("no candidate returned the CSV: html (https://www.scimagojr.com/journalrank.php?year=2020&out=xls)") === "SJR returned a page, not the file"
    && DATA.sjrBlockReason("something else") === "");
  check("sjrOutcomeText appends the short reason to a blocked year, and stays unchanged without one",
    DATA.sjrOutcomeText("blocked", 2021, 0, "no candidate returned the CSV: wrong-year (https://x)") === "SJR 2021 could not be downloaded automatically — tap Get free SJR data or Open SJR download page (SJR returned another year's file)"
    && DATA.sjrOutcomeText("blocked", 2021) === "SJR 2021 could not be downloaded automatically — tap Get free SJR data or Open SJR download page");
  const popupJs33 = fs.readFileSync(path.join(DIR, "..", "popup.js"), "utf8");
  check("ensureSjrYear returns the failure detail instead of a bare blocked",
    popupJs33.indexOf('return { state: "blocked", year: y, detail: res && res.detail ? res.detail : "" };') !== -1);
  check("single lookup shows the short failure reason in the SJR row",
    popupJs33.indexOf("rankingRows(data, rank, sjrNote, sjrDetail)") !== -1
    && popupJs33.indexOf("DATA.sjrBlockReason(sjrDetail)") !== -1);
  check("batch SJR status line carries the failure detail per year",
    popupJs33.indexOf("DATA.sjrOutcomeText(o.state, year, o.rows, o.detail)") !== -1);
  check("Get free SJR data names the real failure reason instead of always saying bot check",
    popupJs33.indexOf("DATA.sjrBlockReason(res.detail)") !== -1
    && popupJs33.indexOf("SJR blocked the download (bot check)") !== -1);

  console.log("== 34. Batch resume actually wired, ownership, security sweep (27 Nov 2026) ==");
  // Resume was dead code before this fix: saveBatchState was never
  // called, runBatch ignored its options, and the Stop/Resume
  // buttons did not exist in the HTML at all.
  check("batchResumePoint returns the next row for a valid saved state",
    DATA.batchResumePoint({ rows: [1, 2, 3], results: [1, 2], nextIndex: 2 }) === 2);
  check("batchResumePoint refuses a finished batch",
    DATA.batchResumePoint({ rows: [1, 2, 3], results: [1, 2, 3], nextIndex: 3 }) === -1);
  check("batchResumePoint refuses results that do not match the saved row count",
    DATA.batchResumePoint({ rows: [1, 2, 3], results: [1], nextIndex: 2 }) === -1);
  check("batchResumePoint refuses null and a zero next index",
    DATA.batchResumePoint(null) === -1 && DATA.batchResumePoint({ rows: [1], results: [], nextIndex: 0 }) === -1);
  const popupJs34 = fs.readFileSync(path.join(DIR, "..", "popup.js"), "utf8");
  check("runBatch saves state after every row",
    popupJs34.indexOf("saveBatchState(rows, batchResults, i + 1);") !== -1);
  check("runBatch takes resume options and starts the loop at startIndex",
    popupJs34.indexOf("async function runBatch(rows, opts)") !== -1
    && popupJs34.indexOf("for (let i = startIndex; i < rows.length; i++)") !== -1
    && popupJs34.indexOf("opts.existingResults") !== -1);
  check("runBatch rebuilds the duplicate map from resumed rows",
    popupJs34.indexOf("if (resuming) batchResults.forEach((r, idx) => {") !== -1);
  check("Stop is checked after each row and breaks the loop",
    popupJs34.indexOf("if (batchStopRequested) { stopped = true; break; }") !== -1);
  check("a stopped batch shows the download and offers resume",
    popupJs34.indexOf("Batch stopped at ${batchResults.length} of ${rows.length} articles") !== -1
    && popupJs34.indexOf("if (batchResumeBtn) batchResumeBtn.hidden = false;") !== -1);
  check("a finished batch clears the saved resume state",
    popupJs34.indexOf("// Finished: no resume state to keep.") !== -1
    && popupJs34.indexOf("clearBatchState();") !== -1);
  check("a new file clears any saved batch state",
    popupJs34.indexOf("// A new file replaces any saved batch: no stale resume offer.") !== -1);
  const panel34 = fs.readFileSync(path.join(DIR, "..", "sidepanel.html"), "utf8");
  check("Stop and Resume buttons exist in the panel",
    panel34.indexOf('id="batch-stop"') !== -1 && panel34.indexOf('id="batch-resume"') !== -1);
  check("panel footer names the owner",
    panel34.indexOf("Built by Mobeen Nasir") !== -1);
  check("panel has no inline scripts or event handlers",
    !/<script(?![^>]*src=)/.test(panel34) && !/ on\w+=/.test(panel34) && panel34.indexOf("javascript:") === -1);
  const manifest34 = JSON.parse(fs.readFileSync(path.join(DIR, "..", "manifest.json"), "utf8"));
  check("manifest name and author are the owner's, no internal Phase label",
    manifest34.name === "Journal Quartile Extension" && manifest34.author === "Mobeen Nasir"
    && manifest34.name.indexOf("Phase") === -1 && String(manifest34.action.default_title).indexOf("Phase") === -1);
  check("manifest is MV3, version 0.4.2, host permissions scoped",
    manifest34.manifest_version === 3 && manifest34.version === "0.4.2"
    && manifest34.host_permissions.indexOf("<all_urls>") === -1
    && manifest34.host_permissions.every((h) => h.indexOf("*://*/*") === -1));
  const pngSize = (file) => {
    const buf = fs.readFileSync(path.join(DIR, "..", "icons", file));
    if (buf.length < 24 || buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null;
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  };
  check("manifest icons exist as real PNGs at 16, 48 and 128 px",
    eq(pngSize("icon16.png"), { w: 16, h: 16 }) && eq(pngSize("icon48.png"), { w: 48, h: 48 }) && eq(pngSize("icon128.png"), { w: 128, h: 128 }));
  check("side panel open trigger uses openPanelOnActionClick",
    fs.readFileSync(path.join(DIR, "..", "background.js"), "utf8").indexOf("openPanelOnActionClick: true") !== -1);
  const readme34 = fs.readFileSync(path.join(DIR, "..", "README.md"), "utf8");
  check("README states version 0.4.2 and has no em or en dashes",
    readme34.indexOf("0.4.2") !== -1 && readme34.indexOf("\u2014") === -1 && readme34.indexOf("\u2013") === -1);
  // Security: no code execution from data, no secrets, no trackers.
  const allJs34 = ["popup.js", "background.js", "jcr.js", "shared.js", "net.js", "freedata.js"]
    .map((f) => fs.readFileSync(path.join(DIR, "..", f), "utf8")).join("\n");
  check("no eval or new Function anywhere in extension code",
    allJs34.indexOf("eval(") === -1 && allJs34.indexOf("new Function") === -1);
  check("no secrets, keys or tracking calls in extension code",
    !/api[_-]?key|password|secret/i.test(allJs34.replace(/MAILTO/g, ""))
    && allJs34.indexOf("analytics") === -1 && allJs34.indexOf("gtag") === -1 && allJs34.indexOf("sentry") === -1);
  check("every value reaching innerHTML in the result is escaped at construction",
    popupJs34.indexOf('escapeHtml(data.title || "—")') !== -1
    && popupJs34.indexOf("escapeHtml(k)") !== -1 && popupJs34.indexOf("escapeHtml(rank.sourceFile)") !== -1);
  check("malicious CSV cells are neutralised, plain numbers are not",
    DATA.resultsToCsv([{ title: '=HYPERLINK("http://evil")', journal: "+cmd", year: "2021", issn: "", doi: "", rank: { source: "none" }, note: "@x" }])
      .indexOf("'=HYPERLINK") !== -1
    && DATA.resultsToCsv([{ title: "2021", journal: "", year: "2021", issn: "", doi: "", rank: { source: "none" }, note: "" }])
      .indexOf("'2021") === -1);
  check("data only goes to the public metadata APIs and the SJR/MJL sites",
    popupJs34.indexOf("api.crossref.org") !== -1 && popupJs34.indexOf("api.openalex.org") !== -1
    && allJs34.indexOf("jcr.clarivate.com") === -1 && allJs34.indexOf("clarivate.com/api") === -1);

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  if (failures.length) console.log("Failures:\n - " + failures.join("\n - "));
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(2); });
