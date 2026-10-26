# Vercel Queues

> Vercel Queues delivers each message by calling a function in your deployment, so what leaves Vercel without code is that function's telemetry: log drain records and an edge trace with the user agent `vercel-queue/v2beta`, plus runtime spans for the function's own calls to the queue API (`POST …vercel-queue.com/api/v3/topic/<topic>` to send, `DELETE …/lease/…` to acknowledge). The queue's own numbers (sent, received, deleted, redeliveries, message age) exist only as `vercel.queue_operation.*` metrics inside Vercel, with no drain. Producer and consumer spans (`queue.publish`, `vqs.send`, `vqs.process`) come from the library in your code and need an OpenTelemetry setup. In the lab, Queues is used only underneath Vercel Workflow (eve and durable-harness); every topic is a Workflow topic. The trap: "message age on receive" includes the delay a sender asks for, so a workflow that sleeps shows messages 23 hours old with nothing wrong.

| | |
| --- | --- |
| Kind | Platform service (public beta), used directly through `@vercel/queue` or underneath Vercel Workflow |
| Plans | All plans (Documented); drains need Pro or Enterprise; metrics queried here with Observability Plus enabled |
| Signals | Logs (consumer function) · Traces (edge, runtime, library) · Metrics (inside Vercel only) |
| Exit paths | Log drain (`source: lambda`) · Trace drain · OTLP from code |
| Verified | 2026-10-26 · Vercel CLI 65.2.0 · eve 0.81.0 (bundles Workflow 5.2.0 and its Vercel Queue client) · durable-harness 0.0.1-beta.6 · lab project `petclinic-agent`, data up to 2026-10-26 10:00 UTC |

## 1. What it emits

| Signal | What | Where it lives | Retention |
| --- | --- | --- | --- |
| Logs | The consumer function's records for each delivery (report line, your output, library errors) | Runtime Logs, `vercel logs` | As for Functions (Documented) |
| Traces | Edge span for each delivery (`POST <consumer route>`), runtime spans for queue API calls, library spans if OpenTelemetry is registered | Observability › Tracing, trace drain | As for Functions (Documented) |
| Metrics | `vercel.queue_operation.count`, `.delivery_count`, `.message_age_on_receive_ms`, `.retention_seconds`, `.visibility_timeout` | Observability › Queues, Query, `vercel metrics` | As for other Observability metrics (Documented) |
| Events | None. No event for an expired or dropped message, no dead-letter queue (Documented) | | |

All five metrics share the dimensions `queueName`, `queueRegion`, `consumerGroup`, `messageId`, `eventType`, `deliveryCount`, `messageAgeMs`, `notificationUrl`, `contentType`, `projectId`, `environment` (`reference/vercel-metrics-schema.json`). `eventType` takes the values `QUEUE_SENT`, `QUEUE_NOTIFIED`, `QUEUE_RECEIVED`, `QUEUE_DELETED`, `QUEUE_VISIBILITY_CHANGED` and `QUEUE_EMPTY` (Observed; 14 `QUEUE_EMPTY` on 2026-10-22).

## 2. Out-of-the-box shape

### Log records

A delivery is a `POST` from Vercel to the consumer route with `proxy.userAgent: ["vercel-queue/v2beta"]`. With Workflow the consumer route is `/.well-known/workflow/v1/flow` (Captured: `log-queue-delivery-report.json`):

| Field | Value | Note |
| --- | --- | --- |
| `proxy.userAgent` | `["vercel-queue/v2beta"]` | Marks a queue delivery |
| `proxy.method`, `path` | `POST`, `/.well-known/workflow/v1/flow` | |
| `host`, `deploymentId` | `petclinic-agent-f2n83i7x4-brontoio.vercel.app`, `dpl_FjmZ…` | The deployment that **published** the message, not the current production one |
| `proxy.region`, `executionRegion` | `dub1`, `dub1` | Delivery enters in the queue's region |
| `traceId`, `spanId` | | Point to the edge trace of the delivery, not to the library spans (see Spans) |

Nothing in the record names the topic, the message ID or the delivery attempt. Those are in the metrics and in the library spans.

On 2026-10-25 the lab received 20,834 deliveries. 20,576 of them went to 38 older deployments and 258 to the current one, because a message is delivered to the deployment that sent it (Observed). Deliveries by region over 7 days: `dub1` 156,163 · `iad1` 8,730 (messages from runs started before the functions were pinned to `dub1`) · `iad1 → dub1` 420 · `dub1 → iad1` 3.

### Library error lines

The Queue client inside the Workflow runtime writes to stderr. Seen in the lab, 2026-10-12 to 2026-10-26 10:00 UTC (Observed):

| Line (start) | `type` / `level` | Count | Meaning |
| --- | --- | --- | --- |
| `[workflow] Queue handler failed for message "<id>" on delivery attempt 1; retrying in 1s: [TypeError: fetch failed] { [cause]: Error: Queue request exceeded its 30000ms deadline` | `stderr` / `error` | 60 (55 with this cause, 5 with other backend transport failures; one record arrived without `type`) | The handler failed; the message is retried. Logged at `error` though it recovers (Captured: `log-queue-handler-failed.json`) |
| `Visibility extension failed with client error for receipt handle … (stopping retries): … [MessageNotAvailableError]: Message … not available for processing: Message is not currently in-flight` | `stderr` / `error` | 1 | The consumer tried to extend its lease on a message it no longer held (Captured: `log-visibility-extension-failed.json`) |

All of them on `/.well-known/workflow/v1/flow` in `dub1`.

### Metrics

From `vercel metrics … --json` for 2026-10-25 (Captured: `metrics-*.json`):

```
$ vercel metrics vercel.queue_operation.count --group-by eventType
QUEUE_NOTIFIED 20,843 · QUEUE_RECEIVED 20,843 · QUEUE_SENT 20,832 · QUEUE_DELETED 20,828 · QUEUE_VISIBILITY_CHANGED 24

$ vercel metrics vercel.queue_operation.count --group-by deliveryCount --filter "eventType eq 'QUEUE_RECEIVED'"
1: 20,827 · 2: 16                         (2026-10-22: 1: 22,737 · 2: 53)

$ vercel metrics vercel.queue_operation.count --group-by queueRegion
dub1 79,242 · iad1 4,128

$ vercel metrics vercel.queue_operation.message_age_on_receive_ms --aggregation p50|p95|max --group-by queueName
__eve…--sessionTimeoutWorkflow  p50 82,800,000 ms · p95 82,801,000 ms · max 83,106,000 ms   (23 hours)
```

Queue names as they appear in the metrics on a day with user traffic (2026-10-22, `QUEUE_SENT`):

| `queueName` | Sent | p95 age on receive |
| --- | --- | --- |
| `__eve706574636c696e69632d6167656e74_wkf_workflow_workflow--eve--sessionTimeoutWorkflow` | 20,920 | 82,801,000 ms |
| `__eve706574636c696e69632d6167656e74_wkf_workflow_workflow--eve--workflowEntry` | 3,258 | 1,000 ms |
| `__eve…_wkf_workflow_workflow--eve--workflowToolRunWorkflow` | 8 | 0 ms |
| `__harness_wkf_workflow_session` (durable-harness) | 13 | 0 ms |

The middle part of eve's names is the project name in hex (`706574636c696e69632d6167656e74` = `petclinic-agent`). `consumerGroup` is `default` on receive, notify and delete events and empty on send events.

Read message age with the workflow in mind: every `sessionTimeoutWorkflow` message on 2026-10-25 was received exactly 23 hours after it was sent, because the Workflow runtime sends a sleeping run's wake-up message with the longest delay it allows (see the Workflow entry). For queues without delays (`workflowEntry`), p95 age was 1 s.

### Spans

**Edge and runtime spans (trace drain, no code).** Each delivery gets an edge root span and the function's outgoing queue calls show up as runtime spans (Captured: `trace-queue-delivery-edge.ndjson`):

```
POST /.well-known/workflow/v1/flow                                   vercel.edge-network        125.2 ms
├─ Resolve Deployment                                                vercel.edge-network          7.8 ms
├─ Resolve Route                                                     vercel.edge-network          0.4 ms
└─ Invoke Function                                                   vercel.serverless-runtime  108.7 ms
   ├─ POST vercel-workflow.com/api/v4/runs/wrun_…/events/run_started vercel.serverless-runtime   34.0 ms
   ├─ POST dub1.vercel-queue.com/api/v3/topic/<topic>                vercel.serverless-runtime   25.0 ms   send the next message
   ├─ DELETE dub1.vercel-queue.com/api/v3/topic/<topic>/consumer/default/lease/<handle>   22.0 ms   acknowledge
   ├─ waitUntil                                                      vercel.serverless-runtime    8.6 ms
   └─ POST ingestion.eu.bronto.io/v1/traces                          vercel.serverless-runtime    8.0 ms   the app's own OTLP export
```

- The edge span has `http.request.header.user-agent: vercel-queue/v2beta` and a **parent span ID** (`4908ace3cceda9dc`) that isn't in the drain: the queue service's own span, which Vercel doesn't export (Captured: `span-queue-delivery-edge.json`).
- The runtime spans for queue calls use older HTTP attributes: `http.method`, `http.host`, `http.target`, `http.status_code` (`201` on send) (Captured: `span-runtime-queue-send.json`, `span-runtime-queue-ack.json`).

**Library spans (OTLP from code).** The Queue client inside the Workflow runtime emits spans through `@opentelemetry/api` when a tracer provider is registered (Captured: `span-vqs-send.json`, `span-vqs-process.json`, `span-queue-publish.json`):

| Span | Kind | Attributes |
| --- | --- | --- |
| `vqs.process` | `CONSUMER` | `messaging.system: vercel-queue`, `messaging.operation: process`, `operation.name: vercel_queue.consumer`, one span link to the delivery's `Invoke Function` span |
| `queue.publish` | `PRODUCER` | `messaging.destination.name`, `messaging.message.id`, `messaging.operation.type: publish`, `peer.service: vercel-queue`, `rpc.system: vercel-queue`, `rpc.service: vqs`, `rpc.method: publish`, `operation.name: workflow.producer` |
| `vqs.send` | `PRODUCER` | `messaging.destination.name`, `messaging.message.id`, `operation.name: vercel_queue.producer` |

These spans start a **new trace** per delivery: the function's root span (`workflow.route.flow`) has no parent, and `vqs.process` and `workflow.execute` reach the edge trace only through a span link. On `vqs.send`, `messaging.destination.name` uses the metric spelling (`…workflow--eve--sessionTimeoutWorkflow`); on `queue.publish` and `workflow.execute` it uses slashes (`…workflow//eve//sessionTimeoutWorkflow`).

`vqs.process` ended with an error status 32 times in 7 days, with messages such as `Message 9-1M1hkk… not available for processing: temporarily locked. Try again later.` (Observed).

## 3. Extras beyond the default

| Extra | What it adds | Cost |
| --- | --- | --- |
| Observability Plus | Queue metrics in Query and `vercel metrics`, the Observability › Queues view, the "Queue Retry Depth" alert preset (Documented) | See Observability Plus pricing |
| An OpenTelemetry tracer provider in the consumer (`@vercel/otel`, or the SDK with an OTLP exporter) | `vqs.*` and `queue.publish` spans with topic and message ID | None beyond span volume |
| A structured log line in the handler | `messageId`, `deliveryCount`, `topicName`, `consumerGroup` from the handler's metadata as queryable fields in the log drain (the handler receives them, Documented) | None |
| `traceparent` in message headers (direct `@vercel/queue` use) | Joins producer and consumer traces; `send()` accepts headers (Documented; the lab doesn't use `@vercel/queue` directly) | None |

## 4. Getting it out

| Signal | Exit path | Tested configuration |
| --- | --- | --- |
| Consumer logs | Log drain | Drain `petclinic-agent-logs` (see the Functions entry) |
| Edge and runtime spans | Trace drain | Drain `petclinic-agent-traces` |
| `vqs.*`, `queue.publish` spans | Trace drain (with `@vercel/otel`) or an OTLP exporter in code, not both | eve exports with `OTLPTraceExporter` and the project also has a trace drain; the lab receives these spans twice (see the Functions entry for which path to keep) |
| Queue metrics: sent, received, deleted, redeliveries, message age | None. Pull with `vercel metrics vercel.queue_operation.* --json` on a schedule | `vercel metrics vercel.queue_operation.count --group-by eventType --since … --until … --json` |
| Expired or dropped messages | Not emitted anywhere (Documented) | |

## 5. In Bronto

| Data | Dataset | Field names |
| --- | --- | --- |
| Consumer logs | `petclinic-agent/vercel-logs` | `"proxy.userAgent.0"`, `path`, `deploymentId`, `executionRegion` |
| Edge and runtime spans | `.traces/vercel-traces` | `"$span.name"`, `"$http.request.header.user-agent"`, `"$http.target"` |
| Library spans | `.traces/petclinic-agent` | `"$messaging.destination.name"`, `"$messaging.message.id"`, `"$span.name"` |

Queries, run against 2026-10-19 10:00 to 2026-10-26 10:00 UTC unless noted:

| Question | Query | Group by | Result |
| --- | --- | --- | --- |
| Deliveries per region | `"proxy.userAgent.0" = 'vercel-queue/v2beta' AND message LIKE 'START%'` | `"proxy.region"`, `executionRegion` | `dub1/dub1` 156,163 · `iad1/iad1` 8,730 · `dub1/iad1` 420 |
| Which deployments still receive messages? (2026-10-25) | same | `deploymentId` | 39 deployments; the oldest one (`dpl_FjmZ…`, from 2026-10-20) 14,703 |
| Handler failures that will be retried | `message LIKE '[workflow] Queue handler failed%'` | `executionRegion` | `dub1` 60 |
| Lease problems | `message LIKE 'Visibility extension failed%'` | | 1 |
| Messages sent per topic (spans) | `"$span.name" = 'queue.publish'` (`.traces/petclinic-agent`) | `"$messaging.destination.name"` | one topic per workflow; `sessionTimeoutWorkflow` 20,836 on 2026-10-25 |
| Consumer errors | `"$span.name" = 'vqs.process' AND "$span.status_code" = 'STATUS_CODE_ERROR'` | `"$span.status_message"` | 32, all "temporarily locked" |

For redeliveries and message age, the numbers live in Vercel: query them with `vercel metrics` and send the result on, or log `deliveryCount` from the handler.

## Gotchas

1. **Message age includes the requested delay.** A Workflow `sleep` is a delayed message. Every `sessionTimeoutWorkflow` message was 23 hours old on receive (p50 82,800,000 ms). An alert on maximum message age fires on healthy sleeping workflows; filter by queue or compare against the delay you expect (Observed).
2. **Messages go to the deployment that sent them.** On 2026-10-25, 99% of deliveries went to 38 older deployments, one of them six days old. Old deployments keep running code, and their errors carry an old `deploymentId` (Observed).
3. **Recovered failures log at `error`.** `[workflow] Queue handler failed … retrying in 1s` is `level: error` although the message is delivered again and usually succeeds; only 16 messages needed a second delivery on 2026-10-25. Alert on the redelivery count or on failed runs, not on this line (Observed).
4. **A delivery is two traces.** The edge trace (in the drain, with the log record's `traceId`) and the library trace (new root `workflow.route.flow`) are joined only by a span link on `vqs.process` / `workflow.execute`. A backend that doesn't follow span links shows them as unrelated (Captured: `span-vqs-process.json`).
5. **Topic names differ by place.** Metrics and `vqs.send` write `workflow--eve--sessionTimeoutWorkflow`; `queue.publish` and `workflow.execute` write `workflow//eve//sessionTimeoutWorkflow`. Normalise before joining (Observed).
6. **No record of the queue's side.** The edge span's parent (the queue service) isn't exported, and expired messages leave no trace at all (Observed, Documented).
7. **`QUEUE_VISIBILITY_CHANGED` is rare and meaningful.** 24 on 2026-10-25 against 20,843 receives: a consumer extended or gave back a lease. It pairs with the `Visibility extension failed` line when the lease was already gone.

## Samples

| File | What it shows |
| --- | --- |
| [`log-queue-delivery-report.json`](../samples/queues/log-queue-delivery-report.json) | Report line of a delivery: `vercel-queue/v2beta`, old deployment |
| [`log-queue-handler-failed.json`](../samples/queues/log-queue-handler-failed.json) | Handler failure with retry, `level: error` |
| [`log-visibility-extension-failed.json`](../samples/queues/log-visibility-extension-failed.json) | `MessageNotAvailableError` on lease extension |
| [`span-queue-delivery-edge.json`](../samples/queues/span-queue-delivery-edge.json) | Edge span of a delivery, with an unexported parent |
| [`span-runtime-queue-send.json`](../samples/queues/span-runtime-queue-send.json) | Runtime span for `POST dub1.vercel-queue.com/api/v3/topic/…` |
| [`span-runtime-queue-ack.json`](../samples/queues/span-runtime-queue-ack.json) | Runtime span for the lease `DELETE` (acknowledge) |
| [`span-vqs-process.json`](../samples/queues/span-vqs-process.json) | Consumer span with the span link to the edge trace |
| [`span-vqs-send.json`](../samples/queues/span-vqs-send.json) | Producer span |
| [`span-queue-publish.json`](../samples/queues/span-queue-publish.json) | Workflow's publish span |
| [`trace-queue-delivery-edge.ndjson`](../samples/queues/trace-queue-delivery-edge.ndjson) | The edge trace of one delivery |
| [`metrics-event.json`](../samples/queues/metrics-event.json) | Operations by event type, 2026-10-25 |
| [`metrics-deliv.json`](../samples/queues/metrics-deliv.json), [`metrics-deliv-22.json`](../samples/queues/metrics-deliv-22.json) | Receives by delivery attempt |
| [`metrics-name.json`](../samples/queues/metrics-name.json), [`metrics-name-22.json`](../samples/queues/metrics-name-22.json) | Operations per queue and consumer group |
| [`metrics-region.json`](../samples/queues/metrics-region.json) | Operations per queue region |
| [`metrics-age50.json`](../samples/queues/metrics-age50.json), [`metrics-agemax.json`](../samples/queues/metrics-agemax.json), [`metrics-age-22.json`](../samples/queues/metrics-age-22.json) | Message age on receive |

## Sources

- Vercel docs, read 2026-10-16 to 2026-10-20: [Queues concepts](https://vercel.com/docs/queues/concepts), [Queues observability](https://vercel.com/docs/queues/observability), [Queues pricing and limits](https://vercel.com/docs/queues/pricing).
- Lab: Bronto EU datasets `petclinic-agent/vercel-logs`, `.traces/vercel-traces`, `.traces/petclinic-agent`, 2026-10-12 to 2026-10-26 10:00 UTC; Vercel CLI 65.2.0 (`vercel metrics vercel.queue_operation.*`, `vercel metrics schema`); eve 0.81.0 source in `node_modules/eve/dist`.
