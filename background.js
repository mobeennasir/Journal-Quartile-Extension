// Phase 1 spike: background service worker.
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
// ROOT CAUSE of the v4 failure (26 Nov 2026, ScienceDirect page):
// v4 made ONE chrome.scripting.executeScript call with BOTH
// files: ["shared.js"] AND func: () => extractDoiFromDocument(...).
// Per the scripting API spec, exactly one of `files` and `func`
// must be specified — a call with both is invalid, so the extractor
// never ran and the call failed, surfacing as the generic
// "Chrome wouldn't let the extension read that tab" message even
// though the user WAS on the article tab. The fix is two separate
// calls (below), and the real error is surfaced, not hidden.
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

    // Step 1: inject shared.js alone. Exactly one of `files`/`func`
    // per call — see the root-cause note above. This defines
    // extractDoiFromDocument in the tab's isolated world.
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["shared.js"],
      });
    } catch (err) {
      sendResponse({
        doi: null, error: "inject-shared-failed", host,
        detail: String(err && err.message || err),
      });
      return;
    }

    // Step 2: run the extractor in a separate call. The func is
    // self-contained (it only calls the global that step 1 defined
    // — executeScript serialises the func, so it cannot see any
    // closure from this service worker) and returns the DOI or null.
    let results;
    try {
      results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          if (typeof extractDoiFromDocument !== "function") return null;
          try { return extractDoiFromDocument(document); } catch (e) { return null; }
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
