# vercel-observability

Every Vercel service, product and library that emits telemetry, with the same five answers for each:

1. **What it emits**: logs, metrics, traces, events, other.
2. **Out-of-the-box shape**: the records as Vercel produces them with no setup, from captured samples.
3. **Extras**: what add-ons, configuration and instrumentation libraries add.
4. **Getting it out**: drains, webhooks, APIs or OTLP from code, with tested configuration, and what can't leave Vercel.
5. **In a backend**: how the data looks after ingestion, with tested queries. Bronto is the example backend; sections 1–4 apply to any OTLP or HTTP backend.

Entries were verified in the lab on 2026-10-26 and 2026-10-27 and refreshed against Vercel's docs, changelog and package releases on 2026-11-12 (no new captures; each entry has a `Refreshed` row). Every claim is marked Captured, Observed, Documented or Not observed. See [METHOD.md](METHOD.md) for how records are captured and redacted, and [TEMPLATE.md](TEMPLATE.md) for the layout of an entry.

## Catalog

Exit paths: **LD** log drain · **TD** trace drain · **AD** analytics (Web Analytics) drain · **SID** Speed Insights drain · **AGD** AI Gateway trace drain · **WH** webhook · **API** REST API · **OTLP** export from your code · **—** stays in Vercel.

### Platform

| Emitter | Logs | Metrics | Traces | Events / other | Exit paths | Entry |
| --- | --- | --- | --- | --- | --- | --- |
| [Functions](emitters/functions.md) | ✓ | ✓ (Plus) | ✓ | | LD, TD, OTLP | **Done** 2026-10-26 |
| [Routing Middleware](emitters/routing-middleware.md) | ✓ | ✓ (Plus) | ✓ | | LD, TD | **Done** 2026-10-26 |
| [CDN: static, ISR, PPR, cache](emitters/cdn.md) | ✓ | ✓ (Plus) | ✓ | | LD, TD | **Done** 2026-10-26 (PPR: needs a PPR route) |
| [Redirects and external rewrites](emitters/redirects-rewrites.md) | ✓ | ✓ (Plus) | ✓ | | LD, TD | **Done** 2026-10-26 |
| [Image Optimization](emitters/image-optimization.md) | ✓ | ✓ (Plus) | | | LD | **Done** 2026-10-27 |
| [Firewall, WAF, rate limits](emitters/firewall.md) | ✓ | ✓ (Plus) | | Attack alerts | LD, WH | **Done** 2026-10-26 (log/challenge actions, attack alerts: need config) |
| [BotID](emitters/botid.md) | ✓ | ✓ (Plus) | ✓ | | LD, TD | **Done** 2026-10-27 |
| [Builds](emitters/builds.md) | ✓ | | | | LD | **Done** 2026-10-26 |
| [Vercel CI](emitters/vercel-ci.md) | ✓ (task logs, pull only) | | | Run and task status, GitHub check | API | **Docs only** 2026-11-12 (no lab capture yet) |
| [Deployments, Rolling Releases, domains](emitters/deployments.md) | | | | ✓ | WH | **Done** 2026-10-26 (rollback, Rolling Release, domain events: need more webhook events) |
| [Cron Jobs](emitters/cron-jobs.md) | ✓ | | ✓ | | LD, TD | **Done** 2026-10-26 (successor: Schedules) |
| [Schedules](emitters/schedules.md) | ✓ (target's) | | ✓ (target's) | Execution history, Activity Log events | LD, TD, API | **Docs only** 2026-11-12 (no lab capture yet) |
| [Queues](emitters/queues.md) | ✓ | ✓ (Plus) | ✓ | | LD, TD | **Done** 2026-10-26 |
| [Workflow](emitters/workflow.md) | ✓ | ✓ (Plus) | ✓ | | LD, TD, OTLP | **Done** 2026-10-26 |
| [AI Gateway](emitters/ai-gateway.md) | | ✓ (Plus) | ✓ | Generation API | AGD, API | **Done** 2026-10-26 (fallback in production: not observed) |
| [Agent Runs (eve, agent harnesses)](emitters/agent-runs.md) | | | ✓ | | TD, OTLP | **Done** 2026-10-26 |
| [Sandbox](emitters/sandbox.md) | | ✓ (Plus) | | Per-sandbox usage | API | **Done** 2026-10-27 (spans: not observed) |
| [Blob](emitters/blob.md) | | | via OTLP from code | Usage, billing | API, OTLP | **Done** 2026-10-27 |
| [Global Config (formerly Edge Config)](emitters/global-config.md) | | | via OTLP from code | Usage, billing | API, OTLP | **Done** 2026-10-27 |
| [Flags](emitters/flags.md) | | ✓ | ✓ | Evaluations, webhooks | TD, AD, WH, API | **Done** 2026-10-27 |
| [Speed Insights](emitters/speed-insights.md) | | ✓ | | Web Vitals per page view | SID | **Done** 2026-10-27 |
| [Web Analytics](emitters/web-analytics.md) | | ✓ | | Page views, custom events | AD | **Done** 2026-10-26 |
| [AI traffic (crawlers, assistants)](emitters/ai-traffic.md) | | ✓ (Plus) | | | — | **Done** 2026-10-26 (no recognized AI bot on the lab project yet) |
| [Custom Metrics](emitters/custom-metrics.md) | | ✓ (Plus) | | | — | **Done** 2026-10-27 |
| [Alerts and monitors](emitters/alerts.md) | | | | ✓ | WH, API | **Done** 2026-10-26 (no alert fired by 2026-11-12; custom monitors since 2026-10-26) |
| [Vercel Connect](emitters/vercel-connect.md) | | ✓ (Plus) | | Token and trigger events | Drain (`connect`) | **Done** 2026-10-27 (drain records: not observed; project-filtered drain since 2026-10-28, project has no connector) |
| [Audit Logs and the Activity Log](emitters/audit-logs.md) | ✓ | | | Team activity events | Drain (`audit_log`, Enterprise), API | **Done** 2026-10-27 (audit drain: Enterprise only) |
| [Billing and usage](emitters/billing.md) | | | | FOCUS cost records | API | **Done** 2026-10-26 (no backend queries yet: needs a forwarder) |
| [Spend Management](emitters/spend-management.md) | | | | Budget alerts | WH, API | **Done** 2026-10-27 (`budget.reached` payload: documented; needs a budget webhook) |
| [Daemons](emitters/daemons.md) | ✓ (not in drains) | | from code; `@vercel/otel` socket path (destination undocumented) | | OTLP | **Done** 2026-10-27 |
| [Vercel Drives](emitters/vercel-drive.md) | | ✓ (Plus) | via Sandbox SDK spans | Usage, billing | TD | **Done** 2026-10-27 |

### Libraries and client scripts

| Emitter | Emits | Exit paths | Entry |
| --- | --- | --- | --- |
| [Next.js and `@vercel/otel`](emitters/nextjs-and-vercel-otel.md) | Framework spans, fetch spans, context propagation | TD, OTLP | **Done** 2026-10-26 |
| [AI SDK (`ai`, `@ai-sdk/otel`)](emitters/ai-sdk.md) | GenAI spans, `gen_ai.client.inference.duration` histogram (OTLP metrics) | TD, OTLP | **Done** 2026-10-26 |
| eve, durable-harness | Agent spans | TD, OTLP | Covered in [Agent Runs](emitters/agent-runs.md) |
| `@vercel/analytics` | Page views, custom events | AD | Covered in [Web Analytics](emitters/web-analytics.md) |
| `@vercel/speed-insights` | Web Vitals | SID | Covered in [Speed Insights](emitters/speed-insights.md) |
| `@vercel/functions` (`metric()`, `waitUntil`) | Custom metrics, `waitUntil` spans | — | Covered in [Custom Metrics](emitters/custom-metrics.md) and [Functions](emitters/functions.md) |
| Flags SDK | `flag` spans, flag values on Web Analytics | TD, AD | Covered in [Flags](emitters/flags.md) |
| [Turborepo](emitters/turborepo.md) | Run and task metrics (OTLP) | OTLP | **Done** 2026-10-27 (Remote Cache hits: need `turbo link`) |

### Reference

- [`reference/inventory-sweep-2026-10-27.md`](reference/inventory-sweep-2026-10-27.md): every Vercel CLI command and product checked for telemetry, with candidates for new entries (Daemons, Spend Management, Schedules).
- [`reference/vercel-metrics-schema.json`](reference/vercel-metrics-schema.json): all 111 platform metrics with their dimensions, units and aggregations (Vercel CLI 65.14.0, 2026-11-12). New since CLI 65.2.0 (2026-10-26): `vercel.span.duration_ms`, `vercel.ai_gateway.request.billed_cost`, `vercel.ai_gateway.request.succeeded_requests`.

## Cross-cutting findings

- **Send each span once.** On Vercel, `@vercel/otel` and eve export to Vercel's collector (which feeds the trace drain) and also to any OTLP endpoint you configure. With both, every span arrives twice with the same span ID. Still the case on 2026-11-12: the trace-drain check in `@vercel/otel` 2.3.0 is unchanged. See [Functions](emitters/functions.md#4-getting-it-out) and [Next.js and `@vercel/otel`](emitters/nextjs-and-vercel-otel.md).
- **The trace drain was incomplete for queue-triggered work** (84% of Workflow invocations on 2026-10-25), and complete for direct requests. No change in Vercel's docs or releases by 2026-11-12. See [Functions](emitters/functions.md#4-getting-it-out).
- **Tracing and trace drains sample separately** (Vercel Tracing, generally available since 2026-11-06). With no rules, Vercel Tracing collects nothing while a trace drain forwards everything. Trace retention in Vercel is now 3 days on Hobby and 14 days on Pro and Enterprise. See [Next.js and `@vercel/otel`](emitters/nextjs-and-vercel-otel.md).
- **Billing records changed shape without a version bump.** Since early November 2026 the FOCUS lines carry the team ID and new columns, and billing days start at midnight `America/Los_Angeles` (08:00 UTC in winter). Parse by column name. See [Billing](emitters/billing.md).
- **Drains and Vercel's metrics agree** wherever both exist: function invocations, duration and memory, middleware invocations, cache states, redirects, firewall denies, Web Analytics events, AI Gateway requests and cost.

## Layout

```
emitters/<slug>.md      one entry per emitter, five sections + gotchas
samples/<slug>/         captured records, redacted (see METHOD.md)
reference/              machine-readable catalogs from Vercel
```

## License

A community project from Bronto; not an official product of, or endorsed by, Vercel. Licensed under the [Apache License 2.0](LICENSE).
