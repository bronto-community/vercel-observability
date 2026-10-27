# Audit Logs and the Activity Log

> Every configuration change on a Vercel team is an event: a drain created, an env var added, a deployment, Speed Insights enabled, a firewall rule published, a connector attached. On all plans these events sit in the team Activity Log, which keeps everything since the team was created and leaves Vercel only by pull: `vercel activity --format json` or `GET /v3/events?withPayload=true`. Enterprise adds Audit Logs: the same events with the source IP address, user agent and an actor type, exported as CSV or pushed by an Audit Log drain (schema `audit_log` v1) to HTTP, S3, Splunk, Datadog or Panther. A Pro team asking for an `audit_log` drain gets `402: Audit Log Drains are only available on the Enterprise plan`. The lab's own changes from 2026-10-27 are all in the Activity Log with their payloads (five `drain-created`, two `project-speed-insights-enabled`, six `env-variable-add`, three `deployment`). The catch on Pro: no push. Getting these events into a backend means polling the API on a schedule, and a fifth of them are "someone read the env vars" events.

| | |
| --- | --- |
| Kind | Platform service (team-level change history) |
| Plans | Activity Log: all plans. Audit Logs (CSV export, Audit Log drains): Enterprise, team owners only (Documented). Lab team: Pro |
| Signals | Events |
| Exit paths | Pro: CLI and REST pull (`vercel activity`, `GET /v3/events`) · Enterprise: Audit Log drain (`audit_log` v1) to HTTP, S3, Splunk HEC, Datadog, Panther; CSV export |
| Verified | 2026-10-27 · Vercel CLI 65.2.0 · team `brontoio` (Pro) |

## 1. What it emits

| Signal | What | Where it lives | Retention |
| --- | --- | --- | --- |
| Activity events | One event per team or project change, 635 event types in 21 categories | Dashboard › Activity, `vercel activity`, `GET /v3/events` | Since the team was created: the oldest event returned is the team's first, 2026-01-30 (Observed). Docs: "chronologically organized since its creation" |
| Audit Log events (Enterprise) | The Activity Log events plus IP address, user agent, actor type | Team Settings › Security & Privacy › Audit Log (CSV), Audit Log drain | CSV: any timeframe; exports of the last 90 days aren't billed (Documented) |

The type catalog comes from `vercel activity types --format json` (Captured: `cli-activity-types.json`). The categories that matter for observability: `observability` (drains, tracing, Observability Plus, alert rules, webhooks, Speed Insights settings), `deployment`, `env-variable`, `firewall`, `feature-flags`, `connect`, `ai-gateway`. The docs table lists 624 types, of which 592 Active, 9 Deprecated and 23 Replaced (`log-drain-*` became `drain-*`) (Documented, page updated 2026-06-29).

Over 30 days the team (about 15 projects) produced 754 events (Captured: `cli-activity-30d-type-counts.json`): `deployment` 227, `aliases-assigned` 197, env var reads 162 (`env-variable-read:*`), `env-variable-add` 40, `drain-created` 14, `connect-upsert-installation` 14, `drain-updated` 9, `drain-deleted` 4, `tracing-configured` 3, `project-speed-insights-enabled` 3, `observability-enabled` 1, `webhook-created` 1.

## 2. Out-of-the-box shape

### An Activity event (Captured)

The drain the lab created for Speed Insights at 09:17 UTC today, as `vercel activity --all --format json` returns it (Captured: `cli-activity-2026-10-27.json`):

```json
{ "id": "uev_xaJgnKTLAI6cRLvfEfJaKxR6",
  "type": "drain-created",
  "categories": ["observability"],
  "createdAt": 1793092637126,
  "text": "You created a drain with endpoint url bronto.io (via Vercel CLI)",
  "entities": [ { "type": "author", "start": 0, "end": 3 }, { "type": "bold", "start": 38, "end": 47 } ],
  "user":      { "uid": "user_REDACTED_1", "username": "user-1", "email": "user-1@example.com", "avatar": "REDACTED" },
  "principal": { "uid": "user_REDACTED_1", "username": "user-1", "email": "user-1@example.com", "avatar": "REDACTED" },
  "via": [ { "name": "Vercel CLI", "type": "app", "id": "cl_HYyOPBNtFMfHhaUn9L4QPfTZz6TP47bp", "clientId": "cl_HYyOPBNtFMfHhaUn9L4QPfTZz6TP47bp" } ],
  "userId": "user_REDACTED_1", "principalId": "user_REDACTED_1",
  "tokenId": "token_REDACTED", "sessionId": "session_REDACTED",
  "requestId": "wcnwd-1793092637078-d92c0284e5fa",
  "payload": { "id": "drn_QzDJlobvAjI07U5R", "drainUrl": "bronto.io", "drainName": "petclinic-agent-speed-insights" } }
```

| Field | Note |
| --- | --- |
| `id` | `uev_…`, the same ID format as the Audit Log record's `id` |
| `type` | The event type; the Audit Log calls it `action` |
| `createdAt`, `created` | ms since epoch, identical |
| `text`, `entities` | The dashboard sentence and its highlight offsets. Written for the viewer: the caller's own events say "You", everyone else's show their username or display name |
| `user`, `principal`, `userId`, `principalId` | Who did it. Absent on 9 of 754 events, where `text` starts with "System" (Observed) |
| `via` | The app in between, such as the Vercel CLI; empty for dashboard actions (493 of 754) |
| `tokenId`, `sessionId`, `requestId` | Present when the change came through the API or CLI |
| `payload` | Type-specific (below) |

No IP address, user agent or actor type in Activity events; those are what Audit Logs add.

### Observability-relevant events from the lab (Captured)

From 2026-10-27, all times UTC (Captured: `cli-activity-2026-10-27.json`; one example per type over 30 days in `cli-activity-observability-examples.json`):

| Time | Type | Payload |
| --- | --- | --- |
| 08:04:21, 08:30:19, 09:15:46 | `deployment` | `deploymentId`, `target: production`, `regions`, `plan`, Git commit metadata (`githubCommitSha`, `githubCommitMessage`, author) |
| 08:37:37–40 | `drain-created` ×3 (lab logs, traces, Web Analytics) | `id`, `drainName`, `drainUrl` (host only) |
| 09:03:02–17 | `env-variable-add` ×6, `env-variable-read:cli:env:add` ×12, `env-variable-read:cli:env:ls` ×1 | `key`, `type` (`sensitive`, `encrypted`), `target`, `projectId`; never the value |
| 09:16:45, 09:16:55 | `project-speed-insights-enabled` (petclinic-agent, lab) | `projectSpeedInsights.enabledAt`, `hasData`, `dataReceivedAt`, and `prevProjectSpeedInsights` |
| 09:17:15–17 | `drain-created` ×2 (Speed Insights) | as above |

Earlier in the 30 days: `observability-enabled` (Observability Plus, 2026-10-26 09:42, empty payload), `tracing-configured` (`sampling: [{type: head_sampling, rate: 1}]`), `project-web-analytics-enabled`, `webhook-created` (full receiver URL), `firewall-config-promoted` (each rule change with its full rule definition), `env-variable-edit` (`updateDiff` with `changedValue: true`, no value), `drain-updated` and `drain-deleted`.

Not in 30 days: a manual promotion (`manual-deployment-promotion-created`), an instant rollback, alert rule changes. The lab's Git pushes deploy straight to production, which logs as `deployment` with `target: production` plus `aliases-assigned`.

### An Audit Log record (Documented)

Vercel's reference (page updated 2026-08-07) for the drain record, NDJSON:

```json
{"schema":"vercel.audit_log.v1","id":"uev_O0Sn1S6VHTDuKJ6sNs3hLIEy","teamId":"team_123","projectId":"prj_123","action":"drain-created","timestamp":1779444000123,"actor":{"type":"user","id":"user_123","name":"Test User","email":"test@example.com"},"via":[{"type":"app","id":"app_123","name":"Test App"}],"requestId":"req_123","payload":{"drainUrl":"https://example.com"}}
```

| Audit Log field | Activity event field |
| --- | --- |
| `schema` (`vercel.audit_log.v1`) | none |
| `id` (`uev_…`) | `id` (`uev_…`) |
| `action` | `type` |
| `timestamp` | `createdAt` |
| `teamId`, `projectId` at the top level | `scope.teamSlug` on the response; `projectId` inside `payload` |
| `actor.type` (`user`, `app`, `system`, `integration`), `actor.id`, `actor.name`, `actor.email` | `user` / `principal` (`uid`, `username`, `email`); system events have no `user` |
| `via[]` | `via[]` |
| `requestId`, `tokenId` | `requestId`, `tokenId` |
| `userAgent`, `ipAddress` | none |
| `payload` | `payload` |
| none | `text`, `entities`, `categories`, `sessionId` |

The CSV export has `timestamp`, `action`, `actor_vercel_id`, `actor_name`, `actor_email`, `location` (IP), `user_agent`, `request_id`, `previous`, `next` (Documented).

## 3. Extras beyond the default

| Extra | What it adds | Cost |
| --- | --- | --- |
| Audit Logs (Enterprise) | IP address, user agent and actor type on every event; CSV export; Audit Log drain | Enterprise contract. Drain volume $0.50 per GB (Documented). The lab team's 30 days were 1.3 MB of JSON (1.7 KB per event), so volume is not the cost driver |
| Audit Log drain destinations | Custom HTTP (JSON array or NDJSON), Amazon S3, Splunk HEC (`sourcetype: vercel:audit_log`), Datadog Logs API (`ddsource: vercel`, `service: audit-logs`), Panther | As above. Applies to the whole team: no project selection, filters or sampling (Documented) |
| Custom SIEM Log Streaming | The older Enterprise add-on; Vercel is replacing it with Audit Log drains | Paid add-on (Documented) |

## 4. Getting it out

| Plan | Exit path | Tested configuration |
| --- | --- | --- |
| Pro | `vercel activity --all --since <t> --until <t> --limit 100 --format json`, paged | Ran read-only for 30 days of the lab team (Captured) |
| Pro | `GET /v3/events?teamId=…&since=…&limit=…&withPayload=true` (what the CLI calls, seen with `--debug`) | Through the CLI (Observed) |
| Enterprise | Audit Log drain, schema `audit_log` v1 | Not available: `POST /v1/drains/test` with `audit_log` returned `402 Audit Log Drains are only available on the Enterprise plan` (Captured: `api-drains-test-audit-log.txt`) |
| Enterprise | CSV export from Team Settings, emailed link valid 24 h | Not available on Pro |

No webhook event carries activity events, and no other drain type does. To get them into an OTLP backend on Pro, run a scheduled job (a Vercel Cron Job works) that reads `GET /v3/events` since the last `createdAt` it saw and writes each event as an OpenTelemetry log record with the Logs SDK and the standard OTLP exporter, using the event `id` as the deduplication key. Not built in the lab.

Reading through the API leaves no trace of its own: the `vercel api /v1/drains`, `vercel connect list`, `vercel metrics` and `vercel activity` calls made for this entry produced no activity events (Observed, 09:20–09:35 UTC). Reading env var values does: every `vercel env pull`, `env add`, `env ls` logs an `env-variable-read:*` event.

## 5. In Bronto

Not observed: on Pro there is no drain to point at Bronto, and the polling job above isn't built. With it, events would land as OTLP log records, the payload under `$`-prefixed attributes (`"$type"`, `"$payload.drainName"`). On Enterprise, an Audit Log drain in NDJSON to Bronto's HTTP ingestion would store each record with its fields as delivered (`action`, `"actor.email"`). The first queries to add once data exists: changes per type in the hour before an incident, and `drain-deleted` or `drain-updated` as a monitor, since a disabled drain is silent in every other dataset.

## Gotchas

1. **Pro has no push.** The Activity Log is complete and old, but it leaves Vercel only by polling; the Audit Log drain is Enterprise-only and the plan check happens at validation time (Captured: 402).
2. **`drainUrl` is only the host.** `drain-created` records `bronto.io` and the drain name; the endpoint path, the data type and the projects are missing. To know what a drain carries, join `payload.id` to `GET /v1/drains` (Captured).
3. **Reads are a fifth of the volume.** 162 of 754 events in 30 days were `env-variable-read:*`. Each `vercel env add` logged two reads besides the add (12 reads for 6 adds on 2026-10-27) (Observed). Route them separately if they crowd out the changes.
4. **`text` depends on who asks.** The sentence says "You" for the caller's own events and a username or display name for others, and `entities` are offsets into that text. Use `type` and `payload` for anything automated (Captured).
5. **People and secrets.** Events carry usernames, emails, Git commit authors and messages, and full firewall rule definitions; env var events carry the key and target but never the value, and `connect-update-connector` names changed secret fields without values (Captured). Redact before sharing.
6. **The Activity Log docs contradict the drain docs.** The Activity Log page says "Vercel does not emit any logs to third-party services", while the Drains docs offer Audit Log drains to five destinations (Documented). On Pro the first statement holds.
7. **Git deploys don't log a promotion.** A push to the production branch logs `deployment` (`target: production`) and `aliases-assigned`; `manual-deployment-promotion-created` and `instant-rollback-created` appear only for those actions (Observed: none in 30 days; types Captured).

## Samples

| File | What it shows |
| --- | --- |
| [`cli-activity-2026-10-27.json`](../samples/audit-logs/cli-activity-2026-10-27.json) | All 31 team events of 2026-10-27 until 09:20 UTC: drains, Speed Insights, env vars, deployments |
| [`cli-activity-observability-examples.json`](../samples/audit-logs/cli-activity-observability-examples.json) | One event each of 15 observability-relevant types over 30 days (drain created/updated/deleted, tracing, Plus, Speed Insights, Web Analytics, webhook, firewall publish, env var add/edit/delete/read, deployment, aliases) |
| [`cli-activity-30d-type-counts.json`](../samples/audit-logs/cli-activity-30d-type-counts.json) | Event counts by type, 2026-09-27 to 2026-10-27 |
| [`cli-activity-types.json`](../samples/audit-logs/cli-activity-types.json) | `vercel activity types --format json`: 635 types, 21 categories |
| [`api-drains-test-audit-log.txt`](../samples/audit-logs/api-drains-test-audit-log.txt) | `POST /v1/drains/test` with schema `audit_log` on a Pro team: 402 |

People are replaced with `user-n` / `user-n@example.com` (numbering per file), Git commit authors with `Commit Author`, token and session IDs with placeholders, other team projects' IDs with `prj_OTHER_n`. The `entities` offsets refer to the original text and no longer line up after redaction.

## Sources

- Vercel docs, read 2026-10-27: [Audit Logs](https://vercel.com/docs/audit-log) (last updated 2026-08-26), [Audit Log Drains reference](https://vercel.com/docs/drains/reference/audit-logs) (2026-08-07), [Using the Activity Log](https://vercel.com/docs/activity-log) (2026-06-29), [`vercel activity`](https://vercel.com/docs/cli/activity) (2026-03-17), [Working with Drains](https://vercel.com/docs/drains) (2026-09-01), [Using Drains](https://vercel.com/docs/drains/using-drains) (2026-09-17).
- Lab, 2026-10-27: Vercel CLI 65.2.0 `vercel activity` (`--all`, `--type`, `--since`, `--until`, `--format json`, `--debug` for the endpoint), `vercel activity types`, `vercel api /v1/drains/test`.
