/**
 * @fileoverview
 * Shared test helpers for the `nbads-prebid` Worker tests. These provide lightweight
 * fakes for the Cloudflare Worker globals (`caches`, `fetch`) and constructors for the
 * test environment, using Node's built-in `Request`/`Response`/`URL`.
 *
 * @module tests/helpers
 */

// Capture the originals once so `restoreGlobals()` can reliably undo a test's mocks,
// regardless of which helpers were used.
const ORIGINAL_FETCH = globalThis.fetch;
const HAD_CACHES = Object.prototype.hasOwnProperty.call(globalThis, 'caches');
const ORIGINAL_CACHES = globalThis.caches;

/** The path the Worker serves by default. @type {string} */
export const ROUTE_PATH = '/nb/template/prebid.js';

/** A valid `Content-Type` for an upstream prebid.js bundle. @type {string} */
export const VALID_JS_CT = 'application/javascript; charset=UTF-8';

/**
 * Produce a body that looks like a real (large enough) prebid.js bundle so it passes the
 * `MIN_BUNDLE_BYTES` sanity check in the Worker.
 *
 * @returns {string} A fake bundle body.
 */
export function validBody() {
  return '/* prebid.js\nfunction pbjs(){}\n'.repeat(200);
}

/**
 * Create an upstream-style `Response` that the build service would return.
 *
 * @param {string} [body] Response body.
 * @param {string} [contentType] `Content-Type` header value.
 * @returns {Response} A 200 response representing a build attempt.
 */
export function upstreamResponse(body = validBody(), contentType = VALID_JS_CT) {
  return new Response(body, { status: 200, headers: { 'Content-Type': contentType } });
}

/**
 * Build a `Request` the Worker expects.
 *
 * @param {string} [path] Request path (defaults to `ROUTE_PATH`).
 * @param {Record<string, string | number>} [params] Query parameters.
 * @param {RequestInit} [init] Extra request init (method, headers, etc.).
 * @returns {Request} A synthetic inbound request.
 */
export function makeRequest(path = ROUTE_PATH, params = {}, init = {}) {
  const url = new URL(`https://example.com${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }
  return new Request(url.toString(), init);
}

/**
 * Create a minimal `ExecutionContext` for the Worker handler.
 *
 * @param {(p: Promise<unknown>) => void} [waitUntil] Optional waitUntil implementation.
 * @returns {{ waitUntil: (p: Promise<unknown>) => void }} A fake context.
 */
export function makeCtx(waitUntil = (p) => p.catch(() => {})) {
  return { waitUntil };
}

/**
 * Replace the global `fetch` with a recording stub.
 *
 * @param {(attempt: number, args: Parameters<typeof fetch>) => Response | Promise<Response>} handler Per-call handler (1-indexed attempt).
 * @returns {{ calls: Array<Parameters<typeof fetch>>, count: () => number }} Handles for assertions.
 */
export function mockFetch(handler) {
  /** @type {Array<Parameters<typeof fetch>>} */
  const calls = [];
  const stub = /** @type {typeof fetch} */ (async (...args) => {
    calls.push(args);
    const result = handler(calls.length, args);
    return result;
  });
  globalThis.fetch = stub;
  return { calls, count: () => calls.length };
}

/**
 * Replace the global `caches` with an in-memory fake supporting `match`/`put`.
 *
 * @returns {{ store: Map<string, Response>, puts: Array<{ key: string, resp: Response }>, matches: string[] }} Handles for assertions.
 */
export function mockCaches() {
  /** @type {Map<string, Response>} */
  const store = new Map();
  /** @type {Array<{ key: string, resp: Response }>} */
  const puts = [];
  /** @type {string[]} */
  const matches = [];

  globalThis.caches = /** @type {any} */ ({
    default: {
      /** @param {Request} key */
      async match(key) {
        const keyUrl = key.url;
        matches.push(keyUrl);
        return store.get(keyUrl);
      },
      /** @param {Request} key @param {Response} resp */
      async put(key, resp) {
        const keyUrl = key.url;
        store.set(keyUrl, resp);
        puts.push({ key: keyUrl, resp });
        return true;
      },
    },
  });

  return { store, puts, matches };
}

/**
 * Compute the cache-key URL the Worker uses for a given version and tier, so tests can
 * seed/assert cache entries without duplicating the key logic.
 *
 * @param {Request} request The inbound request (for the host).
 * @param {string} version The Prebid version.
 * @param {'primary' | 'fallback'} tier The cache tier.
 * @param {string} [routePath] The route path.
 * @returns {string} The synthetic cache-key URL.
 */
export function cacheKeyUrl(request, version, tier, routePath = ROUTE_PATH) {
  const url = new URL(request.url);
  url.pathname = routePath;
  url.search = `?v=${encodeURIComponent(version)}&tier=${tier}`;
  return url.toString();
}

/** Restore the original `fetch`/`caches` globals after a test. */
export function restoreGlobals() {
  globalThis.fetch = ORIGINAL_FETCH;
  if (HAD_CACHES) {
    globalThis.caches = ORIGINAL_CACHES;
  } else {
    try {
      delete globalThis.caches;
    } catch {
      /* no-op */
    }
  }
}
