# Vercel Blob

> Vercel Blob leaves no telemetry of its own in drains. A lab request that ran `put`, `head`, `list` and `del` took 1.3 s, and all that left Vercel was the app's own log line, the function's report line and a span tree whose `executing api route` span has no children. Vercel's outgoing-request metric (`vercel.external_api_request.*`) didn't count the calls either. The reason is in the SDK: `@vercel/blob` 2.8.2 sends its requests through its own copy of `undici` (npm `undici` 6.x) instead of the global `fetch`, and the global `fetch` is what `@vercel/otel` and Vercel's runtime watch. `@opentelemetry/instrumentation-undici` does see those requests, because it listens on Node's diagnostics channels, so one added instrumentation gives each Blob call a client span. Usage leaves Vercel only as daily billing lines, and the trap is that those lines are team-level: they carry a region and no project or store, so Blob cost can't be split by project from the billing data.

| | |
| --- | --- |
| Kind | Platform service (object storage) and library (`@vercel/blob`) |
| Plans | All plans; drains need Pro or Enterprise |
| Signals | Other: usage and cost records, store metadata. No logs, spans or metrics of its own |
| Exit paths | REST API (`GET /v1/billing/charges`, `GET /v1/storage/stores/{id}`) · OTLP from code (with an undici instrumentation) |
| Verified | 2026-10-27 · Vercel CLI 65.2.0 · `@vercel/blob` 2.8.2 (bundles `undici` 6.29.1) · `@vercel/otel` 2.1.3 · `@opentelemetry/instrumentation-undici` 0.34.0 (local test) · lab project `vercel-observability-lab` |

## 1. What it emits

| Signal | What | Where it lives | Retention |
| --- | --- | --- | --- |
| Logs | Nothing from Blob. Your own `console` lines around the calls; with `DEBUG=blob`, the SDK's `console.debug` lines (from source, not tested) | Runtime Logs, log drain | As for Functions |
| Traces | Nothing from Blob. The calls run inside the function's spans without a child span | Trace drain | As for Functions |
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

A `GET /api/blob` request in the trace drain (Captured: `trace-request.ndjson`):

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

### Why the calls are invisible

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

### The undici instrumentation, tested

A local test (Node.js 24, `@vercel/blob` 2.8.2, `@opentelemetry/sdk-trace-node` 2.12.0, `@opentelemetry/instrumentation-undici` 0.34.0, a console exporter) called `head()` with a non-existent store token. It produced one client span, and a wrapper around `globalThis.fetch` counted 0 calls (Captured: `span-undici-local.txt`):

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

So the instrumentation, which subscribes to undici's diagnostics channels by name, catches the SDK's private copy too. On Vercel it would be added to `registerOTel({ instrumentations: [...] })` in `instrumentation.ts`, and the spans would leave through the trace drain like the app's other spans. That deployment is Not observed: it needs a change to the lab's `instrumentation.ts`.

Two things to know about these spans: `url.full` contains the blob URL (`?url=…` for `head` and `del`, the pathname for `put`), so object names leave with the span; and the span name is just the method (`GET`, `PUT`, `POST`), so tell Blob calls apart by `url.path` (`/api/blob`) and the query.

## 4. Getting it out

| Signal | Exit path | Tested configuration |
| --- | --- | --- |
| Blob calls as spans | OTLP from code: add `@opentelemetry/instrumentation-undici` to `@vercel/otel`; spans leave through the trace drain (or your exporter, not both) | Local test only (section 3) |
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

Queries run 2026-10-27 against the lab's last 6 hours (drained data starts 08:43 UTC):

| Question | Query | Group by | Result |
| --- | --- | --- | --- |
| Blob round trips logged by the app | `source = 'lambda' AND message LIKE '%blob roundtrip%'` | `path` | `/api/blob` 6 |
| Time spent in the route that calls Blob | `"$span.name" = 'executing api route (app) /api/blob'`, `avg("$span.duration_nano")` | `"$span.name"` | 1,329.5 ms over 6 spans |
| Outgoing calls with a span | `"$span.kind" = 'SPAN_KIND_CLIENT'` | `"$http.host"` | `api.vercel.com` 9 (BotID only; no `vercel.com` Blob calls) |

With the undici instrumentation deployed, `"$server.address" = 'vercel.com' AND "$url.path" = '/api/blob'` would select the Blob calls (Not observed on Vercel).

## Gotchas

1. **Blob calls bypass fetch instrumentation.** `@vercel/blob` uses its own `undici`, so `@vercel/otel` records no span and `vercel.external_api_request.*` records no request. A route that spends 1.3 s in Blob shows one childless span (Observed; source of 2.8.2).
2. **Blob billing lines have no project.** `Tags` is `{}` on every Blob line, unlike Global Config and Flags lines. Attribute cost by region, or keep one store per region and project (Observed, billing day 2026-10-26).
3. **The billing endpoint lists every Blob region.** A team with one store in `dub1` gets 21 lines per Blob service per day, most of them 0 (Observed).
4. **Deletes are free and uncounted.** 9 `del` calls produced no operation line; 9 `put` + 9 `list` = 18 advanced operations; 9 `head` = 9 simple operations (Observed, matches the pricing page).
5. **Dashboard browsing is billed as operations.** Browsing a store in the dashboard counts as advanced operations (Documented), so a quiet store can still show operations.
6. **Span URLs hold object names.** With an undici instrumentation, `url.full` and `url.query` contain blob pathnames and URLs (local test).

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

## Sources

- Vercel docs, read 2026-10-27: [Vercel Blob Pricing](https://vercel.com/docs/vercel-blob/usage-and-pricing) (last updated 2026-09-23), [Webhooks API reference](https://vercel.com/docs/webhooks/webhooks-api) (last updated 2026-09-17), [List FOCUS billing charges](https://vercel.com/docs/rest-api/billing/list-focus-billing-charges).
- Source: `@vercel/blob` 2.8.2 (`dist/chunk-XKVPKJPO.js`, `package.json`), `@vercel/otel` 2.1.3 (`dist/edge/index.js`, fetch instrumentation), `undici` 6.29.1 (`lib/core/diagnostics.js`), the lab's built server chunk.
- Lab: Bronto EU datasets `vercel-observability-lab/vercel-logs` and `.traces/vercel-observability-lab`, 2026-10-27 08:43 to 08:50 UTC; `vercel metrics` and `vercel blob get-store` (CLI 65.2.0); `GET /v1/billing/charges` for the billing day 2026-10-26; `GET /v1/storage/stores/store_186lljFsKYsfqxFe`; local undici test, 2026-10-27; `lab/NOTES.md`.
