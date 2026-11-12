# CDN: static assets, ISR, PPR and cache states

> Every request the CDN serves from a file or a cache writes one log drain record with its cache state (`proxy.vercelCache`: `HIT`, `MISS`, `STALE`, `PRERENDER`) and how it was served (`proxy.pathType`: `STATIC`, `PRERENDER`). Static files and ISR pages arrive as `source: static`; an ISR revalidation arrives as a separate `source: lambda` report line with `proxy.pathType: background_func` and the same `requestId` as the stale request that triggered it. Counted by cache state, the drain matches Vercel's `vercel.request.count` exactly. The trace drain adds the cache tier on the root span (`vercel.cache_level`: `global`, `regional`, `origin`, `fallback`, `worker`) for ISR pages, but has no spans at all for static files or for revalidation renders. Cache reason, ISR read and write units and cache tags exist only as metrics inside Vercel (Observability Plus). The trap: an ISR page's revalidations are invisible in traces, and one revalidation writes four ISR entries, not one.

| | |
| --- | --- |
| Kind | Platform service (Vercel CDN: static files, ISR, PPR, cached responses) |
| Plans | Logs on all plans in the dashboard; traces on all plans once the project has a tracing sampling rule (added by default for new Next.js 16.5+ projects since 2026-11-06; Hobby includes 1M span units a month); drains need Pro or Enterprise; metrics queries need Observability Plus |
| Signals | Logs · Traces · Metrics (inside Vercel only) |
| Exit paths | Log drain (`source: static`, `source: lambda`) · Trace drain |
| Verified | 2026-10-26 · Vercel CLI 65.2.0 · Next.js 16.3.6 (ISR page `/vets`, `revalidate = 60`; no PPR route) · lab project `petclinic-agent` |
| Refreshed | 2026-11-12 · docs and changelog to 2026-11-12, no new captures · Vercel CLI 65.14.0 docs |

## 1. What it emits

| Signal | What | Where it lives | Retention |
| --- | --- | --- | --- |
| Logs | One record per request served from a static file or the cache; one report line per ISR revalidation | Runtime Logs (Cache, Cache Reason, Cache Age, PPR State columns), `vercel logs` | Hobby 1 h, Pro 1 day, Enterprise 3 days, Plus 30 days (Documented) |
| Traces | Root span `GET <route>` with `vercel.cache_level` and `http.response.header.x-vercel-cache` for ISR pages and functions; `Resolve Cache` span on cache lookups that miss | Traces page (Vercel Tracing), `vercel traces`, trace drain | In Vercel: Hobby 3 days, Pro 14 days, Enterprise 14 days since 2026-11-06; before that as for logs (Documented). Drained spans: your backend's retention |
| Metrics | `vercel.request.*` (count, Fast Data Transfer, routing CPU) with cache dimensions; `vercel.isr_operation.*` (count, read and write bytes, read and write units) | Observability › CDN, ISR; Query; `vercel metrics` | Hobby 12 h, Pro 1 day, Enterprise 3 days, Plus 30 days (Documented) |

`vercel.request.*` has 60 dimensions, among them `pathType`, `cacheResult`, `cacheHitState`, `cacheHitLevel`, `cacheReason`, `pprState`, `cacheTags`, `triggeringTag`, `isrCacheRegion` and `route`. `vercel.isr_operation.*` adds `isrAction` (`write`, `shieldRead`, `ephemeralRead`) ([`reference/vercel-metrics-schema.json`](../reference/vercel-metrics-schema.json)).

## 2. Out-of-the-box shape

### Log records

Fields seen on 2,000 `source: static` records (Captured):

| Field | Example | Note |
| --- | --- | --- |
| `source` | `static` | Static files and ISR pages served from the cache |
| `path` | `_next/static/chunks/0a7ys0jsd8qel.js`, `/vets` | For static files the file path **without** a leading slash; for ISR pages the route with one. A missing file gives `_next/static/not-found.txt` |
| `proxy.path` | `/_next/static/chunks/0a7ys0jsd8qel.js?` | The URL; static files get a trailing `?` |
| `proxy.pathType` | `STATIC`, `PRERENDER` | Upper case. Vercel's schema lists lower-case values (`static`, `prerender`) |
| `proxy.vercelCache` | `HIT`, `MISS`, `STALE`, `PRERENDER` | Missing on 12 of 51,193 static-file records |
| `proxy.cacheId` | `nj5qc-1792777654394-e2c58882c0aa`, `-` | On ISR pages: the `requestId` of an earlier request (see below). On static files: `-` or absent |
| `proxy.lambdaRegion` | `dub1` | ISR pages only |
| `proxy.statusCode` | `200`, `404`, `499` | `statusCode` (top level) only on `PRERENDER` fallback records |
| `level` | `info`, `warning` | `warning` for 404 and 499 |
| `executionRegion` | `dub1`, `iad1:dub1` | Can hold a region chain |
| `traceId`, `spanId` | | On ISR pages; absent on static files (986 of 989 static-file records in the sample) |
| `ja4Digest` | `t13d5213h1_b262b3658495_66863fb0a24c` | TLS fingerprint, on all records |
| `proxy.referer`, `proxy.userAgent`, `proxy.clientIp`, `proxy.region`, `proxy.vercelId`, `requestId`, `deploymentId`, `environment`, `branch` | | As on function records |

Not in any record: `proxy.responseByteSize` (documented, never seen), cache reason, cache age or TTL, PPR state, cache tags. The edge span carries the response size (`http.response.body.size`).

### One request, which records

| Request | Records (same `requestId`) | Evidence |
| --- | --- | --- |
| Static file | `static` (`STATIC`, `HIT`/`MISS`), plus a middleware report line if middleware matches the path | Captured: `log-static-asset-hit.json`, `log-static-asset-miss.json` |
| ISR page, fresh | `static` (`PRERENDER`, `HIT`), middleware report line | Captured: `log-prerender-hit.json` |
| ISR page, stale | `static` (`PRERENDER`, `STALE`), middleware report line, and a `lambda` report line with `proxy.pathType: background_func`, `proxy.pathTypeVariant: prerender`: the revalidation | Captured: `log-prerender-stale.json`, `log-isr-revalidation.json` |
| ISR page, first request after a deploy | `static` (`PRERENDER`, `vercelCache: PRERENDER`), revalidation report line | Captured: `log-prerender-fallback.json` |

The revalidation record has `proxy.statusCode: 200`, no `traceId` and no `spanId` (3,051 in 7 days, Observed). Vercel documents `proxy.statusCode: -1` for background revalidation; it never appeared.

A small share of ISR responses arrive as `source: lambda` instead of `static`: a record with no `message` and no `type`, `path: vets` without the slash, `proxy.pathType: PRERENDER` (30 records in 14 days, against 5,946 as `static`; Captured: `log-lambda-request-only.json`). The `/apple-icon` route produced the same kind of record. Count them with the `static` ones.

### `proxy.cacheId`

On ISR pages `proxy.cacheId` is the `requestId` of the request that first rendered the page on that deployment: the `PRERENDER` fallback request (or a `STALE` one) right after the deploy. It stays the same for the life of the deployment, through every revalidation: deployment `dpl_zA9h…` served 252 cached responses, all with `cacheId: nj5qc-1792777654394-e2c58882c0aa`, across 135 revalidations (Observed). It identifies the deployment's first render, not the render being served. Vercel's example value has a region prefix (`pdx1::…`); the lab's values have none.

### Spans

ISR page, stale (Captured: `trace-prerender-stale.ndjson`):

```
GET /vets                          vercel.edge-network        49.7 ms   cache_level=regional, x-vercel-cache=STALE
├─ Resolve Deployment              vercel.edge-network         5.8 ms
└─ Resolve Route                   vercel.edge-network        32.1 ms
   └─ Invoke Middleware            vercel.serverless-runtime  12.7 ms
      ├─ middleware GET            petclinic-web               0.2 ms
      └─ waitUntil                 vercel.serverless-runtime  10.0 ms
```

- The root span carries `vercel.cache_level` and `http.response.header.x-vercel-cache` (Captured: `span-edge-prerender-hit.json`, `span-edge-prerender-stale.json`). Neither is in the Functions entry's field list; both are on every edge root span.
- There is no span for the revalidation render that the stale request triggered, and no app spans for it, although `@vercel/otel` is registered: on 2026-10-23, 711 revalidations of `/vets` produced no `Invoke Function` span and one Next.js span in total (Observed).
- Static files have no spans: no root span for any `/_next/static` path in 14 days (Observed).
- `Resolve Cache` appears under the root span on cache lookups that miss (seen on `/`, 2,902 spans on 2026-10-23).

`vercel.cache_level` against `x-vercel-cache` on edge root spans, 7 days (Observed):

| `vercel.cache_level` | `x-vercel-cache` | Spans | Seen on |
| --- | --- | --- | --- |
| `origin` | `MISS` | 210,989 | Functions |
| `origin` | `BYPASS` | 12,514 | Cron routes, streams |
| `regional` | `HIT` | 4,440 | Web Analytics scripts (external rewrites), `/404`, icons |
| `regional` | `STALE` | 2,853 | `/vets` |
| `global` | `HIT` | 2,741 | `/vets` |
| `global` | `STALE` | 306 | `/vets` |
| `origin` | `HIT` | 129 | Web Analytics scripts |
| `worker` | `HIT` | 58 | Web Analytics scripts, `/icon.svg` |
| `fallback` | `PRERENDER` | 38 | `/vets`, `/apple-icon` after a deploy |

The same names appear in the metric dimension `cacheHitLevel`.

### Metrics

Every query needs Observability Plus. 2026-10-23 (UTC), the last full day of synthetic traffic (Captured: `metrics-*.json`):

```
$ vercel metrics vercel.request.count --group-by pathType --group-by cacheResult
streaming_func MISS 28,494 · streaming_func BYPASS 1,725 · prerender STALE 706 · prerender HIT 603
redirect 381 · static MISS 253 · static HIT 243 · prerender PRERENDER 8

$ vercel metrics vercel.request.count --filter "route:/vets" --group-by cacheResult --group-by cacheHitLevel --group-by cacheReason
STALE regional stale_time 604 · HIT global 602 · STALE global stale_time 102 · PRERENDER fallback 8

$ vercel metrics vercel.isr_operation.count --group-by isrAction --group-by route
write /vets 718 · write /vets.segments/_full.segment 711 · write /vets.segments/_tree.segment 711
write /vets.segments/vets/__PAGE__.segment 711 · ephemeralRead /vets 604 · shieldRead /vets 712

$ vercel metrics vercel.isr_operation.write_units --aggregation sum   → 2,851 (8,664,597 bytes)
$ vercel metrics vercel.isr_operation.read_units --aggregation sum    → 729 (shieldRead)
```

The log drain gives the same counts for that day (Observed):

| Cache state | Log drain records | `vercel.request.count` |
| --- | --- | --- |
| ISR `STALE` | 704 `static` + 2 `lambda` = 706 | 706 |
| ISR `HIT` | 602 `static` + 1 `lambda` = 603 | 603 |
| ISR `PRERENDER` | 8 | 8 |
| Static `MISS` | 253 | 253 |
| Static `HIT` | 243 | 243 |
| Revalidations | 711 `background_func` report lines | 711 segment writes per segment |

`cacheReason` is a queryable metric dimension; the lab's only value was `stale_time`, on all 706 stale responses. `pprState` was empty for every request because the lab has no PPR route: PPR state Not observed.

## 3. Extras beyond the default

| Extra | What it adds | Cost |
| --- | --- | --- |
| Observability Plus | Querying `vercel.request.*` and `vercel.isr_operation.*` with cache reason, PPR state, cache tags, hit level, ISR read/write units | $1.20 per 1M events (Documented) |
| `@vercel/otel` | The `middleware GET` span under ISR requests; nothing for revalidation renders or static files | None |
| Logging in the page's data fetch | The only way to see a revalidation's work outside Vercel: lines from the render arrive with `proxy.pathType: background_func` and the triggering request's `requestId` | None |

## 4. Getting it out

| Signal | Exit path | Tested configuration |
| --- | --- | --- |
| Cache state per request, static and ISR | Log drain, `source: static` (plus `source: lambda` for revalidations and the rare request-only record) | Drain `petclinic-agent-logs` (configuration in the [Functions entry](functions.md#4-getting-it-out)). A drain filtered to `lambda` only loses every cache hit |
| Revalidation duration and memory | Log drain: the `background_func` report line | |
| Cache tier per request | Trace drain: `vercel.cache_level` on the root span (ISR pages and functions only) | Drain `petclinic-agent-traces` |
| Cache reason, PPR state, cache tags, ISR units | None. Pull with `vercel metrics --json` (Plus) on a schedule | |

## 5. In Bronto

| Data | Dataset | Field names |
| --- | --- | --- |
| Log drain | `petclinic-agent/vercel-logs` | `"proxy.vercelCache"`, `"proxy.pathType"`, `"proxy.cacheId"` |
| Trace drain | `.traces/vercel-traces` | `"$vercel.cache_level"`, `"$http.response.header.x-vercel-cache"` |

Queries, each run against the lab's last 7 days on 2026-10-26:

| Question | Query | Group by | Result |
| --- | --- | --- | --- |
| ISR cache states | `"proxy.pathType" = 'PRERENDER'` | `"proxy.vercelCache"` | `STALE` 3,159 · `HIT` 2,779 · `PRERENDER` 38 |
| Static file hit ratio | `source = 'static' AND "proxy.pathType" = 'STATIC'` | `"proxy.vercelCache"` | `HIT` 49,217 · `MISS` 1,964 (96.2% hits) |
| Where static files miss | `source = 'static' AND "proxy.pathType" = 'STATIC' AND "proxy.vercelCache" = 'MISS'` | `"proxy.region"` | `sfo1` 985 · `dub1` 380 · `fra1` 364 |
| ISR revalidations per route | `"proxy.pathType" = 'background_func'` | `path`, `statusCode` | `/vets` 200: 3,051 |
| Which first render a deployment's cache comes from | `"proxy.pathType" = 'PRERENDER' AND "proxy.cacheId" != '-'` | `"proxy.cacheId"` | 24 values for 24 deployments; top 2,082 |
| Missing static files | `source = 'static' AND "proxy.statusCode" >= 400` | `"proxy.statusCode"`, `path` | 404 `_next/static/not-found.txt` 287 |
| Cache tier from traces | `"$service.name" = 'vercel.edge-network' AND "$vercel.cache_level" != ''` | `"$vercel.cache_level"`, `"$http.response.header.x-vercel-cache"` | table in section 2 |

To see what a stale request triggered, search its `requestId`: the `static` record, the middleware line and the `background_func` revalidation come back together.

Templates: the "Vercel Overview" dashboard has a cache state panel over the log drain dataset.

## Gotchas

1. **ISR revalidations have no trace.** The render that refreshes a stale page runs without a span, even with `@vercel/otel`, so its outgoing calls (here, PetClinic's `/vets`) are invisible in traces. Its report line in the log drain is the only record outside Vercel; join it to the stale request by `requestId` (Observed: 711 revalidations, 0 spans).
2. **One revalidation writes four ISR entries.** A Next.js 16 App Router page writes the page plus three `.segments/` files on each revalidation: 718 + 3 × 711 writes, 2,851 write units on 2026-10-23 for one route with `revalidate = 60`. ISR writes are billed per unit (Observed).
3. **With steady traffic, stale is the normal state.** One request a minute against `revalidate = 60` made 54% of `/vets` responses `STALE` (706 of 1,317). A hit ratio that counts only `HIT` reads that as a failing cache; count `STALE` as served from cache.
4. **`cacheId` does not change on revalidation.** It names the deployment's first render, so it can't tell you how old the served page is.
5. **Static files are logged but not traced.** 51,193 static-file records, no spans and no `traceId`; middleware runs in front of them still count (see [Routing Middleware](routing-middleware.md)).
6. **Documented fields that don't arrive.** `proxy.statusCode: -1` for background revalidation (seen: `200`), `proxy.responseByteSize` (never), lower-case `pathType` values (seen: upper case for `STATIC`, `PRERENDER`, `EXTERNAL`; lower case for `middleware`, `background_func`, `streaming_func`).
7. **Cache reason and PPR state need Plus, not the dashboard.** Both are `vercel metrics` dimensions (`cacheReason`, `pprState`), so they can be pulled by script; neither is in any drain.

## Samples

| File | What it shows |
| --- | --- |
| [`log-static-asset-hit.json`](../samples/cdn/log-static-asset-hit.json) | Static file served from cache |
| [`log-static-asset-miss.json`](../samples/cdn/log-static-asset-miss.json) | Static file cache miss (crawler in `pdx1`) |
| [`log-static-404.json`](../samples/cdn/log-static-404.json) | Missing static file: `level: warning`, `path: _next/static/not-found.txt` |
| [`log-prerender-hit.json`](../samples/cdn/log-prerender-hit.json) | ISR page from cache, with `cacheId` |
| [`log-prerender-stale.json`](../samples/cdn/log-prerender-stale.json) | ISR page served stale |
| [`log-isr-revalidation.json`](../samples/cdn/log-isr-revalidation.json) | The revalidation that stale request triggered (`background_func`) |
| [`log-prerender-fallback.json`](../samples/cdn/log-prerender-fallback.json) | First request after a deploy (`vercelCache: PRERENDER`); later `cacheId` values point here |
| [`log-lambda-request-only.json`](../samples/cdn/log-lambda-request-only.json) | ISR response delivered as `source: lambda` with no message |
| [`span-edge-prerender-hit.json`](../samples/cdn/span-edge-prerender-hit.json) | Root span, `cache_level: global`, `x-vercel-cache: HIT` |
| [`span-edge-prerender-stale.json`](../samples/cdn/span-edge-prerender-stale.json) | Root span, `cache_level: regional`, `x-vercel-cache: STALE` |
| [`trace-prerender-hit.ndjson`](../samples/cdn/trace-prerender-hit.ndjson), [`trace-prerender-stale.ndjson`](../samples/cdn/trace-prerender-stale.ndjson) | Full traces of a hit and a stale response |
| [`metrics-request-pathtype.json`](../samples/cdn/metrics-request-pathtype.json) | Requests by path type and cache result |
| [`metrics-request-cache-level.json`](../samples/cdn/metrics-request-cache-level.json) | Requests by hit level, hit state, cache result |
| [`metrics-request-vets-cache-reason.json`](../samples/cdn/metrics-request-vets-cache-reason.json) | `/vets` by cache result, hit level and cache reason |
| [`metrics-request-ppr-state.json`](../samples/cdn/metrics-request-ppr-state.json) | `pprState` by route (empty: no PPR in the lab) |
| [`metrics-isr-operations.json`](../samples/cdn/metrics-isr-operations.json) | ISR operations by action and route (segment writes) |
| [`metrics-isr-write-units.json`](../samples/cdn/metrics-isr-write-units.json) | ISR write units |

## Sources

- Vercel docs, read 2026-10-26: [Log Drains reference](https://vercel.com/docs/drains/reference/logs) (last updated 2026-09-11); read 2026-10-16 to 2026-10-20: [Cache Status](https://vercel.com/docs/caching/cache-status), [PPR state](https://vercel.com/docs/partial-prerendering/ppr-state), [Observability Plus](https://vercel.com/docs/observability/observability-plus), [`vercel metrics`](https://vercel.com/docs/cli/metrics).
- Docs, read 2026-11-12: [Vercel Tracing is now generally available](https://vercel.com/changelog/vercel-tracing-is-now-generally-available) (2026-11-06), [Tracing](https://vercel.com/docs/tracing) and [Configuring Tracing](https://vercel.com/docs/tracing/configure-tracing) (both last updated 2026-11-03; retention, sampling rules, span units), [Trace Drains reference](https://vercel.com/docs/drains/reference/traces) (last updated 2026-08-21), [Runtime Logs](https://vercel.com/docs/logs/runtime) (last updated 2026-08-28; log retention unchanged).
- Lab: `apps/web/app/vets/page.tsx` (`revalidate = 60`), synthetic traffic from `apps/web/app/api/synthetic/route.ts` (stopped 2026-10-23 22:00 UTC); Bronto EU datasets `petclinic-agent/vercel-logs` and `.traces/vercel-traces`, 2026-10-18 to 2026-10-26; Vercel CLI 65.2.0 `vercel metrics` for 2026-10-23.
