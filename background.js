// Phase 2: background service worker.
// Two jobs:
//  1. Fetch an article page and extract its DOI from the page
//     metadata (generic path, any publisher — see shared.js).
//     A service-worker fetch with host_permissions is CORS-exempt,
//     so this works for publisher pages where a popup fetch would
//     be blocked by CORS. No data is stored; the DOI is returned
//     to the lookup page and the page HTML is discarded.
//  2. Open the side panel when the extension icon is clicked
//     (the side panel, unlike a popup, stays open when you click
//     elsewhere in the browser).

importScripts("shared.js");

// "Check this page": read the DOI from the live DOM of the article
// tab the user is already on. The page is already loaded by the user,
// so no fetch happens and a publisher bot check cannot apply.
//
// ROOT CAUSE of the v4/v5 failures (26–27 Nov 2026, ScienceDirect):
// v4 made ONE executeScript call with BOTH files: ["shared.js"] AND
// func — invalid, exactly one of `files`/`func` may be specified, so
// the extractor never ran. The v5 "fix" split it into two calls:
// step 1 injected shared.js, step 2 called the global it defined.
// That is fragile too: top-level `const`/`function` declarations in
// an injected file do NOT reliably persist across separate
// executeScript calls in the tab's isolated world — step 2's
// `typeof extractDoiFromDocument === "function"` can be false (or
// the call can throw because the `const DOI_PATTERN` it closes over
// is gone), so it silently returned null — "No DOI found on this
// page" — even though step 1 "succeeded" and the DOI was on the
// page. The user confirmed this on 27 Nov 2026: pasting the
// ScienceDirect link (background fetch) worked, "Check this page"
// still did nothing.
//
// The fix below is ONE executeScript call with ONLY `func`, and the
// func is FULLY SELF-CONTAINED: the whole DOI extraction lives
// inside it (same priority order as shared.js extractDoiFromDocument
// — citation_doi, DC.Identifier, JSON-LD, og:url, canonical, head
// doi.org link). Nothing is injected by a previous call and nothing
// is read from any closure, so there is no cross-call persistence
// to fail.
//
// Permission path: this does NOT rely on activeTab alone. The
// manifest grants host_permissions for the publisher origins
// (*.sciencedirect.com, *.nature.com, etc.), and
// chrome.scripting.executeScript is allowed on any origin the
// extension has a host permission for — no activeTab grant needed.
// activeTab is only a fallback for origins outside that list.
async function checkThisPage(sendResponse) {
  try {
    if (!chrome.scripting || !chrome.scripting.executeScript) {
      sendResponse({ doi: null, error: "no-scripting", detail: "chrome.scripting is unavailable in this browser." });
      return;
    }
    // Pick the article tab. When the side panel is open, the panel
    // is not a tab, so the active tab in the window IS the article
    // tab the user is looking at. When the lookup page itself is
    // open as a full tab, it is the active tab, so fall back to the
    // most recently used http(s) tab in this window instead.
    // (Needs the "tabs" permission so tab URLs are visible here.)
    let tab = null;
    try {
      const active = await chrome.tabs.query({ active: true, currentWindow: true });
      const first = active && active[0];
      if (first && first.id && first.url && /^https?:\/\//.test(first.url)) {
        tab = first;
      }
    } catch (err) { /* fall through to the all-tabs search */ }
    if (!tab) {
      const all = await chrome.tabs.query({ currentWindow: true });
      const candidates = (all || []).filter((t) => t && t.id && t.url && /^https?:\/\//.test(t.url));
      candidates.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
      tab = candidates[0] || null;
    }
    if (!tab || !tab.id || !tab.url || !/^https?:\/\//.test(tab.url)) {
      sendResponse({ doi: null, error: "no-article-tab" });
      return;
    }
    let host = "";
    try { host = new URL(tab.url).hostname; } catch (err) { /* ignore */ }

    // ONE executeScript call, `func` only — no `files`. The func is
    // fully self-contained (see the root-cause note above): it
    // defines everything it needs inside itself and only touches
    // the page's own `document`. It returns the DOI string or null.
    let results;
    try {
      results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          try {
            const DOI_PATTERN = /10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i;
            const pick = (value) => {
              if (!value) return null;
              const d = String(value).match(DOI_PATTERN);
              return d ? d[0] : null;
            };
            const metaContent = (selector) => {
              const el = document.querySelector(selector);
              return el ? el.getAttribute("content") : null;
            };
            let doi = pick(metaContent('meta[name="citation_doi"]'))
              || pick(metaContent('meta[property="citation_doi"]'))
              || pick(metaContent('meta[name="DC.Identifier"]'))
              || pick(metaContent('meta[name="dc.identifier"]'));
            if (doi) return doi;
            // JSON-LD blocks: "doi", or an "@id" pointing at doi.org.
            const scripts = document.querySelectorAll('script[type="application/ld+json"]');
            for (const script of scripts) {
              try {
                const data = JSON.parse(script.textContent || "");
                const candidates = Array.isArray(data) ? data : [data];
                for (const item of candidates) {
                  if (!item || typeof item !== "object") continue;
                  doi = pick(item.doi) || pick(item["@id"]);
                  if (doi) return doi;
                }
              } catch (e) { /* not JSON — skip this block */ }
            }
            doi = pick(metaContent('meta[property="og:url"]'));
            if (doi) return doi;
            const canonical = document.querySelector('link[rel="canonical"]');
            if (canonical) {
              doi = pick(canonical.getAttribute("href"));
              if (doi) return doi;
            }
            // A doi.org link inside <head> only — references live
            // in the body, so scanning the whole page would risk a
            // cited DOI.
            const headLinks = document.head ? document.head.querySelectorAll("a[href]") : [];
            for (const a of headLinks) {
              doi = pick(a.getAttribute("href"));
              if (doi) return doi;
            }
            return null;
          } catch (e) {
            return null;
          }
        },
      });
    } catch (err) {
      sendResponse({
        doi: null, error: "inject-extract-failed", host,
        detail: String(err && err.message || err),
      });
      return;
    }
    const firstResult = results && results[0];
    if (firstResult && firstResult.error) {
      sendResponse({
        doi: null, error: "inject-extract-failed", host,
        detail: String(firstResult.error.message || firstResult.error),
      });
      return;
    }
    const doi = firstResult && firstResult.result;
    sendResponse({ doi: doi || null, host, url: tab.url });
  } catch (err) {
    sendResponse({ doi: null, error: String(err && err.message || err) });
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.type === "checkThisPage") {
    checkThisPage(sendResponse);
    return true; // async sendResponse
  }
  if (!message || message.type !== "fetchPageDoi" || !message.url) {
    sendResponse({ doi: null });
    return false;
  }
  let url;
  try {
    url = new URL(message.url);
  } catch (err) {
    sendResponse({ doi: null, error: "bad url" });
    return false;
  }
  fetch(url.toString(), { headers: { Accept: "text/html" } })
    .then(async (response) => {
      const html = await response.text();
      if (!response.ok || isBlockedPage(html, response.status)) {
        sendResponse({ doi: null, blocked: true, status: response.status });
        return;
      }
      sendResponse({ doi: parseDoiFromHtml(html) });
    })
    .catch((err) => sendResponse({ doi: null, error: String(err && err.message || err) }));
  return true; // async sendResponse
});

// Side panel: clicking the toolbar icon opens the panel, not a popup.
if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  const enablePanel = () => {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {
      // Older Chrome without setPanelBehavior: fall back to onClicked.
    });
  };
  chrome.runtime.onInstalled.addListener(enablePanel);
  chrome.runtime.onStartup.addListener(enablePanel);
  enablePanel();
}
if (chrome.action && chrome.action.onClicked) {
  chrome.action.onClicked.addListener((tab) => {
    if (chrome.sidePanel && chrome.sidePanel.open) {
      chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
    }
  });
}
