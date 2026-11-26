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
via `chrome.scripting` + `activeTab`, and runs the normal
Crossref lookup on it. The page is already loaded by you, so
no fetch happens and no bot check can apply. It needs two
extra permissions: `scripting` (inject the reader) and `tabs`
(find the article tab when the lookup page itself is open as a
full tab). If Chrome won't let the extension read the tab (e.g.
you navigated after opening the panel and the activeTab grant
lapsed), it says so plainly — click the extension icon while
you're on the article tab and try again. The blocked-fetch
message now also points at this button.

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

## Logo (v3, regenerated)

`icons/icon128.png`, `icons/icon48.png`, `icons/icon16.png` —
same concept (journal + ascending quartile bars, teal only),
transparent background, no navy square, no border, no backdrop:
just the teal journal document with four ascending teal bars,
no text. All three are real PNGs with an alpha channel.
Wired into `manifest.json` under `icons` and
`action.default_icon`, and shown in the panel header (44px).

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
8. Blocked-publisher test: open
   `https://www.sciencedirect.com/science/article/pii/S0944501317303993`
   in a tab, click the extension icon, tap "Check this page".
   It must read the DOI from the open page and show
   `10.1016/j.micres.2017.08.011` ("Assessment of two carrier
   materials for phosphate solubilizing biofertilizers…",
   Microbiological Research, 2017, Source: Crossref) — the
   background fetch of that link is blocked (HTTP 403), so this
   only works via the open tab. Nothing about this DOI is
   hard-coded; the DOM reader must find it on the page.

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
  open article tab's DOM for "Check this page" (injects
  shared.js, runs the DOM extractor — no fetch, no storage),
  and opens the side panel on icon click. No storage, page HTML
  is discarded after parsing.
- `icons/icon16.png`, `icons/icon48.png`, `icons/icon128.png` —
  the extension logo in three sizes (v3 redraw).
