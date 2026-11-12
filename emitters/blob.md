# Vercel Blob

> Vercel Blob leaves no telemetry of its own in drains. A lab request that ran `put`, `head`, `list` and `del` took 1.3 s, and all that left Vercel was the app's own log line, the function's report line and a span tree whose `executing api route` span has no children. Vercel's outgoing-request metric (`vercel.external_api_request.*`) didn't count the calls either. The reason is in the SDK: `@vercel/blob` 2.8.2 sends its requests through its own copy of `undici` (npm `undici` 6.x) instead of the global `fetch`, and the global `fetch` is what `@vercel/otel` and Vercel's runtime watch. `@opentelemetry/instrumentation-undici` does see those requests, because it listens on Node's diagnostics channels. Deployed in the lab, it gave each Blob call a client span in the trace drain (`PUT`, `GET`, `GET`, `POST` per round trip, 320 to 440 ms each). Added next to `@vercel/otel`'s default fetch instrumentation it also records every `globalThis.fetch` call a second time, so use it instead of the fetch instrumentation, not in addition. Usage leaves Vercel only as daily billing lines, and the trap is that those lines are team-level: they carry a region and no project or store, so Blob cost can't be split by project from the billing data.

| | |
| --- | --- |
| Kind | Platform service (object storage) and library (`@vercel/blob`) |
| Plans | All plans; drains need Pro or Enterprise |
| Signals | Traces (with an undici instrumentation) · Other: usage and cost records, store metadata. No logs or metrics of its own |
| Exit paths | Trace drain (with an undici instrumentation in code) · REST API (`GET /v1/billing/charges`, `GET /v1/storage/stores/{id}`) |
| Verified | 2026-10-27 · Vercel CLI 65.2.0 · `@vercel/blob` 2.8.2 (bundles `undici` 6.29.1) · `@vercel/otel` 2.1.3 · `@opentelemetry/instrumentation-undici` 0.34.0 (deployed 2026-10-27 10:03 UTC) · Next.js 16.4.3 · lab project `vercel-observability-lab` |
| Refreshed | 2026-11-12 · docs, changelog and releases to 2026-11-12, no new captures · `@vercel/blob` 2.9.0 (2026-11-09; still depends on and imports its own `undici` 6.x, checked in the published `dist`, so Gotcha 1 still applies) · Vercel CLI 65.14.0 |

## 1. What it emits

| Signal | What | Where it lives | Retention |
| --- | --- | --- | --- |
| Logs | Nothing from Blob. Your own `console` lines around the calls; with `DEBUG=blob`, the SDK's `console.debug` lines (from source, not tested) | Runtime Logs, log drain | As for Functions |
| Traces | Nothing by default: the calls run inside the function's spans without a child span. With `@opentelemetry/instrumentation-undici`: one `SPAN_KIND_CLIENT` span per Blob API call (Captured) | Trace drain | Vercel Tracing since 2026-11-06: Hobby 3 days, Pro and Enterprise 14 days (before: 1 h, 1 day, 3 days) (Documented); drained spans: your backend's retention |
| Metrics | None. No Blob metric in `vercel metrics schema`, and Blob calls are not in `vercel.external_api_request.*` (Observed) | | |
| Usage and cost | `Blob Storage Size`, `Blob Simple Operations`, `Blob Advanced Operations`, `Blob Data Transfer`, one line per region per billing day | Usage page, Blob Observability page in the dashboard (Documented), `GET /v1/billing/charges` | See the Billing entry |
| Store metadata | Object count, total size, region, access, connected projects | `vercel blob get-store`, `GET /v1/storage/stores/{id}` | Current state only |

The lab route `/api/blob` (`lab/app/api/blob/route.ts`) writes one small text object with `put`, reads its metadata with `head`, runs `list({ prefix: "lab/" })` and deletes it with `del`, then logs one JSON line.

## 2. Out-of-the-box shape

### Log records

Two records per request, both `source: lambda`, and neither mentions Blob beyond what the app writes (Captured, 6 requests on 2026-10-27):

| Record | `message` | Note |
| --- | --- | --- |
| App line | `{"msg":"blob roundtrip","pathname":"lab/hello-1793090678530.txt","size":32,"listed":1}` | The lab's own `console.log` (`log-app-line.json`) |
| Report line | `START RequestId: … REPORT … Duration: 1558 ms … Max Memory Used: 234 MB` | The function's report line, as in the Functions entry (`log-report-line.json`) |

The record fields are the Functions fields (`requestId`, `traceId`, `spanId`, `proxy.*`, `executionRegion`, `instanceId`). No record carries the store ID, operation, pathname or a Blob request ID. The SDK sends an `x-api-blob-request-id` header (`<storeId>:<timestamp>:<random>`) with every call, but nothing on the Vercel side logs it to you.

### Spans

Without an undici instrumentation, a `GET /api/blob` request in the trace drain (Captured: `trace-request.ndjson`):

```
GET /api/blob                               vercel.edge-network          1.60 s
├─ Resolve Deployment                       vercel.edge-network          2.75 ms
├─ Resolve Route                            vercel.edge-network          1.73 ms
├─ Resolve Cache                            vercel.edge-network          0.87 ms
├─ Route across regions                     vercel.edge-network         12.21 ms
├─ Invoke Function                          vercel.serverless-runtime    1.55 s
│  ├─ GET /api/blob                         vercel-observability-lab     1.54 s
│  │  ├─ prepare route module               vercel-observability-lab     0.40 ms
│  │  ├─ executing api route (app) /api/blob  vercel-observability-lab   1.55 s
│  │  └─ start response                     vercel-observability-lab     0.03 ms
│  └─ waitUntil                             vercel.serverless-runtime    0.11 ms
```

Four network calls to `https://vercel.com/api/blob` happen inside `executing api route`, and none of them has a span. Across the 6 traced requests that span averaged 1,329.5 ms (Observed). The same app's BotID call, which uses the global `fetch`, does get a `fetch POST https://api.vercel.com/bot-protection/v1/is-bot` span from `@vercel/otel` in the same dataset (Observed, 9 spans).

With `@opentelemetry/instrumentation-undici` 0.34.0 registered (section 3), the same request has one child span per Blob call (Captured: `trace-request-undici.ndjson`, 2026-10-27 10:03 UTC):

```
├─ Invoke Function                          vercel.serverless-runtime    1.46 s
│  ├─ GET /api/blob                         vercel-observability-lab     1.46 s
│  │  ├─ prepare route module               vercel-observability-lab     0.51 ms
│  │  ├─ executing api route (app) /api/blob  vercel-observability-lab   1.45 s
│  │  │  ├─ PUT    (put)                    vercel-observability-lab   398.91 ms
│  │  │  ├─ GET    (head)                   vercel-observability-lab   323.92 ms
│  │  │  ├─ GET    (list)                   vercel-observability-lab   320.81 ms
│  │  │  └─ POST   (del)                    vercel-observability-lab   403.51 ms
│  │  └─ start response                     vercel-observability-lab     0.13 ms
```

The four spans account for 1.45 s of the 1.45 s route, so the whole route is Blob round trips from `dub1` to `vercel.com`. A Blob span as delivered (Captured: `span-undici-put.json`, flattened, Vercel resource attributes left out):

```json
{ "span.name": "PUT", "span.kind": "SPAN_KIND_CLIENT", "span.status_code": "STATUS_CODE_UNSET",
  "operation.name": "opentelemetry_instrumentation-undici.client",
  "http.request.method": "PUT", "http.response.status_code": "200",
  "url.full": "https://vercel.com/api/blob/?pathname=lab%2Fhello-1793095434937.txt",
  "url.path": "/api/blob/", "url.query": "?pathname=lab%2Fhello-1793095434937.txt",
  "server.address": "vercel.com", "server.port": "443", "network.peer.address": "64.239.109.129",
  "network.protocol.version": "1.1", "user_agent.original": "undici" }
```

| SDK call | `span.name` | `url.path` | `url.query` | Avg over 10 requests |
| --- | --- | --- | --- | --- |
| `put` | `PUT` | `/api/blob/` | `?pathname=<pathname>` | 440.8 ms |
| `head` | `GET` | `/api/blob` | `?url=<blob URL>` | 320.7 ms (with `list`) |
| `list` | `GET` | `/api/blob` | `?prefix=lab%2F` | |
| `del` | `POST` | `/api/blob/delete` | none (URLs in the body) | 393.8 ms |

(Captured: `span-undici-put.json`, `span-undici-head.json`, `span-undici-list.json`, `span-undici-del.json`.) No attribute names the store, the SDK operation or the `x-api-blob-request-id`; the operation has to be read from method, path and query. `user_agent.original` is `undici`, the private copy's default, while calls through `globalThis.fetch` carry their caller's user agent. Vercel's `vercel.external_api_request.count` still listed only the BotID call after the instrumentation was deployed (Captured: `metrics-external-api-after-undici.json`): the platform metric is measured independently of what the app instruments.

### Why the calls are invisible by default

From the `@vercel/blob` 2.8.2 source (`dist/chunk-XKVPKJPO.js`):

- `import { fetch } from "undici"` in `src/fetch.ts`. The package depends on `undici ^6.23.0`; the lab resolves 6.29.1, and Next.js bundled it into the route's server chunk (the built chunk contains undici's own `undici:request:create` channel names).
- The browser build maps `undici` to `globalThis.fetch` (`package.json` `browser` field), so client uploads use the browser's `fetch`. On the server, Node's own `fetch` is never called.
- API base: `https://vercel.com/api/blob` (override: `VERCEL_BLOB_API_URL`). Retries via `async-retry`, with the attempt number in `x-api-blob-request-attempt`.
- No OpenTelemetry dependency and no tracer hook in the package.

`@vercel/otel` 2.1.3 instruments outgoing calls by replacing `globalThis.fetch`, so a separate `undici` copy bypasses it. Vercel's `vercel.external_api_request.count` missed the calls the same way: grouped by `requestHostname` and `requestPath` for the lab's last 3 hours it returned only `api.vercel.com /bot-protection/v1/is-bot 12`, while `/api/blob` ran 9 times (Captured: `metrics-external-api.json`).

### Usage and cost records

The billing day 2026-10-26 07:00 to 2026-10-27 07:00 UTC, Blob lines for Dublin (`dub1`, the store's region) (Captured: `charges-2026-10-26.jsonl`):

| `ServiceName` | `ConsumedQuantity` | `EffectiveCost` | `Tags` |
| --- | --- | --- | --- |
| `Blob Advanced Operations` | 18 Operations | $0.00009 | `{}` |
| `Blob Simple Operations` | 9 Operations | $0.0000036 | `{}` |
| `Blob Data Transfer` | 0 GB | 0 | `{}` |
| `Blob Storage Size` | 0 GB | 0 | `{}` |

`/api/blob` ran 9 times that billing day (`vercel.function_invocation.count`, Captured: `metrics-invocations-2026-10-26.json`). 9 requests × (`put` + `list`) = 18 advanced operations, 9 × `head` = 9 simple operations, and the 9 `del` calls are free, which is what Vercel's pricing page says (Documented: uploads, copies and lists are advanced, metadata reads and cache-miss reads are simple, deletes are free). The billing data matched the code exactly (Observed).

The endpoint returns a line for every Blob region, most with 0, and the same day had larger lines for `Washington, D.C., USA` from another store on the team. None of the Blob lines has `Tags.ProjectId`: they belong to the team, and a store or project can only be inferred from the region when each region holds one store (Observed). Global Config and Flags lines, by contrast, carry the project.

### Store metadata

`vercel blob get-store store_186lljFsKYsfqxFe` and `GET /v1/storage/stores/store_186lljFsKYsfqxFe` return the current object count, size, region, access mode, billing state, `usageQuotaExceeded` and the connected projects with their env var names (Captured: `api-store.json`). The lab's store showed `count: 0`, `size: 0` because each request deletes its object. There is no history.

## 3. Extras beyond the default

| Extra | What it adds | Cost |
| --- | --- | --- |
| `@opentelemetry/instrumentation-undici` | One `SPAN_KIND_CLIENT` span per Blob API call, with `http.request.method`, `url.full`, `server.address: vercel.com`, `http.response.status_code`, `error.type` on failure | None in code; drained spans cost trace drain volume |
| `DEBUG=blob` env var | `vercel-blob: using fetch` and multipart-upload progress lines through `console.debug` (from source; not tested) | Log volume |
| Your own log line | Operation, pathname and size per call, as the lab does | None |
| Blob Observability page | Usage charts in the dashboard (Documented) | Stays in Vercel |

### The undici instrumentation, deployed

The lab's `instrumentation.ts` since 2026-10-27 10:06 UTC:

```ts
process.env.NEXT_OTEL_FETCH_DISABLED = "1";
registerOTel({
  serviceName: "vercel-observability-lab",
  instrumentations: [new UndiciInstrumentation()],
});
```

Three configurations were deployed in turn, each with 3 or 4 requests to `/api/blob` and to `POST /api/botid` (whose `checkBotId()` calls `globalThis.fetch`):

| `instrumentations` | Blob calls | BotID's `globalThis.fetch` call | Sample |
| --- | --- | --- | --- |
| default (`["auto"]`, the fetch instrumentation) | no span | 1 span, `fetch POST https://api.vercel.com/…` (`operation.name: fetch.POST`) | `trace-request.ndjson` |
| `["auto", new UndiciInstrumentation()]` | 1 span each | **2 sibling spans**: `fetch POST …` from `@vercel/otel` and `POST` from undici, same parent, same start | `trace-botid-duplicate.ndjson` |
| `[new UndiciInstrumentation()]` | 1 span each | **2 nested spans**: Next.js's own `fetch POST …` (`next.span_type: AppRender.fetch`) with the undici `POST` as its child | `trace-botid-nextjs-duplicate.ndjson` |
| `[new UndiciInstrumentation()]` + `NEXT_OTEL_FETCH_DISABLED=1` | 1 span each | 1 span, `POST` from undici | `trace-botid-undici-only.ndjson` |

(Captured, 2026-10-27 10:03 to 10:07 UTC.) Node's `fetch` is built on undici and publishes to the same diagnostics channels, so the undici instrumentation sees every `globalThis.fetch` call as well as the Blob SDK's private copy. `@vercel/otel`'s fetch instrumentation sets `NEXT_OTEL_FETCH_DISABLED=1` when it starts (from source, `dist/node/index.js`), which is why Next.js's own fetch span only appears once that instrumentation is removed. The last row is the one that sends each outgoing request once. The trade-off is the span shape for `globalThis.fetch` calls: `POST` with stable semantic-convention attributes (`url.full`, `server.address`, `http.response.status_code`) instead of `fetch POST <url>` with `http.url`, `http.host`, `http.status_code` (Captured: `span-fetch-botid.json`, `span-undici-botid.json`). Queries and dashboards built on the old span names need updating. The undici span also sets `span.status_code: STATUS_CODE_ERROR` and `error.type` for 4xx responses (BotID's 400 for curl), where the fetch span left the status unset.

`@opentelemetry/instrumentation-undici` 0.34.0 (released 2026-10-20) requires Node.js 22.15 or later and depends on `@opentelemetry/instrumentation` 0.300; `@vercel/otel` 2.1.3 accepted the instance without a type or runtime error.

The earlier local test (Node.js 24, `@vercel/blob` 2.8.2, `@opentelemetry/sdk-trace-node` 2.12.0, `@opentelemetry/instrumentation-undici` 0.34.0, a console exporter) called `head()` with a non-existent store token. It produced one client span, and a wrapper around `globalThis.fetch` counted 0 calls (Captured: `span-undici-local.txt`):

```
name: GET   kind: CLIENT   status: ERROR
http.request.method = GET
url.full = https://vercel.com/api/blob?url=https%3A%2F%2Fexample.public.blob.vercel-storage.com%2Fx.txt
server.address = vercel.com
user_agent.original = undici
http.response.status_code = 404
error.type = 404
instrumentationScope = @opentelemetry/instrumentation-undici 0.34.0
```

The deployed spans matched it attribute for attribute.

Two things to know about these spans: `url.full` contains the blob URL (`?url=…` for `head`, the pathname for `put`), so object names leave with the span; and the span name is just the method (`GET`, `PUT`, `POST`), so tell Blob calls apart by `url.path` (`/api/blob`) and the query.

## 4. Getting it out

| Signal | Exit path | Tested configuration |
| --- | --- | --- |
| Blob calls as spans | Add `@opentelemetry/instrumentation-undici` to `@vercel/otel` in place of the fetch instrumentation, with `NEXT_OTEL_FETCH_DISABLED=1`; spans leave through the trace drain (or your exporter, not both) | Lab, 2026-10-27 (section 3) |
| Blob calls as log lines | Your own structured log line, through the log drain | Lab route, `log-app-line.json` |
| Usage and cost | `GET /v1/billing/charges` once per billing day, team-level lines per region | `vercel api "/v1/billing/charges?from=2026-10-26T07:00:00Z&to=2026-10-27T07:00:00Z"` |
| Store size and count | `GET /v1/storage/stores/{id}` on a schedule | `vercel api /v1/storage/stores/store_186lljFsKYsfqxFe` |
| Blob Observability charts | None; dashboard only | |

No drain carries anything Blob-specific, and no Blob webhook events exist in Vercel's webhook event list (Documented, read 2026-10-27).

## 5. In Bronto

| Data | Dataset | Field names |
| --- | --- | --- |
| Log drain | `vercel-observability-lab/vercel-logs` | As in the payload: `path`, `message`, `traceId` |
| Trace drain | `.traces/vercel-observability-lab` (app spans), `.traces/vercel.edge-network`, `.traces/vercel.serverless-runtime` (Vercel's infrastructure spans) | `"$span.name"`, `"$span.duration_nano"`, `$trace_id` |

Queries run 2026-10-27 against the lab's drained data (from 08:43 UTC; the undici instrumentation from 10:03 UTC):

| Question | Query | Group by | Result |
| --- | --- | --- | --- |
| Blob round trips logged by the app | `source = 'lambda' AND message LIKE '%blob roundtrip%'` | `path` | `/api/blob` 6 |
| Time spent in the route that calls Blob | `"$span.name" = 'executing api route (app) /api/blob'`, `avg("$span.duration_nano")` | `"$span.name"` | 1,329.5 ms over 6 spans |
| Outgoing calls with a span, before the undici instrumentation | `"$span.kind" = 'SPAN_KIND_CLIENT'` | `"$http.host"` | `api.vercel.com` 9 (BotID only; no `vercel.com` Blob calls) |
| Blob calls, with the undici instrumentation | `"$server.address" = 'vercel.com' AND "$url.path" LIKE '/api/blob%'` | `"$http.request.method"`, `"$url.path"` | `GET /api/blob` 20, `PUT /api/blob/` 10, `POST /api/blob/delete` 10 (10 requests) |
| Blob latency per call type | same, `avg("$span.duration_nano")` | `"$http.request.method"`, `"$url.path"` | `PUT` 440.8 ms, `POST` (delete) 393.8 ms, `GET` 320.7 ms |
| Client spans by source | `"$span.kind" = 'SPAN_KIND_CLIENT'` | `"$operation.name"` | `opentelemetry_instrumentation-undici.client` for Blob and BotID once deployed; `fetch.POST` and `next_js.AppRender.fetch` only from the duplicate configurations |

## Gotchas

1. **Blob calls bypass fetch instrumentation.** `@vercel/blob` uses its own `undici`, so `@vercel/otel` records no span and `vercel.external_api_request.*` records no request. A route that spends 1.3 s in Blob shows one childless span (Observed; source of 2.8.2). `@opentelemetry/instrumentation-undici` fixes the spans; the platform metric stays blind to Blob calls either way (Observed).
2. **Undici plus fetch instrumentation counts `fetch` twice.** Node's `fetch` is undici, so adding the undici instrumentation next to `@vercel/otel`'s default gives every `globalThis.fetch` call two spans; removing the fetch instrumentation brings back Next.js's own `fetch` span (also two). Use the undici instrumentation alone and set `NEXT_OTEL_FETCH_DISABLED=1` (Observed, three lab deployments).
3. **Blob billing lines have no project.** `Tags` is `{}` on every Blob line, unlike Global Config and Flags lines. Attribute cost by region, or keep one store per region and project (Observed, billing day 2026-10-26).
4. **The billing endpoint lists every Blob region.** A team with one store in `dub1` gets 21 lines per Blob service per day, most of them 0 (Observed).
5. **Deletes are free and uncounted.** 9 `del` calls produced no operation line; 9 `put` + 9 `list` = 18 advanced operations; 9 `head` = 9 simple operations (Observed, matches the pricing page).
6. **Dashboard browsing is billed as operations.** Browsing a store in the dashboard counts as advanced operations (Documented), so a quiet store can still show operations.
7. **Span URLs hold object names.** With an undici instrumentation, `url.full` and `url.query` contain blob pathnames and URLs (Captured).

## Samples

| File | What it shows |
| --- | --- |
| [`log-app-line.json`](../samples/blob/log-app-line.json) | The app's own JSON line for a Blob round trip, the only Blob trace in the log drain |
| [`log-report-line.json`](../samples/blob/log-report-line.json) | The report line of the same kind of request (1,558 ms) |
| [`trace-request.ndjson`](../samples/blob/trace-request.ndjson) | All 11 spans of one `/api/blob` request: no child span for the four Blob calls |
| [`metrics-external-api.json`](../samples/blob/metrics-external-api.json) | `vercel.external_api_request.count` by host and path: BotID only |
| [`metrics-invocations-2026-10-26.json`](../samples/blob/metrics-invocations-2026-10-26.json) | Invocations per route for the billing day (9 on `/api/blob`) |
| [`charges-2026-10-26.jsonl`](../samples/blob/charges-2026-10-26.jsonl) | The four Blob billing lines for `dub1`, `Tags: {}` |
| [`api-store.json`](../samples/blob/api-store.json) | `GET /v1/storage/stores/{id}`: count, size, region, connected project |
| [`span-undici-local.txt`](../samples/blob/span-undici-local.txt) | A client span for a Blob `head()` from `@opentelemetry/instrumentation-undici` (local test, console exporter output) |
| [`trace-request-undici.ndjson`](../samples/blob/trace-request-undici.ndjson) | One `/api/blob` request with the undici instrumentation: four Blob client spans |
| [`span-undici-put.json`](../samples/blob/span-undici-put.json), [`span-undici-head.json`](../samples/blob/span-undici-head.json), [`span-undici-list.json`](../samples/blob/span-undici-list.json), [`span-undici-del.json`](../samples/blob/span-undici-del.json) | The four Blob client spans as drained (flattened attributes) |
| [`span-fetch-botid.json`](../samples/blob/span-fetch-botid.json), [`span-undici-botid.json`](../samples/blob/span-undici-botid.json) | The same BotID `globalThis.fetch` call as a `@vercel/otel` fetch span and as an undici span |
| [`trace-botid-duplicate.ndjson`](../samples/blob/trace-botid-duplicate.ndjson) | Fetch plus undici instrumentation: two sibling spans for one call |
| [`trace-botid-nextjs-duplicate.ndjson`](../samples/blob/trace-botid-nextjs-duplicate.ndjson) | Undici only, without `NEXT_OTEL_FETCH_DISABLED`: Next.js's fetch span with the undici span nested |
| [`trace-botid-undici-only.ndjson`](../samples/blob/trace-botid-undici-only.ndjson) | The tested configuration: one span per call |
| [`metrics-external-api-after-undici.json`](../samples/blob/metrics-external-api-after-undici.json) | `vercel.external_api_request.count` after the undici deployment: still BotID only |

## Sources

- Read 2026-11-12: [`@vercel/blob` 2.9.0 release notes](https://github.com/vercel/storage/releases/tag/%40vercel%2Fblob%402.9.0) (TTL options; no telemetry change), package `dist` and `package.json` of 2.9.0; [Vercel Tracing is now generally available](https://vercel.com/changelog/vercel-tracing-is-now-generally-available) (2026-11-06, trace retention).
- Vercel docs, read 2026-10-27: [Vercel Blob Pricing](https://vercel.com/docs/vercel-blob/usage-and-pricing) (last updated 2026-09-23), [Webhooks API reference](https://vercel.com/docs/webhooks/webhooks-api) (last updated 2026-09-17), [List FOCUS billing charges](https://vercel.com/docs/rest-api/billing/list-focus-billing-charges).
- Source: `@vercel/blob` 2.8.2 (`dist/chunk-XKVPKJPO.js`, `package.json`), `@vercel/otel` 2.1.3 (`dist/edge/index.js`, `dist/node/index.js`, fetch instrumentation), `@opentelemetry/instrumentation-undici` 0.34.0 (npm metadata), `undici` 6.29.1 (`lib/core/diagnostics.js`), the lab's built server chunk.
- Lab: Bronto EU datasets `vercel-observability-lab/vercel-logs` and `.traces/vercel-observability-lab`, 2026-10-27 08:43 to 08:50 UTC and 10:03 to 10:10 UTC (undici instrumentation, deployments `dpl_9aBXamwMGAtPV1yDNvA8pY9xnFiE`, `dpl_EWQV89riJZ21sXkqT7waRB8wQhG5`, `dpl_42HLZRGEErtMw8aedmJ4Lq6LB1GX`); `vercel metrics` and `vercel blob get-store` (CLI 65.2.0); `GET /v1/billing/charges` for the billing day 2026-10-26; `GET /v1/storage/stores/store_186lljFsKYsfqxFe`; local undici test, 2026-10-27; `lab/NOTES.md`.
