# Alerts (anomaly alerts, Vercel Agent investigations)

> Vercel Alerts come from monitors (called alert rules until October 2026). Built-in monitors use Vercel-defined detectors: error anomalies (a route's five-minute 4xx or 5xx count against its trailing 24-hour baseline) and usage anomalies (function invocations, duration, Active CPU, Fast Data Transfer, CDN requests); they choose triggers, project scope, minimum severity and destinations, not thresholds. Since 2026-10-26, custom monitors add a threshold or anomaly condition on one Observability metric or a ratio of two, per project, at $0.0035 per GB of data scanned (Documented); the lab team's schema offered both types on 2026-11-12 (Observed). An alert leaves Vercel as an `alerts.triggered` webhook (a signed JSON POST with severity, z-score, baseline and a dashboard link) or as a GET from the Alerts API (`vercel alerts --format json`). Email and Slack are notifications for people. No drain carries alerts. The thing to plan for: alerts use only data collected while Observability Plus was on, and Vercel holds them back for 24 hours (error anomalies) or 3 days (usage anomalies) after enabling it. The lab enabled Plus on 2026-10-26, has only the default monitor and no custom monitor, and no alert group had been created team-wide by 2026-11-12, so every payload below is Documented.

| | |
| --- | --- |
| Kind | Platform service (Observability Plus) |
| Plans | Pro and Enterprise with Observability Plus; anomaly alerts GA 2026-04-13; custom monitors since 2026-10-26, up to 50 per team, $0.0035 per GB scanned; Vercel Agent Investigation in Public Beta, 10 investigations per billing cycle included with Plus (Documented) |
| Signals | Events (alert groups) |
| Exit paths | Webhook (`alerts.triggered`) · REST API (`/alerts/v3/groups`) · Slack, email, push (notifications) |
| Verified | 2026-10-26 · Vercel CLI 65.2.0 · lab team with project `petclinic-agent` |
| Refreshed | 2026-11-12 · docs and changelog to 2026-11-12, no new captures; read-only `vercel monitors ls`, `schema`, `notifications ls`, `vercel alerts`, `vercel api /v1/webhooks` · Vercel CLI 65.14.0 |

## 1. What it emits

| Signal | What | Where it lives | Retention |
| --- | --- | --- | --- |
| Alert groups | One group per anomaly (grouped by route and HTTP status group for errors, by metric for usage), with severity `low`, `medium`, `high` or `critical` | Observability › Alerts, `vercel alerts`, `GET /alerts/v3/groups` | Not documented |
| Custom monitor alerts | Alerts from a custom monitor (metric or ratio, threshold or anomaly), filterable by monitor | Observability › Alerts | Not documented |
| Investigations | Vercel Agent's summary and key findings for a Medium or High alert | Alert details page, Slack, `vercel alerts --ai` | Not documented |
| Notifications | The same alert sent to team owners, email, push, Inbox, Slack channels, incident.io, webhooks; each destination can be set to Critical Only (since 2026-10-28) | Destinations | |

Alert types (Documented, Alerts docs, last updated 2026-09-09):

| Type | Fires when | Grouped by |
| --- | --- | --- |
| `error_anomaly` | A route's five-minute error count is unusually high against its 24-hour baseline and passes Vercel's minimum activity checks. 5xx by default; a rule can select 4xx | Route, HTTP status group |
| `usage_anomaly` | Five-minute usage is more than 4 standard deviations above the 24-hour average and crosses a minimum activity threshold. Metrics: `function_invocations`, `fluid_duration`, `fluid_cpu_duration`, `fast_data_transfer`, `edge_requests` | Metric |

Vercel computes severity from signals such as z-score and error-rate impact. Only a completed Vercel Agent investigation sets `critical` (Documented). Every monitor includes Critical alerts and sends them to all its destinations; `critical` can't be picked as a minimum severity (Documented, Configure alerts, read 2026-11-12).

Custom monitors (Documented, Configure alerts and `vercel monitors`, read 2026-11-12):

| Setting | Values |
| --- | --- |
| Scope | Exactly one project (`--project`; no `--all`) |
| Measure | One metric with aggregation and filters, or a ratio of a numerator and denominator query on the same event; optional group-by on one dimension (route, path, status code, cache status, region), each group evaluated on its own |
| Condition | `is above`, `is below` a fixed value; `is anomalously high`, `is anomalously low` by a number of standard deviations |
| Window | `5 min` (24-hour baseline, runs every 5 min), `1h` (7-day baseline, every 30 min), `1d` (7-day baseline, every 2 h). Below and anomalously-low conditions wait 10 min for data to finish ingesting |
| Minimum sample | `Only if metric >=` / `Only if numerator >=` for anomaly and ratio threshold alerts |
| Cost | $0.0035 per GB of data scanned; Observability Plus required |

A custom monitor isn't evaluated while its window includes a period when Observability Plus was off; it resumes on its own (Documented).

## 2. Out-of-the-box shape

### Monitors (formerly rules)

A team starts with one monitor, `ar_default`, which can't be deleted and accepts only notification changes (Captured: `cli-alert-rules-ls.json`):

```json
{ "rules": [ {
  "type": "built-in", "name": "Default Alert Rule", "id": "ar_default", "isDefault": true,
  "ruleScope": { "type": "all" },
  "triggers": { "mode": "all" },
  "matchMinimumSeverityLevel": "high",
  "notificationSettings": { "enableTeamOwnerNotifications": true } } ] }
```

So out of the box, every project gets error and usage anomaly alerts at `high` and above, sent to team owners. On 2026-11-12, `vercel monitors ls --all --format json` (CLI 65.14.0) returned the same single monitor, `vercel monitors ls --all --type custom` returned none, and `vercel monitors notifications ls` listed 0 destinations (Observed).

`vercel monitors` replaces the `vercel alerts rules` command tree, which is deprecated (Documented, `vercel monitors` docs read 2026-11-12). The commands below that use `vercel alerts rules` were run with CLI 65.2.0.

The rule schema (`vercel alerts rules schema --format json`, `schemaVersion: 3`) lists one rule type for the team, `built-in` (Captured: `cli-alert-rules-schema-built-in.json`). Its fields:

| Field | Values |
| --- | --- |
| `ruleScope` | `{type: all}`, `{type: include, projectIds}`, `{type: exclude, projectIds}` |
| `triggers` | `mode: selected` with items `usage_anomaly` (optional filter `metrics:(edge_requests OR function_invocations)`) or `error_anomaly` (required filter with `statusGroup:4xx` or `statusGroup:5xx`, optional `route`, wildcards and regexes allowed) |
| `matchMinimumSeverityLevel` | `low`, `medium`, `high` (and everything above) |
| `notificationSettings` | `enableTeamOwnerNotifications`, `vercelNotificationsMinimumSeverityLevel` (`critical`), `incidentIoRoutingKey` (added to this rule's webhook payloads) |
| `tags` | Up to 10 |

On 2026-10-27 this schema offered no threshold on any metric: a non-default rule was a built-in detector with your own scope, filter, severity and destinations (Observed). On 2026-11-12, `vercel monitors schema --format json` (CLI 65.14.0, `schemaVersion: 3`) listed two monitor types for the team, `built-in` and `custom` (Observed). The `custom` body has `type`, `name`, `severity`, `evaluation` (`window`, `query.metrics.<alias>` with `metric`, `aggregation`, `filter`, and `outputs`) and `trigger` (`type: threshold`, `output`, `operator`, `threshold`, or an anomaly trigger) (Documented, example from Configure alerts). Metric names come from `vercel metrics schema`.

### Alert history

`vercel alerts --all --since 2026-09-26T00:00:00.000Z --format json` returned `{"groups": []}`; `vercel alerts --ai` printed "No alerts found" (Captured: `cli-alerts-list-30d.json`). Plus had been on for less than a day, inside the documented 24-hour hold-back (Observed 2026-10-26).

On 2026-11-12, `vercel alerts --all --since 2026-10-13T00:00:00.000Z --format json` (CLI 65.14.0) still returned `{"groups": []}` for the whole team, which includes `petclinic-agent` and `vercel-observability-lab` (Observed). The lab has had little traffic since about 2026-11-02, and nothing in it crossed the default monitor's `high` threshold.

### Webhook payload (Documented)

Envelope as for every Vercel webhook: `type` (`alerts.triggered`), `id` (delivery ID), `createdAt`, `region`, `payload`, signed with `x-vercel-signature` (hex HMAC-SHA1 of the body; see the Deployments entry). Payload fields from the Webhooks API reference (read 2026-10-26):

| Field | Meaning |
| --- | --- |
| `payload.teamId`, `teamSlug`, `projectId`, `projectSlug` | Scope |
| `payload.startedAt` | Anomaly start, ms since epoch |
| `payload.groupId` | Alert group ID (optional); the ID `vercel alerts inspect` takes |
| `payload.severity` | `low`, `medium`, `high`, `critical` |
| `payload.initialSeverity` | Severity before any Agent investigation (optional) |
| `payload.level` | Legacy: `warning`, `error`, `critical`; `high` and `critical` both map to `critical` |
| `payload.links.observability` | Dashboard URL for the alert |
| `payload.alerts[]` | One entry per alert in the group: `alertId`, `type`, `metric` (such as `edge_requests`), `title`, `startedAt` (ISO 8601), `unit`, `count`, `average`, `stddev`, `zscore`, `zscoreThreshold`, `formattedValues` |

Not in the documented payload: the investigation summary or findings, the route as its own field (only through `title` and `formattedValues`, Not observed), the rule ID.

## 3. Extras beyond the default

| Extra | What it adds | Cost |
| --- | --- | --- |
| Observability Plus | Alerts at all. Error anomalies start 24 h after enabling, usage anomalies 3 days after; disabling stops alerts and re-enabling restarts the wait | $1.20 per 1M events (Documented); anomaly alerts at no extra cost (Documented) |
| Alert rules | Per-route or per-metric filters, 4xx detection, project scope, lower severity threshold, Slack channels per rule | None |
| Custom monitors | Threshold or anomaly alerts on one metric or a ratio, per project, with group-by; JSON bodies with `vercel monitors add`; Terraform `vercel_custom_monitor` | $0.0035 per GB of data scanned, Observability Plus (Documented) |
| Critical Only on a destination | Vercel Agent investigates each alert first and delivers only those it assesses as Critical; pre-selected for incident.io destinations. `vercel monitors notifications link … --critical-only` (or `update`) | Needs Agent investigations: 10 per billing cycle with Plus, then billed (Documented, changelog 2026-10-28) |
| Vercel Agent Investigation | Runs automatically on Medium and High alerts when enabled in team settings (or manually from the alert page); queries logs and metrics around the alert, groups related alerts, sets severity, writes a summary. Results in the dashboard, Slack and `vercel alerts --ai` | 10 per billing cycle with Plus; then provider token cost plus $0.25 per 1M tokens (Documented) |
| incident.io routing key, tags | `incidentIoRoutingKey` in a rule's webhook payloads; monitor tags are sent to incident.io as routing keys | None |

## 4. Getting it out

| Signal | Exit path | Tested configuration |
| --- | --- | --- |
| Alerts | Webhook destination linked to a monitor (`alerts.triggered`); optionally Critical Only | None in the lab: the team's two webhooks subscribe only to `deployment.*` events (Captured: `api-webhooks-events.json`; unchanged on 2026-11-12, Observed) |
| Alerts | REST API, polled: `GET /alerts/v3/groups?teamId=…&projectId=…&from=…` (what `vercel alerts --format json` calls), `vercel alerts inspect <groupId>` | Ran read-only, empty result (Observed) |
| Monitors | `GET /alerts/v3/alert-rules?teamId=…`, `GET /alerts/v3/alert-rules/schema?teamId=…` (2026-10-26); `vercel monitors ls`, `inspect`, `schema` with `--format json`, `GET /alerts/v3/monitors/notifications/discover-slack-channels` (from the schema's `notificationDiscovery`) | Ran read-only (Observed, endpoints from `--debug` on 2026-10-26 and from the schema on 2026-11-12) |
| Investigations | `vercel alerts --ai`, dashboard, Slack. Not in the documented webhook payload | Not observed |
| Email, push, Slack | Notifications for people | Not tested |

To land alerts in an OTLP backend, the path is the same as for deployment events: a webhook receiver that verifies `x-vercel-signature` and writes each event as an OpenTelemetry log record with the Logs SDK and the standard OTLP exporter. The lab's receiver (`apps/web/app/api/vercel-webhook/route.ts`) answers `{ignored: true}` for any type not starting with `deployment.`, so it would drop `alerts.triggered` as written.

Since the monitors change, a webhook destination receives `alerts.triggered` only for the monitors linked to it, with their trigger conditions and project scope; a webhook linked to no monitor receives no alert events. Account-wide alert webhooks created before keep receiving all alert events until they are linked to a monitor, which then limits them to the linked monitors (Documented, Configure alerts, read 2026-11-12).

Which documented delivery events exist is unclear: the webhook reference says `alerts.triggered` "occurs whenever an alert is triggered", while Vercel's uptime guide (2026-06-02) says Vercel sends a POST "whenever an alert group is created, updated, or resolved" (Documented, conflicting; Not observed).

## 5. In Bronto

Not observed: no alert had fired by 2026-11-12 and no webhook forwards `alerts.triggered`. With the receiver extended to `alerts.*`, the events would land next to the deployment events in `petclinic-agent/vercel-deployments` as OTLP log records, with the attributes the receiver sets under a `$` prefix. Queries belong here once events exist.

## Gotchas

1. **No alerts right after enabling Plus.** Error anomalies wait 24 hours and usage anomalies 3 days after Observability Plus is enabled or re-enabled; alerts use only data collected while Plus was on (Documented). The lab's alert list was empty on day one (Observed).
2. **The default rule pages only on `high`.** `ar_default` matches `high` and above and notifies team owners. Medium alerts still start an investigation (when enabled) but notify no one unless a rule with a lower severity exists (Captured rule; behaviour Documented).
3. **Built-in monitors have no thresholds; custom monitors do, at a price.** Built-in detectors are anomaly-based with Vercel's minimum activity thresholds and filters on `statusGroup`, `route` or `metrics` (Observed: `rules schema`, 2026-10-26). A fixed "error rate above X" or a "no traffic" (`is below`) alert needs a custom monitor (since 2026-10-26, one project each, $0.0035 per GB scanned; Documented) or the backend that receives the logs. Below and anomalously-low conditions wait 10 minutes before they evaluate (Documented).
4. **`level` hides `critical`.** In the webhook, `high` and `critical` severities both become `level: critical`; read `severity` (Documented).
5. **Webhooks follow the monitors they are linked to.** A webhook destination gets alerts only from linked monitors; one linked to none gets nothing. Older account-wide alert webhooks get every alert until first linked (Documented, 2026-11-12). Before the monitors change, a team webhook received alert events independent of rule destinations (Documented 2026-10-26). The schema links only account webhooks subscribed to `alerts.triggered` (Observed, `notificationDiscovery`, 2026-10-26 and 2026-11-12).
6. **Investigations stay in Vercel.** The documented webhook payload carries severity (which an investigation can raise to `critical`) but no investigation text; pull it with `vercel alerts --ai` or read it in the dashboard (Documented).
7. **Critical Only waits for the Agent.** A destination set to Critical Only gets an alert only after Vercel Agent has assessed it as Critical, which can delay it relative to the monitor's own severity threshold, and each triage uses an Agent investigation (Documented, 2026-10-28).

## Samples

| File | What it shows |
| --- | --- |
| [`cli-alert-rules-ls.json`](../samples/alerts/cli-alert-rules-ls.json) | `vercel alerts rules ls --all --format json`: the default rule |
| [`cli-alert-rules-schema-built-in.json`](../samples/alerts/cli-alert-rules-schema-built-in.json) | `vercel alerts rules schema --type built-in --format json`: fields, filters, constraints, discovery endpoints |
| [`cli-alerts-list-30d.json`](../samples/alerts/cli-alerts-list-30d.json) | `vercel alerts --all --since … --format json`: no alert groups |
| [`api-webhooks-events.json`](../samples/alerts/api-webhooks-events.json) | `GET /v1/webhooks`: event subscriptions of the team's webhooks (no `alerts.triggered`) |

## Sources

- Vercel docs, read 2026-10-26: [Alerts](https://vercel.com/docs/alerts) (last updated 2026-09-09), [Configure alerts](https://vercel.com/docs/alerts/configure-alerts) (2026-09-16), [`vercel alerts`](https://vercel.com/docs/cli/alerts) (2026-09-10), [Webhooks API: `alerts.triggered`](https://vercel.com/docs/webhooks/webhooks-api#alerts.triggered), [Agent Investigation](https://vercel.com/docs/agent/investigation) (2026-09-18), [Anomaly alerts GA](https://vercel.com/changelog/anomaly-alerts-ga) (2026-04-13), [Monitor uptime for AI-native apps with Vercel Alerts](https://vercel.com/kb/guide/monitor-uptime-for-ai-native-apps-with-vercel-alerts) (2026-06-02).
- Vercel docs and changelog, read 2026-11-12: [Configure alerts](https://vercel.com/docs/alerts/configure-alerts) (custom monitors, destinations, Critical Only, webhooks), [Alerts](https://vercel.com/docs/alerts), [`vercel monitors`](https://vercel.com/docs/cli/monitors), [Create custom monitors in Vercel Observability](https://vercel.com/changelog/create-custom-monitors-in-vercel-observability) (2026-10-26), [Vercel Agent can now validate alerts before paging](https://vercel.com/changelog/vercel-agent-can-now-validate-alerts-before-paging-you) (2026-10-28).
- Lab, 2026-11-12: Vercel CLI 65.14.0 `vercel monitors ls --all`, `monitors ls --all --type custom`, `monitors schema`, `monitors notifications ls`, `vercel alerts --all --since 2026-10-13T00:00:00.000Z`, `vercel api /v1/webhooks`, team `brontoio`, read-only.
- Lab: Vercel CLI 65.2.0 `vercel alerts`, `vercel alerts rules ls|inspect|schema` (with `--debug` for the endpoints), `vercel api /v1/webhooks`, 2026-10-26; receiver code `apps/web/app/api/vercel-webhook/route.ts`.
