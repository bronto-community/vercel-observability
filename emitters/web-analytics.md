# Web Analytics

> The `@vercel/analytics` script sends one record per page view and one per `track()` call, and the Web Analytics drain (`analytics` v2) delivers each of them as a flat JSON object: path, route pattern, query parameters, referrer, deployment, country, device, browser and OS, plus `eventName` and `eventData` for custom events. No code beyond the script tag and `track()` is needed to get them out. The drained count matched the billed count exactly in the lab (4,772 events in one billing day on both sides), so the drain is a complete copy you can join with logs and traces by `deployment` and route. The aggregated `vercel.analytics.*` metrics stay inside Vercel. What people get wrong: the script sends nothing from automated browsers (`navigator.webdriver = true`), so headless synthetic checks never show up, and the record carries the full query string twice (`origin` and `queryParams`), including whatever an OAuth redirect or a token puts there.

| | |
| --- | --- |
| Kind | Client script (`@vercel/analytics`) and platform service |
| Plans | All plans collect; drains need Pro or Enterprise; UTM dimensions in Vercel's own queries need Web Analytics Plus or Enterprise (Documented) |
| Signals | Events (page views, custom events) · Metrics (inside Vercel only) |
| Exit paths | Web Analytics drain (`analytics` v2) |
| Verified | 2026-10-26 · Vercel CLI 65.2.0 · `@vercel/analytics` 2.0.1 (`sdkVersion` 0.1.3 on the wire) · Next.js 16.3.6 · lab project `petclinic-agent` |

## 1. What it emits

| Signal | What | Where it lives | Retention |
| --- | --- | --- | --- |
| Events | `pageview` on every client-side navigation; `event` on every `track(name, data)` call | Web Analytics dashboard, Web Analytics drain | Hobby 1 month, Pro 12 months, Enterprise 24 months (Documented) |
| Metrics | `vercel.analytics.page_view.count`, `vercel.analytics.event.count` | Web Analytics dashboard, Query, `vercel metrics` | As above (Documented) |

Both metrics have the same 17 dimensions, among them `route`, `requestPath`, `referrerHostname`, `country`, `deviceType`, `osName`, `browserName`, the five `utm*` fields, `flags` and `visitorId`; `event.count` adds `eventName` and `eventData` ([`reference/vercel-metrics-schema.json`](../reference/vercel-metrics-schema.json)).

The script is added once in the root layout. The lab app (`apps/web/app/layout.tsx`) renders `<Analytics />` from `@vercel/analytics/next` and calls `track()` in three places: `example_clicked` and `message_sent` with `{ plan }` (and `followUp`), and `upgrade_clicked` with no data.

## 2. Out-of-the-box shape

### Event records

One drain record per event, no batching inside a record. Fields seen in the lab (4,788 records, 2026-10-17 to 2026-10-22, Captured):

| Field | Example | Note |
| --- | --- | --- |
| `schema` | `vercel.analytics.v2` | |
| `eventType` | `pageview`, `event` | |
| `eventName` | `message_sent` | Custom events only |
| `eventData` | `"{\"plan\":\"free\",\"followUp\":false}"` | A JSON **string**, not an object. Absent when `track()` gets no data (`upgrade_clicked`) |
| `timestamp` | `1792663026735` | ms, set by the browser |
| `projectId`, `ownerId` | `prj_b3WT…`, `team_REDACTED` | |
| `deviceId` | `3389692868` | A number. An anonymous visitor identifier without cookies (Documented) |
| `origin` | `https://petclinic-agent.vercel.app/?utm_source=synthetic` | **The full page URL with query string**, despite the name |
| `path` | `/s/wrun_41M5C982R93GMD3NQRPEXEHC29` | The real path |
| `route` | `/s/[sessionId]` | The route pattern, set by the Next.js integration |
| `queryParams` | `"{\"utm_source\":\"synthetic\"}"` | A JSON string. Vercel's schema shows `utm_source=google&…`; the lab gets JSON. Absent when the URL has no query (31 of 4,788) |
| `referrer` | `android-app://com.slack`, `https://vercel.com` | Absent on direct visits (4,777 of 4,788) |
| `country` | `IE` | ISO code |
| `osName`, `osVersion` | `Android`, `10.0` | |
| `clientName`, `clientType`, `clientVersion` | `Chrome Mobile`, `browser`, `155.0` | |
| `deviceType` | `mobile`, `desktop` | |
| `deviceBrand` | `Apple` | Absent when unknown (121 of 500 sampled had it) |
| `browserEngine`, `browserEngineVersion` | `Blink`, `605.1` | Version often absent |
| `sdkName`, `sdkVersion`, `sdkVersionFull` | `@vercel/analytics/next`, `0.1.3`, `2.0.1` | `sdkVersionFull` is the npm version |
| `vercelEnvironment` | `production` | |
| `vercelUrl` | `petclinic-agent-1gvj2sndw-brontoio.vercel.app` | The deployment URL |
| `deployment` | `dpl_4NKTKHthxj6KqejUJ8MSaWjNkDeA` | Named `deployment`, not `deploymentId` as in the log drain |

In Vercel's published schema but never seen in the lab: `region`, `city`, `deviceModel`, `flags` (Not observed). No record carried a `flags` field: the lab app doesn't use the Flags SDK, and grouping `vercel.analytics.event.count` by `flags` returned an empty result. Whether flag values appear once the Flags SDK reports them: Not observed (needs a test project).

No field links an event to a request or trace: there is no request ID, trace ID or session ID. The join keys to the other drains are `deployment` (= `deploymentId` in logs, `vercel.deployment_id` on spans), `route` and the timestamp.

### What the lab produced

From 2026-10-17 to 2026-10-22 (Observed, grouped counts in the drain dataset):

| | Count |
| --- | --- |
| Custom events | 2,625 (`message_sent` 1,312 · `example_clicked` 1,311 · `upgrade_clicked` 2) |
| Page views | 2,163 |
| Records by route (page views and events) | `/` 2,636 · `/s` 1,310 · `/vets` 837 · `/s/[sessionId]` 5 |
| Synthetic (`queryParams` contains `utm_source=synthetic`) | 4,755 of 4,788 |
| Device types | mobile 2,458 · desktop 2,330 |

### Metrics

Queried with `vercel metrics` (Observability Plus enabled), for the billing day 2026-10-20 07:00 to 2026-10-21 07:00 UTC (Captured: `metrics-*.json`):

```
$ vercel metrics vercel.analytics.page_view.count --group-by route
/ 877 · /vets 836 · /s 437 · /s/[sessionId] 5               (total 2,155)

$ vercel metrics vercel.analytics.event.count --group-by eventName
message_sent 1,310 · example_clicked 1,308 · upgrade_clicked 1   (total 2,619)

$ vercel metrics vercel.analytics.event.count --group-by eventData
plan 2,618 · followUp 1,310

$ vercel metrics vercel.analytics.page_view.count --group-by utmSource
null 2,155
```

- `eventData` as a dimension groups by the **key names** in the data, not their values. Per-value counts (free versus premium) need the drained records.
- `utmSource` came back `null` for all 2,155 page views on a Pro team, although every synthetic page view carries `utm_source=synthetic` in `queryParams`. The drain has the UTM values; Vercel's queries need Web Analytics Plus for them (Documented; earlier CLI versions refused with "UTM dimensions require an Enterprise plan or the Web Analytics Plus add-on").
- `--aggregation unique` (unique visitors) returned `invalid_request` without a group-by (Observed, CLI 65.2.0).

## 3. Extras beyond the default

| Extra | What it adds | Cost |
| --- | --- | --- |
| `track(name, data)` | `event` records with `eventName` and `eventData` (flat values: strings, numbers, booleans, null) | Each event counts as a Web Analytics event, like a page view |
| `beforeSend` on `<Analytics />` | Rewrite or drop events in the browser before they are sent (for example, strip query strings from URLs) (Documented) | None |
| UTM parameters in the URL | `queryParams` in the drain, at no extra cost. `utm*` dimensions in Vercel's own queries need Web Analytics Plus | Web Analytics Plus: add-on (Documented) |
| Flags SDK reporting | A `flags` field and a `flags` dimension (Documented) | Not observed |

### Automated browsers send nothing

The script sends no events while the browser reports `navigator.webdriver = true`, which every Playwright, Puppeteer and Selenium browser does by default (Observed 2026-10-20, research I, D11: one Playwright visit with the flag on gave 0 events, with it off 1 page view and 2 custom events). The lab's synthetic visitor (`petclinic/browser/visit.mjs`) launches Chromium with `--disable-blink-features=AutomationControlled` so that its visits are counted, and tags every URL with `utm_source=synthetic` so they can be told apart. Bots and crawlers that don't run JavaScript never load the script at all. Nothing in the drain marks a visit as automated; filter on your own marker.

## 4. Getting it out

| Signal | Exit path | Tested configuration |
| --- | --- | --- |
| Page views, custom events | Web Analytics drain, schema `analytics` v2, delivery `http`, encoding `ndjson` | Drain `petclinic-agent-web-analytics`, one project |
| `vercel.analytics.*` metrics | None. `vercel metrics --json` (Observability Plus) on a schedule | |

The lab's drain, as `GET /v1/drains` returns it (secrets removed):

```json
{ "name": "petclinic-agent-web-analytics",
  "projectIds": ["prj_b3WTvq01Qtd6lK3zThoF2COD7prM"],
  "schemas": { "analytics": { "version": "v2" } },
  "delivery": { "type": "http", "endpoint": "<your endpoint>", "encoding": "ndjson", "compression": "none" } }
```

**The drain is complete.** For the billing day 2026-10-20 07:00 to 2026-10-21 07:00 UTC, the billing API charged `petclinic-agent` for 4,772.2 Web Analytics Events; the drain delivered 2,618 events and 2,154 page views, 4,772 records (Observed). Vercel's metrics counted 2,619 and 2,155 for the same window, one more each.

Drained events cost drain volume ($0.50 per GB, Documented) on top of the Web Analytics events themselves. A record is about 0.8 KB (776 bytes on average over 500 records, Observed). Delivery behaviour (batching, retries, signatures) is shared by all drains and covered in the Drains entry.

Records leave only when the browser sends them. The lab's visitor ends each visit by navigating to `about:blank` so that the last events are flushed.

## 5. In Bronto

| Data | Dataset | Field names |
| --- | --- | --- |
| Web Analytics drain | `petclinic-agent/vercel-web-analytics` | As in the payload: `eventType`, `eventName`, `route`, `queryParams` |

Queries against the lab's last 30 days, run 2026-10-26 (traffic ran 2026-10-17 to 2026-10-22):

| Question | Query | Group by | Result |
| --- | --- | --- | --- |
| Custom events by name | `eventType = 'event'` | `eventName` | `message_sent` 1,312 · `example_clicked` 1,311 · `upgrade_clicked` 2 |
| Events by data | `eventType = 'event'` | `eventData` | `{"plan":"free"}` 1,311 · `{"plan":"free","followUp":false}` 1,310 · `{"plan":"free","followUp":true}` 2 · none 2 |
| Real page views (synthetic excluded) | `eventType = 'pageview' AND (queryParams IS NULL OR queryParams NOT LIKE '%synthetic%')` | `route` | `/` 13 · `/s/[sessionId]` 5 · `/s` 2 · `/vets` 1 |
| Page views per release | `eventType = 'pageview'` | `deployment` | top deployment 4,377 of all records |
| Device mix | `eventType = 'pageview'` | `deviceType`, `clientName` | mobile Chrome Mobile 553 · mobile Mobile Safari 552 · desktop Chrome 525 · desktop Edge 523 |

`eventData` and `queryParams` are strings; match values with `LIKE` (`eventData LIKE '%"plan":"premium"%'`).

## Gotchas

1. **Headless browsers are invisible.** `navigator.webdriver = true` suppresses every event, so Playwright checks and most bots never appear. Counted synthetic traffic needs the flag off and a marker of your own (Observed, D11).
2. **`origin` is the full URL.** It holds the path and query string, not just scheme and host. Together with `queryParams`, anything in the query string leaves Vercel: two lab records carry `{"error":"access_denied","error_description":"This Vercel account does not have access to this app."}` from an OAuth redirect. Strip sensitive parameters with `beforeSend` (Captured: `pageview-synthetic.json`).
3. **`queryParams` and `eventData` are JSON strings.** Vercel's docs show `queryParams` as a URL query string (`utm_source=google&…`); the lab receives JSON (`{"utm_source":"synthetic"}`) (Captured).
4. **`deployment`, not `deploymentId`.** The same ID is `deploymentId` in the log drain and `vercel.deployment_id` on spans; join on the value.
5. **No request or trace ID.** A page view can't be joined to its server request directly; join by deployment, route and time.
6. **`eventData` dimension groups by key.** In `vercel metrics`, `--group-by eventData` returns `plan` and `followUp`, not their values (Observed).
7. **`route` needs the framework integration.** `@vercel/analytics/next` fills `route` with the pattern (`/s/[sessionId]`); `path` keeps the real URL. Group by `route` for per-page numbers.

## Samples

| File | What it shows |
| --- | --- |
| [`pageview-synthetic.json`](../samples/web-analytics/pageview-synthetic.json) | A page view from the synthetic visitor: `queryParams`, full-URL `origin` |
| [`pageview-dynamic-route.json`](../samples/web-analytics/pageview-dynamic-route.json) | A page view on a dynamic route: `path` versus `route`, no `queryParams` |
| [`event-message-sent.json`](../samples/web-analytics/event-message-sent.json) | A custom event with `eventData` (two keys) |
| [`event-upgrade-clicked.json`](../samples/web-analytics/event-upgrade-clicked.json) | A custom event without data, from a real phone visit with `referrer` |
| [`event-with-referrer.json`](../samples/web-analytics/event-with-referrer.json) | A custom event with an app referrer (`android-app://com.slack`) |
| [`metrics-pv-route.json`](../samples/web-analytics/metrics-pv-route.json) | `vercel.analytics.page_view.count` by route |
| [`metrics-ev.json`](../samples/web-analytics/metrics-ev.json) | `vercel.analytics.event.count` by event name |
| [`metrics-evdata.json`](../samples/web-analytics/metrics-evdata.json) | `vercel.analytics.event.count` by `eventData` (key names) |
| [`metrics-utm.json`](../samples/web-analytics/metrics-utm.json) | `utmSource` dimension: `null` without Web Analytics Plus |

## Sources

- Vercel docs, read 2026-10-26: [Web Analytics Drains reference](https://vercel.com/docs/drains/reference/analytics) (last updated 2026-07-03), [Web Analytics](https://vercel.com/docs/analytics), [Custom events](https://vercel.com/docs/analytics/custom-events), [`@vercel/analytics` package](https://vercel.com/docs/analytics/package), [Drains](https://vercel.com/docs/drains).
- Lab: Bronto EU dataset `petclinic-agent/vercel-web-analytics`, 2026-10-17 to 2026-10-22; `vercel metrics vercel.analytics.*` (CLI 65.2.0, 2026-10-26); `GET /v1/drains`; `GET /v1/billing/charges` for 2026-10-20; lab code `apps/web/app/layout.tsx`, `apps/web/app/_components/agent-chat.tsx`, `petclinic/browser/visit.mjs`; research I, D11 and D14.
