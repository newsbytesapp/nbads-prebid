/**
 * @fileoverview
 * Cloudflare Worker that downloads, caches at the edge, and serves a custom
 * `prebid.js` bundle at the `GET /nbads/prebid.js` endpoint.
 *
 * The bundle is produced by Prebid's official build service (`js-download.prebid.org`).
 * This Worker wraps that service so clients get a stable, aggressively cached asset on a
 * controlled path instead of calling the build endpoint directly.
 *
 * Reliability model:
 *   - The download is **retried** on transient failure up to `config.maxRetries`.
 *   - A bundle is **only cached and served after it is validated** ("proper" JS), so a
 *     partial or error payload is never served to clients.
 *   - On a persistent download failure the Worker serves the **most recent good build**
 *     from a long-lived "fallback" cache, so a stale-but-valid bundle beats a hard error.
 *
 * Content compression (gzip/br) is handled automatically by Cloudflare's CDN for
 * `application/javascript` responses when the client advertises `Accept-Encoding`, so no
 * manual compression is performed here.
 *
 * Configuration lives in `./config.js` and can be overridden via Worker bindings (env
 * vars) defined in the `Env` typedef below.
 */

import { createConfig } from './config.js';

/**
 * Minimum acceptable bundle size in bytes. The Prebid build service returns a tiny JSON
 * error (a few dozen bytes) on failure; anything smaller than this is treated as invalid.
 * @type {number}
 */
const MIN_BUNDLE_BYTES = 1024;

/**
 * Worker bindings / environment object (all optional).
 * @typedef {object} Env
 * @property {string} [PREBID_BUILD_ENDPOINT] Override for the Prebid build service URL.
 * @property {string} [PREBID_DEFAULT_VERSION] Override for the default Prebid version.
 * @property {string} [PREBID_ALLOWED_VERSIONS] Comma-separated whitelist of versions.
 * @property {string} [PREBID_ROUTE_PATH] Override for the served path.
 * @property {string} [PREBID_BIDDERS] Comma-separated bidder adapter module names.
 * @property {string} [PREBID_STANDARD_MODULES] Comma-separated always-included modules.
 * @property {string} [PREBID_CACHE_CONTROL] Override the client-facing `Cache-Control`.
 * @property {string} [PREBID_FALLBACK_CACHE_CONTROL] Override the fallback `Cache-Control`.
 * @property {string} [PREBID_MAX_RETRIES] Override the upstream download retry count.
 * @property {string} [PREBID_RETRY_DELAY_MS] Override the retry base delay in ms.
 */

/**
 * Execution context passed to the Worker handler.
 * @typedef {import('@cloudflare/workers-types').ExecutionContext} Ctx
 */

/**
 * Result of a build attempt.
 * @typedef {{ ok: true, js: string } | { ok: false, error: string }} BuildResult
 */

/**
 * Wait for the given number of milliseconds.
 * @param {number} ms Milliseconds to wait.
 * @returns {Promise<void>} Resolves after the delay.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve the version to serve based on the request's `?v=` query parameter.
 *
 * Rules:
 *   - No `?v=`            -> config.defaultVersion
 *   - `?v=` in whitelist  -> that version
 *   - `?v=` unknown       -> config.defaultVersion (keeps stale cache-busting URLs working)
 *
 * @param {Request} request The inbound request.
 * @param {{ allowedVersions: readonly string[], defaultVersion: string }} config Effective config.
 * @returns {string} The resolved Prebid version.
 */
function resolveVersion(request, config) {
  const v = new URL(request.url).searchParams.get('v');
  if (v && config.allowedVersions.includes(v)) {
    return v;
  }
  return config.defaultVersion;
}

/**
 * Build the `application/x-www-form-urlencoded` body accepted by the Prebid build
 * service. The service expects repeated `modules[]=` fields plus a single `version=`.
 *
 * @param {string} version The Prebid version to request.
 * @param {{ bidderAdapters: readonly string[], standardModules: readonly string[] }} config Effective config.
 * @returns {string} Encoded form body.
 */
function buildModuleBody(version, config) {
  const modules = [...config.bidderAdapters, ...config.standardModules];
  const parts = modules.map((m) => `modules[]=${encodeURIComponent(m)}`);
  parts.push(`version=${encodeURIComponent(version)}`);
  return parts.join('&');
}

/**
 * Determine whether an upstream response is a genuine, servable prebid.js bundle.
 *
 * The build service returns HTTP 200 even on failure, with a tiny JSON error body and a
 * `text/html` content-type. A valid bundle is served as JavaScript and is comfortably
 * larger than `MIN_BUNDLE_BYTES`.
 *
 * @param {string} contentType The response's `Content-Type` header.
 * @param {string} js The response body text.
 * @returns {boolean} True when the body looks like a real bundle.
 */
function isProperBundle(contentType, js) {
  return /javascript/i.test(contentType) && js.trim().length > MIN_BUNDLE_BYTES;
}

/**
 * Attempt to download (and validate) a prebid.js bundle from the build service, retrying
 * on transient failures. A failed attempt is never treated as a valid build.
 *
 * @param {{ buildEndpoint: string, bidderAdapters: readonly string[], standardModules: readonly string[], maxRetries: number, retryDelayMs: number }} config Effective config.
 * @param {string} version The Prebid version to build.
 * @returns {Promise<BuildResult>} The validated source text, or a retry-exhausted error.
 */
async function downloadBuild(config, version) {
  let lastError = 'unknown failure';
  const { maxRetries, retryDelayMs } = config;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const upstream = await fetch(config.buildEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: buildModuleBody(version, config),
      });

      if (!upstream.ok) {
        lastError = `HTTP ${upstream.status}`;
      } else {
        const contentType = upstream.headers.get('content-type') ?? '';
        const js = await upstream.text();
        if (isProperBundle(contentType, js)) {
          return { ok: true, js };
        }
        lastError = 'non-JavaScript (invalid) response';
      }
    } catch {
      lastError = 'network error';
    }

    // Back off before retrying (not after the final attempt).
    if (attempt < maxRetries - 1) {
      await sleep(retryDelayMs * (attempt + 1));
    }
  }

  return { ok: false, error: lastError };
}

/**
 * Construct the response served to the client with the correct content type and
 * cache headers. The `X-Prebid-Version` header aids debugging (which build is served).
 * Cloudflare's CDN compresses this `application/javascript` body for gzip-capable clients.
 *
 * @param {string} js The prebid.js source text.
 * @param {string} version The version the bundle was built for.
 * @param {string} cacheControl The `Cache-Control` value to send.
 * @returns {Response} A ready-to-serve response.
 */
function makeResponse(js, version, cacheControl) {
  return new Response(js, {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': cacheControl,
      'X-Prebid-Version': version,
    },
  });
}

/**
 * Clone a Response while overriding its `Cache-Control`. Used to store the long-lived
 * "last-known-good" fallback entry without changing what clients receive.
 *
 * @param {Response} response The response to clone.
 * @param {string} cacheControl The `Cache-Control` value to apply to the clone.
 * @returns {Response} A new Response with the same body and updated headers.
 */
function withCacheControl(response, cacheControl) {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', cacheControl);
  return new Response(response.body, { status: response.status, headers });
}

/**
 * Rebuild a cached Response, re-tagging it and marking how it was sourced when needed.
 *
 * @param {Response} cached The cached Response to rebuild.
 * @param {string} version The Prebid version.
 * @param {string} [servedFrom] When set, adds an `X-Prebid-Served-From` header.
 * @returns {Response} A fresh Response wrapping the cached body.
 */
function rebuildCached(cached, version, servedFrom) {
  const resp = new Response(cached.body, cached);
  resp.headers.set('X-Prebid-Version', version);
  if (servedFrom) {
    resp.headers.set('X-Prebid-Served-From', servedFrom);
  }
  return resp;
}

/**
 * Build a cache key (a synthetic GET Request) for a given version and tier. We key on the
 * public URL so the primary and fallback entries differ only by a `tier` marker.
 *
 * @param {Request} request The inbound request (used to derive the host).
 * @param {string} version The Prebid version.
 * @param {string} routePath The path this Worker serves.
 * @param {'primary' | 'fallback'} tier The cache tier.
 * @returns {Request} A request object usable with `caches.default`.
 */
function cacheKeyFor(request, version, routePath, tier) {
  const url = new URL(request.url);
  url.pathname = routePath;
  url.search = `?v=${encodeURIComponent(version)}&tier=${tier}`;
  return new Request(url.toString());
}

/**
 * Worker entry point.
 *
 * @param {Request} request The inbound request.
 * @param {Env} env Worker bindings.
 * @param {Ctx} ctx Execution context (used for `waitUntil`).
 * @returns {Promise<Response>} The response to return to the client.
 */
export default {
  /** @param {Request} request @param {Env} env @param {Ctx} ctx */
  async fetch(request, env, ctx) {
    const config = createConfig(env);
    const url = new URL(request.url);

    // Route guard: only the exact prebid.js path is served.
    if (url.pathname !== config.routePath) {
      return new Response('Not found', { status: 404 });
    }

    // Method guard: only GET (and HEAD, for free via fetch semantics) is supported.
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405 });
    }

    const version = resolveVersion(request, config);
    const primaryKey = cacheKeyFor(request, version, config.routePath, 'primary');

    // 1) Try the primary Workers Cache first (in-memory edge cache).
    const cached = await caches.default.match(primaryKey);
    if (cached) {
      return rebuildCached(cached, version);
    }

    // 2) Cache miss: attempt a validated download, retrying transient failures.
    const build = await downloadBuild(config, version);

    if (build.ok) {
      const response = makeResponse(build.js, version, config.cacheControl);
      // Persist both the client-facing (primary) and the long-lived fallback entries
      // without blocking the response.
      const fallbackKey = cacheKeyFor(request, version, config.routePath, 'fallback');
      ctx.waitUntil(
        Promise.all([
          caches.default.put(primaryKey, response.clone()),
          caches.default.put(
            fallbackKey,
            withCacheControl(response.clone(), config.fallbackCacheControl)
          ),
        ])
      );
      return response;
    }

    // 3) Download failed after retries: serve the most recent good build, if any, so a
    //    valid (stale) bundle is preferred over a hard failure. Otherwise error out.
    const fallbackKey = cacheKeyFor(request, version, config.routePath, 'fallback');
    const fallback = await caches.default.match(fallbackKey);
    if (fallback) {
      return rebuildCached(fallback, version, 'fallback');
    }

    return new Response(`Prebid build unavailable (${build.error})`, { status: 502 });
  },
};
