# Cron Jobs

> A cron job is an ordinary HTTP `GET` from Vercel's scheduler to a path in your production deployment, so its telemetry is the telemetry of that function: log drain records and a trace with the user agent `vercel-cron/1.0`. There is no record of the schedule itself. Vercel emits no "run started", "run missed" or "run failed" event, no webhook and no metric, so a missed run leaves nothing behind and has to be detected from the absence of the expected request. In the lab every cron request entered Vercel in `iad1` and crossed to the function in `dub1`, and each run produced two report lines (middleware in `iad1`, function in `dub1`). The thing most people get wrong: counting records with the cron user agent counts lines, not runs. Count function report lines per schedule interval, and expect the occasional run that executes twice inside one request.
>
> **Successor: [Schedules](schedules.md).** Vercel Schedules (public beta 2026-11-05) is "the successor to Cron Jobs. Existing Cron Jobs continue to work" (changelog), and the docs call Cron Jobs "a legacy feature" that "will be migrated to Schedules in the future" (Documented 2026-11-12). Schedules add per-schedule execution history; a schedule with a `path` target calls the route the same way, with `vercel-cron/1.0`, so the records below also describe migrated path schedules.

| | |
| --- | --- |
| Kind | Platform service (scheduler that calls your functions) |
| Plans | All plans; Hobby runs at most once a day, anywhere within the hour (Documented). Drains need Pro or Enterprise |
| Signals | Logs · Traces (both from the invoked function; nothing from the scheduler) |
| Exit paths | Log drain (`source: lambda`) · Trace drain |
| Verified | 2026-10-26 · Vercel CLI 65.2.0 · Next.js 16.3.6 · `@vercel/otel` 2.1.3 · lab project `petclinic-agent`, data up to 2026-10-26 10:00 UTC |
| Refreshed | 2026-11-12 · docs and changelog to 2026-11-12, no new captures · Vercel CLI 65.14.0 (`crons --help`, `activity types`) |

## 1. What it emits

| Signal | What | Where it lives | Retention |
| --- | --- | --- | --- |
| Logs | The invoked function's records: report line, your `console` output, timeouts and crashes. Middleware writes its own report line for the same request | Runtime Logs (Settings › Cron Jobs › View Logs filters them), `vercel logs` | As for Functions (Documented) |
| Traces | The request's span tree: edge network, `Route across regions`, middleware, function, framework spans | Observability › Tracing (the Traces page since Tracing GA), `vercel traces search`, trace drain | Hobby 3 days, Pro 14 days, Enterprise 14 days since Tracing GA on 2026-11-06 (Documented). Before, traces followed runtime log retention: 1 hour, 1 day, 3 days |
| Metrics | None of its own. Cron invocations are counted in `vercel.function_invocation.*` like any request; the metric catalog has no cron metric or cron dimension | Observability | |
| Events | None per run. No run, miss or failure event, no webhook (Documented, and nothing found in the lab). The Activity Log has one type, `project-cron-jobs-toggled`, for turning a project's cron jobs on or off (Observed in `vercel activity types`, CLI 65.14.0) | Activity Log | See the Audit Logs entry |

The lab's crons, defined in `vercel.ts`:

```ts
crons: [
  { path: "/api/synthetic", schedule: "* * * * *" },  // every minute
  { path: "/api/ops", schedule: "0 * * * *" },        // hourly
],
```

Both routes check `Authorization: Bearer $CRON_SECRET` and, since 2026-10-23 22:00 UTC, return `410` at once (a hard stop in the lab code). Records before that date show real runs (`200`), records after show the scheduler still calling on time.

## 2. Out-of-the-box shape

### Log records

A cron run is a request with `proxy.userAgent: ["vercel-cron/1.0"]`. Every record of that request carries it, including the middleware's report line and your own `console.log` lines (Captured: `log-cron-report-200.json`, `log-cron-middleware.json`).

| Field | Cron value | Note |
| --- | --- | --- |
| `proxy.userAgent` | `["vercel-cron/1.0"]` | An array. The only field that marks a record as cron. `requestType: cron`, which the Runtime Logs UI filters on, is **not** in the drain record |
| `proxy.method` | `GET` | |
| `proxy.path`, `path` | `/api/synthetic` | `path` is the route pattern; on the middleware record it is `/services/web/_middleware` |
| `proxy.host`, `host` | `petclinic-agent-ejezkkpzs-brontoio.vercel.app` | The **deployment URL** of the current production deployment, not the production domain |
| `proxy.region` | `iad1` | Where the request entered. `iad1` for all 8,853 runs |
| `executionRegion` | `dub1` (function), `iad1` (middleware) | The function runs in its configured region; the middleware ran in `iad1` |
| `proxy.lambdaRegion` | `dub1` | |
| `statusCode`, `proxy.statusCode` | `200`, `410`, `504` | The middleware record shows `200` while the function returns `410` |
| `proxy.pathType` | `streaming_func` (function), `middleware` | |

No field carries the schedule, the cron expression or the scheduled time. Vercel sends the schedule as a request header (`x-vercel-cron-schedule`, Documented), but the log drain doesn't include request headers. If you need it in the record, log it from the handler.

### One run, two report lines

Each run produces a middleware report line and a function report line, both with the cron user agent (Observed, 2026-10-25):

| `path` | `executionRegion` | `proxy.region` | `statusCode` | Records |
| --- | --- | --- | --- | --- |
| `/services/web/_middleware` | `iad1` | `iad1` | `200` | 1,440 |
| `/api/synthetic` | `dub1` | `iad1` | `410` | 1,440 |
| `/services/web/_middleware` | `iad1` | `iad1` | `200` | 24 |
| `/api/ops` | `dub1` | `iad1` | `410` | 24 |

1,440 runs of the per-minute job and 24 of the hourly job on 2026-10-25: none missing, none extra.

### Level of a cron run

| Outcome | `type` | `level` | Seen |
| --- | --- | --- | --- |
| `200` | `stdout` | `info` | 5,243 runs |
| `410` (route stopped itself) | `stdout` | `warning` | 3,660 runs |
| `504` (hit `maxDuration` of 300 s) | `stderr` | `error` | 11 runs |

(Observed, 2026-10-19 10:00 to 2026-10-26 10:00 UTC, function report lines.)

### Timing

The scheduler calls at a fixed offset inside the interval, not at second zero. `proxy.timestamp` of the per-minute job fell between 34.1 s and 34.8 s past the minute for 98% of 8,853 runs; the hourly job arrived 3.1 to 5.7 s past the hour (Observed). Expect a run "at 12:00" to arrive some seconds later and keep that offset stable.

### Spans

The trace drain delivers the request's tree like any other request (Captured: `trace-cron-410.ndjson`):

```
GET /api/synthetic                          vercel.edge-network        135.7 ms   cloud.region iad1
├─ Resolve Deployment                       vercel.edge-network          7.4 ms
├─ Resolve Route                            vercel.edge-network         26.2 ms
│  └─ Invoke Middleware                     vercel.serverless-runtime  217.5 ms
│     ├─ middleware GET                     petclinic-web                0.2 ms
│     └─ waitUntil                          vercel.serverless-runtime  214.4 ms
├─ Route across regions                     vercel.edge-network         36.2 ms   iad1 → dub1
└─ Invoke Function                          vercel.serverless-runtime   21.5 ms
   ├─ GET /api/synthetic                    petclinic-web                4.0 ms
   │  ├─ executing api route (app) …        petclinic-web                1.1 ms
   │  └─ start response                     petclinic-web                0.0 ms
   └─ waitUntil                             vercel.serverless-runtime   12.6 ms
```

- The root span carries `http.request.header.user-agent: vercel-cron/1.0`, `http.route`, `http.response.status_code` and `cloud.region: iad1` (Captured: `span-cron-edge.json`).
- `Route across regions` carries `vercel.edge.region: iad1` and `vercel.function.region: dub1`; in the lab it adds about 35 ms to every run (Captured: `span-route-across-regions.json`).
- Each run starts a new trace. Nothing links consecutive runs of the same job.

## 3. Extras beyond the default

| Extra | What it adds | Cost |
| --- | --- | --- |
| A structured log line per run from the handler | Outcome, counts and the schedule header in a queryable form. The lab's synthetic job writes `{"msg":"synthetic run","free":1,"premium":0,"failed":0,"errors":[]}` (Captured in `log-cron-duplicate-run.ndjson`) | None |
| `@vercel/otel` in `instrumentation.ts` | Framework spans under `Invoke Function` (as for any function) | None beyond trace drain volume |
| Observability Plus | Per-route invocation, duration and CPU metrics, which include cron routes. There is still no cron-specific metric | See the Functions entry |

## 4. Getting it out

| Signal | Exit path | Tested configuration |
| --- | --- | --- |
| Cron run records | Log drain | Drain `petclinic-agent-logs`, all sources (see the Functions entry) |
| Cron traces | Trace drain | Drain `petclinic-agent-traces` (see the Functions entry) |
| Schedule, missed runs, failure events | None. Vercel keeps no record of them that you can export | |
| Schedule definition | Your repo (`vercel.ts` / `vercel.json`); the deployment's cron list is visible in Settings › Cron Jobs, the Cron Jobs tab of the project's Schedules page, and `vercel crons list` | |

Run history per job exists only after migrating to [Schedules](schedules.md) (`vercel schedules executions list`); still the case on 2026-11-12 (docs checked).

A missed run can only be detected outside Vercel, from the drained records: count function report lines per cron path and alert when a window holds fewer than expected. Section 5 shows the query in the example backend.

## 5. In Bronto

| Data | Dataset | Field names |
| --- | --- | --- |
| Log drain | `petclinic-agent/vercel-logs` | `"proxy.userAgent.0"` for the first (only) user agent; `path`, `statusCode`, `"proxy.region"`, `executionRegion` |
| Trace drain | `.traces/vercel-traces` | `"$http.request.header.user-agent"`, `"$http.route"`, `"$cloud.region"` |

Queries, run against 2026-10-19 10:00 to 2026-10-26 10:00 UTC unless noted:

| Question | Query | Group by | Result |
| --- | --- | --- | --- |
| Did each cron job run, and how did it end? | `"proxy.userAgent.0" = 'vercel-cron/1.0' AND path != '/services/web/_middleware' AND message LIKE 'START%'` | `path`, `statusCode` | `/api/synthetic` 200: 5,243 · 410: 3,600 · 504: 11; `/api/ops` 410: 60 · 200: 35 |
| Runs per day (2026-10-25) | same | `path` | `/api/synthetic` 1,440 · `/api/ops` 24 |
| Missed-run check (monitor: count per window below the schedule) | same, plus `AND path = '/api/synthetic'`, counted per 5 minutes | | Minimum 5 per 5-minute window; per minute, 8,853 of 8,853 minutes from 2026-10-20 06:27 to 2026-10-26 09:59 had a run |
| Failed runs | same, plus `AND statusCode >= 500` | `path` | `/api/synthetic` 11 (all `504`) |
| Which edge region do cron requests enter? | `"$http.request.header.user-agent" = 'vercel-cron/1.0'` (trace dataset) | `"$cloud.region"` | `iad1` only |

For the missed-run monitor, use a window a little longer than the interval (5 minutes for a per-minute job, 65 minutes for an hourly one) so the fixed offset inside the interval doesn't cause false alarms, and exclude the middleware path so each run counts once.

A cron record's `traceId` is the `$trace_id` of its trace in `.traces/vercel-traces`.

## Gotchas

1. **No miss event.** If the scheduler doesn't call, nothing is logged anywhere. Detect misses from the absence of the expected report line (Documented; the lab had no missed run to show).
2. **Two report lines per run.** Middleware writes its own report line with the cron user agent, in `iad1`, with status `200` even when the function returns `410`. Filter on the function's `path`, not on the user agent alone (Observed: 1,440 + 1,440 records for 1,440 runs).
3. **A run can execute twice in one request.** On 2026-10-21 at 15:48:34 one cron request (`requestId bvvdk-1792597714280-f84c62f7c084`, one trace) contained two `Route across regions` and two `Invoke Function` spans 17.6 s apart. Both invocations ran the whole job and both wrote a report line and a `synthetic run` line. Counting distinct `requestId` hides this; counting report lines shows it. Once in 8,854 runs (Captured: `log-cron-duplicate-run.ndjson`, `trace-cron-duplicate.ndjson`). Vercel's docs warn that a cron job can be delivered more than once; make cron handlers idempotent.
4. **The root span of that duplicated request had no `http.response.status_code`**, while normal cron root spans have it (Captured: `span-cron-duplicate-edge.json` vs `span-cron-edge.json`).
5. **Cron enters in `iad1`.** Every cron request in the lab entered in `iad1`, whatever region the function is pinned to, and paid a `Route across regions` hop of about 35 ms. The middleware for the cron request ran in `iad1` too.
6. **`requestType: cron` is UI-only.** The Runtime Logs filter exists, but the drained record has no such field. Use `proxy.userAgent`.
7. **The scheduler targets the deployment URL.** `host` is `petclinic-agent-<hash>-brontoio.vercel.app`, the current production deployment, not the production domain. After a promotion or rollback, cron requests move to the new deployment (Observed: 8 deployment IDs on 2026-10-23).
8. **No retries.** A run that returns `5xx` or times out isn't repeated (Documented). The 11 `504` runs in the lab were followed by the next scheduled run, not a retry (Observed).
9. **Migrating to Schedules changes the method and timing.** Path schedules send `POST` unless `requestMethod: "GET"` is set, and start within a jitter window (1 minute by default on Pro) instead of a fixed offset in the minute. Keeping both `crons` and `schedules` for the same route runs it twice (Documented, migration guide). A missed-run monitor built on the counts above needs a window that covers the jitter.

## Samples

| File | What it shows |
| --- | --- |
| [`log-cron-report-200.json`](../samples/cron-jobs/log-cron-report-200.json) | Function report line of a successful run: `vercel-cron/1.0`, entered `iad1`, ran `dub1` |
| [`log-cron-middleware.json`](../samples/cron-jobs/log-cron-middleware.json) | The middleware's report line for a cron request, in `iad1` |
| [`log-cron-report-410.json`](../samples/cron-jobs/log-cron-report-410.json) | A run the route stopped (`410`, `level: warning`) |
| [`log-cron-ops-410.json`](../samples/cron-jobs/log-cron-ops-410.json) | The hourly job's report line |
| [`log-cron-duplicate-run.ndjson`](../samples/cron-jobs/log-cron-duplicate-run.ndjson) | All five records of the request that ran twice |
| [`span-cron-edge.json`](../samples/cron-jobs/span-cron-edge.json) | Root span of a cron request |
| [`span-route-across-regions.json`](../samples/cron-jobs/span-route-across-regions.json) | The `iad1 → dub1` hop |
| [`span-cron-duplicate-edge.json`](../samples/cron-jobs/span-cron-duplicate-edge.json) | Root span of the duplicated request, no status code |
| [`trace-cron-410.ndjson`](../samples/cron-jobs/trace-cron-410.ndjson) | All 12 spans of one cron request |
| [`trace-cron-duplicate.ndjson`](../samples/cron-jobs/trace-cron-duplicate.ndjson) | The trace with two function invocations |

## Sources

- Vercel docs and changelog, read 2026-11-12: [Cron Jobs](https://vercel.com/docs/schedules/cron-jobs) (now under Schedules; "a legacy feature"), changelog [Vercel Schedules is now in public beta](https://vercel.com/changelog/vercel-schedules-is-now-in-public-beta) (2026-11-05), [Migrating from Cron Jobs to Schedules](https://vercel.com/docs/schedules/migrate-from-cron-jobs), [Schedules](https://vercel.com/docs/schedules), changelog [Vercel Tracing is now generally available](https://vercel.com/changelog/vercel-tracing-is-now-generally-available) (2026-11-06), [Configuring Tracing](https://vercel.com/docs/tracing/configure-tracing) (Retention); `vercel crons --help` and `vercel activity types`, CLI 65.14.0.
- Vercel docs, read 2026-10-16 to 2026-10-20: [Cron Jobs](https://vercel.com/docs/cron-jobs), [Managing Cron Jobs](https://vercel.com/docs/cron-jobs/manage-cron-jobs) (no retries, duplicate delivery, `CRON_SECRET`, Hobby limits), [Troubleshooting cron jobs](https://vercel.com/kb/guide/troubleshooting-vercel-cron-jobs), [Runtime Logs](https://vercel.com/docs/logs/runtime) (`requestType` filter).
- Lab: Bronto EU dataset `petclinic-agent/vercel-logs` (cron report lines 2026-10-20 06:27 to 2026-10-26 10:00 UTC) and `.traces/vercel-traces`; lab code `vercel.ts`, `apps/web/app/api/synthetic/route.ts`, `apps/web/app/api/ops/route.ts`, `apps/web/lib/stop-at.ts`; Vercel CLI 65.2.0 (`vercel metrics schema`).
