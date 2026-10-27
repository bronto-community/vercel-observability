# Turborepo and Vercel Remote Cache

> Turborepo can export each run as OpenTelemetry metrics over OTLP, and nothing else: no spans and no logs. It is opt-in and experimental (`futureFlags.experimentalObservability`, since Turborepo 2.8.13 of 2026-03-03). By default a run sends four metrics (run duration as a histogram, tasks attempted, failed and cached), each tagged with exit code, branch and Turborepo version. `taskDetails` adds per-task duration and a cache hit/miss counter with the package, task name and the full script text. Run IDs, commit SHAs and task hashes are off unless you turn them on. The metrics go from wherever `turbo` runs (a laptop, CI or a Vercel build) straight to your OTLP endpoint; Vercel is not involved and has no drain, metric or usage line for Remote Cache. The thing people get wrong: with `http/protobuf`, Turborepo posts to the endpoint exactly as written, so a base URL without `/v1/metrics` loses every run, and Turborepo prints no error unless you run with `-vv`. Time saved by the cache is only in the local run summary (`--summarize`), never in the metrics.

| | |
| --- | --- |
| Kind | Library / CLI (Turborepo) plus a platform service (Vercel Remote Cache) |
| Plans | Turborepo OTel export: any, it runs on your machine or CI. Remote Cache: free on all plans within fair use (Documented) |
| Signals | Metrics (OTLP) · Run summary file (JSON, local) · Remote Cache usage on Vercel's Usage page |
| Exit paths | OTLP from the `turbo` process (gRPC or `http/protobuf`) · run summary file · Remote Cache usage: none |
| Verified | 2026-10-27 · Turborepo 2.11.10 (latest, 2026-10-20) · OpenTelemetry Collector contrib 0.139.0 · Vercel CLI 65.2.0 · throwaway two-package monorepo, not deployed |

## 1. What it emits

| Signal | What | Where it lives | Retention |
| --- | --- | --- | --- |
| Run metrics | `turbo.run.duration_ms`, `turbo.run.tasks.attempted`, `turbo.run.tasks.failed`, `turbo.run.tasks.cached` | Your OTLP endpoint only | Your backend's |
| Task metrics (opt-in) | `turbo.task.duration_ms`, `turbo.task.cache.events` | Your OTLP endpoint only | Your backend's |
| Run summary (opt-in, `--summarize`) | One JSON file per run: every task with hash, cache status and source, time saved, command, inputs, environment variable names, exit code, error text | `.turbo/runs/<run id>.json` on the machine that ran `turbo` | Until deleted |
| Task logs | Each task's output | `.turbo/turbo-<task>.log` per package, the cache artifact, and on Vercel the build log | Build logs: see Builds |
| Remote Cache usage | Number and size of artifacts uploaded and downloaded, time saved (remote and local) | Vercel Usage page (Documented) | Artifacts expire after 7 days (Documented) |

The OTel export first shipped in Turborepo 2.8.13 (2026-03-03); 2.8.14 (2026-03-06) switched it to delta temporality. Turborepo's configuration reference still marks it experimental (read 2026-10-27).

## 2. Out-of-the-box shape

### What a run sends

With `futureFlags.experimentalObservability: true` in the root `turbo.json` and only an endpoint set, each `turbo run` sends one export at the end of the run (plus periodic exports every 15 s for long runs, Documented). A run of `turbo run build` over two packages, both cache misses (Captured: `otlp-run-summary-only.json`):

| Metric | OTLP type | Temporality | Unit | Value in the lab |
| --- | --- | --- | --- | --- |
| `turbo.run.duration_ms` | Histogram, one data point per run | Delta | `ms` | count 1, sum 461 |
| `turbo.run.tasks.attempted` | Sum, monotonic | Delta | none | 2 |
| `turbo.run.tasks.failed` | Sum, monotonic | Delta | none | 0 |
| `turbo.run.tasks.cached` | Sum, monotonic | Delta | none | 0 |

Every data point carries three attributes, all strings (Captured):

| Attribute | Example | Note |
| --- | --- | --- |
| `turbo.run.exit_code` | `"0"`, `"1"` | A string, not a number |
| `turbo.scm.branch` | `main` | |
| `turbo.version` | `2.11.10` | |

The resource has one attribute, `service.name: turborepo`, unless you set `resource`/`TURBO_EXPERIMENTAL_OTEL_RESOURCE`. No host, CI, repository or SDK attributes. Scope name: `turborepo` (Captured).

The histogram uses fixed bucket bounds of 100, 500, 1,000, 2,500, 5,000, 10,000, 15,000, 30,000, 60,000, 120,000, 300,000, 600,000, 900,000, 1,800,000 and 3,600,000 ms, with `min` and `max` set (Captured). Runs shorter than 100 ms, which is most fully cached runs, all land in the first bucket.

### Task details (`metrics.taskDetails`)

`taskDetails` (`TURBO_EXPERIMENTAL_OTEL_METRICS_TASK_DETAILS=1`) adds two metrics with one data point per task (Captured: `otlp-task-details-miss.json`, `otlp-task-details-hit.json`):

| Metric | OTLP type | Values in the lab |
| --- | --- | --- |
| `turbo.task.duration_ms` | Histogram, delta, `ms` | Miss: 428 ms per build task. Hit: 1 ms (the restore, not the original task time) |
| `turbo.task.cache.events` | Sum, delta, monotonic | 1 per task |

Task data points carry the three run attributes plus:

| Attribute | Example | Note |
| --- | --- | --- |
| `turbo.task.name` | `build` | |
| `turbo.task.package` | `pkg-a` | |
| `turbo.task.cache_status` | `miss`, `hit` | |
| `turbo.task.cache_source` | `LOCAL` | Only on hits. `REMOTE` for Remote Cache hits: Not observed (Remote Cache not linked) |
| `turbo.task.exit_code` | `"0"`, `"1"` | String |
| `turbo.task.command` | `mkdir -p dist && node -e "…"` | The full `package.json` script text, on by default with `taskDetails` |

### Opt-in identifiers

These are off by default to keep cardinality low (Documented) and appear when enabled (Captured: `otlp-failed-run-all-attributes.json`):

| Setting | Adds | Example |
| --- | --- | --- |
| `metrics.runAttributes.id` | `turbo.run.id` | `3LGvPYMF1H4HwtZcnsw8Vu7aXBM` (same ID as the run summary file name) |
| `metrics.runAttributes.scmRevision` | `turbo.scm.revision` | Full commit SHA |
| `metrics.taskAttributes.id` | `turbo.task.id` | `pkg-b#test` |
| `metrics.taskAttributes.hashes` | `turbo.task.hash`, `turbo.task.external_inputs_hash` | `939a1d47c69fae90` |

A failed run (`turbo run test --continue`, one of four tasks exits 1) sent `turbo.run.exit_code: "1"`, `tasks.failed` 1, `tasks.cached` 2 and, on the failing task, `turbo.task.exit_code: "1"` with `cache_status: miss`. The successful tasks of the same run also carry `turbo.run.exit_code: "1"` (Captured).

### Run summary (`--summarize`)

`turbo run … --summarize` writes `.turbo/runs/<run id>.json` (Captured: `run-summary-failed-test.json`, paths replaced). Top level: `id`, `version`, `turboVersion`, `monorepo`, `globalCacheInputs`, `execution` (command, `success`, `failed`, `cached`, `attempted`, `startTime`, `endTime`, `exitCode`), `packages`, `envMode`, `frameworkInference`, `tasks`, `user`, `scm` (`type`, `sha`, `branch`). Each task has `taskId`, `hash`, `inputs` (file hashes), `cache` (`local`, `remote`, `status` `HIT`/`MISS`, `source`, `timeSaved` in ms), `command`, `outputs`, `logFile`, `directory`, `dependencies`, `dependents`, `resolvedTaskDefinition`, `environmentVariables` (names), and `execution` (`startTime`, `endTime`, `exitCode`, and `error` on failure).

The summary has what the metrics leave out: `timeSaved` per task (443 ms for a cached build in the lab), input file hashes, start and end time per task and the error text. The error text contains absolute paths of the machine that ran it (`command (/…/packages/b) /…/bin/npm run test exited (1)`).

### Remote Cache on Vercel

`GET /v8/artifacts/status` (through `vercel api`) returned `{"status":"enabled"}` for the lab team (Captured: `api-artifacts-status.json`). Vercel's metric catalog (108 metrics, `reference/vercel-metrics-schema.json`) has no Remote Cache metric, and `vercel usage --json` lists 73 services for the billing cycle with no Remote Cache line (Observed). The Usage page shows artifact counts, artifact size and time saved (Documented). Turborepo reports cache hits to Vercel through `POST /v8/artifacts/events` ("Record an artifacts cache usage event" in the REST API list), which is where the time-saved numbers come from (Documented, inferred from the API list).

## 3. Extras beyond the default

| Extra | What it adds | Cost |
| --- | --- | --- |
| `metrics.taskDetails` | Per-task duration histogram and hit/miss counter (section 2) | One data point per task per metric per run |
| `runAttributes.id`, `runAttributes.scmRevision` | Run ID and commit SHA on run metrics; joins a metric to its run summary and to a deployment's `vcs.ref.head.revision` | One series per run |
| `taskAttributes.id`, `taskAttributes.hashes` | Task ID and task hashes | One series per task hash |
| `resource` | Your resource attributes, for example `service.name`, `deployment.environment.name` | None |
| `--summarize` | The run summary file | Disk only |
| `useRemoteCacheToken` | Sends the Remote Cache token as `Authorization: Bearer` to the OTLP endpoint | Only for an endpoint that expects Vercel's token; Not observed |

## 4. Getting it out

| Signal | Exit path | Tested configuration |
| --- | --- | --- |
| Run and task metrics | OTLP gRPC from `turbo` | `TURBO_EXPERIMENTAL_OTEL_ENDPOINT=https://localhost:24317` to an OpenTelemetry Collector with an OTLP gRPC receiver, `debug` and `file` exporters. Arrived (Captured) |
| Run and task metrics | OTLP/HTTP protobuf from `turbo` | `TURBO_EXPERIMENTAL_OTEL_PROTOCOL=http/protobuf`, endpoint set to the backend's full metrics URL (`https://<host>/v1/metrics`), headers in `TURBO_EXPERIMENTAL_OTEL_HEADERS`. Arrived (Observed, section 5) |
| Run summary | None built in. The file stays on the machine; a CI step has to ship it | |
| Remote Cache usage | None. Usage page only | |
| Task logs | On Vercel: the build log, which a log drain carries as `source: build` (see Builds) | Not observed: the lab project is not a Turborepo monorepo |

The configuration used in the lab, root `turbo.json`:

```json
{
  "futureFlags": { "experimentalObservability": true },
  "tasks": { "build": { "outputs": ["dist/**"] }, "test": { "dependsOn": ["build"] } }
}
```

and the environment (secrets in env vars, not in `turbo.json`, which is usually committed):

```sh
TURBO_EXPERIMENTAL_OTEL_ENABLED=1
TURBO_EXPERIMENTAL_OTEL_PROTOCOL=http/protobuf
TURBO_EXPERIMENTAL_OTEL_ENDPOINT=https://<otlp host>/v1/metrics
TURBO_EXPERIMENTAL_OTEL_HEADERS=<header>=<value>
TURBO_EXPERIMENTAL_OTEL_RESOURCE=service.name=turbo-catalog-lab,deployment.environment.name=local
TURBO_EXPERIMENTAL_OTEL_METRICS_TASK_DETAILS=1
```

Endpoint rules, as observed with 2.11.10:

| Endpoint | Result |
| --- | --- |
| `http://localhost:24317` | Rejected before the run: `WARNING Ignoring experimentalObservability.otel endpoint because it must be a valid HTTPS URL without userinfo, private IPs, or metadata endpoints.` The run continues without metrics |
| `https://localhost:24317`, gRPC, collector without TLS | Arrived. The `https://` check did not stop a plaintext gRPC connection to the local collector |
| `https://localhost:24318`, `http/protobuf`, collector without TLS | Lost. Only `-vv` shows `could not flush metrics … url: "https://localhost:24318/" … InvalidContentType` |
| `https://<backend>` (no path), `http/protobuf` | Lost, no message even with `-vv`. Turborepo posts to `/`, it does not append `/v1/metrics` |
| `https://<backend>/v1/metrics`, `http/protobuf` | Arrived |
| `https://<backend>`, gRPC, to a backend that accepts only OTLP/HTTP | Lost; `-vv` shows `h2 protocol error … FRAME_SIZE_ERROR` |

So to reach a collector on the same machine, either give it TLS or use gRPC; to reach a hosted OTLP/HTTP backend, use `http/protobuf` with the full `/v1/metrics` URL. Exporter failures never fail the run (Observed, and Documented).

What can't leave: Remote Cache usage (artifact counts and sizes, time saved) has no API, metric or drain. Time saved per task exists only in the run summary file.

Turborepo also has its own anonymous usage telemetry to Vercel, unrelated to this export; the lab runs set `TURBO_TELEMETRY_DISABLED=1`.

## 5. In Bronto

| Data | Where | Field names |
| --- | --- | --- |
| Turborepo metrics over OTLP/HTTP | Metrics (Metric Explorer), not a dataset; no dataset was created | Metric names as sent (`turbo.run.duration_ms`); attributes as sent (`turbo.task.cache_status`); resource attributes listed as `Resource:service.name` |

Sent on 2026-10-27 between 09:24 and 09:27 UTC: 3 test exports, then 6 build runs (3 with `--force`, 3 cached) and one failing test run under `service.name=turbo-catalog-lab`. Checks run with the Bronto CLI 0.8.3 the same morning:

| Question | Command | Result |
| --- | --- | --- |
| Which Turborepo metrics arrived? | `bronto metrics list` | 6 metrics: `turbo.run.duration_ms` and `turbo.task.duration_ms` (`HISTOGRAM`, `DELTA`, unit `ms`); `turbo.run.tasks.attempted`, `.failed`, `.cached` and `turbo.task.cache.events` (`SUM`, `DELTA`). Descriptions as Turborepo sets them, such as "Tasks served from cache per run" |
| Which attributes can I group by? | `bronto metrics top-keys <turbo.task.cache.events id>` | `Resource:service.name` (`turbo-catalog-lab`, `turbo-otel-lab`), `Resource:deployment.environment.name`, `turbo.task.cache_status` (`hit`, `miss`), `turbo.task.cache_source` (`LOCAL`), `turbo.task.exit_code` (`0`, `1`), `turbo.task.name` (`build`, `test`), `turbo.task.package`, `turbo.task.command`, `turbo.run.exit_code`, `turbo.scm.branch`, `turbo.version` |
| Did the base-URL run arrive? | `bronto metrics top-keys <turbo.run.duration_ms id>` | No: `service.name=turbo-otel-lab-root` (sent to the base URL) is absent; `turbo-catalog-lab` (sent to `/v1/metrics`) is present |

Questions for the Metric Explorer, with the metric and aggregation to use:

| Question | Metric | Aggregation | Group by |
| --- | --- | --- | --- |
| Cache hit ratio per package | `turbo.task.cache.events` | Sum | `turbo.task.cache_status`, `turbo.task.package` |
| Slowest tasks on a miss | `turbo.task.duration_ms`, filter `turbo.task.cache_status = miss` | P95 | `turbo.task.package`, `turbo.task.name` |
| Failed runs per branch | `turbo.run.tasks.failed` | Sum | `turbo.scm.branch` |
| CI run duration trend | `turbo.run.duration_ms` | P50, P95 | `Resource:deployment.environment.name` |

Metric monitors (Monitors › Data source: Metrics) fit two checks: `turbo.run.tasks.failed` Sum above 0 on the main branch, and the hit share of `turbo.task.cache.events` dropping after a dependency change.

## Gotchas

1. **No `/v1/metrics`, no metrics, no error.** With `http/protobuf`, the endpoint is used as the full URL. A base URL like `https://<host>` posted to `/` and lost every run without a message, even at `-vv` (Observed). Use `https://<host>/v1/metrics`.
2. **`http://` is refused, also for localhost.** The run prints a warning and continues without metrics; `localhost` as a name is accepted (Observed). The warning text says private IPs and metadata endpoints are refused as well (not tested).
3. **Export failures are silent at normal verbosity.** Failed flushes appear only with `-vv` as `turborepo_otel` debug lines (Observed). Check the backend after the first run.
4. **A cache hit reports the restore time.** `turbo.task.duration_ms` for a hit was 0–1 ms; the task's real duration and the time saved (443 ms) are only in the run summary (Captured). Time saved can't be computed from the metrics alone.
5. **The full script text is an attribute.** `turbo.task.command` carries the `package.json` script verbatim whenever `taskDetails` is on. Inline secrets in scripts end up in your metrics backend (Captured).
6. **Exit codes are strings.** `turbo.run.exit_code` and `turbo.task.exit_code` are `"0"`/`"1"` strings; filter with string comparison (Captured).
7. **Runs blend together by default.** Without `runAttributes.id`, nothing on a data point identifies the run, and with delta temporality two runs in the same export window are separate points without a key (Captured). Turn on `runAttributes.id` in CI to join metrics and run summaries.
8. **Default `service.name` is `turborepo`.** Every repository that enables the export reports as the same service unless `resource` is set (Captured).

## Samples

| File | What it shows |
| --- | --- |
| [`otlp-run-summary-only.json`](../samples/turborepo/otlp-run-summary-only.json) | Default export of a run with two cache misses: four run metrics, OTLP JSON as written by the Collector's file exporter |
| [`otlp-task-details-miss.json`](../samples/turborepo/otlp-task-details-miss.json) | Same run with `taskDetails`: per-task duration and cache events, `cache_status: miss` |
| [`otlp-task-details-hit.json`](../samples/turborepo/otlp-task-details-hit.json) | Fully cached run: `cache_status: hit`, `cache_source: LOCAL`, 1 ms task durations |
| [`otlp-failed-run-all-attributes.json`](../samples/turborepo/otlp-failed-run-all-attributes.json) | Failed `test` run with every opt-in attribute: run ID, commit SHA, task ID, task hashes |
| [`run-summary-failed-test.json`](../samples/turborepo/run-summary-failed-test.json) | `--summarize` file of a failed run (absolute paths replaced) |
| [`api-artifacts-status.json`](../samples/turborepo/api-artifacts-status.json) | `GET /v8/artifacts/status` for the lab team |
| [`bronto-metrics-list.json`](../samples/turborepo/bronto-metrics-list.json) | The six Turborepo metrics in Bronto's metric catalog |
| [`bronto-top-keys-task-cache-events.json`](../samples/turborepo/bronto-top-keys-task-cache-events.json) | Attribute keys and values of `turbo.task.cache.events` in Bronto |
| [`bronto-top-keys-run-duration.json`](../samples/turborepo/bronto-top-keys-run-duration.json) | Attribute keys of `turbo.run.duration_ms`; the base-URL service is absent |

## Sources

- Turborepo docs, read 2026-10-27: [`turbo.json` reference](https://turborepo.dev/docs/reference/configuration) (`futureFlags`, `experimentalObservability.otel`, env vars, CLI flags, precedence); the `with-otel` example in `vercel/turborepo` (`examples/with-otel`, Collector config and expected metric names).
- Release history: npm `turbo` publish dates (2.8.13 on 2026-03-03, 2.8.14 on 2026-03-06, 2.11.10 on 2026-10-20); [2.8.13 release note](https://newreleases.io/project/npm/turbo/release/2.8.13) (OTel backend, #11130); [2.8.14 release note](https://newreleases.io/project/npm/turbo/release/2.8.14) (delta temporality).
- Vercel docs, read 2026-10-27: [Remote Caching](https://vercel.com/docs/monorepos/remote-caching) (last updated 2026-08-13: free on all plans, fair-use limits, 7-day expiry, Usage page metrics, automatic use during Vercel builds).
- Lab, 2026-10-27: throwaway npm-workspaces monorepo (two packages, `build` and `test` tasks) in a scratch folder; OpenTelemetry Collector contrib 0.139.0 in Docker (gRPC receiver, `debug` and `file` exporters); Bronto EU lab organization (`bronto metrics list`, `bronto metrics top-keys`); Vercel CLI 65.2.0 (`vercel api /v8/artifacts/status`, `vercel usage --json`, `vercel metrics schema`).
- Not tested (needs `turbo login` and `turbo link`, which change team state): Remote Cache hits (`cache_source: REMOTE`), `useRemoteCacheToken`, Turborepo inside a Vercel build.
