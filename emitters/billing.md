# Billing and usage

> Vercel publishes the team's charges as FOCUS v1.3 cost records through one read-only REST endpoint, `GET /v1/billing/charges`: one JSON line per service, project, region and billing day, with the consumed quantity, the list-price value (`EffectiveCost`) and what is actually invoiced (`BilledCost`). It carries the cost of observability itself (`Drains Volume`, `Tracing Spans`, `Web Analytics Events`, `Observability Events`, `AI Gateway Traces`) next to Functions, Queues and Workflow, per project. Nothing pushes it: there is no drain or webhook, so getting it out means calling the endpoint once a day and forwarding the lines. The thing people get wrong: billing days run from 07:00 to 07:00 UTC (midnight US Pacific), and the endpoint returns whole billing days, so a midnight-UTC window returns the previous day.

| | |
| --- | --- |
| Kind | Platform service (billing) |
| Plans | All plans with a team; the endpoint needs the Owner, Member, Developer, Security, Billing or Enterprise Viewer role (Documented) |
| Signals | Other: cost records (FOCUS v1.3, JSONL) |
| Exit paths | REST API (`GET /v1/billing/charges`) · none pushed |
| Verified | 2026-10-26 · Vercel REST API, Vercel CLI 65.2.0 (`vercel api`) · lab team (Pro) and project `petclinic-agent` |

## 1. What it emits

| Signal | What | Where it lives | Retention |
| --- | --- | --- | --- |
| Cost records | One line per service (SKU), project and, for network services, region, per billing day | Usage page in the dashboard, `GET /v1/billing/charges` | One request covers up to 1 year (Documented); how far back data goes: Not observed |

The endpoint takes `from` and `to` (ISO 8601, UTC) and `teamId` or `slug`, and streams `application/jsonl`, gzip-compressed on request ([docs](https://vercel.com/docs/rest-api/billing/list-focus-billing-charges)). For one billing day the lab team got 988 to 1,174 lines, of which about 240 had a non-zero quantity or cost; the rest list every SKU at zero.

## 2. Out-of-the-box shape

### A cost record

A project's drain usage for 2026-10-25 (Captured: `charge-drains-volume.json`):

```json
{ "ChargePeriodStart": "2026-10-25T07:00:00.000Z",
  "ChargePeriodEnd": "2026-10-26T07:00:00.000Z",
  "ChargeCategory": "Usage",
  "BilledCost": 0.5212357072673286,
  "BillingCurrency": "USD",
  "EffectiveCost": 0.5212357072673286,
  "ServiceName": "Drains Volume",
  "ServiceCategory": "Observability",
  "ServiceProviderName": "Vercel",
  "SkuId": "prod_01jvt9pkqbecssvtz6z30jsjwf",
  "ConsumedQuantity": 1.0424714145346572,
  "ConsumedUnit": "gigabyte",
  "Tags": { "ProjectId": "prj_b3WTvq01Qtd6lK3zThoF2COD7prM", "ProjectName": "petclinic-agent" },
  "PricingCategory": "Other",
  "PricingCurrency": "USD",
  "PricingQuantity": 0.5212357072673286,
  "PricingUnit": "USD" }
```

| Field | Example | Note |
| --- | --- | --- |
| `ChargePeriodStart`, `ChargePeriodEnd` | `2026-10-25T07:00:00.000Z` | Always 07:00 UTC to 07:00 UTC in the lab (Observed, October 2026, US daylight time). Whether it moves to 08:00 UTC in winter: Not observed |
| `ChargeCategory` | `Usage` | Every line, including the Pro subscription and seats (Observed) |
| `ServiceName` | `Drains Volume` | 72 distinct names in one day (list below) |
| `ServiceCategory` | `Observability` | Vercel's own groups (below); the published schema lists only FOCUS's standard categories |
| `SkuId` | `prod_01jvt9pk…` | Stable per product |
| `ConsumedQuantity`, `ConsumedUnit` | `1.0425`, `gigabyte` | Event counts can be fractional (4,772.215 Web Analytics events) |
| `EffectiveCost` | `0.5212` | The usage at list price, whether or not it is invoiced |
| `BilledCost` | `0.5212` | What goes on the invoice; `0` while the plan's included usage covers it |
| `PricingCategory` | `Other`, `Committed` | `Committed`: covered by the plan's included usage (`BilledCost` 0). `Other`: charged on demand |
| `PricingQuantity`, `PricingUnit` | `0.5212`, `USD` | Repeats the cost in dollars, not a quantity |
| `RegionId`, `RegionName` | `dub1`, `Dublin, Ireland` | Only on regional services (CDN, data transfer, Fluid compute); absent on others |
| `Tags.ProjectId`, `Tags.ProjectName` | | On project usage. Team-level lines (seats, plan, Blob) have `Tags: {}` |

No line carries a team ID or billing account ID; the team is implied by the request. Lines are not split by drain, function or route.

### Service names

The 72 `ServiceName` values for one day, grouped by `ServiceCategory` (Observed, 2026-10-24):

| `ServiceCategory` | `ServiceName` |
| --- | --- |
| Observability | Drains Volume · Tracing Spans · Observability Events (Observability Plus) · Web Analytics Events · Speed Insights Plus Events · AI Gateway Traces |
| Vercel Functions | Function Invocations · Function Duration · Fluid Active CPU · Fluid Provisioned Memory · Fluid Provisioned Memory (Custom Scaling) · Fast Origin Transfer · Workflow Events · Workflow Storage Writes · Workflow Storage Retention · Edge Function Execution Units · Edge Middleware Invocations |
| Vercel Delivery Network | CDN Requests · CDN Requests - Additional CPU Duration · Fast Data Transfer · Private Data Transfer · PrivateLink Data Transfer · Microfrontends Routing |
| Queues | Queue Message Sends · Receives · Deletes · Notifications · Visibility Changes |
| Content, Caching & Optimization | ISR Reads/Writes · Runtime Cache Reads/Writes · Image Optimization (Transformation, Cache Reads, Cache Writes) · Blob (Storage Size, Simple/Advanced Operations, Data Transfer) · Global Config Reads/Writes (formerly Edge Config) · Flag Requests · Drive Reads/Writes/Storage |
| Build & Deploy | Build Minutes · Build CPU Minutes · CI CPU Time · Deployment Storage · Function Storage · Snapshot Storage |
| Web Application Firewall | Firewall OWASP Requests · Firewall OWASP Excess Bytes · Firewall Rate Limit Requests · BotID Deep Analysis Requests · Page Integrity Views |
| Sandbox | Sandbox Active CPU · Provisioned Memory · Data Transfer · Creations · Daemons Active CPU · Daemons Provisioned Memory |
| Vercel Connect | Connect Token Requests · Connect Triggers |
| Services | Service Requests |
| AI Tokens | Vercel Agent |
| KMS · VCR | KMS Operations · VCR Storage |
| Subscription Licenses | Pro · Additional Team Seats · v0 Seats · Speed Insights Plus |

### One project, two days

`petclinic-agent`, from the endpoint (Observed):

| Service | 2026-10-20 (≈14,400 agent conversations) | 2026-10-25 (cron traffic only) |
| --- | --- | --- |
| Workflow Events | 351,492 events · $7.03 · billed $0 | |
| Drains Volume | 9.13 GB · $4.56 · billed $2.56 | 1.04 GB · $0.52 · billed $0.52 |
| Fluid Provisioned Memory | 178 GB-h · $2.42 · billed $0 | 3.27 GB-h · $0.04 |
| Tracing Spans | 3,770,736 span units · $1.89 · billed $0 | 488,795 · $0.24 |
| Fluid Active CPU | 5.3 h · $0.88 · billed $0 | 0.52 h · $0.09 |
| AI Gateway Traces | 3,988 · $0.20 · billed $0 | |
| Web Analytics Events | 4,772 · $0.14 · billed $0 | |
| Function Invocations | 146,635 · $0.09 · billed $0 | 24,466 · $0.01 |
| **Project total** | **$17.75 · billed $2.60** | **$1.00 · billed $1.00** |

On 2026-10-20 most lines were `Committed` (inside the Pro plan's monthly included usage) and Drains Volume was the first to spill into `Other`, half billed. By 2026-10-25 the included usage was used up and every line was `Other`, billed in full. Team total for 2026-10-25: $9.96, of which $8.84 subscriptions (Pro $0.67 a day, seats prorated).

Unit prices fall out of `EffectiveCost / ConsumedQuantity` (Observed): Drains Volume $0.50 per GB; Tracing Spans $0.50 per 1M span units; Web Analytics Events $0.03 per 1,000; Workflow Events $0.02 per 1,000; AI Gateway Traces $0.05 per 1,000; Function Invocations $0.60 per 1M; Fluid Active CPU $0.128 to $0.184 per hour depending on region.

`Observability Events` (Observability Plus) appears as a team-level line at 0: Plus was enabled on 2026-10-26, a billing day not complete at the time of writing (Not observed).

## 3. Extras beyond the default

None. The endpoint has no options beyond the date range and the team, and add-ons only add their own lines (Observability Events, Speed Insights Plus Events).

## 4. Getting it out

| Signal | Exit path | Tested |
| --- | --- | --- |
| Cost records | `GET /v1/billing/charges`, pulled | curl and `vercel api`, 2026-10-26 |
| Push (drain, webhook) | None | |

### Pulling one day

```bash
# Billing days run 07:00 to 07:00 UTC. Ask for exactly one.
curl -sS -N "https://api.vercel.com/v1/billing/charges?teamId=$TEAM_ID&from=2026-10-25T07:00:00Z&to=2026-10-26T07:00:00Z" \
  -H "Authorization: Bearer $VERCEL_TOKEN" -H "Accept-Encoding: gzip" --compressed > charges.jsonl

# The same with the Vercel CLI (team taken from the linked project)
vercel api "/v1/billing/charges?from=2026-10-25T07:00:00Z&to=2026-10-26T07:00:00Z" > charges.jsonl
```

Both returned the same 988 lines and $9.96 (Observed, CLI 65.2.0; research I recorded that `vercel api` couldn't parse JSONL with an earlier version). Window behaviour (Observed):

| `from` → `to` | Billing days returned |
| --- | --- |
| `2026-10-25T07:00Z` → `2026-10-26T07:00Z` | 2026-10-25 (07:00 to 07:00) |
| `2026-10-25` → `2026-10-26` (dates only) | 2026-10-25 |
| `2026-10-25T00:00Z` → `2026-10-26T00:00Z` | **2026-10-24** only |
| `2026-10-24T00:00Z` → `2026-10-26T00:00Z` | 2026-10-23 and 2026-10-24 |
| `2026-10-26T00:00Z` → `2026-10-27T00:00Z` | 2026-10-25 (the 26th wasn't complete) |
| `2026-10-25T00:00Z` → `2026-10-25T06:00Z` | `404 costs_not_found` |

The billing day 2026-10-25 was complete and available at 10:00 UTC on 2026-10-26, three hours after it closed (Observed).

### On a schedule

Not run in the lab (it needs a new cron route and a token in the project, a configuration change). The pattern that fits Vercel:

1. A daily Cron Job after 07:00 UTC (for example `30 9 * * *`) calls a route that requests the billing day that just closed, aligned to 07:00 UTC.
2. Authenticate with an access token scoped to the team, with one of the roles above, stored as a sensitive environment variable.
3. Emit each line as an OpenTelemetry log record with the OpenTelemetry Logs SDK (`LoggerProvider`, `BatchLogRecordProcessor`, `OTLPLogExporter`, configured by `OTEL_EXPORTER_OTLP_*`), with the FOCUS columns as attributes, and flush before the function returns. The lab's deployment-webhook forwarder (`apps/web/app/api/vercel-webhook/route.ts`) is a tested template for the exporter part.

Re-pulling a day returns the same totals, so a retry after a failed run doesn't double-count if the backend deduplicates on `ChargePeriodStart` + `SkuId` + `ProjectId` + `RegionId`. The set of zero lines changed between requests for the same day (1,057 versus 1,174 lines, both $10.01; Observed), so don't use the line count as a check.

## 5. In Bronto

Not tested: the lab doesn't send billing lines to Bronto (see section 4). As OpenTelemetry log records, the FOCUS columns would arrive as attributes (`$ServiceName`, `$EffectiveCost`, `$Tags.ProjectName` or however the forwarder names them), and the natural questions are cost per `ServiceName` per day and `Drains Volume` GB per project next to the volume the backend received.

## Gotchas

1. **Billing days start at 07:00 UTC.** A `from`/`to` at midnight UTC returns the previous billing day, and a window inside one day returns `404 costs_not_found` (Observed).
2. **`EffectiveCost` is not what you pay.** While the plan's included usage lasts, lines are `PricingCategory: Committed` with `BilledCost: 0`. `BilledCost` is the invoice; `EffectiveCost` is the usage at list price (Captured: `charge-web-analytics-events-committed.json`).
3. **`PricingQuantity` is dollars.** `PricingUnit` is `USD` and `PricingQuantity` equals `EffectiveCost` on all 5,369 lines pulled; use `ConsumedQuantity` and `ConsumedUnit` for usage (Captured).
4. **Categories are Vercel's.** `ServiceCategory` values such as `Observability`, `Vercel Functions` and `Vercel Delivery Network` are not in the FOCUS category list the endpoint's schema publishes. Map them yourself if you mix clouds.
5. **No per-drain split.** `Drains Volume` is one line per project; log, trace and analytics drains share it.
6. **Observability has its own cost lines.** Drains Volume, Tracing Spans, Observability Events, Web Analytics Events, Speed Insights Plus Events and AI Gateway Traces are separate SKUs. On the lab's busiest day, Drains Volume was the first line billed beyond the plan's included usage.

## Samples

| File | What it shows |
| --- | --- |
| [`charges-2026-10-25-petclinic-agent-and-team.jsonl`](../samples/billing/charges-2026-10-25-petclinic-agent-and-team.jsonl) | Every line for `petclinic-agent` and the team-level lines of one billing day, as delivered (other projects removed) |
| [`charge-drains-volume.json`](../samples/billing/charge-drains-volume.json) | Drains Volume, billed in full |
| [`charge-drains-volume-2026-10-20.json`](../samples/billing/charge-drains-volume-2026-10-20.json) | Drains Volume, partly covered by included usage (`BilledCost` < `EffectiveCost`) |
| [`charge-tracing-spans.json`](../samples/billing/charge-tracing-spans.json) | Tracing Spans in span units |
| [`charge-web-analytics-events-committed.json`](../samples/billing/charge-web-analytics-events-committed.json) | `PricingCategory: Committed`, `BilledCost: 0`, fractional event count |
| [`charge-observability-events-team.json`](../samples/billing/charge-observability-events-team.json) | The Observability Plus line, team level, zero |
| [`charge-fluid-active-cpu.json`](../samples/billing/charge-fluid-active-cpu.json) | Fluid Active CPU for a region |
| [`charge-fast-data-transfer-region.json`](../samples/billing/charge-fast-data-transfer-region.json) | A regional line with `RegionId` and `RegionName` |
| [`charge-pro-subscription.json`](../samples/billing/charge-pro-subscription.json) | The plan fee as a daily `Usage` line, no tags |

## Sources

- Vercel docs, read 2026-10-26: [List FOCUS billing charges](https://vercel.com/docs/rest-api/billing/list-focus-billing-charges) (last updated 2026-10-26), [Pricing](https://vercel.com/docs/pricing), changelog [Access billing usage and cost data via API](https://vercel.com/changelog/access-billing-usage-cost-data-api) (February 2026).
- Lab: `GET /v1/billing/charges` for the billing days 2026-10-20 and 2026-10-23 to 2026-10-25, with curl and `vercel api` (CLI 65.2.0), 2026-10-26; research I (billing, 2026-10-20). Team and billing account identifiers are not in the records; the samples drop other projects' lines.
