# Global Config (formerly Edge Config)

> Reading Global Config leaves no record of its own in any drain: no log line, no span and no metric. In the lab a `get()` took under 1 ms inside the route (`executing api route` averaged 0.97 ms), and no outgoing request was recorded, because on Vercel the SDK reads the store from memory or from a file the platform mounts in the function (`/opt/edge-config/<id>.json`), and only falls back to HTTP when neither is there. The reads are still billed: the billing API counted 10 `Global Config Reads` for the 10 requests that called `get()`, tagged with the project. The SDK, `@vercel/global-config` (the renamed `@vercel/edge-config`), has its own OpenTelemetry hook, `setTracerProvider`. With it called in `instrumentation.ts`, every `get()` became a `get` span with the store ID in `edgeConfigId` (10 spans for 10 reads, 0.74 ms on average), and the spans left through the trace drain. The thing people get wrong: a fast, local read looks free and invisible, but each `get()` call is one billed read, and `getAll()` is the way to make several keys cost one.

| | |
| --- | --- |
| Kind | Platform service (key-value store) and library (`@vercel/global-config`) |
| Plans | All plans; drains need Pro or Enterprise |
| Signals | Traces (with the SDK's `setTracerProvider`) · Other: read and write counts as billing records, store metadata and backups. No logs or metrics |
| Exit paths | Trace drain (with the SDK's `setTracerProvider`) · REST API (`GET /v1/billing/charges`, store metadata) |
| Verified | 2026-10-27 · Vercel CLI 65.2.0 · `@vercel/global-config` 1.5.1 · `@vercel/otel` 2.1.3 · lab project `vercel-observability-lab` |
| Refreshed | 2026-11-12 · docs and changelog to 2026-11-12, no new captures, no change found · `@vercel/global-config` 1.5.1 (still current on npm) · Vercel CLI 65.14.0 |

## 1. What it emits

| Signal | What | Where it lives | Retention |
| --- | --- | --- | --- |
| Logs | Nothing from Global Config. Your own `console` lines | Runtime Logs, log drain | As for Functions |
| Traces | Nothing by default. With `setTracerProvider`: a `get` span per `get()` (Captured); `has`, `getAll`, `digest` spans per call (from source) | Trace drain when enabled | Vercel Tracing since 2026-11-06: Hobby 3 days, Pro and Enterprise 14 days (before: 1 h, 1 day, 3 days) (Documented); drained spans: your backend's retention |
| Metrics | None in `vercel metrics schema` (Observed) | | |
| Usage and cost | `Global Config Reads (formerly known as Edge Config Reads)` per project, `Global Config Writes (…)` per team, per billing day | Usage page (Reads chart by project, Writes chart by store; Documented), `GET /v1/billing/charges` | See the Billing entry |
| Store metadata | Size, item count, digest, timestamps; backups on every change | `vercel global-config inspect`, `vercel global-config backups` | Backups: Hobby 7 days, Pro 90 days, Enterprise 365 days (Documented) |

Edge Config is now called Global Config; `@vercel/global-config` was first published to npm on 2026-07-20, and `@vercel/edge-config` is marked deprecated on npm ("renamed to @vercel/global-config"). The new package reads `GLOBAL_CONFIG` and falls back to `EDGE_CONFIG`; environment variables, request headers and the mount path still say `edge-config`.

The lab route `/api/config` (`lab/app/api/config/route.ts`) calls `get("greeting")` and logs one JSON line. The store's connection string is the env var `GLOBAL_CONFIG`, added by hand because the CLI can't connect a store to a project (`lab/NOTES.md`).

## 2. Out-of-the-box shape

### Log records

Two records per request, both `source: lambda` (Captured, 6 requests on 2026-10-27):

| Record | `message` | Note |
| --- | --- | --- |
| App line | `{"msg":"global config read","key":"greeting","found":true}` | The lab's own `console.log` (`log-app-line.json`) |
| Report line | `START RequestId: … REPORT … Duration: … ms` | The function's report line (`log-report-line.json`) |

No record carries the store ID, key or read outcome unless your code logs it.

### Spans

Without the SDK hook, a `GET /api/config` request in the trace drain (Captured: `trace-request.ndjson`):

```
GET /api/config                               vercel.edge-network         49.65 ms
├─ Resolve Deployment                         vercel.edge-network          3.27 ms
├─ Resolve Route                              vercel.edge-network          1.94 ms
├─ Resolve Cache                              vercel.edge-network          1.09 ms
├─ Route across regions                       vercel.edge-network         12.41 ms
└─ Invoke Function                            vercel.serverless-runtime    8.31 ms
   ├─ waitUntil                               vercel.serverless-runtime    3.25 ms
   └─ GET /api/config                         vercel-observability-lab
      ├─ prepare route module                 vercel-observability-lab     0.40 ms
      ├─ executing api route (app) /api/config  vercel-observability-lab   0.77 ms
      └─ start response                       vercel-observability-lab     0.02 ms
```

`executing api route (app) /api/config` averaged 0.97 ms over 6 requests, and none had a child span (Observed). `vercel.external_api_request.count` grouped by host and path listed no Global Config host for the same window (Captured: `metrics-external-api.json`, BotID only).

With `setTracerProvider(trace)` called in `instrumentation.ts` (deployed 2026-10-27 10:03 UTC), the read has its own span (Captured: `trace-request-get.ndjson`):

```
└─ Invoke Function                            vercel.serverless-runtime   11.51 ms
   ├─ GET /api/config                         vercel-observability-lab     3.52 ms
   │  ├─ prepare route module                 vercel-observability-lab     0.46 ms
   │  ├─ executing api route (app) /api/config  vercel-observability-lab   0.72 ms
   │  │  └─ get                               vercel-observability-lab     0.26 ms
   │  └─ start response                       vercel-observability-lab     0.03 ms
   └─ waitUntil                               vercel.serverless-runtime    4.14 ms
```

The span as delivered (Captured: `span-get.json`, flattened, Vercel resource attributes left out):

```json
{ "span.name": "get", "span.kind": "SPAN_KIND_INTERNAL", "span.status_code": "STATUS_CODE_OK",
  "operation.name": "vercel_global-config", "edgeConfigId": "ecfg_nk7b2edicaf9ovzskhnsxs7qwtkt",
  "span.duration_nano": "264289" }
```

That is all it carries: the store ID and the status. No key, no source (memory, mounted file or HTTP), no cache outcome; those are in the verbose spans (section 3), not tested. The instrumentation scope is `@vercel/global-config` (`operation.name: vercel_global-config` in the drained record). 10 `get` spans over 10 requests averaged 0.74 ms, between 0.26 and 1.89 ms (Observed).

### How the SDK reads

From `@vercel/global-config` 1.5.1 (`dist/index.next-js.js`), `get(key)` tries, in order:

1. A store object the runtime puts on `globalThis` under `Symbol.for("privateEdgeConfig")`.
2. On Vercel Functions (`AWS_LAMBDA_FUNCTION_NAME` is set) and for Vercel-hosted stores: the file `/opt/edge-config/<ecfg_id>.json`, parsed once and cached in memory.
3. Otherwise HTTP: `GET https://edge-config.vercel.com/<id>/item/<key>?version=1` (or `global-config.vercel.com`, depending on the connection string) with the token as a bearer header, through the global `fetch`, with an ETag cache and `stale-if-error` (default 604,800 s).

In `next dev` the SDK loads all items once over HTTP and serves them from memory (stale-while-revalidate). In the Next.js build of the package each of these steps is wrapped in `"use cache"` with `cacheLife({ revalidate: 0, expire: 0 })`, so the default `cache: "no-store"` makes pages that read Global Config dynamic.

The lab's sub-millisecond reads with no outgoing request fit steps 1 or 2; which of the two served them is Not observed. If step 3 runs, the request goes through `globalThis.fetch`, so a fetch instrumentation would record it: `@vercel/otel`'s default as `fetch GET https://edge-config.vercel.com/…`, the undici instrumentation the lab uses since 2026-10-27 as `GET` with `server.address: edge-config.vercel.com` (from source; not observed in the lab, where no read went over HTTP).

### Usage and cost records

Billing day 2026-10-26 07:00 to 2026-10-27 07:00 UTC (Captured: `charges-2026-10-26.jsonl`):

| `ServiceName` | `ConsumedQuantity` | `EffectiveCost` | `Tags` |
| --- | --- | --- | --- |
| `Global Config Reads (formerly known as Edge Config Reads)` | 10 Reads | $0.00003 | `ProjectId`, `ProjectName: vercel-observability-lab` |
| `Global Config Writes (formerly known as Edge Config Writes)` | 0 Writes | 0 | `{}` |

`/api/config` ran 10 times that billing day (`vercel.function_invocation.count`, Captured: `metrics-invocations-2026-10-26.json`), one `get()` each: one billed read per `get()`, although no read left the function (Observed). The price works out to $3 per 1M reads, as documented. The store's one write (its creation with an item, 2026-10-26 14:58 UTC) fell in the previous billing day.

### Store metadata

`vercel global-config inspect` returns `id`, `slug`, `digest`, `sizeInBytes` (39), `itemCount` (1), `createdAt`, `updatedAt` (Captured: `cli-inspect.json`). `vercel global-config backups <id>` lists one backup per change with its time, item count and size (Observed: one backup, 2026-10-26T14:58:32Z). Neither shows reads.

## 3. Extras beyond the default

| Extra | What it adds | Cost |
| --- | --- | --- |
| `setTracerProvider(trace)` from `@vercel/global-config` | A span per `get`, `has`, `getAll` and `digest` call, each with the attribute `edgeConfigId` (`get`: Captured; the others from source) | None in code; drained spans cost trace drain volume |
| `GLOBAL_CONFIG_TRACE_VERBOSE=true` | Additional spans for the internal steps: `getPrivateEdgeConfig`, `getFileSystemEdgeConfig`, `readFile`, `JSON.parse`, `fetchWithCachedResponse` (with `status`), `createClient`, `clone` (from source) | Span volume |
| `getAll([keys])` instead of several `get()` | Fewer billed reads: one read regardless of how many items (Documented) | Saves read cost |
| Your own log line | Key, found or not, per read | None |

The hook works like the Flags SDK's: the package looks up a tracer under `Symbol.for("@vercel/global-config:global-trace")`, and without one it calls the function directly. Enabling it on Vercel is one line next to the Flags SDK hook in `instrumentation.ts`, as the lab does since 2026-10-27:

```ts
const { setTracerProvider } = await import("@vercel/global-config");
setTracerProvider(trace); // trace from @opentelemetry/api
```

Note that the README passes the `trace` API object, not a tracer provider; the SDK calls `.getTracer(name, version)` on whatever it gets, and its TypeScript signature (`TracerProvider`) accepts both. With `@vercel/otel` registered, the spans leave through the trace drain (Captured, section 2). `GLOBAL_CONFIG_TRACE_VERBOSE` was not set in the lab.

## 4. Getting it out

| Signal | Exit path | Tested configuration |
| --- | --- | --- |
| Reads as spans | `setTracerProvider(trace)` from the SDK in `instrumentation.ts`, spans through the trace drain | Lab, 2026-10-27 (`span-get.json`) |
| Reads as log lines | Your own structured line through the log drain | Lab route, `log-app-line.json` |
| Read and write counts, cost | `GET /v1/billing/charges` once per billing day | `vercel api "/v1/billing/charges?from=2026-10-26T07:00:00Z&to=2026-10-27T07:00:00Z"` |
| Store size, item count, backups | `vercel global-config inspect` / `backups`, or the REST API, on a schedule | CLI 65.2.0 |
| Reads chart per project | None; dashboard only | |

There are no Global Config or Edge Config events in Vercel's webhook event list, so a change to a store can't be pushed to you (Documented, read 2026-10-27). The closest signal is the `digest` or `updatedAt` changing between two polls, or a new backup.

## 5. In Bronto

| Data | Dataset | Field names |
| --- | --- | --- |
| Log drain | `vercel-observability-lab/vercel-logs` | As in the payload |
| Trace drain | `.traces/vercel-observability-lab`, `.traces/vercel.edge-network`, `.traces/vercel.serverless-runtime` | `"$span.name"`, `"$span.duration_nano"` |

Queries run 2026-10-27 against the lab's drained data (from 08:43 UTC; the SDK hook from 10:03 UTC):

| Question | Query | Group by | Result |
| --- | --- | --- | --- |
| Reads logged by the app | `source = 'lambda' AND message LIKE '%global config read%'` | `path` | `/api/config` 6 |
| Time in the route that reads | `"$span.name" = 'executing api route (app) /api/config'`, `avg("$span.duration_nano")` | `"$span.name"` | 0.97 ms over 6 spans |
| Reads per store, from the SDK spans | `"$span.name" = 'get'` | `"$edgeConfigId"` | `ecfg_nk7b2edicaf9ovzskhnsxs7qwtkt` 10 (10 requests), the same unit the billing line counts |
| Read latency | `"$span.name" = 'get'`, `avg("$span.duration_nano")` | `"$edgeConfigId"` | 0.74 ms |

`"$span.name" = 'get'` is a generic name; add `"$operation.name" = 'vercel_global-config'` when other libraries emit `get` spans.

## Gotchas

1. **Local reads are billed reads.** 10 `get()` calls served without a network request were billed as 10 reads (Observed, billing day 2026-10-26). Use `getAll()` for several keys.
2. **No span unless you ask the SDK.** `@vercel/otel` sees only the HTTP fallback, so on Vercel a working read has no span at all. Call the SDK's `setTracerProvider`; the resulting `get` span carries the store ID but not the key (Captured).
3. **The old name is everywhere.** The package and env var are `global-config`/`GLOBAL_CONFIG`, but the billing line says "formerly known as Edge Config", the HTTP host and headers are `edge-config.vercel.com` and `x-edge-config-*`, the mount path is `/opt/edge-config/`, and the span attribute is `edgeConfigId` (source and Observed). Search for both names.
4. **Writes are team-level, reads are per project.** The `Writes` billing line has `Tags: {}`; `Reads` carries `ProjectId` (Observed).
5. **Store changes aren't pushed.** No webhook event exists for Global Config; detect changes by polling `digest` (Documented).
6. **Pages that read it become dynamic in Next.js.** The default `cache: "no-store"` opts out of static rendering unless you pass `cache: "force-cache"` (Documented in the package README).

## Samples

| File | What it shows |
| --- | --- |
| [`log-app-line.json`](../samples/global-config/log-app-line.json) | The app's own line for one read |
| [`log-report-line.json`](../samples/global-config/log-report-line.json) | The report line of the same kind of request |
| [`trace-request.ndjson`](../samples/global-config/trace-request.ndjson) | All spans of one `/api/config` request without the SDK hook: no span for the read |
| [`trace-request-get.ndjson`](../samples/global-config/trace-request-get.ndjson) | The same request with `setTracerProvider`: a `get` span under the route |
| [`span-get.json`](../samples/global-config/span-get.json) | The `get` span as drained (flattened attributes, `edgeConfigId`) |
| [`metrics-external-api.json`](../samples/global-config/metrics-external-api.json) | `vercel.external_api_request.count` by host and path: no Global Config host |
| [`metrics-invocations-2026-10-26.json`](../samples/global-config/metrics-invocations-2026-10-26.json) | Invocations per route for the billing day (10 on `/api/config`) |
| [`charges-2026-10-26.jsonl`](../samples/global-config/charges-2026-10-26.jsonl) | The Reads (per project) and Writes (team) billing lines |
| [`cli-inspect.json`](../samples/global-config/cli-inspect.json) | `vercel global-config inspect`: size, item count, digest |

## Sources

- Read 2026-11-12: [Vercel Tracing is now generally available](https://vercel.com/changelog/vercel-tracing-is-now-generally-available) (2026-11-06, trace retention); npm metadata for `@vercel/global-config`.
- Vercel docs, read 2026-10-27: [Global Config Limits and pricing](https://vercel.com/docs/global-config/global-config-limits) (last updated 2026-07-29), [Webhooks API reference](https://vercel.com/docs/webhooks/webhooks-api) (last updated 2026-09-17), `@vercel/global-config` README (OpenTelemetry tracing, Next.js fetch cache).
- Source: `@vercel/global-config` 1.5.1 (`dist/index.next-js.js`); npm registry metadata for `@vercel/global-config` (created 2026-07-20) and `@vercel/edge-config` (deprecated).
- Lab: Bronto EU datasets `vercel-observability-lab/vercel-logs` and `.traces/vercel-observability-lab`, 2026-10-27 08:43 to 08:50 UTC and 10:03 to 10:10 UTC (SDK hook, deployments `dpl_9aBXamwMGAtPV1yDNvA8pY9xnFiE` to `dpl_42HLZRGEErtMw8aedmJ4Lq6LB1GX`); `vercel metrics`, `vercel global-config inspect` and `backups` (CLI 65.2.0); `GET /v1/billing/charges` for the billing day 2026-10-26; `lab/NOTES.md`.
