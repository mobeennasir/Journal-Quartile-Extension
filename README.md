# Journal Quartile Extension — Phase 2 (v0.3.0)

Phase 2 builds on the Phase 1 spike (below). It adds year-correct
ranking, batch upload, and manual entry — built 27 Nov 2026 on the
user's word "start", WITHOUT a real JCR export yet (he asked whether
JCR was mandatory; the answer: real JCR numbers need it, building
does not).

## What Phase 2 adds

### 1. Single article — three clearly named ways in
The panel has three tabs, each with a one-line plain description:
- **Lookup by DOI** — "Paste a DOI, for example 10.1038/nature14539. The extension looks the article up in Crossref." Button: **Look up**.
- **Lookup by article link** — "Paste any publisher article link, for example a nature.com or ScienceDirect link. The DOI is read from the article page itself." Button: **Look up**. The **Check this page — read the DOI from the open article tab** button lives here too (same self-contained injection fix as v4/v5, commit 4b07429).
- **Enter details manually** — "For old articles with no DOI or link. Type the title, journal and year and the extension searches Crossref for the article." Fields: Article title, Journal name, Year published, DOI if known (optional), ISSN if known (optional). Button: **Look up this article**. If a DOI is given it is used directly; otherwise the title + journal + year are searched in Crossref (OpenAlex fallback), and a title-word overlap check (≥40%) guards against returning a different article with a similar title.

Every lookup then shows the ranking for the article's own
publication year (see below).

### 2. Ranking — JCR import, SJR labelled fallback, WoS category W/X
- **Import JCR data (for quartile + Impact Factor)** — the user
  uploads their own JCR export file(s) (CSV, .xlsx, or old .xls —
  HTML-table exports are read too; old binary .xls is refused with
  a plain message to save as .xlsx/.csv). A **Data year this export
  covers** dropdown says which year the numbers describe (a 2021
  article needs the export reporting 2021 data — not the download
  year). Rows are stored in IndexedDB keyed by ISSN + data year
  (print and online ISSN both stored, so lookup by either works),
  with file name, edition year, upload date, and expiry (next June
  release) shown in the status line. Multiple files merge; a
  duplicate ISSN+year row is overwritten by the latest import.
  Button: **Import JCR file**. **Do not scrape JCR. No credential
  is stored or hard-coded.**
- **Year-correct lookup, honest about gaps:** the article's ISSNs
  (Crossref/OpenAlex, or the manually entered ISSN) and publication
  year are looked up exactly. If no JCR row exists for that
  ISSN+year the result says **"No JCR data for this year"** — never
  another year's quartile or IF.
- **Import SJR data (fallback quartile — NOT JCR)** — optional.
  Upload an SJR CSV downloaded from scimagojr.com in a browser
  (automated fetch is Cloudflare-blocked — verified 27 Nov 2026,
  HTTP 403 — so the extension never live-fetches SJR). Used only
  when no JCR row exists, and every value is labelled **"SJR
  quartile — fallback, NOT JCR (year)"**. No SJR values are bundled
  with the extension: no verified SJR dataset could be obtained
  from this machine, and inventing quartile values would corrupt
  the tool's whole purpose. The bundled SJR table is therefore
  empty until the user imports a real SJR CSV; the import path
  (parser + store + fallback labelling) is fully built and tested
  with a synthetic file.
- **Import WoS journal list (for category W / X)** — optional
  Master Journal List export. W = SCIE/SSCI/AHCI, X = ESCI
  (Emerging), settled 26 Nov 2026 per HEC Policy 2024 v2.0. The
  category can also come from a JCR row's Edition/Index column.
  Without either, the result says **"Unknown — needs WoS / JCR
  data"**, never a guess. The category is the journal's *current*
  indexing, not the publication year's. The full HEC part (Y, Z,
  national-journal rules) is skipped for now, per plan.
- Result labels, exactly as shown: **"JCR quartile (2021)"**,
  **"Impact Factor — JCR (2021)"**, **"SJR quartile — fallback,
  NOT JCR (2021)"**, **"WoS category"**, **"No JCR data for this
  year"**, plus a **"Ranking: JCR / SJR fallback — NOT JCR / no
  JCR data for this year"** badge. No bare number is ever shown
  without its source and year.
- **Clear all imported data** deletes every imported JCR/SJR/MJL
  row (with a confirm step). Files on the user's computer are not
  affected.

### 3. Batch — Upload a list of articles (Excel / CSV)
- **Upload a list of articles (Excel / CSV)** — "Upload a .csv or
  .xlsx file with one article per row. Columns it understands:
  title, journal, year, DOI if known, ISSN if known,
  volume/pages. A missing DOI is fine — each article is found by
  its title and journal. Returns one result row per article, with
  the quartile and Impact Factor for that article's own year."
- .csv is parsed in JS; .xlsx is parsed by a bundled minimal
  reader (`xlsx.js`: ZIP + DecompressionStream, first sheet only,
  no dependencies, no remote code). Old binary .xls is refused
  with instructions; HTML-table .xls exports are read.
- Buttons: **Choose Excel or CSV file**, **Upload and check all
  articles**, **Use the Naqqash test set (67 articles)** (built-in
  `test-set.csv`, the Scholar list), **Download results as CSV**.
  Progress shows "Checking article N of 67…" with a progress bar;
  the results table shows title, journal, year, JCR quartile
  (year), Impact Factor — JCR (year), WoS category, Source. Rows
  are processed one at a time (~300 ms apart, polite pool) with
  one retry on a dropped Crossref response. A row whose DOI
  resolves to one already seen in the batch is flagged "Same
  article as row N (same DOI) — Scholar lists it twice".
- Export columns: Title, Journal, Year, ISSN, DOI, JCR quartile
  (year), Impact Factor - JCR (year), WoS category, SJR quartile -
  fallback NOT JCR (year), Source, Notes.

### 4. Files changed in Phase 2
- `jcr.js` (new) — ISSN helpers, CSV parser, JCR/SJR/MJL parsers,
  MemoryStore + IndexedDB store, year-exact rank lookup, results
  CSV builder. Dependency-free; also loaded by the Node tests.
- `xlsx.js` (new) — minimal bundled .xlsx reader + HTML-table
  .xls fallback.
- `sidepanel.html` — rewritten Phase 2 UI (three lookup modes,
  batch section, three import sections, exact labels — see
  "Labels" below).
- `popup.js` — rewritten: modes, manual lookup, rank display,
  batch engine, import handlers, duplicate flagging.
- `popup.css` — styles for tabs, batch table, progress bar, import
  sections.
- `manifest.json` — version 0.3.0, name "Journal Quartile
  Extension — Phase 2".
- `test-set.csv` (new) — the Naqqash Scholar list (67 rows; the
  "(duplicate of…)" notes that were in the working copy have been
  removed from the titles so they do not pollute title searches).
- `tests/` (new) — synthetic JCR/SJR/MJL/XLSX files + `run-tests.js`
  (`node tests/run-tests.js`).

### 5. Labels used (exact wording — label audit in the tests)
Single article: "Lookup by DOI", "Lookup by article link", "Enter
details manually", "Look up", "Look up this article", "Check this
page — read the DOI from the open article tab". Batch: "Upload a
list of articles (Excel / CSV)", "Choose Excel or CSV file",
"Upload and check all articles", "Use the Naqqash test set (67
articles)", "Download results as CSV". Imports: "Import JCR data
(for quartile + Impact Factor)", "Data year this export covers",
"Import JCR file", "Import SJR data (fallback quartile — NOT JCR)",
"Import SJR file", "Import WoS journal list (for category W / X)",
"Import WoS journal list", "Clear all imported data". Results:
"JCR quartile (year)", "Impact Factor — JCR (year)", "SJR quartile
— fallback, NOT JCR (year)", "WoS category", "No JCR data for this
year", "Unknown — needs WoS / JCR data". No button is called
"Submit" or "Go"; no input is unlabeled. One label that could
still confuse a first-time user, flagged honestly: **"Data year
this export covers"** — JCR calls its editions by release year
(JCR 2025 = 2024 data), so a user may pick the edition year
instead of the data year. The hint under the dropdown explains
it ("The year the numbers describe — not the year you downloaded
it"), and the import status line repeats the chosen data year.

### 6. Verification (27 Nov 2026, `node tests/run-tests.js`)
**60 passed, 0 failed.** Covered: ISSN/CSV helpers; JCR category
export (10 ISSN rows from 6 journals), canonical format, and an
All-Years file with no ISSN/journal key (skipped, not guessed);
merging two JCR files and year-exact lookup (Nature 2015 vs 2021
return different JIFs; 2019 returns "none", never another year);
SJR fallback labelling (JCR wins when present; SJR-only journal
returns source "SJR"); MJL import → category W; real Naqqash CSV
(67 rows; title dedupe → 65 unique — the other two Scholar
duplicates have truncated titles on the profile and only collapse
once their DOIs resolve to the same DOI, which the batch flags);
.xlsx reader on a hand-built file; HTML-table .xls fallback;
results-CSV round-trip; live Crossref lookups for all 6 known DOIs
(10.1038/nature14539, 10.1016/j.chemosphere.2020.128054,
10.1016/j.cell.2020.02.052, 10.1038/s41586-020-2649-2,
10.1038/nature12373, 10.1016/j.micres.2017.08.011); live batch of
the first 10 Scholar rows by title search — **9 of 10 resolved a
DOI** (1 failed with an empty Crossref response even after the
retry; the batch keeps that row with a "Network error" note rather
than dropping it); live manual entry (Scholar row 1 → DOI
10.3389/fsufs.2021.617157); label audit of the whole UI; static
check that all 38 element IDs used by popup.js exist in
sidepanel.html. `node --check` passes on all JS files.
**Not tested in a real browser** — the side panel, imports, and
batch run in Chrome still need the user's load-unpacked test
(`git pull` + Reload, then the steps under "Test — Phase 2" below).

### 7. Blockers / what is NOT done
- **JCR importer untested against a real JCR file.** The parser
  matches columns by name and accepts several known JCR column
  spellings, but no real JCR export has been seen. The first real
  import must be checked row by row against the export (the UI
  shows rows read / skipped / warnings). If the real columns
  differ, the parser will need a small fix — minutes once the
  file is seen. **Still needed from Naqqash: one sample JCR
  export** (even one journal's All Years CSV, or one 600-row
  category export).
- **No SJR values bundled** (see above) — the SJR fallback works
  only after the user downloads an SJR CSV in their browser and
  imports it. SJR blocks automated downloads (Cloudflare 403,
  verified 27 Nov 2026).
- **No WoS category without an import** — the MJL list is not
  bundled (free download needs registration); category shows
  "unknown" until a JCR or MJL file is imported.
- **Batch of all 67 has not been run end-to-end** — only the first
  10 rows were tested live (9/10 DOI resolution). The full run
  needs the user's Chrome session (or a longer live run here).

## Test — Phase 2 (in Chrome, after git pull + Reload)
1. Single DOI: `10.1038/nature14539` → Look up. Shows Deep
   learning, Nature, 2015, plus "JCR quartile (2015): No JCR data
   for this year" (correct — nothing imported yet) and "WoS
   category: Unknown — needs WoS / JCR data".
2. Manual entry: title "Rhizosphere engineering with plant
   growth-promoting microorganisms for agriculture and ecological
   sustainability", journal "Frontiers in Sustainable Food
   Systems", year 2021 → Look up this article. Must resolve to
   DOI 10.3389/fsufs.2021.617157.
3. JCR import: import `tests/synthetic-jcr-canonical.csv` with
   data year 2015 (synthetic data — for testing only, clear it
   afterwards with "Clear all imported data"). Then look up
   `10.1038/nature14539` again: it must now show "JCR quartile
   (2015): Q1" and "Impact Factor — JCR (2015): 38.138".
   Importing the category file with data year 2021 and looking up
   `10.1016/j.micres.2017.08.011` must NOT show 2021 numbers for
   the 2017 article — it must say "No JCR data for this year".
4. Batch: "Use the Naqqash test set (67 articles)" → it runs all
   rows; "Download results as CSV" saves the file.
5. SJR fallback: import `tests/synthetic-sjr.csv`, then look up a
   2022 Journal of Plant Growth Regulation article — it must show
   "SJR quartile — fallback, NOT JCR (2022): Q2" and never a JCR
   label.

---

# Journal Quartile Extension — Phase 1 Spike (v3 / v0.2.0)

Throwaway proof-of-concept. It proves one thing only: a DOI or an
article link can be resolved to article metadata in the browser via
Crossref, with OpenAlex as fallback.

**Not in this spike:** quartile, Impact Factor, journal category,
SJR, JCR, bulk lookup, export. Those come in later phases.

## What it does

- Input accepts a bare DOI (`10.1038/nature14539`), a doi.org
  link, or any publisher article URL.
- Crossref first:
  `GET https://api.crossref.org/works/{doi}?mailto=mubeennasir117@gmail.com`
  On failure / 404, OpenAlex fallback:
  `GET https://api.openalex.org/works/doi:{doi}?mailto=mubeennasir117@gmail.com`
- Displays, exactly as the API returns it: title, journal, ISSN,
  publication year, publisher, volume / issue / pages, DOI (linked),
  and which source answered (Crossref or OpenAlex, shown as a badge).
- Clear error states for: no DOI in the input, DOI not found in
  either source, network failure, and a publisher page that
  blocked the automatic read (see below).
- No preset / test-article section in the popup — paste a DOI
  manually to test. Verified DOIs you can use (all resolved via
  Crossref on 2026-11-26):
  1. `10.1038/nature14539` — Deep learning, Nature, 2015
  2. `10.1016/j.chemosphere.2020.128054` — Simultaneous degradation of
     triazophos, methamidophos and carbofuran pesticides in wastewater
     using an Enterobacter bacterial bioreactor…, Chemosphere, 2020
  3. `10.1016/j.cell.2020.02.052` — SARS-CoV-2 Cell Entry Depends on
     ACE2 and TMPRSS2…, Cell, 2020
  4. `10.1038/s41586-020-2649-2` — Array programming with NumPy,
     Nature, 2020
  5. `10.1038/nature12373` — Nanometre-scale thermometry in a living
     cell, Nature, 2013

## Resolving a publisher URL (generic, any journal)

A publisher link often carries no DOI in its address (a Nature
slug, a ScienceDirect PII). The resolution is generic — the same
path for every publisher, no per-publisher special cases and no
hard-coded DOIs or PIIs:

1. **Main mechanism:** the article page is fetched by the
   background service worker (CORS-exempt with host permissions)
   and the DOI is parsed from the page's own metadata, in order:
   `<meta name="citation_doi">`, `<meta name="DC.Identifier">`,
   JSON-LD `"doi"` / `"@id"`, `<meta property="og:url">` with a
   doi.org link, `<link rel="canonical">` with a DOI, then a
   doi.org link inside `<head>` only (references live in the
   body, so the whole page is never scanned for a DOI). This is
   the path that handles Nature, Springer, Wiley, Taylor &
   Francis, MDPI, Frontiers, PubMed / PMC and others the same way.
2. **Fallback only:** a known slug mapping —
   `nature.com/articles/<slug>` → `10.1038/<slug>`.
3. Only if neither yields a DOI does the "No DOI found" error
   appear.

**Blocked pages — reported, not silently failed.** Some publishers
block automated page fetches with a bot check (HTTP 403 + captcha
page, no article metadata). When that happens the extension now
says so plainly, naming the publisher, and tells you to open the
article in Chrome and copy the DOI from the page. Verified from
this machine on 2026-11-26: **ScienceDirect blocks direct fetch**
(403, "Are you a robot" page) and **MDPI blocks direct fetch**
(403). A fetch from the user's own Chrome may succeed where this
machine's fetch is blocked, because it runs in a real browser —
but if it is blocked there too, the message above is what you will
see, not "No DOI found".

**ScienceDirect PII note (honest):** the reported link
`https://www.sciencedirect.com/science/article/pii/S09445013`
cannot be resolved to a DOI by any mechanism, because the PII
itself is incomplete — Elsevier's own linking hub answers
"Article Not Recognized / Requested article is not found in
IHub" for `S09445013` (a real PII is longer, e.g.
`S0944501325001234`-style). Nothing was hard-coded for it; with
the full PII the generic metadata path above is what resolves it.
If you have the full link, paste that instead.

## "Check this page" — the answer for blocked publishers

The background fetch above can still be blocked (ScienceDirect,
MDPI). The escape hatch is **“Check this page”**: open the
article in a Chrome tab, click the extension icon, tap the
button. The background worker reads the DOI from that tab's
live DOM (`citation_doi` first, then DC.Identifier, JSON-LD,
og:url, canonical — same order as the page-metadata parser)
via `chrome.scripting`, and runs the normal Crossref lookup on
it. The page is already loaded by you, so no fetch happens and
no bot check can apply. It needs two extra permissions:
`scripting` (inject the reader) and `tabs` (find the article
tab when the lookup page itself is open as a full tab).

**Fixed twice — why it failed on ScienceDirect.** The v4 build
made ONE `chrome.scripting.executeScript` call with BOTH
`files: ["shared.js"]` AND a `func`. Per the scripting API spec
exactly one of `files` and `func` may be specified, so that call
was invalid and the extractor never ran — which is why it
reported "Chrome wouldn't let the extension read that tab"
even though the user WAS on the article tab with the panel
open. The first fix (26 Nov 2026) split it into two calls:
(1) inject `shared.js` alone, (2) then run the extractor.
That still failed on 27 Nov 2026 — the user reported pasting
the ScienceDirect link (background fetch) worked, but "Check
this page" still did nothing. Root cause: top-level `const` /
`function` declarations in an injected file do NOT reliably
persist across separate `executeScript` calls in the tab's
isolated world, so step 2's extractor (or the `const
DOI_PATTERN` it closed over) could be missing and it silently
returned null. The current fix is ONE call with ONLY `func`,
and the func is FULLY SELF-CONTAINED — the whole DOI
extraction lives inside it, nothing from a previous call is
needed. Injection works via the manifest's host permissions
for the publisher origins (e.g. `*.sciencedirect.com`) — it
does NOT rely on an `activeTab` grant alone. Tab picking is
also explicit: when the side panel is open the active tab is
the article tab behind it; when the lookup page is open as a
full tab, the worker falls back to the most recently used
http(s) tab. If injection still fails, the UI now shows
Chrome's real error message instead of a generic one. The
blocked-fetch message also points at this button.

## Side panel (v3 — the popup no longer closes on outside clicks)

A Chrome popup closes the moment you click anywhere else in the
browser. So the main UI is now a **side panel**: clicking the
extension icon opens the panel, and it stays open while you browse,
keeping the last lookup result visible. The last lookup (input +
result) is saved in `chrome.storage.local` and restored when the
panel is reopened. There is also an **"Open in a full tab"**
button in the panel, which opens the same lookup page in a
browser tab as a second escape hatch.

## UI / theme (v3 polish)

Clean light academic look: navy (`#12324f`) headings, teal
(`#0f766e`) Lookup button and source badge, light grey-blue
background (`#f7f9fb`), white result card with a soft border.
v3 tightened the spacing, made the title the clear headline
(bold navy, larger) with the journal second (italic navy) and
the remaining rows plain, added a visible loading state
("Looking up…" + disabled button while fetching), and a
stronger input focus ring (teal border + soft teal glow).
Same colours, same logo concept — polish only. The layout is
responsive: the side panel keeps its narrow single-column look,
while the full tab (≥700px) centres the content in a ~920px
container with the input and Lookup button side by side and the
result rows in a wider label/value grid — no narrow left column
with empty space on the right.

## Logo — v11, the actual image #1 (27 Nov 2026, supersedes v9 below)

`icons/icon128.png`, `icons/icon48.png`, `icons/icon16.png` are
now the ACTUAL image #1 mark (a Dribbble design: six petal bands,
180° rotational symmetry, three blues) — cropped from the user's
reference image, gradient background stripped to transparent.
Uploaded to GitHub `/icons/` via the user's tab, commit `a364f2e`
("Update icons to actual Dribbble mark (v11)"). Flag: the mark is
a Dribbble design, not his — fine for test / Naqqash use, needs
permission or his own version before public publishing. The v9
"Interlinked Rise" history below is kept for the record only.

## Logo history (transparent, royal blue + burgundy, no background)

`icons/icon128.png`, `icons/icon48.png`, `icons/icon16.png` —
v9 "Interlinked Rise" (27 Nov 2026, user picked references #1 +
#2): one flowing S-ribbon cut into interlinked segments —
royal blue `#2226D2` top + bottom, deep burgundy `#6E1038`
middle, white gaps = the interlink. No page, no bars, no Q,
no fold, no star, no text. It reads on a light toolbar like the
other transparent extension icons (16px is a dedicated bold
redraw, not a downscale — thicker ribbon, wider gaps — so the
burgundy middle stays distinct). No text. Wired into
`manifest.json` under `icons` and `action.default_icon`, and
shown in the panel header (64px, 72px in the wide full-tab view).
Full history below.

**Designed properly (27 Nov 2026, on the user's ask to use design
skills / Canva, not just the image generator):** the design was
built in Canva (design `DAHcCzkNsOQ`, "Scientific journal ranking
extension icon", https://canva.link/r9cqdin7oj7soqw — tilted green
page, gold bars, sparkle), following the Impeccable skill's
design process (brief wins, verify by looking at the render at
shipping sizes, no gradient-text / glass / stock-component
shortcuts). **Canva blocker, reported honestly:** the account is
on the Canva Free plan, which cannot export a PNG with a
transparent background ("Users on the Canva Free plan can not
export PNGs with transparent background"). So the Canva design
was used as the visual source and rebuilt faithfully as clean
vector — `icons-src/icon.svg` (128/48px master) and
`icons-src/icon16.svg` (dedicated 16px redraw) — with geometry
measured from the Canva export (page tilt -7°, bars bottom-aligned,
ascending heights) and the exact settled colours, then rendered
to PNG with cairosvg (Chromium headless would not start in this
VM). Verified: RGBA, corner alpha 0, bar centres exactly
`#eab308`, page exactly `#166534`, readable on light-grey and
white at 128/48/16px.

**Education-team attempt (27 Nov 2026):** the user asked to use
his Canva Education team (Edwards-Bender Academy, 11,310 members)
for a max-quality transparent export. The Canva connector exposes
no team selection — `create-design` / `copy-design` / `export-design`
take no `team_id`, and `list-brand-kits` returns none. A fresh
design was created from the same brief (`DAHcC6UtUvA`,
https://canva.link/bzyd9c1uq9kphp5) and it landed in the same
team as the original (`team_id oBYV_Zo8oywXVqDBdEEqfo`), so its
transparent export failed with the same Free-plan error. The
connector cannot move a design into the Education team — that
step has to happen in the Canva app (open the design, make a
copy / move it into Edwards-Bender Academy), after which a
transparent export via the connector should work. Meanwhile the
128/48px icons were rebuilt from this fresh design's max-quality
export (2000×2000 PNG, `export_quality: pro`, lossless), with
the checkerboard stripped to real transparency using a crisp
0.4px feather (not the 1.2px blur that softened the earlier
version — that blur is why the last 128px looked low quality
next to the Canva export). Sampled colours from the Canva render:
page ≈ `#105B2E`, gold ≈ `#EFBC08`. 16px is still the dedicated
SVG redraw. Verified: RGBA, corner alpha 0, sharp on light-grey
at 128/48/16px.

**Figma / free-software route (27 Nov 2026, on the user's ask "can we
use figma or any other free software ... or ai just like figureslab"):**
checked all three. (a) **Figma** — a Figma connector exists
(`/opt/hatch/connectors/figma/CONNECTOR.md`) but the account is
**not connected** (`auth_status: not_connected`); Figma free does
export transparent PNGs, so it is a real option once the user
connects it at https://agent.meta.ai/connectors/connect/figma —
the agent cannot sign in for him. (b) **FigureLabs**
(figurelabs.ai) — a web AI scientific-figure tool (text/sketch to
figure, background removal, upscaling; free plan 150 credits, 1K
export, vector SVG export on paid plans only). No connector or
credential exists here and it needs a browser sign-in, so it
cannot be driven from this workspace; and for a 16px icon a raster
AI output is the wrong source anyway — it would need background
removal and would blur at toolbar size. (c) **Free vector software
— the route actually used:** the icon is a hand-built SVG master,
the same kind of file Inkscape / Figma free would produce,
rendered at exact size with cairosvg (no Inkscape/GIMP/rsvg on
this VM). Vector is lossless and transparent by nature, so there
is no Canva blocker and no raster-downscale blur. Bar steps evened
out (100/100/120) and the 16px redraw's bar gaps widened to 1.6px
so the bars stay distinct. Re-rendered 128/48/16 from
`icons-src/icon.svg` / `icon16.svg`; verified RGBA, corner alpha 0,
page exactly `#166534`, bars exactly `#eab308`, sharp on
light-grey at 128/48/16px.

**Built in Figma for real (27 Nov 2026 — Figma is now connected,
so the "not connected" note above is out of date):** new Figma
file "Journal Quartile Extension Icon",
https://www.figma.com/design/ZgCThVG9q6c1WKEwHdLu8U
(file key `ZgCThVG9q6c1WKEwHdLu8U`, team "Mubeen Nasir's team",
starter plan), drawn as real vector shapes via the Figma MCP
`use_figma` Plugin API (guides `figma-create-new-file`,
`figma-use`, `figma-generate-design` read first). Frame
"Icon 1024" (node `2:5`, 1024×1024, transparent fill): tilted
journal page −5° (deep green `#166534`, 56px rounded corners,
top-right corner square for the fold), folded top-right corner
as a vector triangle (`#15803d`), four chunky rounded gold bars
(`#eab308`, heights 196/344/492/640, bottom-aligned, ascending),
tiny 4-point gold sparkle — premium and polished, playful tilt
but clean geometry, not stiff corporate and not messy playful.
A second frame "Icon 16 bold" (node `3:2`, 256×256) is the
dedicated 16px redraw: 3 thicker gold bars + sparkle dot.
Exported via Figma `get_screenshot` (transparent PNG, RGBA,
corner alpha 0 — Figma screenshots keep the transparency, no
Canva Free blocker, no checkerboard to strip): 1024px master
rendered the vector at full size, then trimmed and Lanczos-
downscaled to 128/48; the 16px frame downscaled to 16.
Verified: page and bars sample exactly `#166534` / `#eab308`,
sharp on light-grey at 128/48/16px, 16px reads as 3 distinct
gold bars. (Note: `get_screenshot` caps at the node's natural
size, so the 1024px frame exports at 1024px even when asked
for 2048 — 8× the 128px target, still sharp. First build
attempt failed on the fold vector's region format — the
Plugin API wants `regions: [{loops: [[0,1,2]]}]`, not `loop` —
and rolled back cleanly, so it was retried in full.)

**Icon v7 — complete redesign in Figma (27 Nov 2026, on the
user's words "why not folded corner as in canva, and not looking
good, use design skills … even improve the color combo", "use all
design skills installed", "even change the design"):**
ALL installed design skills were read and applied — Impeccable
(`.claude/skills/impeccable/SKILL.md`: brief wins, redesign
replaces, verify by looking at the render at shipping sizes,
craft floor — contrast, real depth with offset+blur shadow,
drawn icons, commit to one world), Hallmark (hard floor: tokens,
no purple-blue gradient, no card-in-card, no emoji as icon, one
idea, look designed not generated), UI-UX Pro Max `design` skill
(icon section: filled/flat/rounded styles, multi-size export),
Diagram Design (one accent colour, 4px grid, complexity budget,
taste gate — ≤6 elements). Figma guides `figma-use`,
`figma-generate-design`, `figma-3d-transforms` were also read
before editing.
The design was reimagined, not just patched: the page is now
UPRIGHT (the −5° tilt was what broke the fold geometry and made
the bars lean), and the fold is a REAL curved dog-ear like the
Canva version — a quadratic-bezier crease bulging toward the
page centre, bright mint-emerald underside, and a soft drop
shadow under the crease so it reads as folded paper, not a flat
triangle (the old fold was a triangle rotated 37° — that is why
it looked wrong). Refined colour combo, still green + gold as
the user picked, but richer: page emerald `#0E6B3C`, fold
`#2FBF71`, bars/sparkle warm gold `#F5B301` (was `#166534` /
`#15803d` / `#eab308`). Four chunky bars, even 120px steps,
small sparkle clear of the fold. Built in Figma as real vector
shapes (frame "Icon v7 — 1024", node `7:3`; 16px frame
"Icon 16 v7", node `7:11`) and verified by screenshot at 1024px.
Honest limits: the polish pass (smaller fold, more bar clearance)
could not be applied — Figma MCP hit its Starter-plan tool-call
limit mid-task, and `cornerRadius` on vector vertices is
read-only in the Plugin API (the sharp fold tip is authentic to
a folded page — the Canva fold has it too). The Figma screenshot
renders on a flat `#E5E5E5` canvas background, so that grey was
stripped to real transparency with a 0.4px feather (no icon
colour is near that grey), then trimmed and Lanczos-downscaled
to 128/48; 16px is the dedicated SVG bold redraw
(`icons-src/icon16.svg`, 3 bars, curved fold). Vector masters
updated to v7 (`icons-src/icon.svg`, `icon16.svg`); Figma master
saved as `figma-icon-v7-master.png`. Verified: RGBA, corner
alpha 0, page/fold/bars sample exactly `#0E6B3C` / `#2FBF71` /
`#F5B301`, sharp on light-grey at 128/48/16px, 16px reads as
3 distinct gold bars.

**Icon v8 — COMPLETELY NEW concept (27 Nov 2026, on the user's
correction "i told you to change the design mesn change the icons
complelety" and "change the colors completely use a different combo
based on the design skills"):**
v7 kept the journal page + gold bars — that was NOT what he wanted.
v8 drops both entirely. New concept, one sentence: a bold **"Rising
Q"** — a large Q (quartile) whose tail becomes a rising arrow to a
star, i.e. a rank rising to Q1. No page, no bars, no fold.
New colour combo, NO green and NO gold in any form: deep navy
`#17233B` (the Q — dark and bold on a light toolbar) + vivid coral
`#FF5733` (the arrow + star — the single accent) + white counter
(the Q's hole, transparent by construction). Design-skill reasoning:
complementary navy↔coral gives maximum contrast on light
backgrounds (Impeccable: redesign replaces, verify at shipping
sizes); one accent colour only, solid fills, no purple-blue gradient
(Hallmark floor); 4px grid and a 4-element complexity budget
(Diagram Design); UI-UX Pro Max multi-size export.
Figma could NOT be used for v8: the MCP Starter-plan tool-call
limit was still hit on the first `use_figma` call ("You've reached
the Figma MCP tool call limit on the Starter plan"), so — as
instructed — no calls were wasted retrying it; v8 was built as a
clean SVG vector master (`icons-src/icon-v8.svg`, `icon16-v8.svg`,
also copied to `icon.svg` / `icon16.svg`) and rendered at exact
size with cairosvg. Verified: RGBA, corner alpha 0, sampled colours
exactly `#17233B` (2,222 px at 128px) / `#FF5733`; composited on
light toolbar grey, 128px and 48px read as a navy Q with a coral
rising arrow + star, and 16px (dedicated bold redraw, slim arrow +
small dot after the first 16px check merged them into a blob)
reads as a navy Q with a coral arrow. Figma file
https://www.figma.com/design/ZgCThVG9q6c1WKEwHdLu8U still holds
v6/v7; v8 lives in the SVG masters. Not tested in a real browser.

**Icon v9 — COMPLETELY NEW concept (27 Nov 2026, user picked
references #1 and #2: "1, 2"):**
References read first: #1 = blue flowing abstract mark, smooth
intertwined ribbon curves (deep blue + lighter blue, premium
modern); #2 = burgundy interlinked geometric premium knot
(clean rounded interlinked shapes, deep burgundy on cream,
luxury feel). v9 combines both: **"Interlinked Rise"** — one
flowing S-ribbon, cut into interlinked segments (royal blue top
+ bottom, burgundy middle, white gaps = the interlink), rising
bottom-left to top-right. NO page, NO chart bars, NO Q letter,
NO fold, NO star, NO text. Colours, from the references:
deep royal blue `#2226D2` + deep burgundy `#6E1038`, two colours
only, white gaps. The blue gives the flow (#1), the burgundy
gives the premium knot (#2); both are dark and bold on a light
toolbar. Skills applied: Impeccable (redesign replaces, verify
at shipping sizes), Hallmark floor (one idea, no purple-blue
gradient), UI-UX Pro Max (multi-size export), Diagram Design
(4px grid, complexity budget — 3 ribbon segments + 2 gaps).
Figma could NOT be used: the MCP Starter-plan tool-call limit
is still hit ("You've reached the Figma MCP tool call limit on
the Starter plan"), so v9 was built as a clean SVG vector master
(`icons-src/icon-v9.svg`, `icon16-v9.svg`, also copied to
`icon.svg` / `icon16.svg`) and rendered at exact size with
cairosvg. Two false starts were caught by visual checks: v9 v1
(two crossing ribbons) read as an X, and v9 v2's hand-drawn
white cuts were misaligned and ate the ribbon — fixed with
`pathLength` dash segments so the burgundy middle sits exactly
on the S curve. Note: cairosvg ignores `pathLength`, so the
16px dashes were computed in real path units (path length
≈21.8 units; burgundy 8–14, gaps 7–8.5 and 14–15.5) after the
first 16px redraw rendered with no burgundy at all. Verified:
RGBA, corner alpha 0 on all three sizes; 128px and 48px read as
a flowing blue S with a burgundy middle segment; 16px dedicated
bold redraw reads enlarged as a blue S with a distinct burgundy
middle. Not tested in a real browser.

**Canva replication of image #1 (27 Nov 2026, on the user's words
"replicate the 1 image logos look" and "use canva", then the
correction "that was not fucking s" — do NOT call image #1 an S and
do not build an S):** image #1, looked at again enlarged, is NOT
an S. It is a tall vertical mark of six curved petal/flame bands
in two stacked clusters with 180-degree rotational symmetry,
separated by clean white gaps: top cluster = small light
periwinkle teardrop top-left, medium indigo curved band centre,
large deep royal-blue curved band right with its tip at the
centre waist; bottom cluster is the exact 180-degree rotation
of the top. Colours only: deep royal blue `#0000FE`, medium
indigo `#4B4BE8`, light periwinkle `#8080F5`. Nothing else
invented — no sparkle, no bars, no letters, no fold, no star.
Built IN CANVA via the connector (`create-design`, design
`DAHcDMMZNm4`, "Abstract rotational symmetry icon",
https://canva.link/2n79x8r0q4emsa9, 2000×2000, 1 page, title
confirms the rotational symmetry). Verification of the Canva
artwork (regular PNG export, `export_quality: pro`, lossless,
2000×2000, saved as `canva-ref1-master-2000px.png`): the
structure is right — six bands, 180-degree symmetry, three
blues, white gaps — but NOT exact: Canva stretched the mark
taller and left a clear vertical gap between the two clusters
at the centre waist, where in image #1 the clusters touch and
interlock at the waist. **Transparent-export blocker, exact
error:** `export-design` with `transparent_background: true`
failed with "Users on the Canva Free plan can not export PNGs
with transparent background." The design landed in the same
Free team as before (`team_id oBYV_Zo8oywXVqDBdEEqfo`) — the
connector cannot pick a team. **What the user must do in the
Canva app:** open the design and copy/move it into the
Edwards-Bender Academy (Education) team; after that a
transparent export via the connector should work, and the
128/48/16 icons can be made from that transparent master.
**Icon files were NOT changed by this step** — they are still
v9 — and no SVG fallback was silently built. Not tested in a
real browser.

### Canva v2 — waist gap FIXED (27 Nov 2026, user: "fix gap, improve visuals, design, logo for extension")
New corrected Canva design `DAHcDHgiiSE`, https://canva.link/l41qifvecclrj0l,
built in Canva (`create-design`) from a precise brief stating the waist
interlock and compact proportions explicitly. **What changed:** the two
clusters now TOUCH at the centre waist — the tips of the two large deep-blue
bands meet at one centre pinch point, no vertical gap between the clusters
(v1 had a clear gap; v2 waist centre pixel is deep blue). Proportions
improved: mark 675×1757 px in the 2000×2000 export (ratio 2.6, was taller
in v1). Curves smoother, band edges clean, six bands, 180-degree symmetry,
thin even white S-gaps, bold enough for toolbar use. Sampled colours from
the v2 export match the brief: deep `#0101FE` (≈ `#0000FE`), indigo
`#4A4AEF` (≈ `#4B4BE8`), light `#7F7EFC` (≈ `#8080F5`). Nothing else
invented — same three blues, no sparkle/bars/letters/fold/star, no
background. **Honest remaining differences vs image #1:** the mark is
still slightly taller than the reference (ratio 2.6 vs ~2.2) and the bands
are a little fatter/rounder with less overlap at the waist than the
reference, where the clusters interlock past the pinch point. **Transparent
export tried again and failed with the same exact error** ("Users on the
Canva Free plan can not export PNGs with transparent background"). Regular
max-quality master saved as `canva-ref1-master-v2-2000px.png` (2000×2000,
pro, lossless, RGB, 1.4 MB). **User step still open:** move design
`DAHcDHgiiSE` into the Edwards-Bender Academy team in the Canva app for a
transparent export, then the 128/48/16 icons can be made. Icon files were
NOT changed by this step (still v9); no code changed; nothing pushed to
GitHub. Not tested in a real browser.

## Load unpacked in Chrome

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this folder
   (`journal-quartile-extension/phase1-spike/`). If you loaded
   an earlier version, remove it first (or click **Reload** on
   its card) so the side-panel registration picks up cleanly.
4. Click the extension icon in the toolbar — the side panel
   opens on the right. (If the icon is not visible, open the
   puzzle-piece menu and pin it.) After any code change, click
   **Reload** on the extension card — no need to remove and re-add.

## Test

1. Paste a DOI: `10.1038/nature14539` → Lookup. Should show title
   "Deep learning", journal "Nature", ISSN "0028-0836, 1476-4687",
   year "2015", publisher "Springer Science and Business Media LLC",
   "Vol. 521, pp. 436–444", DOI linked to doi.org, Source: Crossref.
2. Paste a link: `https://doi.org/10.1016/j.cell.2020.02.052` →
   Lookup. Should resolve to the Cell 2020 article.
3. Paste a Nature article link with no DOI in it:
   `https://www.nature.com/articles/s41598-026-62863-y` →
   Lookup. Should resolve via the page metadata to DOI
   `10.1038/s41598-026-62863-y` and show "Combined effect of
   cauliflower intercropping and Pseudomonas fluorescens seed
   biopriming on the suppression of fusarium wilt in okra",
   Scientific Reports, 2026, Source: Crossref.
4. Paste a PMC link: `https://pmc.ncbi.nlm.nih.gov/articles/PMC7217796/`
   → Lookup. Should resolve via the page metadata to DOI
   `10.1016/j.cytogfr.2020.05.005` ("The Covid-19 pandemic in
   Denmark…", Cytokine & Growth Factor Reviews, 2020).
5. Paste a bad DOI: `10.9999/nonexistent123` → Lookup. Should
   show "Not found" (Crossref returns 404; OpenAlex also has
   no record).
6. Paste plain text with no DOI, e.g. `hello` → Lookup. Should
   show "No DOI found".
7. Click outside the side panel in the browser — the panel must
   stay open with the last result still visible. Click "Open in
   a full tab" — the same lookup page opens in a tab.
8. Blocked-publisher test (retest after the 26 Nov 2026 fix —
   v4 failed this step with "Chrome wouldn't let the extension
   read that tab" because of the invalid files+func call, see
   above): open
   `https://www.sciencedirect.com/science/article/pii/S0944501317303993`
   in a tab, click the extension icon so the side panel opens
   on the right, tap "Check this page". It must read the DOI
   from the open page and show
   `10.1016/j.micres.2017.08.011` ("Assessment of two carrier
   materials for phosphate solubilizing biofertilizers…",
   Microbiological Research, 2017, Source: Crossref) — the
   background fetch of that link is blocked (HTTP 403), so this
   only works via the open tab. Nothing about this DOI is
   hard-coded; the DOM reader must find it on the page. If it
   fails, the error now shows Chrome's real reason.

## Files

- `manifest.json` — Manifest V3, version 0.2.0; permissions
  `storage`, `activeTab`, `sidePanel`, `scripting`, `tabs`
  (`scripting` + `tabs` are for "Check this page": inject the
  DOI reader into the open article tab and find that tab when
  the lookup page is open as a full tab); `side_panel` default
  path `sidepanel.html` (no `default_popup` any more); host
  permissions for `api.crossref.org`, `api.openalex.org`, plus
  a curated publisher list (nature, sciencedirect, elsevier,
  springer, wiley, tandfonline, mdpi, frontiers, nih.gov,
  europepmc, oup, sagepub, cambridge, acs, rsc, iop, science.org,
  cell, thelancet, bmj, plos, biorxiv, medrxiv) — narrow list,
  no blanket `*://*/*`; icons wired in.
- `shared.js` — the one copy of the DOI logic (extract, slug
  fallback, generic page-metadata parser, bot-block detector),
  loaded by the lookup page and by the service worker.
- `sidepanel.html` / `popup.css` / `popup.js` — the lookup UI
  and logic (popup.js is the shared page script, despite the
  name). Plain HTML/JS, no dependencies, no build step, no
  remotely hosted code. Lookup is Crossref first, OpenAlex
  fallback; last result persisted in `chrome.storage.local`.
- `background.js` — service worker: fetches an article page
  and returns the DOI parsed from its metadata (blocked pages
  reported as blocked, not as "no DOI"), reads the DOI from the
  open article tab's DOM for "Check this page" (ONE
  executeScript call with a fully self-contained extractor
  func — no `files`, no cross-call persistence to fail; host
  permission, no fetch, no storage; real injection errors are
  surfaced with Chrome's message), and opens the side panel on
  icon click. No storage, page HTML is discarded after parsing.
- `icons/icon16.png`, `icons/icon48.png`, `icons/icon128.png` —
  the extension logo in three sizes (v3 redraw).
