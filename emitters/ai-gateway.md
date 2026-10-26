# AI Gateway

> Every AI Gateway request produces a four-span OpenTelemetry trace (request, routing, model attempt, provider attempt) with token counts, time to first token, cost as a decimal string, credential type and the provider's own request ID. It leaves Vercel only through an AI Gateway trace drain, a separate drain type (`ai_gateway` schema, version `otelv1`) that a normal trace drain doesn't replace. Vercel's `vercel.ai_gateway.request.*` metrics (Observability Plus) and the drain agreed exactly in the lab: 542 requests and $0.1558 on 2026-10-22 in both. No prompt or completion text is included. The traps: the provider-attempt spans carry timestamps several seconds after the request has ended, requests made from the same function invocation share their trace and span IDs, and whether a gateway trace joins the caller's trace depends on the client library. The key that always joins is the generation ID.

| | |
| --- | --- |
| Kind | Platform service |
| Plans | Traces in the dashboard (Logs, Overview) on all plans; trace drains on Pro and Enterprise; metrics queries need Observability Plus |
| Signals | Traces · Metrics (inside Vercel only) · Generation lookup API |
| Exit paths | AI Gateway trace drain · REST API (generation lookup, Custom Reporting) |
| Verified | 2026-10-26 · Vercel CLI 65.2.0 · lab project `petclinic-agent` · data 2026-10-19 to 2026-10-23 (the lab's model traffic stopped 2026-10-23 22:00 UTC) |

## 1. What it emits

| Signal | What | Where it lives | Retention |
| --- | --- | --- | --- |
| Traces | One trace per request: `<operation> <model>` root, `vercel.ai_gateway.routing`, one `vercel.ai_gateway.model_attempt <model>` per model in the fallback chain, one `<model> (<provider>)` per upstream call | AI Gateway › Logs (per request, with a "Routed to" card per attempt), AI Gateway trace drain | Routing details 30 days, list 36 days (Documented) |
| Metrics | `vercel.ai_gateway.request.*`: 32 metrics, among them `count`, `cost`, `input_tokens`, `output_tokens`, `cached_input_tokens`, `time_to_first_token_ms`, `request_duration_ms` | AI Gateway › Overview, `vercel metrics` | As other Observability metrics (Documented) |
| Generation record | Cost, latency, tokens and finish reason per generation ID | `GET https://ai-gateway.vercel.sh/v1/generation?id=…`, `gateway.getGenerationInfo()` in the AI SDK | Not documented |

The metric catalog is in [`reference/vercel-metrics-schema.json`](../reference/vercel-metrics-schema.json). Every `ai_gateway.request` metric has 63 dimensions, among them `aiModel`, `aiProvider`, `isByok`, `appName`, `httpStatus`, `generationId`, `sessionId`, `evaluationFallbackTriggered` and `routerAttempts`.

## 2. Out-of-the-box shape

### Spans

An eve agent's model call through the gateway (Captured: `trace-gateway-request.ndjson`):

```
chat anthropic/claude-haiku-5.5                      SERVER    1.44 s
└─ vercel.ai_gateway.routing                         INTERNAL  72 ms
   └─ vercel.ai_gateway.model_attempt anthropic/…    INTERNAL  0 ms
      └─ anthropic/claude-haiku-5.5 (anthropic)      CLIENT    1.12 s
```

Resource attributes: `service.name: ai-gateway`, `service.namespace: vercel`. Status is `STATUS_CODE_OK` on every span seen.

**Root span** (Captured: `span-root-chat.json`):

| Attribute | Example | Note |
| --- | --- | --- |
| `gen_ai.operation.name` | `chat` | |
| `gen_ai.provider.name` | `anthropic`, `gcp.gen_ai`, `gcp.vertex_ai` | OTel well-known values |
| `gen_ai.request.model` | `anthropic/claude-haiku-5.5` | On a fallback this is the model that served, see Gotchas |
| `gen_ai.response.model` | `anthropic/claude-haiku-5.5` | Gateway slug |
| `gen_ai.response.finish_reasons.0` | `stop`, `tool-calls` | |
| `gen_ai.request.stream` | `true` | |
| `gen_ai.response.time_to_first_chunk` | `0.706` | Seconds |
| `gen_ai.usage.input_tokens`, `output_tokens`, `reasoning.output_tokens`, `cache_creation.input_tokens`, `cache_read.input_tokens` | `2`, `95`, `0`, `305`, `7816` | `input_tokens` excludes cached tokens |
| `http.response.status_code` | `200` | |
| `session.id` | `wrun_41M5NCENVJ3GVQ3AKCDDEW3YZD` | **Not in Vercel's published list.** eve's run ID for eve calls; a hex fingerprint for plain AI SDK calls |
| `vercel.ai_gateway.request.id` | `dub1::68cqk-1792792818602-2651b596f0b8` | For calls from a Vercel function, the **caller's** Vercel request ID; `gw_<uuid>` otherwise |
| `vercel.ai_gateway.generation.id` | `gen_01M5NCF1293DE8W7EX0B31D1ZK` | Unique per request; the join key |
| `vercel.ai_gateway.cost.total`, `cost.market` | `0.000163985` | Decimal strings, USD |
| `vercel.ai_gateway.cost.currency`, `cost.market_currency` | `USD` | |
| `vercel.ai_gateway.credential.type` | `system`, `byok` | |
| `vercel.ai_gateway.byok.credential.id` | `request-scoped-anthropic-0` | BYOK only |
| `vercel.ai_gateway.api_format` | `ai-sdk`, `anthropic-compat` | |
| `vercel.ai_gateway.provider` | `anthropic`, `vertexAnthropic`, `google` | Gateway provider slug |
| `vercel.ai_gateway.region` | `cdg1`, `iad1`, `fra1` | Where the gateway ran; not the caller's region (`dub1`) |
| `vercel.ai_gateway.environment` | `production`, `development` | |
| `vercel.ai_gateway.referring_site.name`, `.url` | `petclinic-agent` | Set by eve; absent on plain AI SDK calls |
| `vercel.ai_gateway.zdr.requested` | `false` | |
| `vercel.project.id`, `vercel.deployment.id` | | Span attributes with dots, unlike `vercel.projectId` on the platform trace drain |

Not seen in the lab, though documented: `vercel.ai_gateway.api_key.*`, `.service_tier`, `.tags`, `.user.id` (the lab sends no tags or user, which Custom Reporting bills per write).

**Routing span**: `vercel.ai_gateway.vmc.used = false`, nothing else in the lab (Captured: `span-routing.json`).

**Model attempt span**: `gen_ai.request.model`, `vercel.ai_gateway.model_attempt.index`, `.total`, `.is_last`, `.success`, `.provider_attempt_count`. Always zero duration (Captured: `span-model-attempt.json`).

**Provider attempt span** (Captured: `span-provider-attempt.json`): `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.response.model`, `http.response.status_code`, `vercel.ai_gateway.attempt.id` (`<generation id>:<model index>:<attempt>`), `.number`, `.total_in_request`, `.total_in_model_attempt`, `.is_final`, `.success`, `.provider_request_id` (`req_011CgKvN8qhVTxUPb6tGpQeC`), `.provider_response_id` (`msg_011CgKvN9AofEBQn1NbyuoT7`), `.credential.type`, `.provider`, `.region`.

What the lab sent through the gateway, 2026-10-19 to 2026-10-23 (Observed, root spans):

| Caller | `api_format` | Credential | Requests |
| --- | --- | --- | --- |
| eve agent (`referring_site.name = petclinic-agent`) | `ai-sdk` | system | 5,517 |
| eve triage subagent (`triage`) | `ai-sdk` | system | 14 |
| durable-harness ops agent (Anthropic Messages format) | `anthropic-compat` | system | 125 |
| AI SDK `generateText` in a Next.js route | `ai-sdk` | 57 BYOK, rest system | 76 |

### Fallbacks

With `providerOptions.gateway.models: ['google/gemini-3.8-flash']` and the primary's provider excluded (`only: ['google']`), three requests on 2026-10-22 (from a local `eve dev` run, `environment: development`) were served by the fallback (Captured: `span-root-fallback.json`, `span-model-attempt-fallback.json`):

- the root says `gen_ai.request.model = google/gemini-3.8-flash`, `gen_ai.provider.name = gcp.gen_ai`;
- the only model-attempt span has `model_attempt.index = 1`, `model_attempt.total = 2`; there is no span for index 0, because the filter removed the primary before any call;
- cost was $0.00315 for 4,116 input tokens, about 10 times a Haiku call of that size.

No production request fell back or had a failed provider attempt in the period (`attempt.success = false`: 0, Observed). One request was routed to `vertexAnthropic` for the same Haiku model on its first attempt; the provider span shows it (`anthropic/claude-haiku-5.5 (vertexAnthropic)`, `gen_ai.provider.name = gcp.vertex_ai`).

### BYOK

With request-scoped BYOK, `credential.type = byok`, `cost.total = 0` and `cost.market` holds the provider's list price ($0.0000945 for 375 in, 114 out). Over the period: 57 BYOK requests, $0 billed, $0.0061 at market price (Captured: `span-root-byok.json`; Observed).

### Metrics

Output of `vercel metrics … --json` for 2026-10-22 (Captured: `metrics-*.json`), next to the drain's numbers for the same day (Observed):

```
$ vercel metrics vercel.ai_gateway.request.count --group-by appName --group-by isByok
petclinic-agent/not-byok 447 · (none)/not-byok 77 · (none)/byok 13 · triage/not-byok 5      = 542
   drain: 542 root spans

$ vercel metrics vercel.ai_gateway.request.cost --group-by appName --group-by isByok
petclinic-agent $0.142297 · (none) $0.010563 · triage $0.002981 · byok $0              = $0.155841
   drain: sum(cost.total) = $0.155842

$ vercel metrics vercel.ai_gateway.request.time_to_first_token_ms --aggregation p75 --group-by aiProvider
anthropic 967.9 ms · google 3,745 ms · vertex 1,235 ms

$ vercel metrics vercel.ai_gateway.request.count --group-by evaluationFallbackTriggered --group-by routerAttempts
unknown / [] 542
```

`appName` is the drain's `referring_site.name`. The three Gemini fallbacks appear under `aiModel = google/gemini-3.8-flash` with nothing marking them as fallbacks: `evaluationFallbackTriggered` is `unknown` for all 542 requests.

### Generation lookup

`GET /v1/generation?id=<generation id>` with an AI Gateway API key or OIDC token returns cost, latency, tokens and finish reason (Documented). The lab used `gateway.getGenerationInfo()` on 2026-10-22 to confirm which model served a fallback request (Observed then); it wasn't called again for this entry because the lab's local OIDC token had expired and creating a key is a change to the team.

## 3. Extras beyond the default

| Extra | What it adds | Cost |
| --- | --- | --- |
| AI Gateway trace drain | The spans in section 2, to any OTLP/HTTP endpoint | $0.05 per 1,000 traces plus $0.50 per GB, no Pro allowance; one trace event per request per drain, fallbacks included (Documented) |
| Observability Plus | Querying `vercel.ai_gateway.request.*` with any dimension | $1.20 per 1M events (Documented) |
| `providerOptions.gateway.user` / `tags` | `vercel.ai_gateway.user.id`, `vercel.ai_gateway.tags` on the root span, Custom Reporting dimensions | $0.075 per 1,000 writes (Documented); not used in the lab |
| Request-scoped BYOK (`providerOptions.gateway.byok`) | `credential.type = byok`, `byok.credential.id`; with Anthropic, the call runs in your Anthropic organization and Anthropic's own spans become available (below) | Provider bills you directly |
| Trace context from the caller | The gateway's root span becomes a child of the caller's span (see section 4) | None |

### Anthropic's server-side spans

Anthropic exports its own spans for Claude API requests to an OTLP/HTTP endpoint an organization admin sets (Console › Settings › Telemetry destinations, public beta since 2026-10-13, Documented). Through the gateway this applies only to BYOK requests, since system-credential requests run in Vercel's Anthropic organization.

The span `anthropic.messages.create` (`service.name: claude-platform`) carries `anthropic.request.id`, the model, token usage, `anthropic.response.service_tier`, cache-write detail by TTL, and, unlike the gateway, the prompt, system instructions and output (`gen_ai.input.messages`, `gen_ai.output.messages`) (Captured: `span-claude-platform-messages-create.json`).

The gateway doesn't pass a `traceparent` upstream, so this span is the root of its own trace. All 57 BYOK requests matched an Anthropic span on `anthropic.request.id` = the gateway's `vercel.ai_gateway.attempt.provider_request_id`, and all 57 Anthropic spans had no parent (Observed). Join by request ID.

## 4. Getting it out

| Signal | Exit path | Tested configuration |
| --- | --- | --- |
| Gateway traces | AI Gateway trace drain: schema `ai_gateway`, version `otelv1`, delivery `otlphttp`, encoding `proto` | Drain "Pet Clinic AI Gateway Drain", one project, created in the dashboard |
| Gateway traces | A `trace` drain | Delivers none of them (research D6, 2026-10-20) |
| Metrics | None. Pull with `vercel metrics --json` (Plus) | |
| Per-request cost from your code | `providerMetadata.gateway.cost` / `generationId` in the AI SDK response (see the AI SDK entry) | |
| Generation records | `GET /v1/generation` | Documented |
| Anthropic's spans | Anthropic Console telemetry destination, BYOK only | Destination to the same OTLP endpoint |

The drain as the Vercel API returns it (`GET /v1/drains`, secret removed; Captured: `drain-config.json`):

```json
{ "name": "Pet Clinic AI Gateway Drain",
  "projectIds": ["prj_b3WTvq01Qtd6lK3zThoF2COD7prM"],
  "schemas": { "ai_gateway": { "version": "otelv1" } },
  "sampling": [],
  "delivery": { "type": "otlphttp", "endpoint": { "traces": "<your endpoint>/v1/traces" }, "encoding": "proto" } }
```

Vercel's REST API reference lists the drain schemas `log`, `trace`, `analytics`, `speed_insights`, `audit_log` and `connect`, not `ai_gateway` (research D6). The dashboard creates the drain; whether `POST /v1/drains` accepts this schema is Not observed.

### Joining the caller's trace

The gateway continues an incoming W3C trace context: its root span becomes a child of the caller's HTTP client span. Whether the context arrives depends on the client (Observed, root spans 2026-10-22 and 23):

| Caller and instrumentation | Root spans with a parent | Parent found in the caller's data |
| --- | --- | --- |
| AI SDK in Next.js, `@vercel/otel` with `propagateContextUrls: ["https://ai-gateway.vercel.sh"]` | 57 of 57 (BYOK route) | 54 of 57, the `fetch POST https://ai-gateway.vercel.sh/v4/ai/language-model` span |
| durable-harness in Next.js, same `@vercel/otel` setup | 124 of 125 | Yes, but in the Next.js request trace, not the agent's trace (see the Agent Runs entry) |
| eve 0.81.0 with `@opentelemetry/instrumentation-undici` | 57 of 914 | No; those 57 parents are in no dataset |

eve's documentation says gateway-routed model calls propagate the trace context; in the lab, 94% of eve's gateway requests started their own trace. A full chain that does join, from the eve agent through a Next.js route to the gateway, is in `samples/agent-runs/trace-eve-turn-booking.ndjson`.

Keys that join in every case (Observed):

| Gateway attribute | Equals |
| --- | --- |
| `vercel.ai_gateway.generation.id` | eve `agent.step` `gen_ai.generation.id`; durable-harness `chat` `gen_ai.response.id`; AI SDK `providerMetadata.gateway.generationId` |
| `vercel.ai_gateway.attempt.provider_response_id` | eve `chat` `gen_ai.response.id` |
| `vercel.ai_gateway.attempt.provider_request_id` | Anthropic `anthropic.request.id` |
| `session.id` | eve `agent.run.id` / `gen_ai.conversation.id` |

## 5. In Bronto

| Data | Dataset | Field names |
| --- | --- | --- |
| AI Gateway trace drain | `.traces/ai-gateway` | `$` prefix: `"$vercel.ai_gateway.cost.total"`, `"$gen_ai.response.model"`, `"$span.kind"` |
| Anthropic's spans | `.traces/claude-platform` | `"$anthropic.request.id"` |

Queries over the lab's last 7 days, run 2026-10-26 (traffic 2026-10-19 to 2026-10-23):

| Question | Query | Select / group by | Result |
| --- | --- | --- | --- |
| Spend by served model and credential | `"$span.kind" = 'SPAN_KIND_SERVER' AND "$vercel.ai_gateway.generation.id" != 'test-generation-id'` | `sum("$vercel.ai_gateway.cost.total")` by `"$gen_ai.response.model"`, `"$vercel.ai_gateway.credential.type"` | Haiku/system $1.1256 (5,672) · Gemini/system $0.0070 (3) · Haiku/byok $0 (57) |
| BYOK spend at list price | same | `sum("$vercel.ai_gateway.cost.market")` by credential type | byok $0.0061 |
| Requests by caller | same | `count()` by `"$vercel.ai_gateway.api_format"`, `"$vercel.ai_gateway.referring_site.name"` | ai-sdk/petclinic-agent 5,517 · anthropic-compat 125 · ai-sdk (none) 76 · ai-sdk/triage 14 |
| Time to first token | `"$span.kind" = 'SPAN_KIND_SERVER'` | `p95("$gen_ai.response.time_to_first_chunk")` by `"$vercel.ai_gateway.provider"` | anthropic 1.22 s · google 3.75 s · vertexAnthropic 1.24 s |
| Fallbacks | `"$vercel.ai_gateway.model_attempt.index" > 0` | `count()` by `"$gen_ai.request.model"` | google/gemini-3.8-flash 3 |
| Failed provider attempts | `"$vercel.ai_gateway.attempt.success" = false` | `count()` by `"$vercel.ai_gateway.provider"` | none |
| Errors returned to callers | `"$span.kind" = 'SPAN_KIND_SERVER' AND "$http.response.status_code" != 200` | `count()` | none |
| Anthropic span for a gateway request | `"$anthropic.request.id" = '<provider_request_id>'` on `.traces/claude-platform` | | 57 of 57 BYOK requests matched |

`cost.total` and `cost.market` are strings in the payload; `sum()` adds them as numbers.

## Gotchas

1. **Provider-attempt timestamps are late.** On 2026-10-23, all 336 provider-attempt spans started after their request's root span had ended: median 6.9 s later, range 1.7 to 19.3 s. The model-attempt span sits at the provider span's end with zero duration. Durations are right; positions are not. Anthropic's own span and the AI SDK's `providerMetadata` put one call at 20.35–22.53 s past the minute; the gateway's provider span says 29.65–31.83 s (Captured: `trace-shared-span-ids.ndjson`, `span-provider-attempt-byok.json`). Use the root span for timing.
2. **Requests from one invocation share span IDs.** `vercel.ai_gateway.request.id` is the caller's Vercel request ID, and requests that share it also share the root, routing and model-attempt span IDs. On 2026-10-23, 336 requests had 212 distinct root span IDs; one eve invocation made five. A trace view keyed on span ID merges them. Count requests and join on `vercel.ai_gateway.generation.id` (Captured: `trace-shared-span-ids.ndjson`).
3. **`gen_ai.request.model` shows the fallback.** Vercel's docs describe it as the model the client requested; on the three fallback requests it was the fallback model, and no span names the primary that was skipped. Detect fallbacks with `model_attempt.index > 0` (Captured: `span-root-fallback.json`). eve's `chat` span for the same call names the primary instead (see the Agent Runs entry).
4. **The drain's test event is in your data.** Creating the drain sent two `chat gpt-4o-2024-08-06` traces with `generation.id = test-generation-id`, `vercel.project.id = test-project-id` and a cost of $0.00384 each. Exclude them from spend (Captured: `span-drain-test-event.json`).
5. **A `trace` drain doesn't carry gateway traces.** It needs its own drain with the `ai_gateway` schema, billed per trace on top of drain volume.
6. **BYOK cost is zero.** `cost.total = 0` on BYOK requests; the provider's price is in `cost.market`. Spend dashboards on `cost.total` alone undercount BYOK traffic.
7. **The metrics don't flag fallbacks.** `vercel.ai_gateway.request.*` grouped by `aiModel` lists a fallback as an ordinary request to the fallback model; `evaluationFallbackTriggered` stayed `unknown` (Observed).

## Samples

| File | What it shows |
| --- | --- |
| [`span-root-chat.json`](../samples/ai-gateway/span-root-chat.json) | Root span of an eve model call: tokens, TTFT, cost, `session.id` |
| [`span-routing.json`](../samples/ai-gateway/span-routing.json) | Routing span |
| [`span-model-attempt.json`](../samples/ai-gateway/span-model-attempt.json) | Model attempt, zero duration |
| [`span-provider-attempt.json`](../samples/ai-gateway/span-provider-attempt.json) | Upstream call with the provider's request and response IDs |
| [`span-root-byok.json`](../samples/ai-gateway/span-root-byok.json) | BYOK request: `cost.total = 0`, `cost.market` set |
| [`span-provider-attempt-byok.json`](../samples/ai-gateway/span-provider-attempt-byok.json) | Its provider attempt, timestamps 9 s late |
| [`span-root-fallback.json`](../samples/ai-gateway/span-root-fallback.json) | Request served by the fallback model |
| [`span-model-attempt-fallback.json`](../samples/ai-gateway/span-model-attempt-fallback.json) | `model_attempt.index = 1`, `total = 2` |
| [`span-drain-test-event.json`](../samples/ai-gateway/span-drain-test-event.json) | The drain's test trace |
| [`trace-gateway-request.ndjson`](../samples/ai-gateway/trace-gateway-request.ndjson) | All four spans of one request |
| [`trace-shared-span-ids.ndjson`](../samples/ai-gateway/trace-shared-span-ids.ndjson) | Two requests from one invocation with the same trace and span IDs |
| [`span-claude-platform-messages-create.json`](../samples/ai-gateway/span-claude-platform-messages-create.json) | Anthropic's server span for a BYOK request (organization and workspace IDs redacted) |
| [`drain-config.json`](../samples/ai-gateway/drain-config.json) | The drain as `GET /v1/drains` returns it |
| [`metrics-request-count.json`](../samples/ai-gateway/metrics-request-count.json) | Requests by app and BYOK |
| [`metrics-request-cost.json`](../samples/ai-gateway/metrics-request-cost.json) | Cost by app and BYOK |
| [`metrics-request-count-model.json`](../samples/ai-gateway/metrics-request-count-model.json) | Requests by model, provider and environment |
| [`metrics-ttft-p75-provider.json`](../samples/ai-gateway/metrics-ttft-p75-provider.json) | p75 time to first token by provider |

## Sources

- Vercel docs, read 2026-10-26: [AI Gateway Trace Drains](https://vercel.com/docs/ai-gateway/observability-and-spend/trace-drains) (last updated 2026-09-08); read 2026-10-16: [Observability](https://vercel.com/docs/ai-gateway/observability-and-spend/observability), [Logs](https://vercel.com/docs/ai-gateway/observability-and-spend/logs), [Custom Reporting](https://vercel.com/docs/ai-gateway/observability-and-spend/custom-reporting), [Model fallbacks](https://vercel.com/docs/ai-gateway/models-and-providers/model-fallbacks), [changelog 2026-08-05](https://vercel.com/changelog/export-ai-gateway-traces-with-vercel-drains).
- eve 0.81.0 docs (`docs/guides/instrumentation/otel.mdx`, trace topology section).
- Lab: Bronto EU datasets `.traces/ai-gateway`, `.traces/claude-platform`, `.traces/petclinic-web`, `.traces/petclinic-agent`, 2026-10-19 to 2026-10-23; `vercel metrics vercel.ai_gateway.request.*` (CLI 65.2.0, Observability Plus) for 2026-10-22; `GET /v1/drains`; research I-lab-findings D6, T4.
