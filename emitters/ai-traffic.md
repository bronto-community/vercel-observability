# AI traffic (crawlers and assistants)

> Vercel counts requests from AI bots in five `vercel.ai_traffic.*` metrics (all AI bots, crawlers, assistants, failed requests, requests for `text/markdown`). They are metrics only: they need Observability Plus to query, and no drain or webhook carries them. Every AI request also reaches the log drain as an ordinary record whose `proxy.userAgent` holds the bot's user agent, so request counts per user agent can leave Vercel without code. Requests the platform challenges, and the bot classification itself, stay inside Vercel. The trap: Vercel only counts a request as AI traffic when it recognizes the bot, and a user agent alone was not enough. In the lab, 167 requests from `MistralBot/1.0` (a scanner on a hosting provider's network), a spoofed `GPTBot` and a `Claude-User` fetch from a laptop all reached the drain with their AI user agents, while `vercel.ai_traffic.*` stayed at zero for the project for 30 days. On the team's other projects the metric did count 140 recognized requests in 7 days (`amazonbot`, `applebot`, `gptbot`, `oai-searchbot`, `chatgpt-user` …), most of them for `/robots.txt`. A user agent match in the drain counts what bots claim to be. The metric counts what Vercel has recognized.

| | |
| --- | --- |
| Kind | Platform service (CDN request classification) |
| Plans | AI Traffic tab on all plans with Observability (Documented); `vercel metrics` queries need Pro or Enterprise with Observability Plus |
| Signals | Metrics (inside Vercel only); the underlying requests as log records |
| Exit paths | None for the metrics (pull with `vercel metrics --json`) · Log drain for the requests (`proxy.userAgent`) |
| Verified | 2026-10-26 · Vercel CLI 65.2.0 · lab project `petclinic-agent` · Observability Plus enabled 2026-10-26 |
| Refreshed | 2026-11-12 · docs and changelog to 2026-11-12, no new captures · Vercel CLI 65.14.0 (`firewall rules` help and `inspect ai-bots`, read-only) |

## 1. What it emits

| Signal | What | Where it lives | Retention |
| --- | --- | --- | --- |
| Metrics | `vercel.ai_traffic.count`, `.crawler.count`, `.assistant.count`, `.failed_requests.count`, `.markdown_requests.count` | Observability › AI Traffic, Query, `vercel metrics` | Observability Plus 30 days (Documented) |
| Metrics (related) | `botName`, `botCategory`, `botVerified` dimensions on `vercel.request.*`, `vercel.firewall_action.count` and `vercel.isr_operation.*` | Observability › CDN Requests, Query, `vercel metrics` | As above |
| Logs | Each AI bot request as a normal record (`source: static`, `lambda`, `firewall` …) with the user agent in `proxy.userAgent` | Runtime Logs, log drain | See the Functions entry |

What the five metrics count, per `vercel metrics` docs (Documented, read 2026-10-26):

| Metric | Docs description | Dimensions (Captured: `reference/vercel-metrics-schema.json`) |
| --- | --- | --- |
| `vercel.ai_traffic.count` | Number of requests from AI bots | `projectId`, `environment`, `botName`, `botCategory` |
| `vercel.ai_traffic.crawler.count` | Requests from AI crawlers (bots that index or train on content) | the four above plus `requestPath`, `httpStatus`, `pathType` |
| `vercel.ai_traffic.assistant.count` | Requests from AI assistants (fetches on behalf of a user) | as for crawler |
| `vercel.ai_traffic.failed_requests.count` | Failed requests from AI bots | as for crawler |
| `vercel.ai_traffic.markdown_requests.count` | Requests from AI bots that requested `text/markdown` | as for crawler |

All five support only the `count` aggregation. `ai_traffic.count` has no path or status dimension; use the per-kind metrics for those.

**Markdown requests** (Documented only): requests from AI bots that asked for `text/markdown`, which is how agents ask for the Markdown version of a page through content negotiation (`Accept: text/markdown`). The AI Traffic tab lists "paths that AI bots request as Markdown". The lab app serves no Markdown, and no AI request was counted, so this metric was empty (Not observed). The log drain has no `Accept` header field, so a markdown request can't be told apart from an HTML request outside Vercel (Observed: no such field in 589 bot records).

Vercel announced the Observability › AI Traffic page in its changelog on 2026-10-28: requests by verified AI bot, most-crawled pages, assistant retrievals, Markdown requests and error pages, with `vercel metrics` queries needing Observability Plus (Documented). The Observability Insights docs already described the AI Traffic tab (last updated 2026-08-11), and this entry used it on 2026-10-26; the changelog adds no new metric or exit path.

**Crawler or assistant** comes from Vercel's verified bots directory, which gives each bot a category: `gptbot`, `claudebot`, `ccbot`, `applebot`, `amazonbot`, `meta-externalagent` are `ai_crawler`; `chatgpt-user`, `oai-searchbot`, `claude-user`, `claude-searchbot`, `perplexitybot`, `perplexity-user`, `mistralai-user`, `mistralai-index`, `duckassistbot` are `ai_assistant` (Documented, Bot Management docs, 2026-09-10). Vercel verifies bots by IP range, reverse DNS or Web Bot Auth signatures (Documented).

## 2. Out-of-the-box shape

### Metrics

Output of `vercel metrics … --json`: `query`, `summary` (one row per group), `data` (one row per group per time bucket), as for every platform metric (see Functions).

For the lab project, every `vercel.ai_traffic.*` metric returned no rows for the last 30 days, in production and preview (Captured: `metrics-ai-traffic-count-14d.json`, `metrics-markdown-requests-14d.json`):

```json
{ "query": { "metric": "vercel.ai_traffic.count", "aggregation": "count", "groupBy": ["botName", "botCategory"],
             "startTime": "2026-10-12T12:00:00.000Z", "endTime": "2026-10-26T16:00:00.000Z", "granularity": { "hours": 4 } },
  "summary": [], "data": [] }
```

Other projects on the same team (public websites, no drain into the lab) did get recognized AI traffic: 140 requests team-wide in the 7 days to 2026-10-26, all `production` (Observed with `--all`). Their rows show the shape (Captured: `metrics-team-*.json`, project IDs other than the lab's replaced with `prj_OTHER_n`):

```
$ vercel metrics vercel.ai_traffic.count --all --since 7d --group-by projectId --group-by botName --group-by botCategory --group-by environment
prj_OTHER_1  amazonbot      ai_crawler    production  23
prj_OTHER_2  applebot       ai_crawler    production  23
prj_OTHER_1  oai-searchbot  ai_assistant  production  17
prj_OTHER_3  oai-searchbot  ai_assistant  production  11
…  (22 groups: amazonbot, applebot, gptbot, meta-externalagent, shapbot as ai_crawler; oai-searchbot, chatgpt-user, perplexitybot, gpt-actions as ai_assistant)

$ vercel metrics vercel.ai_traffic.assistant.count --all --since 7d --group-by botName --group-by requestPath --group-by httpStatus --group-by pathType
oai-searchbot  /robots.txt  200  static  45
oai-searchbot  /robots.txt  404  static   2
chatgpt-user   /            200  static   1
chatgpt-user   /setup/      200  static   1
perplexitybot  /episodes/openrouter/  200  static  1

$ vercel metrics vercel.ai_traffic.crawler.count  (same grouping, top rows)
applebot  /robots.txt          200  static  9
applebot  /robots.txt          404  static  7
gptbot    /sitemap-index.xml   200  static  7
gptbot    /sitemap.xml         200  static  7

$ vercel metrics vercel.ai_traffic.failed_requests.count  (same grouping)
applebot  /robots.txt  404  streaming_func  1

$ vercel metrics vercel.ai_traffic.markdown_requests.count  (same grouping)
(no rows)
```

Column names follow the usual pattern: `vercel_ai_traffic_crawler_count_count` and so on. `botName` values are the slugs from Vercel's verified bots directory; `pathType` is lower case (`static`, `streaming_func`), unlike `proxy.pathType` in the drain (`STATIC`, `streaming_func`).

`failed_requests` held 1 request while the crawler and assistant metrics showed at least 9 AI requests answered `404` from static files (`/robots.txt`: 7 `applebot`, 2 `oai-searchbot`). The one counted failure was a `404` from a function. So static 404s were not counted as failed requests (Observed, 7 days, team-wide). Vercel's docs don't define "failed".

The bot classification is visible on `vercel.request.count`. 2026-10-19 to 2026-10-26, grouped by `botName` and `botCategory` (Captured: `metrics-request-count-botname.json`):

| `botName` | `botCategory` | Requests |
| --- | --- | --- |
| (empty) | `unknown` | 239,066 |
| (empty) | (empty) | 64,596 |
| `checkly` | `monitor` | 1,152 |
| `googleother` | `search_engine_crawler` | 34 |
| `googlebot` | `search_engine_crawler` | 4 |

`unknown` is what Vercel assigns to non-browser clients it doesn't recognize (`curl`, `vercel-queue/v2beta`, `vercel-cron/1.0`, the lab's synthetic user agent); browsers get an empty category (Observed, grouped by `clientUserAgent` in `metrics-request-count-useragent-2026-10-20.json`).

### AI user agents that Vercel did not count

Three sets of requests in the lab carried AI bot user agents. None were classified (Observed with `vercel metrics vercel.request.count --filter "clientUserAgent …" --group-by botName --group-by botCategory --group-by botVerified`):

| Requests | User agent | Origin | `botName` / `botCategory` / `botVerified` | In `ai_traffic.*` |
| --- | --- | --- | --- | --- |
| 167 on 2026-10-20, 10:16:02–10:16:25 UTC, all via `lhr1` | `Mozilla/5.0 (compatible; MistralBot/1.0; +https://mistral.ai)` | ASN "Infraly, LLC" (hosting provider) | `''` / `unknown` / `''` | No |
| 1 on 2026-10-26 (lab test) | `… compatible; GPTBot/1.3; +https://openai.com/gptbot)` with `Accept: text/markdown`, sent with `curl` | Lab laptop | `''` / `unknown` / `''` | No |
| 1 on 2026-10-26 (lab test) | `Claude-User (claude-code/2.1.306; +https://support.anthropic.com/)` (a Claude Code web fetch) | Lab laptop | `''` / `unknown` / `''` | No |

(Captured: `metrics-request-mistralbot.json`, `metrics-firewall-mistralbot.json`, `metrics-request-test-user-agents.json`.)

The `MistralBot` requests were a scan, not a crawl: 121 asked for `/_next/static/*` chunks, the rest for `/.env`, `/.env.backup`, `/.env.staging`, `/config.yml`, `/api/v1/chat`, `/api/v1/completions`, `/api/debug`, `/api/auth/session` and similar, one each; another 46 were challenged by Vercel's platform DDoS mitigation (`/.claude/settings.json`, `/.cursor/mcp.json`, …; see the Firewall entry). `MistralBot` is not a name in Vercel's verified bots directory, which lists Mistral's bots as `mistralai-user` and `mistralai-index` (Documented). So Vercel's metric was right not to count it, and it would also not count a real AI bot it can't verify.

A recognized AI request on the lab project, which could be compared with its drain record, did not happen in 30 days (Not observed). The lab is not linked from anywhere crawlers look; the team's other projects that do get AI traffic have no drain into the lab backend.

### Log records

AI bot requests produce the same records as any other request (see Functions, CDN, Firewall). The only bot-specific field is the user agent. A `MistralBot` request for a missing static path (Captured: `log-mistralbot-static.json`):

```json
{ "source": "static", "level": "warning", "path": "404",
  "proxy": { "path": "/status", "statusCode": 404, "pathType": "STATIC", "vercelCache": "HIT", "region": "lhr1",
             "userAgent": ["Mozilla/5.0 (compatible; MistralBot/1.0; +https://mistral.ai)"],
             "clientIp": "203.0.113.10", "vercelId": "fx6r2-1792491384729-7135c7f3891d" },
  "ja4Digest": "t13d3112h1_e8f1e7e78f70_b26ce05bbdd6", "traceId": "6bf4e5f11a9982491ff947ff1ff7081e" }
```

| Field | Use for bot traffic | Note |
| --- | --- | --- |
| `proxy.userAgent` | The claimed bot | An array; one element in every record seen |
| `ja4Digest` | TLS fingerprint of the client | **Not in Vercel's published schema.** On 237 of 589 bot records (static and firewall records, not function records); the same digest for all `MistralBot` requests |
| `proxy.clientIp` | Client address | Lets you check the address against an operator's published ranges yourself |
| `proxy.statusCode`, `proxy.path`, `proxy.pathType` | What the bot got | |

Not in log records: `botName`, `botCategory`, `botVerified`, the `Accept` header, whether a request counted as a markdown request (Observed: 589 bot records, field union with `keys.py`).

Every page request in the lab runs Routing Middleware, which writes its own `source: lambda` record with `proxy.pathType: middleware`. One bot request therefore leaves two records (middleware plus static or function). The 167 `MistralBot` requests left 333 records: 169 `lambda` (middleware), 163 `static`, 1 `firewall` (Observed).

## 3. Extras beyond the default

| Extra | What it adds | Cost |
| --- | --- | --- |
| Observability Plus | Querying `vercel.ai_traffic.*` and the `botName`/`botCategory` dimensions, filtering CDN Requests by bot category, 30-day retention | $1.20 per 1M events (Documented). Data from before enabling Plus was queryable: `vercel.request.count` returned rows for 2026-10-19 on 2026-10-26 (Observed) |
| AI Bots managed ruleset (Firewall) | Since 2026-10-29, a separate action (`allow`, `log`, `deny`) for AI crawlers and for AI assistants, using the same categories as these metrics; Vercel updates the bot list. `vercel firewall rules update ai-bots --category ai-crawlers --action deny` (`edit` is an alias), then `vercel firewall publish`. Denied requests appear in `vercel.firewall_action.count` and, as for other denies, in the log drain as `source: firewall` (see the Firewall entry; for this ruleset Not observed). In the lab it is set to Allow (inactive) (Observed 2026-11-12, `vercel firewall rules inspect ai-bots`) | All plans (Documented) |
| Serving Markdown to agents (content negotiation, `.md` routes) | Something for `markdown_requests.count` to count | Your code |

## 4. Getting it out

| Signal | Exit path | Tested configuration |
| --- | --- | --- |
| AI request counts by user agent, path, status | Log drain: count records by `proxy.userAgent` | Drain `petclinic-agent-logs` (all sources). Matches `vercel.request.count` grouped by `clientUserAgent` for the same requests (below) |
| Vercel's classification (`botName`, `botCategory`, `botVerified`, crawler vs assistant) | None. Pull `vercel metrics vercel.ai_traffic.* --json` or `vercel.request.count --group-by botName` (Plus) on a schedule | |
| Markdown requests | None. The drain has no `Accept` header | |
| Challenged requests | None in the log drain; `vercel.firewall_action.count` only | 46 challenged `MistralBot` requests had no drain record (Observed) |

Drain against metric for the same requests (Observed):

| Requests | Log drain (records, excluding middleware lines) | `vercel.request.count` by `clientUserAgent` |
| --- | --- | --- |
| `MistralBot/1.0`, 2026-10-20 | 86 with `200`, 80 with `404`, plus 1 `source: firewall` deny (`403`) = 167 | 86 `200`, 80 `404`, 1 `403` = 167 |
| `GoogleOther`, 2026-10-19 to 26 | 34 | 34 (`googleother`) |
| `Googlebot`, 2026-10-19 to 26 | 4 | 4 (`googlebot`) |
| Lab tests (`GPTBot` spoof, `Claude-User`), 2026-10-26 | 1 and 1 | 1 and 1 |

The comparison with `vercel.ai_traffic.*` itself could not be made on the lab project: the metric had no rows while the drain held 169 requests with AI bot user agents, none of them recognized by Vercel. Bot classification on `vercel.request.count` and the drain's user agents did agree for the bots Vercel recognized (`googleother`, `googlebot`), which suggests a drain count of recognized AI bots would match too (Not observed).

## 5. In Bronto

| Data | Dataset | Field names |
| --- | --- | --- |
| Log drain | `petclinic-agent/vercel-logs` | `proxy.userAgent` is an array; its first element is `"proxy.userAgent.0"` |

Queries, each run against the lab's last 30 days on 2026-10-26:

| Question | Query | Group by | Result |
| --- | --- | --- | --- |
| Which bots reached the site, one row per request? | `("proxy.userAgent.0" LIKE '%Bot%' OR "proxy.userAgent.0" LIKE '%bot%' OR "proxy.userAgent.0" LIKE '%-User%' OR "proxy.userAgent.0" LIKE '%GoogleOther%') AND "proxy.pathType" != 'middleware'` | `"proxy.userAgent.0"` | `MistralBot/1.0` 166 · `GoogleOther` 34 · `Slack-ImgProxy` 8 · `Googlebot/2.1` 4 · `Slackbot 1.0` 4 · `Slackbot-LinkExpanding` 2 · `Claude-User` 1 · `GPTBot/1.3` 1 · `facebookexternalhit` 1 |
| What did one bot get? | `"proxy.userAgent.0" LIKE '%MistralBot%' AND "proxy.pathType" != 'middleware'` | `"proxy.statusCode"` | `200` 86 · `404` 80 |
| Which bot requests did the firewall deny? | `"proxy.userAgent.0" LIKE '%MistralBot%' AND source = 'firewall'` | `"proxy.wafRule"` | `rule_block_scanner_paths_jbLxqj` 1 (`/.env`) |
| Records per source for one bot | `"proxy.userAgent.0" LIKE '%MistralBot%'` | `source` | `lambda` 169 · `static` 163 · `firewall` 1 |

`"proxy.pathType" != 'middleware'` drops the middleware line of each request and also records without `pathType` (the firewall record), so add `source = 'firewall'` separately when counting denied requests. To match a list of AI bots, use the user agent tokens from Vercel's verified bots directory (`GPTBot`, `ClaudeBot`, `Claude-User`, `ChatGPT-User`, `OAI-SearchBot`, `PerplexityBot`, `Perplexity-User`, `MistralAI-User`, `CCBot`, `Amazonbot`, `Applebot`, `meta-externalagent` …) and add `proxy.clientIp` or `ja4Digest` to the group-by when you want to see who is behind a claimed name.

## Gotchas

1. **A user agent is a claim.** The drain shows 167 `MistralBot` requests that Vercel classified as `unknown` and kept out of AI traffic; they came from a hosting provider and probed for `.env` files and AI API routes. Counting AI traffic from the drain by user agent counts these too. Group by `ja4Digest` or `proxy.clientIp` to see whether a "bot" is one scanner (Captured: `log-mistralbot-static.json`, `metrics-firewall-mistralbot.json`).
2. **The metric is empty until a recognized bot visits.** `vercel.ai_traffic.*` returned `summary: []` for the lab project for 30 days, even with three AI user agents in the drain, while the same query with `--all` returned 140 requests on other projects. An empty result means no recognized AI bot, not missing access: without Plus the CLI answers `payment_required` instead (see Functions).
3. **Static 404s are not "failed requests".** Team-wide, 9 AI requests for a missing `/robots.txt` served as static 404s were not in `failed_requests.count`; one 404 from a function was (Observed). For "what did AI bots fail to get", group `crawler.count` and `assistant.count` by `httpStatus`.
4. **Most AI traffic is `robots.txt`.** 47 of 53 assistant requests team-wide were `oai-searchbot` fetching `/robots.txt` (Observed, 7 days).
5. **`MistralBot` is not Mistral's bot name on Vercel.** The directory lists `mistralai-user` and `mistralai-index`. Vercel's directory names (`botName` values) are lower-case slugs, not user agent strings (`googleother`, `googlebot`, `checkly`).
6. **One request, two records.** With Routing Middleware, every request writes a middleware record plus its static or function record, both with the bot's user agent. Exclude `proxy.pathType = 'middleware'` to count requests.
7. **Challenged bots leave no log record.** 46 of the `MistralBot` requests were challenged by platform DDoS mitigation and appear only in `vercel.firewall_action.count` (see the Firewall entry).
8. **Markdown requests can't be measured outside Vercel.** The drain doesn't carry the `Accept` header. If you serve Markdown on separate `.md` paths, count those paths in the drain instead.

## Samples

| File | What it shows |
| --- | --- |
| [`metrics-ai-traffic-count-14d.json`](../samples/ai-traffic/metrics-ai-traffic-count-14d.json) | `vercel.ai_traffic.count` by `botName`, `botCategory`: no rows |
| [`metrics-markdown-requests-14d.json`](../samples/ai-traffic/metrics-markdown-requests-14d.json) | `vercel.ai_traffic.markdown_requests.count`: no rows |
| [`metrics-team-ai-traffic-by-project-bot.json`](../samples/ai-traffic/metrics-team-ai-traffic-by-project-bot.json) | Team-wide `vercel.ai_traffic.count` by project, bot, category, environment (7 days) |
| [`metrics-team-crawler-by-path.json`](../samples/ai-traffic/metrics-team-crawler-by-path.json) | Team-wide `crawler.count` by bot, path, status, path type |
| [`metrics-team-assistant-by-path.json`](../samples/ai-traffic/metrics-team-assistant-by-path.json) | Team-wide `assistant.count` by bot, path, status, path type |
| [`metrics-team-failed-requests.json`](../samples/ai-traffic/metrics-team-failed-requests.json) | Team-wide `failed_requests.count`: one function 404 |
| [`metrics-team-markdown-requests.json`](../samples/ai-traffic/metrics-team-markdown-requests.json) | Team-wide `markdown_requests.count`: no rows |
| [`metrics-request-count-botname.json`](../samples/ai-traffic/metrics-request-count-botname.json) | `vercel.request.count` by `botName`, `botCategory`, 2026-10-19 to 26 |
| [`metrics-request-count-useragent-2026-10-20.json`](../samples/ai-traffic/metrics-request-count-useragent-2026-10-20.json) | `vercel.request.count` by user agent and bot fields for one day |
| [`metrics-request-mistralbot.json`](../samples/ai-traffic/metrics-request-mistralbot.json) | `MistralBot` requests by status and bot fields |
| [`metrics-firewall-mistralbot.json`](../samples/ai-traffic/metrics-firewall-mistralbot.json) | `MistralBot` firewall actions with `asnName` and bot fields |
| [`metrics-request-test-user-agents.json`](../samples/ai-traffic/metrics-request-test-user-agents.json) | The spoofed `GPTBot` and `Claude-User` test requests: `unknown` |
| [`log-mistralbot-static.json`](../samples/ai-traffic/log-mistralbot-static.json) | `source: static` 404 for a `MistralBot` request, with `ja4Digest` |
| [`log-mistralbot-middleware.json`](../samples/ai-traffic/log-mistralbot-middleware.json) | The middleware record of a `MistralBot` request (`source: lambda`) |
| [`log-mistralbot-firewall-deny.json`](../samples/ai-traffic/log-mistralbot-firewall-deny.json) | `source: firewall` deny of `MistralBot` asking for `/.env` |
| [`log-gptbot-spoof-test.json`](../samples/ai-traffic/log-gptbot-spoof-test.json) | Function record of the spoofed `GPTBot` test request |
| [`log-claude-user-test.json`](../samples/ai-traffic/log-claude-user-test.json) | Function record of the `Claude-User` test request |

## Sources

- Vercel docs, read 2026-10-26: [`vercel metrics`](https://vercel.com/docs/cli/metrics) (AI traffic section, last updated 2026-09-10), [Observability Insights](https://vercel.com/docs/observability/insights) (AI Traffic and CDN Requests tabs, 2026-08-11), [Bot Management](https://vercel.com/docs/bot-management) (verified bots directory, verification methods, AI bots ruleset, 2026-09-10).
- Vercel docs and changelog, read 2026-11-12: [AI traffic insights now available in Vercel Observability](https://vercel.com/changelog/ai-traffic-insights-now-available-in-vercel-observability) (2026-10-28), [Control AI crawlers and assistants separately in Vercel Firewall](https://vercel.com/changelog/block-ai-crawlers-and-assistants-independently-with-managed-rules) (2026-10-29), [WAF Managed Rulesets: AI Bots](https://vercel.com/docs/vercel-firewall/vercel-waf/managed-rulesets#configure-ai-bots-managed-ruleset), [Observability Insights](https://vercel.com/docs/observability/insights) (AI Traffic, unchanged since 2026-08-11).
- Lab: Vercel CLI 65.2.0 `vercel metrics` for `vercel.ai_traffic.*`, `vercel.request.count` and `vercel.firewall_action.count`, 2026-09-26 to 2026-10-26; Bronto EU dataset `petclinic-agent/vercel-logs`, 2026-09-26 to 2026-10-26; two test requests to `https://petclinic-agent.vercel.app/?catalog-test=…` on 2026-10-26 15:05 UTC.
