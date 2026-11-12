# Vercel Functions

> Every function invocation produces log records and infrastructure spans with no setup at all. The log drain carries both your `console` output and one platform line per invocation. That line holds the duration and peak memory as text, and its numbers match Vercel's own `function_duration_ms` and `peak_memory_mb` metrics exactly, so duration and memory can leave Vercel on any paid plan, and an `Init Duration` marks invocations that started a new instance. The trace drain carries a span tree for each request: routing, cross-region hops, the invocation and `waitUntil`. Active CPU time, CPU throttle, cold-versus-pre-warmed and TTFB exist only as metrics inside Vercel, need Observability Plus to query, and have no drain. The trap: a streaming function that hits its timeout has already answered `200`, so its timeout line carries no status code and 5xx-based alerts never see it.

| | |
| --- | --- |
| Kind | Platform service (Node.js, Bun, Python runtimes; Fluid Compute) |
| Plans | Logs on all plans in the dashboard; traces on all plans once the project has a tracing sampling rule (added by default for new Next.js 16.5+ projects since 2026-11-06; Hobby includes 1M span units a month); drains need Pro or Enterprise; metrics queries need Observability Plus |
| Signals | Logs · Traces · Metrics (inside Vercel only) |
| Exit paths | Log drain (`source: lambda`) · Trace drain · OTLP from code |
| Verified | 2026-10-26 · Vercel CLI 65.2.0 · Next.js 16.3.6 · `@vercel/otel` 2.1.3 · lab project `petclinic-agent` |
| Refreshed | 2026-11-12 · docs and changelog to 2026-11-12, no new captures · Vercel CLI 65.14.0 docs · `@vercel/otel` 2.3.0 |

## 1. What it emits

| Signal | What | Where it lives | Retention |
| --- | --- | --- | --- |
| Logs | `console.*`/stdout/stderr lines from your code, platform lines (invocation report, timeout, process exit) | Runtime Logs, `vercel logs` | Hobby 1 h, Pro 1 day, Enterprise 3 days, with Observability Plus 30 days (Documented) |
| Traces | Infrastructure spans for every request (edge network and function runtime), `fetch` spans for outgoing calls, framework spans if the framework emits them | Traces page (Vercel Tracing), `vercel traces`, trace drain | In Vercel: Hobby 3 days, Pro 14 days, Enterprise 14 days since 2026-11-06; before that as for logs (Documented). Drained spans: your backend's retention |
| Metrics | `vercel.function_invocation.*` (10 metrics), `vercel.external_api_request.*` (outgoing calls), `vercel.request.*` | Observability dashboard, Query, `vercel metrics` | Hobby 12 h, Pro 1 day, Enterprise 3 days, Plus 30 days (Documented) |

The metric catalog with every dimension is in [`reference/vercel-metrics-schema.json`](../reference/vercel-metrics-schema.json). The function metrics are `count`, `function_duration_ms`, `function_cpu_time_ms`, `cpu_throttle_percent`, `peak_memory_mb`, `provisioned_memory_mb`, `ttfb_ms` and Fast Origin Transfer in, out and total. Each has 19 dimensions, among them `route`, `errorCode`, `functionStartType`, `functionRegion`, `edgeNetworkRegion`, `httpStatus`, `serverActionName` and `deploymentId`.

## 2. Out-of-the-box shape

### Log records

One drain record per log line. Every record of a request repeats the request context (`proxy.*`), so a function that logs ten lines produces ten full records. Fields seen on `source: lambda` records in the lab (2,000 records sampled, Captured):

| Field | Example | Note |
| --- | --- | --- |
| `id` | `70627586130179300501598997000000` | |
| `timestamp` | `1793005015989` | ms; when the line was written |
| `source` | `lambda` | |
| `type` | `stdout`, `stderr` | Absent on request-only records (see below) |
| `level` | `info`, `warning`, `error` | Derived, see "How `level` is set" |
| `message` | `START RequestId: …` | Up to 256 KB, then truncated (Documented) |
| `statusCode` | `200` | Only on records written after the response status is known |
| `requestId` | `k65tr-1793005015981-2981b42e7310` | Same as `proxy.vercelId` on other sources |
| `invocationId` | `01M5VPTMXP15SY9JV9PW42GXK9` | **Not in Vercel's published schema.** On 99% of records |
| `instanceId` | `usLzl1ecc7nq` | **Not in Vercel's published schema.** Identifies the Fluid instance; requests that share it share memory and CPU |
| `executionRegion` | `dub1` | Where the function ran |
| `path` | `/eve/v1/session/[sessionId]/stream` | The **route pattern**, not the URL path |
| `host`, `projectId`, `projectName`, `deploymentId`, `environment`, `branch` | | `branch` is missing on some records |
| `traceId`, `spanId` | `6adee827…`, `8a66043f…` | On 88% of records; joins the line to its trace |
| `proxy.timestamp` | `1793005015981` | When the request reached the edge |
| `proxy.method`, `proxy.host`, `proxy.path`, `proxy.scheme` | | `proxy.path` is the real URL with query string |
| `proxy.statusCode` | `200` | |
| `proxy.region` | `dub1` | The edge region that received the request |
| `proxy.lambdaRegion` | `dub1` | |
| `proxy.userAgent` | `["vercel-queue/v2beta"]` | An array |
| `proxy.clientIp` | | |
| `proxy.vercelCache` | `MISS` | |
| `proxy.pathType` | `streaming_func` | |
| `proxy.pathTypeVariant` | `lambda` | Rare (36 of 2,000) |

Not in function records as fields, though the dashboard shows them: function start type (only hinted at by `Init Duration` in the report text), Active CPU, CPU throttle, the platform error code (such as `FUNCTION_INVOCATION_TIMEOUT`), cache reason.

### The invocation report line

For each invocation the runtime writes one record whose `message` is four lines:

```
START RequestId: 9732347b-29e7-4b31-9f1c-b69b08ce32b8
[GET] /api/chaos?kind=error status=500
END RequestId: 9732347b-29e7-4b31-9f1c-b69b08ce32b8
REPORT RequestId: 9732347b-29e7-4b31-9f1c-b69b08ce32b8 Duration: 17 ms Billed Duration: 17 ms Memory Size: 2048 MB Max Memory Used: 234 MB
```

This is the only place outside Vercel where function duration and peak memory per invocation appear. They are text in `message`, so they need a parser to become numbers (Captured: `log-report-line.json`, `log-report-500.json`).

The report line reproduces Vercel's metrics. For 2026-10-25 (UTC), parsed report lines against `vercel metrics` (Observed):

| Route | Invocations: report lines / metric | Avg duration: report / `function_duration_ms` | Max memory: report / `peak_memory_mb` |
| --- | --- | --- | --- |
| `/.well-known/workflow/v1/flow` | 20,834 / 20,836 | 407.4 ms (metric) | 355 MB (metric) |
| `/api/synthetic` | 1,440 / 1,440 | 37.2 ms / 37.2 ms | 265 MB / 265 MB |
| `/` | 288 / 288 | 685.6 ms / 685.6 ms | 369 MB / 369 MB |
| `/api/ops` | 24 / 24 | 1,923.4 ms / 1,923.4 ms | 278 MB / 278 MB |
| Middleware (`/services/web/_middleware`) | 1,760 / 1,760 (`vercel.middleware_invocation.count`) | | |

An invocation that starts a new instance adds `Init Duration` to the report line:

```
REPORT RequestId: 07da2441-… Duration: 1289 ms Billed Duration: 1289 ms Memory Size: 2048 MB Max Memory Used: 281 MB Init Duration: 408 ms
```

On 2026-10-25, 362 function report lines carried `Init Duration`, the same as the cold (306) plus pre-warmed (56) starts in `vercel.function_invocation.count` grouped by `functionStartType` (Observed). So the share of invocations that started an instance can leave Vercel through the drain. Cold and pre-warmed can't be told apart there. On 2026-10-23 the two counts were further apart (477 report lines against 548 starts), so treat it as close, not exact.

`Billed Duration` equalled `Duration` in all 1,440 `/api/synthetic` invocations. It is not the Active CPU time Vercel bills under Fluid Compute; that number (`function_cpu_time_ms`) exists only as a metric.

### How `level` is set

From 349,626 function records over 14 days (Observed):

| Record | `type` | `level` |
| --- | --- | --- |
| Report line, status 2xx/3xx | `stdout` | `info` |
| Report line, status 4xx | `stdout` | `warning` |
| Report line, status 5xx | `stderr` | `error` |
| Your `console.log` | `stdout` | `info` |
| Your `console.error`; an uncaught error in a route handler (`Error: …` with stack) | `stderr` | `error` |
| Library warnings on stderr (seen: Workflow SDK) | `stderr` | `warning` |
| `Node.js process exited with exit status: N` | `stderr` | **`info`** |
| Unhandled promise rejection, runtime form (`Unhandled Rejection: TypeError: …`) | `stderr` | **`info`** |
| Unhandled promise rejection, Next.js form (`⨯ unhandledRejection: …`) | **`stdout`** | **`info`** |
| `Vercel Runtime Timeout Error: Task timed out after N seconds` | `stderr` | `error` |

### Request-only records

Requests served from the ISR cache can produce a `source: lambda` record with no `message` and no `type`, only the request context (`proxy.pathType: PRERENDER`, `proxy.vercelCache: HIT` or `STALE`). Count them as requests, not as log lines (Observed, 30 in 14 days).

### Spans

Vercel's trace drain delivers a span tree for every traced request. A cron request to `/api/synthetic` (Captured: `trace-request.ndjson`):

```
GET /api/synthetic                         vercel.edge-network        128.8 ms
├─ Resolve Deployment                      vercel.edge-network          7.4 ms
├─ Resolve Route                           vercel.edge-network         29.3 ms
│  └─ Invoke Middleware                    vercel.serverless-runtime  223.3 ms
│     ├─ middleware GET                    petclinic-web (Next.js)      0.6 ms
│     └─ waitUntil                         vercel.serverless-runtime  216.1 ms
├─ Route across regions                    vercel.edge-network         35.4 ms
└─ Invoke Function                         vercel.serverless-runtime   20.3 ms
   ├─ GET /api/synthetic                   petclinic-web (Next.js)      2.0 ms
   │  ├─ executing api route (app) …       petclinic-web                0.4 ms
   │  └─ start response                    petclinic-web                0.0 ms
   └─ waitUntil                            vercel.serverless-runtime   14.4 ms
```

- The root span (`service.name: vercel.edge-network`) carries the request: `http.route`, `http.response.status_code`, `http.request.header.user-agent`, `cloud.region` (the edge region), `vercel.cache_level`, the Git branch and commit (`vcs.ref.head.name`, `vcs.ref.head.revision`), and a `TTFB` span event (Captured: `span-edge-network.json`).
- `Invoke Function` (`service.name: vercel.serverless-runtime`) carries only IDs: no route, no region, no start type, no memory (Captured: `span-invoke-function.json`).
- `Route across regions` appears when the request enters in one region and the function runs in another. Its duration is the extra hop.
- Infrastructure spans are always `STATUS_CODE_UNSET`, including for 4xx responses (Observed: 1.59M runtime spans, 3,606 edge spans with 4xx). Whether a 5xx sets an error status: Not observed yet.
- The Next.js spans (`petclinic-web`) appear because the app registers `@vercel/otel`. Without an OpenTelemetry setup, Vercel records `fetch` spans for outgoing calls itself, but there are no framework spans. A project that lists `@opentelemetry/api` 1.7+, `@vercel/otel` 1.11+ or `@opentelemetry/sdk-trace-node` 1.19+ and never registers an SDK has no `fetch` spans at all (Documented, Instrumentation, read 2026-11-12). Projects that qualify for default tracing (created from 2026-11-05, Next.js 16.5+, no own `instrumentation` file) get `@vercel/otel` added at build and so get the framework spans (Documented; see the Next.js entry).

### Metrics

Pre-aggregated by Vercel, queried with `vercel metrics`, Query or the dashboard. Every query needs Observability Plus. Output of `vercel metrics … --json` for 2026-10-25 (Captured: `metrics-*.json`):

```
$ vercel metrics vercel.function_invocation.count --group-by functionStartType --since 1d --json
hot 31,939 · cold 460 · prewarmed 81            (2026-10-25 and 26, 1.4% cold)

$ vercel metrics vercel.function_invocation.function_cpu_time_ms --aggregation avg --group-by route
/api/ops 1,053.3 ms · / 387.1 ms · /.well-known/workflow/v1/flow 61.2 ms · /api/synthetic 19.6 ms

$ vercel metrics vercel.function_invocation.cpu_throttle_percent --aggregation avg --group-by route
/ 24.5 % · /api/synthetic 11.6 % · /api/ops 11.0 % · /.well-known/workflow/v1/flow 6.7 %

$ vercel metrics vercel.function_invocation.count --group-by functionRegion --group-by edgeNetworkRegion
dub1←dub1 19,804 · dub1←iad1 1,464 · iad1←iad1 1,032 · dub1←fra1 144 · dub1←lhr1 144
```

Response shape: `query` (metric, aggregation, groupBy, time range, granularity), `summary` (one row per group for the whole range) and `data` (one row per group per time bucket). Column names are `<metric with dots as underscores>_<aggregation>`, such as `vercel_function_invocation_function_duration_ms_avg`.

Middleware invocations write report lines with `source: lambda` like any function, but Vercel counts them under `vercel.middleware_invocation.*`, not under `function_invocation`. Exclude them with `"proxy.pathType" = 'middleware'`, not by `path`: on 2026-10-23, 61 page-function report lines arrived with the middleware's `path` and 3 middleware lines with `path: /`, while `proxy.pathType` matched `vercel.middleware_invocation.count` exactly (5,095). See the Routing Middleware entry. `errorCode` was empty for every invocation that day, because none failed.

## 3. Extras beyond the default

| Extra | What it adds | Cost |
| --- | --- | --- |
| Observability Plus | Querying the `vercel.function_invocation.*` metrics (percentiles, Active CPU, CPU throttle, memory, start type, TTFB), 30-day retention, alerts. After enabling it, the previous day's data was queryable at once | $1.20 per 1M events (Documented). Without it, `vercel metrics` refuses every function query, even counts: `payment_required: Observability Plus is required for this query` (Observed, CLI 65.2.0) |
| `@vercel/otel` in `instrumentation.ts` | Framework spans under `Invoke Function`; `fetch` spans for outgoing calls; `traceparent` on calls to `propagateContextUrls` | None from the package; spans count as Drains Volume when drained and as span units when Vercel Tracing collects them ($0.50 per 1M on Pro, Documented) |
| Structured logging | One JSON object per `console.log` line keeps fields queryable after the drain (`{"msg":"synthetic run","free":0,"premium":1,…}` in `log-app-stdout.json`) | None |
| `metric()` from `@vercel/functions` | Custom metrics next to the platform ones | Counts as Observability Plus events; no drain (see the Custom Metrics entry) |

## 4. Getting it out

| Signal | Exit path | Tested configuration |
| --- | --- | --- |
| Logs | Log drain, schema `log` v1, delivery `http`, encoding `ndjson` | Drain `petclinic-agent-logs`: one project, no source filter, so it carries all sources (`lambda`, `static`, `external`, `build`, `redirect`, `firewall`) |
| Traces | Trace drain, schema `trace` v1, delivery `otlphttp`, encoding `proto` | Drain `petclinic-agent-traces`: endpoint `…/v1/traces`, no sampling rules (forwards everything) |
| Traces from your code | Either the trace drain (with `@vercel/otel`) or an OTLP exporter in your code, **not both** | See below |
| Duration, peak memory, invocation count | Log drain: parse the report line | Matches the metrics exactly (section 2) |
| New instance started (cold or pre-warmed) | Log drain: `Init Duration` in the report line | Close to the metric, not exact (section 2) |
| Active CPU, CPU throttle, cold vs pre-warmed, TTFB | None. Pull with `vercel metrics --json` (Plus) on a schedule and send the result on | |

The lab's drains, as the Vercel API returns them (`GET /v1/drains`, secrets removed):

```json
{ "name": "petclinic-agent-logs",
  "projectIds": ["prj_b3WTvq01Qtd6lK3zThoF2COD7prM"],
  "schemas": { "log": { "version": "v1" } },
  "delivery": { "type": "http", "endpoint": "<your endpoint>", "encoding": "ndjson", "compression": "none" } }

{ "name": "petclinic-agent-traces",
  "projectIds": ["prj_b3WTvq01Qtd6lK3zThoF2COD7prM"],
  "schemas": { "trace": { "version": "v1" } },
  "delivery": { "type": "otlphttp", "endpoint": { "traces": "<your endpoint>/v1/traces" }, "encoding": "proto" } }
```

**Send each span once.** Spans created inside the function can leave twice: through the trace drain and through an OTLP exporter your code configures. In the lab, the eve agent exports with `OTLPTraceExporter` and the project also has a trace drain; the same span IDs arrive through both, about 290,000 duplicate spans a day (Observed 2026-10-26). Pick one path per service. The trace drain is the only way to get Vercel's infrastructure spans, so the usual split is: trace drain for everything, no exporter in code; or exporter in code and accept that the infrastructure spans stay in Vercel.

**The trace drain is not complete for every kind of request.** Requests that arrive without trace context came through in full: on 2026-10-25, 1,440 of 1,440 cron requests to `/api/synthetic` had their traces in the drain, and the Next.js app's spans matched the direct export (8,617 against 8,623). Function invocations triggered by Vercel Queues (Workflow deliveries to `/.well-known/workflow/v1/flow`) did not: 17,482 traces in the drain for 20,836 invocations (84%), missing in every hour of the day (13–29% per hour), while the direct export had spans for all 20,836 (Observed). Neither the drain configuration (no sampling rules) nor the trace flags explain the gap. For queue-triggered work, the exporter in code was the complete path. The question is with Vercel; still the case on 2026-11-12 (docs and releases checked, no answer and no change that addresses it).

**Tracing and the trace drain sample separately.** Since GA on 2026-11-06, Vercel Tracing and trace drains have separate sampling rules. With no rules, tracing collects nothing while a drain forwards all traces; with rules, each collects only what its own rules match (Documented, Tracing › Sampling). So the Traces page and `vercel traces search` can hold fewer (or more) traces than the drain delivered. An inbound `traceparent` marked not-sampled drops the trace whatever the rules say (Documented, Instrumentation › Sampling behavior).

Drain delivery behaviour (batching, retries, signatures, failed deliveries) is the same for every drain and is covered in the Drains entry.

## 5. In Bronto

| Data | Dataset | Field names |
| --- | --- | --- |
| Log drain | `petclinic-agent/vercel-logs` (with the Marketplace connector: collection = project name, dataset `log`) | As in the payload: `source`, `level`, `path`; nested with dots and double quotes: `"proxy.region"` |
| Trace drain | `.traces/vercel-traces` | Attributes with a `$` prefix: `"$http.route"`, `"$service.name"`, `$trace_id` |

Queries, each run against the lab's last 7 days on 2026-10-26:

| Question | Query | Group by | Result |
| --- | --- | --- | --- |
| Which routes hit their time limit? | `source = 'lambda' AND message LIKE 'Vercel Runtime Timeout Error%'` | `path` | `/eve/v1/session/[sessionId]/stream` 23,039 · `/api/synthetic` 11 |
| Which routes crashed? | `source = 'lambda' AND message LIKE 'Node.js process exited with exit status%'` | `path` | `/api/chaos` 2 · `/.well-known/workflow/v1/flow` 1 |
| Which routes returned 5xx? | `source = 'lambda' AND statusCode >= 500` | `path` | `/api/chaos` 12 · `/api/synthetic` 11 |
| Errors per deployment | `source = 'lambda' AND level = 'error'` | `deploymentId` | top deployment 16,188 |
| Unhandled promise rejections | `source = 'lambda' AND (message LIKE 'Unhandled Rejection%' OR message LIKE '%unhandledRejection%')` | `path` | `/.well-known/workflow/v1/flow` 2 |
| Requests served from another region | `source = 'lambda' AND "proxy.region" != executionRegion` | `proxy.region`, `executionRegion` | `iad1 → dub1` 13,836 · `fra1 → dub1` 1,164 |

The timeout query and the 5xx query answer different questions: the 23,039 stream timeouts don't appear among the 5xx at all (see Gotchas).

A log record's `traceId` is the `$trace_id` of its trace in `.traces/vercel-traces`.

Templates: the "Vercel Overview" dashboard (requests, status codes, Lambda crashes, top error paths) and the monitors "5xx Error Rate Spike", "Lambda Error Spike" and "Lambda Crash" bind to the log drain dataset. "Lambda Error Spike" counts `level = 'error'`, so it catches timeouts.

## Gotchas

1. **Streaming timeouts have no status code.** A streaming response has sent `200` before the time limit hits. The timeout record has no `statusCode`, and the edge span has no `http.response.status_code` (21,174 such spans on the stream route in 14 days). Alert on the timeout message or on `level = 'error'`, not on 5xx (Captured: `log-timeout-streaming.json`).
2. **A crash logs at `info`.** `Node.js process exited with exit status: 1` arrives as `type: stderr`, `level: info`, and the request returns a normal `500` with no `statusCode: -1` (Captured: `log-crash-exit.json`).
3. **`path` is the route pattern.** `/eve/v1/session/[sessionId]/stream`, while `proxy.path` is the real URL. Group by `path` for per-route numbers.
4. **One request, several records.** Each line repeats the full request context, so counting records counts lines, not requests. Count report lines (`message LIKE 'START%'`) or distinct `requestId` for requests.
5. **Function region and edge region differ.** `executionRegion` is where the code ran, `proxy.region` where the request entered. A cron job enters in `iad1` even when the function is pinned to `dub1`.
6. **Unhandled rejections log at `info`.** Both forms (`Unhandled Rejection: …` from the runtime, `⨯ unhandledRejection: …` from Next.js) arrive as `level: info`, the Next.js one even on `stdout`. A `level = 'error'` alert misses them; match the text.

## Samples

| File | What it shows |
| --- | --- |
| [`log-report-line.json`](../samples/functions/log-report-line.json) | Invocation report line: duration, billed duration, memory |
| [`log-report-500.json`](../samples/functions/log-report-500.json) | Report line of a 500: `type: stderr`, `level: error` |
| [`log-app-stdout.json`](../samples/functions/log-app-stdout.json) | A JSON line from `console.log` in a cron route |
| [`log-stderr-error.json`](../samples/functions/log-stderr-error.json) | An error with a stack trace from a library (`console.error`) |
| [`log-timeout-streaming.json`](../samples/functions/log-timeout-streaming.json) | Timeout of a streaming route, no `statusCode` |
| [`log-crash-exit.json`](../samples/functions/log-crash-exit.json) | `process.exit(1)`: `level: info`, no `statusCode` |
| [`span-edge-network.json`](../samples/functions/span-edge-network.json) | Root span of a request (edge network) |
| [`span-invoke-function.json`](../samples/functions/span-invoke-function.json) | The `Invoke Function` span |
| [`span-wait-until.json`](../samples/functions/span-wait-until.json) | A `waitUntil` span |
| [`trace-request.ndjson`](../samples/functions/trace-request.ndjson) | All 12 spans of one cron request |
| [`metrics-start-type.json`](../samples/functions/metrics-start-type.json) | Invocations by start type (hot, cold, prewarmed) |
| [`metrics-dur-avg-route.json`](../samples/functions/metrics-dur-avg-route.json) | Average duration per route |
| [`metrics-mem-max-route.json`](../samples/functions/metrics-mem-max-route.json) | Peak memory per route |
| [`metrics-cpu-avg-route.json`](../samples/functions/metrics-cpu-avg-route.json) | Active CPU time per route |
| [`metrics-throttle.json`](../samples/functions/metrics-throttle.json) | CPU throttle per route |
| [`metrics-region.json`](../samples/functions/metrics-region.json) | Invocations by function region and edge region |

## Sources

- Vercel docs, read 2026-10-16 to 2026-10-20: [Log Drains reference](https://vercel.com/docs/drains/reference/logs), [Trace Drains reference](https://vercel.com/docs/drains/reference/traces), [Runtime Logs](https://vercel.com/docs/logs/runtime), [Observability Plus](https://vercel.com/docs/observability/observability-plus), [`vercel metrics`](https://vercel.com/docs/cli/metrics).
- Docs, read 2026-11-12: [Vercel Tracing is now generally available](https://vercel.com/changelog/vercel-tracing-is-now-generally-available) (2026-11-06), [Tracing](https://vercel.com/docs/tracing), [Configuring Tracing](https://vercel.com/docs/tracing/configure-tracing) and [Instrumentation](https://vercel.com/docs/tracing/instrumentation) (all last updated 2026-11-03; retention, sampling rules, span units, default tracing, Vercel's own `fetch` spans), [`vercel traces`](https://vercel.com/docs/cli/traces) (last updated 2026-11-03), [Trace Drains reference](https://vercel.com/docs/drains/reference/traces) (last updated 2026-08-21), [Runtime Logs](https://vercel.com/docs/logs/runtime) (last updated 2026-08-28; log retention unchanged).
- Lab: Bronto EU datasets `petclinic-agent/vercel-logs` and `.traces/vercel-traces`, 2026-10-12 to 2026-10-26; Vercel CLI 65.2.0 (`vercel metrics schema`, `vercel metrics`); Vercel REST API `GET /v1/drains`.
