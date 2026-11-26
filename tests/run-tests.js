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
    "Lookup by DOI", "Lookup by article link", "Enter details manually",
    "Upload a list of articles (Excel / CSV)",
    "Import JCR data (for quartile + Impact Factor)",
    "Import SJR data (fallback quartile — NOT JCR)",
    "Import WoS journal list (for category W / X)",
    "Look up", "Upload and check all articles", "Import JCR file",
    "Download results as CSV", "Use the Naqqash test set (67 articles)",
    "Data year this export covers",
    "JCR quartile (year)", "Impact Factor — JCR (year)",
  ];
  requiredLabels.forEach((label) => check(`label present: "${label}"`, html2.indexOf(label) !== -1));
  const js = fs.readFileSync(path.join(DIR, "..", "popup.js"), "utf8");
  check("result label: SJR quartile — fallback, NOT JCR", js.indexOf("SJR quartile — fallback, NOT JCR") !== -1);
  check("result label: No JCR data for this year", js.indexOf("No JCR data for this year") !== -1);
  check("no bare 'Submit' or 'Go' button labels", !/>(Submit|Go)</.test(html2));

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  if (failures.length) console.log("Failures:\n - " + failures.join("\n - "));
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(2); });
