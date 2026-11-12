# Vercel CI

> **Docs only: the lab doesn't use Vercel CI, so everything here is Documented or Not observed, except the billing line, the Activity Log types and CLI help.** Vercel CI (beta since 2026-10-28) runs the Turborepo tasks tagged `ci` on every `git push` to a connected GitHub repository, each task on its own compute. It produces task logs (lines with a level, timestamp and message, grouped by job and task), run, job and task status with timestamps and conclusions, and a check on the GitHub pull request. All of it stays in Vercel: the dashboard CI tab, `vercel ci`, Vercel MCP and REST endpoints read it, and no drain or webhook carries it. Log drains have no CI source. Getting CI logs into another backend means pulling them from the REST log-line endpoints after each run. The thing people get wrong: a task restored from Remote Cache didn't run, and its log is the log of the run that produced the cache entry.

| | |
| --- | --- |
| Kind | Platform service (CI runner for Turborepo tasks) |
| Plans | All plans, beta. Hobby: 200 CPU minutes per month included. Pro: $0.0035 per CPU minute. Enterprise: custom (Documented). GitHub only, private repositories only, Linux image only |
| Signals | Logs (task log lines) · Other: run, job and task status · GitHub check · Activity Log events · Billing line |
| Exit paths | REST API pull (`/v1/vercel-ci/…/task-logs`, `…/logs`, `…/task-runs`) · CLI (`vercel ci logs --json`, `--follow` as JSONL) · Vercel MCP · GitHub check on the commit · Activity Log API · billing API · no drain, no webhook |
| Verified | docs only, 2026-11-12, no lab capture yet · Vercel CLI 65.14.0 (help output, `vercel activity types`, `vercel metrics schema`) · Vercel OpenAPI spec as published 2026-11-12 · `GET /v1/billing/charges` for 2026-11-10 |

## 1. What it emits

| Signal | What | Where it lives | Retention |
| --- | --- | --- | --- |
| Task logs | Lines per task with `level` (`trace`, `debug`, `command`, `info`, `warn`, `error`, `systemError`, `fatal`), `timestamp` and `message` (Documented, OpenAPI and CLI help) | Dashboard CI tab, `vercel ci logs`, `vercel ci grep`, Vercel MCP, REST | Not documented |
| Run, job and task status | Runs per commit and branch with status `queued`, `running`, `succeeded`, `failed`, `skipped`; attempts; per task run `createdAt`, `startedAt`, `completedAt`, `conclusion` and a `deploymentBinding` (deployment ID and ready state) (Documented) | Dashboard, `vercel ci list`/`inspect`, REST | Not documented |
| GitHub check | Pass or fail per run, with a link to the run, in the pull request's merge box (Documented) | GitHub | GitHub's |
| Metrics | None. `vercel metrics schema` lists no CI metric (Observed, CLI 65.14.0); "advanced observability" is planned before general availability (Documented, blog) | | |
| Activity Log | `vercel-ci-repository-settings-updated` (CI enabled or disabled), `repository-ci-env-variable-create`, `-update`, `-delete` (Observed in `vercel activity types`) | Activity Log, `vercel activity` | See the Audit Logs entry |
| Billing | `CI CPU Time`, category `Build & Deploy`, unit `minute`, team-level, no region (Captured: zero line, billing day 2026-11-10) | Usage page, `GET /v1/billing/charges` | See the Billing entry |

CPU minutes are CPUs times run time, rounded up to the second: 4 CPUs for bootstrapping by default, 2 per task by default; cached and skipped tasks use none (Documented).

## 2. Out-of-the-box shape

Nothing captured yet. The shape of a task-log response, from the OpenAPI spec (`GET /v1/vercel-ci/invocations/{invocationId}/attempts/{attempt}/task-logs`, Documented):

| Field | Note |
| --- | --- |
| `tasks[].jobDefinitionId`, `jobName`, `jobRunAttempt` | The job |
| `tasks[].taskDefinitionId`, `taskName`, `taskRunAttempt` | The task, named like `web#test` |
| `tasks[].conclusion` | Completed tasks only |
| `tasks[].lines[].level`, `timestamp`, `message` | One log line; `timestamp` is a number |
| `hasMore` | More tasks matched than returned; with `search`, more than 1,000 lines matched |

No trace ID, commit SHA, branch or repository is in the line objects; they come from the run. The CLI `--json` output shape isn't documented.

## 3. Extras beyond the default

| Extra | What it adds |
| --- | --- |
| Turborepo OpenTelemetry export (`futureFlags.experimentalObservability`) | Run and task metrics over OTLP from the `turbo` process (see [Turborepo](turborepo.md)). Whether it works inside Vercel CI tasks and reaches an external endpoint: Not observed |
| Your own OTLP export from task scripts | Whatever the test or build tool emits, sent with the task's environment variables (CI environment variables are repository-scoped) |
| `ci:cpus` tags, bootstrapping `vcpus` | Change CPU minutes per task, not the telemetry |

## 4. Getting it out

| Signal | Exit path | Tested configuration |
| --- | --- | --- |
| Task logs | Pull `GET /v1/vercel-ci/invocations/{id}/attempts/{n}/task-logs` (filter by `task`, `conclusion`, `level`, `search`; up to 25 tasks per request), or per job or task run `…/logs` | Not tested |
| Live task logs | `vercel ci logs <run> --task <name> --follow --json` streams JSONL | Not tested |
| Run and task status | Pull `…/job-definitions/{id}/runs` and `…/task-runs`; `vercel ci list --json`, `vercel ci inspect --json` | Not tested. The spec has no endpoint to list runs (OpenAPI, 2026-11-12); the CLI lists them |
| Pass or fail | GitHub check; GitHub's own webhooks and APIs can forward it | Not tested |
| Configuration changes | Activity Log | Not tested |
| Cost | `GET /v1/billing/charges` | Pulled, 2026-11-12 (zero) |

Can't leave Vercel by push: no log drain source (sources are `build`, `edge`, `lambda`, `static`, `external`, `firewall`, `redirect`; docs checked 2026-11-12), no Vercel webhook event, no metric. A forwarder has to find a run (CLI, or the GitHub check), then pull its logs.

## 5. In Bronto

Nothing ingested, and there is no push path yet. A forwarder that pulls the task-log endpoint after each run and sends each line as an OpenTelemetry log record, with `jobName`, `taskName`, `conclusion` and `level` as attributes, would allow queries like these (Not tested; the dataset name is whatever the forwarder sets):

| Question | Query | Group by |
| --- | --- | --- |
| Which tasks fail most | `level IN ('error', 'fatal')` | `taskName` |
| Is a test flaky across runs | `message LIKE '%ECONNRESET%'` | `taskName`, day |

## Gotchas

1. **No drain, no webhook.** CI logs and status are pull-only: dashboard, CLI, MCP and REST (Documented, 2026-11-12).
2. **Cached tasks show someone else's log.** A task restored from Remote Cache returns the log of the run that produced the cache entry (Documented, OpenAPI).
3. **Retention isn't documented.** Pull logs after each run if you need them later.
4. **Beta limits.** GitHub only, no public repositories, Linux only, `git push` as the only trigger, and a repository can't be connected to projects in more than one team (Documented).
5. **Cost is one team-level line.** `CI CPU Time` has no project or repository tag in the lab's zero line (Captured); whether billed lines carry one: Not observed.

## Samples

| File | What it shows |
| --- | --- |
| [`charges-ci-cpu-time-2026-11-10.jsonl`](../samples/vercel-ci/charges-ci-cpu-time-2026-11-10.jsonl) | The `CI CPU Time` billing line (zero), team ID redacted |
| [`activity-types.txt`](../samples/vercel-ci/activity-types.txt) | Vercel CI Activity Log types from `vercel activity types` |
| [`cli-help-65.14.0.txt`](../samples/vercel-ci/cli-help-65.14.0.txt) | `vercel ci`, `ci logs`, `ci list`, `ci inspect` and `ci grep` help |

## Sources

- Vercel changelog and blog, read 2026-11-12: [Vercel CI is now in beta](https://vercel.com/changelog/vercel-ci-is-now-in-beta) (2026-10-28), [Introducing Vercel CI](https://vercel.com/blog/introducing-vercel-ci) (2026-10-28).
- Vercel docs, read 2026-11-12: [Vercel CI](https://vercel.com/docs/ci) (last updated 2026-10-28), [Vercel CI Pricing](https://vercel.com/docs/ci/pricing) (last updated 2026-10-28), [vercel ci](https://vercel.com/docs/cli/ci), [Log drains reference](https://vercel.com/docs/drains/reference/logs) (sources), [OpenAPI spec](https://vercel.com/openapi.json) (`vercel-ci` tag).
- Lab, 2026-11-12, read-only: Vercel CLI 65.14.0 (`ci … --help`, `activity types`, `metrics schema`), `vercel api "/v1/billing/charges?from=2026-11-10T08:00:00Z&to=2026-11-11T08:00:00Z"`.
