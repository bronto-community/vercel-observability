# Schedules

> **Docs only: the lab has no schedule yet, so everything here is Documented or Not observed, except the billing lines and CLI help.** Vercel Schedules (public beta since 2026-11-05, the successor to [Cron Jobs](cron-jobs.md)) runs a function, calls a path or publishes a Queues message on a cron cadence or once. Unlike Cron Jobs it keeps an execution history per schedule (run count, error rate, average duration, each run's outcome), readable in the dashboard and with `vercel schedules executions list`. That history has no drain, webhook or documented REST endpoint, so it leaves Vercel only by pulling it with the CLI. What leaves without code is the same as for Cron Jobs: each run is a function invocation, so its log records and spans go out through the log and trace drains. Schedule changes made by people are Activity Log events; changes made by deployed code through the SDK are not recorded. The thing most people will get wrong: a migrated path schedule looks like a cron run in the drains (`vercel-cron/1.0`), but it arrives inside a jitter window, sends `POST` by default, and can catch up with several late runs at once, so a missed-run monitor built for Cron Jobs needs a wider window.

| | |
| --- | --- |
| Kind | Platform service (scheduler that calls functions, paths or queue topics) |
| Plans | All plans, public beta. Hobby: 500 creations and 5,000 runs per billing period, cron at most every 15 minutes. Pro and Enterprise: $5 per 1M runs, $10 per 1M creations (Documented). Drains need Pro or Enterprise |
| Signals | Other: execution history and schedule state (dashboard, CLI, SDK, API) · Logs and Traces (from the invoked function or queue consumer) · Activity Log events · Billing lines |
| Exit paths | Log drain and trace drain (the target's records) · CLI pull (`vercel schedules executions list --json`) · Schedules API pull (`https://vercel-schedules.com/v1/schedules`, state only) · Activity Log API, audit log drain (Enterprise) · billing API |
| Verified | docs only, 2026-11-12, no lab capture yet · Vercel CLI 65.14.0 (help output, `vercel activity types`, `vercel metrics schema`) · `GET /v1/billing/charges` for 2026-11-10 |

## 1. What it emits

| Signal | What | Where it lives | Retention |
| --- | --- | --- | --- |
| Execution history | Per schedule: run count, error rate, average duration, next run. Per run: execution ID, scheduled or manual, success or failure. Outcomes come from the recorded function request (for queue targets, the consumer's); runs without one show `unavailable` and are left out of the metrics (Documented) | Project › Schedules (team-wide Schedules page too), `vercel schedules executions list` | Not documented. The CLI defaults to the last 24 hours and takes ranges of up to 30 days per query (Documented) |
| Schedule state | Name, namespace, timezone, expression, jitter, target, `active`/`inactive`, `activeUntil`, `static`/`dynamic`, created and updated times (Documented, API reference) | Dashboard, `vercel schedules list`/`inspect`, `@vercel/schedules`, Schedules API | Current state. A one-time schedule is removed about 30 days after its time (Documented) |
| Logs | The target function's records: report line, your `console` output, timeouts and crashes. Queue targets: the consumer's records | Runtime Logs, `vercel logs` | As for Functions |
| Traces | The target request's spans | Traces page, `vercel traces search`, trace drain | Hobby 3 days, Pro 14 days, Enterprise 14 days (Documented, Tracing GA 2026-11-06) |
| Metrics | None of its own. Runs count as `vercel.function_invocation.*` (and `vercel.queue_operation.*` for queue targets); `vercel metrics schema` lists no schedule metric (Observed, CLI 65.14.0, 111 metrics) | Observability | |
| Activity Log | `schedule-created`, `schedule-updated`, `schedule-deleted`, `schedule-enabled`, `schedule-disabled`, `schedule-invoked` (manual run), `project-custom-environment-schedules-default-updated` (Observed in `vercel activity types`; Documented). Recorded for the dashboard, CLI and API calls by a user, app or integration; not for SDK calls from deployed code (Documented) | Activity Log, `vercel activity`; Audit Log exports and audit log drain on Enterprise | See the Audit Logs entry |
| Billing | `Schedule Firings` and `Schedule Creations`, category `Schedules`, team-level, no region (Captured: zero lines, billing day 2026-11-10) | Usage page, `GET /v1/billing/charges` | See the Billing entry |

No event is emitted for a late, skipped or failed run. Vercel delivers late runs until the occurrence expires (jitter window plus the shortest interval, at least 10 minutes) and then skips it; runs are also skipped while a project is paused and when a Hobby team is over its limits (Documented). Whether a skipped run appears in the execution history: Not documented.

## 2. Out-of-the-box shape

Nothing captured from a run yet. What the docs say each run carries:

### The request a target receives (Documented)

Function and path targets get an empty body; the run's details are in headers:

| Header | Sent to | Value |
| --- | --- | --- |
| `ce-specversion`, `ce-type` | Function and path | `1.0`, `com.vercel.schedule.v1beta` |
| `ce-source` | Function and path | `/schedule/{namespace}/{name}` |
| `ce-id` | Function and path | Execution ID; the same for every delivery of a run |
| `ce-vssscheduleid`, `ce-vssschedulename`, `ce-vssnamespace` | Function and path | Schedule ID, name, namespace |
| `ce-vssscheduledat` | Function and path | Time the expression matched, without jitter |
| `ce-vssschedulesource`, `ce-vssexpression` | Function and path | `static`/`dynamic`, cron expression or one-time local datetime |
| `user-agent` | Path only | `vercel-cron/1.0` |
| `x-vercel-cron-schedule` | Path only | The cron expression |
| `authorization` | Path only | `Bearer <CRON_SECRET>` when set |

Queue targets get a message with the same details as JSON fields (`scheduleId`, `executionId` such as `schx_def456`, `name`, `namespace`, `scheduledAt`, `expression`, `source`, optional `payload`).

### In the drains (Not observed)

Log drain records carry no request headers (Observed for Cron Jobs; see that entry), so none of the `ce-*` values reach the drain on their own. Expected per target:

| Target | Expected drain records |
| --- | --- |
| Path | Like a cron run: `proxy.userAgent: ["vercel-cron/1.0"]`, `proxy.method` `POST` unless `requestMethod: "GET"` |
| Function | A `lambda` record for a function with no public URL; user agent and method not documented |
| Queue topic | The consumer invocation, as in the [Queues](queues.md) entry |

To get the execution ID, schedule name and scheduled time into the records, log them from the handler (`handleSchedule` passes them as `metadata`).

### Execution history (Documented)

`vercel schedules executions list <name> --json` returns runs with "function outcomes and metrics for the selected time range"; the field names aren't documented. Options (Captured: `cli-help-65.14.0.txt`): `--since`/`--until` (at most 30 days apart), `--sort asc|desc`, `--limit` up to 100, `--next` cursor, `--execution` (ID substring), `--environment`, `--git-branch`, `--user`, `--namespace`.

### Billing lines (Captured: `charges-schedules-2026-11-10.jsonl`)

`ServiceName: "Schedule Firings"` (unit `Firings`) and `"Schedule Creations"` (unit `Creations`), `ServiceCategory: "Schedules"`, `Tags: {}`, no `RegionId`; both zero for the lab team. Whether billed lines carry `Tags.ProjectName`: Not observed.

## 3. Extras beyond the default

| Extra | What it adds |
| --- | --- |
| A structured log line per run from the handler | Execution ID, schedule name, scheduled time and outcome in the drained records, which the drains otherwise lack |
| `@vercel/otel` or other OpenTelemetry instrumentation | Spans inside the target, as for any function |
| Queue target | Retries for failed runs, and the Queues signals for each run |
| Starting a Workflow from a schedule | The Workflow signals for long jobs (see [Workflow](workflow.md)) |
| Observability Plus | Per-route function metrics, which include schedule targets; no schedule-specific metric |

## 4. Getting it out

| Signal | Exit path | Tested configuration |
| --- | --- | --- |
| Run records and spans | Log drain, trace drain (the target's records) | Not tested; the lab's drains would carry them (see [Functions](functions.md)) |
| Execution history | Pull `vercel schedules executions list <name> --json` per schedule | Not tested. The [Schedules API](https://vercel.com/docs/schedules/http-api) documents no executions endpoint (2026-11-12) |
| Schedule state | Pull `GET https://vercel-schedules.com/v1/schedules` (access token with `projectId`, or OIDC from a deployment), or `vercel schedules list --json` | Not tested |
| Schedule changes | Activity Log (`vercel activity --type schedule-…`, `GET /v3/events`); audit log drain on Enterprise | Not tested |
| Cost | `GET /v1/billing/charges` | Pulled, 2026-11-12 (zero lines) |

Can't leave Vercel without pulling: the execution history, its run counts and error rates. Not available anywhere: an event for a late, skipped or duplicated run, and SDK-made schedule changes.

## 5. In Bronto

Nothing ingested yet. The runs would arrive with the target's log drain records, so the dataset and fields are those of the [Cron Jobs](cron-jobs.md) entry (Not tested):

| Question | Query (dataset `petclinic-agent/vercel-logs`) | Group by |
| --- | --- | --- |
| Path-schedule runs and outcomes | `"proxy.userAgent.0" = 'vercel-cron/1.0' AND message LIKE 'START%'` | `path`, `statusCode` |
| Runs of a function or queue target, if the handler logs `{"msg":"schedule run","name":…,"executionId":…}` | `message LIKE '%schedule run%'` | the logged `name` |

The execution history has no push path yet; sending `vercel schedules executions list --json` output as events from a scheduled job would put it next to these records (Not tested).

## Gotchas

1. **History in Vercel, not in the drains.** Run counts, error rates and per-run outcomes are only in the dashboard and CLI; no drain, webhook or documented API endpoint carries them (Documented, 2026-11-12).
2. **Jitter and catch-up.** Runs start within a jitter window (Pro default 1 minute, up to 15; Hobby always 15). After a delivery delay, every unexpired occurrence is delivered, so an every-minute schedule can run up to 12 times in a row (Documented).
3. **Duplicates are possible.** Use the execution ID (`ce-id`, `executionId`) to de-duplicate; it stays the same across deliveries (Documented).
4. **No retries for function and path targets.** Only queue targets retry (Documented).
5. **SDK changes leave no audit trail.** Schedules created, changed or deleted by deployed code through `@vercel/schedules` aren't Activity Log events (Documented).
6. **Separate schedules per environment.** Production, each custom environment, each Preview branch and each user's CLI deployments have their own schedules and history; the CLI reads production unless told otherwise (Documented).
7. **Rollback can reset history.** Rolling back to a deployment without a static schedule deletes it; redeploying it creates a new schedule with a new ID and no history (Documented).
8. **Path targets send `POST`.** A migrated Cron Job route that only handles `GET` needs `requestMethod: "GET"` (Documented).

## Samples

| File | What it shows |
| --- | --- |
| [`charges-schedules-2026-11-10.jsonl`](../samples/schedules/charges-schedules-2026-11-10.jsonl) | The two Schedules billing lines (zero), team ID redacted |
| [`activity-types.txt`](../samples/schedules/activity-types.txt) | Schedule-related Activity Log types from `vercel activity types` |
| [`cli-help-65.14.0.txt`](../samples/schedules/cli-help-65.14.0.txt) | `vercel schedules`, `schedules executions` and `schedules executions list` help |

## Sources

- Vercel changelog and blog, read 2026-11-12: [Vercel Schedules is now in public beta](https://vercel.com/changelog/vercel-schedules-is-now-in-public-beta) (2026-11-05), [blog post](https://vercel.com/blog/vercel-schedules).
- Vercel docs, read 2026-11-12: [Schedules](https://vercel.com/docs/schedules) (last updated 2026-10-26), [Managing Schedules](https://vercel.com/docs/schedules/manage) (execution history, Activity Log events), [Concepts](https://vercel.com/docs/schedules/concepts) (jitter, late and missed runs, duplicates, retries), [Handling scheduled runs](https://vercel.com/docs/schedules/handle-runs) (headers, queue message), [vercel schedules](https://vercel.com/docs/cli/schedules), [API reference](https://vercel.com/docs/schedules/http-api), [Limits](https://vercel.com/docs/schedules/limits), [Migrating from Cron Jobs](https://vercel.com/docs/schedules/migrate-from-cron-jobs), [Configuring Tracing](https://vercel.com/docs/tracing/configure-tracing) (retention).
- Lab, 2026-11-12, read-only: Vercel CLI 65.14.0 (`schedules … --help`, `activity types`, `metrics schema`), `vercel api "/v1/billing/charges?from=2026-11-10T08:00:00Z&to=2026-11-11T08:00:00Z"`.
