# Next.js and `@vercel/otel`

> Next.js traces itself: with `registerOTel()` from `@vercel/otel` in `instrumentation.ts`, every request gets framework spans (`GET /route`, `middleware GET`, `render route (app) /`, `executing api route (app) /…`, `resolve segment modules`, `start response`) and a `fetch GET <url>` span for every outgoing call. On Vercel these spans join the platform's own trace under `Invoke Function` and leave through the trace drain with no extra setup. `propagateContextUrls` adds `traceparent` to calls to the hosts you list, and in the lab that turned one cron request into a single trace running from Vercel's edge through the Next.js route into Caddy, Spring PetClinic and its SQL queries. The trap: `@vercel/otel` exports to Vercel **and** to any OTLP endpoint in `OTEL_EXPORTER_OTLP_ENDPOINT`, so a project that has both a trace drain and that variable sends every app span twice (8,623 and 8,617 copies of the same spans on one day in the lab).

| | |
| --- | --- |
| Kind | Library (Next.js built-in tracing, `@vercel/otel`) |
| Plans | All plans; the trace drain needs Pro or Enterprise |
| Signals | Traces |
| Exit paths | Trace drain · OTLP from code (`OTEL_EXPORTER_OTLP_*`) |
| Verified | 2026-10-26 · Next.js 16.3.6 · `@vercel/otel` 2.1.3 · `@opentelemetry/api` 1.9.1 · lab project `petclinic-agent`, service `petclinic-web` |

## 1. What it emits

| Signal | What | Where it lives | Retention |
| --- | --- | --- | --- |
| Traces | Next.js framework spans, `fetch` client spans, spans from libraries that use the OpenTelemetry API (better-auth, Workflow SDK, AI SDK in the lab) | Observability › Tracing, trace drain, your OTLP endpoint | As for Vercel traces (Documented: Hobby 1 h, Pro 1 day, Enterprise 3 days) |

The lab's setup (`apps/web/instrumentation.ts`):

```ts
registerOTel({
  serviceName: "petclinic-web",
  attributes: { "service.namespace": "petclinic-agent" },
  instrumentationConfig: {
    fetch: { propagateContextUrls: [petclinicOrigin, "https://ai-gateway.vercel.sh"] },
  },
});
```

No `NEXT_OTEL_VERBOSE`, no `NEXT_OTEL_FETCH_DISABLED`, no `onRequestError` (Observed: project environment and code).

## 2. Out-of-the-box shape

### Span names

Spans of `service.name = petclinic-web` over 7 days (Observed, `.traces/petclinic-web`):

| Span name | `next.span_type` | Kind | Count | What it is |
| --- | --- | --- | --- | --- |
| `GET /`, `GET /api/synthetic`, `POST /api/vercel-webhook` | `BaseServer.handleRequest` | SERVER | 32,000 | Root of the app's part of a request. Named method + route pattern |
| `middleware GET`, `middleware POST` | `Middleware.execute` | INTERNAL | 73,016 | The Next.js 16 `proxy.ts`; still named `middleware` |
| `executing api route (app) /api/synthetic` | `AppRouteRouteHandlers.runHandler` | INTERNAL | 9,012 | A route handler |
| `render route (app) /` | `AppRender.getBodyResult` | INTERNAL | 10,776 | Rendering a page |
| `build component tree` | `NextNodeServer.createComponentTree` | INTERNAL | 10,776 | |
| `NextNodeServer.clientComponentLoading` | same | INTERNAL | 10,776 | The span name is the type |
| `resolve segment modules` | `NextNodeServer.getLayoutOrPageModule` | INTERNAL | 21,552 | Loading layout and page modules |
| `start response` | `NextNodeServer.startResponse` | INTERNAL | 28,929 | Zero-length marker for the first byte |
| `prerender route (app) /vets` | | INTERNAL | 3,053 | |
| `fetch GET https://…/petclinic/api/vets` | none | CLIENT | 72,632 client spans in all | From `@vercel/otel`'s fetch instrumentation |

`build component tree` and `NextNodeServer.clientComponentLoading` appear without `NEXT_OTEL_VERBOSE`. Not seen: `resolve page components`, `generateMetadata`, and Next.js's own `AppRender.fetch` spans; every `fetch` span came from `@vercel/otel` (`operation.name: fetch.GET`, no `next.span_type`). Other spans in the same service come from libraries: `GET /get-session` and `handler /get-session` (better-auth), `world.*` and `workflow.*` (Workflow SDK), `invoke_agent …` and `step 1` (AI SDK).

### Attributes

A root span (Captured: `span-handle-request.json`). Resource attributes set by `@vercel/otel`, the same on every span of a deployment:

| Attribute | Example | Note |
| --- | --- | --- |
| `service.name`, `service.namespace` | `petclinic-web`, `petclinic-agent` | From `registerOTel` |
| `service.version` | `dpl_zA9h4XmaGkY15VUuTXZcv1aMnzyP` | The deployment ID |
| `deployment.id`, `vercel.deployment_id` | same | |
| `deployment.environment.name`, `env` | `production` | |
| `cloud.provider`, `cloud.region` | `vercel`, `dub1` | Where the code ran: `iad1` on middleware spans, `dub1` on function spans |
| `vcs.ref.head.name`, `vcs.ref.head.revision`, `vcs.repository.name` | `main`, `abd0ee3e…`, `petclinic-agent` | Plus the older `vcs.repository.ref.revision` and `vercel.sha` |
| `vercel.project_id`, `vercel.host`, `vercel.branch_host`, `vercel.region`, `vercel.runtime` | | |
| `process.runtime.name`, `node.env` | `nodejs`, `production` | |

Span attributes on the root span: `http.method`, `http.route`, `http.target`, `http.status_code`, `http.host`, `http.user_agent`, `next.route`, `next.rsc`, `next.span_name`, `next.span_type`, `next.span_category`, `operation.name`, `resource.name`, `vercel.request_id` (same as the log drain's `requestId`), `vercel.edge_region`, `vercel.matched_path`. These use the older HTTP conventions (`http.method`, `http.status_code`); Vercel's edge spans in the same trace use `http.response.status_code`.

A `fetch` span (Captured: `span-fetch-petclinic.json`): `http.url`, `http.method`, `http.host`, `http.scheme`, `http.status_code`, `net.peer.name`, `http.response_time`, `http.response_content_length_uncompressed`.

### Status and errors

| Case | Span status | Evidence |
| --- | --- | --- |
| Route handler throws (`/api/chaos`, 500) | `STATUS_CODE_ERROR` on `GET /api/chaos` and on `executing api route`, with an `exception` event carrying message and stack | 10 of each in 7 days (Captured: `span-api-route-error.json`) |
| Route returns 4xx | `UNSET` | `GET /api/chaos` with 401 |
| `fetch` gets 404 or 403 | `UNSET` | 1,461 and 487 spans |
| `fetch` gets 502 or 504 | `ERROR` | 2 and 1 spans |

`onRequestError` (an export from `instrumentation.ts` that Next.js calls with the error, the request and the route context for every server error) is Documented only: the lab doesn't use it.

### One trace across Vercel and PetClinic

A cron request to `/api/synthetic` whose route handler calls PetClinic (Captured: `trace-propagation-petclinic.ndjson`, 41 spans, trace `85bd2aaeaaaec285662fc110f8bd8223`):

```
GET /api/synthetic                              vercel.edge-network        49.8 s
└─ Invoke Function                              vercel.serverless-runtime
   ├─ Spawn Node.js · Init User Code            vercel.serverless-runtime  185 ms · 146 ms (cold start)
   └─ GET /api/synthetic                        petclinic-web              49.3 s
      └─ executing api route (app) /api/synthetic
         ├─ fetch GET https://petclinic-…/petclinic/api/vets          25.5 ms
         │  └─ caddy                            caddy                       6.2 ms
         │     └─ GET /petclinic/api/vets       petclinic (Spring)          5.7 ms
         │        └─ SpringDataVetRepository.findAll
         │           └─ select vets · select vet_specialties ×6   (PostgreSQL)
         ├─ fetch GET https://petclinic-…/petclinic/api/owners?lastName=Smith
         │  └─ caddy → GET /petclinic/api/owners → findByLastName → select owners pets
         ├─ fetch GET https://petclinic-agent.vercel.app/vets          (no children)
         └─ fetch POST https://petclinic-agent.vercel.app/eve/v1/session (no children)
```

- The PetClinic URL is in `propagateContextUrls`, so `fetch` sent `traceparent` and Caddy and the Java agent continued the trace (Observed).
- The calls to the production alias `petclinic-agent.vercel.app` have no children. `@vercel/otel` propagates by default only to the deployment's own generated URLs (Documented in its README), and the alias is not one. The requests they caused were traced as separate traces: all 5,945 `GET /vets` edge spans in 7 days are roots (Observed).

## 3. Extras beyond the default

| Extra | What it adds |
| --- | --- |
| `propagateContextUrls` | `traceparent` on `fetch` calls to the listed URL prefixes or regexes; `dontPropagateContextUrls` excludes, `ignoreUrls` stops tracing a URL (Documented) |
| `attributes` in `registerOTel` | Extra resource attributes on every span (`service.namespace` in the lab) |
| `NEXT_OTEL_VERBOSE=1` | More Next.js spans (Documented; not set in the lab) |
| `NEXT_OTEL_FETCH_DISABLED=1` | Turns off Next.js's own fetch spans (Documented) |
| `onRequestError` in `instrumentation.ts` | A hook for every server error with route context (Documented) |
| Libraries on the OpenTelemetry API | Their spans join the request trace with no extra setup (better-auth, Workflow SDK, AI SDK `registerTelemetry` in the lab) |

## 4. Getting it out

`registerOTel()` with the default (`"auto"`) span processor sets up, in `@vercel/otel` 2.1.3 (read from the package source, behaviour confirmed by the lab data below):

1. Always, a Vercel exporter that hands the spans to the function's runtime. Vercel puts them into its own trace and the trace drain, under `Invoke Function`.
2. If `VERCEL_OTEL_ENDPOINTS` is set (an observability integration), an OTLP exporter to the local Vercel collector.
3. Otherwise, if `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` or `OTEL_EXPORTER_OTLP_ENDPOINT` is set, an OTLP exporter to that endpoint (`http/protobuf` by default, headers from `OTEL_EXPORTER_OTLP_HEADERS`).

| Path | What leaves | Cost on Vercel |
| --- | --- | --- |
| Trace drain (schema `trace` v1, `otlphttp`, `proto`) | App spans inside the full request trace, with the edge and runtime spans | Drains Volume ($0.50 per GB), and Tracing Spans ($0.50 per 1M span units) for the project (Observed in billing; the bill doesn't split app from infrastructure spans) |
| OTLP from code (`OTEL_EXPORTER_OTLP_*`) | App spans only; the trace is missing its edge and runtime spans | None from Vercel |

**The lab sends `petclinic-web` spans both ways.** The project has `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS` set for Production (for the eve agent, which shares the project) and a trace drain. On 2026-10-25, 8,623 `petclinic-web` spans arrived over OTLP and 8,617 through the drain, with the same span IDs (`05c904f4e070ab45`, `c6e5739e2020c894` and the rest of request `wg6xg-1793009254408-be09daa615d3`) (Observed). The drain copy carries three more attributes, `vercel.projectId`, `vercel.deploymentId` and `vercel.ownerId`; everything else is identical (Captured: `span-handle-request-drain-copy.json`). This corrects research I, which listed `petclinic-web` as OTLP-only.

Send each span once. With `@vercel/otel` the trace drain is the path that keeps the app spans inside Vercel's request trace, so on Vercel the usual choice is the drain alone, with no `OTEL_EXPORTER_OTLP_*` in the Next.js app's environment. In the lab the variables are set once for the project, which holds both the eve service and the Next.js app, so they reach both. The two ways out are to drop the trace drain (and lose the infrastructure spans) or to keep the variables away from the Next.js app. Neither was tested (it needs a configuration change).

What can't leave: nothing. Every span Next.js creates is exportable; the infrastructure spans come only through the drain (see the Functions entry).

## 5. In Bronto

| Data | Dataset | Field names |
| --- | --- | --- |
| App spans via OTLP | `.traces/petclinic-web` (dataset per `service.name`) | Attributes with a `$` prefix: `"$next.route"`, `"$span.trace_id"` |
| App spans via the trace drain | `.traces/vercel-traces`, `"$service.name" = 'petclinic-web'` | Same |
| PetClinic spans | `.traces/petclinic`, `.traces/caddy` | Same |

Queries against the lab's last 7 days, run 2026-10-26:

| Question | Query (dataset) | Group by | Result |
| --- | --- | --- | --- |
| Average duration per route | `"$next.span_type" = 'BaseServer.handleRequest'`, `avg("$span.duration_nano")` (`petclinic-web`) | `"$next.route"` | `/api/synthetic` 20,025.6 ms · `/.well-known/workflow/v1/flow` 7,918.4 ms · `/api/visit-note` 2,430.2 ms · `/vets` 55.0 ms · `/` 42.9 ms |
| Which routes threw? | `"$span.status_code" = 'STATUS_CODE_ERROR'` (`petclinic-web`) | `"$next.span_type"` | `BaseServer.handleRequest` 10 · `AppRouteRouteHandlers.runHandler` 10 · other 78 (libraries) |
| Outgoing calls by host and status | `"$operation.name" LIKE 'fetch.%'` (`petclinic-web`) | `"$http.host"`, `"$http.status_code"` | `petclinic-agent.vercel.app` 200: 31,488 · PetClinic 200: 11,819 · PetClinic 404: 1,461 · `ai-gateway.vercel.sh` 200: 169 |
| One trace end to end | `"$span.trace_id" = '85bd2aaeaaaec285662fc110f8bd8223'` | | 12 spans in `petclinic-web`, 17 in `petclinic`, 22 in `vercel-traces` (10 infrastructure + the 12 app spans again) |
| Spans sent twice | `"$vercel.request_id" = 'wg6xg-1793009254408-be09daa615d3'` (`vercel-traces`) | | The edge span plus `middleware GET` and `GET /api/synthetic`, the same span IDs as in `petclinic-web` |

## Gotchas

1. **Two exporters from one call.** `registerOTel()` always exports to Vercel. Its automatic OTLP exporter is added as well: to `OTEL_EXPORTER_OTLP_ENDPOINT` if set, otherwise to `http://localhost:4318/v1/traces`. The 2.1.3 source wraps that exporter in a check meant to skip it when the request has trace drains (`skipping automatic exporter due to configured trace drains`), but in the lab the check didn't take effect: every app span arrived twice (Observed: 8,623 exported versus 8,617 drained on 2026-10-25, same span IDs). Reported to Vercel on 2026-10-26. Until that's resolved, a project with a trace drain shouldn't also set `OTEL_EXPORTER_OTLP_ENDPOINT` for traces.
2. **Default propagation stops at your own production domain.** Only the deployment's generated URLs get `traceparent` by default. Calls to the production alias or a custom domain of the same app start new traces unless the URL is in `propagateContextUrls` (Observed).
3. **`proxy.ts` is traced as `middleware GET`.** Next.js 16 renamed the file, not the span (Captured: `span-middleware.json`).
4. **4xx is not an error.** Root and `fetch` spans keep `UNSET` for 4xx; only thrown errors and 5xx from `fetch` set `ERROR`. Count 4xx from `"$http.status_code"` (Observed).
5. **`cloud.region` follows the code.** Middleware spans say `iad1` while the function spans of the same request say `dub1`, because middleware runs where the request entered.
6. **Old and new HTTP attribute names in one trace.** Next.js spans have `http.status_code`; Vercel's edge spans have `http.response.status_code`. Queries across both need both names.

## Samples

| File | What it shows |
| --- | --- |
| [`span-handle-request.json`](../samples/nextjs-and-vercel-otel/span-handle-request.json) | Root Next.js span (`BaseServer.handleRequest`) via OTLP, all resource attributes |
| [`span-handle-request-drain-copy.json`](../samples/nextjs-and-vercel-otel/span-handle-request-drain-copy.json) | The same span as delivered by the trace drain |
| [`span-middleware.json`](../samples/nextjs-and-vercel-otel/span-middleware.json) | `middleware GET` from `proxy.ts`, region `iad1` |
| [`span-render-route.json`](../samples/nextjs-and-vercel-otel/span-render-route.json) | `render route (app) /` |
| [`span-resolve-segment-modules.json`](../samples/nextjs-and-vercel-otel/span-resolve-segment-modules.json) | `resolve segment modules` |
| [`span-start-response.json`](../samples/nextjs-and-vercel-otel/span-start-response.json) | Zero-length `start response` |
| [`span-api-route-error.json`](../samples/nextjs-and-vercel-otel/span-api-route-error.json) | A throwing route handler: `ERROR` status, exception event with stack |
| [`span-fetch-petclinic.json`](../samples/nextjs-and-vercel-otel/span-fetch-petclinic.json) | `fetch` client span to PetClinic |
| [`trace-propagation-petclinic.ndjson`](../samples/nextjs-and-vercel-otel/trace-propagation-petclinic.ndjson) | 41 spans of one request: Vercel edge and runtime, Next.js, Caddy, Spring PetClinic, SQL |

## Sources

- Docs, read 2026-10-26: Next.js [OpenTelemetry guide](https://nextjs.org/docs/app/guides/open-telemetry) (last updated 2026-10-22), [`instrumentation.ts` and `onRequestError`](https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation); Vercel [Instrumentation](https://vercel.com/docs/tracing/instrumentation) (last updated 2026-09-15), [Trace Drains reference](https://vercel.com/docs/drains/reference/traces); `@vercel/otel` 2.1.3 README and `dist/node/index.js` (export setup).
- Lab: Bronto EU datasets `.traces/petclinic-web`, `.traces/vercel-traces`, `.traces/petclinic`, `.traces/caddy`, 2026-10-19 to 2026-10-26; `vercel env ls` (variable names only); lab code `apps/web/instrumentation.ts`, `apps/web/proxy.ts`.
