# Agent Runs (eve, durable-harness)

> Agent frameworks on Vercel emit OpenTelemetry spans per agent turn: `invoke_agent` for the turn, `agent.step` per model round, `chat <model>` for the model call and `execute_tool <tool>` per tool call, with tokens, gateway cost, the caller and the run ID. On Vercel those spans feed the Agent Runs view (`vercel agent-runs`, beta, no Observability Plus needed) and, because they travel through Vercel's tracing, the project's trace drain too. Adding an OTLP exporter in code (eve's `otelIntegration`, durable-harness's `spanProcessors`) sends the same spans a second time: as of 2026-10-26 the lab's eve agent delivers every span twice, with identical span IDs, about 290,000 duplicates a day. Choose one path. Turns are separate traces from the request that ran them, and model calls join them by generation ID rather than by trace.

| | |
| --- | --- |
| Kind | Library (eve, durable-harness) plus a platform view (Agent Runs) |
| Plans | Agent Runs: beta on Hobby, Pro and Enterprise, needs team enablement and a 100% tracing rule; trace drains on Pro and Enterprise |
| Signals | Traces · Agent Runs records (sessions, turns, tool calls, usage) |
| Exit paths | Trace drain · OTLP from code · `vercel agent-runs` CLI (read) |
| Verified | 2026-10-26 · eve 0.81.0 · durable-harness 0.0.1-beta.6 · Vercel CLI 65.2.0 · data 2026-10-19 to 2026-10-25 (agent turns stopped 2026-10-23 22:00 UTC) |

## 1. What it emits

| Signal | What | Where it lives | Retention |
| --- | --- | --- | --- |
| Traces | One trace per agent turn: `invoke_agent`, `agent.step`, `chat`, `execute_tool`, plus spans from instrumentation libraries inside tools | Agent Runs, Observability › Tracing, trace drain, any OTLP destination you add | Agent Runs 30 days during beta (Documented) |
| Agent Runs records | Run list (status, trigger, turns, tokens, cost), run detail, turn timeline with tool calls | Observability › Agent Runs, `vercel agent-runs` | As above |
| Workflow spans | eve and durable-harness run on Vercel Workflow; its spans (`workflow.*`, `world.*`, `vqs.*`) come with them | As traces | See the Workflow entry |

Agent Runs usage is billed at Always-on Tracing rates during beta (Documented, eve docs).

## 2. Out-of-the-box shape

### eve

A premium turn that books a visit (Captured: `trace-eve-turn-booking.ndjson`):

```
invoke_agent petclinic-agent                           4.95 s   INTERNAL  root, new trace per turn
├─ agent.step                                          3.65 s
│  ├─ chat anthropic/claude-haiku-5.5                  1.13 s   CLIENT
│  │  └─ POST  ai-gateway.vercel.sh/v4/ai/language-model         (undici instrumentation)
│  └─ execute_tool book_visit                          2.52 s
│     ├─ POST  → caddy → PetClinic → insert visits                (W3C trace context to AWS)
│     └─ POST  → POST /api/visit-note (Vercel edge, function, Next.js, AI SDK, AI Gateway)
└─ agent.step                                          1.04 s
   └─ chat anthropic/claude-haiku-5.5                  1.03 s
      └─ POST  ai-gateway.vercel.sh/v4/ai/language-model
```

| Span | Attributes (Captured: `span-eve-*.json`) |
| --- | --- |
| `invoke_agent <agent>` | `gen_ai.operation.name`, `gen_ai.agent.name`, `gen_ai.conversation.id`, `agent.run.id` (`wrun_…`, the Workflow run), `agent.turn.id`, `.sequence`, `.outcome` (`completed`, `failed`), `agent.channel.kind`, `.name`, `.audience`, `.request.id`, `agent.principal.current.type`, `agent.principal.initiator.type` (`runtime`, `anonymous`), `agent.session.origin`, `agent.framework.name`, `.version`, `gen_ai.usage.input_tokens`, `output_tokens` (turn total), events `turn.started`, `turn.completed` |
| `agent.step` | `agent.step.index`, `.attempt`, `agent.model.id`, `agent.usage.input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, **`gen_ai.usage.cost`** (from the gateway), **`gen_ai.generation.id`**, `ai.settings.context.*`, a span link to the Workflow delivery |
| `chat <model>` | `gen_ai.provider.name = gateway`, `gen_ai.request.model` (`anthropic/claude-haiku-5.5`), `gen_ai.response.model` (`claude-haiku-5-5`, the provider's ID), `gen_ai.response.id` (the provider's message ID), `gen_ai.usage.input_tokens`, `output_tokens`, `cache_read.input_tokens`, `cache_write.input_tokens`, `ai.settings.context.*` |
| `execute_tool <tool>` | `gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.tool.type`, `gen_ai.execute_tool.duration`, `agent.action.kind`, `.name`, `.outcome` (`completed`, `failed`), `agent.tool.is_framework` |

All spans are `STATUS_CODE_UNSET`, including failed tool calls; failure is in `agent.action.outcome` and `agent.turn.outcome`. Resource attributes include `service.name` (from `otel({ resource })`), `vercel.project_id`, `vercel.deployment_id`, `vercel.region`, `vcs.*`, `deployment.environment.name`.

Content: eve recorded no prompt or output text on production spans (`private` and `unknown` audience); `gen_ai.input.messages` appeared only on 21 spans from local runs (`deployment.environment.name = local`) (Observed). That follows eve's default trace policy; `otel({ tracePolicy })` changes it (Documented).

What the eve agent produced in 7 days (Observed): 23,112 turns (`invoke_agent`), 41,834 steps, 35,845 `chat petclinic-basic-1` calls (the free plan's rule-based model, no gateway), 5,960 gateway model calls, 18,720 tool calls (34 `failed`), 1 failed turn.

eve's `chat` span doesn't show which model served when the gateway falls back. In a forced fallback on 2026-10-22, `gen_ai.request.model` and `gen_ai.response.model` both named Claude Haiku while Gemini answered; only the about 10 times higher `gen_ai.usage.cost` on `agent.step` hinted at it (Observed during the lab build, local `eve dev` run, spans not retained). The gateway's spans show the fallback.

### durable-harness

The ops agent (`agentRuns({ serviceName: "petclinic-ops", spanProcessors })`, hourly cron) produces the same span names with its own attributes (Captured: `trace-ops-run.ndjson`, `span-ops-*.json`):

```
invoke_agent clinic-ops                                9.12 s
├─ agent.step  → chat anthropic/claude-haiku-5.5       4.63 s
│              → execute_tool visits_on                369 ms
│                 └─ fetch GET …/petclinic/api/owners  (petclinic-web, @vercel/otel) → caddy → PetClinic → SQL
├─ agent.step  → chat …, execute_tool post_schedule
└─ agent.step  → chat …
```

Differences from eve (Observed):

- **Content is recorded**: `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions`, `gen_ai.tool.definitions`, `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`, `ai.response.text`.
- `gen_ai.provider.name = vercel-ai-gateway`; `chat` carries `gen_ai.response.id` = the gateway's **generation ID**, and `agent.usage.cost_usd`.
- `invoke_agent` carries `agent.session.title` (the user message) and `agent.usage.cost_usd` for the turn.
- The harness's model calls are not children of its `chat` spans. They are `@vercel/otel` `fetch` spans in the trace of the Workflow request that ran the step, with the gateway's spans beneath (Captured: `trace-ops-request-with-gateway.ndjson`). The tool's `fetch` does join the agent's trace.

### Agent Runs

`vercel agent-runs list | inspect | trace` read the same spans (`"dataSource": "agent-otel"`). For the eve session above (Captured: `agent-runs-*.json`):

```
$ vercel agent-runs list --since 2026-10-23T20:00:00Z --until 2026-10-23T23:00:00Z
Run ID                            Status    Trigger   Model   Tokens   Duration
wrun_41M5NCENVJ3GVQ3AKCDDEW3YZD   Waiting   eve       -       29.6k    -
…  Showing 5 of 121 Agent Runs.

$ vercel agent-runs trace wrun_41M5NCENVJ3GVQ3AKCDDEW3YZD --json
turn_0  find_owner   costUsd 0.000574175
turn_1  book_visit   costUsd 0.00035166     "traceRevision": "agent-otel:776df6eb…,8f4dd497…"
```

- A run is an eve session (`wrun_…`); its turns are the turn traces listed in `traceRevision`. Turn 1's cost, $0.00035166, is the sum of the two gateway requests in that turn ($0.000187675 + $0.000163985).
- Messages are empty (`"messages": []`) and titles private for these sessions, matching the spans.
- Every eve run had status `waiting` and no duration: on 2026-10-23, 1,320 runs, `completed: 0`, `failed: 0`. eve sessions stay open after a turn.
- The durable-harness ops run appears too, but as `"framework": "eve"`, trigger `HTTP`, while its spans say `agent.framework.name = durable-harness` (Captured: `agent-runs-inspect-ops.json`).
- `vercel agent-runs projects` lists only projects with recent activity; on 2026-10-26, three days after the lab's agent stopped, `petclinic-agent` wasn't listed while `list --since …` still returned its runs.

## 3. Extras beyond the default

| Extra | What it adds | Cost |
| --- | --- | --- |
| `otel({ resource, instrumentations })` (eve) | Resource attributes; spans from instrumentation libraries inside tools. With `@opentelemetry/instrumentation-undici`, every `fetch` gets a span and a `traceparent`, so PetClinic's spans join the turn | None |
| `otelIntegration({ runtimeContext })` (eve) | `ai.settings.context.<key>` on `agent.step` and `chat`. The lab stamps `plan`, `user.type`, `user.id`; `ai.settings.context.eve.environment` is always there | None |
| `otelIntegration({ traceExporter })` (eve) / `agentRuns({ spanProcessors })` (durable-harness) | A second destination over OTLP | See "Send each span once" |
| `agentRuns({ exportPolicy })` / `otelIntegration({ exportPolicy })` | Per-destination filtering and content redaction (Documented) | None |
| `otel({ tracePolicy })` | Whether prompts and outputs are recorded, for every destination (Documented) | None |

`runtimeContext` exists only on `otelIntegration`, not on `agentRuns` (eve 0.81.0 types). Its values still land on the spans Agent Runs and the trace drain receive: the drain copy of `agent.step` carried `ai.settings.context.plan = premium` (Observed).

## 4. Getting it out

| Path | What leaves | Tested configuration |
| --- | --- | --- |
| Agent Runs → trace drain | All agent spans, with `vercel.projectId`, `vercel.deploymentId`, `vercel.ownerId` added as resource attributes | eve's default Agent Runs export (no `agent/instrumentation/agent-runs.ts`); durable-harness `agentRuns()`; project trace drain `petclinic-agent-traces` |
| OTLP from code | The same spans, without the `vercel.*` resource attributes the drain adds | eve: `otelIntegration({ traceExporter: new OTLPTraceExporter() })` reading `OTEL_EXPORTER_OTLP_*`; durable-harness: `spanProcessors: [new SimpleSpanProcessor(new OTLPTraceExporter())]` |
| `vercel agent-runs … --json` | Run and turn summaries, usage, cost | CLI 65.2.0, read-only |

### Send each span once

As of 2026-10-26 the lab uses both paths for both agents, and every span arrives twice (Observed):

- The eve turn root `6069ab7a6a576edb` (trace `081c7a954d1efe5363c45d7e2ee0e7e5`, 2026-10-23 12:00 UTC) is in `.traces/petclinic-agent` (direct export) and in `.traces/vercel-traces` (drain) with the same span ID and the same attributes. The drain copy adds `vercel.projectId`, `vercel.deploymentId`, `vercel.ownerId` and has `span.flags = 0` instead of `257` (Captured: `duplicate-direct-copy.json`, `duplicate-drain-copy.json`).
- 40 of 40 span IDs sampled from the drain's `petclinic-agent` spans (2026-10-23 12:00 to 12:05) were also in the direct dataset.
- On 2026-10-25: 344,225 spans through the direct export, 288,927 of the same service through the drain. After the agent's turns stopped, these were mostly eve's Workflow spans (session timeouts, queue processing).
- The ops agent: 315 spans in each path, 2026-10-22 to 2026-10-23.

eve's documentation shows `otelIntegration` as the way to add a third-party destination and doesn't mention that, on Vercel, the default Agent Runs export already reaches the trace drain. The fix is to choose one path per service:

- **Trace drain only.** Keep the default Agent Runs export and the trace drain; remove the OTLP exporter from code. For eve, `otelIntegration({ runtimeContext })` without `traceExporter` keeps the `ai.settings.context.*` attributes (allowed by the types; Not observed). Spans arrive with Vercel's resource attributes and in the same pipeline as the platform's spans; you pay drain volume.
- **OTLP from code only.** Keep the exporter; stop the agent's spans from reaching the drain. Whether turning off the Agent Runs export (`disableInstrumentation()` in `agent/instrumentation/agent-runs.ts`) also removes them from the trace drain is Not observed, and it empties the Agent Runs view.

## 5. In Bronto

| Data | Dataset | Field names |
| --- | --- | --- |
| eve, direct OTLP export | `.traces/petclinic-agent` | `"$gen_ai.usage.cost"`, `"$ai.settings.context.plan"`, `"$agent.run.id"` |
| durable-harness, direct OTLP export | `.traces/petclinic-ops` | Same names, `"$agent.usage.cost_usd"` |
| Drain copies | `.traces/vercel-traces` | Same, filter on `"$service.name"` |

Queries, run 2026-10-26:

| Question | Query | Select / group by | Result |
| --- | --- | --- | --- |
| Model cost per plan, 2026-10-23 | `"$span.name" = 'agent.step'` | `sum("$gen_ai.usage.cost")` by `"$ai.settings.context.plan"` | premium $0.1603 (477 steps); free plan makes no gateway calls |
| Turns per caller type, 2026-10-23 | `"$gen_ai.operation.name" = 'invoke_agent' AND "$gen_ai.agent.name" = 'petclinic-agent'` | `count()` by `"$agent.principal.current.type"` | anonymous 1,275 · runtime 265 |
| Failed tool calls, 7 days | `"$gen_ai.operation.name" = 'execute_tool'` | `count()` by `"$gen_ai.tool.name"`, `"$agent.action.outcome"` | find_owner failed 33 · list_vets failed 1 (of 18,720) |
| Failed turns, 7 days | `"$gen_ai.operation.name" = 'invoke_agent'` | `count()` by `"$agent.turn.outcome"` | completed 23,124 · failed 1 |
| Ops agent cost per run | `"$span.name" = 'agent.step'` on `.traces/petclinic-ops` | `sum("$gen_ai.usage.cost")` by `"$gen_ai.conversation.id"` | about $0.0006 to $0.0007 per hourly run |
| Is a span arriving twice? | `"$span.span_id" = '<id>'` on both `.traces/petclinic-agent` and `.traces/vercel-traces` | | Found in both (2026-10-26) |
| The gateway's record of a step | `"$vercel.ai_gateway.generation.id" = '<gen_ai.generation.id of agent.step>'` on `.traces/ai-gateway` | | One root span |

The eve cost on `agent.step` and the gateway's own spend agree: for 2026-10-23, $0.1603 on eve's steps against $0.1555 + $0.0049 = $0.1604 on the gateway's root spans for `petclinic-agent` and `triage`.

## Gotchas

1. **Each span twice.** Agent Runs on Vercel feeds the trace drain; an OTLP exporter in code sends the same span IDs again (section 4). The cost advice is to send each span once.
2. **A turn is not a request.** eve starts a new trace for each turn; the Vercel request that ran it, the Workflow spans and, for durable-harness, the model calls are in other traces. Join with `agent.run.id` / `gen_ai.conversation.id` and the generation ID.
3. **The gateway's spans rarely join eve's trace.** With eve 0.81.0 and the undici instrumentation, 857 of 914 gateway requests from eve (2026-10-22 and 23) started their own trace, although eve's docs say gateway calls propagate the context. Join on `agent.step` `gen_ai.generation.id` = `vercel.ai_gateway.generation.id`, or `chat` `gen_ai.response.id` = `vercel.ai_gateway.attempt.provider_response_id` (see the AI Gateway entry).
4. **Failures don't set span status.** Failed tool calls and turns are `STATUS_CODE_UNSET`; query `agent.action.outcome` and `agent.turn.outcome`.
5. **eve's `chat` span hides fallbacks.** It names the requested model even when the gateway served another; cost is the only hint.
6. **eve and durable-harness differ on content.** eve kept prompts and outputs off production spans by default; durable-harness 0.0.1-beta.6 recorded messages, tool arguments and tool results (here PetClinic seed data such as owner Harold Davis's lizard Iggy).
7. **Agent Runs status stays `waiting`.** eve sessions never showed `completed` or a duration; count turns from `invoke_agent` instead.

## Samples

| File | What it shows |
| --- | --- |
| [`span-eve-invoke-agent.json`](../samples/agent-runs/span-eve-invoke-agent.json) | eve turn root: run, turn, channel, principal, usage |
| [`span-eve-agent-step.json`](../samples/agent-runs/span-eve-agent-step.json) | `agent.step`: cost, generation ID, `ai.settings.context.*` |
| [`span-eve-chat.json`](../samples/agent-runs/span-eve-chat.json) | eve `chat` span |
| [`span-eve-execute-tool.json`](../samples/agent-runs/span-eve-execute-tool.json) | eve tool call |
| [`span-eve-http-gateway.json`](../samples/agent-runs/span-eve-http-gateway.json) | undici client span for the gateway call |
| [`duplicate-direct-copy.json`](../samples/agent-runs/duplicate-direct-copy.json) | A turn root as delivered by the OTLP exporter |
| [`duplicate-drain-copy.json`](../samples/agent-runs/duplicate-drain-copy.json) | The same span as delivered by the trace drain |
| [`trace-eve-turn-booking.ndjson`](../samples/agent-runs/trace-eve-turn-booking.ndjson) | One eve turn across PetClinic, a Next.js route, the AI SDK and the gateway |
| [`span-ops-invoke-agent.json`](../samples/agent-runs/span-ops-invoke-agent.json) | durable-harness turn root, with content and cost |
| [`span-ops-agent-step.json`](../samples/agent-runs/span-ops-agent-step.json) | durable-harness step |
| [`span-ops-chat.json`](../samples/agent-runs/span-ops-chat.json) | durable-harness `chat`, response ID = generation ID |
| [`span-ops-execute-tool.json`](../samples/agent-runs/span-ops-execute-tool.json) | durable-harness tool call with arguments and result |
| [`trace-ops-run.ndjson`](../samples/agent-runs/trace-ops-run.ndjson) | One ops run |
| [`trace-ops-request-with-gateway.ndjson`](../samples/agent-runs/trace-ops-request-with-gateway.ndjson) | The Workflow request that ran it, with the gateway calls |
| [`agent-runs-list.json`](../samples/agent-runs/agent-runs-list.json) | `vercel agent-runs list --json` (first two runs) |
| [`agent-runs-inspect.json`](../samples/agent-runs/agent-runs-inspect.json) | `inspect` of the eve session |
| [`agent-runs-trace.json`](../samples/agent-runs/agent-runs-trace.json) | `trace` of the eve session: turns, tool calls, cost |
| [`agent-runs-inspect-ops.json`](../samples/agent-runs/agent-runs-inspect-ops.json) | `inspect` of the durable-harness run, labelled `eve` |

## Sources

- eve 0.81.0 docs, read 2026-10-26: `docs/guides/instrumentation/agent-runs.mdx`, `otel.mdx` (trace topology, `runtimeContext`, export policies); type definitions in `dist/src/tracing/eve/otel-declaration.d.ts`.
- Lab: `agent/instrumentation/otel.ts`, `agent/instrumentation/otlp.ts`, `apps/web/agent-runs.ts`, `apps/web/lib/ops-agent.ts` (commits 0230eda, eea769e, 1346de3); Bronto EU datasets `.traces/petclinic-agent`, `.traces/petclinic-ops`, `.traces/vercel-traces`, `.traces/ai-gateway`, 2026-10-19 to 2026-10-25; Vercel CLI 65.2.0 `vercel agent-runs list | inspect | trace | projects`; research I-lab-findings T2, T8, V3; lab notes 2026-10-22 (fallback in eve's spans).
