# Vercel Connect

> Vercel Connect records five runtime events per connector: token requests, completed OAuth authorizations, token revocations, inbound provider webhooks (triggers) and their forwarding to your projects. They live in each connector's Observability tab for 12 hours (Hobby), 3 days (Pro) or 30 days (Enterprise), and the only way out is a drain with schema `connect` v1 to a custom HTTP endpoint. There is no REST endpoint or CLI command that reads them. The drain works on Pro: Vercel's drain validation accepted a `connect` drain for the lab team, where an `audit_log` drain got a 402. Configuration changes to connectors (created, attached, installation updated, trigger destinations changed) are a separate stream in the team Activity Log. Inside the app, a `getToken` call is an outgoing `fetch` to `api.vercel.com/v1/connect/token/<connector>`, so Vercel's external-API metrics count it per connector: 98 token requests across the team's connectors in 7 days, about 0.3–0.4 s each. The lab has no `connect` drain yet, so no drain record is captured. The thing most people miss: you don't need a new connector to get records. The team's existing Slack connectors already produce token requests every day, and a team-wide `connect` drain would carry them.

| | |
| --- | --- |
| Kind | Platform service (credential broker for third-party APIs, MCP servers and provider webhooks) |
| Plans | All plans; Observability tab on all plans; drains on Pro and Enterprise; connector audit logs and 30-day retention on Enterprise (Documented). Billed per token request: Hobby 500 a month included, Pro $3.00 per 1,000; triggers $0.95 per 1,000 on Pro (Documented, in effect since 2026-09-25) |
| Signals | Events (Connect runtime events) · Events (Activity Log config changes) · Metrics (outgoing `fetch` to the Connect API, Observability Plus) |
| Exit paths | Drain (`connect` v1, custom HTTP endpoint only) · Activity Log via CLI/API pull for config changes · OTLP from code for the `fetch` span |
| Verified | 2026-10-27 · Vercel CLI 65.2.0 · `@vercel/connect` 2.5.2 and eve 0.81.0 (source read, not running in the lab) · team `brontoio` (Pro) |

## 1. What it emits

| Signal | What | Where it lives | Retention |
| --- | --- | --- | --- |
| Connect events | Token Request, Completed Authorization Request, Revoked Token Request, Inbound Trigger, Forward Trigger | Connector › Observability tab; `connect` drain | Hobby 12 h, Pro 3 days, Enterprise 30 days (Documented) |
| Connector config changes | `connect-create-connector`, `connect-attach-project`, `connect-upsert-installation`, `connect-update-connector`, `connect-update-trigger-destinations`, `connect-delete-installation` and 6 more (12 in all) | Activity Log (`vercel activity`, `GET /v3/events`); Audit Logs on Enterprise | Since the team was created (Observed, see the [Audit Logs](audit-logs.md) entry) |
| Token request calls from functions | `POST https://api.vercel.com/v1/connect/token/<connector>` as an external API request | `vercel.external_api_request.*` metrics (Plus) | Plus 30 days (Documented) |
| Spans | The `fetch` span of `getToken` (with `@vercel/otel`); eve MCP and connection-event spans | Trace drain or your OTLP exporter | As for traces |

Connect launched in beta and became generally available on 2026-08-25; the Observability tab and the `connect` drain type arrived on 2026-08-11 (Documented, changelog).

## 2. Out-of-the-box shape

### Connect events (Documented)

No record has been captured: the lab team has no `connect` drain, and no API returns these events. The shape below is from Vercel's events reference (read 2026-10-27, page last updated 2026-08-11). Each event is a JSON object; the drain delivers "each event as a JSON webhook payload".

Common fields:

| Field | Type | Note |
| --- | --- | --- |
| `eventType` | string | One of the five types. The exact string values (display names or snake case) are not in the docs: Not observed |
| `timestamp` | number | ms since epoch |
| `ownerId` | string | The team ID |
| `clientId` | string | The connector's `id` (`scl_…`), the same value `vercel connect list` and the Activity Log show (Captured in both) |
| `clientType` | string | `slack`, `oauth`, … |
| `projectId` | string | Optional; the project that made the request |

Per type:

| Event | Fields beyond the common ones |
| --- | --- |
| Token Request | `subjectType` (`app`, `user`, `jwt-bearer`), `subjectId`, `authorizationId`, `tokenGroupId`, `tokenId`, `scopes`, `environment`, `userId` (Vercel user), `installationId`, `expiresAt`, `refreshTokenExpiresAt` |
| Completed Authorization Request | `subjectType`, `subjectId`, `authorizationId`, `tokenGroupId`, `scopes`, `environment`, `userId`, `installationId`, `externalTenantId`, `refreshTokenExpiresAt` |
| Revoked Token Request | As Token Request, plus `tokenExpiresAt` and the required `revokedAt` |
| Inbound Trigger | `triggerRequestId`, `bodySize`, `externalEventId`, `externalEventType` (such as a Slack event type) |
| Forward Trigger | `triggerRequestId`, `bodySize`, `destinationProjectId`, `destinationPath`, `externalEventId`, `externalEventType`, `status` (`success` or `error`), `reason`, `statusCode` (from your project) |

The correlation keys: `tokenId` follows one token, `authorizationId` the grant behind it, `tokenGroupId` all tokens with the same client, subject, environment, scopes and audience, and `triggerRequestId` ties an inbound webhook to its forwarded deliveries. A Forward Trigger with `status: error` and the `statusCode` your route returned is the record that shows a broken webhook receiver.

The events carry no provider token or webhook body, only IDs, scopes and sizes (Documented).

### Connectors (Captured)

`vercel connect list --all-projects --format json` returns each connector's `uid` (`slack/agentic-gtm`), `id` (`scl_…`), `type`, creation time, branding and linked projects (Captured: `cli-connect-list.json`). The lab team has four: three Slack connectors and one OAuth connector to an MCP server, linked to two other projects. None is linked to `vercel-observability-lab` or `petclinic-agent`; `petclinic-agent` lists `@vercel/connect` 2.5.2 as a dependency but doesn't call it.

### Config changes in the Activity Log (Captured)

Every connector change is an Activity Log event with the connector identity in `payload` (Captured: `cli-activity-connect-events.json`):

```json
{ "type": "connect-attach-project",
  "text": "user-3 attached project team-bot-a to Connector slack/agentic-gtm for Production, Preview and Development environments",
  "payload": { "clientId": "scl_wxD0oAnojqRFZ3gigDdSZg", "clientUid": "slack/agentic-gtm",
               "clientType": "slack", "clientService": "slack", "clientName": "team-bot-c",
               "projectId": "prj_OTHER_2", "environments": ["development", "preview", "production"] } }
```

`connect-update-connector` lists the changed fields by name, secrets included, without values: `"fields": ["uid", "name", "data.clientSecret", "data.signingSecret", "data.verificationToken"]`. `connect-upsert-installation` carries the provider tenant (`installationId`, `tenantId`, the Slack workspace ID). The CLI catalog has 25 `connect-*` types. Twelve belong to Vercel Connect, among them `connect-revoke-all-tokens`, `connect-import-tokens` and the MCP event subscription pair. Six are Secure Compute network changes (`connect-configuration-*`) and seven are Git account connections (`connect-github`, `connect-gitlab`, …), unrelated to Vercel Connect (Captured: `../audit-logs/cli-activity-types.json`).

Token requests and triggers never appear in the Activity Log: in 30 days the team had 98+ token requests (below) and 0 runtime Connect events in `vercel activity` (Observed).

### Token requests as external API calls (Captured)

The SDK's `getToken` is a plain `fetch` to `https://api.vercel.com/v1/connect/token/<uid>` (read in `@vercel/connect` 2.5.2 `dist/token.js`). Vercel's runtime counts every outgoing `fetch`, so the external API metrics show Connect usage per project and connector with no setup beyond Observability Plus (Captured: `metrics-connect-token-requests-7d.json`):

```
$ vercel metrics vercel.external_api_request.count --all --filter "requestPath:/v1/connect/*" \
    --group-by requestHostname --group-by requestPath --group-by requestMethod --since 7d --granularity 1d --json
POST api.vercel.com /v1/connect/token/slack%2Fagentic-gtm            59
POST api.vercel.com /v1/connect/token/slack%2Fbronto-team-bot-a       24
POST api.vercel.com /v1/connect/token/slack%2Fteam-bot-b   15
POST api.vercel.com /v1/connect/authorize/slack%2Fagentic-gtm         1
per day (2026-10-20 … 27): 22, 51, 1, 14, 5, 2, 3, 1
```

Average duration of a token request over 3 days: 336 ms (`team-bot-b`), 379 ms (`agentic-gtm`) (Captured: `metrics-connect-token-duration-3d.json`). Each of these calls is a billed token request, $0.003 on Pro. The SDK caches a token in process until it nears expiry, so this count is the number of cache misses; Slack API calls made with a cached token don't appear in it.

### Spans (Not observed)

Neither lab project calls Connect, so no span exists. From the code:

- With `@vercel/otel`, `getToken` produces a `fetch POST` span to `api.vercel.com`. The Connect request doesn't continue your trace inside Vercel.
- eve 0.81.0 adds `agent.connection.name` (exported as `eve.connection.name`) to MCP client spans (`tools/call <tool>`) of connections, and emits `agent.connection.event.<operation>` spans with `connect.subscription.id`, `connect.subscription.status` and `connect.delivery.id` for MCP event subscriptions (read in `eve/dist/src/tracing/eve/connection-events.js` and `mcp.js`).

## 3. Extras beyond the default

| Extra | What it adds | Cost |
| --- | --- | --- |
| `connect` drain | Every Connect event, beyond the 3-day Pro retention | $0.50 per GB of drained JSON (Documented); the events are small |
| Observability Plus | The `vercel.external_api_request.*` view of token requests (count, duration, status per connector path) | $1.20 per 1M events (Documented) |
| Trigger forwarding | Inbound Trigger and Forward Trigger events, with your receiver's `statusCode` | $0.95 per 1,000 triggers on Pro; each destination counts once; an event with no destination still counts (Documented) |
| Enterprise | 30-day event retention, connector audit logs, role-based access (Documented) | Contract |
| `@vercel/otel` / eve | `fetch` spans for token requests; eve connection spans | None |

## 4. Getting it out

| Signal | Exit path | Tested configuration |
| --- | --- | --- |
| Connect events | Drain, schema `connect` v1, delivery `http` to a custom endpoint, JSON or NDJSON | Validation only: `POST /v1/drains/test` with `{"schemas":{"connect":{"version":"v1"}},"delivery":{"type":"http",…,"encoding":"ndjson"}}` returned `200` and ran a test delivery (Captured: `api-drains-test-connect.txt`). No drain created |
| Connect events | REST API or CLI | None exists: `vercel api list` has no Connect events endpoint, and `vercel connect` has no events subcommand (Observed, CLI 65.2.0) |
| Connector config changes | Activity Log: `vercel activity --type connect-create-connector,…`, `GET /v3/events?withPayload=true` | Ran read-only (Captured). Audit Log drain on Enterprise |
| Token request volume and latency | `vercel metrics vercel.external_api_request.* --filter "requestPath:/v1/connect/*"` | Ran read-only (Captured). No drain carries metrics |
| `getToken` spans | Trace drain with `@vercel/otel`, or your OTLP exporter | Not observed |

The docs add a `connect` drain from the connector's Observability toolbar (Add Drain, then a webhook URL). The Team Settings › Drains type list in the "Using Drains" page doesn't mention Connect (Documented, page updated 2026-09-17). The REST API accepts the schema like any other (`POST /v1/drains` with `schemas: {connect: {version: "v1"}}`). Whether a `connect` drain honours `projectIds` is Not observed; Inbound Trigger events carry no `projectId`, so a project-scoped drain may not receive them.

What can't leave Vercel: provider tokens and webhook bodies (by design); the Observability tab's filters and views.

## 5. In Bronto

Not observed: the lab has no `connect` drain. With the drain pointed at Bronto's HTTP ingestion (`https://ingestion.eu.bronto.io/`, NDJSON, `x-bronto-collection` and `x-bronto-dataset` headers as for the log drain), each event becomes one log record with the fields as delivered (`eventType`, `clientId`, `subjectType`, `"statusCode"`). Queries belong here once records exist; the first ones to run are token requests per connector (`group by clientId`) and failed forwards (`status = 'error'`, `group by destinationPath, statusCode`).

## Gotchas

1. **No pull API for Connect events.** The Observability tab and the drain are the only ways to see them; on Pro anything older than 3 days is gone unless a drain was running (Observed: `vercel api list`; retention Documented).
2. **The Activity Log has only the config.** Connector creation, project links and installation updates are activity events; token requests and triggers are not (Observed: 0 runtime events in 30 days of `vercel activity` while 98 token requests ran in 7 days).
3. **Token requests show up as outgoing `fetch`.** The connector UID is in `requestPath`, URL-encoded (`/v1/connect/token/slack%2Fagentic-gtm`), so `vercel.external_api_request.count` grouped by `requestPath` gives requests per connector without a drain (Captured).
4. **One token request, one charge, one event.** The SDK's in-process cache decides how many token requests (and Connect events) an invocation makes; a fresh Fluid instance or a cold start requests again (Documented caching; counts Observed).
5. **CLI differs from the docs.** The CLI reference (read 2026-10-27) lists `vercel connect remove`; CLI 65.2.0 has `delete`, plus `revoke-tokens` and `contacts`, which the reference doesn't list (Observed: `vercel connect --help`).
6. **`discover` and `create --help` disagree on Checkly.** `vercel connect discover checkly` reports `connectionMethods: ["mcp"]`, while `vercel connect create checkly --help` offers one method, `api-key` ("MCP (API Key) — bring your own credentials") (Captured: `cli-connect-discover-checkly.json`, `cli-connect-create-checkly-help.txt`). API-key connectors exist for services in Vercel's catalog (more than 500 with an `api-key` method on 2026-10-27, Observed). The Connect overview also lists a generic "API key" connector type; whether it accepts a service outside the catalog is Not observed (the lab's notes from 2026-10-22 found none).

## Samples

| File | What it shows |
| --- | --- |
| [`cli-connect-list.json`](../samples/vercel-connect/cli-connect-list.json) | `vercel connect list --all-projects --format json`: the team's four connectors |
| [`cli-activity-connect-events.json`](../samples/vercel-connect/cli-activity-connect-events.json) | One Activity Log event per connector config change type (create, attach, trigger destinations, installation, update, delete installation) |
| [`metrics-connect-token-requests-7d.json`](../samples/vercel-connect/metrics-connect-token-requests-7d.json) | Token and authorize calls per connector per day, from `vercel.external_api_request.count` |
| [`metrics-connect-token-requests-3d.json`](../samples/vercel-connect/metrics-connect-token-requests-3d.json) | The same per project and HTTP status |
| [`metrics-connect-token-duration-3d.json`](../samples/vercel-connect/metrics-connect-token-duration-3d.json) | Average token request duration per connector |
| [`api-drains-test-connect.txt`](../samples/vercel-connect/api-drains-test-connect.txt) | `POST /v1/drains/test` with schema `connect` on a Pro team: accepted |
| [`api-connect-endpoints.txt`](../samples/vercel-connect/api-connect-endpoints.txt) | Every Connect endpoint in Vercel's public API spec: no events endpoint |
| [`cli-connect-discover-checkly.json`](../samples/vercel-connect/cli-connect-discover-checkly.json) | `vercel connect discover checkly` |
| [`cli-connect-create-checkly-help.txt`](../samples/vercel-connect/cli-connect-create-checkly-help.txt) | `vercel connect create checkly --help`: the API-key method |

Other team projects' IDs are replaced with `prj_OTHER_n`, people with `user-n`, the Slack workspace ID with `T_SLACK_REDACTED`.

## Sources

- Vercel docs, read 2026-10-27: [Vercel Connect](https://vercel.com/docs/connect) (last updated 2026-10-14), [Connect Observability and events reference](https://vercel.com/docs/connect/observability) (2026-08-11), [Connect Pricing](https://vercel.com/docs/connect/pricing), [Connectors](https://vercel.com/docs/connect/concepts/connectors), [`vercel connect`](https://vercel.com/docs/cli/connect), [Working with Drains](https://vercel.com/docs/drains) (2026-09-01), [Using Drains](https://vercel.com/docs/drains/using-drains) (2026-09-17), [Validate Drain delivery configuration](https://vercel.com/docs/rest-api/drains/validate-drain-delivery-configuration), [Vercel Connect adds observability support](https://vercel.com/changelog/vercel-connect-adds-observability-support) (2026-08-11), [Vercel Connect GA](https://vercel.com/changelog/vercel-connect-ga) (2026-08-25).
- Lab, 2026-10-27: Vercel CLI 65.2.0 `vercel connect list|discover|create --help|--help`, `vercel activity`, `vercel metrics`, `vercel api list`, `vercel api /v1/drains` (no `connect` drain among the team's 49), `vercel api /v1/drains/test`; package source `@vercel/connect` 2.5.2 and eve 0.81.0 in `petclinic-agent/node_modules`.
