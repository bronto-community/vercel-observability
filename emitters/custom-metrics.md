# Custom Metrics

> `metric(name, value, attributes)` from `@vercel/functions` records one numeric data point per call. Vercel stores it next to its own metrics, and the only ways to read it are `vercel metrics`, the Query tab and the Custom Metrics dashboard, all with Observability Plus. No drain carries it, and the call leaves no trace anywhere else: no log line, no span, no attribute on the function's spans. In the lab every one of 18 calls arrived, with the `plan` attribute as a dimension next to the region, path type and deployment that Vercel adds. To get the numbers out, pull `vercel metrics … --json` on a schedule. The trap: `metric()` hands the value to the Vercel runtime and returns. If the runtime doesn't take metrics (local development, another host), the call does nothing and reports no error.

| | |
| --- | --- |
| Kind | Library (`@vercel/functions` ≥ 3.9.0) and platform metric store |
| Plans | Pro and Enterprise with Observability Plus (Documented, changelog 2026-08-20) |
| Signals | Metrics (inside Vercel only) |
| Exit paths | None pushed. `vercel metrics --json` pull |
| Verified | 2026-10-27 · Vercel CLI 65.2.0 · `@vercel/functions` 3.10.3 · Next.js 16.4.3 · lab project `vercel-observability-lab` |
| Refreshed | 2026-11-12 · docs and changelog to 2026-11-12, no new captures · `@vercel/functions` 3.11.1 (changelog: no change to `metric()`) · Vercel CLI 65.14.0 |

## 1. What it emits

| Signal | What | Where it lives | Retention |
| --- | --- | --- | --- |
| Metrics | One data point per `metric()` call, named by you, with your attributes and Vercel's metadata | Observability › Custom Metrics, Query (group "Custom Metrics"), `vercel metrics` | Pro 1 day, Plus 30 days (Documented, as for other Observability metrics) |
| Logs, traces | Nothing from the call itself (Observed) | | |
| Billing | Each data point is one Observability event | `GET /v1/billing/charges`, line `Observability Events` | |

The lab route `/api/metric` calls `metric("lab.orders.created", 1, { plan })` once per request with `plan` chosen at random from `free` and `pro`.

## 2. Out-of-the-box shape

### The metric

`vercel metrics schema` lists a custom metric once it has received data (Captured: `schema-lab-orders-created.json`):

```json
{ "id": "lab.orders.created",
  "description": "Custom metric value",
  "dimensions": ["ownerId", "projectId", "deploymentId", "functionRegion", "pathType", "edgeNetworkRegion", "plan"],
  "unit": "count",
  "aggregations": ["count", "sum", "avg", "min", "max", "p50", "p75", "p90", "p95", "p99", "stddev", "unique"] }
```

`plan` is the lab's attribute; the other six dimensions are added by Vercel. The docs list `requestId` among the automatic metadata, but the schema has no `requestId` dimension (Observed).

Queries since 2026-10-26 (Captured: `metrics-*.json`):

```
$ vercel metrics lab.orders.created -a sum --group-by plan --group-by functionRegion --since 2026-10-26T00:00:00Z --json
pro / dub1 11 · free / dub1 7

$ vercel metrics lab.orders.created -a sum --group-by pathType --group-by edgeNetworkRegion --group-by deploymentId
streaming_func / fra1 / dpl_GY4J… 8 · streaming_func / fra1 / dpl_GZb7… 7 · streaming_func / fra1 / dpl_ri5y… 2 · streaming_func / pdx1 / dpl_GY4J… 1

$ vercel metrics vercel.function_invocation.count --filter "route eq '/api/metric'"
18
```

18 invocations, 18 data points: every call arrived (Observed). The column name follows the platform metrics: `<name with dots as underscores>_<aggregation>`, here `lab_orders_created_sum`. `--filter "plan eq 'pro'"` and `--filter "plan:pro"` (the form in Vercel's docs) both returned 11.

### What the call leaves elsewhere

Nothing. For the same requests (Observed, 5 requests since the drain started):

- Log drain: one invocation report line per request (`[GET] /api/metric status=200 … Duration: 10 ms`), the same as for a route without `metric()` (Captured: `log-report-line.json`). No line for the metric.
- Trace drain: the usual tree (edge network, `Invoke Function`, `GET /api/metric`, `executing api route (app) /api/metric`, `waitUntil`), with no span or attribute for the metric (Captured: `trace-api-metric.ndjson`, `span-executing-api-route.json`).

The reason is in the library. `metric()` is three lines: it looks up the runtime's IPC object (`globalThis[Symbol.for("@vercel/rusty-runtime-ipc")]`) and calls `sendMetric(name, value, tags)` if it exists (`@vercel/functions` 3.10.3, `metric.js`). It is synchronous, returns `void`, writes nothing to stdout and creates no span.

### Names and limits (Documented)

| Rule | Value |
| --- | --- |
| Metric names, attribute names, attribute values | Non-empty, shorter than 64 bytes |
| Allowed characters | `A-Z a-z 0-9 - _ . /`; anything else becomes `_` (`data+summary` → `data_summary`) |
| Value | 64-bit float |
| Attributes per data point | Up to 50 |
| Data points per function invocation | Up to 100 |
| Prefix | `vercel.` is reserved for platform metrics (Vercel's agent guidance) |

### Billing

Each data point is one Observability event at $1.20 per 1M (Documented). The billing line does not separate custom metrics from the other Observability Plus events: the lab's `Observability Events` line for billing day 2026-10-26 was 1,135.85 events ($0.00136), a fractional count that covers all of the project's Plus events (Captured: `charge-observability-events-2026-10-26.jsonl`).

## 3. Extras beyond the default

| Extra | What it adds |
| --- | --- |
| Attributes | Each attribute key becomes a dimension for `--group-by` and `--filter`. Keep values bounded (plan, outcome, provider); unique values such as user or request IDs make every data point its own group |
| Custom monitors (since 2026-10-26) | Threshold or anomaly alerts on an Observability metric, per project, at $0.0035 per GB scanned (see the [Alerts](alerts.md) entry). The docs take metric names from `vercel metrics schema`, where custom metrics appear after their first data point; a monitor on a custom metric: Not observed |
| A structured log line next to the call | The only way to see the individual values outside Vercel; one JSON `console.log` per event, as in the Functions entry |

## 4. Getting it out

| Signal | Exit path | Tested configuration |
| --- | --- | --- |
| Custom metric values | None pushed. Pull `vercel metrics <name> -a sum --group-by <attr> --since … --json` (Plus) on a schedule and forward the `data` rows | Queries in section 2 |
| Per-event detail | Log a JSON line next to `metric()` and use the log drain | Not done in the lab (the route only calls `metric()`) |
| Count of calls when there is one call per invocation | Log drain: count the route's report lines | 5 report lines against 5 data points since the drain started (Observed) |

The `--json` response has `query`, `summary` (one row per group for the whole range) and `data` (one row per group per time bucket), as for the platform metrics.

## 5. In Bronto

Custom metrics don't reach Bronto through any drain. What is there is the function around the call:

| Data | Dataset | Field names |
| --- | --- | --- |
| Log drain | `vercel-observability-lab/vercel-logs` | `source`, `path`, `message` |
| Trace drain | `.traces/vercel-observability-lab` | `"$span.name"`, `"$http.route"` |

| Question | Query | Group by | Result (2026-10-27, from 08:43 UTC) |
| --- | --- | --- | --- |
| Invocations of the route that emits the metric | `path = '/api/metric' AND message LIKE 'START%'` | `statusCode` | `200` 5 |
| Any log record about the metric itself | `message LIKE '%lab.orders.created%'` | | 0 (the route's response body names the metric, but responses aren't logged) |
| Any span about it (trace dataset) | `"$span.name" LIKE '%lab.orders%' OR "$plan" != ''` | | 0 |

To chart the values in Bronto, forward the rows of a scheduled `vercel metrics --json` pull.

## Gotchas

1. **No drain, no log, no span.** Data points exist only in Vercel's metric store. A dashboard elsewhere needs a scheduled pull (Observed).
2. **Silent outside Vercel.** `metric()` is a no-op when the runtime's IPC object is missing, so a local run or a test shows nothing and throws nothing. Verify on a deployment (library source).
3. **`requestId` isn't a dimension.** The docs list it as automatic metadata, the schema doesn't have it, so a data point can't be tied back to its request (Observed).
4. **The schema appears after the first data point.** `vercel metrics schema <name>` returns the metric only once it has data; attribute dimensions appear as they are first sent (Vercel's agent guidance; consistent with the lab, where `plan` was listed after the first requests).
5. **The cost is not broken out.** Custom metric events are part of `Observability Events` on the bill and can't be separated from the other Plus events.

## Samples

| File | What it shows |
| --- | --- |
| [`schema-lab-orders-created.json`](../samples/custom-metrics/schema-lab-orders-created.json) | `vercel metrics schema lab.orders.created` |
| [`metrics-sum-by-plan-region.json`](../samples/custom-metrics/metrics-sum-by-plan-region.json) | Sum by the `plan` attribute and function region |
| [`metrics-count-by-plan.json`](../samples/custom-metrics/metrics-count-by-plan.json) | Data points by `plan` |
| [`metrics-sum-by-auto-dims.json`](../samples/custom-metrics/metrics-sum-by-auto-dims.json) | The dimensions Vercel adds: path type, edge region, deployment |
| [`metrics-function-invocations.json`](../samples/custom-metrics/metrics-function-invocations.json) | Invocations of `/api/metric` for comparison |
| [`log-report-line.json`](../samples/custom-metrics/log-report-line.json) | The only log record of a request that called `metric()` |
| [`span-executing-api-route.json`](../samples/custom-metrics/span-executing-api-route.json) | The route span, with no metric attribute |
| [`trace-api-metric.ndjson`](../samples/custom-metrics/trace-api-metric.ndjson) | All spans of one `/api/metric` request |
| [`charge-observability-events-2026-10-26.jsonl`](../samples/custom-metrics/charge-observability-events-2026-10-26.jsonl) | The project's Observability Events billing line |

## Sources

- Vercel docs, read 2026-10-27: [Emit Custom Metrics from Vercel Functions](https://vercel.com/docs/observability/custom-metrics) (last updated 2026-09-10), [changelog: Custom metrics are now supported in Vercel Observability](https://vercel.com/changelog/custom-metrics-are-now-supported-in-vercel-observability) (2026-08-20), [`vercel metrics`](https://vercel.com/docs/cli/metrics). Vercel's agent plugin skill `custom-metrics` (0.50.0) for the reserved `vercel.` prefix.
- Read 2026-11-12: [Configure alerts: custom monitors](https://vercel.com/docs/alerts/configure-alerts#configure-custom-rules), [`@vercel/functions` CHANGELOG](https://www.npmjs.com/package/@vercel/functions) to 3.11.1.
- `@vercel/functions` 3.10.3: `metric.js`, `CHANGELOG.md` (`metric()` added in 3.9.0).
- Lab: `lab/app/api/metric/route.ts`; Vercel CLI 65.2.0 (`vercel metrics schema`, `vercel metrics`, `vercel api /v1/billing/charges`); Bronto EU datasets `vercel-observability-lab/vercel-logs` and `.traces/vercel-observability-lab`, 2026-10-27.
