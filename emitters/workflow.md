# Vercel Workflow

> A workflow run is a series of short function invocations on `/.well-known/workflow/v1/flow`, each triggered by a Vercel Queues message. Without code, Vercel exports only those invocations: log drain records (with the Workflow SDK's `[workflow]` stderr lines) and edge traces. Runs, steps, events and their failures exist as `vercel.workflow_operation.*` metrics and in Observability › Workflows, with no drain; the drained log records don't even carry the run ID. The detailed picture comes from the Workflow SDK's own spans (`workflow.*`, `step.*`, `world.*`, `vqs.*`), which carry `workflow.run.id` (`wrun_…`) and appear once an OpenTelemetry tracer is registered. In the default `linked` trace mode every invocation is its own trace, so a run is a query on `workflow.run.id`, not one trace. The thing most people miss: a sleeping run wakes up every 23 hours to re-sleep. eve starts one 30-day `sessionTimeoutWorkflow` per session, so in the lab about 20,000 idle sessions produced 20,836 function invocations a day with no user traffic at all.

| | |
| --- | --- |
| Kind | Platform service plus library (Workflow SDK, used directly or inside eve and durable-harness) |
| Plans | All plans (Documented); run data kept 1 day on Hobby, 7 days on Pro, 30 days on Enterprise (Documented); drains need Pro or Enterprise; metrics queried here with Observability Plus enabled |
| Signals | Logs · Traces (edge from Vercel, SDK spans from code) · Metrics (inside Vercel only) |
| Exit paths | Log drain (`source: lambda`) · Trace drain · OTLP from code |
| Verified | 2026-10-26 · Vercel CLI 65.2.0 · eve 0.81.0 (bundles Workflow core 5.2.0, `@workflow/world-vercel/5.2.0`) · durable-harness 0.0.1-beta.6 · lab project `petclinic-agent`, data up to 2026-10-26 10:00 UTC |
| Refreshed | 2026-11-12 · docs and changelog to 2026-11-12, one read-only query on the lab's spans of 2026-10-29 to 2026-11-12, no new captures · workflow 5.5.0 (`@workflow/core`, `@workflow/world-vercel` 5.5.0 source) · eve 1.0.0-rc.10 |

## 1. What it emits

| Signal | What | Where it lives | Retention |
| --- | --- | --- | --- |
| Logs | Records of each flow invocation: report line, your step output, SDK lines on stderr (`[workflow]`, `[workflow-sdk]`) | Runtime Logs (filterable by run and step ID in the dashboard, Documented), `vercel logs` | As for Functions (Documented) |
| Traces | Edge and runtime spans per invocation (no code); SDK spans when a tracer provider is registered | Observability › Tracing and › Workflows (trace viewer), trace drain | Hobby 3 days, Pro and Enterprise 14 days since Tracing GA on 2026-11-06; before that they followed runtime log retention (Hobby 1 hour, Pro 1 day, Enterprise 3 days) (Documented) |
| Metrics | `vercel.workflow_operation.runs`, `run_completed`, `run_failed`, `run_cancelled`, `steps`, `step_completed`, `step_failed`, `step_cancelled` | Observability › Workflows, Query, `vercel metrics` | As for other Observability metrics (Documented) |
| Run data | Event log, step inputs and outputs (encrypted; reading needs Owner or Workflow Run Data Viewer) | Observability › Workflows, `npx workflow inspect`, World API | Hobby 1 day, Pro 7 days, Enterprise 30 days after completion (Documented) |

All workflow metrics share 15 dimensions, among them `workflowName`, `workflowRunId`, `workflowStepName`, `stepRunId`, `errorCode`, `region`, `dataRegion`, `deploymentId`, `workflowCoreVersion` and `specVersion` (`reference/vercel-metrics-schema.json`).

## 2. Out-of-the-box shape

### Log records

Every invocation is a queue delivery to `/.well-known/workflow/v1/flow` with `proxy.userAgent: ["vercel-queue/v2beta"]` (see the Queues entry for the record). The record has no `workflowRunId`, step ID or workflow name field (Observed: no such key on any flow record). Only your own log lines can add them.

The SDK writes these lines to stderr. 2026-10-12 to 2026-10-26 10:00 UTC, all on the flow route (Observed):

| Line (start) | `type` / `level` | Count | What happened |
| --- | --- | --- | --- |
| `[workflow] Queue handler failed for message "<id>" on delivery attempt 1; retrying in 1s: [TypeError: fetch failed] { [cause]: Error: Queue request exceeded its 30000ms deadline` | `stderr` / `error` | 60 | A call to the queue or workflow backend timed out; the message is redelivered |
| `[workflow] events transport: rebuilding connection pool after 3 consecutive transport failures` | `stderr` / `warning` | 12 | Backend connection problems, recovered (Captured: `log-workflow-transport-warning.json`) |
| `[workflow-sdk] Background flush of step stream ops failed` | `stderr` / `warning` | 9 | Stream writes from a step failed to flush |
| `[workflow-sdk] Re-executing inline steps owned by this queue message — a previous delivery crashed mid-body and this redelivery is recovering them` + `run wrun_…` + `stepIds […]` | `stderr` / `warning` | 5 | The invocation running a step died; the next delivery re-ran the step (Captured: `log-workflow-reexecuting-steps.json`) |
| `[workflow-sdk] Transient world error during replay; redelivering via queue instead of failing the run` + `StreamError`, `run wrun_… · workflowEntry (eve)`, `error GET listEvents transport failure after 60002ms (UND_ERR_HEADERS_TIMEOUT)`, `deliveryAttempt 1` | `stderr` / `warning` | 1 | Same, during replay (Captured: `log-workflow-transient-world-error.json`) |

Two prefixes (`[workflow]` and `[workflow-sdk]`) and multi-line messages: the run ID is in the message text, on the second line, for some lines and absent from others.

### Spans

**Edge and runtime spans (trace drain, no code).** Each invocation gets an edge trace with the function's calls to the workflow backend (`POST vercel-workflow.com/api/v4/runs/wrun_…/events/run_started`) and the queue (`POST`/`DELETE dub1.vercel-queue.com/…`) as runtime spans. The trace is shown in the Queues entry (Captured: `trace-queue-delivery-edge.ndjson` there).

**Workflow SDK spans (OTLP from code).** One invocation of a sleeping `sessionTimeoutWorkflow` run (Captured: `trace-session-timeout-replay.ndjson`):

```
workflow.route.flow                                      SERVER    112.3 ms   root, no parent
└─ vqs.process                                           CONSUMER  111.9 ms   span link → edge trace
   ├─ workflow.route.get_world                                       0.0 ms
   ├─ workflow.events.ws.connect                         CLIENT     61.8 ms   wss://vercel-workflow.com/…
   └─ workflow.execute sessionTimeoutWorkflow            CONSUMER   88.9 ms   span link → edge trace
      ├─ workflow.replay.load                                       37.6 ms
      │  └─ world.events.create run_started              CLIENT     37.6 ms
      │     └─ http POST                                 CLIENT     35.8 ms   vercel-workflow.com
      ├─ workflow.bundle.compile                                     0.1 ms
      ├─ workflow.run workflow//eve//sessionTimeoutWorkflow          4.5 ms
      │  ├─ workflow.vm.create_context                               1.4 ms
      │  ├─ workflow.bundle.evaluate                                 1.1 ms
      │  ├─ workflow.input.hydrate                                   0.4 ms
      │  └─ workflow.replay.execute                                  1.3 ms
      └─ queue.publish                                   PRODUCER   43.5 ms
         └─ vqs.send                                     PRODUCER   43.1 ms   the next wake-up message
```

**Event writes over WebSocket (dated note, 2026-11-12).** The tree above is Workflow 5.2.0. Since 5.2.0 (released 2026-10-08, announced in the changelog on 2026-11-09), the Workflow SDK on Vercel sends event and stream writes over one WebSocket per delivery instead of one HTTP request per write (Documented). The span shape barely changes: for a WebSocket write the SDK still emits an `http POST` client span with the same `url.full`, so per-event traces and dashboards keep working, and marks it with `workflow.events.transport = ws`, `network.protocol.name = websocket`, `workflow.events.ws.url` and `workflow.events.ws.req_id` (the join key to the server's log line). An HTTP write carries `workflow.events.transport = http` (`@workflow/world-vercel` 5.5.0 source; both values in the lab's 5.2.0 spans, Observed). What does change: only real HTTP writes show up as Vercel runtime spans (`POST vercel-workflow.com/…` in the trace drain) and in the outgoing-requests view; WebSocket writes appear only in the SDK's spans.

In the lab's spans from 2026-10-29 to 2026-11-12 (`@workflow/world-vercel/5.2.0`, Observed), most event writes went over the WebSocket; `run_created`, most `run_started` and most `hook_received` went over HTTP:

| Event type | `ws` | `http` |
| --- | --- | --- |
| `step_completed` | 41,968 | |
| `hook_created` | 33,099 | |
| `step_started` | 29,926 | |
| `attr_set` | 20,793 | |
| `run_started` | 17,399 | 33,031 |
| `run_created` | | 17,423 |
| `wait_created`, `step_created` | 8,533, 8,191 | |
| `hook_received` | 692 | 3,407 |

A sleeping run's wake-up (the tree above) writes only `run_started`, over HTTP, while `workflow.events.ws.connect` is still opening. Workflow 5.5.0 (2026-11-10) makes that explicit: `run_started` is written over HTTP while the socket is connecting, and an HTTP write that tried the socket first carries `workflow.events.transport_fallback` = `connecting` or `no_channel` (the run had no socket). Writes that never tried the socket carry no such attribute (Documented).

Span names seen on a day with user traffic (2026-10-22, eve): `workflow.route.flow`, `workflow.start <name>`, `workflow.execute <name>`, `workflow.run <workflow id>`, `workflow.replay.*`, `workflow.bundle.*`, `workflow.vm.create_context`, `workflow.input.hydrate`, `workflow.stream.write|flush|read|read.connect|read.complete|read.resolve_key|ws.connect|ws.close.cleanup`, `workflow.events.ws.connect`, `step.execute <name>`, `step.execute`, `step.hydrate`, `step.dehydrate`, `hook.resume`, `world.events.create <event type>`, `world.events.list`, `world.events.createBatch`, `world.runs.get`, `world.hooks.getByToken`, `world.parse`, `world.validate`, `http GET|POST`, `vqs.send`, `vqs.process`, `queue.publish` (Observed). The SDK spans arrive as service `petclinic-agent`, whatever service exports them.

Key attributes (Captured: `span-workflow-*.json`, `span-step-execute.json`, `span-world-events-create.json`):

| Span | Attributes |
| --- | --- |
| `workflow.start <name>` | `workflow.run.id`, `workflow.name`, `workflow.run.status: pending`, `workflow.run.spec_version: 8`, `workflow.serialization.stored_bytes` |
| `workflow.execute <name>` | `workflow.run.id`, `workflow.name`, `workflow.run.status` (`workflow_suspended`), `workflow.trace.mode: linked`, `workflow.trace.propagated`, **`workflow.queue.overhead_ms`**, `workflow.started_at`, `workflow.steps.created`, `workflow.waits.created`, `workflow.hooks.created`, `messaging.system: vercel-queue`, `messaging.destination.name`, `messaging.message.id`; one span link to the edge trace |
| `workflow.run <workflow id>` | `workflow.run.id`, `workflow.execution.mode` (`replay` or `retained`), `workflow.run.status: running`, `workflow.events.count`, `workflow.suspension.state`, `workflow.suspension.wait_count`, `.hook_count`, `.step_count` |
| `step.execute <name>` | `step.name` (`step//eve@0.81.0//turnStep`), `step.id`, `step.status`, `step.max_retries: 3`, `workflow.run.id`, `workflow.name` |
| `step.execute` (no name) | Nothing beyond the resource: no step name, no run ID (82,221 such spans in 7 days) |
| `world.events.create <type>` | `workflow.run.id`, `rpc.method`, `rpc.service: workflow-server`, `peer.service: workflow-server` |
| `http POST` (to the workflow backend) | `url.full`, `server.address: vercel-workflow.com`, `http.request.method`, `http.response.status_code`, `workflow.event.type`, `workflow.client.version: @workflow/world-vercel/5.2.0` |
| `workflow.route.flow` | `http.route`, `http.response.status_code`, **`http.host`**, **`http.user_agent`** (`vercel-queue/v2beta`), `vercel.request_id`, `faas.instance`, `workflow.route.invocation_count`, `workflow.route.entrypoint_age_ms` |

Attributes added after 5.2.0 (Documented, release notes; Not observed):

| Since | Attribute | Where |
| --- | --- | --- |
| 5.3.0 (2026-11-02) | `workflow.start_hook.outcome`, `.rejection_reason`, `.error_code`, `.conflicting_run_id`, `.confirm_attempts`, `.enqueue_failed`, `.trigger` (names from `@workflow/core` 5.5.0 source) | The `workflow.start` span of a `start({ hook })` call (idempotent starts) and the invocation span of its queued copy |
| 5.5.0 (2026-11-10) | `workflow.events.transport_fallback` | `http POST` event writes that fell back from the WebSocket |
| 5.5.0 | `step.delivery.log_read` | Step delivery spans on spec 9 runs: what the delivery read from the event log |
| 5.5.0 | `http.route` includes the base path | `workflow.route.flow` with Next.js `workflows.experimentalRoutePrefix` |

5.5.0 also adds an OpenTelemetry counter, `workflow.queue.delivery.refused` (meter `workflow`), for flow-route deliveries refused for lacking the app's queue key. It applies to Worlds that declare `queueAuthMode: 'loopback'` (local and Postgres); `@workflow/world-vercel` 5.5.0 declares none, so on Vercel it isn't expected (source check, Not observed). New eve runs use spec version 9 since eve 1.0.0-rc.3 (2026-11-03), so `workflow.run.spec_version` and the `specVersion` metric dimension read `9` for them.

Every SDK span also carries `operation.name` (`workflow`, `workflow.client`, `workflow.consumer`, `workflow.server`, `workflow.producer`, `vercel_queue.consumer`, `vercel_queue.producer`) and `env: production`.

### Attributes outside current OpenTelemetry conventions

Some of Workflow's span attributes are deprecated OpenTelemetry names or Datadog-style tags (Observed, 2026-10-25 and 2026-10-22):

| Attribute | Where | Current convention |
| --- | --- | --- |
| `http.host` | `workflow.route.flow` | `server.address` |
| `http.user_agent` | `workflow.route.flow` (20,836 on 2026-10-25) | `user_agent.original` |
| `messaging.operation` | `vqs.process` | `messaging.operation.type` (which `queue.publish` and `workflow.execute` already use) |
| `peer.service` | `queue.publish`, `world.*`, `http POST`, `workflow.events.ws.connect` | `service.peer.name` |
| `operation.name`, `env` | Every SDK span | No OpenTelemetry equivalent; Datadog's span tags |

`resource.name` is not on Workflow spans. It is on eve's agent spans (`agent.step`, `chat …`, `invoke_agent …`, `execute_tool …`) and on durable-harness's; see the Agent Runs entry.

The trace drain's runtime spans for outgoing calls also use the older `http.method`, `http.host`, `http.target`, `http.status_code` (see the Queues entry).

### Metrics

Pre-aggregated by Vercel, from `vercel metrics … --json` (Captured: `metrics-*.json`):

```
$ vercel metrics vercel.workflow_operation.runs --group-by workflowName   (runs created)
2026-10-20  sessionTimeoutWorkflow 11,182 · workflowEntry 11,182
2026-10-21  sessionTimeoutWorkflow 6,130 · workflowEntry 6,128
2026-10-22  sessionTimeoutWorkflow 1,448 · workflowEntry 1,448 · durable-harness clinic-ops 13 · workflowToolRunWorkflow 4
2026-10-23  sessionTimeoutWorkflow 1,328 · workflowEntry 1,328 · durable-harness clinic-ops 22 · workflowToolRunWorkflow 8
2026-10-24, 25  none

$ vercel metrics vercel.workflow_operation.steps --group-by workflowName   (2026-10-22)
workflowEntry 5,942 · clinic-ops 65 · workflowToolRunWorkflow 16          step_completed: identical; step_failed: none

$ vercel metrics vercel.workflow_operation.runs --group-by region --group-by dataRegion   (2026-10-22)
dub1/dub1 2,900 · dub1/iad1 13 (durable-harness)

$ vercel metrics vercel.workflow_operation.runs --group-by workflowCoreVersion --group-by specVersion
5.2.0 / 8: 2,900 · (empty) / 8: 13 (durable-harness)
```

`run_completed` and `run_failed` returned no rows for any day: eve's sessions stay open waiting for the next message, so neither eve workflow completed in the window. `workflowName` uses the workflow ID (`workflow//eve//sessionTimeoutWorkflow`, `workflow//durable-harness@0.0.1-beta.6//clinic-ops`).

### eve's session timeout workflow

eve 0.81.0 starts a `sessionTimeoutWorkflow` next to every session's `workflowEntry` run (`startSessionTimeoutStep`), with a deadline of `DEFAULT_SESSION_TIMEOUT_MS = 2592e6` (30 days) unless the agent sets `sessionTimeoutMs`. The workflow is `await sleep(deadline)` followed by one signal step (`node_modules/eve/dist/src/execution/session/timeout*.js`).

Workflow core caps a single wait at `WORKFLOW_WAIT_CONTINUATION_MAX_DELAY_SECONDS`, default 82,800 s (23 hours). A longer sleep is a chain of delayed queue messages: each wakes the run, replays it, finds the deadline not yet reached and sends the next message. One run's replays (Captured: `spans-one-run-replays.ndjson`):

```
wrun_41M5D4BXGE3GG4KQ91QYSR46D3  workflow.run …sessionTimeoutWorkflow  execution.mode replay  wait_count 1
2026-10-20T17:04:56 → 10-21T16:04:57 → 10-22T15:04:57 → 10-23T14:04:58 → 10-24T13:04:58 → 10-25T12:04:59
                     23.0 h          23.0 h          23.0 h          23.0 h          23.0 h
```

Every run wakes once every 23 hours, not every hour. The lab created 20,099 of these runs between 2026-10-19 and 2026-10-23 (metrics above; `createSessionStep` spans: 20,099). On 2026-10-25, with no user traffic, they produced (Observed):

| What | 2026-10-25 |
| --- | --- |
| `workflow.run …sessionTimeoutWorkflow` spans (`replay`, `suspended`, `wait_count = 1`) | 20,836 |
| Function invocations on `/.well-known/workflow/v1/flow` (`vercel.function_invocation.count`) | 20,836 |
| Queue messages sent / received / deleted (all on the `sessionTimeoutWorkflow` topic) | 20,832 / 20,843 / 20,828 |
| `workflow.queue.overhead_ms` on `workflow.execute` | 82,800,266 ms (the 23 h delay) |

That is about 20,099 × 24 / 23 wake-ups a day, or about 870 distinct runs in any hour. A 30-day session timeout means about 31 wake-ups per session, each one a function invocation, three queue operations and a `run_started` event, until the session times out or the run is cancelled.

## 3. Extras beyond the default

| Extra | What it adds | Cost |
| --- | --- | --- |
| An OpenTelemetry tracer provider (`@vercel/otel` in `instrumentation.ts`, or the SDK with an OTLP exporter) | All SDK spans above. The SDK depends only on `@opentelemetry/api` and starts emitting once a provider is registered (Documented) | Span volume. The sleeping-run replays above are about 16 spans each |
| `WORKFLOW_TRACE_MODE=continuous` | One trace ID for the whole run instead of one per invocation (Documented; the lab runs the default `linked`, Observed as `workflow.trace.mode: linked`) | None |
| Run attributes (`setAttributes()`, `start(…, { attributes })`) | Searchable attributes in Observability › Workflows (Documented, not used in the lab) | Counts as workflow events |
| A structured log line in steps with `workflowRunId` and step name (from `getWorkflowMetadata()`) | The run ID in the log drain, where Vercel doesn't put it | None |
| Observability Plus | Workflow metrics in Query and `vercel metrics` | See Observability Plus pricing |

## 4. Getting it out

| Signal | Exit path | Tested configuration |
| --- | --- | --- |
| Flow route logs, `[workflow]` lines | Log drain | Drain `petclinic-agent-logs` |
| Edge and runtime spans | Trace drain | Drain `petclinic-agent-traces` |
| Workflow SDK spans | Trace drain (with `@vercel/otel`) or an OTLP exporter in code, not both | eve exports with `OTLPTraceExporter`; the same spans also reach the trace drain, so the lab receives them twice (see the Functions entry for which path to keep) |
| Run and step counts, failures, `errorCode` | None. Pull `vercel metrics vercel.workflow_operation.* --json` on a schedule, or read runs and events through the World API (`getWorld()`) from code | `vercel metrics vercel.workflow_operation.runs --group-by workflowName --since … --until … --json` |
| Step inputs and outputs | Stay in Vercel (encrypted) | |

## 5. In Bronto

| Data | Dataset | Field names |
| --- | --- | --- |
| Flow route logs | `petclinic-agent/vercel-logs` | `path = '/.well-known/workflow/v1/flow'`, `message`, `level` |
| eve's Workflow SDK spans | `.traces/petclinic-agent` (direct export; the same spans are also in `.traces/vercel-traces` via the drain) | `"$workflow.run.id"`, `"$workflow.name"`, `"$workflow.execution.mode"`, `"$step.name"`, `"$span.name"` |
| durable-harness | `.traces/petclinic-web` (Workflow spans), `.traces/petclinic-ops` (agent spans) | as above |

Queries, run against 2026-10-19 10:00 to 2026-10-26 10:00 UTC on `.traces/petclinic-agent` unless noted:

| Question | Query | Group by | Result |
| --- | --- | --- | --- |
| Invocations per workflow and mode | `"$span.name" LIKE 'workflow.run %'` | `"$workflow.name"`, `"$workflow.execution.mode"` | `sessionTimeoutWorkflow` replay 120,578 · `workflowEntry` retained 82,518, replay 25,771 · `workflowToolRunWorkflow` 78 |
| Everything one run did | `"$workflow.run.id" = 'wrun_41M5D4BXGE3GG4KQ91QYSR46D3'` | | 6 invocations, 23 h apart (above) |
| Sleeping runs waking today (2026-10-25) | `"$span.name" = 'workflow.run workflow//eve//sessionTimeoutWorkflow' AND "$workflow.suspension.wait_count" = 1` | | 20,836 |
| Steps by name | `"$span.name" LIKE 'step.execute %'` | `"$span.name"`, `"$span.status_code"` | `turnStep` 41,944 · `startSessionTimeoutStep` 20,220 · `createSessionStep` 20,099, all OK |
| Retries and cancellations | `"$span.name" IN ('world.events.create step_retrying', 'world.events.create run_cancelled')` | `"$span.name"` | `step_retrying` 11 · `run_cancelled` 4 |
| SDK failures in logs | `path = '/.well-known/workflow/v1/flow' AND type = 'stderr' AND (message LIKE '[workflow]%' OR message LIKE '[workflow-sdk]%')` (log dataset) | `level` | `error` 59 · `warning` 27 |
| Error-status spans | `"$span.status_code" = 'STATUS_CODE_ERROR'` | `"$span.name"` | `http POST` 1,767 · `GET` 1,589 · `workflow.events.ws.connect` 1,031 · `hook_created` 608 · `run_created` 277 |
| Event writes by transport (2026-10-29 to 2026-11-12, run 2026-11-12) | `"$span.name" = 'http POST' AND "$server.address" = 'vercel-workflow.com'` | `"$workflow.events.transport"`, `"$workflow.event.type"` | `ws` 160,985 · `http` 53,861 (table in section 2) |

Most error-status spans are conflicts that the SDK expects: `world.events.create hook_created` fails with `Workflow hook with ID hook_… already exists` (HTTP `409`) when a redelivery repeats a step, and `run_created`/`step_started` return `409` the same way. Exclude `409` before alerting on span errors.

## Gotchas

1. **A long sleep is not free.** A sleeping run wakes every 23 hours and runs a function to go back to sleep. eve's default 30-day session timeout gives every session about 31 such wake-ups. In the lab, 20,099 idle sessions caused 20,836 invocations, about 62,500 queue operations and 20,836 `run_started` events a day, with no users (Observed). Counting distinct runs per hour (about 870) and reading it as "each run replays hourly" overstates the rate 23 times: each run wakes once every 23 hours.
2. **Drained logs have no run ID.** The dashboard filters logs by run and step ID, but the drained record has neither. Add them to your own log lines, or join through spans by time and `vercel.request_id`.
3. **A run is many traces.** In the default `linked` mode each invocation starts a new trace (`workflow.route.flow` has no parent) and points to the delivery's edge trace through a span link on `vqs.process` and `workflow.execute`. Search by `workflow.run.id`.
4. **`workflow.queue.overhead_ms` includes sleeps.** It measured 82,800,266 ms on a sleeping run's wake-up. Use it for queue latency only on runs that weren't waiting (Captured: `span-workflow-execute.json`).
5. **Retried failures log at `error`.** `[workflow] Queue handler failed … retrying in 1s` is `level: error` even though the run continues. No run failed in the lab (`run_failed`: no rows), while 60 such lines were logged.
6. **Expected conflicts carry error status.** 608 `hook_created` and 277 `run_created` spans have `STATUS_CODE_ERROR` with HTTP `409`; these are idempotent repeats, not failures.
7. **Two `step.execute` spans per step, one empty.** The named one (`step.execute turnStep`) has `step.name` and `workflow.run.id`; a second span called just `step.execute` has neither. Filter on `step.execute %` (with the space) when counting steps.
8. **Durable-harness differs.** Its runs report `dataRegion: iad1` while executing in `dub1`, and an empty `workflowCoreVersion` (Observed, 2026-10-22).
9. **Deprecated and vendor-specific attributes.** `http.host`, `http.user_agent`, `messaging.operation`, `peer.service` instead of the current names; `operation.name` and `env` on every span. Map them in the pipeline if your backend relies on current semantic conventions.
10. **The trace drain misses part of the queue-triggered traces.** On 2026-10-25 the drain held traces for 17,482 of 20,836 flow invocations (84%), missing in every hour, while the log drain, the direct OTLP export and `vercel.function_invocation.count` all had 20,834–20,836. Count runs and invocations from the log drain or the metrics, not from drained spans (Observed; cause unknown, see the Functions entry). Vercel hasn't documented a cause or change; still the case on 2026-11-12 (docs and releases checked).
11. **Fewer runtime spans for event writes.** Since Workflow 5.2.0, event and stream writes go over a WebSocket; only HTTP writes (`run_created`, most `run_started`, fallbacks) appear as `POST vercel-workflow.com/…` runtime spans in the trace drain. The SDK's own `http POST` spans cover both; split them with `workflow.events.transport` (Observed, `@workflow/world-vercel` 5.2.0).

## Samples

| File | What it shows |
| --- | --- |
| [`trace-session-timeout-replay.ndjson`](../samples/workflow/trace-session-timeout-replay.ndjson) | All 16 SDK spans of one sleeping-run wake-up |
| [`spans-one-run-replays.ndjson`](../samples/workflow/spans-one-run-replays.ndjson) | One run's six wake-ups, 23 h apart |
| [`span-workflow-route-flow.json`](../samples/workflow/span-workflow-route-flow.json) | Root of an invocation: `http.host`, `http.user_agent`, `operation.name` |
| [`span-workflow-execute.json`](../samples/workflow/span-workflow-execute.json) | `workflow.execute`: span link, `workflow.queue.overhead_ms`, trace mode |
| [`span-workflow-run-replay.json`](../samples/workflow/span-workflow-run-replay.json) | `workflow.run` of a sleeping run (`replay`, `suspended`) |
| [`span-workflow-run-retained.json`](../samples/workflow/span-workflow-run-retained.json) | `workflow.run` of a session (`retained`, 3 hooks) |
| [`span-workflow-start.json`](../samples/workflow/span-workflow-start.json) | `workflow.start` at run creation |
| [`span-step-execute.json`](../samples/workflow/span-step-execute.json) | A named step span |
| [`span-step-execute-bare.json`](../samples/workflow/span-step-execute-bare.json) | The unnamed `step.execute` span |
| [`span-world-events-create.json`](../samples/workflow/span-world-events-create.json) | An event write to the workflow backend |
| [`span-http-post-world.json`](../samples/workflow/span-http-post-world.json) | The HTTP call under it |
| [`log-workflow-transport-warning.json`](../samples/workflow/log-workflow-transport-warning.json) | `[workflow] events transport` warning |
| [`log-workflow-reexecuting-steps.json`](../samples/workflow/log-workflow-reexecuting-steps.json) | Step re-run after a crashed delivery |
| [`log-workflow-transient-world-error.json`](../samples/workflow/log-workflow-transient-world-error.json) | Transient backend error during replay |
| [`metrics-runs-20.json`](../samples/workflow/metrics-runs-20.json) … [`metrics-runs-23.json`](../samples/workflow/metrics-runs-23.json) | Runs created per workflow and day |
| [`metrics-steps-22.json`](../samples/workflow/metrics-steps-22.json) | Steps per workflow |
| [`metrics-run_failed-22.json`](../samples/workflow/metrics-run_failed-22.json) | Failed runs: empty |
| [`metrics-region-22.json`](../samples/workflow/metrics-region-22.json) | Runs by execution and data region |
| [`metrics-ver-22.json`](../samples/workflow/metrics-ver-22.json) | Runs by core version and spec version |

## Sources

- Vercel docs, read 2026-10-16 to 2026-10-20: [Vercel Workflows](https://vercel.com/docs/workflows), [Workflows pricing](https://vercel.com/docs/workflows/pricing), [Workflow SDK tracing](https://workflow-sdk.dev/docs/observability/tracing) (`WORKFLOW_TRACE_MODE`, span names), changelog [logs filtering for Workflows](https://vercel.com/changelog/logs-filtering-for-vercel-workflows-now-available).
- Read 2026-11-12: changelog [Workflow SDK now writes over WebSockets on Vercel](https://vercel.com/changelog/workflow-writes-now-use-websockets-on-vercel) (2026-11-09), [Workflow SDK adds idempotent starts](https://vercel.com/changelog/atomic-start-hooks-in-the-workflow-sdk) (2026-11-04), [Vercel Tracing is now generally available](https://vercel.com/changelog/vercel-tracing-is-now-generally-available) (2026-11-06); release notes [workflow 5.3.0](https://github.com/vercel/workflow/releases/tag/workflow%405.3.0), [5.4.0](https://github.com/vercel/workflow/releases/tag/workflow%405.4.0), [5.5.0](https://github.com/vercel/workflow/releases/tag/workflow%405.5.0); source `@workflow/core` 5.5.0 (`dist/telemetry.js`, `dist/telemetry/semantic-conventions.js`) and `@workflow/world-vercel` 5.5.0 (`dist/events-v4.js`, `dist/telemetry.js`); eve [1.0.0-rc.3](https://github.com/vercel/eve/releases/tag/eve%401.0.0-rc.3) (spec version 9).
- Code: eve 0.81.0 `node_modules/eve/dist/src/execution/session/timeout.js`, `timeout-workflow.js`, `timeout-steps.js`, `entry.js`; bundled Workflow core (`WORKFLOW_WAIT_CONTINUATION_MAX_DELAY_SECONDS`, default 82800).
- Lab: lab backend (Bronto EU) datasets `.traces/petclinic-agent`, `.traces/vercel-traces`, `.traces/petclinic-web`, `.traces/petclinic-ops`, `petclinic-agent/vercel-logs`, 2026-10-12 to 2026-10-26 10:00 UTC; Vercel CLI 65.2.0 (`vercel metrics vercel.workflow_operation.*`, `vercel metrics schema`); transport split: `"$span.name" = 'http POST' AND "$server.address" = 'vercel-workflow.com'` grouped by `"$workflow.events.transport"`, `"$workflow.event.type"` on `.traces/petclinic-agent`, 2026-10-29 to 2026-11-12, run 2026-11-12. `vercel metrics schema` with CLI 65.14.0 (2026-11-12): the eight `vercel.workflow_operation.*` metrics and their dimensions are unchanged.
