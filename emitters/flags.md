# Vercel Flags and the Flags SDK

> Flags produce three kinds of telemetry, and each leaves Vercel by a different path. The Flags SDK writes a `flag` span per evaluation (`key`, `method`) once `instrumentation.ts` hands it a tracer provider, and the span leaves through the trace drain. The flag's value reaches Web Analytics when the page renders `<FlagValues>`: every page view and custom event on that page carries a `flags` field (`"{\"lab-flag\":true}"`) in the Web Analytics drain. Vercel Flags also counts evaluations per variant, reason and environment (`vercel flags evaluations`) and bills each request that reads flag configuration as a `Flag Requests` line per project; in the lab, 33 requests gave 33 evaluations and 33 billed flag requests. Flag changes are announced through `flag.*` webhooks. What people get wrong: the span names the flag but not its value, and the server logs carry neither, so the only per-request record of which variant someone got is the browser's analytics event. Server-side work can't be joined to a variant from drained data unless your code logs it.

| | |
| --- | --- |
| Kind | Platform service (Vercel Flags) and libraries (`flags`, `@flags-sdk/vercel`, `@vercel/flags-core`) |
| Plans | All plans; drains need Pro or Enterprise; Web Analytics flags integration is Beta on all plans (Documented) |
| Signals | Traces (`flag` span) · Events (flag values on Web Analytics records; `flag.*` webhooks) · Metrics (evaluation counts, inside Vercel) · Other: billing records |
| Exit paths | Trace drain · Web Analytics drain (`analytics` v2) · Webhook · CLI/API (`vercel flags evaluations --json`, `GET /v1/billing/charges`) |
| Verified | 2026-10-27 · Vercel CLI 65.2.0 · `flags` 4.4.0 · `@flags-sdk/vercel` 1.5.3 · `@vercel/flags-core` 1.10.2 · `@vercel/analytics` 2.0.1 · `@vercel/otel` 2.1.3 · lab project `vercel-observability-lab` |

## 1. What it emits

| Signal | What | Where it lives | Retention |
| --- | --- | --- | --- |
| Traces | `flag` span per evaluation (`key`, `method`); `identify`, `decide`, `run`, `batch` spans in some paths (from source) | Trace drain, when the SDK has a tracer provider | As for Functions |
| Events | Flag values on Web Analytics page views and custom events (`flags` field) | Web Analytics dashboard, Web Analytics drain | As for Web Analytics |
| Metrics | Evaluation counts by variant, reason, environment, client, SDK key | Flag detail page, `vercel flags evaluations` | Up to 90 days, 1-minute granularity (Documented) |
| Metrics | `vercel.analytics.page_view.count` and `event.count` have a `flags` dimension | `vercel metrics`, Web Analytics | As for Web Analytics |
| Events | `flag.created`, `flag.updated`, `flag.deleted`, `flag.segment.created`, `flag.segment.updated`, `flag.segment.deleted` | Webhooks | Delivery retried for 24 hours (Documented) |
| Usage and cost | `Flag Requests` per project per billing day | Usage page, `GET /v1/billing/charges` | See the Billing entry |

The lab's `flags.ts` declares one boolean flag, `lab-flag`, with `vercelAdapter`. `/flags` evaluates it in a server component, renders `<FlagValues values={{ "lab-flag": enabled }} />` and a button that calls `track("Flag button clicked", {}, { flags: ["lab-flag"] })`. `instrumentation.ts` registers `@vercel/otel` and calls the SDK's `setTracerProvider(trace.getTracerProvider())`.

## 2. Out-of-the-box shape

### The `flag` span

One per evaluation, as a child of the page render (Captured: `span-flag.json`, 10 of 10 traced `/flags` requests on 2026-10-27):

| Attribute | Example | Note |
| --- | --- | --- |
| span name | `flag` | |
| `key` | `lab-flag` | The flag key. Not namespaced (`key`, not `flag.key`) |
| `method` | `decided` | `decided`, `cached` (already evaluated in this request), `override` (Flags Explorer cookie), `precomputed` (from source) |
| `span.kind` | `SPAN_KIND_INTERNAL` | |
| `span.status_code` | `STATUS_CODE_OK` | The SDK sets OK on success and ERROR on failure; Next.js control-flow errors count as OK |
| duration | 1.0 ms (avg 2.3 ms over 10) | |
| resource | `service.name: vercel-observability-lab`, `vercel.*`, `vcs.*` | From `@vercel/otel` |

There is no attribute for the value, the variant or the reason. The span tells you that `lab-flag` was evaluated and how long it took, not what it returned. In the span tree it sits under `render route (app) /flags` (Captured: `trace-request.ndjson`):

```
GET /flags                                  vercel.edge-network         73.29 ms
├─ … Resolve Deployment, Route, Cache, Route across regions
└─ Invoke Function                          vercel.serverless-runtime   18.21 ms
   ├─ GET /flags                            vercel-observability-lab    19.50 ms
   │  ├─ prepare route module                                            0.39 ms
   │  ├─ render route (app) /flags                                       5.15 ms
   │  │  ├─ build component tree                                         0.41 ms
   │  │  ├─ flag                                                         1.01 ms
   │  │  └─ start response                                               0.04 ms
   │  └─ NextNodeServer.clientComponentLoading                           1.24 ms
   └─ waitUntil                             vercel.serverless-runtime    7.76 ms
```

No `fetch` span to `flags.vercel.com` appeared in any of the 10 traces, and `vercel.external_api_request.count` listed no Flags host (Observed). From the `@vercel/flags-core` 1.10.2 source: on Vercel the client reads flag definitions from a datafile or the definitions bundled at build time (`@vercel/flags-definitions`), and hands evaluation counts to an in-process runtime hook (`globalThis[Symbol.for("@vercel/flags-context")].ingest`); it falls back to `GET https://flags.vercel.com/v1/datafile`, `/v1/stream` and `POST /v1/ingest` through the global `fetch`. The lab's traces fit the in-process paths.

Without `setTracerProvider`, the SDK creates no spans at all: it looks up a tracer under `Symbol.for("flags:global-trace")` and otherwise calls the function directly. `VERCEL_FLAGS_TRACE_VERBOSE=true` adds spans for internal steps (from source).

### Log records

`/flags` requests produced only the function's report line in the log drain, with no flag field (Captured: `log-report-line.json`; 10 records, field union checked). The SDK's `reportValue()` passes the value to Vercel's request context, and Vercel's docs say this makes the flag show up in Runtime Logs (Documented); it did not add anything to the drained log records or to `vercel logs --json` (Observed). The SDK writes its own lines only on trouble: `flags: Flag "<key>" is falling back to its defaultValue after catching the following error` (`console.warn`) and `flags: Failed to report flag override` (`console.error`) (from source; Not observed).

### Web Analytics records with flags

`<FlagValues>` renders the values into the page as `<script type="application/json" data-flag-values="true">{"lab-flag":true}</script>` (Observed in the page HTML). The Web Analytics script loads a second script (`/<prefix>/flags/script.js`, seen in the log drain as `source: external`) and adds an `f` object to its beacons (Captured: `beacon-view-flags.json`, `beacon-event-flags.json`):

```json
/view   … "dp":"/flags", "f":{"p":{"lab-flag":true},"e":[]}
/event  … "en":"Flag button clicked", "ed":{}, "f":{"k":["lab-flag"],"p":{"lab-flag":true},"e":[]}
```

`p` holds the values found on the page and `k` the keys the `track()` call named. The Web Analytics drain delivers both as ordinary records with one extra field (Captured: `analytics-pageview-with-flags.json`, `analytics-event-with-flags.json`):

| Field | Example | Note |
| --- | --- | --- |
| `flags` | `"{\"lab-flag\":true}"` | A JSON **string** of key → value, on page views and custom events of a page that renders `<FlagValues>`. Matches Vercel's schema (`string`, `{"feature_a": true}`) |
| `eventData` | absent | `track()` with `{}` sends no `eventData` |

All 6 `/flags` records in the drain (3 page views, 3 events) had `flags`; the 3 page views of `/` had none (Observed). The records are otherwise the Web Analytics shape described in the Web Analytics entry: no request ID or trace ID, so a flag value on a page view can't be joined to the `flag` span of the request that rendered the page.

### Evaluation metrics

`vercel flags evaluations lab-flag --json` for the billing day 2026-10-26 07:00 to 2026-10-27 07:00 UTC, hourly buckets (Captured: `cli-evaluations-variant-2026-10-26.json`, `cli-evaluations-reason-2026-10-26.json`):

```
--group-by variant      gcwfspZAtQoUJBneqkWZ1 (true) 33
--group-by reason       paused 33
--group-by environment  production 33
--group-by client       "" 33
--group-by sdk-key      "" 33
```

The response lists `variants` (variant ID → value) and `buckets` with `timestamp`, the group value and `evaluations`. The current bucket comes back as `"evaluations": null` until it closes (Observed). `reason: paused` is what the lab's flag reports; it has no targeting rules and was switched on with `vercel flags enable`. `client` and `sdk-key` came back empty for every evaluation in the lab, which sets no client name and no SDK key of its own. The counts come from `@vercel/flags-core` ≥ 1.6.0, which batches evaluations per flag, variant, reason and minute (`FLAG_EVALUATION` events; Documented and source).

### Analytics metrics with flags

```
$ vercel metrics vercel.analytics.page_view.count --group-by route --group-by flags --since 2026-10-27T07:00:00Z
/flags, lab-flag 3

$ vercel metrics vercel.analytics.event.count --group-by eventName --group-by flags --since 2026-10-27T07:00:00Z
Flag button clicked, lab-flag 3
```

The `flags` dimension holds the flag **key**, not its value, and grouping by it drops records without flags: the same query without `--group-by flags` returned `/ 3, /flags 3, /botid 2` (Observed; Captured: `metrics-pageview-flags.json`, `metrics-event-flags.json`). Per-value counts need the drained records.

### Usage and cost records

Billing day 2026-10-26 (Captured: `charges-2026-10-26.jsonl`):

| `ServiceName` | `ConsumedQuantity` | `EffectiveCost` | `Tags` |
| --- | --- | --- | --- |
| `Flag Requests` | 33 Requests | $0.00099 | `ProjectId`, `ProjectName: vercel-observability-lab` |

33 requests to `/flags` (`vercel.function_invocation.count`, Captured: `metrics-invocations-2026-10-26.json`), 33 evaluations and 33 billed flag requests: they agree exactly (Observed). $0.00099 for 33 is $0.03 per 1,000, the documented Pro price. A flag request is one application request that reads a project's flag configuration; ten flags evaluated in one request with one client still count once (Documented). The 4 invocations of `/.well-known/vercel/flags` that day (Flags Explorer discovery) were not billed as flag requests.

## 3. Extras beyond the default

| Extra | What it adds | Cost |
| --- | --- | --- |
| `setTracerProvider` from `flags` in `instrumentation.ts` | The `flag` span (section 2). Without it, no spans | Trace drain volume |
| `VERCEL_FLAGS_TRACE_VERBOSE=true` | Spans for internal steps (from source; not tested) | Span volume |
| `<FlagValues>` on the page | `flags` on every Web Analytics page view and client-side event of that page | None beyond the events |
| `track(name, data, { flags: [...] })` | Names which flags an event should carry (`k` in the beacon) | Web Analytics events |
| Server-side `track()` from `@vercel/analytics/server` after `reportValue()` | Flags on server-side events (Documented; Not observed) | Web Analytics events |
| Your own log line with the value | The only way to put the variant on server records | None |

Two things are worth adding by hand, because nothing records them: the evaluated value next to the `flag` span (as a log line with `traceId`, or as an attribute on the active span with the OpenTelemetry API), and the variant in your structured logs, so errors can be grouped by variant.

## 4. Getting it out

| Signal | Exit path | Tested configuration |
| --- | --- | --- |
| `flag` spans | Trace drain (schema `trace` v1, `otlphttp`) | Drain `vercel-observability-lab-traces` |
| Flag values with page views and events | Web Analytics drain (schema `analytics` v2, `http`, `ndjson`) | Drain `vercel-observability-lab-web-analytics` |
| Evaluation counts | None pushed. `vercel flags evaluations --json` on a schedule | CLI 65.2.0 |
| `vercel.analytics.*` by flag | None pushed. `vercel metrics --json` (keys only) | CLI 65.2.0 |
| Flag and segment changes | Webhooks `flag.created`, `flag.updated` (with `previousFlag` and `patch`), `flag.deleted`, `flag.segment.*` | Documented; Not observed (no webhook subscribed to these events) |
| Flag requests, cost | `GET /v1/billing/charges` once per billing day | `vercel api "/v1/billing/charges?from=2026-10-26T07:00:00Z&to=2026-10-27T07:00:00Z"` |

The `flag.updated` payload carries IDs, slug, project and timestamps plus a `patch` of changed fields (Documented); it is the event to mark on a timeline next to error rates. Configuration history is also available with `vercel flags versions` (CLI).

Records leave the browser only when the Web Analytics script sends them. In the lab, headless Chrome sent nothing while its user agent said `HeadlessChrome/156.0.0.0`, even with `navigator.webdriver` false; the same browser with a regular Chrome user agent sent every page view and event (Observed 2026-10-27). See the Web Analytics entry.

## 5. In Bronto

| Data | Dataset | Field names |
| --- | --- | --- |
| Trace drain | `.traces/vercel-observability-lab` (app spans, including `flag`) | `"$span.name"`, `"$key"`, `"$method"` |
| Web Analytics drain | `vercel-observability-lab/vercel-web-analytics` | As in the payload: `flags`, `eventType`, `eventName`, `route` |

Queries run 2026-10-27 against the lab's last 6 hours (drained data starts 08:43 UTC):

| Question | Query | Group by | Result |
| --- | --- | --- | --- |
| Flag evaluations by key and method | `"$span.name" = 'flag'` | `"$key"`, `"$method"` | `lab-flag, decided` 10 |
| Evaluation time | `"$span.name" = 'flag'`, `avg("$span.duration_nano")` | `"$span.name"` | 2.35 ms over 10 spans |
| Page views and events by flag values | `flags IS NOT NULL` | `eventType`, `flags` | `event, {"lab-flag":true}` 3 · `pageview, {"lab-flag":true}` 3 |
| Events of visitors who got the flag on | `flags LIKE '%"lab-flag":true%'` | `eventType`, `eventName` | `event, Flag button clicked` 3 · `pageview` 3 |

`flags` is a string; match a value with `LIKE '%"<key>":<value>%'`. For an A/B comparison, group conversion events by `flags` and divide by page views with the same `flags`.

## Gotchas

1. **The span has no value.** `flag` carries `key` and `method`; which variant the request got is not on the span, in the function logs or in `vercel logs` (Observed). Log it yourself if server-side errors need to be split by variant.
2. **No spans without the hook.** The Flags SDK only traces after `setTracerProvider()`; registering `@vercel/otel` alone is not enough (from source; the lab calls it).
3. **`flags` is a JSON string.** In the drain it is `"{\"lab-flag\":true}"`, like `eventData` and `queryParams` (Captured).
4. **The `flags` metric dimension is keys only and drops the rest.** `--group-by flags` returns `lab-flag`, not `true`/`false`, and leaves out page views without flags (Observed).
5. **Page views carry flags only where `<FlagValues>` renders.** The analytics script reads values from the DOM; pages without the component send no `flags` (Observed: `/` had none). The values are public in the page source unless encrypted, and encrypted values can make an event exceed size limits and arrive without flags (Documented).
6. **Flag requests are per request, not per evaluation.** 33 requests evaluating one flag = 33 flag requests; 10 flags in one request = 1 (Observed and Documented). Separate Flags clients count separately (Documented).
7. **The current evaluation bucket is `null`.** `vercel flags evaluations --json` returns `"evaluations": null` for the bucket still open; treat it as missing, not 0 (Observed).
8. **Headless browsers need a normal user agent too.** With `navigator.webdriver` off but a `HeadlessChrome` user agent, the analytics script sent no beacons, so flag values from synthetic checks never arrive (Observed 2026-10-27).

## Samples

| File | What it shows |
| --- | --- |
| [`span-flag.json`](../samples/flags/span-flag.json) | A `flag` span: `key`, `method`, status OK, no value |
| [`trace-request.ndjson`](../samples/flags/trace-request.ndjson) | All spans of one `/flags` request, `flag` under the render span |
| [`log-report-line.json`](../samples/flags/log-report-line.json) | The only log record of a `/flags` request: no flag field |
| [`analytics-pageview-with-flags.json`](../samples/flags/analytics-pageview-with-flags.json) | A Web Analytics drain page view with `flags` |
| [`analytics-event-with-flags.json`](../samples/flags/analytics-event-with-flags.json) | A custom event (`Flag button clicked`) with `flags`, no `eventData` |
| [`beacon-view-flags.json`](../samples/flags/beacon-view-flags.json) | The `/view` beacon body as the browser sent it (`f.p`) |
| [`beacon-event-flags.json`](../samples/flags/beacon-event-flags.json) | The `/event` beacon body (`f.k`, `f.p`) |
| [`cli-evaluations-variant-2026-10-26.json`](../samples/flags/cli-evaluations-variant-2026-10-26.json) | `vercel flags evaluations --group-by variant --json` for one billing day |
| [`cli-evaluations-reason-2026-10-26.json`](../samples/flags/cli-evaluations-reason-2026-10-26.json) | The same, by reason (`paused`) |
| [`metrics-pageview-flags.json`](../samples/flags/metrics-pageview-flags.json) | `vercel.analytics.page_view.count` by route and `flags` |
| [`metrics-event-flags.json`](../samples/flags/metrics-event-flags.json) | `vercel.analytics.event.count` by event name and `flags` |
| [`metrics-invocations-2026-10-26.json`](../samples/flags/metrics-invocations-2026-10-26.json) | Invocations per route for the billing day (33 on `/flags`) |
| [`charges-2026-10-26.jsonl`](../samples/flags/charges-2026-10-26.jsonl) | The `Flag Requests` billing line, per project |

## Sources

- Vercel docs, read 2026-10-27: [Vercel Flags](https://vercel.com/docs/flags/vercel-flags) (last updated 2026-07-15), [Flag Evaluation Metrics](https://vercel.com/docs/flags/vercel-flags/evaluation-metrics) (2026-07-15), [Limits and Pricing for Vercel Flags](https://vercel.com/docs/flags/vercel-flags/limits-and-pricing) (2026-08-26), [Flags observability](https://vercel.com/docs/flags/observability) (2026-09-15), [Integrate flags with Web Analytics](https://vercel.com/docs/flags/observability/web-analytics) (2026-08-11), [Web Analytics Drains reference](https://vercel.com/docs/drains/reference/analytics) (2026-07-03), [Webhooks API reference](https://vercel.com/docs/webhooks/webhooks-api) (2026-09-17).
- Source: `flags` 4.4.0 (`dist/chunk-XASPEQRL.js` tracing and `reportValue`, `dist/next.js` `flag()` wrapper), `@vercel/flags-core` 1.10.2 (`dist/chunk-LGS6CVED.js`: datafile, stream, ingest, usage tracker).
- Lab: Bronto EU datasets `.traces/vercel-observability-lab`, `vercel-observability-lab/vercel-logs` and `vercel-observability-lab/vercel-web-analytics`, 2026-10-27 08:43 to 08:50 UTC; 3 headless Chrome visits to `/` and `/flags` with the button click (Playwright, system Chrome, `--disable-blink-features=AutomationControlled`, desktop Chrome user agent), beacon bodies captured from the browser; `vercel flags evaluations`, `vercel metrics`, `vercel logs` (CLI 65.2.0); `GET /v1/billing/charges` for the billing day 2026-10-26; `lab/NOTES.md`.
