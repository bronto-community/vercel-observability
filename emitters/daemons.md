# Vercel Daemons

> Nothing a daemon does at runtime left Vercel through a drain in the lab. Its stdout and stderr reach the project's runtime logs with `source: daemon`, and `vercel logs --query 'source:daemon'` showed all 37 lines of a 34-minute run, but none of them reached the project's log drain (all sources, no filter). It emits no spans (it has no request to trace, and the lab ran no instrumentation inside it) and no queryable metrics: `vercel metrics schema` has no `vercel.daemon.*` metric, and the CLI's own `vercel daemons instances inspect` asks the metrics API for six `vercel.daemon.*` metrics and gets `Unknown metric` back. The image build does reach the log drain as `source: build` lines. Billing knows daemons as `Daemons Active CPU` and `Daemons Provisioned Memory` (service category `Vercel Functions`), plus `VCR Storage` for the image. So today, to get a daemon's output out of Vercel, send it from the process yourself (an OTLP log exporter or any HTTP sink), or pull `vercel logs` on a schedule. The trap: the docs list `daemonName` and `daemonInstanceId` fields on daemon logs, but the CLI's JSON had neither; only `deploymentId` ties a line to a daemon version.

| | |
| --- | --- |
| Kind | Platform service (long-running container workers on Fluid compute) |
| Plans | Public beta on all plans since 2026-10-15; production deployments only. Hobby: 5 Active CPU-hours per month. Pro and Enterprise: billed for Active CPU and Provisioned Memory (Documented) |
| Signals | Logs (runtime logs only) · build logs · Other: daemon and instance state (API), billing lines |
| Exit paths | `vercel logs` / REST pull · log drain for the image build only · API pull (`/v1/projects/{id}/daemons`) · billing pull · OTLP or HTTP from inside the container (your code) |
| Verified | 2026-10-27 · Vercel CLI 65.2.0 · image `node:24.16.0-alpine` · lab project `vercel-observability-lab`, daemon `heartbeat`, 1 instance in `dub1`, 1 GiB |

## 1. What it emits

| Signal | What | Where it lives | Retention |
| --- | --- | --- | --- |
| Logs | Each instance's stdout and stderr, one record per line, `source: daemon` (Captured) | Runtime Logs, `vercel logs --query 'source:daemon'`; not in the log drain (Observed) | As for runtime logs |
| Build logs | Image build and push to Vercel Container Registry, `source: build` (Captured) | Build logs, log drain | As for builds |
| Traces | None. No request spans; nothing from the container unless your code exports it | | |
| Metrics | None queryable: `vercel metrics schema vercel.daemon` → `METRIC_NOT_FOUND` (Captured). The dashboard charts CPU, memory, running instances and data transfer (Documented) | Dashboard only | Observability Plus extends the range (Documented) |
| Daemon state | Config (image digest, command, instances per region, memory, grace period), status, instances with start time, `alive`, last check (Captured) | `vercel daemons ls/inspect`, `GET /v1/projects/{id}/daemons` | Current state |
| Billing | `Daemons Active CPU` (hours), `Daemons Provisioned Memory` (GB-hours), `VCR Storage` (GB) (Observed in `vercel usage`) | Usage page, `vercel usage`, `GET /v1/billing/charges` | See the Billing entry |

The lab daemon (`lab/daemons/heartbeat/`) is a Node.js script in a `node:24.16.0-alpine` image that prints `{"msg":"daemon started",…}`, then one `{"msg":"heartbeat","region":"dub1","beats":N,"rssBytes":…}` per minute, and `{"msg":"daemon stopping",…}` on `SIGTERM`. It is declared in `vercel.json`:

```json
"daemons": {
  "heartbeat": {
    "root": "daemons/heartbeat/",
    "entrypoint": "Dockerfile",
    "instances": { "dub1": 1 },
    "resources": { "requests": { "memory": "1Gi" } },
    "terminationGracePeriodSeconds": 5
  }
}
```

It ran from 10:12:50 UTC (first instance, deployment `dpl_7iop2T1aw8yWXFVBzYmUYoXyJQez`), was replaced at 10:16:50 UTC by a new instance when the next production deployment went out, and was removed with deployment `dpl_AX3DBwrCwuKMwZhdbeEsoMeTrgKh`: the last instance logged `daemon stopping` at 10:47:00.285 UTC, and `vercel daemons ls` was empty right after. Run time 34 minutes, 37 log lines.

## 2. Out-of-the-box shape

### Log records

`vercel logs --query 'source:daemon' --json` (Captured: `cli-logs-daemon.jsonl`):

```json
{ "timestamp": "2026-10-27T10:23:53.325Z", "projectId": "prj_Y3RSmZp5SNQvB6FhLb0LMH4HPWSM",
  "deploymentId": "dpl_EqPzC7dEefgzqwzBtFpQhbe4TQy7", "source": "daemon", "level": "info", "stream": "stdout",
  "message": "{\"msg\":\"heartbeat\",\"region\":\"dub1\",\"beats\":7,\"rssBytes\":46657536}",
  "requestId": "", "region": "", "environment": "", "service": "", "runtime": "", "traceId": "", "spanId": "",
  "isSystemLog": false, "attributes": { "scope.type": "target", "scope.value": "production" }, "truncated": false }
```

- No daemon name, no instance ID and no region in the record; `region` and `environment` are empty strings. The daemon's own `VERCEL_REGION` (`dub1`) is in the message only because the script logs it. The docs say daemon logs carry `daemonName` and `daemonInstanceId`; the CLI's JSON had neither (Observed).
- `attributes` carries the scope (`target`/`production`), the same pair the daemons API uses.
- A rollout shows as a change of `deploymentId`: the replaced instance's `SIGTERM` line (10:16:51.170 UTC) carries the old one, the new instance's first line (10:16:53.048 UTC, about 2 s after the API's `startedAt` of 10:16:50.808) the new one (Observed; grace period 5 s).
- Removing the daemon from `vercel.json` and deploying sent `SIGTERM` to the last instance within a second of the deployment going live (Observed: `daemon stopping` at 10:47:00.285 UTC).

The log drain (`vercel-observability-lab/vercel-logs`, all sources, no filter) received none of these lines: `message LIKE '%"msg":"heartbeat"%'` returned 0 records from 10:12 to 10:50 UTC, while the same drain carried the project's `lambda`, `static`, `external` and `build` records in that window (Observed).

### Build records

The image build runs inside the deployment's build and reaches the log drain with `source: build`, `type: stderr` (Captured: `log-build-daemon-image.json`):

```
▲ container  Building image vcr.vercel.com/brontoio/vercel-observability-lab/daemon.heartbeat:c100aa4b33d9 (buildah)
STEP 3/4: COPY heartbeat.mjs .
▲ container  pushing vcr.vercel.com/…/daemon.heartbeat:c100aa4b33d9 with zstd compression (level=3, force, oci)
▲ container  Image reference vcr.vercel.com/…/daemon.heartbeat@sha256:b6c3eea2…
```

The tag is the commit SHA of the working directory (`c100aa4b33d9`), so two deployments of the same commit pushed two different images under one tag; the daemon config pins the digest (Observed). The first build logged `created repository "daemon.heartbeat"`, later ones `already exists`. The repository stays in Vercel Container Registry after the daemon is removed: it held two 53.4 MB images (the untagged first build and the tagged second) until the lab deleted it with `vercel vcr delete daemon.heartbeat` at 10:47 UTC (Captured: `cli-vcr-images.json`).

### Daemon and instance state

`GET /v1/projects/{id}/daemons?scopeType=target&scopeValue=production` (what `vercel daemons ls` calls; Captured: `api-project-daemons.json`):

```json
{ "name": "heartbeat", "scope": { "type": "target", "value": "production" }, "deploymentId": "dpl_EqPzC7dEefgzqwzBtFpQhbe4TQy7",
  "config": { "image": { "requested": "vcr.vercel.com/…/daemon.heartbeat@sha256:fed1968e…", "resolved": "…" },
              "instances": { "dub1": 1 }, "command": ["docker-entrypoint.sh", "node", "heartbeat.mjs"],
              "terminationGracePeriodSeconds": 5, "resources": { "requests": { "memory": "1024Mi" } } },
  "status": "ready",
  "instances": { "ready": 1, "total": 1, "desired": 1,
                 "items": [ { "id": "dmni_01m5ydsps2n3jrbv0dcdhr0skk", "region": "dub1", "startedAt": "2026-10-27T10:16:50.808Z",
                              "lastCheckedAt": "2026-10-27T10:22:14.905Z", "alive": true, "memoryMiB": 1024 } ] },
  "createdAt": "2026-10-27T10:12:50.957Z", "updatedAt": "2026-10-27T10:16:50.786Z" }
```

`command` shows the image's resolved entrypoint (`docker-entrypoint.sh` from the Node.js image) in front of the Dockerfile's `CMD`. There are no restart counts, exit codes or resource figures. A replaced instance disappears: `vercel daemons instances inspect` on the first instance ID returned `not_found` four minutes after the rollout (Observed).

### Metrics

`vercel metrics schema vercel.daemon --json` → `METRIC_NOT_FOUND` (Captured: `metrics-schema-vercel-daemon.json`); the full schema (107 metrics) is unchanged from `reference/vercel-metrics-schema.json` and has no daemon dimension anywhere (Observed). `vercel daemons instances inspect <id> --since 1h --json` returned `"metrics": null` with the warning `metrics_unavailable` (Captured: `cli-daemons-instance-inspect.json`). With `--debug`, the CLI posts to `/metrics/v1` asking for `vercel.daemon.cpu_time_ms`, `vercel.daemon.provisioned_cpu_time_ms`, `vercel.daemon.memory_used_bytes`, `vercel.daemon.memory_peak_bytes`, `vercel.daemon.data_transfer_in_bytes` and `vercel.daemon.data_transfer_out_bytes`, filtered by `instanceId`, and gets `400 Unknown metric "vercel.daemon.memory_peak_bytes"` (Observed; names from the CLI 65.2.0 bundle). Those are the metric names to look for once they ship.

### Billing lines

`vercel usage --json` for the cycle lists `Daemons Active CPU` (product key `daemonProvisionedCpu`, unit `hour`), `Daemons Provisioned Memory` (`daemonProvisionedMemory`, `gigabyte-hour`) and `VCR Storage` (`vcrStorage`, `gigabyte`), all at 0 at 10:25 UTC (Observed). In the FOCUS export the two daemon services have `ServiceCategory: "Vercel Functions"`. The lab's daemon, Drive and Sandbox usage had no non-zero line in the in-progress billing day (2026-10-27 07:00 to 2026-10-28 07:00 UTC) at 10:47 UTC: Not observed yet. At 1 GiB, 34 minutes of provisioned memory is about 0.57 GB-hours.

## 3. Extras beyond the default

| Extra | What it adds |
| --- | --- |
| Logging from inside the container to your own backend | The only way daemon output reaches a backend without polling: an OpenTelemetry SDK with an OTLP log exporter (`OTEL_EXPORTER_OTLP_*` env vars from the project, which the daemon receives) or any HTTP sink. Not tested |
| OpenTelemetry tracing inside the daemon | Spans for the work the daemon does (queue receives, outgoing calls), exported over OTLP from the process; the trace drain covers only Vercel-run requests. Not tested |
| `VERCEL_OIDC_TOKEN_FILE` | An OIDC token file, refreshed about every 5 minutes, for authenticating to other services (Documented) |
| Observability Plus | Longer range for the dashboard's daemon charts (Documented) |

## 4. Getting it out

| Signal | Exit path | Tested configuration |
| --- | --- | --- |
| Daemon stdout/stderr | Not the log drain (Observed). Pull `vercel logs --query 'source:daemon' --json` (or the runtime logs API) on a schedule, or export from the process | `vercel logs --query 'source:daemon' --since 30m --json` |
| Image build | Log drain, `source: build` | Lab drain, all sources |
| Daemon and instance state | Pull `GET /v1/projects/{id}/daemons?scopeType=target&scopeValue=production` | `vercel api`, `vercel daemons ls --json` |
| CPU, memory, data transfer | None: dashboard only | |
| Cost | `GET /v1/billing/charges` daily | See the Billing entry |

## 5. In Bronto

| Data | Dataset | Field names |
| --- | --- | --- |
| Build logs | `vercel-observability-lab/vercel-logs` | `source`, `message`, `deploymentId` |

Queries run 2026-10-27 over 10:00 to 10:50 UTC:

| Question | Query | Group by | Result |
| --- | --- | --- | --- |
| Daemon lines in the log drain | `message LIKE '%"msg":"heartbeat"%' OR source = 'daemon'` | `source` | 0 records |
| Daemon image builds | `source = 'build' AND message LIKE '%Building image vcr.vercel.com%'` | `deploymentId` | 2 (one per production deployment with the daemon) |

## Gotchas

1. **Daemon logs don't reach the log drain.** A project log drain with all sources carried none of 37 daemon lines over 34 minutes; `vercel logs` had all of them (Observed). Plan for an export from inside the container.
2. **No name or instance on the log record.** The CLI's JSON has neither `daemonName` nor `daemonInstanceId`, and `region` is empty (Observed; the docs describe both fields). Log them yourself (`VERCEL_REGION` is set in the container).
3. **The CLI asks for metrics that don't exist yet.** `vercel daemons instances inspect` shows `metrics_unavailable`; the `vercel.daemon.*` names it requests are unknown to the metrics API (Observed, CLI 65.2.0).
4. **Every production deployment restarts the daemon.** The image is rebuilt and a new instance replaces the old one even when the daemon's files didn't change; the lab's daemon restarted at 10:16:50 because a route was added (Observed).
5. **The image outlives the daemon.** Removing the daemon leaves the `daemon.<name>` repository in Vercel Container Registry, billed as VCR Storage until deleted (Observed; pricing Documented).
6. **"Active CPU" is provisioned.** The usage product behind `Daemons Active CPU` is `daemonProvisionedCpu` (Observed in `vercel usage --json`); how idle time is counted on Pro is Not observed.

## Samples

| File | What it shows |
| --- | --- |
| [`cli-logs-daemon.jsonl`](../samples/daemons/cli-logs-daemon.jsonl) | `vercel logs --query 'source:daemon' --json`: start, heartbeat and stop lines |
| [`log-build-daemon-image.json`](../samples/daemons/log-build-daemon-image.json) | A drained build record of the daemon image build |
| [`api-project-daemons.json`](../samples/daemons/api-project-daemons.json) | `GET /v1/projects/{id}/daemons` |
| [`cli-daemons-ls.json`](../samples/daemons/cli-daemons-ls.json), [`cli-daemons-inspect.json`](../samples/daemons/cli-daemons-inspect.json), [`cli-daemons-instances-ls.json`](../samples/daemons/cli-daemons-instances-ls.json) | The CLI views of the same state |
| [`cli-daemons-instance-inspect.json`](../samples/daemons/cli-daemons-instance-inspect.json) | `instances inspect`: `metrics: null`, `metrics_unavailable` |
| [`cli-vcr-images.json`](../samples/daemons/cli-vcr-images.json) | The two images in the `daemon.heartbeat` repository before deletion |
| [`metrics-schema-vercel-daemon.json`](../samples/daemons/metrics-schema-vercel-daemon.json) | `vercel metrics schema vercel.daemon`: `METRIC_NOT_FOUND` |

## Sources

- Vercel docs and changelog, read 2026-10-27: [Daemons](https://vercel.com/docs/daemons), [Managing Daemons](https://vercel.com/docs/daemons/managing-daemons), [Daemon configuration reference](https://vercel.com/docs/daemons/config-reference), [Daemons limits](https://vercel.com/docs/daemons/limits), [Vercel Daemons is now in public beta](https://vercel.com/changelog/vercel-daemons-is-now-in-public-beta) (2026-10-15). The docs pages show no usable last-updated date.
- Source: Vercel CLI 65.2.0 bundle (`dist/commands-routing.js`, `instances inspect` metric query).
- Lab: `lab/daemons/heartbeat/`, `lab/vercel.json`; deployments `dpl_7iop2T1aw8yWXFVBzYmUYoXyJQez`, `dpl_EqPzC7dEefgzqwzBtFpQhbe4TQy7`, `dpl_AX3DBwrCwuKMwZhdbeEsoMeTrgKh` (removal); Vercel CLI 65.2.0 (`daemons`, `logs`, `metrics schema`, `usage`, `vcr ls`, `api`); Bronto EU dataset `vercel-observability-lab/vercel-logs`; `lab/NOTES.md`.
