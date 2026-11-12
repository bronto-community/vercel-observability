# Firewall, WAF and rate limiting

> The Vercel Firewall writes one log drain record (`source: firewall`) for every request a custom rule denies, including rate-limit blocks, with the rule ID in `proxy.wafRule` and `proxy.errorCode: MITIGATION_DENY`. That is the only firewall data that leaves Vercel without code. Allowed traffic and challenges from Vercel's own DDoS mitigation produce no drain record; they exist only in the `vercel.firewall_action.count` metric (Observability Plus) and the Firewall tab. In the lab the drain and the metric agreed exactly on denies (512 and 512 over 7 days), and the metric also showed 75 challenges the drain never saw. The trap: a rate-limit block arrives as `wafAction: deny`, not `rate_limit`, so the rule ID is the only way to tell a rate limit from a block rule.

| | |
| --- | --- |
| Kind | Platform service (platform DDoS mitigation, WAF custom rules, managed rulesets, rate limiting) |
| Plans | Firewall and DDoS mitigation on all plans; drains need Pro or Enterprise; metric queries need Observability Plus; DDoS alerts on all plans (Documented) |
| Signals | Logs (denied requests) · Metrics (inside Vercel only) · Events (attack alerts by webhook) |
| Exit paths | Log drain (`source: firewall`) · Webhook (Attack Detected Firewall Event) · `vercel metrics` / `vercel firewall` CLI pulls |
| Verified | 2026-10-26 · Vercel CLI 65.2.0 · lab project `petclinic-agent` |
| Refreshed | 2026-11-12 · docs and changelog to 2026-11-12, no new captures · Vercel CLI 65.14.0 (`firewall rules --help`, `rules inspect ai-bots`, read-only) |

## 1. What it emits

| Signal | What | Where it lives | Retention |
| --- | --- | --- | --- |
| Logs | One record per request denied by a custom rule or rate limit | Firewall tab, Runtime Logs, log drain | Firewall tab looks back 1 h, 24 h or a live 10-minute window (Documented) |
| Metrics | `vercel.firewall_action.count`: every request the firewall evaluated, by action and rule, 37 dimensions | Firewall tab, Query, `vercel metrics` | As for other metrics: Pro 1 day, Plus 30 days (Documented) |
| Events | DDoS attack alert when mitigation sees more than 100,000 malicious requests in 10 minutes | Firewall tab › Alerts, `vercel firewall alerts list`, webhook "Attack Detected Firewall Event", Slack (`/vercel subscribe {team_id} firewall_attack`) | (Documented) |
| Metrics | `vercel.bot_id_check.count` (BotID) | Query, `vercel metrics` | See the BotID entry |

The lab's firewall configuration (Captured: `cli-firewall-rules.json`): two custom rules, `rule_block_scanner_paths_jbLxqj` (deny `/.env`, `/wp-login.php`, `/.git/config`, `/xmlrpc.php`) and `rule_rate_limit_new_chats_vbkYGF` (rate limit, fixed window, 20 `POST /eve/v1/session` per IP per 60 s, then deny). Bot Protection off, AI Bots allow (unchanged on 2026-11-12, Observed), OWASP off, BotID `basic`. A synthetic cron job requested a scanner path in about 1 run in 10 (user agent `sqlmap/1.8`) until 2026-10-23 22:00 UTC; the rate limit was hit once on purpose with `curl` (6 requests over the limit, 2026-10-20 ~08:59 UTC).

## 2. Out-of-the-box shape

### Log records

Fields on all 512 `source: firewall` records in the lab (2026-10-20 to 2026-10-23, Captured: `log-deny-custom-rule.json`, `log-deny-rate-limit.json`):

| Field | Example | Note |
| --- | --- | --- |
| `id`, `timestamp` | `1792792714586` | |
| `source` | `firewall` | |
| `level` | `warning` | All 512 records |
| `message` | `MITIGATION_DENY: You don't have the required permissions` | Same text for block and rate-limit denies |
| `statusCode`, `proxy.statusCode` | `403` | |
| `proxy.wafAction` | `deny` | Also for the rate-limit rule (see Gotchas) |
| `proxy.wafRule` | `rule_rate_limit_new_chats_vbkYGF` | **Vercel's schema calls this field `proxy.wafRuleId`; the delivered field is `proxy.wafRule`.** No record had `proxy.wafRuleId` |
| `proxy.errorCode` | `MITIGATION_DENY` | **Not in Vercel's published schema** |
| `requestId`, `proxy.vercelId` | `qh58w-1792792714580-c6c8851be4e1` | Equal |
| `path`, `proxy.path` | `/.env` | Both the URL path here; no route pattern, the request never reached a function |
| `proxy.method`, `proxy.host`, `proxy.scheme`, `proxy.timestamp`, `proxy.userAgent`, `proxy.clientIp` | | `proxy.userAgent` is an array |
| `proxy.region` | `dub1` | Edge region that denied the request |
| `executionRegion` | `iad1:dub1`, `fra1` | 480 of 512 records had a two-region value like `iad1:dub1`; nothing executed |
| `ja4Digest` | `t13d5213h1_b262b3658495_66863fb0a24c` | TLS fingerprint; `ja3Digest` never appeared |
| `traceId`, `spanId` | `e17d4ff9e76d2ae61b32fb35fc676a3c` | Present on every record, but no span with that trace ID reached the trace drain (see Gotchas) |
| `deploymentId`, `environment`, `branch`, `host`, `projectId`, `projectName` | | `branch` missing on 3 of 500 sampled block records |

Absent: `type`, `proxy.vercelCache`, `proxy.pathType`, `proxy.responseByteSize`, the rule name or description. The record carries the rule ID only; the name (`Block scanner paths`) comes from `vercel firewall rules list --json`.

### Which actions produce a record

Over the same 7 days (2026-10-19 08:00 to 2026-10-26 12:00 UTC), drain against metric (Observed):

| Action and rule | `vercel.firewall_action.count` | Log drain records |
| --- | --- | --- |
| `deny`, `rule_block_scanner_paths_jbLxqj` | 506 | 506 |
| `deny`, `rule_rate_limit_new_chats_vbkYGF` | 6 | 6 |
| `challenge`, `sys_dos_mitigation` (Vercel's platform DDoS mitigation) | 75 | 0 |
| `allow`, no rule | 298,695 | 0 (these requests appear under their own sources: `lambda`, `static` and so on) |

The 75 challenges came from outside the lab, all on 2026-10-20 08:00–12:00 UTC through `lhr1`: AI-endpoint probes (`/api/chat`, `/v1/chat/completions`, `/run/predict`, …) with user agent `Mozilla/5.0`, and `MistralBot/1.0` asking for `/.claude/settings.json` and `/.cursor/mcp.json` (Captured: `metrics-system-challenge.json`). None of them produced a `source: firewall` record.

Not observed: `log`, `challenge` and `bypass` actions from custom rules, `redirect`, persistent actions, managed rulesets (Bot Protection, AI Bots, OWASP) blocking anything, Attack Challenge Mode. The docs describe `source: firewall` as "requests denied by Vercel Firewall rules", so `log` and `challenge` from custom rules are not expected in the drain (Documented, not tested).

### Metric

`vercel.firewall_action.count`, aggregation `count` or `unique`. Dimensions include `wafAction`, `action`, `wafRuleId`, `rule`, `ruleCategory`, `eventType`, `requestPath`, `route`, `statusCode`, `clientIp`, `clientIpCountry`, `asnName`, `ja4`, `clientJa4Digest`, `userAgent`, `botName`, `verifiedBot`, `botCategory`, `edgeRegion` and `connectionId` (full list in [`reference/vercel-metrics-schema.json`](../reference/vercel-metrics-schema.json)).

```
$ vercel metrics vercel.firewall_action.count --group-by wafAction --since 7d --json
allow 298,695 · deny 512 · challenge 75

$ vercel metrics vercel.firewall_action.count --group-by wafRuleId --since 7d --json
"" 298,695 · rule_block_scanner_paths_jbLxqj 506 · sys_dos_mitigation 75 · rule_rate_limit_new_chats_vbkYGF 6

$ vercel metrics vercel.firewall_action.count --group-by eventType --since 7d --json
httpResponse 299,211 · httpRequest 75
```

The challenges are the `httpRequest` events; everything else is `httpResponse` (Captured: `metrics-by-*.json`). `--filter "wafAction = 'challenge'"` returned no rows; `--filter "wafRuleId eq 'sys_dos_mitigation'"` worked (Observed, CLI 65.2.0).

### Attack alerts

None in the lab: `vercel firewall alerts list` and `vercel firewall overview` showed no alerts and "Attacks mitigated 0" for 2026-10-25/26 (Observed). The alert threshold (100,000 malicious requests in 10 minutes), the webhook event "Attack Detected Firewall Event" and the Slack subscription are Documented only; its webhook payload is Not observed.

## 3. Extras beyond the default

| Extra | What it adds | Cost |
| --- | --- | --- |
| Custom rules (deny, rate limit) | A drain record per denied request, keyed by rule ID | See Vercel's Firewall pricing |
| AI Bots managed ruleset | Since 2026-10-29, separate actions for AI crawlers and AI assistants (`allow`, `log`, `deny` each), from Vercel's verified bot categories. CLI: `vercel firewall rules update ai-bots --category <ai-crawlers or ai-assistants> --action …`, then `vercel firewall publish`. A `deny` should add `source: firewall` drain records like other denies; `log` is not expected in the drain (Documented; Not observed for this ruleset). Category counts are in the AI traffic metrics (see [AI traffic](ai-traffic.md)) | All plans (Documented) |
| Observability Plus | Querying `vercel.firewall_action.count`: allowed traffic, challenges, platform mitigations, bot classification, ASN and country | $1.20 per 1M events (Documented) |
| `vercel firewall` CLI (`overview`, `traffic`, `alerts`, `rules list --json`) | Read the last day of firewall activity and the rule definitions from scripts | None |
| Webhook "Attack Detected Firewall Event" | A push event when DDoS mitigation fires | None (Documented) |

## 4. Getting it out

| Signal | Exit path | Tested configuration |
| --- | --- | --- |
| Denied requests | Log drain, schema `log` v1 | Drain `petclinic-agent-logs`, no source filter (see the Functions entry). A drain filtered to `source eq 'firewall'` delivered only firewall records (lab test, 2026-10) |
| Rule names | `vercel firewall rules list --json` or the REST API; join on rule ID | Read-only CLI call, output in `cli-firewall-rules.json` |
| Allowed, challenged, platform-mitigated traffic | None. Pull `vercel metrics vercel.firewall_action.count --json` (Plus) on a schedule and send the result on | |
| DDoS alerts | Account webhook with the Attack Detected Firewall Event | Not configured in the lab (Not observed) |
| BotID verdicts | None (`vercel.bot_id_check.count` metric only) | The lab app doesn't call `checkBotId()`; the metric returned no rows for 7 days (Not observed) |

Delivery delay: from the record's `timestamp` to ingestion in the backend, the 506 block records took median 5.6 s, p95 9.2 s, max 22.4 s. The 6 rate-limit records took 15.6 to 18.1 s (Observed). An earlier lab note described rate-limit records arriving "minutes" after the request; this re-measurement on the same 6 records shows seconds, about three times the delay of the block records.

## 5. In Bronto

| Data | Dataset | Field names |
| --- | --- | --- |
| Firewall records | `petclinic-agent/vercel-logs` (log drain, all sources) | `source`, `level`, `ja4Digest`; nested fields in double quotes: `"proxy.wafRule"`, `"proxy.wafAction"`, `"proxy.errorCode"`, `"proxy.clientIp"` |

Queries, each run against the lab's last 7 days on 2026-10-26:

| Question | Query | Group by | Result |
| --- | --- | --- | --- |
| Denies per rule | `source = 'firewall'` | `proxy.wafRule` | `rule_block_scanner_paths_jbLxqj` 506 · `rule_rate_limit_new_chats_vbkYGF` 6 |
| Rate-limit hits | `source = 'firewall' AND "proxy.wafRule" LIKE 'rule_rate_limit%'` | `proxy.path`, `proxy.region` | `/eve/v1/session`, `fra1` 6 |
| Denied clients by TLS fingerprint | `source = 'firewall'` | `ja4Digest` | top fingerprint 466 · second 37 · third 7 |
| Denied clients by IP | `source = 'firewall'` | `proxy.clientIp` | 79 distinct IPs (mostly the synthetic job's outbound addresses) |
| Which paths are being probed | `source = 'firewall'` | `proxy.path` | `/.env` 150 · `/wp-login.php` 127 · `/.git/config` 127 · `/xmlrpc.php` 102 · `/eve/v1/session` 6 |

Rule IDs end in a random suffix (`_jbLxqj`); name rules with a common prefix (`rule_rate_limit_…`) so one `LIKE` covers a class of rules.

Templates: the "Vercel Overview" dashboard has "Firewall Actions" and "Top Denied Clients" on the log drain dataset; the monitor template "Firewall Deny Spike" counts `source = 'firewall'`.

## Gotchas

1. **Rate limits arrive as `deny`.** The rule's action is `rate_limit` in its definition, and Vercel's schema lists `rate_limit` as a `proxy.wafAction` value, but all 6 rate-limited requests arrived with `proxy.wafAction: deny`, `proxy.errorCode: MITIGATION_DENY` and the same message as a block rule. Only `proxy.wafRule` tells them apart (Captured: `log-deny-rate-limit.json`).
2. **The field is `proxy.wafRule`, not `proxy.wafRuleId`.** Queries and parsers written from the schema find nothing (Observed, 512 of 512 records). The metric dimension, by contrast, is `wafRuleId`.
3. **Platform DDoS challenges never reach the drain.** 75 requests challenged by `sys_dos_mitigation` appear in `vercel.firewall_action.count` and nowhere in the log drain. Counting firewall activity from the drain counts custom-rule denies only (Observed).
4. **Denied requests have a trace ID and no trace.** Every firewall record carries `traceId`/`spanId`, but the trace drain delivered no span for any of them, and no edge span with status 403 at all in 7 days (Observed). Don't build a "jump to trace" link for firewall records.
5. **`executionRegion` holds two regions.** 480 of 512 records had values like `iad1:dub1`, although no code ran. Use `proxy.region` for where the request was stopped (Observed).
6. **Rate limits count per region.** A limit of 20 per minute per IP can let through up to 20 per region the client reaches (Documented: "Rate limit counters are tracked on a per-region basis", [Rate limiting](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting), read 2026-11-12). The lab test used one region (`fra1`).

## Samples

| File | What it shows |
| --- | --- |
| [`log-deny-custom-rule.json`](../samples/firewall/log-deny-custom-rule.json) | A request to `/.env` denied by a custom path rule |
| [`log-deny-rate-limit.json`](../samples/firewall/log-deny-rate-limit.json) | A request over the rate limit: `wafAction: deny`, rule ID `rule_rate_limit_…` |
| [`cli-firewall-rules.json`](../samples/firewall/cli-firewall-rules.json) | `vercel firewall rules list --json`: both rule definitions and the managed rulesets |
| [`metrics-by-wafAction.json`](../samples/firewall/metrics-by-wafAction.json) | Firewall actions by `wafAction`, 7 days |
| [`metrics-by-wafRuleId.json`](../samples/firewall/metrics-by-wafRuleId.json) | Firewall actions by rule, including `sys_dos_mitigation` |
| [`metrics-by-eventType.json`](../samples/firewall/metrics-by-eventType.json) | `httpRequest` against `httpResponse` events |
| [`metrics-system-challenge.json`](../samples/firewall/metrics-system-challenge.json) | The 75 platform challenges by path, user agent and edge region |

## Sources

- Vercel docs, read 2026-10-26: [Log Drains reference](https://vercel.com/docs/drains/reference/logs) (last updated 2026-09-11), [Firewall Observability](https://vercel.com/docs/vercel-firewall/firewall-observability) (last updated 2026-09-10), [Webhooks API](https://vercel.com/docs/webhooks/webhooks-api).
- Lab: Bronto EU dataset `petclinic-agent/vercel-logs`, 2026-10-19 to 2026-10-26; trace drain dataset `.traces/vercel-traces`; Vercel CLI 65.2.0 (`vercel metrics`, `vercel firewall status|overview|alerts list|rules list`); synthetic traffic in `apps/web/app/api/synthetic/route.ts`.
- Vercel docs and changelog, read 2026-11-12: [WAF Managed Rulesets: AI Bots](https://vercel.com/docs/vercel-firewall/vercel-waf/managed-rulesets#configure-ai-bots-managed-ruleset), [Control AI crawlers and assistants separately in Vercel Firewall](https://vercel.com/changelog/block-ai-crawlers-and-assistants-independently-with-managed-rules) (2026-10-29), [Rate limiting](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting).
