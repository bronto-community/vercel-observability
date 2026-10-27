# Lab notes

Deployed 2026-10-26 to team `brontoio`, project `vercel-observability-lab` (`prj_Y3RSmZp5SNQvB6FhLb0LMH4HPWSM`), production, functions in `dub1`. URL: https://vercel-observability-lab.vercel.app

Versions: Vercel CLI 65.2.0, Next.js 16.4.3, React 19.3.1, `@vercel/otel` 2.1.3, `@vercel/blob` 2.8.2, `@vercel/global-config` 1.5.1, `flags` 4.4.0, `@flags-sdk/vercel` 1.5.3, `@vercel/functions` 3.10.3, `botid` 1.5.11, `@vercel/sandbox` 3.9.0, `@vercel/analytics` 2.0.1, `@vercel/speed-insights` 2.0.0, Node.js 24.

All times UTC. `vercel` below means `npx vercel@65.2.0` run from this folder (linked project).

## Setup done from the CLI

| What | Command | Result |
| --- | --- | --- |
| Project | `vercel project add vercel-observability-lab --scope brontoio`, `vercel link` | Created; `vercel.json` sets `framework: nextjs`, `regions: ["dub1"]` |
| Blob store | `vercel blob create-store vercel-observability-lab-blob --access public --region dub1 --yes` | `store_186lljFsKYsfqxFe`, connected; adds `BLOB_READ_WRITE_TOKEN` |
| Global Config store | `vercel global-config create vercel-observability-lab --items '{"greeting":…}'` | `ecfg_nk7b2edicaf9ovzskhnsxs7qwtkt`. The CLI can't connect a store to a project, so a read token was created (`vercel global-config tokens … --add`) and the connection string stored as the sensitive env var `GLOBAL_CONFIG` (all environments) |
| Flag | `vercel flags create lab-flag --kind boolean`, `vercel flags enable lab-flag --environment production` | `flg_8Lee0SAdhpTEKdrGSA2BYdGSYtYk`; activation added `FLAGS_SECRET` per environment |
| Sandbox secret | `vercel env add LAB_SECRET production` | Random value, sensitive, stored only in Vercel |
| Web Analytics | `vercel project web-analytics enable` | Enabled |
| Tracing | `vercel traces config set 100 --environment any` | Same rule as `petclinic-agent`. Before it, `vercel traces search` returned 0 spans for the project |
| Speed Insights | not enabled from the CLI | Vitals were recorded anyway (see below) |

## Traffic

- `curl` of every API route several times (Blob 9, Global Config 9, metric 9, BotID 5 plain POSTs).
- Headless Chrome (Playwright, system Chrome): 3 rounds of `/`, `/flags` (with the button click), `/image`, `/botid` (button posts to `/api/botid`). Runs with the `navigator.webdriver` flag on and off.
- `/api/sandbox`: 2 runs with the secret, 1 with a wrong secret (`401`).

## Per product

### Vercel Blob

- Function log (`vercel logs --since 30m --json`): our own line `{"msg":"blob roundtrip",…}` per request, `source: function`, with `traceId`/`spanId`.
- Spans (`vercel traces search --project vercel-observability-lab --json`): `GET /api/blob` (~1.2 s) with no child span for the four Blob calls. `@vercel/otel`'s fetch instrumentation does not see them.
- Metrics: no Blob metric in `vercel metrics schema`; the Blob calls do not appear in `vercel.external_api_request.count` either (grouped by host, route, path: only BotID and Sandbox calls are there).
- Store: `vercel blob get-store store_186lljFsKYsfqxFe` shows count and size only (0 objects, since each request deletes its object). Operation counts: dashboard Usage only (not checked).

### Global Config

- Function log: `{"msg":"global config read","key":"greeting","found":true}` per request.
- Spans: `GET /api/config` (~3 ms), no child span; no outgoing request recorded in `vercel.external_api_request.count`.
- Metrics: none in `vercel metrics schema`. `vercel global-config inspect` returns metadata only (size, item count, digest). Read counts: dashboard only (not checked).

### Flags (Flags SDK + Vercel adapter)

- Span: `flag` with `key=lab-flag`, `method=decided`, `operation.name=flags` (3 of 3 traced `/flags` requests), from `setTracerProvider` in `instrumentation.ts`.
- `vercel flags evaluations lab-flag` (last hour): `true: On 23`.
- Web Analytics: page views carry the flag (`f: {"p":{"lab-flag":true}}` in the `/view` beacon). `vercel metrics vercel.analytics.page_view.count --group-by route --group-by flags --since 2h` → `/flags, lab-flag: 14`.
- Custom event with the flag: `vercel metrics vercel.analytics.event.count --group-by eventName --group-by flags` → `Flag button clicked, lab-flag: 3` (plus `Manual probe: 1`, a debugging call from the browser console).
- Gotcha: calling `track()` from a `useEffect` on page load sent nothing. The `<Analytics />` component's queue (`window.va`) did not exist yet, and `track()` drops the event silently when it is missing. Fixed by sending the event from a button click.
- `/.well-known/vercel/flags` was invoked twice by Vercel (Flags Explorer discovery).

### Image Optimization

- `vercel metrics vercel.image_transformation.count --group-by optimizedFormatMimeType --group-by optimizedWidthPixels --group-by httpStatus --since 2h`: 5 transformations (webp at 256, 384, 640 px; 96 and 128 px with an empty format, requested without an `image/webp` Accept header), all `200`. Only cache misses count; repeat requests were not transformations.
- `source_size_bytes` avg 139,369 (the PNG), `optimized_size_bytes` avg 3,156.
- No spans or function logs for `/_next/image` requests.

### Custom Metrics

- `vercel metrics schema lab.orders.created`: unit `count`, aggregations count…stddev, dimensions `ownerId, projectId, deploymentId, functionRegion, pathType, edgeNetworkRegion, plan` (`plan` is our attribute).
- `vercel metrics lab.orders.created -a sum --group-by plan --group-by functionRegion --since 2h` → `pro/dub1 7`, `free/dub1 2` (9 requests).
- No log line or span for the metric itself.

### BotID

- `vercel metrics vercel.bot_id_check.count --group-by botCheckResult --group-by route --since 2h` → `Bot 11`, `Human 13`, all on `/api/botid`. Dimensions include `botCheckResult`, `deepAnalysisCheck`, `clientJa4Digest`, `asnName`.
- Span: `fetch POST https://api.vercel.com/bot-protection/v1/is-bot?v=3` under `POST /api/botid`; also in `vercel.external_api_request.count` (14 at the time of the query, `requestPath /bot-protection/v1/is-bot`).
- Logs: plain `curl` POSTs (no BotID headers) produced a platform warning in the function log: "Possible misconfiguration of Vercel BotId or malicious request to 'POST /api/botid'", level `warn`.
- Verdicts: curl → Bot; headless Chrome with `navigator.webdriver` set → Bot; headless Chrome with `--disable-blink-features=AutomationControlled` → Human (basic mode; Deep Analysis not enabled).

### Vercel Sandbox

- `vercel metrics vercel.sandbox.cpu_total_time_ms -a sum --group-by sandboxName --since 2h` → `beige-dirty-cardinal-P4qDoP 635`, `aquamarine-colourful-quokka-z45VGz 644`. Dimensions: `projectId, sandboxSessionId, sandboxName`.
- `vercel.sandbox.memory_requested_gb_hr` sum 0.00056; `public_egress_bytes` and `public_ingress_bytes` no data (no network use).
- Outgoing API calls in `vercel.external_api_request.count`: `POST /api/v3/sandboxes`, `…/sessions/<id>/cmd` (2 per run), `…/stop` on `vercel.com`.
- Function log: our `{"msg":"sandbox run",…}` line. The Sandbox ran in the project's Sandbox region `iad1` (project setting), the function in `dub1`.

### Web Analytics and Speed Insights

- Page views: `/ 12, /botid 6, /flags 6, /image 6` in the first hour (`vercel.analytics.page_view.count --group-by route`).
- The analytics script sends nothing from headless Chrome while `navigator.webdriver` is set; page views appeared only after disabling that flag. Correction 2026-10-27: disabling the flag isn't enough on its own. With the default `HeadlessChrome/156` user agent no beacons were sent; the page views counted here came from runs with a regular Chrome user agent.
- Speed Insights: `vercel.speed_insights.lcp_ms` has samples (`/ 26, /botid 13, /flags 13, /image 13` counts) although `vercel project speed-insights enable` was never run.

### Functions (all routes)

- `vercel metrics vercel.function_invocation.count --group-by route --group-by functionRegion --since 1h`: every route in `dub1`.
- In `vercel logs --json`, `region` is the edge region (`fra1` from this client), not the function region.
