# Billing and usage

> Vercel publishes the team's charges as FOCUS v1.3 cost records through one read-only REST endpoint, `GET /v1/billing/charges`: one JSON line per service, project, region and billing day, with the consumed quantity, the list-price value (`EffectiveCost`) and what is actually invoiced (`BilledCost`). It carries the cost of observability itself (`Drains Volume`, `Tracing Spans`, `Web Analytics Events`, `Observability Events`, `AI Gateway Traces`) next to Functions, Queues and Workflow, per project. Nothing pushes it: there is no drain or webhook, so getting it out means calling the endpoint once a day and forwarding the lines. The CLI shows the same data as tables (`vercel billing usage`, formerly `vercel usage`), plus invoices and contract commitments. The thing people get wrong: billing days run from midnight to midnight US Pacific time, which is 07:00 UTC in US summer time and 08:00 UTC since 2026-11-02, and the endpoint returns whole billing days, so a midnight-UTC window returns the previous day.

| | |
| --- | --- |
| Kind | Platform service (billing) |
| Plans | All plans with a team; the endpoint needs the Owner, Member, Developer, Security, Billing or Enterprise Viewer role (Documented) |
| Signals | Other: cost records (FOCUS v1.3, JSONL) |
| Exit paths | REST API (`GET /v1/billing/charges`) · none pushed |
| Verified | 2026-10-26 · Vercel REST API, Vercel CLI 65.2.0 (`vercel api`) · lab team (Pro) and project `petclinic-agent` |
| Refreshed | 2026-11-12 · docs and changelog to 2026-11-12, no new captures in the lab apps; read-only pulls of `GET /v1/billing/charges` for the billing days 2026-10-25, 2026-11-01, 2026-11-02, 2026-11-04 to 2026-11-06, 2026-11-09 and 2026-11-10 · Vercel CLI 65.14.0 |

## 1. What it emits

| Signal | What | Where it lives | Retention |
| --- | --- | --- | --- |
| Cost records | One line per service (SKU), project and, for network services, region, per billing day | Usage page in the dashboard, `GET /v1/billing/charges`, `vercel billing usage` | One request covers up to 1 year (Documented); how far back data goes: Not observed |
| Invoices | Issued invoices with line items per service and billing period; an estimate of the next invoice (Documented) | `vercel billing invoices list`, `inspect`, `upcoming`, `download` (PDF) | Not documented |
| Contract commitments | Enterprise commitment per contract period (Documented) | `vercel billing contract`, `GET /v1/billing/contract-commitments` (FOCUS v1.3 JSONL) | Not documented |

The endpoint takes `from` and `to` (ISO 8601, UTC) and `teamId` or `slug`, or `orgId` for every team in an organization with Enterprise teams (OrgAdmin or OrgViewer role; Documented 2026-11-12), and streams `application/jsonl`, gzip-compressed on request ([docs](https://vercel.com/docs/rest-api/billing/list-focus-billing-charges)). For one billing day the lab team got 988 to 1,174 lines, of which about 240 had a non-zero quantity or cost; the rest list every SKU at zero. On 2026-11-12 the pulls returned 1,013 to 1,082 lines per day (Observed).

## 2. Out-of-the-box shape

### A cost record

A project's drain usage for 2026-10-25, as pulled on 2026-10-26 (Captured: `charge-drains-volume.json`). Pulled again on 2026-11-12, every line, including those for October, has five more columns; see [Columns added by 2026-11-12](#columns-added-by-2026-11-12) and `charge-drains-volume-2026-11-10.json`:

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
| `ChargePeriodStart`, `ChargePeriodEnd` | `2026-10-25T07:00:00.000Z` | Midnight to midnight US Pacific: 07:00 UTC up to the billing day 2026-11-01, 08:00 UTC from 2026-11-02 (Observed, pulls of 2026-11-12) |
| `ChargeCategory` | `Usage`, `Purchase` | `Usage` on metered lines. On 2026-10-26 the Pro subscription and seats were `Usage` too; in pulls of 2026-11-12 the plan fee and the Observability Plus line are `Purchase`, with `ConsumedQuantity` and `ConsumedUnit` `null` (Observed), as the schema now documents |
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

On 2026-10-26 no line carried a team ID or billing account ID. Since then every line carries the team in `SubAccountId` and `SubAccountName` (below). Lines are not split by drain, function or route.

### Columns added by 2026-11-12

Pulled on 2026-11-12, every line has these columns, including re-pulled October days (Observed; Documented in the endpoint schema, page updated 2026-11-12):

| Field | Example | Note |
| --- | --- | --- |
| `SkuPriceId` | `prod_01jvt9pk…` | Equal to `SkuId` on every line (Observed; the schema says so) |
| `SubAccountId`, `SubAccountName` | `team_REDACTED`, the team name | The team the charge belongs to. With `orgId`, `null` on "Organization (unallocated)" rows (Documented) |
| `SubAccountType` | `Team` | `null` on unallocated organization rows (Documented) |
| `x_CostAttribution` | `null` | How cost was split between teams of an organization: `calibrated_estimate` or `uncalibrated_estimate`; `null` on rows not split (Documented). `null` on every lab line (Observed) |

The field order in each JSON line also changed (`BilledCost` first). Parse by name.

### Service names

The 72 `ServiceName` values for one day, grouped by `ServiceCategory` (Observed, 2026-10-24). Pulls of 2026-11-12 list 77 names for each of the billing days 2026-11-04, 2026-11-05, 2026-11-06 and 2026-11-10; the changes are listed under the table:

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

Changes in the pulls of 2026-11-12 (Observed, billing day 2026-11-10):

- **New category `Schedules`**: `Schedule Creations` (unit `Creations`) and `Schedule Firings` (unit `Firings`), team-level, no region. See [Schedules](schedules.md).
- **`Observability`**: adds `Observability Data Scanned` (gigabyte), team-level.
- **`AI Tokens`**: adds `Regional Gateway Hosting` (unit `Dollars`).
- **`Subscription Licenses`**: adds an `Observability Plus` line (`Purchase`).
- **`Vercel Functions`**: now holds `Daemons Active CPU` and `Daemons Provisioned Memory` (listed under `Sandbox` on 2026-10-24).
- **Names**: Global Config lines read `Global Config Reads (formerly known as Edge Config Reads)` and `Global Config Writes (formerly known as Edge Config Writes)`.
- `CI CPU Time` (Build & Deploy, minutes) is the [Vercel CI](vercel-ci.md) line; team-level, no region (Observed).

### Runtime Cache (formerly Data Cache)

Data Cache is moving to Runtime Cache (changelog 2026-10-30). After a team migrates, Next.js `fetch` caching and `unstable_cache` reads and writes, unbilled before, are billed at Runtime Cache rates: from $0.40 per 1M read units and $4.00 per 1M write units, varying by region; a unit is 8 KB, rounded up per read or write. Teams created on or after 2026-10-30 use Runtime Cache from the start; Hobby teams migrate on 2026-11-29; Pro teams get a date by notice (Documented).

In the cost records (Observed, pulls of 2026-11-12):

- The lines are `Runtime Cache Reads` (unit `Reads`) and `Runtime Cache Writes` (unit `Writes`), category `Content, Caching & Optimization`, one per region. They were already there on 2026-10-25, before the migration was announced (Captured: `charges-2026-10-25-petclinic-agent-and-team.jsonl`).
- No `ServiceName` contains "Data Cache" on any day pulled, so pre-migration Data Cache usage doesn't appear in the records. The docs point to the Usage page and Observability › Runtime Cache for it (Documented).
- Every Runtime Cache line in the lab was zero and team-level (`Tags: {}`; Captured: `charge-runtime-cache-reads-2026-11-10.json`). Whether billed Runtime Cache lines carry `Tags.ProjectName`: Not observed.
- Observability counts cache operations, billing counts 8 KB units, so the two don't match for entries over 8 KB (Documented, Data Cache guide).

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

None for the records. The endpoint has no options beyond the date range and the team or organization, and add-ons only add their own lines (Observability Events, Speed Insights Plus Events).

The CLI reads the same data in other shapes (Documented, CLI reference; help output checked with CLI 65.14.0):

| Command | What it shows | Note |
| --- | --- | --- |
| `vercel billing usage` | Usage and cost per service for the billing period or `--since`/`--until`; `--breakdown daily\|weekly\|monthly`, `--group-by project\|region`, `--json` | Since CLI 65.11.0. `vercel usage` still works and prints a deprecation warning, as do `--from`/`--to` and `--format json`. Date-only values are Los Angeles midnights. "Cost" is before credits and discounts, not the invoice |
| `vercel billing invoices list\|inspect\|upcoming\|download` | Invoices with line items, the next invoice's estimate (65.10.0 and later), PDFs | `--json` on every subcommand |
| `vercel billing contract` | Enterprise contract commitments | Formerly `vercel contract`; the old name now resolves to `vercel billing contract` (Observed, 65.14.0 help) |
| `vercel billing budgets` | Spend Management | See [Spend Management](spend-management.md) |

## 4. Getting it out

| Signal | Exit path | Tested |
| --- | --- | --- |
| Cost records | `GET /v1/billing/charges`, pulled | curl and `vercel api`, 2026-10-26; `vercel api` (CLI 65.14.0), 2026-11-12 |
| Contract commitments | `GET /v1/billing/contract-commitments` (FOCUS v1.3 JSONL), pulled | Not tested (Enterprise) |
| Invoices | `vercel billing invoices … --json`, pulled | Not tested |
| Push (drain, webhook) | None, still the case on 2026-11-12 (docs checked) | |

### Pulling one day

```bash
# Billing days run 07:00 to 07:00 UTC. Ask for exactly one.
curl -sS -N "https://api.vercel.com/v1/billing/charges?teamId=$TEAM_ID&from=2026-10-25T07:00:00Z&to=2026-10-26T07:00:00Z" \
  -H "Authorization: Bearer $VERCEL_TOKEN" -H "Accept-Encoding: gzip" --compressed > charges.jsonl

# The same with the Vercel CLI (team taken from the linked project)
vercel api "/v1/billing/charges?from=2026-10-25T07:00:00Z&to=2026-10-26T07:00:00Z" > charges.jsonl
```

Both returned the same 988 lines and $9.96 (Observed, CLI 65.2.0; an earlier CLI version couldn't parse the JSONL response). Window behaviour (Observed):

| `from` → `to` | Billing days returned |
| --- | --- |
| `2026-10-25T07:00Z` → `2026-10-26T07:00Z` | 2026-10-25 (07:00 to 07:00) |
| `2026-10-25` → `2026-10-26` (dates only) | 2026-10-25 |
| `2026-10-25T00:00Z` → `2026-10-26T00:00Z` | **2026-10-24** only |
| `2026-10-24T00:00Z` → `2026-10-26T00:00Z` | 2026-10-23 and 2026-10-24 |
| `2026-10-26T00:00Z` → `2026-10-27T00:00Z` | 2026-10-25 (the 26th wasn't complete) |
| `2026-10-25T00:00Z` → `2026-10-25T06:00Z` | `404 costs_not_found` |

The billing day 2026-10-25 was complete and available at 10:00 UTC on 2026-10-26, three hours after it closed (Observed).

After the US clock change, billing days start at 08:00 UTC: `2026-11-10T07:00Z` → `2026-11-11T07:00Z` returned the billing day 2026-11-09 (08:00 to 08:00), and `2026-11-10T08:00Z` → `2026-11-11T08:00Z` returned 2026-11-10 (Observed, 2026-11-12). The billing day 2026-11-01 started at 07:00 UTC, 2026-11-02 at 08:00 UTC. A puller that hard-codes 07:00 UTC gets the previous day all winter; compute the start from midnight in `America/Los_Angeles`.

### On a schedule

Not run in the lab (it needs a new cron route and a token in the project, a configuration change). The pattern that fits Vercel:

1. A daily job after 08:00 UTC (for example `30 9 * * *`) calls a route that requests the billing day that just closed, from midnight to midnight `America/Los_Angeles` converted to UTC.
2. Authenticate with an access token scoped to the team, with one of the roles above, stored as a sensitive environment variable.
3. Emit each line as an OpenTelemetry log record with the OpenTelemetry Logs SDK (`LoggerProvider`, `BatchLogRecordProcessor`, `OTLPLogExporter`, configured by `OTEL_EXPORTER_OTLP_*`), with the FOCUS columns as attributes, and flush before the function returns. The lab's deployment-webhook forwarder (`apps/web/app/api/vercel-webhook/route.ts`) is a tested template for the exporter part.

Re-pulling a day returns the same totals, so a retry after a failed run doesn't double-count if the backend deduplicates on `ChargePeriodStart` + `SkuId` + `ProjectId` + `RegionId` (+ `SubAccountId` when pulling with `orgId`). The 2026-10-25 re-pull on 2026-11-12 returned $9.96 again, in 987 lines (Observed). The set of zero lines changed between requests for the same day (1,057 versus 1,174 lines, both $10.01; Observed), so don't use the line count as a check.

## 5. In Bronto

Not tested: the lab doesn't send billing lines to Bronto (see section 4). As OpenTelemetry log records, the FOCUS columns would arrive as attributes (`$ServiceName`, `$EffectiveCost`, `$Tags.ProjectName` or however the forwarder names them), and the natural questions are cost per `ServiceName` per day and `Drains Volume` GB per project next to the volume the backend received.

## Gotchas

1. **Billing days start at midnight US Pacific**: 07:00 UTC in US summer time, 08:00 UTC in winter (from the billing day 2026-11-02). A `from`/`to` at midnight UTC, or at 07:00 UTC in winter, returns the previous billing day, and a window inside one day returns `404 costs_not_found` (Observed).
2. **`EffectiveCost` is not what you pay.** While the plan's included usage lasts, lines are `PricingCategory: Committed` with `BilledCost: 0`. `BilledCost` is the invoice; `EffectiveCost` is the usage at list price (Captured: `charge-web-analytics-events-committed.json`).
3. **`PricingQuantity` is dollars.** `PricingUnit` is `USD` and `PricingQuantity` equals `EffectiveCost` on all 5,369 lines pulled; use `ConsumedQuantity` and `ConsumedUnit` for usage (Captured).
4. **Categories are Vercel's.** `ServiceCategory` values such as `Observability`, `Vercel Functions` and `Vercel Delivery Network` are not in the FOCUS category list the endpoint's schema publishes. Map them yourself if you mix clouds.
5. **No per-drain split.** `Drains Volume` is one line per project; log, trace and analytics drains share it.
6. **The record shape changes without a version bump.** Between 2026-10-26 and 2026-11-12 the endpoint added five columns, reordered fields, moved subscriptions from `Usage` to `Purchase` and Daemons from `Sandbox` to `Vercel Functions`, also for past days (Observed). Store raw lines and parse by name.
7. **Observability has its own cost lines.** Drains Volume, Tracing Spans, Observability Events, Web Analytics Events, Speed Insights Plus Events and AI Gateway Traces are separate SKUs. On the lab's busiest day, Drains Volume was the first line billed beyond the plan's included usage.

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
| [`charge-pro-subscription.json`](../samples/billing/charge-pro-subscription.json) | The plan fee as a daily `Usage` line, no tags (2026-10-26 shape) |
| [`charge-pro-purchase-2026-11-10.json`](../samples/billing/charge-pro-purchase-2026-11-10.json) | The plan fee as `Purchase` with `null` quantity, 2026-11-12 shape |
| [`charge-drains-volume-2026-11-10.json`](../samples/billing/charge-drains-volume-2026-11-10.json) | Drains Volume with the added columns, billing day starting 08:00 UTC |
| [`charge-runtime-cache-reads-2026-11-10.json`](../samples/billing/charge-runtime-cache-reads-2026-11-10.json) | A Runtime Cache Reads line (zero, `dub1`) |

## Sources

- Vercel docs, read 2026-10-26: [List FOCUS billing charges](https://vercel.com/docs/rest-api/billing/list-focus-billing-charges) (last updated 2026-10-26), [Pricing](https://vercel.com/docs/pricing), changelog [Access billing usage and cost data via API](https://vercel.com/changelog/access-billing-usage-cost-data-api) (February 2026).
- Lab: `GET /v1/billing/charges` for the billing days 2026-10-20 and 2026-10-23 to 2026-10-25, with curl and `vercel api` (CLI 65.2.0), 2026-10-26; earlier pulls on 2026-10-20. The samples drop other projects' lines; `SubAccountId` (the team ID) is redacted as `team_REDACTED`.
- Vercel docs and changelog, read 2026-11-12: [List FOCUS billing charges](https://vercel.com/docs/rest-api/billing/list-focus-billing-charges) (last updated 2026-11-12), [vercel billing](https://vercel.com/docs/cli/billing) (last updated 2026-11-02), [vercel billing usage](https://vercel.com/docs/cli/usage) (last updated 2026-10-30), [vercel billing contract](https://vercel.com/docs/cli/contract) (last updated 2026-10-30), [Runtime Cache](https://vercel.com/docs/runtime-cache) (Pricing), [Data Cache](https://vercel.com/docs/caching/runtime-cache/data-cache), changelog [Data Cache is moving to Runtime Cache](https://vercel.com/changelog/data-cache-is-moving-to-runtime-cache) (2026-10-30).
- Lab, 2026-11-12: `vercel api` (CLI 65.14.0) for the billing days 2026-10-25, 2026-11-01, 2026-11-02, 2026-11-04 to 2026-11-06, 2026-11-09 and 2026-11-10, read-only; `vercel billing --help` and subcommand help, CLI 65.14.0.
