# nbads-prebid

A [Cloudflare Worker](https://developers.cloudflare.com/workers/) that downloads a
custom [prebid.js](https://docs.prebid.org/download.html) build from Prebid's official
build service, caches it at the edge, and serves it at a single, stable URL:

```
GET /nb/template/prebid.js?v=11.23.0
```

It replaces the Laravel `prebid:download` command + `public/js/prebid.js` static file
approach with a fully dynamic, CDN-served asset that never requires a rebuild step.

---

## Architecture

```
Client
  │  GET /nb/template/prebid.js?v=11.23.0
  ▼
Cloudflare CDN ──(cached, Cache-Control: public)──► served instantly
  │  (miss / expired)
  ▼
Worker (src/index.js)
  │  1. check caches.default (Workers Cache API)  ── hit ──► serve
  │  2. miss
  │  POST https://js-download.prebid.org/download
  │     body: modules[]=...&version=11.23.0
  │  3. store in caches.default + serve
  ▼
Client
```

Two layers of edge caching:

1. **Cloudflare CDN** — because the Worker returns `Cache-Control: public`, Cloudflare
   caches the response for the shared `s-maxage` (86400s / 1 day). Most requests are
   served directly by the CDN and never reach the Worker.
2. **Workers Cache API (`caches.default`)** — if/when the worker IS invoked, it first
   checks the in-memory edge cache keyed by version, reusing an already-built bundle
   until its TTL expires.

This is an **edge-only** caching strategy (no KV bucket). The trade-off: for each
distinct version, an upstream Prebid build can recur roughly once per cache cycle.

---

## Project structure

```
.
├── src/index.js          # Worker logic (JSDoc-documented)
├── src/config.js         # Configuration: defaults + env overrides
├── tests/                # Node test-runner tests (node:test)
│   ├── helpers.js        # Fakes for caches/fetch + request constructors
│   ├── index.test.js     # Worker fetch-handler behaviour
│   └── config.test.js    # Defaults + env overrides
├── wrangler.toml         # Worker name, entrypoint, compatibility_date, cache enabled
├── package.json          # scripts + devDependencies (wrangler, types, typescript)
├── tsconfig.json         # TypeScript type-checking of the JSDoc worker
├── .env.example          # Documented env-var reference (env overrides)
├── .gitignore            # excludes node_modules, .wrangler, .env, .dev.vars, logs
├── .gitattributes        # normalises line endings
└── README.md             # this file
```

### Content compression

Cloudflare's CDN automatically compresses (`gzip`/`brotli`) these `application/javascript`
responses for clients that advertise `Accept-Encoding`. The Worker does **not** compress
the bundle itself — it serves plain JS and lets the CDN negotiate encoding.
```

---

## Configuration

Configuration lives in [`src/config.js`](src/config.js) as `DEFAULT_CONFIG`, mirroring the
original `config/prebid.php`. Every value can be overridden at runtime through Worker
bindings (env vars) via `createConfig(env)` — see [Environment overrides](#environment-overrides).

| Key                 | Description                                                          |
| ------------------- | -------------------------------------------------------------------- |
| `routePath`         | Path this Worker serves.                                             |
| `buildEndpoint`     | Prebid build service URL.                                            |
| `defaultVersion`    | Version used when `?v=` is missing or not whitelisted.                |
| `allowedVersions`   | Whitelist of versions this Worker will build/serve.                   |
| `bidderAdapters`    | Enabled bidder adapters bundled into the build.                       |
| `standardModules`   | Modules always included (consent/GPP, TCF, GPT pre-auction, storage). |
| `cacheControl`      | `Cache-Control` sent to clients / primary cache.                       |
| `fallbackCacheControl` | `Cache-Control` for the long-lived fallback cache.                  |
| `maxRetries`        | Upstream download retry attempts (0 = none).                          |
| `retryDelayMs`      | Base delay (ms) between retry attempts.                               |

**Example — the current module list:**

- **Bidders:** `magniteBidAdapter`, `msftBidAdapter`, `inmobiBidAdapter`, `eskimiBidAdapter`
- **Standard:** `consentManagementTcf`, `consentManagementGpp`, `gppControl_usnat`,
  `gppControl_usstates`, `tcfControl`, `gptPreAuction`, `storageControl`

### Adding / removing bidders

Edit `bidderAdapters` in [`src/config.js`](src/config.js) (or override `PREBID_BIDDERS`).
Include the full module name the build service expects (e.g. `magniteBidAdapter`). Then
purge the cache so a stale build is not served (see [Cache purge](#cache-purge)).

### Updating the version

- Bump `defaultVersion` in [`src/config.js`](src/config.js).
- Add the new version to `allowedVersions` **only after confirming it builds** (a
  version is buildable if a `curl` POST to the build endpoint returns
  `Content-Type: application/javascript`). Unbuildable versions were known to return
  HTTP 200 with a JSON error, which this Worker rejects as a `502`.
- Purge the cache.

---

## Endpoints & behavior

| Method | Path                | Behavior                                                        |
| ------ | ------------------- | --------------------------------------------------------------- |
| GET    | `/nb/template/prebid.js`  | Returns the prebid.js bundle for the resolved version.           |
| HEAD   | `/nb/template/prebid.js`  | Same headers as GET (no body) — free via normal fetch semantics. |
| other  | any other path      | `404 Not found`.                                                 |
| POST   | `/nb/template/prebid.js`  | `405 Method not allowed`.                                        |

### Version resolution

| Request `?v=`              | Result                     |
| -------------------------- | -------------------------- |
| (missing)                  | `defaultVersion`           |
| in `allowedVersions`       | that version               |
| anything else              | `defaultVersion` (silent fallback) |

The silent fallback keeps old cache-busted URLs working while bounding builds to the
whitelist.

### Response headers

Mirrors the Laravel implementation:

```
Content-Type: application/javascript; charset=utf-8
Cache-Control: max-age=604800, public, s-maxage=86400
X-Prebid-Version: 11.23.0     # added by this Worker for debugging
```

---

## Getting started

Requires **Node.js 18+** and a [Cloudflare account](https://dash.cloudflare.com/).

```bash
# 1. Install dependencies
npm install

# If npm warns about install scripts being blocked for esbuild/workerd, allow them:
npm install-scripts approve esbuild workerd

# 2. Run locally
npm run dev
# -> http://localhost:8787/nb/template/prebid.js?v=11.23.0

# 3. Type-check the worker
npm run typecheck

# 4. Run the tests
npm test

# 5. Deploy
npm run deploy
```

### Custom domain

By default the Worker is available at `<your-worker-name>.workers.dev`. To mount it
under a path on your own domain, add a **route** in the Cloudflare dashboard:
`<yourdomain.com>/nb/template/prebid.js*` → `nbads-prebid`.

### Deploying to a custom zone via wrangler

```toml
# wrangler.toml (optional addition)
routes = [
  { pattern = "yourdomain.com/nbads*", zone_name = "yourdomain.com" }
]
```

---

## Verification

```bash
# Check headers (Hit vs Miss / version)
curl -sI 'https://<your-host>/nb/template/prebid.js?v=11.23.0'

# Verify the body is valid JS
curl -s 'https://<your-host>/nb/template/prebid.js?v=11.23.0' | grep -c 'window.pbjs' || true

# Confirm the edge-cache state
curl -sI 'https://<your-host>/nb/template/prebid.js?v=11.23.0' | grep -i cf-cache-status
```

- `CF-Cache-Status: HIT` → served from the CDN.
- `X-Prebid-Version` → shows which version was served.

---

## Cache purge

If you change the module list or upgrade the version, purge the old bundle so clients
don't receive a stale build.

**Via the Cloudflare dashboard** (recommended): Cloudflare → Caching → Purge → purge the
URL `https://<your-host>/nb/template/prebid.js?v=<old-version>`.

**Via API** (requires an API token with cache-purge permission):

```bash
curl -X POST 'https://api.cloudflare.com/client/v4/zones/<ZONE_ID>/purge_cache' \
  -H "Authorization: Bearer <API_TOKEN>" \
  -H "Content-Type: application/json" \
  --data '{"files":["https://<your-host>/nb/template/prebid.js?v=11.23.0"]}'
```

---

## Error handling

| Scenario                                        | Response         |
| ----------------------------------------------- | ---------------- |
| Wrong path / method                             | `404` / `405`    |
| Upstream Prebid service unreachable (network)   | `502` (retried, then fallback) |
| Upstream Prebid service returns non-2xx         | `502` (retried, not cached) |
| Upstream returns a non-JavaScript body          | `502` (retried, not cached) |
| Transient failure, but a prior build is cached  | `200` from last-known-good (`X-Prebid-Served-From: fallback`) |

Failed builds are **never cached**. On a persistent failure the Worker serves the most
recent good build from the long-lived fallback cache, so a stale-but-valid bundle beats a
hard error.

> **Important subtlety:** the Prebid build service returns **HTTP 200 even on failure**
> (`{"error": ...}` with a `text/html` content-type). This Worker therefore validates the
> response `content-type` and treats anything that is not JavaScript as a build failure.
> This is also why a version must be confirmed to build before it is added to
> `allowedVersions` — an unbuildable version would otherwise be served as a broken bundle.

---

## Environment overrides (optional)

Every value in `DEFAULT_CONFIG` can be overridden via Worker bindings. Set them in
`wrangler.toml` ([vars](https://developers.cloudflare.com/workers/configuration/variables-beta/)),
as [secrets](https://developers.cloudflare.com/workers/configuration/secrets/), or in a
[`.dev.vars`](https://developers.cloudflare.com/workers/wrangler/configuration/#local-environmental-variables)
file for local `wrangler dev`. See [`.env.example`](.env.example) for a documented sample.

| Binding                    | Purpose                                     | Default                              |
| -------------------------- | ------------------------------------------- | ------------------------------------ |
| `PREBID_BUILD_ENDPOINT`    | Override the Prebid build service URL.       | `https://js-download.prebid.org/download` |
| `PREBID_DEFAULT_VERSION`   | Override the default version.                | `11.23.0`                            |
| `PREBID_ALLOWED_VERSIONS`  | Comma-separated version whitelist.           | `11.23.0`                            |
| `PREBID_ROUTE_PATH`        | Override the served path.                    | `/nb/template/prebid.js`                   |
| `PREBID_BIDDERS`           | Comma-separated bidder adapter modules.      | `magniteBidAdapter,msftBidAdapter,...` |
| `PREBID_STANDARD_MODULES`  | Comma-separated always-included modules.     | `consentManagementTcf,gppControl...` |
| `PREBID_CACHE_CONTROL`     | Client-facing `Cache-Control`.               | `max-age=604800, public, s-maxage=86400` |
| `PREBID_FALLBACK_CACHE_CONTROL` | Fallback-cache `Cache-Control`.        | `max-age=31536000, public, s-maxage=31536000` |
| `PREBID_MAX_RETRIES`       | Upstream download retry attempts (int).      | `3`                                  |
| `PREBID_RETRY_DELAY_MS`    | Retry base delay in ms (int).                | `500`                                |

> Note: `wrangler dev` reads `.dev.vars`, not `.env`. The `.env` / `.env.example` files
> are useful for documenting values and for CI tooling; copy the ones you want into
> `.dev.vars` (or set them as real vars on deploy) to actually apply them.

---

## Testing

The Worker is tested with Node's built-in test runner (`node:test`) — no extra framework:

```bash
npm test
```

This runs the suite in `tests/`:

- `tests/index.test.js` — fetch-handler behaviour: valid build & caching, cache hit, retry
  on failure, retry-exhausted fallback, invalid-bundle rejection, route/method guards,
  version resolution, module body, and `Cache-Control` overrides.
- `tests/config.test.js` — default config and every env override path.

On a cache miss or a failed build the tests fake the globals (`fetch`, `caches`) so they
never hit the real Prebid build service.

---

## Troubleshooting

- **`502 Prebid build failed`** — `js-download.prebid.org` returned an error. Check the
  version exists and the module names are valid for that version.
- **Stale bundle after changing modules** — purge the cache (see above).
- **`1015` / rate limit** — too many distinct `?v=` values trigger upstream builds; keep
  the whitelist tight.

---

## License

This Worker is MIT licensed. The bundled `prebid.js` is built from Prebid by
[`prebid/Prebid.js`](https://github.com/prebid/Prebid.js) under the **Apache License 2.0**;
see [Prebid's license](https://github.com/prebid/Prebid.js/blob/master/LICENSE).
