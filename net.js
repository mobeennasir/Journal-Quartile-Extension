// Network helpers for the Journal Quartile Extension: JSON fetch
// with a timeout and one retry, plus a small bounded cache so a
// repeated lookup does not re-fetch. No DOM access here, so it is
// safe to load in the page, the service worker, and Node tests.
// Pure functions take the fetch implementation as a parameter so
// tests can stub it; in the browser the global fetch is used.

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_RETRIES = 1;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Fetch a URL and parse the body as JSON. Retries once on a
// dropped connection, an empty or unparsable body, a 429, or a 5xx.
// Aborts after timeoutMs so a hung request never freezes the panel.
// Throws a short Error; the caller turns it into a short message.
async function fetchJson(url, options) {
  const opts = options || {};
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const retries = (opts.retries === undefined) ? DEFAULT_RETRIES : opts.retries;
  const doFetch = opts.fetchFn || fetch;
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = (typeof AbortController !== "undefined") ? new AbortController() : null;
    let timer = null;
    try {
      // Race the fetch against the timeout: the timeout wins even
      // if the fetch implementation ignores the abort signal.
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
          if (controller) controller.abort();
          reject(new Error("Request timed out"));
        }, timeoutMs);
      });
      const response = await Promise.race([
        doFetch(url, {
          headers: { Accept: "application/json" },
          signal: controller ? controller.signal : undefined,
        }),
        timeoutPromise,
      ]);
      if (!response.ok) {
        const error = new Error("HTTP " + response.status);
        error.status = response.status;
        throw error;
      }
      const text = await response.text();
      if (!text || !text.trim()) throw new Error("Empty response");
      return JSON.parse(text);
    } catch (err) {
      lastError = err;
      const isAbort = err && (err.name === "AbortError" || err.name === "TimeoutError" || err.message === "Request timed out");
      const status = err && err.status;
      const retryable = isAbort || !status || status === 429 || status >= 500;
      if (attempt < retries && retryable) {
        await sleep(status === 429 ? 2000 : 1200);
        continue;
      }
      if (isAbort) throw new Error("Request timed out");
      if (err instanceof SyntaxError) throw new Error("Bad response from server");
      throw lastError;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  throw lastError || new Error("Network error");
}

// Bounded in-memory cache with in-flight deduplication: two
// identical lookups started together share one fetch, and a repeat
// lookup returns the stored result without fetching again.
class ArticleCache {
  constructor(maxEntries) {
    this.maxEntries = maxEntries || 200;
    this.store = new Map();
    this.pending = new Map();
  }

  get(key) {
    const hit = this.store.get(key);
    if (hit === undefined) return undefined;
    // Refresh recency for the LRU order.
    this.store.delete(key);
    this.store.set(key, hit);
    return hit;
  }

  set(key, value) {
    if (this.store.has(key)) this.store.delete(key);
    this.store.set(key, value);
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      this.store.delete(oldest);
    }
  }

  async getOrFetch(key, fetchFn) {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    if (this.pending.has(key)) return this.pending.get(key);
    const promise = Promise.resolve()
      .then(fetchFn)
      .then((value) => {
        this.pending.delete(key);
        if (value !== null && value !== undefined) this.set(key, value);
        return value;
      })
      .catch((err) => {
        this.pending.delete(key);
        throw err;
      });
    this.pending.set(key, promise);
    return promise;
  }
}

const JournalQuartileNet = { fetchJson, ArticleCache, sleep, DEFAULT_TIMEOUT_MS };

if (typeof module !== "undefined" && module.exports) {
  module.exports = JournalQuartileNet;
} else if (typeof window !== "undefined") {
  window.JournalQuartileNet = JournalQuartileNet;
} else if (typeof self !== "undefined") {
  self.JournalQuartileNet = JournalQuartileNet;
}
