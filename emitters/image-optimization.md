# Image Optimization

> A `/_next/image` request produces one log drain record with `source: static`. The record has the URL with its width and quality parameters, the cache state, and, on a cache hit, `proxy.cacheId`, which is the request ID of the miss that created the cached image. The drain has no transformation details: no output format, no byte sizes, no transformation time. The trace drain has nothing at all, and Vercel stores no span for these requests. Those details exist only in the `vercel.image_transformation.*` metrics (Observability Plus). They count one transformation per cache miss and match the billing line exactly (5 and 5 on the lab's first day). The trap: Next.js rejects some requests with `400` before they reach the optimizer, such as a width or quality the app didn't allow or a remote host that isn't configured, and those requests left no drain record at all (3 of 3). Count image errors from `vercel logs requests` or the request metrics, not from the drain.

| | |
| --- | --- |
| Kind | Platform service (`/_next/image` on Next.js; other frameworks through their image components) |
| Plans | All plans (Hobby within included usage); drains need Pro or Enterprise; metric queries need Observability Plus (Documented) |
| Signals | Logs (one CDN record per request) · Metrics (inside Vercel only) · Billing lines |
| Exit paths | Log drain (`source: static`) · `vercel metrics` pull · `GET /v1/billing/charges` pull |
| Verified | 2026-10-27 · Vercel CLI 65.2.0 · Next.js 16.4.3 · `@vercel/otel` 2.1.3 · lab project `vercel-observability-lab` |
| Refreshed | 2026-11-12 · docs and changelog to 2026-11-12, no new captures · Vercel CLI 65.14.0 docs |

## 1. What it emits

| Signal | What | Where it lives | Retention |
| --- | --- | --- | --- |
| Logs | One record per `/_next/image` request: cache state, status, URL | Log drain, `vercel logs requests` | As for other request logs (Documented) |
| Metrics | `vercel.image_transformation.*` (6 metrics), one data point per transformation (cache miss) | Observability › Image Optimization, Query, `vercel metrics` | Pro 1 day, Plus 30 days (Documented) |
| Traces | None. No span in the trace drain or in `vercel traces search` for any image request (Observed 2026-10-27) | | |
| Billing | Image Optimization Transformation, Cache Reads, Cache Writes, per region and day | `GET /v1/billing/charges` | See the Billing entry |

The six metrics are `count`, `request_duration_ms`, `source_size_bytes`, `optimized_size_bytes`, `compression_ratio` and `size_change_percent`. They share 12 dimensions: `projectId`, `deploymentId`, `environment`, `imageTransformationRegion`, `optimizedFormatMimeType`, `sourceImagePathname`, `sourceImageHostname`, `sourceImage`, `sourceImageHash`, `optimizedQuality`, `optimizedWidthPixels`, `httpStatus`. `count` also has `cacheTags` ([`reference/vercel-metrics-schema.json`](../reference/vercel-metrics-schema.json)).

The lab: `/image` renders a 256×256 PNG (139,369 bytes) with `next/image` and `sizes="200px"`, no `images` config in `next.config.ts`. Traffic: headless Chrome page loads on 2026-10-26, then on 2026-10-27 (drains active) ten `curl` requests: one width three times, another width twice without `image/webp` in `Accept`, one width cached the day before, and four requests that fail.

## 2. Out-of-the-box shape

### Log records

Every `/_next/image` request that reached the optimizer or the cache produced one `source: static` record (Captured: `log-static-miss-webp.json`, `log-static-hit.json`, `log-static-400-invalid.json`):

| Field | Example | Note |
| --- | --- | --- |
| `source` | `static` | No `external` record: the lab uses a local image only. Remote images through `remotePatterns`: Not observed |
| `path` | `_next/static/immutable/media/gradient.1ucu3hliyzcw1.png` | The **source image**, without a leading slash. `404` on the failed request |
| `proxy.path` | `/_next/image?url=%2F_next%2F…png&w=1080&q=75` | The real URL. Width and quality are only here, as query parameters |
| `proxy.vercelCache` | `MISS`, `HIT` | `MISS` is a transformation, `HIT` a cached image |
| `proxy.cacheId` | `dmtrc-1793090808337-f346bb274d0c` | On `HIT` only: the `requestId` of the request that wrote the cache entry. **Not in Vercel's published schema** |
| `statusCode` | `200` | On the `MISS` records only; `HIT` records carry `proxy.statusCode` only |
| `proxy.statusCode` | `200`, `400` | On every record |
| `proxy.pathType` | `STATIC` | |
| `proxy.errorCode` | `INVALID_IMAGE_OPTIMIZE_REQUEST` | On the failed request, with `message: INVALID_IMAGE_OPTIMIZE_REQUEST: Bad request` and `level: warning` |
| `executionRegion`, `proxy.region` | `fra1` | The edge region that served the request; the lab's functions run in `dub1` |
| `requestId`, `proxy.vercelId` | `dmtrc-1793090808337-f346bb274d0c` | Equal |
| `ja4Digest` | `t13d4907h2_…` | TLS fingerprint |
| `level` | `info`, `warning` | |
| `proxy.method`, `proxy.host`, `proxy.scheme`, `proxy.timestamp`, `proxy.userAgent`, `proxy.clientIp`, `projectId`, `projectName`, `deploymentId`, `environment`, `host`, `id`, `timestamp` | | `proxy.userAgent` is an array |

Absent: `traceId` and `spanId` (on none of the 7 records), the output format, the response size (`proxy.responseByteSize`), the transformation time, `type`, `message` on successful requests.

The ten requests of 2026-10-27, as the drain and the response headers saw them (Observed):

| Request | Response | Drain record |
| --- | --- | --- |
| `w=1080`, `Accept: image/webp`, three times | `MISS` then `HIT`, `HIT`; `image/webp`, 878 bytes | 3: `MISS` with `statusCode`; two `HIT` with `proxy.cacheId` = the `MISS` request ID |
| `w=750`, `Accept: */*`, twice | `MISS` then `HIT`; `image/png`, 20,649 bytes | 2, the same pattern |
| `w=256`, `Accept: image/webp` (transformed on 2026-10-26) | `HIT` | 1, `proxy.cacheId` = a request ID from the day before (Captured: `log-static-hit-from-yesterday.json`) |
| `url=/nope.png` (no such file) | `400`, `x-vercel-cache: MISS`, `x-vercel-error: INVALID_IMAGE_OPTIMIZE_REQUEST` | 1, `level: warning`, `path: 404` |
| `w=999` (not an allowed width) | `400`, no `x-vercel-cache` | **none** |
| `url=https://example.com/a.png` (host not configured) | `400`, no `x-vercel-cache` | **none** |
| `w=1080&q=50` (quality not allowed) | `400`, no `x-vercel-cache` | **none** |

`vercel logs requests --query "requestPath:/_next/image"` listed all ten. The three missing ones have `route: /_next/image`, an empty `pathType` and an empty `cacheResult` (Captured: `cli-logs-requests-image.jsonl`). The quality `50` is rejected because Next.js 16 allows only `75` unless `images.qualities` says otherwise (Documented, Next.js).

### Metrics

One data point per transformation. Since 2026-10-26, grouped (Captured: `metrics-*.json`):

```
$ vercel metrics vercel.image_transformation.count --group-by optimizedFormatMimeType --group-by optimizedWidthPixels --group-by httpStatus --since 2026-10-26T00:00:00Z --json
image/webp 1080 · 640 · 384 · 256: 1 each      ""  750 · 128 · 96: 1 each      all httpStatus 200      (7)

$ vercel metrics vercel.image_transformation.count --group-by optimizedQuality --group-by imageTransformationRegion --group-by sourceImageHostname --group-by sourceImagePathname
75 · fra1 · local · prj_Y3RSmZp5SNQvB6FhLb0LMH4HPWSM/immutable_static_assets/production/_next/static/immutable/media/gradient.1ucu3hliyzcw1.png   7

$ vercel metrics vercel.image_transformation.request_duration_ms --group-by optimizedWidthPixels
750 png 273 ms · 1080 webp 221 ms · 256 webp 158 ms · 128 png 91 ms · 96 png 54 ms · 640 webp 25 ms · 384 webp 23 ms

$ vercel metrics vercel.image_transformation.optimized_size_bytes -a avg --group-by optimizedWidthPixels --group-by optimizedFormatMimeType
webp 256…1080: 878 bytes each · png 750: 20,649 · png 128: 8,076 · png 96: 5,071      (source 139,369 for all)
```

- Only cache misses count. The 2026-10-27 traffic added 2 data points (the two `MISS` records); the four `HIT` and four `400` requests added none (Observed).
- `optimizedFormatMimeType` is empty when the output keeps the source format (the PNG responses to `Accept: */*`).
- `optimizedWidthPixels` is the requested width, not the output width. The source is 256 px wide and Next.js doesn't upscale, so widths 256 to 1080 all produced the same 878-byte file.
- `imageTransformationRegion` is the edge region of the request (`fra1`), not the function region.
- `compression_ratio` (source / optimized: 158.7 for the webp files) and `size_change_percent` (−99.4 %) are derived from the two sizes.
- Grouping by `cacheTags` or `sourceImageHash` failed: `No metrics source can serve this request` (Observed, CLI 65.2.0).

### Billing lines

Billing day 2026-10-26 (07:00 to 07:00 UTC), lab project (Captured: `charges-2026-10-26.jsonl`):

| `ServiceName` | Quantity | Region | `EffectiveCost` |
| --- | --- | --- | --- |
| Image Optimization Transformation | 5 Transformations | `fra1` | $0.0003005 ($0.0601 per 1,000) |
| Image Optimization Cache Writes | 6 Writes | `iad1` | $0.000024 ($4 per 1M) |
| Image Optimization Cache Reads | 0 | | |

The 5 transformations equal the metric's 5 data points that day. Cache writes are counted in 8 KB units and were billed in `iad1`, while the transformations ran in `fra1` (Observed). Vercel bills a transformation for every cache `MISS` and `STALE`, and cache reads only when the image comes from the shared global cache, not for regional hits (Documented).

## 3. Extras beyond the default

| Extra | What it adds | Cost |
| --- | --- | --- |
| Observability Plus | Querying `vercel.image_transformation.*`: format, width, quality, sizes, duration per transformation | $1.20 per 1M events (Documented) |
| `images.remotePatterns` | Remote images; their records and the metric's `sourceImageHostname` would name the remote host (Not observed) | |
| `images.qualities`, `images.deviceSizes`, `images.imageSizes` | More allowed variants. Each variant is its own cache entry and its own transformation | Per transformation |

## 4. Getting it out

| Signal | Exit path | Tested configuration |
| --- | --- | --- |
| Requests, cache state, which miss created a cached image | Log drain, schema `log` v1 | Drain on project `vercel-observability-lab`, all sources, ndjson |
| Transformation count | Log drain: `"proxy.path" LIKE '/_next/image%' AND "proxy.vercelCache" = 'MISS' AND "proxy.statusCode" = 200` | Matches the metric for the drained window (2 and 2, Observed) |
| Requests rejected before the optimizer | None in the drain. `vercel logs requests` (Vercel's retention), or `vercel metrics vercel.request.count` (Plus) | |
| Format, width, sizes, duration per transformation | None. Pull `vercel metrics vercel.image_transformation.* --json` (Plus) on a schedule and send the result on | |
| Cost | `GET /v1/billing/charges`, daily pull | See the Billing entry |
| Spans | None exist | |

## 5. In Bronto

| Data | Dataset | Field names |
| --- | --- | --- |
| Log drain | `vercel-observability-lab/vercel-logs` | `source`, `path`; nested with double quotes: `"proxy.path"`, `"proxy.vercelCache"`, `"proxy.cacheId"`, `"proxy.errorCode"` |

Queries, each run on 2026-10-27 over the drained data (from 08:43 UTC):

| Question | Query | Group by | Result |
| --- | --- | --- | --- |
| Image requests by cache state | `source = 'static' AND "proxy.path" LIKE '/_next/image%'` | `proxy.vercelCache`, `proxy.statusCode` | `HIT 200` 4 · `MISS 200` 2 · `MISS 400` 1 |
| Image errors that reached the optimizer | `"proxy.path" LIKE '/_next/image%' AND "proxy.errorCode" != ''` | `proxy.errorCode`, `path` | `INVALID_IMAGE_OPTIMIZE_REQUEST`, `404` 1 |
| Which transformation does each hit reuse? | `"proxy.path" LIKE '/_next/image%' AND "proxy.vercelCache" = 'HIT'` | `proxy.cacheId` | `dmtrc-…` 2 · `lcwp9-…` 1 · `rr6x8-…` 1 (written before the drain existed) |

Group by `path` to count per source image; it holds the image path, while `"proxy.path"` holds each variant.

## Gotchas

1. **Rejected image URLs leave no drain record.** An unsupported width, quality or remote host returns `400` without a `source: static` record (3 of 3, Observed). Only a missing source file produced a record. Watch `vercel logs requests` or `vercel.request.count` for `route = /_next/image` and status `400`.
2. **The drain can't tell you what was produced.** Format, size and transformation time are metric-only. The drain has `w` and `q` in `proxy.path` and nothing about the output.
3. **`optimizedWidthPixels` is what was asked for.** Requests wider than the source produce identical files that still count, and bill, as separate transformations (four widths, four transformations, one 878-byte file, Observed).
4. **Empty format means "unchanged".** `optimizedFormatMimeType` is `""` when the client didn't accept WebP or AVIF and the source format was kept.
5. **`path` is the source image, not the URL.** Grouping by `path` merges all widths of one image; on a failed request `path` is `404`.
6. **No trace for images.** No span and no `traceId` on the record (Observed), so image latency can't be joined to a page's trace.
7. **Regions differ by line.** Transformations ran and were billed in the edge region (`fra1`); cache writes were billed in `iad1`.

## Samples

| File | What it shows |
| --- | --- |
| [`log-static-miss-webp.json`](../samples/image-optimization/log-static-miss-webp.json) | A transformation (`MISS`, `statusCode: 200`) |
| [`log-static-miss-png.json`](../samples/image-optimization/log-static-miss-png.json) | A transformation that kept PNG (`Accept: */*`) |
| [`log-static-hit.json`](../samples/image-optimization/log-static-hit.json) | A cache hit with `proxy.cacheId` pointing at the miss |
| [`log-static-hit-from-yesterday.json`](../samples/image-optimization/log-static-hit-from-yesterday.json) | A hit on an entry written the day before |
| [`log-static-400-invalid.json`](../samples/image-optimization/log-static-400-invalid.json) | `INVALID_IMAGE_OPTIMIZE_REQUEST` for a missing file, `path: 404` |
| [`cli-logs-requests-image.jsonl`](../samples/image-optimization/cli-logs-requests-image.jsonl) | `vercel logs requests`: all ten requests, including the three the drain never got |
| [`metrics-count-by-format-width.json`](../samples/image-optimization/metrics-count-by-format-width.json) | Transformations by format, width, status |
| [`metrics-count-by-quality-region-source.json`](../samples/image-optimization/metrics-count-by-quality-region-source.json) | Quality, region, source host and path |
| [`metrics-duration.json`](../samples/image-optimization/metrics-duration.json) | Transformation time per variant |
| [`metrics-source-size.json`](../samples/image-optimization/metrics-source-size.json), [`metrics-optimized-size.json`](../samples/image-optimization/metrics-optimized-size.json) | Bytes in and out |
| [`metrics-compression-ratio.json`](../samples/image-optimization/metrics-compression-ratio.json), [`metrics-size-change.json`](../samples/image-optimization/metrics-size-change.json) | The derived ratios |
| [`charges-2026-10-26.jsonl`](../samples/image-optimization/charges-2026-10-26.jsonl) | Billing lines: transformations and cache writes |

## Sources

- Vercel docs, read 2026-10-27: [Limits and Pricing for Image Optimization](https://vercel.com/docs/image-optimization/limits-and-pricing) (last updated 2026-08-11), [Observability Insights](https://vercel.com/docs/observability/insights) (last updated 2026-08-11), [Log Drains reference](https://vercel.com/docs/drains/reference/logs).
- Docs, read 2026-11-12: [`vercel traces`](https://vercel.com/docs/cli/traces) (last updated 2026-11-03; `search --request-id` unchanged), [Configuring Tracing](https://vercel.com/docs/tracing/configure-tracing) (last updated 2026-11-03). No change found for Image Optimization telemetry between 2026-10-27 and 2026-11-12.
- Lab: Bronto EU dataset `vercel-observability-lab/vercel-logs` and `.traces/vercel-observability-lab`, 2026-10-27; Vercel CLI 65.2.0 (`vercel metrics`, `vercel logs requests`, `vercel traces search --request-id`, `vercel api /v1/billing/charges`); `lab/app/image/page.tsx`; response headers from `curl -A "catalog-check/1.0"`, 2026-10-27 08:46 UTC.
