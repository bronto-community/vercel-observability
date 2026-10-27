# vercel-observability-lab

A small Next.js app that makes Vercel products emit telemetry, so their records can be captured for the catalog in the parent folder. Each product gets one route. Everything runs at demo scale.

| Route | Product | What it does | Where the telemetry shows up |
| --- | --- | --- | --- |
| `/api/blob` | Vercel Blob | `put`, `head`, `list`, `del` of one small text object | Function logs; one undici client span per Blob call; Blob usage in the dashboard |
| `/api/config` | Global Config (formerly Edge Config) | Reads the key `greeting` | Function logs; a `get` span from the SDK; Global Config usage in the dashboard |
| `/flags` | Flags SDK with the Vercel adapter | Evaluates the boolean flag `lab-flag`, renders `<FlagValues>`, and has a button that sends a Web Analytics custom event naming the flag | `flag` span, `vercel flags evaluations`, flag values on Web Analytics page views and events |
| `/image` | Image Optimization | Renders a local PNG through `next/image` (`/_next/image`) | `vercel.image_transformation.*` metrics |
| `/api/metric` | Custom Metrics | `metric("lab.orders.created", 1, { plan })` from `@vercel/functions` | `vercel metrics lab.orders.created` |
| `/botid` → `POST /api/botid` | BotID | The page posts to the API route, which calls `checkBotId()` | `vercel.bot_id_check.count`, a fetch span to the BotID API |
| `/api/sandbox?secret=…` | Vercel Sandbox | Creates a 1-vCPU, non-persistent Sandbox, runs `echo hello` and `node -v`, stops it | `vercel.sandbox.*` metrics |
| `/api/drive` (header `Authorization: Bearer <LAB_SECRET>`) | Vercel Drives | Gets or creates the drive `lab-drive` in `iad1`, mounts it in a 1-vCPU Sandbox, writes one small file, reads all files, stops the Sandbox | `vercel.drive.*` and `vercel.sandbox.*` metrics, client spans for the SDK calls |
| `POST /api/vercel-webhook` | Vercel webhooks (e.g. Spend Management) | Verifies `x-vercel-signature` with `VERCEL_WEBHOOK_SECRET` and logs the payload as one JSON line; `503` while the secret isn't set | Function logs |

Every page loads `@vercel/analytics` and `@vercel/speed-insights`. `instrumentation.ts` registers `@vercel/otel` with the service name `vercel-observability-lab`, replaces its default fetch instrumentation with `@opentelemetry/instrumentation-undici` (which also sees libraries that bundle their own undici, such as `@vercel/blob`), sets `NEXT_OTEL_FETCH_DISABLED=1` so Next.js doesn't add a second span per `fetch`, and hands the tracer provider to the Flags SDK and the Global Config SDK. It configures no exporter: spans leave Vercel only through a trace drain, so each span is sent once.

## Deploy

Requires Node.js 24, pnpm and the Vercel CLI.

```sh
pnpm install
vercel link                                    # create or pick the project
vercel blob create-store <name> --access public --yes
vercel global-config create <slug> --items '{"greeting":"hello"}'
# Connect the Global Config store to the project (dashboard: Storage > Connect),
# or create a read token and add the connection string as GLOBAL_CONFIG.
vercel flags create lab-flag --kind boolean --description "Boolean flag for the lab"
vercel flags enable lab-flag --environment production
vercel env add LAB_SECRET production --sensitive  # any random string; protects /api/sandbox and /api/drive
vercel project web-analytics enable
vercel project speed-insights enable           # optional, see NOTES.md
vercel traces config set 100 --environment any # keep every trace
vercel deploy --prod
```

The Sandbox and Drive routes answer `401` without the secret, so strangers can't start paid VMs.

### Optional: a daemon

`daemons/heartbeat/` is a minimal [Vercel Daemon](https://vercel.com/docs/daemons) (a container that logs one JSON line per minute). To run it, add this to `vercel.json` and deploy to production; remove it and deploy again to stop it (it is billed while it runs):

```json
"daemons": {
  "heartbeat": {
    "root": "daemons/heartbeat/",
    "entrypoint": "Dockerfile",
    "instances": { "dub1": 1 },
    "resources": { "requests": { "memory": "1Gi" } },
    "terminationGracePeriodSeconds": 5
  }
}
```

## Getting the telemetry out

Drains are configured in the Vercel dashboard (Team Settings > Drains), not in this code. To capture everything, create one drain per data type for this project, pointing at any OTLP or HTTP backend (Bronto is one example):

- Logs: log drain, all sources.
- Traces: trace drain, OTLP over HTTP.
- Web Analytics: analytics drain.
- Speed Insights: Speed Insights drain.

Metrics such as `vercel.image_transformation.*`, `vercel.bot_id_check.count`, `vercel.sandbox.*`, `vercel.drive.*` and custom metrics have no drain; query them with `vercel metrics` (Observability Plus).

## License

Apache License 2.0, as the repository.
