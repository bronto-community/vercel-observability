# Deployments, Rolling Releases and domains

> Deployment lifecycle events (created, succeeded, promoted, error, canceled, rollback, Rolling Release stages, domain and certificate events) are not in any drain. They leave Vercel only as webhooks: signed JSON POSTs to a URL you run, retried for up to 24 hours. To get them into an OTLP backend you need a small receiver of your own. The lab's receiver is a Next.js route that verifies the signature and writes each `deployment.*` event as an OpenTelemetry log record with the Logs SDK and the standard OTLP exporter; that step is the lab's code, not a Vercel feature. Over 5 days it forwarded 116 events for 40 deployments. The things to plan for: Vercel delivered one `deployment.canceled` twice with two different event IDs, `deployment.promoted` carries no `target`, and `promoted` arrived before `succeeded` in 12 of 35 deployments.

| | |
| --- | --- |
| Kind | Platform service (deployments, promotion, rollback, Rolling Releases, domains) |
| Plans | Webhooks on all plans; Rolling Releases on Pro (one project) and Enterprise (Documented) |
| Signals | Events (webhooks); state through the REST API |
| Exit paths | Webhook → your receiver → OTLP logs (lab code) · REST API |
| Verified | 2026-10-26 · Vercel CLI 65.2.0 · `@opentelemetry/sdk-logs`, `api-logs`, `exporter-logs-otlp-proto` 0.223.0 · Next.js 16.3.6 · lab project `petclinic-agent` |

## 1. What it emits

| Signal | What | Where it lives | Retention |
| --- | --- | --- | --- |
| Events | Webhook events, one POST per event: `deployment.*`, `project.rolling-release.*`, `domain.*`, `project.domain.*`, `alerts.triggered`, `flag.*` and others | Your endpoint only; Vercel keeps no event log you can query | Retried up to 24 h on non-2xx, then discarded (Documented) |
| Other | Deployment state and timings (`readyState`, `errorCode`, `buildingAt`, `ready`), Rolling Release state | REST API, `vercel inspect`, `vercel list` | With the deployment |
| Other | Rolling Release comparison (traffic split, metrics per version) | Observability › Rolling Releases | Not exportable (Documented, research A1) |

Event families relevant here (Documented, [Webhooks API](https://vercel.com/docs/webhooks/webhooks-api), last updated 2026-09-17):

| Family | Events |
| --- | --- |
| Deployments | `deployment.created`, `.ready`, `.succeeded`, `.error`, `.canceled`, `.promoted`, `.rollback` ("accepted", traffic may still be switching), `.check-rerequested`, `.cleanup` (after the 30-day recovery period), `.integration.action.{start,cancel,cleanup}` |
| Rolling Releases | `project.rolling-release.started`, `.approved`, `.completed`, `.aborted`, each with `payload.rollingRelease` (`state`, `activeStageIndex`, `config`) and `payload.prevRollingRelease` |
| Domains | `domain.created`, `.certificate-add`, `.certificate-add-failed`, `.certificate-renew`, `.certificate-renew-failed`, `.certificate-deleted`, `.dns-records-changed`, `.renewal`, `.renewal-failed`, `.transfer-in-*`, `.auto-renew-changed`; project-scoped `project.domain.{created,deleted,moved,unverified,updated,verified}` |

The lab's webhook subscribes to five events only: `deployment.created`, `.succeeded`, `.error`, `.canceled`, `.promoted` (Captured: `api-webhook-config.json`). Everything else in the table is Not observed.

## 2. Out-of-the-box shape

### The webhook payload

Envelope as documented: `type`, `id` (the delivery ID), `createdAt`, `region`, `payload` with `team.id`, `user.id`, `project.id`, `target` (`production`, `staging` or `null`), `deployment` (`id`, `url`, `name`, `meta`) and `links` (`deployment`, `project`: dashboard URLs). Each request carries `x-vercel-signature`, the hex HMAC-SHA1 of the body with the webhook's secret; the request times out after 30 s (Documented).

The lab didn't keep raw payloads; what reached the backend is what the receiver copied out of them. From those records (Observed):

| Payload field | Seen as | Note |
| --- | --- | --- |
| `type` | `deployment.created` … | |
| `id` | `HJqD5A5him9qAv2JHVEg1` | Unique per delivery, also for duplicates (Gotcha 1) |
| `createdAt` | `1792777634359` | **Milliseconds since epoch.** The docs' envelope shows an ISO date; the records' timestamps are only correct because it is a number |
| `payload.target` | `production` or absent | Absent on all preview deployments and on 34 of 35 `deployment.promoted` events |
| `payload.project.id`, `payload.deployment.{id,name,url}` | | On every event |
| `payload.deployment.meta.githubCommit*`, `githubOrg`, `githubRepo` | branch, SHA, message, author login | With the Git integration. Deploys from the CLI carry no repository fields (research W2) |

### What the lab's receiver writes

[`apps/web/app/api/vercel-webhook/route.ts`](https://github.com/bronto-community/petclinic-agent/blob/main/apps/web/app/api/vercel-webhook/route.ts) (lab code, ~100 lines):

1. Reads the raw body, checks `x-vercel-signature` against `VERCEL_WEBHOOK_SECRET` with a constant-time compare, answers `401` otherwise.
2. Ignores every type not starting with `deployment.`.
3. Emits one log record through a `LoggerProvider` with a `BatchLogRecordProcessor` and `OTLPLogExporter` (`@opentelemetry/exporter-logs-otlp-proto`), configured only by `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS`.
4. Calls `loggerProvider.forceFlush()` inside Next.js `after()`, so the export finishes before the function is frozen.

The resulting record (Captured: `otlp-log-promoted.json`, as stored by the backend, attributes flattened):

| OTLP field | Value | From |
| --- | --- | --- |
| Resource `service.name`, `service.namespace` | `vercel-deployments`, `petclinic-agent` | Fixed in code |
| Event name | `deployment.promoted` | `type` |
| Timestamp | `createdAt` | |
| Severity | `ERROR` (17) for `deployment.error`, else `INFO` (9) | Derived in code |
| Body | `deployment.promoted petclinic-agent petclinic-agent-f1afzsrgt-brontoio.vercel.app` | `type`, name, target, URL joined by spaces |
| `vercel.event.id`, `vercel.project.id`, `vercel.project.name`, `vercel.deployment.id`, `vercel.deployment.url`, `vercel.target` | | Payload; `vercel.target` left out when Vercel sends none |
| `vcs.provider.name`, `vcs.owner.name`, `vcs.repository.name`, `vcs.repository.url.full`, `vcs.ref.head.name`, `vcs.ref.head.type`, `vcs.ref.head.revision` | `github`, `bronto-community`, … `main`, `branch`, `abd0ee3e…` | `meta`, named per the OpenTelemetry VCS semantic conventions |
| `vercel.git.commit.message`, `vercel.git.commit.author` | | `meta`; no semantic convention exists for these |
| Trace context | trace ID of the webhook's own `POST /api/vercel-webhook` request | Active span from `@vercel/otel`; the same trace ID is on the request's spans in the trace drain (Observed) |

Not forwarded: `payload.links`, `team`, `user`, `region`, `regions`, `plan`, the other `meta` keys and the raw body.

Two earlier versions of the receiver wrote some of the 116 records: until 2026-10-19 20:22 UTC the commit author and message were under `vcs.commit.*`, and the first version wrote `target: preview` when Vercel sent none (one `deployment.promoted` record shows it). Until 2026-10-21 14:53 UTC the receiver built OTLP JSON by hand; those records have an all-zero trace ID (Observed, commits `54c81f6`, `f8e21d2`, `0230eda`).

### What the lab received

2026-10-19 19:32 to 2026-10-23 17:47 UTC, 40 deployments (Observed):

| Event | Count | `target` |
| --- | --- | --- |
| `deployment.created` | 40 | `production` 36, absent 4 (preview) |
| `deployment.succeeded` | 37 | `production` 35, absent 2 |
| `deployment.promoted` | 35 | absent 34, `preview` 1 (written by the receiver, see above) |
| `deployment.error` | 2 | `production` 1, absent 1 |
| `deployment.canceled` | 2 | absent; both for the same deployment |

- `created` → `succeeded` took 25 to 65 s, median 33 s, the same as the build (see the Builds entry). For one deployment, `created` came 1.3 s after the REST API's `createdAt` and `succeeded` 1.8 s after `ready`.
- The two `deployment.error` events match the two failed builds: same `deploymentId`, errorCode `BUILD_UTILS_SPAWN_1` in the REST API (Captured: `otlp-log-error-production.json`, `otlp-log-error-preview.json`).
- `deployment.succeeded` arrived for every successful build, although the lab registers no deployment checks. The docs describe it as requiring registered checks.
- One `deployment.created` for `dpl_Ah7MKaZC1c9zna3e7K9sxPVjpdxu` carried a `createdAt` 22 hours after that deployment's `succeeded` and `promoted` events. Cause unknown.

A full lifecycle of one production deployment is in `deployment-lifecycle.ndjson`.

## 3. Extras beyond the default

| Extra | What it adds |
| --- | --- |
| Git integration | Branch, commit SHA, message and author on every event (`meta.githubCommit*`) |
| Subscribing to more events | `deployment.ready`, `.rollback`, `project.rolling-release.*`, `domain.certificate-renew-failed` and others need only a checkbox on the webhook and, in the lab's receiver, removing the `deployment.` prefix check |
| `@vercel/otel` in the receiving app | Gives the event record the trace context of the delivery request, so a slow or failing delivery can be found in traces |

## 4. Getting it out

| Signal | Exit path | Tested configuration |
| --- | --- | --- |
| Deployment events | Account webhook scoped to the project → receiver route in the same project → OTLP/HTTP protobuf logs | Webhook `account_hook_FtW3…`, five `deployment.*` events, URL `https://petclinic-agent.vercel.app/api/vercel-webhook`, secret in `VERCEL_WEBHOOK_SECRET`; exporter from `OTEL_EXPORTER_OTLP_*` |
| Rolling Release and domain events | Same webhook, more event types | Not observed |
| Deployment state, error code, timings | REST `GET /v13/deployments/{id}`, `vercel inspect` | Read-only calls |
| Rolling Release comparison metrics | None | |

Running the receiver inside the project it reports on has a cost: when that project is down or its firewall blocks the call, the events go into Vercel's 24-hour retry, and after that they are gone. A receiver in a separate project or outside Vercel avoids the dependency. Send each event once: one webhook per destination, and a receiver that writes each delivery once.

The trace drain holds 117 edge spans for `POST /api/vercel-webhook` over 7 days: 21 with status `200`, 96 without a status code, none with 4xx or 5xx (Observed). Whether Vercel retried any delivery is Not observed.

## 5. In Bronto

| Data | Dataset | Field names |
| --- | --- | --- |
| Forwarded events | `petclinic-agent/vercel-deployments` | OTLP attributes with a `$` prefix: `"$vercel.deployment.id"`, `"$vercel.target"`, `"$vcs.ref.head.name"`, `$severity_text`; the body is `@raw` |

Queries, each run against the lab's last 7 days on 2026-10-26:

| Question | Query | Group by | Result |
| --- | --- | --- | --- |
| Events per type | `@raw LIKE 'deployment.created%'` (and `.succeeded`, `.promoted`, `.error`, `.canceled`) | | 40 · 37 · 35 · 2 · 2 |
| Failed deployments | `$severity_text = 'ERROR'` | `$vercel.target`, `$vcs.ref.head.name` | `production`/`main` 1 · no target/`lab/broken-build` 1 |
| Deploys per branch | `@raw LIKE 'deployment.%'` | `$vcs.ref.head.name` | `main` 112 · `lab/broken-build` 2 · `lab/preview` 2 |
| Duplicate deliveries | `@raw LIKE 'deployment.canceled%'` | `$vercel.deployment.id` | `dpl_8iqP16ZFN8YkuKzMGzy9bCF1Nd5b` 2 |
| Production releases (deploy markers) | `@raw LIKE 'deployment.promoted%'` | `$vcs.ref.head.revision` | 34 commits |

`"$vercel.deployment.id"` here equals `deploymentId` in `petclinic-agent/vercel-logs`, so a release can be lined up with the runtime errors of that deployment (the Functions entry has "Errors per deployment").

## Gotchas

1. **Duplicates with new IDs.** Vercel delivered `deployment.canceled` twice for `dpl_8iqP16ZFN8YkuKzMGzy9bCF1Nd5b`, 108 ms apart, with two different event IDs (Captured: `otlp-log-canceled-twice.ndjson`). Deduplicating on the event ID doesn't help; use deployment ID plus event type.
2. **No order.** `deployment.promoted` arrived before `deployment.succeeded` in 12 of 35 deployments, and one `created` arrived 22 hours late. Treat events as state updates, not a sequence.
3. **`promoted` has no target.** 34 of 34 `deployment.promoted` events from Vercel had no `payload.target`; preview deployments have none on any event. Missing target doesn't mean preview on a promotion (research W4).
4. **Nothing in the drains.** Log, trace and analytics drains carry no deployment events; without a webhook there are no deploy markers outside Vercel (research W1).
5. **24 hours, then gone.** Undelivered events are retried with exponential backoff for 24 h and then discarded (Documented). Vercel keeps no event history you can re-read; the REST API shows the current state only.

## Samples

| File | What it shows |
| --- | --- |
| [`api-webhook-config.json`](../samples/deployments/api-webhook-config.json) | The lab's webhook: five events, one project (`GET /v1/webhooks`, secret removed) |
| [`otlp-log-created-production.json`](../samples/deployments/otlp-log-created-production.json) | `deployment.created` with Git metadata and target |
| [`otlp-log-succeeded-production.json`](../samples/deployments/otlp-log-succeeded-production.json) | `deployment.succeeded` |
| [`otlp-log-promoted.json`](../samples/deployments/otlp-log-promoted.json) | `deployment.promoted`: no target, trace ID of the delivery request |
| [`otlp-log-error-production.json`](../samples/deployments/otlp-log-error-production.json) | `deployment.error` of a production build, severity `ERROR` |
| [`otlp-log-error-preview.json`](../samples/deployments/otlp-log-error-preview.json) | `deployment.error` of a preview build, no target |
| [`otlp-log-canceled-twice.ndjson`](../samples/deployments/otlp-log-canceled-twice.ndjson) | The duplicate `deployment.canceled` pair |
| [`deployment-lifecycle.ndjson`](../samples/deployments/deployment-lifecycle.ndjson) | created → succeeded → promoted for one production deployment |

The `otlp-log-*` samples are records as stored by the backend after OTLP ingestion (body, timestamp in ms, resource and log attributes flattened), not Vercel's webhook payload.

## Sources

- Vercel docs, read 2026-10-26: [Webhooks API](https://vercel.com/docs/webhooks/webhooks-api) (last updated 2026-09-17), [Rolling Releases](https://vercel.com/docs/rolling-releases) and [Instant Rollback](https://vercel.com/docs/instant-rollback) (via research A1).
- Lab: Bronto EU dataset `petclinic-agent/vercel-deployments`, 2026-10-19 to 2026-10-23; trace drain dataset `.traces/vercel-traces`; `vercel api /v1/webhooks`, `/v13/deployments/{id}`; receiver code and its history in `apps/web/app/api/vercel-webhook/route.ts`.
- Research: `research/I-lab-findings.md` W1–W4; `research/A1-vercel-platform.md` §6 and webhooks.
