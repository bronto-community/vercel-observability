# Redirects and external rewrites

> Each redirect from a project rule writes one log drain record with `source: redirect`, the status (`307`) and the target in `destination`; each request rewritten to another domain writes one `source: external` record with the full target URL in `destination` and the cache state. Counted from the drain, both match Vercel's `vercel.request.count` exactly. External rewrites also appear in the trace drain, with a `Fetch Host` span for the upstream call; redirects don't: their root span never arrives, only two orphaned child spans. Upstream DNS and connect times exist only as metrics inside Vercel (Observability Plus). The trap: most `external` records in a typical Next.js project are Vercel's own Web Analytics and Speed Insights traffic, which Vercel serves as external rewrites, and cached external rewrites drop the `destination` field.

| | |
| --- | --- |
| Kind | Platform service (redirect and rewrite rules from `next.config.ts`, `vercel.json` / `vercel.ts`, project-level routes) |
| Plans | Logs on all plans in the dashboard; traces on all plans once the project has a tracing sampling rule (added by default for new Next.js 16.5+ projects since 2026-11-06; Hobby includes 1M span units a month); drains need Pro or Enterprise; metrics queries need Observability Plus |
| Signals | Logs · Traces (external rewrites only) · Metrics (inside Vercel only) |
| Exit paths | Log drain (`source: redirect`, `source: external`) · Trace drain |
| Verified | 2026-10-26 · Vercel CLI 65.2.0 · Next.js 16.3.6 · lab project `petclinic-agent` |
| Refreshed | 2026-11-12 · docs and changelog to 2026-11-12, no new captures · Vercel CLI 65.14.0 docs |

The lab has one of each, in `apps/web/next.config.ts`: a redirect `/clinic` → `/vets` (`permanent: false`) and an external rewrite `/petclinic-openapi.yml` → `https://raw.githubusercontent.com/spring-petclinic/spring-petclinic-rest/master/src/main/resources/openapi.yml`. Synthetic traffic called them in 30% and 10% of its runs.

## 1. What it emits

| Signal | What | Where it lives | Retention |
| --- | --- | --- | --- |
| Logs | One record per redirected request; one per externally rewritten request | Runtime Logs, `vercel logs` | Hobby 1 h, Pro 1 day, Enterprise 3 days, Plus 30 days (Documented) |
| Traces | External rewrite: root span plus `Fetch Host`. Redirect: `Resolve Deployment` and `Resolve Route` only | Traces page (Vercel Tracing), `vercel traces`, trace drain | In Vercel: Hobby 3 days, Pro 14 days, Enterprise 14 days since 2026-11-06; before that as for logs (Documented). Drained spans: your backend's retention |
| Metrics | `vercel.request.count` with `redirectLocation`, `externalRewriteTargetHost`, `externalRewriteTargetPath`, `rewriteDestinationHostname`; `vercel.request.external_rewrite_dns_ms`, `vercel.request.external_rewrite_connect_ms` | Observability › External Rewrites, Query, `vercel metrics` | Hobby 12 h, Pro 1 day, Enterprise 3 days, Plus 30 days (Documented) |

## 2. Out-of-the-box shape

### Redirect records

All 1,552 `source: redirect` records in 7 days had the same fields (Captured: `log-redirect.json`):

| Field | Example | Note |
| --- | --- | --- |
| `source` | `redirect` | |
| `path`, `proxy.path` | `/clinic` | The requested path |
| `destination` | `/vets` | The `Location` target, as written in the rule |
| `statusCode`, `proxy.statusCode` | `307` | |
| `level` | `info` | |
| `executionRegion` | `iad1:dub1` | |
| `traceId`, `spanId` | `a20e2957…`, `ba5a0068…` | `spanId` is the request's root span, which the trace drain never delivers (see Spans) |
| `proxy.method`, `proxy.host`, `proxy.region`, `proxy.userAgent`, `proxy.clientIp`, `proxy.vercelId`, `requestId`, `deploymentId`, `environment`, `branch`, `ja4Digest` | | `branch` missing on 7 records |

No `proxy.pathType` and no `proxy.vercelCache` on redirect records. Middleware does not run for a redirect from `next.config.ts`: 0 middleware records for `/clinic` (Observed).

### External rewrite records

Fields seen on 2,000 `source: external` records (Captured: `log-external-rewrite.json`):

| Field | Example | Note |
| --- | --- | --- |
| `source` | `external` | |
| `path`, `proxy.path` | `/petclinic-openapi.yml` | The requested path |
| `destination` | `https://raw.githubusercontent.com/…/openapi.yml` | Full target URL with query string. **Missing on most cache hits** (655 of 700 `HIT` records) |
| `proxy.pathType` | `EXTERNAL` | Upper case |
| `proxy.vercelCache` | `MISS`, `HIT` | External rewrites can be cached by the CDN |
| `proxy.cacheId` | `d8q84-1792777637253-0e7615bc457f` | On cache hits: the `requestId` of the request that filled the cache |
| `statusCode`, `proxy.statusCode` | `200`, `202` | The upstream's status |
| `proxy.referer` | | On browser traffic |
| `traceId`, `spanId` | | On every record |

Nothing about the upstream call's timing is in the record.

### What the external records are

In 7 days, 521 of 11,141 `external` records came from the lab's own rewrite. The rest were Vercel Web Analytics and Speed Insights, which the client scripts load and report through project-relative paths that Vercel rewrites to its own hosts (Observed):

| `path` | `destination` host | Records | Method, cache |
| --- | --- | --- | --- |
| `/35dfe401045c5cda/event` | `vitals.vercel-insights.com/v1/event` | 2,654 | POST, `MISS` |
| `/35dfe401045c5cda/view` | `vitals.vercel-insights.com/v1/view` | 2,215 | POST, `MISS` |
| `/35dfe401045c5cda/script.js` | `analytics-script.vercel.sh/v1/script.js` | 2,260 | GET, mostly `HIT` |
| `/39023274925c087f/script.js` | `analytics-script.vercel.sh/v1/speed-insights/script.js` | 2,258 | GET, mostly `HIT` |
| `/39023274925c087f/vitals` | `vitals.vercel-insights.com/v2/vitals` | 1,232 | POST, `MISS` |
| `/petclinic-openapi.yml` | `raw.githubusercontent.com` | 521 | GET, `MISS` |

The beacon `destination` carries the analytics DSN and the deployment URL as query parameters (`?dsn=…&ve=production&vu=petclinic-agent-…vercel.app&dpl=dpl_…`) (Captured: `log-external-analytics-beacon.json`, `log-external-analytics-script.json`). The path prefix (`35dfe401045c5cda`, `39023274925c087f`) is per project.

### Spans

External rewrite (Captured: `trace-external-rewrite.ndjson`):

```
GET /petclinic-openapi.yml          vercel.edge-network        48.0 ms
├─ Resolve Deployment               vercel.edge-network         6.2 ms
├─ Resolve Route                    vercel.edge-network        30.7 ms
│  └─ Invoke Middleware             vercel.serverless-runtime  30.2 ms
│     ├─ middleware GET             petclinic-web               0.2 ms
│     └─ waitUntil                  vercel.serverless-runtime  27.0 ms
└─ Fetch Host                       vercel.edge-network         8.3 ms
```

- The root span's `http.route` is the **target** path (`/spring-petclinic/spring-petclinic-rest/master/src/main/resources/openapi.yml`), while `http.target` and the span name keep the requested path. `vercel.cache_level` is `origin` on a miss (Captured: `span-edge-external-rewrite.json`).
- `Fetch Host` carries the target as `http.url` without scheme or query string, and no status code (Captured: `span-fetch-host.json`). Its duration is the upstream call: 7-day averages 137.0 ms for GitHub, 12–14 ms for Vercel's analytics hosts (Observed).
- Middleware runs before an external rewrite: 521 middleware records for 521 rewrites (Observed).

Redirect (Captured: `trace-redirect.ndjson`):

```
(root span ba5a0068577ded89: never delivered)
├─ Resolve Deployment               vercel.edge-network   2.2 ms
└─ Resolve Route                    vercel.edge-network   2.2 ms
```

No span named `GET /clinic` arrived in 14 days, against 1,552 redirect records; 5 of 5 sampled redirect traces held only these two children, each pointing at a parent that isn't there (Observed). The child spans carry no route, status or destination (Captured: `span-redirect-resolve-route.json`).

### Metrics

Every query needs Observability Plus. 2026-10-23 (UTC) unless noted (Captured: `metrics-*.json`):

```
$ vercel metrics vercel.request.count --group-by redirectLocation --group-by httpStatus --group-by route
/vets 307 /clinic 381

$ vercel metrics vercel.request.external_rewrite_connect_ms --aggregation avg --group-by externalRewriteTargetHost
raw.githubusercontent.com 8.4 ms (p95 32 ms) · analytics-script.vercel.sh 1 ms

$ vercel metrics vercel.request.external_rewrite_dns_ms --aggregation avg --group-by externalRewriteTargetHost
raw.githubusercontent.com 4.5 ms · analytics-script.vercel.sh 3.5 ms

$ vercel metrics vercel.request.count --filter "pathType:external" --group-by requestPath --group-by externalRewriteTargetHost   (2026-10-20)
/35dfe401045c5cda/event vitals.vercel-insights.com 2,415 · /35dfe401045c5cda/script.js analytics-script.vercel.sh 2,016
/39023274925c087f/script.js 2,014 · /35dfe401045c5cda/view 2,009 · /39023274925c087f/vitals 1,115 · /petclinic-openapi.yml 83
```

The log drain gives the same counts: 381 redirects on 2026-10-23, and the 2026-10-20 external counts path for path (2,415, 2,016, 2,014, 2,009, 1,115, 83) (Observed). The DNS and connect metrics have no value for cache hits. Routing CPU per request (`vercel.request.route_cpu_duration_ms`, average): redirect 1.4 ms, external 2.0 ms.

## 3. Extras beyond the default

| Extra | What it adds | Cost |
| --- | --- | --- |
| Observability Plus | Querying redirect locations, rewrite targets, upstream DNS and connect time | $1.20 per 1M events (Documented) |
| Cache headers on the upstream response | External rewrites served from the CDN (`HIT`), with `proxy.cacheId` and without `destination` | None |
| Redirects in middleware instead of rules | A middleware report line per redirect and `middlewareAction` in the middleware metrics; the `redirect` record then doesn't apply (Not observed: the lab redirects by rule) | One middleware invocation per redirect |

## 4. Getting it out

| Signal | Exit path | Tested configuration |
| --- | --- | --- |
| Redirects | Log drain, `source: redirect` | Drain `petclinic-agent-logs` with no source filter (configuration in the [Functions entry](functions.md#4-getting-it-out)) |
| External rewrites | Log drain, `source: external` | Same drain |
| Upstream call duration | Trace drain: `Fetch Host` span | Drain `petclinic-agent-traces` |
| Upstream DNS and connect time, redirect locations as a metric | None. Pull with `vercel metrics --json` (Plus) | |

Log drains can be limited to some sources. A drain without `external` loses the Web Analytics and Speed Insights request records along with your own rewrites; a drain without `redirect` loses redirects entirely, since they leave no span.

## 5. In Bronto

| Data | Dataset | Field names |
| --- | --- | --- |
| Log drain | `petclinic-agent/vercel-logs` | `source`, `destination`, `path`, `"proxy.vercelCache"` |
| Trace drain | `.traces/vercel-traces` | `"$span.name"`, `"$http.url"`, `"$http.route"` |

Queries, each run against the lab's last 7 days on 2026-10-26:

| Question | Query | Group by | Result |
| --- | --- | --- | --- |
| Which redirects fire, and where to? | `source = 'redirect'` | `path`, `destination`, `statusCode` | `/clinic` → `/vets` 307: 1,552 |
| What goes through external rewrites? | `source = 'external'` | `path` | Analytics and Speed Insights paths 10,620 · `/petclinic-openapi.yml` 521 |
| Cached external rewrites | `source = 'external'` | `"proxy.vercelCache"` | `MISS` 6,622 · `HIT` 4,519 |
| Failing external targets | `source = 'external' AND "proxy.statusCode" >= 400` | `path` | none |
| Upstream latency per target | `"$span.name" = 'Fetch Host'`, select `avg("$span.duration_nano")` | `"$http.url"` | GitHub 137.0 ms · `vitals.vercel-insights.com` 12.1–13.6 ms · `analytics-script.vercel.sh` 10.1–10.9 ms |

For your own rewrites, exclude the analytics paths (`path NOT LIKE '/35dfe401045c5cda/%' AND path NOT LIKE '/39023274925c087f/%'`, with your project's prefixes) or match on `destination`. The `destination` filter misses cached responses, which have none; filter on `path` instead.

Templates: the "Vercel Overview" dashboard counts redirect and external records in its request and status panels; the "High 4xx Rate" and "5xx Error Rate Spike" monitors see failing external targets because the upstream status is the record's `statusCode`.

## Gotchas

1. **Most external records are Vercel's own analytics.** Web Analytics and Speed Insights run as external rewrites through your domain: 95% of the lab's `external` records. Counting your own rewrites by volume needs the analytics paths excluded.
2. **Cache hits lose `destination`.** A cached external rewrite (`proxy.vercelCache: HIT`) usually has no `destination` (655 of 700); group by `path`.
3. **Redirects have no root span.** The trace drain delivers `Resolve Deployment` and `Resolve Route` under a parent ID that never arrives; the log record's `spanId` is that missing parent. Count and inspect redirects from the log drain only.
4. **`http.route` on an external rewrite is the upstream path.** Grouping edge spans by `http.route` puts rewrites under the target's path (`/v1/script.js`, `/spring-petclinic/…/openapi.yml`), not under your route. Group by `http.target` for your path.
5. **Upstream timing splits three ways.** DNS and connect time are metrics only; the full upstream call is the `Fetch Host` span; the log record has neither. The span average (137 ms to GitHub) and the connect average (8.4 ms) measure different things.

## Samples

| File | What it shows |
| --- | --- |
| [`log-redirect.json`](../samples/redirects-rewrites/log-redirect.json) | Redirect `/clinic` → `/vets`, 307 |
| [`log-external-rewrite.json`](../samples/redirects-rewrites/log-external-rewrite.json) | External rewrite to GitHub, cache miss |
| [`log-external-analytics-beacon.json`](../samples/redirects-rewrites/log-external-analytics-beacon.json) | Web Analytics page view beacon as an external rewrite |
| [`log-external-analytics-script.json`](../samples/redirects-rewrites/log-external-analytics-script.json) | Cached analytics script: `HIT`, `cacheId`, no `destination` |
| [`span-edge-external-rewrite.json`](../samples/redirects-rewrites/span-edge-external-rewrite.json) | Root span of an external rewrite (`http.route` = target path) |
| [`span-fetch-host.json`](../samples/redirects-rewrites/span-fetch-host.json) | The `Fetch Host` span |
| [`span-redirect-resolve-route.json`](../samples/redirects-rewrites/span-redirect-resolve-route.json) | One of the two spans a redirect leaves |
| [`trace-external-rewrite.ndjson`](../samples/redirects-rewrites/trace-external-rewrite.ndjson) | Full trace of an external rewrite |
| [`trace-redirect.ndjson`](../samples/redirects-rewrites/trace-redirect.ndjson) | Everything the trace drain delivered for one redirect |
| [`metrics-redirect-location.json`](../samples/redirects-rewrites/metrics-redirect-location.json) | Requests by redirect location, status, route |
| [`metrics-external-rewrite-targets.json`](../samples/redirects-rewrites/metrics-external-rewrite-targets.json) | External rewrites by path and target host (2026-10-20) |
| [`metrics-external-rewrite-connect-avg.json`](../samples/redirects-rewrites/metrics-external-rewrite-connect-avg.json), [`metrics-external-rewrite-connect-p95.json`](../samples/redirects-rewrites/metrics-external-rewrite-connect-p95.json) | Upstream connect time |
| [`metrics-external-rewrite-dns-avg.json`](../samples/redirects-rewrites/metrics-external-rewrite-dns-avg.json) | Upstream DNS time |

## Sources

- Vercel docs, read 2026-10-26: [Log Drains reference](https://vercel.com/docs/drains/reference/logs) (last updated 2026-09-11; `destination` "only on `external` and `redirect` logs", `external` "includes cached external rewrites"); read 2026-10-16 to 2026-10-20: [Rewrites](https://vercel.com/docs/routing/rewrites), [Observability](https://vercel.com/docs/observability), [`vercel metrics`](https://vercel.com/docs/cli/metrics).
- Docs, read 2026-11-12: [Vercel Tracing is now generally available](https://vercel.com/changelog/vercel-tracing-is-now-generally-available) (2026-11-06), [Tracing](https://vercel.com/docs/tracing) and [Configuring Tracing](https://vercel.com/docs/tracing/configure-tracing) (both last updated 2026-11-03; retention, sampling rules, span units), [Trace Drains reference](https://vercel.com/docs/drains/reference/traces) (last updated 2026-08-21), [Runtime Logs](https://vercel.com/docs/logs/runtime) (last updated 2026-08-28; log retention unchanged).
- Lab: `apps/web/next.config.ts`; Bronto EU datasets `petclinic-agent/vercel-logs` and `.traces/vercel-traces`, 2026-10-18 to 2026-10-26; Vercel CLI 65.2.0 `vercel metrics` for 2026-10-20 and 2026-10-23.
