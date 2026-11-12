# Speed Insights and `@vercel/speed-insights`

> The `@vercel/speed-insights` script measures Web Vitals in the visitor's browser and the Speed Insights drain (`speed_insights` v1) delivers one flat JSON record per metric per page view: `metricType` (TTFB, FCP, LCP, CLS, INP, FID), `value`, path, route pattern, deployment, device, browser, OS, country, connection speed and an `attribution` string that names the element involved as a CSS selector. In the lab, 35 page views gave 187 records, and the drained counts and p75 values matched `vercel metrics vercel.speed_insights.*` exactly for all five metrics Vercel exposes; FID is drained but has no metric. Draining needs Speed Insights Plus switched on for each project: the team having Plus isn't enough, and before that the drain API refused with a 400 although the free tier was already collecting vitals. What people get wrong: a page view doesn't always produce all six metrics (no interaction means no INP and no FID, and LCP was missing on 3 of 25 page views with an early click), so count page views with TTFB, not with records.

| | |
| --- | --- |
| Kind | Client script (`@vercel/speed-insights`) and platform service |
| Plans | Free tier on all plans (10,000 events per rolling 30 days, shared by the team; RES only in the dashboard). Speed Insights Plus per project on Pro ($10 per project per month plus $0.65 per 10,000 events) and included on Enterprise; drains need Plus (Documented) |
| Signals | Events (one data point per metric) · Metrics (inside Vercel) |
| Exit paths | Speed Insights drain (`speed_insights` v1) · `vercel metrics` pull |
| Verified | 2026-10-27 · Vercel CLI 65.2.0 · `@vercel/speed-insights` 2.0.0 (`scriptVersion` 0.1.3 on the wire) · Next.js 16.4.3 · lab projects `vercel-observability-lab` and `petclinic-agent` |
| Refreshed | 2026-11-12 · docs, changelog and releases to 2026-11-12, no new captures · `@vercel/speed-insights` 2.1.0 (release notes; the lab still runs 2.0.0) · Vercel CLI 65.14.0 |

## 1. What it emits

| Signal | What | Where it lives | Retention |
| --- | --- | --- | --- |
| Events | One data point per Web Vital per page view: TTFB, FCP, LCP, CLS, INP, FID | Speed Insights dashboard, Speed Insights drain | Free tier: 24 h and 7 day views. Plus: 30 days on Pro, 90 on Enterprise (Documented) |
| Metrics | `vercel.speed_insights.ttfb_ms`, `fcp_ms`, `lcp_ms`, `inp_ms`, `cls` | Speed Insights dashboard, Query, `vercel metrics` | As above (Documented) |

The five metrics share 12 dimensions: `projectId`, `deploymentId`, `environment`, `requestHostname`, `requestPath`, `route`, `country`, `deviceType`, `osName`, `browserName`, `attributionTarget`, `attributionEventName`, with aggregations from `count` to `p99` ([`reference/vercel-metrics-schema.json`](../reference/vercel-metrics-schema.json)). There is no FID metric, and the Real Experience Score (RES) is computed in the dashboard and exists in neither the metrics nor the drain.

The lab app (`lab/app/layout.tsx`) renders `<SpeedInsights />` from `@vercel/speed-insights/next` in the root layout, with no options. `petclinic-agent` does the same.

### Enablement is per project

Each project has its own Speed Insights switch (`vercel project speed-insights enable`, or the dashboard). Unlike `vercel project web-analytics enable` (non-interactive since CLI 64.2.0, 2026-10-28), `speed-insights enable` and `disable` still ask for confirmation and have no flag to skip it, so they need an interactive terminal (Documented, `vercel project` docs read 2026-11-12). The project record shows it (Captured: `project-speed-insights.ndjson`):

```json
"speedInsights": { "id": "WHBHxr7CQ7jqPxYuPCjZFaTn19W", "hasData": true,
                   "dataReceivedAt": 1792435109368, "enabledAt": 1793092605676 }
```

For `petclinic-agent`, `dataReceivedAt` is 2026-10-19 18:38 UTC and `enabledAt` is 2026-10-27 09:16 UTC. In between, the free tier collected vitals: `vercel metrics vercel.speed_insights.ttfb_ms` counts 42, 385, 29 and 6 page views for 2026-10-19 to 2026-10-22 (Captured: `metrics-ttfb-count-daily-petclinic.json`), and all five metrics were queryable for that period, not only RES. The lab project had samples on 2026-10-26 the same way (`lab/NOTES.md`). Yet creating a Speed Insights drain for these projects failed with `400` "Speed Insights must be enabled on project(s) … to drain Speed Insights data", although the team had Speed Insights Plus (Observed by the lab lead, 2026-10-27). After `enable` on each project, the drain was accepted.

Free-tier events count against a team-wide pool of 10,000 per 30 days; when it runs out, Vercel pauses collection for every free-tier project for at least 14 days (Documented). For that reason the `petclinic-agent` synthetic visitor (`petclinic/browser/visit.mjs`) aborts every `/vitals` request, so its visits after 2026-10-22 never reached Speed Insights.

## 2. Out-of-the-box shape

### Data point records

One drain record per metric per page view. Fields seen on all 187 records from 2026-10-27 (Captured):

| Field | Example | Note |
| --- | --- | --- |
| `schema` | `vercel.speed_insights.v1` | |
| `timestamp` | `2026-10-27 09:23:34.291` | **A string without `T` or time zone** (UTC). Vercel's schema shows ISO `2023-09-14T15:30:00.000Z` |
| `projectId`, `ownerId` | `prj_b3WT…`, `team_REDACTED` | |
| `deviceId` | `59974066` | A number. See "deviceId" below |
| `metricType` | `TTFB`, `FCP`, `LCP`, `CLS`, `INP`, `FID` | |
| `value` | `444`, `0`, `1.29` | Milliseconds, except CLS (unitless score). Integer or float |
| `origin` | `https://petclinic-agent.vercel.app/vets?utm_source=catalog-check` | **The full page URL with query string**, as in Web Analytics |
| `path` | `/vets` | |
| `route` | `/vets` | Route pattern, set by the Next.js integration |
| `country` | `DE` | |
| `osName`, `osVersion` | `Mac`, `10.15`; `Android`, `14.0` | |
| `clientName`, `clientVersion` | `Chrome`, `Chrome Mobile`; `141.0` | |
| `deviceType` | `desktop`, `mobile` | |
| `deviceBrand` | `Apple` | Absent when unknown (all 50 Android records) |
| `connectionSpeed` | `4g` | The browser's effective connection type |
| `browserEngine` | `Blink` | |
| `sdkName`, `sdkVersion`, `scriptVersion` | `@vercel/speed-insights/next`, `2.0.0`, `0.1.3` | `sdkVersion` is the npm version here; Web Analytics puts it in `sdkVersionFull` |
| `vercelEnvironment`, `vercelUrl`, `deploymentId` | `production`, `petclinic-agent-85fdk9p6i-brontoio.vercel.app`, `dpl_8bxs…` | Since 2026-11-10, data from custom environments is attributed to that environment instead of Preview in the dashboard and `vercel metrics` (Documented); the drain's `vercelEnvironment` value for a custom environment: Not observed |
| `attribution` | `"{\"eventTarget\":\"html>body>main>img\"}"` | A JSON **string**. See below |
| `isFree` | `false` | **Not in Vercel's published schema** |

In Vercel's schema but never seen: `region`, `city`, `clientType`, `browserEngineVersion` (Not observed). No field links a data point to a request, trace or Web Analytics page view.

### One record per metric, two beacons per page view

The 15 visits of the first run produced 30 `/vitals` requests and 82 records (88 once the last batches arrived); the second run of 20 visits produced 40 requests and 99 records (Observed). In the second run, where the requests were logged, every page view sent exactly two beacons, within 1 ms of each other, when the page was left (navigation to `about:blank` after 3 s); none was sent at load. One beacon carries CLS alone, the other the remaining metrics, and the records from one beacon share the same `timestamp` to the millisecond (Captured: `pageview-all-metrics.ndjson`). Vercel's docs describe TTFB and FCP as sent on load and FID and LCP on interaction (Documented); in the lab, everything waited for the page to be left. The beacons go to a per-project path such as `/39023274925c087f/vitals` (Resilient Intake, Documented), so a filter on `/_vercel/speed-insights` doesn't see them.

Which metrics a page view produces depends on what the visitor did (Observed, 35 page views):

| Visit | Page views | TTFB | FCP | CLS | LCP | INP | FID |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Click or tap after load | 25 | 25 | 25 | 25 | **22** | 25 | 25 |
| No interaction | 10 | 10 | 10 | 10 | 10 | 0 | 0 |

Without an interaction there is no INP and no FID. LCP was missing on 3 page views, all with a click straight after `load` (one each on `petclinic-agent` `/` and `/vets`, one on the lab's `/flags`); the cause wasn't established. Vercel's docs say 3 to 6 data points per visit on average (Documented). TTFB, FCP and CLS were present on every page view, so a count of TTFB records is the page-view count.

Speed Insights measures hard navigations only; in a Next.js app that is the first page of a session (Documented, Metrics docs, last updated 2026-09-01, unchanged on 2026-11-12). `@vercel/speed-insights` 2.1.0 (2026-11-05) adds a `softNavs` option (`<SpeedInsights softNavs={false} />`, `injectSpeedInsights({ softNavs: false })`) that sets `data-soft-navs` on the injected script to opt out of soft-navigation reporting; its release notes say the injected script has a separate default-on soft-navigation rollout, and that omitting the option leaves that default unchanged (Documented, release notes and PR #124). So soft navigations may now produce data points without any change in your code; the docs don't describe this yet. The lab visits were all hard navigations on 2.0.0; soft-navigation records: Not observed.

### `attribution`

A JSON string whose keys depend on the metric (Captured, 187 records):

| `metricType` | Keys | Example |
| --- | --- | --- |
| LCP | `eventTarget` | `html>body>main>img`, `h1.text-balance.font-bold.font-serif.text-4xl…` |
| INP, FID | `eventTarget`, `eventType` | `body>main.dot-grid.min-h-dvh.bg-background.px-6.py-16.text-foreground`, `pointerdown` |
| TTFB, FCP, CLS | none (`{}`) | CLS was 0 on every page view, so CLS attribution with a shift: Not observed |

The selector is a tag path with CSS class names (up to 149 characters in the lab), no text content, no input values, no `id` seen. It describes the page, not the visitor. Vercel's privacy page lists "Web Vital Attribution: html>body img.header" among the stored values (Documented). Class names can still carry meaning in some apps (a class named after a customer or feature); check yours before shipping the data elsewhere.

### `deviceId`

- **Stable across visits from the same browser and network.** Fifteen visits in fresh Playwright contexts (no cookies or storage carried over) had the same `deviceId` per project, and the same value came back in a second run five minutes later (Observed). Changing the user agent from desktop Chrome to Android Chrome gave a new value (`2607550671` → `1923289884`). It's derived from the request, not stored in the browser. Whether it changes from day to day: Not observed.
- **Different per project.** The same browser had `59974066` on `petclinic-agent` and `2607550671` on the lab project.
- **Different from Web Analytics.** The same visits had `deviceId` `567908454` and `1361031400` in the Web Analytics drain against `2607550671` and `1923289884` in Speed Insights (Observed in the lab's two drain datasets). The two products' records can't be joined by visitor.

Vercel's privacy page says Speed Insights doesn't collect anything that could "reconstruct a browsing session across pages or identify a user" (Documented).

### `isFree`

`false` on all 187 records, all from projects with Speed Insights Plus enabled (Observed). The field isn't documented. It most likely marks data points collected under the free tier, which don't count toward Plus usage; free-tier projects can't be drained, so a `true` value: Not observed.

### FID was still sent on 2026-10-27

Google replaced FID with INP as a Core Web Vital on 2024-03-12 ([web.dev](https://web.dev/blog/inp-cwv-march-12)). On 2026-10-27, `@vercel/speed-insights` 2.0.0 still sends FID on every page view with an interaction (25 of 25), and the drain delivers it. Vercel's changelog of 2026-10-01 says Speed Insights "will stop recording new measurements on November 1st" for FID (Documented). Whether FID records stop arriving in the drain after 2026-11-01: Not observed. `vercel metrics` has no FID metric already.

### Metrics

Queried with `vercel metrics` for 2026-10-27 09:15 UTC onwards, after both runs (Captured: `metrics-*.json`):

```
$ vercel metrics vercel.speed_insights.lcp_ms -p vercel-observability-lab --aggregation p75 --group-by deviceType
desktop 140 · mobile 124

$ vercel metrics vercel.speed_insights.lcp_ms --aggregation count --group-by attributionTarget
html>body>main>h1 9 · html>body>main>button 6 · html>body>main>img 5

$ vercel metrics vercel.speed_insights.inp_ms --aggregation count --group-by attributionTarget --group-by attributionEventName
html · pointerdown 15
```

`attributionTarget` and `attributionEventName` are the `eventTarget` and `eventType` keys of the drained `attribution` string.

## 3. Extras beyond the default

| Extra | What it adds | Cost |
| --- | --- | --- |
| Speed Insights Plus, per project | All Core Web Vitals and Poor entries in the dashboard, 30-day range on Pro, element selectors in breakdowns, and the drain | $10 per project per month on Pro, plus $0.65 per 10,000 events; no included events on Pro (Documented) |
| `beforeSend` on `<SpeedInsights />` | Rewrite events in the browser before they are sent, for example strip the query string from the URL so it doesn't land in `origin` (Documented) | None |
| `softNavs` option (2.1.0) | `false` opts out of soft-navigation reporting; `true` opts in explicitly; omitted leaves the script's default (Documented, release notes) | None |
| `route` option | The route pattern for frameworks without an integration; set automatically by `@vercel/speed-insights/next` (Documented) | None |
| `endpoint`, `scriptSrc` | Send beacons to another project's intake when several projects share a domain (Documented) | None |

The billing API shows the add-on as a team-level line, `Speed Insights Plus` (unit `Projects`), and the usage as `Speed Insights Plus Events` per project (Captured: `charges-speed-insights.jsonl`):

| Billing day (07:00 UTC) | Line | Quantity | Cost |
| --- | --- | --- | --- |
| 2026-10-19 to 2026-10-25 | Speed Insights Plus Events (no project) | 0 | $0, although the free tier recorded 462 page views of vitals on `petclinic-agent` |
| 2026-10-26 | Speed Insights Plus | 1 project | $0.33 effective, $0 billed |
| 2026-10-27 (open, read 09:30 UTC) | Speed Insights Plus | 2 projects | $1.00 |
| 2026-10-27 (open) | Speed Insights Plus Events, per lab project | 0 | $0 so far, 187 data points drained |

Free-tier events had no charge, as documented. Whether the Plus Events line counts one event per drained record (187) or per page view (35) needs the closed billing day 2026-10-27 (available after 2026-10-28 07:00 UTC). Vercel defines a data point as "a measurement of a specific Web Vital metric during a user's visit" and bills Plus usage in events (Documented), which points to one event per record.

## 4. Getting it out

| Signal | Exit path | Tested configuration |
| --- | --- | --- |
| Data points | Speed Insights drain, schema `speed_insights` v1, delivery `http`, encoding `ndjson` | Drains `vercel-observability-lab-speed-insights` and `petclinic-agent-speed-insights`, one project each |
| `vercel.speed_insights.*` metrics | None. `vercel metrics --json` on a schedule | |
| RES, FID as a metric | None | |

The lab's drains, as `GET /v1/drains` returns them (secrets removed, Captured: `drains.ndjson`):

```json
{ "name": "petclinic-agent-speed-insights",
  "projectIds": ["prj_b3WTvq01Qtd6lK3zThoF2COD7prM"],
  "schemas": { "speed_insights": { "version": "v1" } },
  "delivery": { "type": "http", "endpoint": "<your endpoint>", "encoding": "ndjson", "compression": "none" } }
```

The drain needs, per project, Speed Insights enabled and Plus active. The order that worked: `vercel project speed-insights enable` on each project (09:16 UTC), then the drain (09:17 UTC). Records reached the backend 6 to 10 s after the beacon.

**The drain is complete.** Drained records against `vercel metrics … --aggregation count` for the same window (2026-10-27 09:15 UTC onwards, Observed):

| Metric | Lab project: drain / metric | `petclinic-agent`: drain / metric |
| --- | --- | --- |
| TTFB | 21 / 21 | 14 / 14 |
| FCP | 21 / 21 | 14 / 14 |
| CLS | 21 / 21 | 14 / 14 |
| LCP | 20 / 20 | 12 / 12 |
| INP | 15 / 15 | 10 / 10 |
| FID | 15 / no metric | 10 / no metric |

Vercel's p75 equals the nearest-rank 75th percentile of the drained values for every metric on both projects (lab: LCP 124, FCP 124, INP 32, TTFB 45, CLS 0; `petclinic-agent`: LCP 380, FCP 444, INP 48, TTFB 46, CLS 0). So the drained records reproduce Vercel's numbers.

A record is about 0.8 KB (815 bytes on average, 758 to 919, Observed), 5.3 records per page view in the lab, so about 4.4 KB of drain volume per page view at $0.50 per GB (Documented), on top of the Plus events.

Records leave only when the browser sends them, and the lab saw them sent only when the page was left (section 2). A visitor who closes a crashed tab or loses the network sends nothing.

## 5. In Bronto

| Data | Dataset | Field names |
| --- | --- | --- |
| Speed Insights drain | `petclinic-agent/vercel-speed-insights`, `vercel-observability-lab/vercel-speed-insights` | As in the payload: `metricType`, `value`, `route`, `deploymentId`, `attribution` |

Queries run 2026-10-27 against the last 2 hours (both runs):

| Question | Query | Select, group by | Result |
| --- | --- | --- | --- |
| LCP p75 per page (lab) | `metricType = 'LCP'` | `p75(value)` by `route` | `/flags` 156 · `/image` 108 · `/` 107 |
| LCP p75 per page (`petclinic-agent`) | `metricType = 'LCP'` | `p75(value)` by `route` | `/` 488 · `/vets` 380 |
| LCP p75 by device (lab) | `metricType = 'LCP'` | `p75(value)` by `deviceType` | desktop 140 · mobile 124 (same as `vercel metrics`) |
| Data points per metric (`petclinic-agent`) | (all) | `count()` by `metricType` | FCP 14 · CLS 14 · TTFB 14 · LCP 12 · FID 10 · INP 10 |
| Page views per release (lab) | `metricType = 'TTFB'` | `count()` by `deploymentId` | `dpl_GY4JDgMZ4S78TcdqVojqu3FK6h1c` 21 |
| Poor INP (over 200 ms) | `metricType = 'INP' AND value > 200` | `count()` by `route` | `/` 1 (320 ms, the first page view of the run) |
| Poor FCP (over 1.8 s) | `metricType = 'FCP' AND value > 1800` | `count()` by `route` | `/` 1 (3,832 ms, the same page view) |
| Which element is slow to respond | `metricType = 'INP'` | `count()` by `attribution` | `body>main.dot-grid…`, `pointerdown` 4 · `div.flex.h-14…`, `pointerdown` 3 · 3 others |

`attribution` is a string; match selectors with `LIKE` (`attribution LIKE '%>img%'`). To leave out synthetic traffic, filter on your own marker in `origin` (`origin NOT LIKE '%utm_source=catalog-check%'`).

Joins: `deploymentId` matches `deploymentId` in the log drain and `deployment` in the Web Analytics drain (`dpl_GY4JDgMZ4S78TcdqVojqu3FK6h1c` in all three lab datasets, Observed); `route` matches the Web Analytics `route`. There is no request, trace or visitor key, so a slow page view can be put next to the function logs of the same deployment and route and time window, not next to its own request.

## Gotchas

1. **Plus on the team doesn't enable the drain.** Speed Insights has to be enabled on each project; until then the drain API answers `400` "Speed Insights must be enabled on project(s) … to drain Speed Insights data", even while the free tier collects and `vercel metrics` returns data for that project (Observed).
2. **Records are not page views.** One record per metric; a page view gave 4 to 6. Count page views with `metricType = 'TTFB'` (present on all 35) (Observed).
3. **LCP can be missing.** 3 of 25 page views with an early click had no LCP record, while TTFB, FCP and CLS were there (Observed). Per-page LCP counts run lower than page views.
4. **No interaction, no INP.** Pages people only look at produce no INP or FID records, so INP p75 describes the visitors who clicked (Observed).
5. **FID was still drained in October 2026.** Google retired it as a Core Web Vital on 2024-03-12; Vercel stopped recording it on 2026-11-01 (Documented). Before that date FID records arrived, with no matching metric in `vercel metrics`; whether they stopped after it: Not observed (the lab had no browser traffic in November).
6. **`timestamp` isn't ISO 8601.** `2026-10-27 09:18:48.325`, no `T`, no zone, unlike the documented example; parse it as UTC (Captured).
7. **`origin` is the full URL.** The query string leaves Vercel with every data point, as in Web Analytics. Strip it with `beforeSend` if URLs carry tokens (Captured).
8. **`deviceId` doesn't join.** It is per project and differs from the Web Analytics `deviceId` for the same visit (Observed).
9. **Headless browsers.** As with Web Analytics, the script sends nothing while `navigator.webdriver` is set (Observed in a lab test, 2026-10-20). The lab's visits ran with the flag off and a regular Chrome user agent, which Web Analytics also needed (see that entry); Speed Insights with the default `HeadlessChrome` user agent: Not observed.

## Samples

| File | What it shows |
| --- | --- |
| [`pageview-all-metrics.ndjson`](../samples/speed-insights/pageview-all-metrics.ndjson) | All six records of one page view (lab `/`, desktop, with a click): two `timestamp` values, one per beacon |
| [`record-lcp-image.json`](../samples/speed-insights/record-lcp-image.json) | LCP with the image selector in `attribution` |
| [`record-inp-petclinic.json`](../samples/speed-insights/record-inp-petclinic.json) | INP with a class-laden selector and `eventType` |
| [`record-fid.json`](../samples/speed-insights/record-fid.json) | FID from a mobile tap |
| [`record-cls.json`](../samples/speed-insights/record-cls.json) | CLS with empty `attribution` |
| [`record-ttfb-mobile.json`](../samples/speed-insights/record-ttfb-mobile.json) | Android record without `deviceBrand` |
| [`metrics-lcp-count-lab.json`](../samples/speed-insights/metrics-lcp-count-lab.json), [`metrics-inp-count-lab.json`](../samples/speed-insights/metrics-inp-count-lab.json) | Metric counts for the drain comparison |
| [`metrics-lcp-p75-device.json`](../samples/speed-insights/metrics-lcp-p75-device.json) | LCP p75 by device type |
| [`metrics-lcp-attribution.json`](../samples/speed-insights/metrics-lcp-attribution.json), [`metrics-inp-attribution.json`](../samples/speed-insights/metrics-inp-attribution.json) | `attributionTarget` and `attributionEventName` dimensions |
| [`metrics-ttfb-count-daily-petclinic.json`](../samples/speed-insights/metrics-ttfb-count-daily-petclinic.json) | Free-tier data before the project was enabled |
| [`project-speed-insights.ndjson`](../samples/speed-insights/project-speed-insights.ndjson) | `speedInsights` block of both project records (`dataReceivedAt`, `enabledAt`) |
| [`drains.ndjson`](../samples/speed-insights/drains.ndjson) | Both Speed Insights drains as `GET /v1/drains` returns them |
| [`charges-speed-insights.jsonl`](../samples/speed-insights/charges-speed-insights.jsonl) | Speed Insights billing lines, 2026-10-19 to 2026-10-27 (other projects removed) |

## Sources

- Vercel docs, read 2026-10-27: [Speed Insights Drains reference](https://vercel.com/docs/drains/reference/speed-insights) (last updated 2026-09-01), [Limits and pricing](https://vercel.com/docs/speed-insights/limits-and-pricing) (2026-09-23), [Metrics and data points](https://vercel.com/docs/speed-insights/metrics) (2026-09-01), [Managing usage](https://vercel.com/docs/speed-insights/managing-usage) (2026-09-01), [`@vercel/speed-insights` package](https://vercel.com/docs/speed-insights/package) (2026-03-18), [Privacy and compliance](https://vercel.com/docs/speed-insights/privacy-policy) (2026-03-18); changelog [Speed Insights deprecates First Input Delay on November 1st](https://vercel.com/changelog/speed-insights-deprecates-first-input-delay-on-november-first) (2026-10-01). Google: [INP becomes a Core Web Vital on March 12](https://web.dev/blog/inp-cwv-march-12) (2024).
- Lab, 2026-10-27: Speed Insights enabled on both projects at 09:16 UTC and drains created at 09:17 UTC; 15 headless-Chrome visits at 09:17–09:19 UTC (desktop, click, `utm_source=catalog-check`) and 20 at 09:23–09:25 UTC (desktop and Android profiles, with and without a click, `utm_source=catalog-check-2-*`), regular Chrome 141 user agent, `navigator.webdriver` off. Bronto EU datasets `petclinic-agent/vercel-speed-insights`, `vercel-observability-lab/vercel-speed-insights`, `vercel-observability-lab/vercel-web-analytics`, `vercel-observability-lab/vercel-logs`; `vercel metrics vercel.speed_insights.*`, `vercel api /v9/projects/<id>`, `/v1/drains`, `/v1/billing/charges` (CLI 65.2.0); `petclinic/browser/visit.mjs`; lab test notes from 2026-10-20.
- Read 2026-11-12: [`@vercel/speed-insights` v2.1.0 release](https://github.com/vercel/speed-insights/releases/tag/v2.1.0) (2026-11-05) and [PR #124](https://github.com/vercel/speed-insights/pull/124), [Speed Insights and Web Analytics now support custom environments](https://vercel.com/changelog/speed-insights-and-web-analytics-now-support-custom-environments) (2026-11-10), [`vercel project`](https://vercel.com/docs/cli/project) (`speed-insights`), [Metrics and data points](https://vercel.com/docs/speed-insights/metrics) (unchanged, 2026-09-01), [Speed Insights Drains reference](https://vercel.com/docs/drains/reference/speed-insights) (unchanged, 2026-09-01).
