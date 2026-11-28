# Journal Quartile Extension

A Chrome extension that shows a journal's quartile (Q1 to Q4) and Impact Factor **for the year an article was published**, not for today.

A 2021 article needs the journal's 2021 ranking. A 2026 ranking would be the wrong answer for it. This extension looks up the ranking for the article's own publication year, every time.

## What it does

- Looks up an article by DOI, publisher article link, or manual entry (title, journal, year).
- Shows the journal, ISSN, publication year, and publisher from Crossref, with OpenAlex as fallback.
- Shows the **JCR quartile and Journal Impact Factor for the publication year**, from JCR data you import yourself.
- Shows the **Web of Science category**: W for SCIE, SSCI or AHCI indexed journals, X for ESCI (Emerging) journals. Checked automatically from the free Master Journal List, no JCR needed.
- Shows the **SJR quartile as a labelled fallback** when no JCR data exists for the year, from SJR data the extension fetches itself. No JCR needed.
- Checks a whole list of articles at once from an Excel or CSV file, and exports the results as CSV.
- Reads the DOI from the article page you already have open, with **Check this page**, so a publisher bot check cannot block the lookup.

## Features

### Look up one article

Two lookup methods are available in the panel:

- **DOI or article link.** Paste a bare DOI, a doi.org link, or any publisher article URL, for example `10.1038/nature14539` or a nature.com or ScienceDirect link. The DOI is read from the article page itself when a link is pasted.
- **Enter details manually.** For old articles with no DOI or link. Type the title, journal, and year. DOI and ISSN are optional.

**Check this page** reads the DOI from the open article tab. Use it when a publisher blocks the automatic page read. Open the article in a tab, open the extension panel, and tap the button.

### Check a list of articles

**Upload a list (Excel / CSV).** Upload a `.csv`, `.xlsx` or `.xls` file with one article per row. Columns it understands: title, journal, year, DOI if known, ISSN if known, volume and pages. A DOI is not required. Each article is located by its title and journal. The extension returns one result row per article, with the quartile and Impact Factor for that article's own year. Results can be saved with **Download results as CSV**.

A built-in test set is included, containing 67 publications from the Google Scholar profile of Dr. Tahir Naqqash. It is available in the panel as **Use the Naqqash test set (67 articles)**.

### Free data, fetched automatically

**Auto-fetch free data** is on by default. On first run, and once a year after, the extension downloads the free SJR CSV and the free WoS Master Journal List itself, straight from their official sites, and stores them in the extension. No user action, no server.

Stored free data is reused for every lookup until the next list is published, about a year. SJR data is valid until the next June release. The WoS list is valid for 12 months. The panel shows the remaining time in one short line, for example "SJR data: valid until June 2027, 7 months left". Re-fetch happens only after expiry.

If the automatic fetch fails, the order is: one-click download in your browser, then manual import as last resort. **Get free SJR data** tries the direct download first, then opens the SJR download in a background tab in your browser and imports it automatically. If SJR blocks the download (bot check), the panel says so plainly and you can download the CSV from scimagojr.com yourself and use **Import SJR file**. The WoS category is also checked automatically for each article from the free public Master Journal List search, which needs no login. Data from any of these paths is stored until expiry, never used once and discarded.

### Import JCR data

**Import JCR data.** Upload your own JCR export file (CSV, `.xlsx`, or HTML-table `.xls`). The data is saved in the extension and reused until the next JCR release in June. You pick the **Data year this export covers**, which is the year the numbers describe, not the year you downloaded the file. Multiple files merge. The file name, edition year, upload date, and expiry are shown in the panel.

The extension never scrapes JCR and never stores or asks for a JCR login. You export the file yourself from your own JCR access and import it here.

### SJR fallback, clearly labelled

**Import SJR data (fallback quartile, NOT JCR).** If no JCR data exists for a journal and year, the extension can fall back to the SJR quartile. Use **Get free SJR data** to fetch it, or import an SJR CSV you downloaded in your browser. Every SJR value is labelled **"SJR quartile, fallback, NOT JCR (year)"**, so it can never be mistaken for a JCR quartile. No SJR values are bundled with the extension. The SJR import takes a .csv file only.

### Web of Science category

**Import WoS journal list (for category W / X).** The category is checked automatically for each article from the free public Master Journal List search, and for a whole batch with **Get WoS categories (free)**. You can also upload a Master Journal List export. W means SCIE, SSCI or AHCI. X means ESCI (Emerging). If the list cannot be read, the result says **"Unknown, WoS list could not be read"**, and if the journal is not listed it says **"Not in the WoS list"**. No value is estimated or guessed. The WoS list import takes .csv, .xlsx or .xls files.

## Data sources and labelling

| What you see | Where it comes from |
|---|---|
| Article title, journal, ISSN, year, publisher | Crossref first, OpenAlex fallback |
| JCR quartile and Impact Factor for the publication year | JCR export you import (primary source) |
| SJR quartile | SJR CSV, fetched automatically or imported (fallback only, always labelled NOT JCR) |
| WoS category W or X | Free Master Journal List search, checked automatically per article, or a Master Journal List export or JCR data |

Every result shows its source and year. If no JCR data exists for the article's year, the result says **"No JCR data for this year"**. It never shows another year's ranking in its place.

Why JCR is the source for the WoS quartile: Web of Science itself shows whether a journal is indexed, but the Q1 to Q4 ranking lives only in Journal Citation Reports (JCR), which is built from Web of Science data. SJR and CiteScore are Scopus based systems with different maths, and they can disagree with JCR.

## Install

1. Clone this repo, or download it as a ZIP and extract it.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top right toggle).
4. Click **Load unpacked** and select this folder.
5. Click the extension icon in the toolbar. The side panel opens on the right. If the icon is not visible, open the puzzle piece menu and pin it.

After any update, run `git pull` in the folder, then click **Reload** on the extension card in `chrome://extensions`. There is no need to remove and re-add it.

## How to use

1. **One article:** paste a DOI or article link and click **Look up**. Or use **Enter details manually** for an article with no DOI.
2. **First time setup:** click **Import JCR data** and upload a JCR export, picking the data year it covers. Without this, results will say "No JCR data for this year", which is correct, not an error. The WoS category and the SJR fallback do not need this step. They are fetched automatically.
3. **A list of articles:** click **Upload a list (Excel / CSV)**, choose the file, then **Upload and check all articles**. Use **Download results as CSV** to save the results.
4. **Blocked publisher page:** if a lookup says the publisher blocked the automatic read, open the article in a tab and tap **Check this page**.

## Status

Version **0.4.6**, 28 November 2026. Tests pass: `node tests/run-tests.js` gives 548 passed, 0 failed (section 39 covers the per-year SJR fetch timer and the WoS store-first fix; section 40 covers "Check this page" on any journal site and stored not-indexed WoS answers). UI uses the Flame Q brand palette (flame orange, dark burgundy). The free WoS and SJR data are fetched automatically; the WoS category is read from the rendered Master Journal List page in the browser, and the SJR download runs through one shared browser tab when the direct download is blocked. A batch interrupted by the panel closing or the browser restarting can be resumed from where it stopped, and every WoS category fetched is saved in the extension database. Journals with no WoS category and no quartile get an HEC fallback: HEC Y, checked automatically against DOAJ or from an imported HEC recognised-journals list, always labelled as a fallback and never as a quartile. "Check this page" works on any journal site: the first tap asks once for permission for that site, then it just works. A journal confirmed not in the WoS list is remembered for 30 days, so repeat checks answer at once.

## Files

- `manifest.json` - Manifest V3, version 0.4.6. Author: Mobeen Nasir.
- `sidepanel.html`, `popup.css`, `popup.js` - the side panel UI and logic. Plain HTML and JavaScript, no dependencies, no build step, no remotely hosted code.
- `shared.js` - the one copy of the DOI logic, shared by the page and the service worker. Also holds the full-tab helpers and the upload file-type guard.
- `freedata.js` - the free data without JCR: Master Journal List search URLs and parsing, SJR download URLs and checks, latest SJR year.
- `net.js` - JSON fetch with timeout and one retry, plus a bounded article cache so a repeated lookup does not re-fetch.
- `background.js` - service worker. Fetches an article page and reads the DOI from its metadata, reads the DOI from the open tab for Check this page, and runs the automatic free-data fetch (SJR and WoS list) on first run and once a year after, with a one-click browser-tab download as fallback.
- `jcr.js` - JCR, SJR and Master Journal List parsers, the IndexedDB store, year-exact lookup, and results CSV builder.
- `xlsx.js` - minimal bundled `.xlsx` reader.
- `test-set.csv` - the Naqqash Scholar test set, 67 articles.
- `tests/` - synthetic test files and `run-tests.js`. Run with `node tests/run-tests.js`.
- `icons/` - the extension icon in 16, 48 and 128 px.
