# Routing Middleware

> Every middleware invocation writes one invocation report line to the log drain as `source: lambda`, with `proxy.pathType: middleware`, the requested URL in `proxy.path`, and duration, peak memory and (on a new instance) `Init Duration` as text. Counting records with `proxy.pathType = 'middleware'` reproduces Vercel's `vercel.middleware_invocation.count` exactly. The trace drain adds an `Invoke Middleware` span under `Resolve Route` for every traced request, with the Next.js `middleware GET` span inside it when `@vercel/otel` is registered. Active CPU, TTFB, start type and the middleware action (`next`, rewrite, redirect) exist only as metrics inside Vercel. The trap: a Next.js `proxy.ts` without a `matcher` runs on every static asset request, cache hits included; in the lab that was 68% of all middleware runs.

| | |
| --- | --- |
| Kind | Platform service (Routing Middleware on Fluid Compute; Next.js `proxy.ts`/`middleware.ts` or the framework-neutral `middleware.ts`) |
| Plans | Logs and traces on all plans in the dashboard; drains need Pro or Enterprise; metrics queries need Observability Plus |
| Signals | Logs · Traces · Metrics (inside Vercel only) |
| Exit paths | Log drain (`source: lambda`) · Trace drain |
| Verified | 2026-10-26 · Vercel CLI 65.2.0 · Next.js 16.3.6 (`proxy.ts`, Node.js runtime `nodejs24.x`) · `@vercel/otel` 2.1.3 · lab project `petclinic-agent` |

## 1. What it emits

| Signal | What | Where it lives | Retention |
| --- | --- | --- | --- |
| Logs | One invocation report line per middleware run; `console.*` output from your middleware code (the lab's middleware logs nothing) | Runtime Logs ("Middleware" panel), `vercel logs` | As for functions: Hobby 1 h, Pro 1 day, Enterprise 3 days, Plus 30 days (Documented) |
| Traces | `Invoke Middleware` (`vercel.serverless-runtime`) with `waitUntil` and, on a new instance, `Start VM`, `Spawn Node.js`, `Init User Code`; framework span `middleware GET` with `@vercel/otel` | Observability › Tracing, trace drain | As for logs (Documented) |
| Metrics | `vercel.middleware_invocation.*`: `count`, `request_duration_ms`, `function_cpu_time_ms`, `ttfb_ms`, `function_duration_gbhr`, Fast Origin Transfer in, out, total | Observability › Middleware, Query, `vercel metrics` | Hobby 12 h, Pro 1 day, Enterprise 3 days, Plus 30 days (Documented) |

The middleware metrics have 20 dimensions, among them `route`, `requestPath`, `middlewareAction`, `middlewareActionTarget`, `functionStartType`, `functionRegion`, `edgeNetworkRegion`, `runtime`, `httpStatus` and `errorCode` ([`reference/vercel-metrics-schema.json`](../reference/vercel-metrics-schema.json)).

## 2. Out-of-the-box shape

### Log records

A middleware run is a function invocation, so its record has the shape described in the [Functions entry](functions.md): same fields, same report line. What identifies it (Captured: `log-middleware-report.json`):

| Field | Value on middleware records | Note |
| --- | --- | --- |
| `source` | `lambda` | Vercel documents `edgeType: middleware` and `type: middleware-invocation` for middleware; neither appeared in 74,790 middleware records (Observed). `type` is `stdout` |
| `proxy.pathType` | `middleware` | The reliable marker (see Gotchas) |
| `path` | `/services/web/_middleware` | The middleware's function name. In the lab the `services` layout puts the service name in it (`/services/<service>/_middleware`) |
| `proxy.path` | `/vets`, `/_next/static/chunks/0g6yb_hyes7e_.js?` | The URL the middleware ran for |
| `executionRegion`, `proxy.region`, `proxy.lambdaRegion` | `sfo1`, `sfo1`, `sfo1` | Middleware runs in the edge region that received the request, not in the function region (see below) |
| `statusCode`, `proxy.statusCode` | `200` | 200 on all 74,790 records, including the static-asset 404s the middleware ran in front of |
| `proxy.vercelCache` | `MISS` | Always `MISS`; middleware runs before the cache |
| `traceId`, `spanId` | | Present except on runs for static assets |
| `invocationId`, `instanceId` | | As on function records |

The `message` is the report line. `[GET] <url> status=200` names the request URL, not the middleware:

```
START RequestId: 76bb9be6-ca2b-4895-8b4b-708386fb136c
[GET] /vets status=200
END RequestId: 76bb9be6-ca2b-4895-8b4b-708386fb136c
REPORT RequestId: 76bb9be6-ca2b-4895-8b4b-708386fb136c Duration: 18 ms Billed Duration: 18 ms Memory Size: 2048 MB Max Memory Used: 252 MB
```

On an invocation that started a new instance the REPORT line ends with `Init Duration: 368 ms` (Captured: `log-middleware-cold-start.json`; the matching spans of a cold start are in `trace-middleware-cold-start.ndjson`). The count of `Init Duration` lines tracks cold plus pre-warmed starts but does not equal it: 305 lines against 297 cold + 10 pre-warmed on 2026-10-25, 477 against 429 + 119 on 2026-10-23 (Observed).

A request that runs middleware produces one middleware record plus the records of whatever serves it: for a stale ISR page that is a `static` record and a `background_func` revalidation record, all sharing one `requestId` (see the [CDN entry](cdn.md)).

### Which requests run middleware

| Request | Middleware runs? | Evidence |
| --- | --- | --- |
| Pages, API routes, ISR pages (HIT and STALE) | Yes | Observed |
| Static assets (`/_next/static/…`), cache hits included | Yes, without a `matcher` | 51,102 middleware records on `/_next/static/` paths against 51,193 `source: static` STATIC records in 14 days (Observed). Captured: `log-middleware-static-asset.json` |
| External rewrites (`/petclinic-openapi.yml`) | Yes | 521 middleware records = 521 `external` records (Observed) |
| Redirects from `next.config.ts` (`/clinic`) | No | 0 middleware records for 1,552 redirects (Observed) |
| eve's own service (`/eve/...`) | No | The middleware belongs to the `web` service |

### Region

Middleware runs where the request entered. On 2026-10-23 `functionRegion` equalled `edgeNetworkRegion` for every invocation: `dub1` 2,721, `iad1` 1,548, `sfo1` 428, `fra1` 162, `lhr1` 160 (Captured: `metrics-mw-region.json`), although the project's functions are pinned to `dub1`. Low-traffic regions start new instances often. Report lines with `Init Duration` over 7 days, by region (Observed):

| Region | Middleware runs | With `Init Duration` |
| --- | --- | --- |
| `dub1` | 59,339 | 761 (1.3%) |
| `iad1` | 9,689 | 266 (2.7%) |
| `fra1` | 2,450 | 709 (29%) |
| `sfo1` | 2,234 | 944 (42%) |
| `lhr1` | 807 | 348 (43%) |

### Spans

A cache hit on the ISR page `/vets` (Captured: `../cdn/trace-prerender-hit.ndjson`):

```
GET /vets                          vercel.edge-network        136.8 ms
├─ Resolve Deployment              vercel.edge-network          6.5 ms
└─ Resolve Route                   vercel.edge-network         29.5 ms
   └─ Invoke Middleware            vercel.serverless-runtime   14.8 ms
      ├─ middleware GET            petclinic-web (Next.js)      1.0 ms
      └─ waitUntil                 vercel.serverless-runtime   10.3 ms
```

A run on a new instance adds `Start VM` (241 ms), `Spawn Node.js` (180 ms) and `Init User Code` (140 ms) under `Invoke Middleware`, here 849 ms in total (Captured: `trace-middleware-cold-start.ndjson`, a Checkly check of `/`).

- `Invoke Middleware` carries only IDs (`vercel.deploymentId`, `vercel.projectId`, owner): no route, URL, region, action or start type (Captured: `span-invoke-middleware.json`). Its parent `Resolve Route` and the root span carry the request.
- The Next.js span `middleware GET` (`next.span_type: Middleware.execute`) carries `http.target`, `http.user_agent`, `vercel.region`, `vercel.edge_region` and `vercel.request_id` (Captured: `span-middleware-nextjs.json`).
- Over 7 days: 23,687 `Invoke Middleware` spans, p50 50.3 ms, p95 571.4 ms, max 600 s; the Next.js middleware code inside them took 0.27 ms at p50 (Observed). Most of the span is `waitUntil` and instance start-up, not the middleware function.
- Runs for static assets have no trace: on 2026-10-23 there were 4,604 `Invoke Middleware` spans for 5,095 invocations, and the 494 runs on `/_next/static/` paths carry no `traceId` (Observed).
- Spans are `STATUS_CODE_UNSET`, as for functions.

### Metrics

Every query needs Observability Plus. 2026-10-23 (UTC), the last full day of synthetic traffic (Captured: `metrics-mw-*.json`):

```
$ vercel metrics vercel.middleware_invocation.count --group-by middlewareAction --group-by pathType
next / middleware 5,095

$ vercel metrics vercel.middleware_invocation.count --group-by functionStartType
hot 4,547 · cold 429 · prewarmed 119

$ vercel metrics vercel.middleware_invocation.request_duration_ms --aggregation avg   → 220.0 ms   (p95 1,130.5 ms)
$ vercel metrics vercel.middleware_invocation.function_cpu_time_ms --aggregation avg  → 65.9 ms
$ vercel metrics vercel.middleware_invocation.ttfb_ms --aggregation avg               → 116.4 ms
$ vercel metrics vercel.middleware_invocation.function_duration_gbhr --aggregation sum → 0.6 GB-h

$ vercel metrics vercel.middleware_invocation.count --group-by requestPath
/ 1,629 · /api/synthetic 1,440 · /vets 1,316 · /petclinic-openapi.yml 124 · /api/visit-note 44 · …
```

The log drain matches the count exactly: 5,095 records with `proxy.pathType = 'middleware'` that day (Observed). `middlewareAction` was `next` for every invocation because the lab's middleware only passes requests on; rewrites and redirects from middleware: Not observed.

## 3. Extras beyond the default

| Extra | What it adds | Cost |
| --- | --- | --- |
| `@vercel/otel` in `instrumentation.ts` | The `middleware GET` span inside `Invoke Middleware`, with URL, user agent and region | None; spans are billed as trace drain volume when drained |
| A `matcher` in `proxy.ts` / `middleware.ts` | Limits which paths run middleware. Next.js documents a negative-lookahead matcher that skips `_next/static`, `_next/image` and `favicon.ico` (Documented). Not tested in the lab | Fewer middleware invocations, each one an Observability Plus event and Fluid Compute usage |
| `console.log` in middleware | Your own records, `source: lambda`, same `path` as the report line. Log the decision (rewrite target, redirect, auth result) as JSON: the action is otherwise only in the `middlewareAction` metric | None |
| Observability Plus | Querying `vercel.middleware_invocation.*` (action, action target, start type, CPU, TTFB) | $1.20 per 1M events (Documented) |

## 4. Getting it out

| Signal | Exit path | Tested configuration |
| --- | --- | --- |
| Logs (report lines, your output) | Log drain, `source: lambda` | Drain `petclinic-agent-logs` (configuration in the [Functions entry](functions.md#4-getting-it-out)) |
| Duration, peak memory, new-instance starts | Log drain: parse the report line | Count matches the metric exactly; `Init Duration` approximates cold + pre-warmed starts |
| Spans | Trace drain | Drain `petclinic-agent-traces` |
| Active CPU, TTFB, start type, middleware action and target | None. Pull with `vercel metrics --json` (Plus) on a schedule | |

## 5. In Bronto

| Data | Dataset | Field names |
| --- | --- | --- |
| Log drain | `petclinic-agent/vercel-logs` | `"proxy.pathType"`, `"proxy.path"`, `executionRegion`, `message` |
| Trace drain | `.traces/vercel-traces` | `"$span.name"`, `"$span.duration_nano"`, `"$vercel.request_id"` |

Queries, each run against the lab's last 7 days on 2026-10-26:

| Question | Query | Group by | Result |
| --- | --- | --- | --- |
| How often does middleware run? | `"proxy.pathType" = 'middleware'` | `"proxy.host"` | 74,790 in total; `petclinic-agent.vercel.app` 63,809 |
| Does middleware run on static assets? | `"proxy.pathType" = 'middleware' AND "proxy.path" LIKE '/_next/static/%'` | | 51,102 (68% of all runs) |
| Where does it run? | `"proxy.pathType" = 'middleware'` | `executionRegion` | `dub1` 59,339 · `iad1` 9,689 · `fra1` 2,450 · `sfo1` 2,234 · `lhr1` 807 |
| Where does it start new instances? | `"proxy.pathType" = 'middleware' AND message LIKE '%Init Duration%'` | `executionRegion` | `sfo1` 944 · `dub1` 761 · `fra1` 709 · `lhr1` 348 · `iad1` 266 |
| Middleware errors | `"proxy.pathType" = 'middleware' AND (level != 'info' OR statusCode >= 400)` | `level`, `statusCode` | none |
| Middleware span latency | `"$span.name" = 'Invoke Middleware'`, select `p50("$span.duration_nano")`, `p95(…)` | | p50 50.3 ms · p95 571.4 ms |

A middleware record's `traceId` is the `$trace_id` of the request's trace; its `requestId` is the `"$vercel.request_id"` on the root span and on the `middleware GET` span.

Templates: the "Vercel Overview" dashboard counts middleware report lines among the `lambda` records; the "Lambda Error Spike" and "Lambda Crash" monitors cover middleware failures because they arrive as `source: lambda`.

## Gotchas

1. **Count middleware by `proxy.pathType`, not by `path`.** Vercel sometimes writes a page function's report line with the middleware's `path`, and a middleware report line with the page's `path`. On 2026-10-23, 61 function report lines for `/` arrived with `path: /services/web/_middleware` (`proxy.pathType: streaming_func`, durations up to 212 ms), and 3 middleware report lines arrived with `path: /` (`proxy.pathType: middleware`). `proxy.pathType = 'middleware'` gave 5,095, the metric's number; `path = '/services/web/_middleware'` gave 5,153 (Captured: `log-function-report-middleware-path.json`). For function counts, exclude `proxy.pathType = 'middleware'` rather than the middleware's path.
2. **No matcher, middleware on every asset.** Without a `matcher`, Next.js `proxy.ts` runs in front of every `/_next/static` file, even when the CDN serves it from cache. Each run is a billed invocation and an Observability Plus event (Observed: 51,102 of 74,790 runs).
3. **Middleware is not pinned to your function region.** It runs in the edge region of the request, so a project pinned to `dub1` runs middleware in `sfo1`, `fra1`, `lhr1` and elsewhere, where instances are colder (42% of `sfo1` runs started a new instance).
4. **The documented middleware fields don't arrive.** No `edgeType`, no `type: middleware-invocation`, no `middleware` type in 74,790 records; Node.js middleware looks like any function report line.
5. **`statusCode: 200` says nothing about the response.** The middleware record's status is the middleware's own result. A static asset that returned 404 had a middleware record with `status=200` (Captured: `log-middleware-cold-start.json` and its `static` record `../cdn/log-static-404.json`, same `requestId`).
6. **Static-asset runs are invisible in traces.** They have no `traceId` and no `Invoke Middleware` span, so trace-based counts undercount middleware by the static-asset share.

## Samples

| File | What it shows |
| --- | --- |
| [`log-middleware-report.json`](../samples/routing-middleware/log-middleware-report.json) | Middleware report line for a request to the ISR page `/vets` |
| [`log-middleware-static-asset.json`](../samples/routing-middleware/log-middleware-static-asset.json) | Middleware run in front of a cached `/_next/static` chunk, no `traceId` |
| [`log-middleware-cold-start.json`](../samples/routing-middleware/log-middleware-cold-start.json) | Report line with `Init Duration` (new instance), in front of a static-asset 404 |
| [`log-function-report-middleware-path.json`](../samples/routing-middleware/log-function-report-middleware-path.json) | A page function's report line carrying the middleware's `path` |
| [`span-invoke-middleware.json`](../samples/routing-middleware/span-invoke-middleware.json) | The `Invoke Middleware` span |
| [`span-middleware-nextjs.json`](../samples/routing-middleware/span-middleware-nextjs.json) | The Next.js `middleware GET` span from `@vercel/otel` |
| [`trace-middleware-cold-start.ndjson`](../samples/routing-middleware/trace-middleware-cold-start.ndjson) | A request whose middleware started a new instance (`Start VM`, `Spawn Node.js`, `Init User Code`) |
| [`metrics-mw-action.json`](../samples/routing-middleware/metrics-mw-action.json) | Invocations by action and path type |
| [`metrics-mw-region.json`](../samples/routing-middleware/metrics-mw-region.json) | Invocations by function region and edge region |
| [`metrics-mw-start-type.json`](../samples/routing-middleware/metrics-mw-start-type.json) | Invocations by start type |
| [`metrics-mw-duration-avg.json`](../samples/routing-middleware/metrics-mw-duration-avg.json), [`metrics-mw-duration-p95.json`](../samples/routing-middleware/metrics-mw-duration-p95.json) | Request duration, average and p95 |
| [`metrics-mw-cpu-avg.json`](../samples/routing-middleware/metrics-mw-cpu-avg.json) | Active CPU time |
| [`metrics-mw-request-path.json`](../samples/routing-middleware/metrics-mw-request-path.json) | Invocations by request path |

## Sources

- Vercel docs, read 2026-10-26: [Log Drains reference](https://vercel.com/docs/drains/reference/logs) (last updated 2026-09-11), [Routing Middleware](https://vercel.com/docs/routing-middleware), [`vercel metrics`](https://vercel.com/docs/cli/metrics); Next.js `proxy.ts` matcher: [Next.js docs](https://nextjs.org/docs/app/api-reference/file-conventions/proxy).
- Lab: `apps/web/proxy.ts` (no `matcher`), `apps/web/instrumentation.ts`; Bronto EU datasets `petclinic-agent/vercel-logs` and `.traces/vercel-traces`, 2026-10-18 to 2026-10-26; Vercel CLI 65.2.0 `vercel metrics` for 2026-10-23 and 2026-10-25.
