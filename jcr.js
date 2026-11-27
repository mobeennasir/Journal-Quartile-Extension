// jcr.js — Phase 2 ranking data for the Journal Quartile Extension.
//
// What this file does (pure data logic, no DOM, no network):
//   * Parse JCR export files (category export, per-journal "All Years"
//     export, and a simple canonical format) into rows keyed by
//     ISSN + data year: { quartile, JIF, WoS category, journal }.
//   * Parse SJR CSV exports (scimagojr.com download) into the same
//     keyed shape, clearly marked as SJR, never as JCR.
//
// REAL SJR FORMAT — verified 27 Nov 2026 against the user's own
// download (scimagojr_2025_0_ipmx.csv, 11.25 MB, 32,193 journals):
// semicolon-separated, quoted fields, decimal commas in numbers
// (SJR 104,065 = 104.065), header
// "Rank;Sourceid;Title;Type;Issn;Publisher;...;SJR;SJR Best
// Quartile;H index;Total Docs. (2025);...;Categories;Areas",
// Issn holds TWO ISSNs ("15424863, 00079235"), Categories holds
// e.g. "Hematology (Q1); Oncology (Q1)", and there is NO Year
// column — the year comes from the headers ("Total Docs.
// (2025)") or the file name. The parser auto-detects the
// delimiter and reads the year from the headers, so a real
// export imports as-is. SJR rows are stored BY YEAR (one stored
// set per data year, expiry next June); a lookup uses the
// article's year and never another year's quartile.
//   * Parse a Web of Science Master Journal List (MJL) export into
//     ISSN -> WoS index (SCIE/SSCI/AHCI/ESCI) -> category W/X.
//   * Look a journal/year up in those stores: JCR first, SJR only
//     as a labelled fallback, never another year's rank.
//   * Parse an article-list CSV (title/journal/year/DOI/ISSN) and
//     build a results CSV for export.
//
// Loaded by the lookup page (sidepanel.html, plain <script>) and by
// the Node unit tests (module.exports guard at the bottom). It must
// stay dependency-free and MV3-safe: no remote code, no fetch.
//
// JCR FORMAT WARNING — read before trusting an import:
//   No real JCR export file has been seen yet (Naqqash has not sent
//   a sample). The importer therefore matches columns by name, not
//   by position, and accepts several known JCR column spellings —
//   but the exact columns of a real JCR category export / "All
//   Years" export are NOT verified against a real file. The first
//   real import must be checked row by row (the UI shows how many
//   rows were read, how many skipped, and a sample of what was
//   stored). See README "Phase 2 — JCR import, untested format".
//   Do NOT scrape JCR. Do NOT hard-code any credential. JCR data
//   comes only from a file the user uploads themselves.

(function (root) {
  "use strict";

  // ---------- ISSN helpers ----------

  // "0028-0836" -> "00280836"; "0028 0836" -> "00280836"; "" -> "".
  function normaliseIssn(value) {
    if (value === null || value === undefined) return "";
    const s = String(value).trim().toUpperCase().replace(/[^0-9X]/g, "");
    return s.length === 8 ? s : "";
  }

  function formatIssn(compact) {
    if (!compact || compact.length !== 8) return compact || "";
    return compact.slice(0, 4) + "-" + compact.slice(4);
  }

  // "0028-0836 (print), 1476-4687 (electronic)" -> ["00280836","14764687"]
  function parseIssnList(value) {
    if (!value) return [];
    const out = [];
    String(value).split(/[,;]/).forEach((part) => {
      const issn = normaliseIssn(part);
      if (issn && out.indexOf(issn) === -1) out.push(issn);
    });
    return out;
  }

  // ---------- CSV parsing (quoted fields, CRLF, BOM) ----------

  // The real SCImago export (seen 27 Nov 2026, scimagojr_2025
  // file, 32,193 journals) is SEMICOLON-separated with quoted
  // fields and decimal commas ("104,065" = 104.065) — NOT the
  // comma CSV the parser first assumed. So the delimiter is
  // auto-detected from the first line: separators outside quotes
  // are counted, and ';' wins when it outnumbers ','. Comma
  // files (JCR, MJL, article lists, synthetic tests) are
  // unaffected — their first lines have more commas than
  // semicolons outside quotes.
  function detectDelimiter(line) {
    let commas = 0, semis = 0, inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) { if (ch === '"') inQuotes = false; }
      else if (ch === '"') { inQuotes = true; }
      else if (ch === ",") { commas++; }
      else if (ch === ";") { semis++; }
    }
    return semis > commas ? ";" : ",";
  }

  function parseCsv(text) {
    if (!text) return [];
    let s = String(text).replace(/^\uFEFF/, "");
    const firstLine = s.split(/\r?\n/)[0] || "";
    const delim = detectDelimiter(firstLine);
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inQuotes) {
        if (ch === '"') {
          if (s[i + 1] === '"') { field += '"'; i++; }
          else { inQuotes = false; }
        } else {
          field += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === delim) {
        row.push(field); field = "";
      } else if (ch === "\n") {
        row.push(field); field = "";
        rows.push(row); row = [];
      } else if (ch === "\r") {
        // CRLF: the \n that follows ends the row; lone \r is ignored.
      } else {
        field += ch;
      }
    }
    if (field !== "" || row.length) { row.push(field); rows.push(row); }
    // Drop trailing empty rows.
    while (rows.length && rows[rows.length - 1].every((c) => String(c).trim() === "")) rows.pop();
    return rows;
  }

  function csvEscape(value) {
    const s = value === null || value === undefined ? "" : String(value);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function rowsToCsv(header, rows) {
    const lines = [header.map(csvEscape).join(",")];
    rows.forEach((r) => lines.push(r.map(csvEscape).join(",")));
    return lines.join("\r\n") + "\r\n";
  }

  // ---------- Header matching ----------

  function normaliseHeader(h) {
    return String(h || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  // headers: raw header strings. candidates: normalised fragments to
  // look for, in priority order. Returns the column index or -1.
  // Exact matches win over substring matches — so a search for
  // "year" does not grab a "5 Year Impact Factor" column, and a
  // search for "issn" does not grab "eissn" when a real ISSN
  // column exists.
  function findColumn(headers, candidates) {
    const norm = headers.map(normaliseHeader);
    for (const cand of candidates) {
      for (let i = 0; i < norm.length; i++) {
        if (norm[i] === cand) return i;
      }
    }
    for (const cand of candidates) {
      for (let i = 0; i < norm.length; i++) {
        if (norm[i].indexOf(cand) !== -1) return i;
      }
    }
    return -1;
  }

  // ---------- Value parsing ----------

  function parseQuartile(value) {
    if (value === null || value === undefined) return "";
    const m = String(value).trim().toUpperCase().match(/Q\s*([1-4])/);
    if (m) return "Q" + m[1];
    const n = String(value).trim().match(/^([1-4])$/);
    return n ? "Q" + n[1] : "";
  }

  function parseJif(value) {
    if (value === null || value === undefined) return null;
    const n = parseFloat(String(value).replace(/,/g, "").trim());
    return Number.isFinite(n) ? n : null;
  }

  // SJR score from the real SCImago export: a DECIMAL COMMA
  // ("104,065" = 104.065, "0,85" = 0.85). Do NOT use parseJif
  // here — it strips commas, which would store 104065 instead
  // of 104.065. A value with a dot is Anglo format ("17.5") and
  // is parsed as-is, commas stripped.
  function parseSjrScore(value) {
    if (value === null || value === undefined) return null;
    const s = String(value).trim();
    if (!s) return null;
    const n = parseFloat(s.indexOf(".") === -1 ? s.replace(",", ".") : s.replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }

  function parseYear(value) {
    if (value === null || value === undefined) return null;
    const m = String(value).match(/(19|20)\d{2}/);
    return m ? parseInt(m[0], 10) : null;
  }

  // ---------- WoS category (HEC W/X, HEC part otherwise skipped) ----------
  // W = SCIE / SSCI / AHCI. X = ESCI (Emerging). Settled 26 Nov 2026
  // against HEC Policy 2024 v2.0 (WoS/JCR primary, NOT SJR; the
  // relayed "Emerging = Y" was a mishearing — X is correct).
  // NOTE: HEC's X also covers some Pakistani Scopus journals that
  // meet extra criteria; that part is skipped for now, per plan.

  function wosCategoryFromIndex(indexValue) {
    if (!indexValue) return "";
    const v = String(indexValue).trim().toUpperCase();
    if (v === "SCIE" || v === "SSCI" || v === "AHCI" ||
        v.indexOf("SCIENCE CITATION INDEX EXPANDED") !== -1 ||
        v.indexOf("SOCIAL SCIENCES CITATION INDEX") !== -1 ||
        v.indexOf("ARTS & HUMANITIES CITATION INDEX") !== -1 ||
        v.indexOf("ARTS AND HUMANITIES CITATION INDEX") !== -1) return "W";
    if (v === "ESCI" || v.indexOf("EMERGING SOURCES CITATION INDEX") !== -1) return "X";
    return "";
  }

  // Journal-title column: a plain substring search for "journal"
  // would wrongly grab "Journal Impact Factor". Exact names win;
  // a substring hit must not contain "impact" or "citation".
  function findJournalColumn(headers) {
    const norm = headers.map(normaliseHeader);
    const exact = ["journaltitle", "journalname", "journal", "sourcetitle", "title"];
    for (const cand of exact) {
      for (let i = 0; i < norm.length; i++) if (norm[i] === cand) return i;
    }
    for (let i = 0; i < norm.length; i++) {
      if (norm[i].indexOf("journal") !== -1 &&
          norm[i].indexOf("impact") === -1 &&
          norm[i].indexOf("citation") === -1) return i;
    }
    return -1;
  }

  // ---------- JCR parsing ----------

  // Accepts three shapes (detected by header, never by position):
  //  A. Canonical simple format (documented in README, for a user
  //     who pastes JCR numbers into a spreadsheet themselves):
  //     issn, year, quartile, jif, category, journal, wos_index
  //  B. JCR category export (Clarivate): Journal name, ISSN, eISSN,
  //     Journal Impact Factor, JIF Quartile, Journal Citation
  //     Indicator, Category, Edition/Index... Year comes from the
  //     "data year this export covers" the user picks in the UI,
  //     because a category export is one JCR edition (one data year).
  //  C. Per-journal "All Years" export: Year, Journal Impact
  //     Factor, Journal Citation Indicator, ... (quartile column
  //     if present). ISSN comes from the file name / a column if
  //     present; if the file has no ISSN at all, rows are stored
  //     under the journal title and matched by title, flagged as
  //     title-matched (less reliable than ISSN).
  //  D. MJL export (no JIF/quartile columns, but a WoS index
  //     column): handled by parseMJLText below, not here.
  //
  // Returns { kind: "jcr", rows, skipped, warnings }.
  // A row: { issn, journal, year, quartile, jif, wosIndex,
  //          wosCategory, category, sourceFile, editionYear }.
  function parseJcrText(text, opts) {
    opts = opts || {};
    const editionYear = opts.editionYear || null; // data year the export covers
    const sourceFile = opts.fileName || "";
    const table = parseCsv(text);
    const out = { kind: "jcr", rows: [], skipped: 0, warnings: [] };
    if (!table.length) { out.warnings.push("File is empty."); return out; }

    // Find the header row: first row containing an ISSN-like or
    // journal-like header. JCR exports sometimes have title lines
    // above the header row.
    let headerIdx = -1;
    for (let i = 0; i < Math.min(table.length, 10); i++) {
      const norm = table[i].map(normaliseHeader);
      if (norm.indexOf("issn") !== -1 || norm.indexOf("eissn") !== -1 ||
          norm.some((h) => h.indexOf("journal") !== -1 && h.indexOf("impactfactor") === -1) ||
          norm.indexOf("year") !== -1) { headerIdx = i; break; }
    }
    if (headerIdx === -1) {
      out.warnings.push("No header row found (looked for ISSN / journal / year columns).");
      out.skipped = table.length;
      return out;
    }
    const headers = table[headerIdx];
    const colIssn = findColumn(headers, ["issn", "eissn"]);
    const colEissn = findColumn(headers, ["eissn"]);
    const colJournal = findJournalColumn(headers);
    const colYear = findColumn(headers, ["jcryear", "year", "datayear"]);
    const colQuartile = findColumn(headers, ["jifquartile", "quartile", "jcrquartile"]);
    const colJif = findColumn(headers, ["journalimpactfactor", "impactfactor", "jif"]);
    const colCategory = findColumn(headers, ["category", "woscategory", "subjectcategory"]);
    const colIndex = findColumn(headers, ["wosindex", "edition", "index", "woscollection"]);
    const colIssnL = findColumn(headers, ["issnl"]);

    if (colIssn === -1 && colJournal === -1) {
      out.warnings.push("No ISSN column and no journal-title column found — cannot key the rows.");
      out.skipped = table.length - headerIdx - 1;
      return out;
    }
    if (colQuartile === -1 && colJif === -1) {
      out.warnings.push("No quartile column and no Impact Factor column found — nothing to store. (If this is a Master Journal List export, use the WoS journal list import instead.)");
      out.skipped = table.length - headerIdx - 1;
      return out;
    }

    for (let r = headerIdx + 1; r < table.length; r++) {
      const row = table[r];
      if (!row || row.every((c) => String(c).trim() === "")) continue;
      const cell = (i) => (i >= 0 && i < row.length ? String(row[i]).trim() : "");
      const issns = [];
      [colIssn, colEissn, colIssnL].forEach((c) => {
        parseIssnList(cell(c)).forEach((x) => { if (issns.indexOf(x) === -1) issns.push(x); });
      });
      const journal = cell(colJournal);
      const year = colYear >= 0 ? parseYear(cell(colYear)) : editionYear;
      const quartile = parseQuartile(cell(colQuartile));
      const jif = parseJif(cell(colJif));
      const wosIndex = cell(colIndex);
      const wosCategory = wosCategoryFromIndex(wosIndex) || "";
      const category = cell(colCategory);
      if (!issns.length && !journal) { out.skipped++; continue; }
      if (!year) { out.skipped++; continue; }
      if (!quartile && jif === null) { out.skipped++; continue; }
      // One stored row per ISSN so lookup by either ISSN works.
      // Rows with no ISSN are stored once, keyed by journal title.
      const keys = issns.length ? issns : [""];
      keys.forEach((issn) => {
        out.rows.push({
          issn: issn, journal: journal, year: year,
          quartile: quartile, jif: jif,
          wosIndex: wosIndex, wosCategory: wosCategory,
          category: category, sourceFile: sourceFile,
          editionYear: editionYear || year,
        });
      });
    }
    return out;
  }

  // ---------- MJL parsing (WoS index only, no metrics) ----------
  // Columns (Clarivate Master Journal List export): Journal Title,
  // ISSN, eISSN, Web of Science Index (SCIE/SSCI/AHCI/ESCI), ...
  function parseMJLText(text, opts) {
    opts = opts || {};
    const sourceFile = opts.fileName || "";
    const table = parseCsv(text);
    const out = { kind: "mjl", rows: [], skipped: 0, warnings: [] };
    if (!table.length) { out.warnings.push("File is empty."); return out; }
    let headerIdx = -1;
    for (let i = 0; i < Math.min(table.length, 10); i++) {
      const norm = table[i].map(normaliseHeader);
      if (norm.some((h) => h.indexOf("index") !== -1) ||
          norm.indexOf("issn") !== -1) { headerIdx = i; break; }
    }
    if (headerIdx === -1) {
      out.warnings.push("No header row found (looked for an index / ISSN column).");
      out.skipped = table.length;
      return out;
    }
    const headers = table[headerIdx];
    const colIssn = findColumn(headers, ["issn", "eissn"]);
    const colEissn = findColumn(headers, ["eissn"]);
    const colJournal = findJournalColumn(headers);
    const colIndex = findColumn(headers, ["webofscienceindex", "wosindex", "index", "edition"]);
    if (colIndex === -1) {
      out.warnings.push("No WoS index column found — this does not look like a Master Journal List export.");
      out.skipped = table.length - headerIdx - 1;
      return out;
    }
    for (let r = headerIdx + 1; r < table.length; r++) {
      const row = table[r];
      if (!row || row.every((c) => String(c).trim() === "")) continue;
      const cell = (i) => (i >= 0 && i < row.length ? String(row[i]).trim() : "");
      const issns = [];
      [colIssn, colEissn].forEach((c) => {
        parseIssnList(cell(c)).forEach((x) => { if (issns.indexOf(x) === -1) issns.push(x); });
      });
      const wosCategory = wosCategoryFromIndex(cell(colIndex));
      if (!issns.length && !cell(colJournal)) { out.skipped++; continue; }
      if (!wosCategory) { out.skipped++; continue; }
      (issns.length ? issns : [""]).forEach((issn) => {
        out.rows.push({
          issn: issn, journal: cell(colJournal), year: null,
          quartile: "", jif: null, wosIndex: cell(colIndex),
          wosCategory: wosCategory, category: "", sourceFile: sourceFile,
          editionYear: null,
        });
      });
    }
    return out;
  }

  // ---------- SJR parsing ----------
  // SJR CSV (scimagojr.com download, human download in a browser —
  // automated fetch is Cloudflare-blocked, verified 27 Nov 2026):
  // columns include Title, Issn, SJR, SJR Best Quartile, H index,
  // Total Docs., Categories, Area, Year (in the sjrdata republish:
  // year, rank, sourceid, title, type, issn, publisher, sjr,
  // sjr_best_quartile, h_index, categories, area).
  // A row: { issn, journal, year, quartile (best), sjr, categories }.
  function parseSjrText(text, opts) {
    opts = opts || {};
    const sourceFile = opts.fileName || "";
    const table = parseCsv(text);
    const out = { kind: "sjr", rows: [], skipped: 0, warnings: [] };
    if (!table.length) { out.warnings.push("File is empty."); return out; }
    let headerIdx = -1;
    for (let i = 0; i < Math.min(table.length, 10); i++) {
      const norm = table[i].map(normaliseHeader);
      if (norm.indexOf("issn") !== -1 || norm.some((h) => h.indexOf("sjrbestquartile") !== -1)) { headerIdx = i; break; }
    }
    if (headerIdx === -1) {
      out.warnings.push("No header row found (looked for ISSN / SJR Best Quartile columns).");
      out.skipped = table.length;
      return out;
    }
    const headers = table[headerIdx];
    const colIssn = findColumn(headers, ["issn"]);
    const colJournal = findJournalColumn(headers);
    // Year column: EXACT match only. The real SJR headers contain
    // "Total Docs. (3years)", whose normalised form contains
    // "year" — a substring search would take that column and read
    // document counts (1955, 1971, ...) as years. The real export
    // has no Year column at all; the year comes from the headers
    // ("Total Docs. (2025)") or the file name instead (below).
    const colYear = headers.findIndex((h) => normaliseHeader(h) === "year");
    const colQuartile = findColumn(headers, ["sjrbestquartile", "bestquartile", "quartile"]);
    const colSjr = findColumn(headers, ["sjr"]);
    const colCategories = findColumn(headers, ["categories", "category"]);
    if (colQuartile === -1) {
      out.warnings.push("No quartile column found (looked for SJR Best Quartile).");
      out.skipped = table.length - headerIdx - 1;
      return out;
    }
    // The year these rows describe. The real SCImago export has
    // NO Year column — the year lives in the headers ("Total
    // Docs. (2025)") — so: Year column first, then the year
    // passed in (file name / year select / auto-fetch), then a
    // year found in any header cell. Without a year the rows
    // cannot be stored year-correctly, so they are skipped and
    // the warning says why instead of a silent "no data".
    let fileYear = opts.year ? parseYear(String(opts.year)) : null;
    if (!fileYear) {
      for (const h of headers) {
        const y = parseYear(h);
        if (y) { fileYear = y; break; }
      }
    }
    if (colYear === -1 && !fileYear) {
      out.warnings.push("No year in this file: no Year column, and no year in the headers or file name. SJR data is stored by year, so the rows were skipped.");
    }
    for (let r = headerIdx + 1; r < table.length; r++) {
      const row = table[r];
      if (!row || row.every((c) => String(c).trim() === "")) continue;
      const cell = (i) => (i >= 0 && i < row.length ? String(row[i]).trim() : "");
      const issns = parseIssnList(cell(colIssn));
      const year = colYear >= 0 ? parseYear(cell(colYear)) : fileYear;
      const quartile = parseQuartile(cell(colQuartile));
      if (!issns.length || !year || !quartile) { out.skipped++; continue; }
      issns.forEach((issn) => {
        out.rows.push({
          issn: issn, journal: cell(colJournal), year: year,
          quartile: quartile, sjr: parseSjrScore(cell(colSjr)),
          categories: cell(colCategories), sourceFile: sourceFile,
        });
      });
    }
    return out;
  }

  // ---------- Article-list parsing (batch upload) ----------
  // Columns understood (any subset; missing columns are tolerated):
  // title, journal, year, doi, issn, volume/pages. Fuzzy header
  // match, so the Naqqash Scholar CSV (n,title,journal,volume_pages,
  // year,doi) works as-is, and so does a hand-made sheet.
  function parseArticleListText(text) {
    const table = parseCsv(text);
    const out = { rows: [], skipped: 0, warnings: [] };
    if (!table.length) { out.warnings.push("File is empty."); return out; }
    let headerIdx = -1;
    for (let i = 0; i < Math.min(table.length, 5); i++) {
      const norm = table[i].map(normaliseHeader);
      if (norm.indexOf("title") !== -1 || norm.indexOf("journal") !== -1) { headerIdx = i; break; }
    }
    if (headerIdx === -1) {
      out.warnings.push("No header row found (looked for a title / journal column). First row is treated as data only if it has a title.");
      // Fall back: treat every row as [title, journal, year, doi].
      table.forEach((row) => {
        if (!row || row.every((c) => String(c).trim() === "")) return;
        out.rows.push({
          title: String(row[0] || "").trim(),
          journal: String(row[1] || "").trim(),
          year: parseYear(row[2]), doi: "",
          issn: "", volumePages: String(row[3] || "").trim(),
        });
      });
      return out;
    }
    const headers = table[headerIdx];
    const colTitle = findColumn(headers, ["title", "articletitle", "paper"]);
    const colJournal = findColumn(headers, ["journal", "journaltitle", "sourcetitle", "publication"]);
    const colYear = findColumn(headers, ["year", "publicationyear", "pubyear"]);
    const colDoi = findColumn(headers, ["doi"]);
    const colIssn = findColumn(headers, ["issn"]);
    const colVol = findColumn(headers, ["volumepages", "volume", "pages", "volumeissuepages"]);
    for (let r = headerIdx + 1; r < table.length; r++) {
      const row = table[r];
      if (!row || row.every((c) => String(c).trim() === "")) continue;
      const cell = (i) => (i >= 0 && i < row.length ? String(row[i]).trim() : "");
      const title = cell(colTitle);
      if (!title) { out.skipped++; continue; }
      out.rows.push({
        title: title,
        journal: cell(colJournal),
        year: parseYear(cell(colYear)),
        doi: (cell(colDoi).match(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i) || [""])[0],
        issn: normaliseIssn(cell(colIssn)),
        volumePages: cell(colVol),
      });
    }
    return out;
  }

  // ---------- Stores (same interface, memory + IndexedDB) ----------

  function jcrKey(issn, year) { return (issn || "") + "|" + (year || ""); }
  function sjrKey(issn, year) { return (issn || "") + "|" + (year || ""); }

  // In-memory store: used by the Node tests and as a fallback.
  function MemoryStore() {
    this.jcr = new Map();   // key issn|year -> row
    this.sjr = new Map();
    this.meta = { jcrFiles: [], sjrFiles: [], mjlFiles: [], importedAt: null };
  }
  MemoryStore.prototype.putJcr = function (rows, fileMeta) {
    rows.forEach((row) => { this.jcr.set(jcrKey(row.issn, row.year), row); });
    if (fileMeta) this.meta.jcrFiles.push(fileMeta);
    this.meta.importedAt = new Date().toISOString();
    return Promise.resolve(rows.length);
  };
  MemoryStore.prototype.putSjr = function (rows, fileMeta) {
    rows.forEach((row) => { this.sjr.set(sjrKey(row.issn, row.year), row); });
    if (fileMeta) this.meta.sjrFiles.push(fileMeta);
    this.meta.importedAt = new Date().toISOString();
    return Promise.resolve(rows.length);
  };
  MemoryStore.prototype.putMjl = function (rows, fileMeta) {
    // MJL rows have no year: store under every year key is wrong.
    // Instead they live in a separate map keyed by ISSN alone.
    if (!this.mjl) this.mjl = new Map();
    rows.forEach((row) => { if (row.issn) this.mjl.set(row.issn, row); });
    if (fileMeta) this.meta.mjlFiles.push(fileMeta);
    this.meta.importedAt = new Date().toISOString();
    return Promise.resolve(rows.length);
  };
  MemoryStore.prototype.getRank = function (issns, year) {
    return Promise.resolve(lookupRankSync(this, issns, year));
  };
  MemoryStore.prototype.getMeta = function () {
    return Promise.resolve({
      jcrFiles: this.meta.jcrFiles.slice(),
      sjrFiles: this.meta.sjrFiles.slice(),
      mjlFiles: this.meta.mjlFiles.slice(),
      importedAt: this.meta.importedAt,
      jcrRows: this.jcr.size, sjrRows: this.sjr.size,
      mjlRows: this.mjl ? this.mjl.size : 0,
    });
  };
  MemoryStore.prototype.clear = function () {
    this.jcr.clear(); this.sjr.clear();
    if (this.mjl) this.mjl.clear();
    this.meta = { jcrFiles: [], sjrFiles: [], mjlFiles: [], importedAt: null };
    return Promise.resolve();
  };

  // Synchronous core of the lookup, shared by both stores.
  // issns: array of compact ISSNs (print/online/ISSN-L, any order).
  // Returns null when nothing is known for that ISSN+year — the
  // caller must say "no data", never substitute another year.
  function lookupRankSync(store, issns, year) {
    const list = (issns || []).filter(Boolean);
    if (!list.length || !year) return null;
    // 1. JCR, exact ISSN + exact year.
    for (const issn of list) {
      const row = store.jcr.get(jcrKey(issn, year));
      if (row) {
        return {
          source: "JCR", quartile: row.quartile || "",
          jif: (row.jif === null || row.jif === undefined) ? null : row.jif,
          wosCategory: row.wosCategory || "",
          wosIndex: row.wosIndex || "",
          category: row.category || "",
          journal: row.journal || "", year: year,
          editionYear: row.editionYear || year,
          sourceFile: row.sourceFile || "",
        };
      }
    }
    // 2. JCR by journal title is NOT attempted here — title matching
    //    is too fuzzy for a submission list. ISSN is the key.
    // 3. SJR fallback, exact ISSN + exact year, labelled as SJR.
    for (const issn of list) {
      const row = store.sjr.get(sjrKey(issn, year));
      if (row) {
        return {
          source: "SJR", quartile: row.quartile || "",
          jif: null, sjr: (row.sjr === null || row.sjr === undefined) ? null : row.sjr,
          wosCategory: "", wosIndex: "", category: row.categories || "",
          journal: row.journal || "", year: year,
          editionYear: null, sourceFile: row.sourceFile || "",
        };
      }
    }
    // 4. Nothing for this ISSN+year — but a WoS category may still
    //    be known from the MJL import (category is current, not
    //    year-correct, so it is returned separately and labelled).
    let wosCategory = "";
    if (store.mjl) {
      for (const issn of list) {
        const row = store.mjl.get(issn);
        if (row && row.wosCategory) { wosCategory = row.wosCategory; break; }
      }
    }
    return { source: "none", quartile: "", jif: null, wosCategory: wosCategory,
             wosIndex: "", category: "", journal: "", year: year,
             editionYear: null, sourceFile: "" };
  }

  // IndexedDB store (browser only). Same interface as MemoryStore.
  // DB: journal-quartile-db v1; stores jcr, sjr (keyPath "key"),
  // mjl (keyPath "issn"), meta (keyPath "id", one row id "meta").
  function IdbStore() { this._db = null; }
  IdbStore.prototype._open = function () {
    const self = this;
    if (self._db) return Promise.resolve(self._db);
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") { reject(new Error("IndexedDB is not available in this context.")); return; }
      const req = indexedDB.open("journal-quartile-db", 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("jcr")) db.createObjectStore("jcr", { keyPath: "key" });
        if (!db.objectStoreNames.contains("sjr")) db.createObjectStore("sjr", { keyPath: "key" });
        if (!db.objectStoreNames.contains("mjl")) db.createObjectStore("mjl", { keyPath: "issn" });
        if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "id" });
      };
      req.onsuccess = () => { self._db = req.result; resolve(self._db); };
      req.onerror = () => reject(req.error || new Error("IndexedDB open failed."));
    });
  };
  IdbStore.prototype._tx = function (storeNames, mode, fn) {
    return this._open().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(storeNames, mode);
      const done = fn(tx);
      tx.oncomplete = () => resolve(done);
      tx.onerror = () => reject(tx.error || new Error("IndexedDB transaction failed."));
    }));
  };
  IdbStore.prototype._putRows = function (storeName, rows, keyFn) {
    return this._tx([storeName], "readwrite", (tx) => {
      const os = tx.objectStore(storeName);
      rows.forEach((row) => { const r = Object.assign({}, row); r.key = keyFn(row); os.put(r); });
      return rows.length;
    });
  };
  IdbStore.prototype.putJcr = function (rows, fileMeta) {
    const self = this;
    return self._putRows("jcr", rows, (r) => jcrKey(r.issn, r.year))
      .then((n) => self._saveMeta("jcr", fileMeta).then(() => n));
  };
  IdbStore.prototype.putSjr = function (rows, fileMeta) {
    const self = this;
    return self._putRows("sjr", rows, (r) => sjrKey(r.issn, r.year))
      .then((n) => self._saveMeta("sjr", fileMeta).then(() => n));
  };
  IdbStore.prototype.putMjl = function (rows, fileMeta) {
    const self = this;
    return self._tx(["mjl"], "readwrite", (tx) => {
      const os = tx.objectStore("mjl");
      rows.forEach((row) => { if (row.issn) os.put(row); });
      return rows.length;
    }).then((n) => self._saveMeta("mjl", fileMeta).then(() => n));
  };
  IdbStore.prototype._saveMeta = function (kind, fileMeta) {
    if (!fileMeta) return Promise.resolve();
    return this._tx(["meta"], "readwrite", (tx) => {
      const os = tx.objectStore("meta");
      const get = os.get("meta");
      get.onsuccess = () => {
        const meta = get.result || { id: "meta", jcrFiles: [], sjrFiles: [], mjlFiles: [], importedAt: null };
        const key = kind + "Files";
        meta[key] = (meta[key] || []).concat([fileMeta]);
        meta.importedAt = new Date().toISOString();
        os.put(meta);
      };
      return null;
    });
  };
  IdbStore.prototype.getRank = function (issns, year) {
    const self = this;
    const list = (issns || []).filter(Boolean);
    if (!list.length || !year) return Promise.resolve(null);
    return self._open().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(["jcr", "sjr", "mjl"], "readonly");
      const out = { jcr: null, sjr: null, mjl: null };
      let pending = 0;
      const check = () => {
        if (pending > 0) return;
        if (out.jcr) {
          resolve({ source: "JCR", quartile: out.jcr.quartile || "",
            jif: (out.jcr.jif === null || out.jcr.jif === undefined) ? null : out.jcr.jif,
            wosCategory: out.jcr.wosCategory || "", wosIndex: out.jcr.wosIndex || "",
            category: out.jcr.category || "", journal: out.jcr.journal || "",
            year: year, editionYear: out.jcr.editionYear || year,
            sourceFile: out.jcr.sourceFile || "" });
        } else if (out.sjr) {
          resolve({ source: "SJR", quartile: out.sjr.quartile || "", jif: null,
            sjr: (out.sjr.sjr === null || out.sjr.sjr === undefined) ? null : out.sjr.sjr,
            wosCategory: "", wosIndex: "", category: out.sjr.categories || "",
            journal: out.sjr.journal || "", year: year,
            editionYear: null, sourceFile: out.sjr.sourceFile || "" });
        } else {
          resolve({ source: "none", quartile: "", jif: null,
            wosCategory: out.mjl || "", wosIndex: "", category: "",
            journal: "", year: year, editionYear: null, sourceFile: "" });
        }
      };
      // JCR first, in ISSN order.
      const tryJcr = (i) => {
        if (out.jcr || i >= list.length) { trySjr(0); return; }
        pending++;
        const req = tx.objectStore("jcr").get(jcrKey(list[i], year));
        req.onsuccess = () => { pending--; if (req.result) out.jcr = req.result; tryJcr(i + 1); };
        req.onerror = () => { pending--; tryJcr(i + 1); };
      };
      const trySjr = (i) => {
        if (out.sjr || i >= list.length) { tryMjl(0); return; }
        pending++;
        const req = tx.objectStore("sjr").get(sjrKey(list[i], year));
        req.onsuccess = () => { pending--; if (req.result) out.sjr = req.result; trySjr(i + 1); };
        req.onerror = () => { pending--; trySjr(i + 1); };
      };
      const tryMjl = (i) => {
        if (out.mjl || i >= list.length) { check(); return; }
        pending++;
        const req = tx.objectStore("mjl").get(list[i]);
        req.onsuccess = () => { pending--; if (req.result && req.result.wosCategory) out.mjl = req.result.wosCategory; tryMjl(i + 1); };
        req.onerror = () => { pending--; tryMjl(i + 1); };
      };
      tx.onerror = () => reject(tx.error || new Error("IndexedDB read failed."));
      tryJcr(0);
    }));
  };
  IdbStore.prototype.getMeta = function () {
    return this._open().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(["meta", "jcr", "sjr", "mjl"], "readonly");
      const meta = { jcrFiles: [], sjrFiles: [], mjlFiles: [], importedAt: null, jcrRows: 0, sjrRows: 0, mjlRows: 0 };
      const getMeta = tx.objectStore("meta").get("meta");
      getMeta.onsuccess = () => {
        if (getMeta.result) {
          meta.jcrFiles = getMeta.result.jcrFiles || [];
          meta.sjrFiles = getMeta.result.sjrFiles || [];
          meta.mjlFiles = getMeta.result.mjlFiles || [];
          meta.importedAt = getMeta.result.importedAt || null;
        }
      };
      ["jcr", "sjr", "mjl"].forEach((name) => {
        const count = tx.objectStore(name).count();
        count.onsuccess = () => { meta[name + "Rows"] = count.result; };
      });
      tx.oncomplete = () => resolve(meta);
      tx.onerror = () => reject(tx.error || new Error("IndexedDB read failed."));
    }));
  };
  IdbStore.prototype.clear = function () {
    const self = this;
    return self._open().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(["jcr", "sjr", "mjl", "meta"], "readwrite");
      ["jcr", "sjr", "mjl", "meta"].forEach((n) => tx.objectStore(n).clear());
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("IndexedDB clear failed."));
    }));
  };

  // ---------- Results CSV export ----------

  var RESULTS_HEADER = ["Title", "Journal", "Year", "ISSN", "DOI",
    "JCR quartile (year)", "Impact Factor - JCR (year)", "WoS category",
    "SJR quartile - fallback NOT JCR (year)", "Source", "Notes"];

  function resultRowToCsv(result) {
    const rank = result.rank || {};
    const isJcr = rank.source === "JCR";
    const isSjr = rank.source === "SJR";
    return [
      result.title || "", result.journal || "", result.year || "",
      result.issn || "", result.doi || "",
      isJcr ? (rank.quartile || "") : "",
      isJcr ? (rank.jif === null || rank.jif === undefined ? "" : String(rank.jif)) : "",
      rank.wosCategory || "",
      isSjr ? (rank.quartile || "") : "",
      rank.source || "none",
      result.note || "",
    ];
  }

  function resultsToCsv(results) {
    return rowsToCsv(RESULTS_HEADER, (results || []).map(resultRowToCsv));
  }

  // ---------- JCR expiry ----------
  // JCR releases a new edition each June. Data imported now is
  // current until the next June release; the UI shows the expiry
  // month so the user knows when to re-import.
  function nextJcrExpiry(fromDate) {
    const d = fromDate ? new Date(fromDate) : new Date();
    const year = d.getMonth() < 5 ? d.getFullYear() : d.getFullYear() + 1;
    return "June " + year;
  }

  // ---------- Free-data expiry (WoS list / SJR) ----------
  // Stored free data is reused until the next list is published,
  // about a year, and only re-fetched or re-downloaded after
  // expiry — never discarded after one use. SJR releases each
  // June, so SJR data expires at the next June 1 after import.
  // The WoS Master Journal List is annual, so it expires 12
  // months after import. Expiry is derived from the stored
  // download date, so every import path (auto-fetch, one-click
  // download, manual import) gets the same rule, and the UI can
  // show the remaining time in one short line.
  var MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];

  function nextJuneDate(fromDate) {
    const d = fromDate ? new Date(fromDate) : new Date();
    const year = d.getMonth() < 5 ? d.getFullYear() : d.getFullYear() + 1;
    return new Date(Date.UTC(year, 5, 1));
  }

  // ISO date string for when SJR data imported at importedAt
  // expires (next June 1).
  function sjrExpiresAt(importedAt) {
    return nextJuneDate(importedAt).toISOString();
  }

  // ISO date string for when WoS list data imported at
  // importedAt expires (12 months after import).
  function mjlExpiresAt(importedAt) {
    const d = importedAt ? new Date(importedAt) : new Date();
    return new Date(Date.UTC(d.getUTCFullYear() + 1, d.getUTCMonth(), d.getUTCDate())).toISOString();
  }

  // "June 2027" / "Nov 2027" for an expiry ISO date.
  function expiryMonthLabel(expiresIso) {
    const d = new Date(expiresIso);
    if (isNaN(d.getTime())) return "";
    return MONTH_NAMES[d.getUTCMonth()] + " " + d.getUTCFullYear();
  }

  // Whole months from fromDate until expiresIso. Negative when
  // already past expiry. Coarse (month granularity), which is
  // what the UI shows.
  function monthsLeft(expiresIso, fromDate) {
    const e = new Date(expiresIso);
    const f = fromDate ? new Date(fromDate) : new Date();
    if (isNaN(e.getTime()) || isNaN(f.getTime())) return null;
    if (e.getTime() < f.getTime()) return -1;
    return (e.getUTCFullYear() - f.getUTCFullYear()) * 12
      + (e.getUTCMonth() - f.getUTCMonth());
  }

  // "7 months left" / "1 month left" / "expires this month" /
  // "expired".
  function monthsLeftText(expiresIso, fromDate) {
    const m = monthsLeft(expiresIso, fromDate);
    if (m === null) return "";
    if (m < 0) return "expired";
    if (m === 0) return "expires this month";
    if (m === 1) return "1 month left";
    return m + " months left";
  }

  // One short line: "Valid until June 2027, 7 months left".
  // kind: "sjr" (also used for JCR, same June rule) or "mjl".
  function validUntilText(importedAt, kind, fromDate) {
    const iso = kind === "mjl" ? mjlExpiresAt(importedAt) : sjrExpiresAt(importedAt);
    return "Valid until " + expiryMonthLabel(iso) + ", " + monthsLeftText(iso, fromDate);
  }

  function isExpired(importedAt, kind, fromDate) {
    const iso = kind === "mjl" ? mjlExpiresAt(importedAt) : sjrExpiresAt(importedAt);
    const m = monthsLeft(iso, fromDate);
    return m !== null && m < 0;
  }

  // The SJR year a stored file covers: recorded at import, or
  // read from an auto-fetch file name ("SJR 2025 (auto-fetch)").
  function sjrFileYear(file) {
    if (!file) return null;
    if (file.year) return file.year;
    const m = String(file.fileName || "").match(/SJR\s+(\d{4})/);
    return m ? parseInt(m[1], 10) : null;
  }

  // Does the stored SJR data cover this year (a file for that
  // year, not yet expired)? Used so a lookup fetches only the
  // years it actually needs, and never re-fetches a stored year.
  function sjrFilesCoverYear(meta, year, fromDate) {
    if (!meta || !meta.sjrFiles || !year) return false;
    return meta.sjrFiles.some((f) => sjrFileYear(f) === year && !isExpired(f.importedAt, "sjr", fromDate));
  }

  const api = {
    normaliseIssn: normaliseIssn, formatIssn: formatIssn,
    parseIssnList: parseIssnList,
    parseCsv: parseCsv, rowsToCsv: rowsToCsv,
    parseQuartile: parseQuartile, parseJif: parseJif, parseYear: parseYear, parseSjrScore: parseSjrScore,
    wosCategoryFromIndex: wosCategoryFromIndex,
    parseJcrText: parseJcrText, parseMJLText: parseMJLText,
    parseSjrText: parseSjrText, parseArticleListText: parseArticleListText,
    MemoryStore: MemoryStore, IdbStore: IdbStore,
    lookupRankSync: lookupRankSync,
    RESULTS_HEADER: RESULTS_HEADER, resultsToCsv: resultsToCsv,
    nextJcrExpiry: nextJcrExpiry,
    sjrExpiresAt: sjrExpiresAt, mjlExpiresAt: mjlExpiresAt,
    expiryMonthLabel: expiryMonthLabel,
    monthsLeft: monthsLeft, monthsLeftText: monthsLeftText,
    validUntilText: validUntilText, isExpired: isExpired,
    sjrFileYear: sjrFileYear, sjrFilesCoverYear: sjrFilesCoverYear,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.JournalQuartileData = api;
  }
})(typeof self !== "undefined" ? self : (typeof window !== "undefined" ? window : this));
