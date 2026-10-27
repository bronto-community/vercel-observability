# BotID

> Every `checkBotId()` call produces one data point in `vercel.bot_id_check.count`, with the verdict (`botCheckResult`: `Bot` or `Human`), the client's user agent, TLS fingerprint, country and referrer. That metric needs Observability Plus and has no drain. The verdict still leaves Vercel without code changes: `checkBotId()` makes a `fetch` to `api.vercel.com/bot-protection/v1/is-bot`, and with `@vercel/otel` that call becomes a span whose `http.status_code` is `400` for every Bot verdict and `200` for every Human (21 and 15 in the lab, matching the metric exactly). The log drain shows what your code did with the verdict (the lab's `403`) and a `warning` from the `botid` library when a request arrives without BotID's client headers. The firewall doesn't see the verdict: the same requests are `allow` in `vercel.firewall_action.count`. The trap: in this lab, a headless browser with `navigator.webdriver` switched off was still a Bot as long as its user agent said `HeadlessChrome`.

| | |
| --- | --- |
| Kind | Platform service (Kasada-backed bot check) with a library (`botid`: client script and `checkBotId()`) |
| Plans | Basic on all plans, free; Deep Analysis Pro ($1 per 1,000 calls) and Enterprise (Documented); metric queries need Observability Plus |
| Signals | Metrics (inside Vercel only) · Traces (the check's `fetch` span, with `@vercel/otel`) · Logs (your code's lines, the library's warning, the client script's rewrite) |
| Exit paths | Trace drain · Log drain · `vercel metrics` pull |
| Verified | 2026-10-27 · Vercel CLI 65.2.0 · `botid` 1.5.11 · `@vercel/otel` 2.1.3 · Next.js 16.4.3 · lab project `vercel-observability-lab`, BotID mode Basic |

## 1. What it emits

| Signal | What | Where it lives | Retention |
| --- | --- | --- | --- |
| Metrics | `vercel.bot_id_check.count`: one data point per `checkBotId()` call, 13 dimensions | Firewall tab (BotID traffic filter), Query, `vercel metrics` | Pro 1 day, Plus 30 days (Documented) |
| Metrics | `vercel.external_api_request.*`: the call to `api.vercel.com/bot-protection/v1/is-bot` | Observability › External APIs, `vercel metrics` | As above |
| Traces | `fetch POST https://api.vercel.com/bot-protection/v1/is-bot?v=3` under the route span | Trace drain (with `@vercel/otel` or another fetch instrumentation) | |
| Logs | The `botid` library's warning for requests without client headers; your own lines; one `source: external` record per load of BotID's client script | Log drain, Runtime Logs | |
| Billing | `BotID Deep Analysis Requests` | `GET /v1/billing/charges` | |

Dimensions of `vercel.bot_id_check.count`: `projectId`, `requestHostname`, `requestPath`, `route`, `clientIp`, `clientUserAgent`, `clientIpCountry`, `clientJa4Digest`, `asnName`, `asnId`, `referrerUrl`, `botCheckResult`, `deepAnalysisCheck`. Aggregations `count`, `unique`.

The lab: `/botid` loads BotID's client (`initBotId` protecting `POST /api/botid`, `withBotId` in `next.config.ts`); its button posts to `/api/botid`, which calls `checkBotId()`, logs `{"msg":"botid check","isBot":…}` and answers `403` for bots, `200` otherwise. Traffic on 2026-10-27 (drains active): 3 `curl` POSTs, 4 headless Chrome runs with the `HeadlessChrome` user agent (2 with `navigator.webdriver` on, 2 off), 2 headless Chrome runs with the user agent rewritten to `Chrome` and `navigator.webdriver` off. Plus the 2026-10-26 traffic in `lab/NOTES.md`.

## 2. Out-of-the-box shape

### Metric

Since 2026-10-26 (Captured: `metrics-by-*.json`):

```
$ vercel metrics vercel.bot_id_check.count --group-by botCheckResult --group-by deepAnalysisCheck --group-by route --since 2026-10-26T00:00:00Z --json
Bot / 0 / /api/botid 21 · Human / 0 / /api/botid 15

$ vercel metrics vercel.bot_id_check.count --group-by botCheckResult --group-by clientUserAgent
Human  Chrome/141 (2026-10-26 headless runs, see lab/NOTES.md)   13
Bot    Chrome/141 (2026-10-26 headless runs)                        6
Bot    catalog-check/1.0                                            6
Bot    curl/8.7.1                                                   5
Bot    HeadlessChrome/156 (webdriver on 2, off 2)                   4
Human  Chrome/156 (headless, UA rewritten, webdriver off)           2

$ vercel metrics vercel.bot_id_check.count --group-by botCheckResult --group-by clientJa4Digest --group-by referrerUrl
Human t13d1517h2_8daaf6152771_cb7bf5808d99 …/botid 15 · Bot t13d4907h2_0d8feac7bc37_7395dae3b2f3 "" 11 · Bot t13d1517h2_8daaf6152771_cb7bf5808d99 …/botid 10
```

- `deepAnalysisCheck` was `0` on every data point (Deep Analysis off).
- `asnName` was empty for every data point; `clientIpCountry` was `DE`.
- `referrerUrl` is empty for `curl`, the page URL for browsers. The JA4 fingerprint separated `curl` from Chrome, but a Chrome classified as Bot had the same fingerprint as one classified as Human.

### The check's `fetch` span

`checkBotId()` posts the request's headers to Vercel and waits for the verdict. With `@vercel/otel` registered, that call is a client span under `executing api route (app) /api/botid` (Captured: `span-fetch-is-bot-bot.json`, `span-fetch-is-bot-human.json`, `trace-botid-403.ndjson`):

```
POST /api/botid                                            vercel.edge-network        120.3 ms
├─ Resolve Deployment · Resolve Route · Route across regions
└─ Invoke Function                                         vercel.serverless-runtime   72.1 ms
   ├─ POST /api/botid                                      vercel-observability-lab    57.9 ms
   │  └─ executing api route (app) /api/botid                                          56.3 ms
   │     └─ fetch POST https://api.vercel.com/bot-protection/v1/is-bot?v=3             54.4 ms
   └─ waitUntil                                                                         3.4 ms
```

| Attribute | Bot | Human |
| --- | --- | --- |
| `http.status_code` | `400` | `200` |
| `http.response_content_length_uncompressed` | `172` | |
| `span.status_code` | `STATUS_CODE_UNSET` | `STATUS_CODE_UNSET` |
| `http.url`, `http.method`, `net.peer.name` | `https://api.vercel.com/bot-protection/v1/is-bot?v=3`, `POST`, `api.vercel.com` | same |

All 9 spans of 2026-10-27 followed this: 7 Bot with `400`, 2 Human with `200`. `vercel.external_api_request.count` for `/bot-protection/v1/is-bot` since 2026-10-26: `400` 21, `200` 15, the same split as `botCheckResult` (Observed). Median call time 123 ms (`request_duration_ms` p50). The edge root span of a request the app answered with `403` is `STATUS_CODE_UNSET` too.

### Log records

Per checked request, the log drain carries (Observed, 9 requests):

| Record | `type` / `level` | Example |
| --- | --- | --- |
| Invocation report line, blocked (the app's `403`) | `stdout` / `warning` | `[POST] /api/botid status=403` (Captured: `log-report-403.json`) |
| Invocation report line, allowed | `stdout` / `info` | `[POST] /api/botid status=200` (Captured: `log-report-200.json`) |
| The lab's own line | `stdout` / `info` | `{"msg":"botid check","isBot":true}` (Captured: `log-app-isbot.json`) |
| Warning from the `botid` library, only when the request had no BotID client headers (`curl`, 3 of 3) | `stderr` / `warning` | `Possible misconfiguration of Vercel BotId or malicious request to 'POST /api/botid'. More info at https://vercel.com/docs/botid/get-started#add-client-side-protection` (Captured: `log-misconfiguration-warning.json`) |
| BotID's client script, once per page load | `source: external`, `info` | `proxy.path: /149e9513-…/a-4-a/c.js?i=0&v=3&h=…`, `destination: https://api.vercel.com/bot-protection/v1/challenge?…` (Captured: `log-external-client-script.json`) |

- The warning is a `console.warn` in `botid/dist/server` when the `x-is-human` header is missing and the deployment is production. Outside production the library writes a longer `console.error` instead ("Ensure that the client-side protection is properly configured…"). It is not a platform line (library source, `botid` 1.5.11).
- Browsers that ran BotID's client sent the headers `x-is-human`, `x-path` and `x-method` with the POST, also when the verdict was Bot. They produced no warning.
- No record carries the verdict as a field. A blocked request is a normal function invocation with your status code; the `403` is the lab's choice.
- No `source: firewall` record: BotID's verdict is not a firewall action. `vercel.firewall_action.count` for `/api/botid` shows all 36 requests as `wafAction: allow` (21 with status `403`, 15 with `200`, Observed).

### Billing

`BotID Deep Analysis Requests` appears as a team-level line at 0 (billing day 2026-10-26, Captured: `charge-deep-analysis-2026-10-26.jsonl`). Basic checks have no billing line. Every `checkBotId()` call in Deep Analysis mode is billed, whatever the verdict (Documented).

## 3. Extras beyond the default

| Extra | What it adds | Cost |
| --- | --- | --- |
| Deep Analysis (Firewall › BotID, or `checkBotId({ advancedOptions: { checkLevel: 'deepAnalysis' } })`) | Kasada's ML check after the Basic check passes; `deepAnalysisCheck` would show it in the metric (Not observed) | $1 per 1,000 calls on Pro (Documented) |
| `@vercel/otel` (or any fetch instrumentation) | The `is-bot` span, which is the verdict's only drained trace | Trace drain volume |
| Logging the full result | `checkBotId()` returns `isBot`, `isHuman`, `isVerifiedBot`, `verifiedBotName`, `verifiedBotCategory`, `bypassed` and `classificationReason` (library source). Logging them as one JSON line puts the reason and verified-bot name into the log drain. The lab logs `isBot` only | |
| Observability Plus | Querying `vercel.bot_id_check.count` | $1.20 per 1M events (Documented) |

## 4. Getting it out

| Signal | Exit path | Tested configuration |
| --- | --- | --- |
| Verdict per request | Trace drain: the `is-bot` fetch span's `http.status_code` (`400` Bot, `200` Human) | Trace drain on `vercel-observability-lab`, OTLP/HTTP; `@vercel/otel` with no exporter in code |
| Verdict with reason | Log drain: log the `checkBotId()` result as JSON | The lab's line carries `isBot` only |
| What the app did | Log drain: report line `status=…` | Drain on `vercel-observability-lab`, all sources |
| Requests without BotID headers | Log drain: the library's `warning` | |
| Client script loads | Log drain: `source: external` with `destination` on `/bot-protection/v1/challenge` | |
| User agent, JA4, country, ASN per verdict | None. Pull `vercel metrics vercel.bot_id_check.count --json` (Plus) | |

## 5. In Bronto

| Data | Dataset | Field names |
| --- | --- | --- |
| Log drain | `vercel-observability-lab/vercel-logs` | `source`, `path`, `message`, `statusCode`, `destination`; nested with double quotes: `"proxy.referer"` |
| Trace drain | `.traces/vercel-observability-lab` | `"$http.url"`, `"$http.status_code"`, `$trace_id` |

Queries, each run on 2026-10-27 over the drained data (from 08:43 UTC):

| Question | Query | Group by | Result |
| --- | --- | --- | --- |
| Verdicts (trace dataset) | `"$http.url" LIKE '%/bot-protection/v1/is-bot%'` | `"$http.status_code"` | `400` (Bot) 7 · `200` (Human) 2 |
| What the app answered | `path = '/api/botid' AND message LIKE 'START%'` | `statusCode`, `level` | `403 warning` 7 · `200 info` 2 |
| Requests without BotID's client | `message LIKE 'Possible misconfiguration of Vercel BotId%'` | `path`, `level`, `type` | `/api/botid warning stderr` 3 |
| Pages that loaded BotID's client | `source = 'external' AND destination LIKE '%/bot-protection/v1/challenge%'` | `proxy.referer`, `proxy.statusCode` | `…/botid 200` 6 |

A log record's `traceId` is the `$trace_id` of the trace that holds the `is-bot` span, so verdict and report line can be joined.

## Gotchas

1. **The `is-bot` call answers `400` for bots.** A fetch error-rate alert on `api.vercel.com` fires on bot traffic. Treat `400` from `/bot-protection/v1/is-bot` as the Bot verdict, not as a failure (Observed, 36 of 36 calls agreed with the metric).
2. **The verdict isn't a firewall event.** Requests your code rejects after `checkBotId()` count as `allow` in the firewall metric and never produce `source: firewall` records. Firewall dashboards don't show BotID blocks.
3. **The warning is from the library, at `warning`.** "Possible misconfiguration of Vercel BotId or malicious request…" is `console.warn` in production; `curl` and scripts without BotID's client trigger it on every request. In preview and development the same case is a `console.error` with a different text, so a filter on the production text misses it there.
4. **`HeadlessChrome` was enough to be a Bot.** Headless Chrome with `navigator.webdriver` switched off was classified Bot 2 of 2 times with its default user agent, and Human 2 of 2 times once the user agent said `Chrome` (Basic mode, Observed). This narrows `lab/NOTES.md`, which recorded the webdriver flag as the difference.
5. **Without `@vercel/otel` the verdict has no drained trace.** The span exists because the lab registers fetch instrumentation; an app without it has only the metric and its own logs.
6. **ASN is empty.** `asnName` was empty on all 36 data points, so the metric can't group bot traffic by network for this lab's clients (Observed).

## Samples

| File | What it shows |
| --- | --- |
| [`span-fetch-is-bot-bot.json`](../samples/botid/span-fetch-is-bot-bot.json) | The `is-bot` fetch span for a Bot verdict (`http.status_code: 400`) |
| [`span-fetch-is-bot-human.json`](../samples/botid/span-fetch-is-bot-human.json) | The same span for a Human verdict (`200`) |
| [`trace-botid-403.ndjson`](../samples/botid/trace-botid-403.ndjson) | All 12 spans of a request answered with `403` |
| [`log-report-403.json`](../samples/botid/log-report-403.json) | Report line of a blocked request (`level: warning`) |
| [`log-report-200.json`](../samples/botid/log-report-200.json) | Report line of an allowed request |
| [`log-app-isbot.json`](../samples/botid/log-app-isbot.json) | The lab's own `{"msg":"botid check","isBot":true}` line |
| [`log-misconfiguration-warning.json`](../samples/botid/log-misconfiguration-warning.json) | The `botid` library's warning for a request without client headers |
| [`log-external-client-script.json`](../samples/botid/log-external-client-script.json) | BotID's client script through the `withBotId` rewrite (`source: external`) |
| [`metrics-by-result.json`](../samples/botid/metrics-by-result.json) | Checks by verdict, Deep Analysis flag and route |
| [`metrics-by-user-agent.json`](../samples/botid/metrics-by-user-agent.json) | Checks by verdict and user agent |
| [`metrics-by-ja4-referrer.json`](../samples/botid/metrics-by-ja4-referrer.json) | Checks by verdict, JA4 and referrer |
| [`metrics-by-asn-country.json`](../samples/botid/metrics-by-asn-country.json) | ASN (empty), country, path, host |
| [`metrics-external-api-is-bot.json`](../samples/botid/metrics-external-api-is-bot.json) | `vercel.external_api_request.count` for the `is-bot` call by status |
| [`metrics-invocations-by-status.json`](../samples/botid/metrics-invocations-by-status.json) | `/api/botid` invocations by status |
| [`charge-deep-analysis-2026-10-26.jsonl`](../samples/botid/charge-deep-analysis-2026-10-26.jsonl) | The Deep Analysis billing line (0) |

## Sources

- Vercel docs, read 2026-10-27: [BotID](https://vercel.com/docs/botid) (last updated 2026-06-16), [Firewall Observability](https://vercel.com/docs/vercel-firewall/firewall-observability), [Log Drains reference](https://vercel.com/docs/drains/reference/logs).
- `botid` 1.5.11: `dist/server/index.mjs` (warning text, `is-bot` request, result fields).
- Lab: `lab/app/botid/`, `lab/app/api/botid/route.ts`, `lab/instrumentation-client.ts`, `lab/next.config.ts`; Bronto EU datasets `vercel-observability-lab/vercel-logs` and `.traces/vercel-observability-lab`, 2026-10-27; Vercel CLI 65.2.0 (`vercel metrics`, `vercel traces search`, `vercel logs requests`, `vercel api /v1/billing/charges`); headless Chrome 156 via Playwright, 2026-10-27 08:47 UTC.
