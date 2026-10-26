# AI SDK (`ai` with `@ai-sdk/otel`)

> With `registerTelemetry(new OpenTelemetry())` in `instrumentation.ts`, every AI SDK call produces three spans following the OpenTelemetry GenAI conventions: `invoke_agent <model>`, `step <n>` and `chat <model>`, with token counts and, by default, the full prompt, system instructions and output. Adding `providerMetadata: true` attaches the AI Gateway's routing (every model and provider attempt, the provider's request ID, the credential used) and the request's cost, as one JSON string. That string is the only place the cost appears on the app's spans. The spans leave through whatever OpenTelemetry pipeline the app registers; on Vercel with `@vercel/otel` they also reach the trace drain, so an app that exports over OTLP as well sends each span twice. The thing people miss: inputs and outputs are recorded unless you turn them off per call.

| | |
| --- | --- |
| Kind | Library |
| Plans | Any; spans need an OpenTelemetry tracer provider (here `@vercel/otel`) |
| Signals | Traces |
| Exit paths | OTLP from code · Trace drain (spans created inside a Vercel function) |
| Verified | 2026-10-26 · `ai` 7.0.148 · `@ai-sdk/otel` 1.0.148 · `@vercel/otel` 2.1.3 · Next.js 16.3.6 · lab route `apps/web/app/api/visit-note` |

## 1. What it emits

| Signal | What | Where it lives | Retention |
| --- | --- | --- | --- |
| Traces | One span tree per call (`generateText`, `streamText`, `generateObject`, embeddings, reranking, tool executions) | Wherever the app's tracer provider exports; nothing is kept by the library | |
| Response metadata | `providerMetadata.gateway` (cost, routing, generation ID) on the call's result | In memory, in your code | |

No logs or metrics. Without `registerTelemetry()` the AI SDK creates no spans.

## 2. Out-of-the-box shape

The lab route writes a visit note after each booking:

```ts
// apps/web/instrumentation.ts
registerOTel({ serviceName: "petclinic-web", instrumentationConfig: {
  fetch: { propagateContextUrls: [petclinicOrigin, "https://ai-gateway.vercel.sh"] } } });
registerTelemetry(new OpenTelemetry({ providerMetadata: true }));

// apps/web/app/api/visit-note/route.ts
await generateText({ model: "anthropic/claude-haiku-5.5", output: Output.object({ schema: Note }),
  instructions: "...", prompt: `Visit for ${petName} on ${date}. Reason: ${description}`,
  telemetry: { functionId: "visit-note" } });
```

The call's spans, inside the Next.js route and followed by the gateway's spans (Captured: `trace-visit-note.ndjson`):

```
POST /api/visit-note                                   petclinic-web   2.37 s
└─ executing api route (app) /api/visit-note           petclinic-web   2.35 s
   ├─ http GET https://oidc.vercel.com/.well-known/jwks
   └─ invoke_agent anthropic/claude-haiku-5.5          petclinic-web   2.28 s   INTERNAL
      └─ step 1                                        petclinic-web   2.28 s   INTERNAL
         └─ chat anthropic/claude-haiku-5.5            petclinic-web   2.28 s   CLIENT
            └─ fetch POST https://ai-gateway.vercel.sh/v4/ai/language-model   (from @vercel/otel)
               └─ chat anthropic/claude-haiku-5.5      ai-gateway      2.20 s
                  └─ … routing, model attempt, provider attempt
```

| Span | Attributes (Captured: `span-invoke-agent.json`, `span-step.json`, `span-chat.json`) |
| --- | --- |
| `invoke_agent <model>` | `gen_ai.operation.name = invoke_agent`, `gen_ai.agent.name` (= `telemetry.functionId`, here `visit-note`), `gen_ai.provider.name = gateway`, `gen_ai.request.model`, `gen_ai.response.finish_reasons.0`, `gen_ai.usage.input_tokens`, `output_tokens`, `cache_creation.input_tokens`, `cache_read.input_tokens`, `gen_ai.system_instructions`, `gen_ai.input.messages`, `gen_ai.output.messages` |
| `step <n>` | `gen_ai.operation.name = agent_step`; nothing else from the SDK |
| `chat <model>` | `gen_ai.operation.name = chat`, `gen_ai.provider.name = gateway`, `gen_ai.request.model`, `gen_ai.response.model` (`anthropic/claude-haiku-5.5`), `gen_ai.response.id` (`aitxt-…`, the SDK's own ID), `gen_ai.response.finish_reasons.0`, `gen_ai.client.operation.duration` (seconds), token usage, and the same instructions, input and output messages |

All three are `STATUS_CODE_UNSET` on success. Resource attributes come from `@vercel/otel` (`service.name`, `vercel.project_id`, `vercel.deployment_id`, `vercel.region`, `vcs.*`); the AI SDK adds none.

Content: `gen_ai.input.messages` held the prompt (`Visit for Rosy on 2026-10-30. Reason: Vaccination`) and `gen_ai.output.messages` the generated note, on both `invoke_agent` and `chat`. Recording is on by default (`recordInputs` and `recordOutputs` default to `true`, Documented in `ai` 7.0.148 types).

No cost attribute exists on these spans without `providerMetadata: true`.

## 3. Extras beyond the default

| Extra | What it adds | Cost |
| --- | --- | --- |
| `new OpenTelemetry({ providerMetadata: true })` | `ai.response.providerMetadata` on `invoke_agent`, `step` and `chat`: a JSON string with the provider's raw usage and the gateway's routing and cost | Span size: the attribute was 1.6 to 1.7 KB per span, three times per call |
| `telemetry: { functionId }` per call | `gen_ai.agent.name` on `invoke_agent` | None |
| `telemetry: { recordInputs: false, recordOutputs: false }` per call | Removes prompts and outputs from the spans | None |
| `enrichSpan` option | Your own attributes on every span, for example the generation ID copied out of the metadata | None |
| `@vercel/otel` `propagateContextUrls` with the gateway's origin | `traceparent` on the gateway call, so the gateway's spans join this trace | None |
| Other options (`usage`, `headers`, `schema`, `toolChoice`, `runtimeContext`) | Further attributes, off by default (Documented, `@ai-sdk/otel` 1.0.148 types) | Not tested |

The gateway part of `ai.response.providerMetadata` for one call (Captured: `provider-metadata-gateway.json`):

```json
{ "routing": {
    "originalModelId": "anthropic/claude-haiku-5.5", "resolvedProvider": "anthropic",
    "fallbacksAvailable": ["bedrock", "vertexAnthropic", "claudeaws"],
    "planningReasoning": "Request-scoped BYOK credentials provided for: anthropic … Total execution order: anthropic(BYOK) → anthropic(system) → bedrock(system) → vertexAnthropic(system) → claudeaws(system)",
    "finalProvider": "anthropic", "modelAttemptCount": 1,
    "modelAttempts": [{ "canonicalSlug": "anthropic/claude-haiku-5.5", "success": true,
      "providerAttempts": [{ "provider": "anthropic", "credentialType": "byok", "success": true,
        "startTime": 1792792820351, "endTime": 1792792822533,
        "providerRequestId": "req_011CgKvMx9X4QtPMi1WmCGBf", "statusCode": 200,
        "providerResponseId": "msg_011CgKvMyNgkM8TBChowkSBQ" }] }],
    "totalProviderAttemptCount": 1,
    "clientSessionId": "08224d8dfdefd3741abfafb3b7cd5a1a", "clientSessionIdSource": "fingerprint" },
  "cost": "0", "marketCost": "0.0000945", "surchargeCost": "0", "gatewayCost": "0",
  "generationId": "gen_01M5NCEYKFB0XAQSP1M21SEMH2" }
```

This carries more than the gateway's own trace for the same request: the planned provider order, the providers left as fallbacks, and correct start and end times of the provider call. A request that falls back lists every model attempt here (`modelAttemptCount` > 1); the lab's 64 calls all had one attempt, so a fallback in this metadata is Not observed.

## 4. Getting it out

| Signal | Exit path | Tested configuration |
| --- | --- | --- |
| Spans | `@vercel/otel` exporter from `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_HEADERS` | `registerOTel({ serviceName: "petclinic-web" })`, OTLP/HTTP protobuf |
| Spans | Vercel trace drain | The project's trace drain forwarded the same spans: all 64 `chat` spans of the period appear in both datasets |
| Cost per call | `ai.response.providerMetadata` on the spans, or `result.providerMetadata.gateway` in code | |

**Send each span once.** On Vercel, spans created inside a function reach the trace drain, and `@vercel/otel` also exports them when `OTEL_EXPORTER_OTLP_*` is set. In the lab the AI SDK's `chat` span `0eb4e8b54a5b9af5` is in both `.traces/petclinic-web` (direct export) and `.traces/vercel-traces` (drain) (Observed). Pick one path; the Functions entry covers the choice.

The trace joins downstream and upstream: the AI SDK's spans sit under the Next.js route, which sits under the eve agent's tool call that invoked it, and the gateway's spans sit under the AI SDK's `fetch`. Of 57 BYOK gateway requests from this route, 54 had their parent `fetch` span in the app's data (Observed). Anthropic's server-side span for the same call is a separate trace, joined on `providerRequestId` (see the AI Gateway entry).

## 5. In Bronto

| Data | Dataset | Field names |
| --- | --- | --- |
| Direct OTLP export | `.traces/petclinic-web` | `"$gen_ai.agent.name"`, `"$gen_ai.usage.output_tokens"`, `"$ai.response.providerMetadata"` |
| Drain copy | `.traces/vercel-traces` (`"$service.name" = 'petclinic-web'`) | Same, plus `vercel.projectId` |

Queries over the lab's last 7 days, run 2026-10-26:

| Question | Query | Group by | Result |
| --- | --- | --- | --- |
| Calls per AI feature | `"$gen_ai.operation.name" = 'invoke_agent'` | `"$gen_ai.agent.name"` | `visit-note` 64 |
| Calls that used your own provider key | `"$span.name" LIKE 'chat %' AND "$ai.response.providerMetadata" LIKE '%"credentialType":"byok"%'` | `"$span.name"` | 57 |
| Calls that needed more than one model | `"$span.name" LIKE 'chat %' AND "$ai.response.providerMetadata" NOT LIKE '%"modelAttemptCount":1,%'` | `"$span.name"` | none |
| The gateway's record of a call | Copy `generationId` from the metadata, then `"$vercel.ai_gateway.generation.id" = '<id>'` on `.traces/ai-gateway` | | One root span per call |

The routing and cost fields are inside one JSON string, so they are matched with `LIKE`; for sums and group-bys on cost, copy `cost` into its own attribute with `enrichSpan` or use the gateway's `vercel.ai_gateway.cost.total`.

## Gotchas

1. **Prompts and outputs are on the spans by default.** `gen_ai.input.messages`, `gen_ai.output.messages` and `gen_ai.system_instructions` were on every call, on two spans each. Set `recordInputs: false` / `recordOutputs: false` per call where the text is personal (Captured: `span-chat.json`).
2. **Cost is a string inside a JSON string.** `providerMetadata: true` writes the whole metadata object as one attribute, repeated on `invoke_agent`, `step` and `chat`. There is no `gen_ai.usage.cost`.
3. **`gen_ai.provider.name` is `gateway`.** The real provider is only in the metadata (`finalProvider`) or in the gateway's spans.
4. **BYOK cost is `"0"`.** As in the gateway's spans, `cost` is `"0"` for BYOK and the list price is in `marketCost`.
5. **The gateway joins the trace only if `traceparent` is sent.** With `@vercel/otel`, list `https://ai-gateway.vercel.sh` in `propagateContextUrls`; without it the gateway's spans start their own trace.

## Samples

| File | What it shows |
| --- | --- |
| [`span-invoke-agent.json`](../samples/ai-sdk/span-invoke-agent.json) | `invoke_agent`: function ID, usage, messages, provider metadata |
| [`span-step.json`](../samples/ai-sdk/span-step.json) | `step 1` |
| [`span-chat.json`](../samples/ai-sdk/span-chat.json) | `chat`: model, response ID, duration, usage, messages |
| [`span-fetch-gateway.json`](../samples/ai-sdk/span-fetch-gateway.json) | `@vercel/otel`'s `fetch` span to the gateway, the gateway root's parent |
| [`provider-metadata-gateway.json`](../samples/ai-sdk/provider-metadata-gateway.json) | The `ai.response.providerMetadata` value, pretty-printed |
| [`trace-visit-note.ndjson`](../samples/ai-sdk/trace-visit-note.ndjson) | The route's spans with the gateway spans beneath |

## Sources

- `ai` 7.0.148 type definitions (`TelemetryOptions`), `@ai-sdk/otel` 1.0.148 README and types (`OpenTelemetryOptions`), read 2026-10-26; [AI SDK telemetry docs](https://ai-sdk.dev/docs/ai-sdk-core/telemetry).
- Lab: `apps/web/instrumentation.ts`, `apps/web/app/api/visit-note/route.ts` (commits 350b3ce, aeee21d); Bronto EU datasets `.traces/petclinic-web`, `.traces/vercel-traces`, `.traces/ai-gateway`, 2026-10-22 to 2026-10-23; trace `8f4dd49762ae87052acded4ce063c7cf`.
