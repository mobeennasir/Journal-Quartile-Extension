# Phase 2 tests

Run: `node tests/run-tests.js` (from `phase1-spike/`).

## WARNING — synthetic data
All JCR / SJR / MJL values in `synthetic-*.csv` are **invented for
testing only**. They are NOT real JCR, SJR or WoS data and must never
be quoted as real, bundled in the extension, or shown to a user as
rankings. Real ranking data comes only from files the user imports.

## What is tested
1. ISSN helpers, CSV parser
2. JCR category export, All-Years export (skipped without a key),
   canonical simple format
3. Merge of two JCR files; year-exact lookup (never another year's rank)
4. SJR fallback labelling (JCR wins when present)
5. MJL import -> WoS category W/X
6. Real Naqqash Scholar CSV: 67 rows, dedupe -> 63 unique
7. XLSX reader on a hand-built .xlsx; HTML-table .xls fallback
8. Results CSV export round-trip
9. Live Crossref lookups for the 6 known DOIs
10. Live batch: first 10 Scholar rows by title search
11. Live manual entry (Scholar row 1)
12. Label audit of sidepanel.html / popup.js
