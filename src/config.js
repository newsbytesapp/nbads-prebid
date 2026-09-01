/**
 * @fileoverview
 * Central configuration for the `nbads-prebid` Worker.
 *
 * Defaults live in `DEFAULT_CONFIG`. They can be overridden at runtime via Worker
 * bindings (env vars / secrets) so the same deployment can serve different bidders,
 * versions, or endpoints without a code change. See `createConfig()`.
 */

/**
 * The effective configuration shape (also used for `DEFAULT_CONFIG`).
 * @typedef {object} PrebidConfig
 * @property {string} routePath The path this Worker serves.
 * @property {string} buildEndpoint The Prebid build service URL.
 * @property {string} defaultVersion Version used when `?v=` is missing/unknown.
 * @property {readonly string[]} allowedVersions Whitelist of buildable versions.
 * @property {readonly string[]} bidderAdapters Bidder adapter modules bundled.
 * @property {readonly string[]} standardModules Modules always included.
 * @property {string} cacheControl `Cache-Control` sent to clients / primary cache.
 * @property {string} fallbackCacheControl `Cache-Control` for the long-lived fallback cache.
 * @property {number} maxRetries Upstream download retry attempts (0 = none).
 * @property {number} retryDelayMs Base delay (ms) between retry attempts.
 */

/**
 * Default configuration. These mirror the original Laravel `config/prebid.php`:
 *   - `bidderAdapters`   – the enabled bidder adapters bundled into prebid.js
 *   - `standardModules`  – modules always included regardless of bidders
 *   - `defaultVersion`   – version used when `?v=` is missing or unknown
 *   - `allowedVersions`  – version whitelist (anything else falls back to `defaultVersion`)
 *
 * @type {PrebidConfig}
 */
export const DEFAULT_CONFIG = {
  /** The single path this Worker serves. */
  routePath: '/nbads/prebid.js',

  /** Prebid's offline build/download service. */
  buildEndpoint: 'https://js-download.prebid.org/download',

  /** Version served when `?v=` is absent or not whitelisted. */
  defaultVersion: '11.23.0',

  /**
   * Whitelist of versions the Worker is allowed to build and serve. A version is only
   * added after confirming it builds (the service returns HTTP 200 even on failure).
   * @type {readonly string[]}
   */
  allowedVersions: ['11.23.0'],

  /** Bidder adapter module names bundled into the build. */
  bidderAdapters: [
    'magniteBidAdapter',
    'msftBidAdapter',
    'inmobiBidAdapter',
    'eskimiBidAdapter',
  ],

  /** Modules always included (consent/GPP, TCF, GPT pre-auction, storage). */
  standardModules: [
    'consentManagementTcf',
    'consentManagementGpp',
    'gppControl_usnat',
    'gppControl_usstates',
    'tcfControl',
    'gptPreAuction',
    'storageControl',
  ],

  /**
   * `Cache-Control` sent to clients and used for the primary edge cache: a long browser
   * cache with a shorter shared (CDN) max-age so a rollback is possible.
   */
  cacheControl: 'max-age=604800, public, s-maxage=86400',

  /**
   * `Cache-Control` for the long-lived "last-known-good" fallback entry, kept for a year
   * so a previously valid build stays servable if the primary entry expires and the
   * upstream is unreachable.
   */
  fallbackCacheControl: 'max-age=31536000, public, s-maxage=31536000',

  /** Upstream download retry attempts (0 = no retry). */
  maxRetries: 3,

  /** Base delay (ms) between retry attempts; grows linearly with the attempt number. */
  retryDelayMs: 500,
};

/**
 * Parse a comma-separated env value into a string array. Returns `null` when the value
 * is missing/empty so callers fall back to the default.
 *
 * @param {string | undefined} value Raw env value.
 * @returns {string[] | null} Trimmed, non-empty entries, or `null`.
 */
function csv(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Parse a non-negative integer env value. Returns `null` when the value is missing or
 * not a valid non-negative integer so callers fall back to the default.
 *
 * @param {string | undefined} value Raw env value.
 * @returns {number | null} Parsed integer, or `null`.
 */
function nonNegativeInt(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * Build the effective configuration, merging defaults with runtime env overrides.
 * Every override is optional; omitting an env var keeps the default.
 *
 * Environment variables recognized:
 *   - PREBID_ROUTE_PATH          -> routePath
 *   - PREBID_BUILD_ENDPOINT      -> buildEndpoint
 *   - PREBID_DEFAULT_VERSION     -> defaultVersion
 *   - PREBID_ALLOWED_VERSIONS    -> allowedVersions (comma-separated)
 *   - PREBID_BIDDERS             -> bidderAdapters (comma-separated)
 *   - PREBID_STANDARD_MODULES    -> standardModules (comma-separated)
 *   - PREBID_CACHE_CONTROL       -> cacheControl (Cache-Control string)
 *   - PREBID_FALLBACK_CACHE_CONTROL -> fallbackCacheControl (Cache-Control string)
 *   - PREBID_MAX_RETRIES         -> maxRetries (int)
 *   - PREBID_RETRY_DELAY_MS      -> retryDelayMs (int)
 *
 * @param {Record<string, string | undefined>} [env] Worker bindings (env vars).
 * @returns {PrebidConfig}
 */
export function createConfig(env = {}) {
  return {
    routePath: env.PREBID_ROUTE_PATH ?? DEFAULT_CONFIG.routePath,
    buildEndpoint: env.PREBID_BUILD_ENDPOINT ?? DEFAULT_CONFIG.buildEndpoint,
    defaultVersion: env.PREBID_DEFAULT_VERSION ?? DEFAULT_CONFIG.defaultVersion,
    allowedVersions: csv(env.PREBID_ALLOWED_VERSIONS) ?? DEFAULT_CONFIG.allowedVersions,
    bidderAdapters: csv(env.PREBID_BIDDERS) ?? DEFAULT_CONFIG.bidderAdapters,
    standardModules: csv(env.PREBID_STANDARD_MODULES) ?? DEFAULT_CONFIG.standardModules,
    cacheControl: env.PREBID_CACHE_CONTROL ?? DEFAULT_CONFIG.cacheControl,
    fallbackCacheControl:
      env.PREBID_FALLBACK_CACHE_CONTROL ?? DEFAULT_CONFIG.fallbackCacheControl,
    maxRetries: nonNegativeInt(env.PREBID_MAX_RETRIES) ?? DEFAULT_CONFIG.maxRetries,
    retryDelayMs: nonNegativeInt(env.PREBID_RETRY_DELAY_MS) ?? DEFAULT_CONFIG.retryDelayMs,
  };
}
