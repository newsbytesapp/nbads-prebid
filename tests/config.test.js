/**
 * @fileoverview
 * Tests for `src/config.js` — defaults and env overrides.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_CONFIG, createConfig } from '../src/config.js';

test('createConfig returns defaults when no env is provided', () => {
  const config = createConfig();
  assert.equal(config.routePath, DEFAULT_CONFIG.routePath);
  assert.equal(config.buildEndpoint, DEFAULT_CONFIG.buildEndpoint);
  assert.equal(config.defaultVersion, DEFAULT_CONFIG.defaultVersion);
  assert.deepEqual(config.allowedVersions, DEFAULT_CONFIG.allowedVersions);
  assert.deepEqual(config.bidderAdapters, DEFAULT_CONFIG.bidderAdapters);
  assert.deepEqual(config.standardModules, DEFAULT_CONFIG.standardModules);
  assert.equal(config.cacheControl, DEFAULT_CONFIG.cacheControl);
  assert.equal(config.fallbackCacheControl, DEFAULT_CONFIG.fallbackCacheControl);
  assert.equal(config.maxRetries, DEFAULT_CONFIG.maxRetries);
  assert.equal(config.retryDelayMs, DEFAULT_CONFIG.retryDelayMs);
});

test('createConfig applies string overrides from env', () => {
  const config = createConfig({
    PREBID_ROUTE_PATH: '/alt/prebid.js',
    PREBID_BUILD_ENDPOINT: 'https://example.com/build',
    PREBID_DEFAULT_VERSION: '9.0.0',
    PREBID_CACHE_CONTROL: 'max-age=123, public',
    PREBID_FALLBACK_CACHE_CONTROL: 'max-age=456, public',
  });

  assert.equal(config.routePath, '/alt/prebid.js');
  assert.equal(config.buildEndpoint, 'https://example.com/build');
  assert.equal(config.defaultVersion, '9.0.0');
  assert.equal(config.cacheControl, 'max-age=123, public');
  assert.equal(config.fallbackCacheControl, 'max-age=456, public');
});

test('createConfig parses comma-separated list env overrides', () => {
  const config = createConfig({
    PREBID_ALLOWED_VERSIONS: '9.0.0, 8.0.0 ,9.1.0',
    PREBID_BIDDERS: 'openxBidAdapter, appnexusBidAdapter',
    PREBID_STANDARD_MODULES: 'consentManagementTcf , storageControl',
  });

  assert.deepEqual(config.allowedVersions, ['9.0.0', '8.0.0', '9.1.0']);
  assert.deepEqual(config.bidderAdapters, ['openxBidAdapter', 'appnexusBidAdapter']);
  assert.deepEqual(config.standardModules, ['consentManagementTcf', 'storageControl']);
});

test('createConfig parses integer overrides and clamps invalid to defaults', () => {
  assert.equal(createConfig({ PREBID_MAX_RETRIES: '5', PREBID_RETRY_DELAY_MS: '250' }).maxRetries, 5);
  assert.equal(createConfig({ PREBID_MAX_RETRIES: '5', PREBID_RETRY_DELAY_MS: '250' }).retryDelayMs, 250);
  // Invalid numbers fall back to defaults.
  assert.equal(createConfig({ PREBID_MAX_RETRIES: 'abc' }).maxRetries, DEFAULT_CONFIG.maxRetries);
  assert.equal(createConfig({ PREBID_RETRY_DELAY_MS: '-5' }).retryDelayMs, DEFAULT_CONFIG.retryDelayMs);
  assert.equal(createConfig({ PREBID_MAX_RETRIES: '' }).maxRetries, DEFAULT_CONFIG.maxRetries);
});
