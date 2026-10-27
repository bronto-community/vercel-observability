# Spend Management (budgets)

> **Payload Documented, not captured.** Spend Management sends a signed HTTPS POST when the team's on-demand spend reaches 50%, 75% and 100% of its budget, with four fields: `budgetAmount`, `currentSpend`, `teamId`, `thresholdPercent`. The budget is team-wide: the CLI, the docs and the API listing only offer `scope: "team"`, so a threshold crossing can't be produced for one project without lowering the whole team's budget, which also notifies every Owner and Billing member. The lab therefore has a receiver ready (`POST /api/vercel-webhook`, signature check tested locally) but no webhook configured. What can be captured without changing anything is the pull side: `vercel budgets inspect --json` (spend, percent used, threshold configuration) and `vercel budgets alerts --json` (alert history, empty for this team over 90 days). The thing to know: the webhook is configured per team and per threshold (`triggerWebhook`), and is off by default even when the budget exists.

| | |
| --- | --- |
| Kind | Platform feature (team billing) |
| Plans | Pro, and Enterprise on Flexible Commitment; Owner or Billing role (Documented) |
| Signals | Events (webhook) · Other: budget state and alert history (API) · Activity Log events |
| Exit paths | Webhook (HTTPS POST, `x-vercel-signature`) · API / CLI pull (`/v1/budgets`, `/v1/budgets/alerts`) · notifications (web, email, SMS; stay with people) |
| Verified | 2026-10-27 · Vercel CLI 65.2.0 · team `brontoio` (budget $200, 9% used) · lab project `vercel-observability-lab` (receiver only) |

## 1. What it emits

| Signal | What | Where it lives | Retention |
| --- | --- | --- | --- |
| Webhook | One POST per threshold reached: 50, 75, 100% (only 100% for budgets created before September 2025) (Documented) | Your endpoint | Retried up to 24 h on non-2xx (Documented, webhooks) |
| Budget state | Amount, status, `pause`, webhook URL and status, thresholds with `sendNotifications`, `triggerWebhook`, `pauseUsage`, current spend and percent (Captured) | `vercel budgets inspect`, `GET /v1/budgets?scope=team` | Current state |
| Alert history | One row per threshold reached: date, scope, threshold, spend, budget amount, actions configured (Documented; empty in the lab) | `vercel budgets alerts`, `GET /v1/budgets/alerts?scope=team` | Not documented |
| Activity Log | `spend-created`, `spend-updated`, `spend-deleted`, `project-paused`, `project-unpaused` event types (Observed in `vercel activity types`; no events in 365 days) | `vercel activity`, `GET /v3/events` | See the Audit Logs entry |
| Notifications | Web and email at 50/75/100%, SMS at 100%, per Owner/Billing member's own settings (Documented) | Inboxes | |

Spend Management checks spend "every few minutes", so the webhook and any pause can arrive several minutes after the threshold is crossed (Documented). The spend it counts is metered usage beyond the Pro plan's monthly credit; seats, Marketplace integrations and add-ons don't count (Documented).

## 2. Out-of-the-box shape

### Webhook payload (Documented)

```json
{
  "budgetAmount": 500,
  "currentSpend": 500,
  "teamId": "team_jkT8yZ3oE1u6xLo8h6dxfNc3",
  "thresholdPercent": 100
}
```

The docs type `budgetAmount` and `currentSpend` as `int`, while the CLI reports spend with cents (`currentSpend: 18.57`); which one the webhook sends is Not observed. The payload has no project, no breakdown by service, no billing period and no event ID or type field, unlike account webhooks, which wrap their payload in `{ type, id, createdAt, payload }`. A receiver that handles both has to tell them apart by shape.

Signature: `x-vercel-signature` is the hex HMAC-SHA1 of the raw request body, keyed with the secret Vercel shows when the webhook URL is saved (Documented, Webhooks API "Securing webhooks").

### Budget state (Captured: `cli-budgets-inspect.json`)

```json
{ "spend": { "currentSpend": 18.57, "percentUsed": 9, "unit": "usd" },
  "budget": { "id": "budget_01kg7w22nke4ernmr9qzc0kwh8", "scope": "team", "amount": 200, "amountUnit": "usd",
    "status": "active", "pause": false, "webhookId": null, "webhookUrl": null, "webhookStatus": "absent",
    "thresholds": [ { "percent": 50, "sendNotifications": true, "triggerWebhook": false, "pauseUsage": false },
                    { "percent": 75, "sendNotifications": true, "triggerWebhook": false, "pauseUsage": false },
                    { "percent": 100, "sendNotifications": true, "triggerWebhook": false, "pauseUsage": false } ] },
  "recentAlerts": [] }
```

The CLI reads it from `GET /v1/budgets?scope=team` and `GET /teams/{id}/spend` (`--debug`, Observed). `GET /v1/budgets?scope=project` and `…&projectId=<lab>` both returned `{"data":[]}` (Observed): the API accepts the value, but neither the CLI (`budgets set` has no project option) nor the docs describe project budgets, so the lab didn't try to create one.

### Alert history (Captured: `cli-budgets-alerts-90d.json`)

`vercel budgets alerts --since 90d --json` (`GET /v1/budgets/alerts?scope=team&since=…`) returned `"alerts": []`. The documented columns are date, budget scope, threshold, spend, budget amount and "actions configured", which reports what the threshold was set to do, not whether each action ran (Documented, CLI reference).

## 3. Extras beyond the default

| Extra | What it adds |
| --- | --- |
| Webhook URL on the budget (`vercel budgets set --webhook <url>`, or the dashboard) | The POST above at each threshold whose `triggerWebhook` is on |
| `--pause` | Pauses the production deployments of all projects at 100%, which also stops their daemons (Documented). Not used here |
| SMS notifications | 100% only, per member (Documented) |

## 4. Getting it out

| Signal | Exit path | Tested configuration |
| --- | --- | --- |
| Threshold events | Webhook to an HTTPS endpoint that verifies `x-vercel-signature` and forwards the payload (the lab route logs it, so it leaves through the log drain) | Receiver deployed (`lab/app/api/vercel-webhook/route.ts`); signature check tested locally; no webhook configured on the team budget |
| Spend and percent used | Pull `vercel budgets inspect --json` on a schedule | Ran, 2026-10-27 |
| Alert history | Pull `vercel budgets alerts --json` | Ran; empty |
| Budget changes | Activity Log (`spend-*` event types) | `vercel activity --type spend-created …`: no events in 365 days |

The receiver, as deployed in the lab:

```ts
const expected = createHmac("sha1", secret).update(body).digest();
const received = Buffer.from(request.headers.get("x-vercel-signature") ?? "", "hex");
if (received.length !== expected.length || !timingSafeEqual(received, expected)) return 403;
console.log(JSON.stringify({ msg: "vercel webhook", payload }));
```

Local test with the documented example payload and a throwaway secret: a correct signature returned `200` and logged `{"msg":"vercel webhook","payload":{"budgetAmount":500,…,"thresholdPercent":100}}`; a wrong or missing signature returned `403` (Observed). On Vercel the route answers `503` until `VERCEL_WEBHOOK_SECRET` is set.

To capture a real payload: save the lab URL as the budget webhook (team Billing settings), store the secret Vercel shows as the sensitive env var `VERCEL_WEBHOOK_SECRET`, and wait for the team's spend to reach 50% of the budget. Lowering the budget to force a crossing changes a team-wide setting and notifies every Owner and Billing member, so it wasn't done.

## 5. In Bronto

Once the webhook is set, the payload arrives in the lab's log drain dataset as the `message` of a `source = 'lambda'` record on `path = '/api/vercel-webhook'`. Query to use: `path = '/api/vercel-webhook' AND message LIKE '%vercel webhook%'`, grouped by `statusCode`. Not observed (no payload yet). `vercel budgets inspect --json` pulled on a schedule and sent as an event per run would give a spend time series next to the billing records; Not observed.

## Gotchas

1. **Budgets are team-wide.** The documented and CLI-supported scope is the team; there is no supported way to alert on one project's spend (Documented; `scope=project` listing returned empty, Observed).
2. **The webhook is per threshold and off by default.** A budget with a webhook URL still sends nothing for thresholds whose `triggerWebhook` is `false`; the lab team's three thresholds all had it `false` (Captured).
3. **The payload has no type field.** It is four bare fields; route it by endpoint, not by `type` (Documented).
4. **Alerts arrive minutes late.** Spend is checked every few minutes (Documented). So is the pause, which keeps serving traffic in the meantime.
5. **"Actions configured" isn't "actions run".** The alert history lists what each threshold was set to do (Documented).

## Samples

| File | What it shows |
| --- | --- |
| [`cli-budgets-inspect.json`](../samples/spend-management/cli-budgets-inspect.json) | `vercel budgets inspect --json`: spend, budget, thresholds |
| [`cli-budgets-list.json`](../samples/spend-management/cli-budgets-list.json) | `vercel budgets list --json` |
| [`cli-budgets-alerts-90d.json`](../samples/spend-management/cli-budgets-alerts-90d.json) | `vercel budgets alerts --since 90d --json`: empty |

## Sources

- Vercel docs, read 2026-10-27: [Spend Management](https://vercel.com/docs/spend-management) (last updated 2026-09-18), [vercel budgets](https://vercel.com/docs/cli/budgets), [Webhooks API reference](https://vercel.com/docs/webhooks/webhooks-api) (last updated 2026-09-17; "Securing webhooks", retries), changelog [Vercel CLI adds Spend Management](https://vercel.com/changelog/vercel-cli-adds-spend-management).
- Lab: Vercel CLI 65.2.0 (`budgets inspect`, `budgets list`, `budgets alerts`, `--debug` for the endpoints, `activity types`, `activity --type spend-*`, `vercel api "/v1/budgets?scope=project"`), read-only, 2026-10-27; `lab/app/api/vercel-webhook/route.ts` (deployment `dpl_EqPzC7dEefgzqwzBtFpQhbe4TQy7`); `reference/inventory-sweep-2026-10-27.md`.
