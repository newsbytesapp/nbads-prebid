/**
 * @fileoverview
 * Tests for the `nbads-prebid` Worker fetch handler: valid builds, caching, retries,
 * fallback-to-cached, invalid-bundle rejection, and route/method guards.
 */

import assert from 'node:assert/strict';
import test, { beforeEach, afterEach } from 'node:test';

import worker from '../src/index.js';
import {
  VALID_JS_CT,
  cacheKeyUrl,
  makeCtx,
  makeRequest,
  mockCaches,
  mockFetch,
  restoreGlobals,
  upstreamResponse,
  validBody,
} from './helpers.js';

// Fast retry config used in failure-path tests so they don't sleep.
const FAST_RETRY_ENV = { PREBID_MAX_RETRIES: '2', PREBID_RETRY_DELAY_MS: '0' };
const NO_RETRY_ENV = { PREBID_MAX_RETRIES: '1', PREBID_RETRY_DELAY_MS: '0' };

beforeEach(() => {});
afterEach(() => restoreGlobals());

test('serves a valid build on cache miss and caches both tiers', async () => {
  const cache = mockCaches();
  const fetchMock = mockFetch(() => upstreamResponse());
  const ctx = makeCtx();

  const resp = await worker.fetch(makeRequest('/nbads/prebid.js', { v: '11.23.0' }), {}, ctx);

  assert.equal(resp.status, 200);
  assert.equal(resp.headers.get('Content-Type'), 'application/javascript; charset=utf-8');
  assert.equal(resp.headers.get('Cache-Control'), 'max-age=604800, public, s-maxage=86400');
  assert.equal(resp.headers.get('X-Prebid-Version'), '11.23.0');
  assert.equal(await resp.text(), validBody());

  // Upstream fetched exactly once.
  assert.equal(fetchMock.count(), 1);
  // Both primary and fallback tiers were written to the cache.
  const tierKeys = cache.puts.map((p) => p.key);
  assert.equal(tierKeys.filter((k) => k.includes('tier=primary')).length, 1);
  assert.equal(tierKeys.filter((k) => k.includes('tier=fallback')).length, 1);
});

test('serves from the primary cache without re-fetching', async () => {
  const cache = mockCaches();
  const request = makeRequest('/nbads/prebid.js', { v: '11.23.0' });
  cache.store.set(
    cacheKeyUrl(request, '11.23.0', 'primary'),
    new Response(validBody(), { status: 200 })
  );
  const fetchMock = mockFetch(() => upstreamResponse());

  const resp = await worker.fetch(request, {}, makeCtx());

  assert.equal(resp.status, 200);
  assert.equal(await resp.text(), validBody());
  // The cached response is re-tagged with the version header.
  assert.equal(resp.headers.get('X-Prebid-Version'), '11.23.0');
  assert.equal(fetchMock.count(), 0);
  assert.equal(cache.puts.length, 0);
});

test('retries a transient network failure and then succeeds', async () => {
  mockCaches();
  const fetchMock = mockFetch((attempt) => {
    if (attempt === 1) {
      return Promise.reject(new Error('network down'));
    }
    return upstreamResponse();
  });

  const resp = await worker.fetch(
    makeRequest('/nbads/prebid.js', { v: '11.23.0' }),
    FAST_RETRY_ENV,
    makeCtx()
  );

  assert.equal(resp.status, 200);
  assert.equal(fetchMock.count(), 2);
});

test('retry-exhausted with cached fallback serves the last-known-good build', async () => {
  const cache = mockCaches();
  const request = makeRequest('/nbads/prebid.js', { v: '11.23.0' });
  // Seed only the long-lived fallback tier (as if a prior good build existed).
  cache.store.set(
    cacheKeyUrl(request, '11.23.0', 'fallback'),
    new Response(validBody(), { status: 200 })
  );
  const fetchMock = mockFetch(() => Promise.reject(new Error('unreachable')));

  const resp = await worker.fetch(request, FAST_RETRY_ENV, makeCtx());

  assert.equal(resp.status, 200);
  assert.equal(await resp.text(), validBody());
  assert.equal(resp.headers.get('X-Prebid-Served-From'), 'fallback');
  // Upstream exhausted its retries.
  assert.equal(fetchMock.count(), Number(FAST_RETRY_ENV.PREBID_MAX_RETRIES));
});

test('retry-exhausted with no cache returns 502 and never caches a failure', async () => {
  mockCaches();
  const fetchMock = mockFetch(() => Promise.reject(new Error('unreachable')));

  const resp = await worker.fetch(
    makeRequest('/nbads/prebid.js', { v: '11.23.0' }),
    NO_RETRY_ENV,
    makeCtx()
  );

  assert.equal(resp.status, 502);
  assert.equal(fetchMock.count(), 1);
});

test('rejects an invalid (non-JS / tiny) bundle and never caches it', async () => {
  const cache = mockCaches();
  // HTTP 200 but a text/html error payload — the build service's failure signature.
  const fetchMock = mockFetch(() =>
    upstreamResponse('{"error":"Prebid file not built properly"}', 'text/html; charset=utf-8')
  );

  const resp = await worker.fetch(
    makeRequest('/nbads/prebid.js', { v: '11.23.0' }),
    NO_RETRY_ENV,
    makeCtx()
  );

  assert.equal(resp.status, 502);
  assert.equal(cache.puts.length, 0);
  assert.equal(fetchMock.count(), 1);
});

test('returns 502 on a non-2xx upstream response', async () => {
  mockCaches();
  const fetchMock = mockFetch(() => new Response('boom', { status: 503 }));

  const resp = await worker.fetch(
    makeRequest('/nbads/prebid.js', { v: '11.23.0' }),
    NO_RETRY_ENV,
    makeCtx()
  );

  assert.equal(resp.status, 502);
  assert.equal(fetchMock.count(), 1);
});

test('route guard returns 404 for a different path', async () => {
  const resp = await worker.fetch(makeRequest('/other.js'), {}, makeCtx());
  assert.equal(resp.status, 404);
});

test('method guard returns 405 for non-GET/HEAD', async () => {
  const resp = await worker.fetch(
    makeRequest('/nbads/prebid.js', {}, { method: 'POST' }),
    {},
    makeCtx()
  );
  assert.equal(resp.status, 405);
});

test('version resolution: whitelisted, unknown, and missing `v`', async () => {
  const cases = [
    { v: '11.23.0', expected: '11.23.0' },
    { v: '99.99.99', expected: '11.23.0' }, // unknown -> default
    { expected: '11.23.0' }, // missing `v` -> default
  ];

  for (const { v, expected } of cases) {
    mockCaches();
    const fetchMock = mockFetch(() => upstreamResponse());

    const params = v ? { v } : {};
    const resp = await worker.fetch(makeRequest('/nbads/prebid.js', params), {}, makeCtx());

    assert.equal(resp.headers.get('X-Prebid-Version'), expected);
    // The resolved version was sent to the build service body.
    const [url, init] = fetchMock.calls[0];
    assert.equal(url, 'https://js-download.prebid.org/download');
    assert.ok(init.body.includes(`version=${expected}`));
  }
});

test('sends the configured module list to the build service', async () => {
  mockCaches();
  const fetchMock = mockFetch(() => upstreamResponse());

  await worker.fetch(makeRequest('/nbads/prebid.js', { v: '11.23.0' }), {}, makeCtx());

  const [, init] = fetchMock.calls[0];
  const body = String(init.body);
  assert.ok(body.includes('modules[]=magniteBidAdapter'));
  assert.ok(body.includes('modules[]=consentManagementTcf'));
  assert.ok(body.includes('modules[]=storageControl'));
  assert.ok(body.includes('version=11.23.0'));
  assert.equal(init.headers['Content-Type'], 'application/x-www-form-urlencoded');
});

test('Cache-Control override from env is applied to client responses', async () => {
  mockCaches();
  mockFetch(() => upstreamResponse());

  const resp = await worker.fetch(
    makeRequest('/nbads/prebid.js', { v: '11.23.0' }),
    { PREBID_CACHE_CONTROL: 'max-age=900, public' },
    makeCtx()
  );

  assert.equal(resp.headers.get('Cache-Control'), 'max-age=900, public');
});

test('fallback cache entry uses the fallback Cache-Control via env', async () => {
  const cache = mockCaches();
  mockFetch(() => upstreamResponse());

  await worker.fetch(
    makeRequest('/nbads/prebid.js', { v: '11.23.0' }),
    { PREBID_FALLBACK_CACHE_CONTROL: 'max-age=7777, public' },
    makeCtx()
  );

  const fallbackPut = cache.puts.find((p) => p.key.includes('tier=fallback'));
  assert.ok(fallbackPut);
  assert.equal(fallbackPut.resp.headers.get('Cache-Control'), 'max-age=7777, public');
});
