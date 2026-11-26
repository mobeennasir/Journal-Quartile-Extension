// xlsx.js — Minimal bundled .xlsx reader for the Journal Quartile
// Extension (Phase 2, batch upload).
//
// An .xlsx file is a ZIP of XML files. This reader parses the ZIP
// central directory, inflates entries with the platform
// DecompressionStream (Chrome and Node 18+), and reads the first
// worksheet plus the shared-strings table. First sheet only, values
// only (no formulas, formatting, or dates — a date cell comes back
// as its raw Excel serial number, which the article-list parser
// ignores unless it looks like a year).
//
// No dependencies, no remote code, no network. If a file cannot be
// parsed, the caller tells the user to save it as .csv in Excel
// instead — CSV is the reliable path.
//
// Loaded by the lookup page (sidepanel.html, plain <script>) and by
// the Node unit tests (module.exports guard at the bottom).

(function (root) {
  "use strict";

  function readUint16(view, off) { return view.getUint16(off, true); }
  function readUint32(view, off) { return view.getUint32(off, true); }

  // Parse the ZIP central directory. Returns [{name, method,
  // compressedSize, offset}] where offset is the local header offset.
  function parseCentralDirectory(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // Find End Of Central Directory: signature 0x06054b50, search
    // backwards from the end (comment may follow it).
    let eocd = -1;
    for (let i = bytes.length - 22; i >= 0; i--) {
      if (readUint32(view, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd === -1) throw new Error("Not a ZIP file (no end-of-central-directory record).");
    const total = readUint16(view, eocd + 10);
    let offset = readUint32(view, eocd + 16);
    const entries = [];
    for (let n = 0; n < total; n++) {
      if (readUint32(view, offset) !== 0x02014b50) break;
      const method = readUint16(view, offset + 10);
      const compressedSize = readUint32(view, offset + 20);
      const nameLen = readUint16(view, offset + 28);
      const extraLen = readUint16(view, offset + 30);
      const commentLen = readUint16(view, offset + 32);
      const localOffset = readUint32(view, offset + 42);
      let name = "";
      for (let i = 0; i < nameLen; i++) name += String.fromCharCode(bytes[offset + 46 + i]);
      entries.push({ name: name, method: method, compressedSize: compressedSize, offset: localOffset });
      offset += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  function inflateRaw(bytes) {
    // DecompressionStream is available in Chrome 80+ and Node 18+.
    if (typeof DecompressionStream === "undefined") {
      return Promise.reject(new Error("This browser cannot inflate .xlsx files (no DecompressionStream). Save the file as .csv in Excel instead."));
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Response(stream).arrayBuffer().then((buf) => new Uint8Array(buf));
  }

  function readEntry(bytes, entry) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const off = entry.offset;
    if (readUint32(view, off) !== 0x04034b50) throw new Error("Bad ZIP local header for " + entry.name);
    const nameLen = readUint16(view, off + 26);
    const extraLen = readUint16(view, off + 28);
    const dataStart = off + 30 + nameLen + extraLen;
    const data = bytes.slice(dataStart, dataStart + entry.compressedSize);
    if (entry.method === 0) return Promise.resolve(data); // stored
    if (entry.method === 8) return inflateRaw(data);      // deflated
    return Promise.reject(new Error("Unsupported ZIP compression method " + entry.method + " in " + entry.name));
  }

  function decodeXml(bytes) {
    return new TextDecoder("utf-8").decode(bytes);
  }

  function unescapeXml(s) {
    return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(parseInt(n, 10)))
      .replace(/&#x([0-9a-fA-F]+);/g, (m, n) => String.fromCharCode(parseInt(n, 16)));
  }

  // <sst><si><t>value</t></si>...</sst> — shared strings.
  function parseSharedStrings(xml) {
    const out = [];
    const siRe = /<si>([\s\S]*?)<\/si>/g;
    let m;
    while ((m = siRe.exec(xml)) !== null) {
      const parts = [];
      const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g;
      let t;
      while ((t = tRe.exec(m[1])) !== null) parts.push(unescapeXml(t[1]));
      out.push(parts.join(""));
    }
    return out;
  }

  // Column letters ("A", "AB") -> 0-based index.
  function columnIndex(ref) {
    const letters = (ref || "").replace(/[^A-Za-z]/g, "").toUpperCase();
    let n = 0;
    for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
    return n - 1;
  }

  // One <sheet> XML: rows of cells. Returns array of arrays of strings.
  function parseSheetXml(xml, sharedStrings) {
    const rows = [];
    const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g;
    let rm;
    while ((rm = rowRe.exec(xml)) !== null) {
      const rowXml = rm[1];
      const cells = [];
      const cellRe = /<c([^>]*)>([\s\S]*?)<\/c>|<c([^>]*)\/>/g;
      let cm;
      while ((cm = cellRe.exec(rowXml)) !== null) {
        const attrs = cm[1] !== undefined ? cm[1] : cm[3];
        const inner = cm[2] || "";
        const ref = (attrs.match(/ r="([A-Za-z]+\d+)"/) || [])[1] || "";
        const type = (attrs.match(/ t="([^"]+)"/) || [])[1] || "";
        const vMatch = inner.match(/<v>([\s\S]*?)<\/v>/);
        const isMatch = inner.match(/<is>([\s\S]*?)<\/is>/);
        let value = "";
        if (type === "s" && vMatch) {
          const idx = parseInt(vMatch[1], 10);
          value = sharedStrings[idx] !== undefined ? sharedStrings[idx] : "";
        } else if (isMatch) {
          const tMatch = isMatch[1].match(/<t[^>]*>([\s\S]*?)<\/t>/);
          value = tMatch ? unescapeXml(tMatch[1]) : "";
        } else if (vMatch) {
          value = unescapeXml(vMatch[1]);
        }
        const col = columnIndex(ref);
        if (col >= 0) cells[col] = value;
      }
      // Trim trailing empty cells, keep the row if anything is set.
      let last = cells.length - 1;
      while (last >= 0 && (cells[last] === undefined || cells[last] === "")) last--;
      if (last >= 0) rows.push(cells.slice(0, last + 1).map((c) => (c === undefined ? "" : c)));
    }
    return rows;
  }

  // Read the first worksheet of an .xlsx file.
  // arrayBuffer: the file contents. Returns Promise<rows[][]>.
  function readXlsx(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    let entries;
    try {
      entries = parseCentralDirectory(bytes);
    } catch (err) {
      return Promise.reject(err);
    }
    const find = (name) => entries.find((e) => e.name === name);
    const sharedEntry = find("xl/sharedStrings.xml");
    // First worksheet: read workbook.xml for the sheet order, fall
    // back to xl/worksheets/sheet1.xml.
    const workbookEntry = find("xl/workbook.xml");
    const sheetEntry = find("xl/worksheets/sheet1.xml");
    if (!sheetEntry) return Promise.reject(new Error("No worksheet found in this .xlsx file."));
    const sharedP = sharedEntry
      ? readEntry(bytes, sharedEntry).then((b) => parseSharedStrings(decodeXml(b)))
      : Promise.resolve([]);
    return sharedP.then((sharedStrings) =>
      readEntry(bytes, sheetEntry).then((b) => parseSheetXml(decodeXml(b), sharedStrings))
    );
  }

  // Rows (arrays) -> CSV text, so the article-list parser can be reused.
  function rowsToCsvText(rows) {
    const esc = (v) => {
      const s = v === null || v === undefined ? "" : String(v);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return rows.map((r) => r.map(esc).join(",")).join("\r\n");
  }

  // Some "Export to Excel" downloads (including some JCR exports)
  // are not real .xls binaries but HTML tables or SpreadsheetML
  // XML. Extract their rows as arrays of cell text. Returns null
  // when the text is neither.
  function spreadsheetHtmlToRows(text) {
    if (!text || typeof text !== "string") return null;
    const s = text.trim();
    if (!/^<(!DOCTYPE|html|\?xml)/i.test(s)) return null;
    const rows = [];
    const rowRe = /<(?:tr|Row)[^>]*>([\s\S]*?)<\/(?:tr|Row)>/gi;
    let rm;
    while ((rm = rowRe.exec(s)) !== null) {
      const cells = [];
      const cellRe = /<(?:td|th|Cell)[^>]*>([\s\S]*?)<\/(?:td|th|Cell)>/gi;
      let cm;
      while ((cm = cellRe.exec(rm[1])) !== null) {
        let inner = cm[1];
        // SpreadsheetML: <Cell><Data>value</Data></Cell>
        const data = inner.match(/<Data[^>]*>([\s\S]*?)<\/Data>/i);
        if (data) inner = data[1];
        inner = inner.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim();
        cells.push(unescapeXml(inner));
      }
      if (cells.some((c) => c !== "")) rows.push(cells);
    }
    return rows.length ? rows : null;
  }

  const api = { readXlsx: readXlsx, rowsToCsvText: rowsToCsvText, spreadsheetHtmlToRows: spreadsheetHtmlToRows };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.JournalQuartileXlsx = api;
  }
})(typeof self !== "undefined" ? self : (typeof window !== "undefined" ? window : this));
