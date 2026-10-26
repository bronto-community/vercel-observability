# Builds

> Every build writes its output to the log drain as `source: build`, one record per line, with `buildId`, `deploymentId` and `environment` but no trace IDs and no branch field. Every build line arrives at `level: info`, including the lines of a failed build, so a `level = 'error'` filter finds no failed build at all. A failed build ends with one line `Error: [<error code>] …` that matches the deployment's `errorCode` in the REST API; match that text. Build duration isn't a field, but two lines carry it: `Build Completed in /vercel/output [21s]` (the build step) and `Deployment completed` (whose timestamp matches the deployment's `ready` time within 0.2 s). The time from first to last line overstates the build by about 40 s, because the build cache upload logs after the deployment is ready.

| | |
| --- | --- |
| Kind | Platform service (build step of every deployment) |
| Plans | Build logs on all plans; drains need Pro or Enterprise |
| Signals | Logs |
| Exit paths | Log drain (`source: build`) · REST API (deployment state, build logs) |
| Verified | 2026-10-26 · Vercel CLI 65.2.0 (local) · build images reported Vercel CLI 64.3.1 to 65.1.0 · Next.js 16.3.6 · lab project `petclinic-agent` |

## 1. What it emits

| Signal | What | Where it lives | Retention |
| --- | --- | --- | --- |
| Logs | Every line of the build: clone, install, framework build, output upload, build cache | Deployment › Build Logs, `vercel inspect --logs`, log drain | Kept with the deployment; truncated above 4 MB (Documented) |
| Other | Build Diagnostics (time and resources per step) | Observability › Build Diagnostics | Not exportable (Documented, research A1) |
| Other | Deployment state, `errorCode`, `errorMessage`, `buildingAt`, `ready` | REST API `GET /v13/deployments/{id}` | With the deployment |

Deployment lifecycle events (`deployment.created`, `.error`, …) are not build logs; they come by webhook (see the Deployments entry).

## 2. Out-of-the-box shape

### Log records

Fields on every `source: build` record (5,334 records from 41 builds, last 30 days on 2026-10-26, Captured: `log-*.json`, `build-failed-preview.ndjson`):

| Field | Example | Note |
| --- | --- | --- |
| `id`, `timestamp` | `1792486786684` | ms |
| `source` | `build` | |
| `type` | `stdout`, `stderr` | Only these two (5,168 and 166). The schema also lists `command`, `exit`, `deployment-state`, `delimiter`; none appeared |
| `level` | `info` | **Every record**, including all error output (see below) |
| `message` | `Cloning github.com/bronto-community/petclinic-agent (Branch: main, Commit: abd0ee3)` | One line per record; ANSI colour codes kept; empty lines arrive as records without `message` |
| `buildId` | `bld_d0w9ahj0k` | One per build |
| `deploymentId` | `dpl_zA9h4XmaGkY15VUuTXZcv1aMnzyP` | Joins build lines to the deployment's runtime records and webhook events |
| `entrypoint` | `.` | Always `.` in the lab (one root) |
| `environment` | `production`, `preview` | |
| `host` | `petclinic-agent-f1afzsrgt-brontoio.vercel.app` | The deployment URL |
| `projectId`, `projectName` | | |

Absent: `traceId`, `spanId`, `requestId`, `branch`, `statusCode`, `proxy.*`. Branch and commit appear only as text in the `Cloning …` line.

### A failed build

The lab broke a preview build on purpose (`lab/broken-build`, deployment `dpl_9N9ig6nAVomDrAZcNMMGV7nPT8jh`). Its last 32 lines, all `type: stderr`, `level: info` (Captured: `build-failed-preview.ndjson`):

```
12.15 s  > Build error occurred
12.15 s  Error: Turbopack build failed with 1 error:
12.15 s  ./apps/web/lib/utils.ts:10:1
12.15 s  Error: Expression expected
 …       (code frame, import traces)
12.25 s  Error: [BUILD_UTILS_SPAWN_1] Command "node ../../node_modules/next/dist/bin/next build" exited with 1
```

The REST API shows the same deployment as `readyState: ERROR`, `errorCode: BUILD_UTILS_SPAWN_1`, `errorMessage: Command "node ../../node_modules/next/dist/bin/next build" exited with 1` (Captured: `api-deployment-failed.json`). The bracketed code in the last line is the deployment's `errorCode`.

A second failed build, in production (`dpl_745bmHLeMYfiHJVfuf81Z5yJKBzH`, a prerender error on `/vets`), ended the same way: `Export encountered an error on /vets/page: /vets, exiting the build.`, then `Error: [BUILD_UTILS_SPAWN_1] …`, both `level: info` (Observed). This confirms research finding D8.

### `stderr` is not an error signal

Of 166 `stderr` lines, most come from successful builds: `> Installing dependencies before config compilation...` (40), `Vercel CLI 64.3.1` (25 and other versions), `Build Completed in /vercel/output [16s]` (every successful build). `type = 'stderr'` doesn't separate failures either (Observed).

### Build duration

From the production build `bld_d0w9ahj0k` (Captured: `log-build-completed.json`, `log-deployment-completed.json`, `api-deployment-ready.json`):

| Moment | Build log | REST API |
| --- | --- | --- |
| Build starts | First line `Running build in Cleveland, USA (East) – cle1`, 0.3 s before `buildingAt` | `buildingAt` |
| Build step done | `Build Completed in /vercel/output [21s]` at +28.1 s | |
| Deployment ready | `Deployment completed` at +37.9 s, 0.2 s after `ready` | `ready` (37.4 s after `buildingAt`) |
| Build cache saved | `Build cache uploaded: 9.349s` at +78.1 s, last line | |

Over 14 production builds, `Deployment completed` came 27 to 62 s after the first line, and the last line 52 to 115 s after (Observed). Use `Deployment completed` minus the first line for "time to ready", or the number in `Build Completed in … [Ns]` for the build step alone.

Builds ran in `cle1` (Cleveland) while the functions run in `dub1`; the build region is only in the first line's text.

## 3. Extras beyond the default

| Extra | What it adds |
| --- | --- |
| Git integration | Branch and commit in the `Cloning` line; commit metadata on the deployment (REST, webhooks) |
| Your build script's output | Anything your build prints becomes a `source: build` line, e.g. the lab's `patched …/.vc-config.json: regions=dub1` |
| Turborepo `experimentalObservability` | OTLP metrics for task runs (Documented, research A1; Not observed) |

## 4. Getting it out

| Signal | Exit path | Tested configuration |
| --- | --- | --- |
| Build lines | Log drain, schema `log` v1 | Drain `petclinic-agent-logs`, no source filter (see the Functions entry). A drain filtered to source `build` and environment `production` delivered only production build lines (research D4) |
| Failure reason, timings | REST `GET /v13/deployments/{id}`: `readyState`, `errorCode`, `errorMessage`, `buildingAt`, `ready` | Read-only call with `vercel api` |
| Build Diagnostics | None | |

Delivery delay from a build line's `timestamp` to ingestion: median 2.2 s, max 4.9 s over 2,000 lines (Observed).

## 5. In Bronto

| Data | Dataset | Field names |
| --- | --- | --- |
| Build lines | `petclinic-agent/vercel-logs` | As in the payload: `source`, `type`, `buildId`, `deploymentId`, `environment`, `message` |

Queries, each run against the lab's last 7 days on 2026-10-26:

| Question | Query | Group by | Result |
| --- | --- | --- | --- |
| Which builds failed? | `source = 'build' AND message LIKE 'Error: [%'` | `deploymentId`, `environment` | `dpl_745bm…` production 1 · `dpl_9N9ig…` preview 1 |
| Why did it fail? | `source = 'build' AND deploymentId = 'dpl_9N9ig6nAVomDrAZcNMMGV7nPT8jh' AND type = 'stderr'` | | 34 lines: the error output above, the CLI banner and the install notice |
| Builds per environment | `source = 'build' AND message LIKE 'Running build in%'` | `environment` | production 37 · preview 4 |
| Build step duration | `source = 'build' AND message LIKE 'Build Completed in%'` | `message` | one line per successful build, `[12s]` to `[43s]` |
| Error-level build lines | `source = 'build' AND level = 'error'` | | 0, although two builds failed |

Template: the "Vercel Overview" dashboard has a "Build Failures Over Time" widget on the log drain dataset; for this lab's data, the first query above is the one that finds the failures.

## Gotchas

1. **Failed builds log at `info`.** Every line of both failed builds, including `> Build error occurred` and `Error: [BUILD_UTILS_SPAWN_1] …`, arrived as `level: info` (Captured). Vercel's schema lists `error` and `fatal` levels; no build line used them.
2. **`stderr` is mostly noise.** The CLI banner and `Build Completed in …` go to `stderr` on every successful build.
3. **The last line isn't the end of the build.** The build cache is created and uploaded after `Deployment completed`, 40 s in the measured build. First-to-last timestamps overstate the time to ready.
4. **No trace context.** Build lines have no `traceId`; join them to runtime data and deployment events by `deploymentId`.
5. **One record per line.** A stack trace or code frame is spread over many records (32 for one Turbopack error), with ANSI colour codes in the text. Group by `buildId` and sort by `timestamp` and `id` to read it back.

## Samples

| File | What it shows |
| --- | --- |
| [`build-failed-preview.ndjson`](../samples/builds/build-failed-preview.ndjson) | All 59 lines of a failed preview build, in order |
| [`log-failed-build-exit.json`](../samples/builds/log-failed-build-exit.json) | The final `Error: [BUILD_UTILS_SPAWN_1] …` line, `level: info` |
| [`log-build-error-occurred.json`](../samples/builds/log-build-error-occurred.json) | `> Build error occurred`, `level: info` |
| [`log-stdout-clone.json`](../samples/builds/log-stdout-clone.json) | The `Cloning` line with branch and commit |
| [`log-build-completed.json`](../samples/builds/log-build-completed.json) | `Build Completed in /vercel/output [21s]` on `stderr` |
| [`log-deployment-completed.json`](../samples/builds/log-deployment-completed.json) | `Deployment completed` |
| [`api-deployment-failed.json`](../samples/builds/api-deployment-failed.json) | REST view of the failed deployment: `errorCode`, `errorMessage`, timings |
| [`api-deployment-ready.json`](../samples/builds/api-deployment-ready.json) | REST view of a successful production deployment |

## Sources

- Vercel docs, read 2026-10-26: [Log Drains reference](https://vercel.com/docs/drains/reference/logs) (last updated 2026-09-11); [Build logs](https://vercel.com/docs/deployments/logs) (via research A1).
- Lab: Bronto EU dataset `petclinic-agent/vercel-logs`, last 30 days on 2026-10-26; `vercel api /v13/deployments/{id}` for `dpl_9N9ig6nAVomDrAZcNMMGV7nPT8jh` and `dpl_zA9h4XmaGkY15VUuTXZcv1aMnzyP`.
- Research: `research/I-lab-findings.md` D4, D8; `research/A1-vercel-platform.md` §6.
