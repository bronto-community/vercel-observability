# Vercel Sandbox

> A Sandbox emits no logs and no spans of its own: three traced runs on 2026-10-27 produced no span and no log record from inside the VM, in either drain. Its usage is in the `vercel.sandbox.*` metrics (Observability Plus, grouped by sandbox name and session), in the Sandbox REST API and in the billing lines, and none of them has a drain. Command output goes back to the calling code and nowhere else, so it reaches a log only if your code logs it. The calling function shows the Sandbox SDK's API calls as outgoing requests to `vercel.com` (create, run command, stop) in `vercel.external_api_request.*`, and, with an undici or fetch instrumentation, as client spans in the trace drain (Captured: five `POST` spans per run, the stop call alone about 1.2 s). The trap: the three sources disagree. For the lab's two runs on 2026-10-26, the metrics showed 1,279 ms of Active CPU, 0 bytes of network and memory for only one sandbox. The API and the bill showed 1,758 ms, 11,158 bytes and one billed minute of memory per sandbox. Three runs on 2026-10-27 repeated the pattern (metrics 1,968 ms of CPU and 0 memory, 0 network; API 2,627 ms and 21,945 bytes). For cost, use the API or the billing lines, not the metrics.

| | |
| --- | --- |
| Kind | Platform service (Firecracker microVMs) with an SDK (`@vercel/sandbox`) |
| Plans | Hobby within included usage; Pro and Enterprise by usage (Documented); metric queries need Observability Plus |
| Signals | Metrics (inside Vercel only) · API objects (sandboxes, sessions) · Billing lines · the calling function's logs and spans |
| Exit paths | `vercel metrics` pull · `GET /v2/sandboxes`, `GET /v2/sandboxes/sessions` pull · `GET /v1/billing/charges` pull · log and trace drain for the calling function only |
| Verified | 2026-10-27 (runs of 2026-10-26 and 2026-10-27) · Vercel CLI 65.2.0 · `@vercel/sandbox` 3.9.0 · `@vercel/otel` 2.1.3 · `@opentelemetry/instrumentation-undici` 0.34.0 · lab project `vercel-observability-lab` |

## 1. What it emits

| Signal | What | Where it lives | Retention |
| --- | --- | --- | --- |
| Metrics | `vercel.sandbox.*` (7 metrics) by `projectId`, `sandboxName`, `sandboxSessionId` | Observability › Sandbox, Query, `vercel metrics` | Pro 1 day, Plus 30 days (Documented) |
| API objects | Per sandbox and per session: region, vCPUs, memory, timestamps, duration, Active CPU, network bytes | `vercel sandbox list --all`, REST API | Both runs still listed 18 h later (Observed) |
| Calling function | Its own logs and spans; the SDK's calls in `vercel.external_api_request.*` | Function logs, trace drain, `vercel metrics` | As for Functions |
| Billing | Sandbox Active CPU, Provisioned Memory, Data Transfer, Creations (and Snapshot, Drive lines) | `GET /v1/billing/charges` | See the Billing entry |
| Logs, traces from inside the Sandbox | None. Command output is returned to the SDK (`stdout()`, `stderr()`, `logs()`) | | |

The seven metrics: `cpu_total_time_ms`, `cpu_usage`, `memory_requested_gb_hr`, `memory_peak_gb_hr`, `memory_used_bytes`, `public_egress_bytes`, `public_ingress_bytes`. The changelog also names running sandboxes and sessions, which have no metric in `vercel metrics schema`; see [`reference/vercel-metrics-schema.json`](../reference/vercel-metrics-schema.json) for units and aggregations. Memory usage (`memory_used_bytes`) was added on 2026-09-28, the per-sandbox grouping on 2026-07-07 (Documented, changelog).

The lab: `GET /api/sandbox?secret=…` creates a 1-vCPU, non-persistent Sandbox with a 60 s timeout, runs `echo hello` and `node -v`, logs one JSON line with the outputs and stops the Sandbox. It ran twice on 2026-10-26 (15:00:32 and 15:06:15 UTC) and was answered `401` three times without the secret. The function ran in `dub1`; the Sandboxes ran in `iad1`, the project's Sandbox region. Both runs happened before the drains existed and before the project's trace sampling rule (first span 15:09:04 UTC), so they have no drained records and no spans.

On 2026-10-27 the lab's `GET /api/drive` route (see the Drives entry) ran the same kind of Sandbox three times (10:11:24, 10:11:33, 10:11:37 UTC) with a drive mounted at `/data`: create, `bash -c 'echo … > /data/run-<ms>.txt'`, `bash -c 'cat /data/*.txt'`, log, stop. By then the drains and the undici instrumentation were in place, so these runs have drained spans and logs (section 2, "Runs with tracing").

## 2. Out-of-the-box shape

### Three views of the same two sandboxes

| | Source | `beige-dirty-cardinal-P4qDoP` | `aquamarine-colourful-quokka-z45VGz` | Both |
| --- | --- | --- | --- | --- |
| Session | API | `sbx_zsZthcumQQ5hiI74bfd1MF6CayC3`, 889 ms | `sbx_57FZJ1atQJYPXcESx0x8Kp5pVnGS`, 910 ms | |
| Active CPU | `vercel.sandbox.cpu_total_time_ms` (sum) | 635 ms | 644 ms | 1,279 ms |
| | API `activeCpuDurationMs` | 814 ms | 944 ms | 1,758 ms |
| | Billing `Sandbox Active CPU` | | | 0.0004883 h = **1,758 ms**, $0.0000625 |
| Memory | `memory_requested_gb_hr` (sum) | 0.000556 GB-h | **0** | 0.000556 GB-h |
| | API | 2,048 MB × 889 ms | 2,048 MB × 910 ms | |
| | Billing `Sandbox Provisioned Memory` | | | **0.0682667 GB-h** = 2 × 2.048 GB × 1 min, $0.00145 |
| Network | `public_egress_bytes` / `public_ingress_bytes` (sum) | 0 / 0 | 0 / 0 | 0 |
| | API `networkTransfer` egress / ingress | 2,452 / 3,063 | 2,576 / 3,067 | 11,158 bytes |
| | Billing `Sandbox Data Transfer` | | | 0.000011158 GB = **11,158 bytes**, $0.0000017 |
| Creations | Billing `Sandbox Creations` | | | 2, $0.0000012 |
| Peak CPU | `cpu_usage` (max) | 63.5 % | 0 | |
| Memory used | `memory_used_bytes` (max) | 193.6 MB | 190.2 MB | |
| Peak memory | `memory_peak_gb_hr` (sum) | 0.000108 GB-h | 0 | |

(Captured: `metrics-*.json`, `api-sandboxes.json`, `api-sandbox-sessions.json`, `cli-sandbox-list.txt`, `charges-2026-10-26.jsonl`.)

- The bill matches the API exactly, not the metrics: Active CPU is the sum of the API's two values, Data Transfer is the sum of all four ingress and egress counts.
- Provisioned memory is billed in 1-minute minimum increments (Documented). Both sessions lasted under a second and were billed one minute each. The metric reports the actual second for one sandbox and nothing for the other.
- The billing quantity for Data Transfer counted ingress too, although the docs say downloaded data is free. At this size the cost is $0.0000017.
- `vercel sandbox list --all` shows the API's numbers (CPU `814ms`, `944ms`; network `2.4 KB / 3 KB`, `2.5 KB / 3 KB`).

### Metrics

```
$ vercel metrics vercel.sandbox.cpu_total_time_ms -a sum --group-by sandboxName --group-by sandboxSessionId --since 2026-10-26T00:00:00Z --json
aquamarine-colourful-quokka-z45VGz / sbx_57FZJ1atQJYPXcESx0x8Kp5pVnGS 644 · beige-dirty-cardinal-P4qDoP / sbx_zsZthcumQQ5hiI74bfd1MF6CayC3 635

$ vercel metrics vercel.sandbox.cpu_total_time_ms -a count --group-by sandboxName
1 · 1
```

One data point per sandbox, in the 15:00 UTC hourly bucket. The dimensions are only `projectId`, `sandboxName` and `sandboxSessionId`: no region, no vCPU count, no exit code, no command.

### API objects

`GET /v2/sandboxes?project=<id>` (read-only, through `vercel api`) returns one object per sandbox (Captured: `api-sandboxes.json`):

```json
{ "name": "beige-dirty-cardinal-P4qDoP", "currentSessionId": "sbx_zsZthcumQQ5hiI74bfd1MF6CayC3",
  "status": "stopped", "persistent": false, "region": "iad1", "vcpus": 1, "memory": 2048,
  "runtime": "node22", "image": "vercel/sandbox/universal@sha256:7a812a4a…", "timeout": 60000,
  "totalEgressBytes": 2452, "totalIngressBytes": 3063, "totalActiveCpuDurationMs": 814, "totalDurationMs": 889,
  "createdAt": 1793026832770 }
```

`GET /v2/sandboxes/sessions?project=<id>` adds per session `requestedAt`, `startedAt`, `requestedStopAt`, `stoppedAt`, `duration`, `activeCpuDurationMs` and `networkTransfer` (Captured: `api-sandbox-sessions.json`). For the beige run: requested 15:00:32.718, started 22 ms later, stop requested after 601 ms, stopped 288 ms after that. `vercel sandbox sessions list <name>` printed no rows for either sandbox (Observed).

### The calling function

The SDK's API calls are outgoing requests of the function (Captured: `metrics-external-api-sandbox.json`, `metrics-external-api-duration.json`):

| Call | Count per run | Duration |
| --- | --- | --- |
| `POST vercel.com/api/v3/sandboxes` (create) | 1 | 292 ms median |
| `POST vercel.com/api/v2/sandboxes/sessions/<session>/cmd` | 2 (one per command) | 140 ms each |
| `POST vercel.com/api/v2/sandboxes/sessions/<session>/stop` | 1 | 1,168 and 1,173 ms |

All from `functionRegion: dub1`, all `200`. `requestPath` contains the session ID, so each sandbox is its own group. Stopping took half of the function's 2,465 ms (`function_duration_ms` max for the `200` runs).

Function logs, still in `vercel logs` 18 hours later (Captured: `cli-logs-runtime-sandbox.jsonl`):

```json
{ "timestamp": "2026-10-26T15:06:17.620Z", "requestPath": "/api/sandbox", "source": "function", "region": "fra1",
  "level": "info", "stream": "stdout", "traceId": "9a4c27b506ee40c993bfe01eb809aa5a",
  "message": "{\"msg\":\"sandbox run\",\"sandbox\":\"aquamarine-colourful-quokka-z45VGz\",\"echo\":\"hello\",\"node\":\"v24.22.1\"}" }
```

`hello` and `v24.22.1` appear only because the route logs them; the runtime logs had no other line for these requests. `region` here is the edge region (`fra1`), not the function or Sandbox region. `vercel traces inspect` for that `traceId` returned `Trace not found (404)`: tracing wasn't on yet.

### Runs with tracing (2026-10-27)

One `/api/drive` request in the trace drain (Captured: `trace-drive-run-warm.ndjson`; `trace-drive-run-cold.ndjson` is a cold start with `Start VM`, `Spawn Node.js` and `Init User Code` spans):

```
GET /api/drive                                vercel.edge-network          2.37 s
└─ Invoke Function                            vercel.serverless-runtime    2.20 s
   └─ GET /api/drive                          vercel-observability-lab     2.20 s
      └─ executing api route (app) /api/drive vercel-observability-lab     2.19 s
         ├─ POST  drives/lab-drive            vercel-observability-lab   141.72 ms
         ├─ POST  /api/v3/sandboxes           vercel-observability-lab   583.88 ms
         ├─ POST  sessions/<id>/cmd           vercel-observability-lab   142.78 ms
         ├─ POST  sessions/<id>/cmd           vercel-observability-lab   119.61 ms
         └─ POST  sessions/<id>/stop          vercel-observability-lab     1.17 s
```

Nothing below the `POST` spans: no span from the Sandbox service or from inside the VM, and no Sandbox service dataset appeared next to `.traces/vercel.edge-network` and `.traces/vercel.serverless-runtime` (Observed). The spans come from `@opentelemetry/instrumentation-undici` (the lab's configuration since 2026-10-27; with `@vercel/otel`'s default fetch instrumentation they would be named `fetch POST https://vercel.com/api/…`). Per call, over the three runs (Captured: `span-sdk-create.json`, `span-sdk-cmd.json`, `span-sdk-stop.json`):

| SDK call | `url.path` | Spans | Duration |
| --- | --- | --- | --- |
| `Drive.getOrCreate()` | `/api/v2/sandboxes/drives/lab-drive` | 3 | 142–214 ms |
| `Sandbox.create()` (with a drive mount) | `/api/v3/sandboxes` | 3 | 584–673 ms |
| `runCommand()` | `/api/v2/sandboxes/sessions/<session>/cmd` | 6 | 109–160 ms |
| `stop()` | `/api/v2/sandboxes/sessions/<session>/stop` | 3 | 1,166–1,188 ms |

`user_agent.original` is `vercel/sandbox/3.9.0 (Node.js/v24.21.0; linux/x64)`, which identifies the SDK and its version; `url.query` carries `teamId`. Create took about twice the 292 ms median of the 2026-10-26 runs without a drive (`vercel.external_api_request.request_duration_ms`), so mounting a drive seems to cost about 300 ms at create (Observed, three runs). `vercel.external_api_request.count` listed the same calls, with the drive call under `requestPath /api/v2/sandboxes/drives/lab-drive` (Captured: `metrics-external-api-drive-runs.json`).

The log drain had only the function's records: the report line (2,208 to 3,280 ms) and the app's `drive run` line, `source: lambda` (Captured: `log-drive-run-app-line.json`). Command output, exit codes and the sandbox name reached the drain only because the route logs them.

The same three sandboxes in the metrics and the API (Captured: `metrics-drive-runs-*.json`, `api-sandboxes-drive-runs.json`, `api-sandbox-sessions-drive-runs.json`):

| Sandbox | `cpu_total_time_ms` (sum) | API `activeCpuDurationMs` | `memory_requested_gb_hr` (sum) | Session duration | Egress / ingress, metric | Egress / ingress, API |
| --- | --- | --- | --- | --- | --- | --- |
| `copper-defiant-flamingo-tyVf67` | 614 | 777 | 0 | 1,233 ms | 0 / 0 | 2,645 / 3,507 |
| `gold-skinny-bear-2JATFQ` | 746 | 1,050 | 0 | 1,322 ms | 0 / 0 | 2,622 / 6,886 |
| `lavender-colossal-weasel-bHsgSo` | 608 | 800 | 0 | 1,136 ms | 0 / 0 | 2,723 / 3,562 |

The API objects now include the mount: `"mounts": {"/data": {"drive": "lab-drive", "mode": "read-write"}}`, plus `failoverRegions: []` and `architecture: "amd64"`. Sessions carry `sourceSandboxName`. The billing lines for these runs were not yet in the in-progress billing day at 10:25 UTC (Not observed).

## 3. Extras beyond the default

| Extra | What it adds |
| --- | --- |
| Logging command results from your code | `exitCode`, `stdout()`, `stderr()`, the sandbox name and session ID per command as one JSON line: the only way command results reach a log drain |
| `@vercel/otel`'s fetch instrumentation or `@opentelemetry/instrumentation-undici` | The SDK sends its API calls with `globalThis.fetch` (with an `undici` dispatcher, `@vercel/sandbox` 3.9.0 `base-client.js`), so each call becomes a client span: `POST` with `url.path` from the undici instrumentation (Captured, 2026-10-27), `fetch POST https://vercel.com/api/…` from the fetch instrumentation (not run with a Sandbox call). Use one of the two, not both, or each call is recorded twice (see the Blob entry) |
| Observability Plus | Querying `vercel.sandbox.*` ($1.20 per 1M events, Documented) |

## 4. Getting it out

| Signal | Exit path | Tested configuration |
| --- | --- | --- |
| Per-sandbox usage that matches the bill | Pull `GET /v2/sandboxes?project=<id>` and `GET /v2/sandboxes/sessions?project=<id>` (or `vercel sandbox list --all`) | `vercel api`, 2026-10-27 |
| Cost | `GET /v1/billing/charges`, daily pull | See the Billing entry |
| Metrics (CPU usage %, memory used) | Pull `vercel metrics vercel.sandbox.* --json` (Plus) | Queries above |
| Command output | Log it in the calling function; log drain | The lab's `sandbox run` line |
| SDK call latency | `vercel.external_api_request.*` (Plus); trace drain spans with an undici or fetch instrumentation | Lab, 2026-10-27: undici instrumentation, trace drain |
| Anything from inside the VM | None | |

## 5. In Bronto

| Data | Dataset | Field names |
| --- | --- | --- |
| Calling function's logs | `vercel-observability-lab/vercel-logs` | `source`, `path`, `message` |
| Calling function's spans | `.traces/vercel-observability-lab` | `"$http.url"`, `"$span.name"` |

The two runs of 2026-10-26 predate the drains. Run on 2026-10-27 over the drained data (from 08:43 UTC; Sandbox runs through `/api/drive` at 10:11 UTC):

| Question | Query | Group by | Result |
| --- | --- | --- | --- |
| Runs through `/api/sandbox` | `path = '/api/sandbox'` | `statusCode` | 0 records (no run since the drains started) |
| Sandbox runs and their results | `path = '/api/drive' AND message LIKE '%drive run%'` | `path` | 3 |
| SDK calls as spans | `"$url.path" LIKE '/api/v%/sandboxes%'` | `"$url.path"` | create 3, `cmd` 6 (one path per session), `stop` 3, drive 3 |
| Slowest SDK call | same, `max("$span.duration_nano")` | `"$url.path"` | the three `…/stop` paths, 1,166–1,188 ms |

With `@vercel/otel`'s default fetch instrumentation, the span field is `"$http.url"` instead of `"$url.path"`. Usage and cost need a scheduled pull of the API or billing lines into the backend.

## Gotchas

1. **Metrics, API and bill disagree.** Active CPU 1,279 ms in the metrics against 1,758 ms in the API and on the bill; network 0 against 11,158 bytes; provisioned memory for one sandbox against two. The bill followed the API (Observed). Use the API for per-sandbox cost.
2. **A one-second sandbox bills a minute of memory.** Provisioned memory has a 1-minute minimum per sandbox (Documented); the lab's 0.9 s sessions were billed 0.0341 GB-h each at 2,048 MB, which the metric doesn't show.
3. **No log or span from inside the VM.** Command output exists only in the SDK's return values. Log it yourself, with the sandbox name and session ID, or it is gone (Observed).
4. **Three regions in one request.** Edge `fra1` (in `vercel logs` `region`), function `dub1`, Sandbox `iad1`. Every SDK call crossed from `dub1` to the Sandbox API; the stop call alone took about 1.2 s.
5. **Session IDs make high-cardinality paths.** `vercel.external_api_request` groups the `cmd` and `stop` calls by a `requestPath` that contains the session ID, one group per sandbox.
6. **`runtime: node22` ran Node.js 24.** The API reports `runtime: "node22"` for both sandboxes, while `node -v` inside them printed `v24.22.1` (image `vercel/sandbox/universal`). Don't take the runtime field as the version (Observed).
7. **SDK spans are the only trace of a Sandbox.** With an undici or fetch instrumentation, each create, command and stop is a client span of the calling function; nothing comes from the VM (Observed, three runs).
8. **Mounting a drive slows create.** `POST /api/v3/sandboxes` took 584–673 ms with a drive mount against 292 ms median without (Observed, 3 and 2 runs).

## Samples

| File | What it shows |
| --- | --- |
| [`api-sandboxes.json`](../samples/sandbox/api-sandboxes.json) | `GET /v2/sandboxes`: both sandboxes with totals |
| [`api-sandbox-sessions.json`](../samples/sandbox/api-sandbox-sessions.json) | `GET /v2/sandboxes/sessions`: timestamps, CPU, network per session |
| [`cli-sandbox-list.txt`](../samples/sandbox/cli-sandbox-list.txt) | `vercel sandbox list --all` |
| [`charges-2026-10-26.jsonl`](../samples/sandbox/charges-2026-10-26.jsonl) | The four Sandbox billing lines for the lab |
| [`metrics-cpu-total-time.json`](../samples/sandbox/metrics-cpu-total-time.json), [`metrics-cpu-total-time-count.json`](../samples/sandbox/metrics-cpu-total-time-count.json) | Active CPU per sandbox and session |
| [`metrics-cpu-usage-max.json`](../samples/sandbox/metrics-cpu-usage-max.json) | Peak CPU usage |
| [`metrics-memory-requested.json`](../samples/sandbox/metrics-memory-requested.json), [`metrics-memory-peak.json`](../samples/sandbox/metrics-memory-peak.json), [`metrics-memory-used-max.json`](../samples/sandbox/metrics-memory-used-max.json) | Memory metrics |
| [`metrics-egress.json`](../samples/sandbox/metrics-egress.json), [`metrics-ingress.json`](../samples/sandbox/metrics-ingress.json) | Network metrics (0) |
| [`metrics-external-api-sandbox.json`](../samples/sandbox/metrics-external-api-sandbox.json), [`metrics-external-api-duration.json`](../samples/sandbox/metrics-external-api-duration.json) | The SDK's API calls from the function |
| [`metrics-function-invocations.json`](../samples/sandbox/metrics-function-invocations.json), [`metrics-function-duration.json`](../samples/sandbox/metrics-function-duration.json) | `/api/sandbox` invocations and duration |
| [`cli-logs-runtime-sandbox.jsonl`](../samples/sandbox/cli-logs-runtime-sandbox.jsonl) | The two `sandbox run` lines from `vercel logs` |
| [`cli-logs-requests-sandbox.jsonl`](../samples/sandbox/cli-logs-requests-sandbox.jsonl) | `vercel logs requests` for `/api/sandbox` (2 × `200`, 3 × `401`) |
| [`trace-drive-run-warm.ndjson`](../samples/sandbox/trace-drive-run-warm.ndjson), [`trace-drive-run-cold.ndjson`](../samples/sandbox/trace-drive-run-cold.ndjson) | All spans of a traced Sandbox run (2026-10-27), warm and cold function |
| [`span-sdk-create.json`](../samples/sandbox/span-sdk-create.json), [`span-sdk-cmd.json`](../samples/sandbox/span-sdk-cmd.json), [`span-sdk-stop.json`](../samples/sandbox/span-sdk-stop.json) | The SDK's create, command and stop calls as undici client spans |
| [`log-drive-run-app-line.json`](../samples/sandbox/log-drive-run-app-line.json) | The route's result line as drained (`source: lambda`) |
| [`api-sandboxes-drive-runs.json`](../samples/sandbox/api-sandboxes-drive-runs.json), [`api-sandbox-sessions-drive-runs.json`](../samples/sandbox/api-sandbox-sessions-drive-runs.json) | The three sandboxes of 2026-10-27 with their drive mount and sessions |
| `metrics-drive-runs-*.json` ([CPU](../samples/sandbox/metrics-drive-runs-cpu_total_time_ms.json), [memory](../samples/sandbox/metrics-drive-runs-memory_requested_gb_hr.json), [egress](../samples/sandbox/metrics-drive-runs-public_egress_bytes.json), [ingress](../samples/sandbox/metrics-drive-runs-public_ingress_bytes.json)) | The same three sandboxes in `vercel.sandbox.*` |
| [`metrics-external-api-drive-runs.json`](../samples/sandbox/metrics-external-api-drive-runs.json) | `vercel.external_api_request.count` with the drive and Sandbox calls |

## Sources

- Vercel docs, read 2026-10-27: [Vercel Sandbox pricing and quotas](https://vercel.com/docs/sandbox/pricing) (last updated 2026-09-10), [Observability Insights](https://vercel.com/docs/observability/insights) (last updated 2026-08-11), changelogs [More granular observability for Vercel Sandbox](https://vercel.com/changelog/more-granular-observability-for-vercel-sandbox) (2026-07-07) and [Vercel Sandbox now supports memory observability](https://vercel.com/changelog/vercel-sandbox-now-supports-memory-observability) (2026-09-28).
- `@vercel/sandbox` 3.9.0: `dist/api-client/base-client.js`.
- Lab: `lab/app/api/sandbox/route.ts`, `lab/app/api/drive/route.ts` (runs 2026-10-27 10:11 UTC, deployment `dpl_14UbnR1c1cgJ2Kk4RkNXj5ChK3XJ`), Bronto EU datasets `vercel-observability-lab/vercel-logs` and `.traces/vercel-observability-lab`, `lab/NOTES.md`; Vercel CLI 65.2.0 (`vercel metrics`, `vercel sandbox list --all`, `vercel api /v2/sandboxes`, `vercel api /v2/sandboxes/sessions`, `vercel logs`, `vercel logs requests`, `vercel traces search`, `vercel api /v1/billing/charges`), read-only, 2026-10-27.
