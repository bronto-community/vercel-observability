# Vercel Drives (Sandbox)

> A Drive emits no logs and no spans of its own. In the lab, three Sandbox runs that each wrote one small file to a drive and read back every file on it left the following: the app's own log line, client spans for the SDK's API calls (one `POST /api/v2/sandboxes/drives/<name>` per `Drive.getOrCreate()`, with an undici instrumentation), and read bytes in `vercel.drive.read_bytes` split by `cacheResult` (`hit` 16,384 bytes, `miss` 49,152 bytes). `vercel.drive.write_bytes` stayed empty although every run wrote a file. Neither metric has a drain; querying them needs Observability Plus. The trap: the metric's `driveId` is not the drive ID the API and SDK use. It is `<projectId>_<region>_<driveId>`, so a join against the drives API needs the prefix stripped. Usage also appears as three billing lines (Drive Storage, Reads, Writes) per region.

| | |
| --- | --- |
| Kind | Platform service (storage for Vercel Sandbox), used through `@vercel/sandbox`, the Python SDK or the `sandbox` CLI |
| Plans | All plans since GA on 2026-10-15. Hobby: 15 GB storage (lifetime), 30 GB reads and 30 GB writes per month included, drives up to 1 GiB. Pro and Enterprise: by usage, $0.05/GB-month storage, $0.0015/GB read, $0.004/GB write in `iad1`, other regions differ (Documented) |
| Signals | Metrics (inside Vercel only) · billing lines · API objects (drives) · the calling function's spans and logs |
| Exit paths | `vercel metrics` pull · `vercel usage` / `GET /v1/billing/charges` pull · `GET /v2/sandboxes/drives` pull · trace and log drain for the calling function only |
| Verified | 2026-10-27 · Vercel CLI 65.2.0 · `@vercel/sandbox` 3.9.0 · `@opentelemetry/instrumentation-undici` 0.34.0 · lab project `vercel-observability-lab`, drive `lab-drive` in `iad1` |

## 1. What it emits

| Signal | What | Where it lives | Retention |
| --- | --- | --- | --- |
| Metrics | `vercel.drive.read_bytes` by `projectId`, `driveId`, `billableRegion`, `cacheResult` (Captured); `vercel.drive.write_bytes` by `projectId`, `driveId`, `billableRegion` (no rows in the lab) | Query, `vercel metrics` | As for other metrics: Pro 1 day, Plus 30 days (Documented, Observability Plus docs) |
| Billing | Drive Storage (GB, measured hourly on logical used size), Drive Reads (GB), Drive Writes (GB), per region | Usage page, `vercel usage`, `GET /v1/billing/charges` | See the Billing entry |
| API objects | One object per drive: name, region, maximum size, creation and update times, `workloadType` (Captured); the sandbox it's mounted on, `parentDriveId` and `rootDriveId` for forks (Documented) | `GET /v2/sandboxes/drives?projectId=…`, `sandbox drives ls` | Until the drive is deleted |
| Sandbox objects | The mount on each sandbox: `"mounts": {"/data": {"drive": "lab-drive", "mode": "read-write"}}` (Captured) | `GET /v2/sandboxes?project=…` | As for sandboxes |
| Calling function | The SDK's drive API call as an outgoing request; your own log line | Trace drain (with fetch/undici instrumentation), log drain, `vercel.external_api_request.*` | As for Functions |
| Logs, spans | None from the drive or from inside the Sandbox | | |

The lab route `GET /api/drive` (`lab/app/api/drive/route.ts`, protected by a bearer secret) calls `Drive.getOrCreate({ name: "lab-drive", region: "iad1", maxSize: 1 GiB })`, creates a 1-vCPU, non-persistent Sandbox in `iad1` with the drive mounted read-write at `/data`, writes `/data/run-<ms>.txt` (about 31 bytes), runs `cat /data/*.txt`, logs one JSON line and stops the Sandbox. It ran three times on 2026-10-27 at 10:11:24, 10:11:33 and 10:11:37 UTC; the runs read 1, 2 and 3 files, so the drive kept its contents between sandboxes. The drive was deleted with `vercel sandbox drives delete lab-drive` at 10:47:47 UTC (`vercel sandbox drives ls` showed `SIZE 1 GB`, the maximum size, not the used size); the route creates it again on its next run.

## 2. Out-of-the-box shape

### Metrics

`vercel metrics vercel.drive.read_bytes -a sum --group-by driveId --group-by cacheResult --group-by billableRegion --since 1h --json` after the three runs (Captured: `metrics-read-bytes-cache-result.json`):

| `driveId` | `cacheResult` | `billableRegion` | sum | count |
| --- | --- | --- | --- | --- |
| `prj_Y3RSmZp5SNQvB6FhLb0LMH4HPWSM_iad1_drive_vsjD0blIUoOGyMKEqFj6EcYK8J5C` | `miss` | `iad1` | 49,152 bytes | 1 |
| same | `hit` | `iad1` | 16,384 bytes | 1 |

- `cacheResult` takes the values `hit` and `miss` (Observed). Both are multiples of 16 KiB: four 16 KiB reads for six reads of 31-byte files, so the metric counts what the drive layer fetched, not what the command read.
- All points landed in one 1-minute bucket, 10:11 UTC, with `count` 1 per `cacheResult`: the metric is aggregated before it is stored, so it can't tell the three runs apart (Captured: `metrics-read-bytes-count.json`).
- The `driveId` dimension is `<projectId>_<region>_<driveId>`; the API's `id` is only the last part.
- `vercel.drive.write_bytes` returned no rows, grouped or not, at 10:14, 10:24 and 10:47 UTC (36 minutes after the runs) (Captured: `metrics-write-bytes-empty-after-writes.json`), although each run wrote a file and `cat` read it back.

### API objects

`GET /v2/sandboxes/drives?projectId=prj_Y3RSmZp5SNQvB6FhLb0LMH4HPWSM` after the runs (Captured: `api-drives-list-lab-2026-10-27.json`):

```json
{ "id": "drive_vsjD0blIUoOGyMKEqFj6EcYK8J5C", "name": "lab-drive", "projectId": "prj_Y3RSmZp5SNQvB6FhLb0LMH4HPWSM",
  "maxSizeBytes": 1073741824, "region": "iad1", "workloadType": "sandbox",
  "createdAt": 1793095883800, "updatedAt": 1793095897883 }
```

No used size, no read or write counters, and no current sandbox while nothing has it mounted. `updatedAt` moved with the last mount (10:11:37.883 UTC). The sandboxes that mounted it carry the mount in `GET /v2/sandboxes` (see the Sandbox entry).

### The calling function

With the lab's undici instrumentation, `Drive.getOrCreate()` is one client span before the Sandbox is created (Captured: `span-sdk-drive-get-or-create.json`):

```json
{ "span.name": "POST", "span.kind": "SPAN_KIND_CLIENT", "http.response.status_code": "200",
  "url.full": "https://vercel.com/api/v2/sandboxes/drives/lab-drive?teamId=team_REDACTED",
  "server.address": "vercel.com", "user_agent.original": "vercel/sandbox/3.9.0 (Node.js/v24.21.0; linux/x64)",
  "span.duration_nano": "214375874" }
```

`getOrCreate` is a `POST` whether or not the drive exists (the first run created it, the next two reused it; all three were `POST … /drives/lab-drive`, 142 to 214 ms). `vercel.external_api_request.count` counted the same three calls under `requestPath /api/v2/sandboxes/drives/lab-drive` (Observed, `../sandbox/metrics-external-api-drive-runs.json`). The drive name is in the path; the drive ID is not.

### Log records

Only the app's own line (Captured: `log-app-line.json`), `source: lambda`, path `/api/drive`:

```json
{"msg":"drive run","drive":"lab-drive","driveId":"drive_vsjD0blIUoOGyMKEqFj6EcYK8J5C","sandbox":"lavender-colossal-weasel-bHsgSo","session":"sbx_6gwacssY77AyhrCiKjd6yDp4GUwn","file":"/data/run-1793095896936.txt","writeExitCode":0,"readExitCode":0,"filesRead":3}
```

Without such a line nothing in the drains connects a drive to a sandbox or a file.

### Billing lines

The team's FOCUS export has Drive Storage, Reads and Writes lines for every region every day, at zero before the lab used a drive (Captured: `billing-drive-lines-dub1.jsonl`, 2026-10-25). For the billing day of the runs (2026-10-27 07:00 to 2026-10-28 07:00 UTC) the in-progress export queried at 10:25 UTC had no non-zero Drive or Sandbox line for the lab yet: Not observed at the time of writing.

## 3. Extras beyond the default

| Extra | What it adds | Cost |
| --- | --- | --- |
| Observability Plus | Querying `vercel.drive.*` with 30-day retention | As for other metrics (see Functions) |
| An undici (or fetch) instrumentation | A client span per Drive API call from the SDK (Captured, section 2) | Trace drain volume |
| Your own log line | Drive name and ID, sandbox name, session, file, exit codes per run | Log volume |
| Read-only snapshot mounts (`drive.snapshot()`) | Many sandboxes reading one drive at once; reads still count as Drive Reads (Documented) | Reads |
| Forks (`drive.fork()`) | A new drive with its own `driveId`; `parentDriveId`/`rootDriveId` link it to its source (Documented) | Storage of the fork's own changes |

## 4. Getting it out

| Signal | Exit path | Tested configuration |
| --- | --- | --- |
| Read and write bytes | None. Pull `vercel metrics vercel.drive.* --json` (Observability Plus) on a schedule | `vercel metrics vercel.drive.read_bytes -a sum --group-by driveId --group-by cacheResult --group-by billableRegion --since 1h --json` |
| Storage, reads, writes as cost | Pull `GET /v1/billing/charges` (FOCUS) or `vercel usage --json` | Zero-value lines captured; non-zero lines Not observed yet |
| Drive inventory | Pull `GET /v2/sandboxes/drives?projectId=…` per project | `vercel api "/v2/sandboxes/drives?projectId=prj_…"` |
| Drive API calls | Trace drain, with an undici instrumentation in the calling app | Lab, 2026-10-27 |
| What the sandbox did with the files | Your own log line in the calling function; log drain | Lab route, `log-app-line.json` |

What can't leave: no drain type carries drive activity, and nothing records which file was read or written (Observed in the lab; the docs and changelogs describe only metering).

## 5. In Bronto

| Data | Dataset | Field names |
| --- | --- | --- |
| Calling function's logs | `vercel-observability-lab/vercel-logs` | `path`, `message` |
| Calling function's spans | `.traces/vercel-observability-lab` | `"$url.path"`, `"$span.duration_nano"` |

Queries run 2026-10-27 over the lab's data from 10:00 UTC:

| Question | Query | Group by | Result |
| --- | --- | --- | --- |
| Drive runs logged by the app | `path = '/api/drive' AND message LIKE '%drive run%'` | `path` | 3 |
| Drive API calls | `"$url.path" LIKE '/api/v2/sandboxes/drives/%'` | `"$url.path"` | `/api/v2/sandboxes/drives/lab-drive` 3 |

The `vercel.drive.*` numbers reach Bronto only through a scheduled pull that sends each metric row as an event; Not observed.

## Gotchas

1. **The metric's `driveId` isn't the drive ID.** `vercel.drive.read_bytes` reports `prj_…_iad1_drive_…`; the API, SDK and your logs use `drive_…` (Observed).
2. **No write bytes for real writes.** Three runs that each wrote and read back a file produced `read_bytes` rows and no `write_bytes` row in the following 36 minutes (Observed). Don't alert on missing write bytes.
3. **Read bytes are block reads.** Six reads of 31-byte files were recorded as 65,536 bytes in 16 KiB units, three quarters of it `miss` (Observed).
4. **The drive metrics don't name the sandbox.** Their dimensions are project, drive, billable region and (for reads) `cacheResult`; the sandbox metrics have no drive dimension (schema, Observed). Per-sandbox attribution has to come from your own log line.
5. **`getOrCreate` is always a `POST`.** Creating and reusing a drive look the same in spans and in `vercel.external_api_request` (Observed).
6. **Billing lines appear before any drive does.** The daily FOCUS export has zero-value Drive lines for every region (Captured). Filter on `ConsumedQuantity > 0` to find real use.
7. **The drives list needs a project.** `GET /v2/sandboxes/drives` without `projectId` returns 400 (Observed).
8. **Region is fixed.** A drive stays in the region it was created in (default `iad1`), and sandboxes that mount it must run there (Documented). The lab's function runs in `dub1`, its drive and sandboxes in `iad1`.

## Samples

| File | What it shows |
| --- | --- |
| [`metrics-schema.json`](../samples/vercel-drive/metrics-schema.json) | `vercel metrics schema vercel.drive --json` |
| [`metrics-read-bytes-cache-result.json`](../samples/vercel-drive/metrics-read-bytes-cache-result.json) | Read bytes by drive, `cacheResult` and region after three runs |
| [`metrics-read-bytes-count.json`](../samples/vercel-drive/metrics-read-bytes-count.json) | Data point count per `cacheResult` |
| [`metrics-write-bytes-empty-after-writes.json`](../samples/vercel-drive/metrics-write-bytes-empty-after-writes.json) | Write bytes after the same runs: no rows |
| [`metrics-read-bytes-30d-empty.json`](../samples/vercel-drive/metrics-read-bytes-30d-empty.json), [`metrics-write-bytes-30d-empty.json`](../samples/vercel-drive/metrics-write-bytes-30d-empty.json) | Before the lab had a drive: no rows |
| [`api-drives-list-lab-2026-10-27.json`](../samples/vercel-drive/api-drives-list-lab-2026-10-27.json) | `GET /v2/sandboxes/drives` with `lab-drive` |
| [`api-drives-list-lab.json`](../samples/vercel-drive/api-drives-list-lab.json) | The same call before the drive existed: empty |
| [`span-sdk-drive-get-or-create.json`](../samples/vercel-drive/span-sdk-drive-get-or-create.json) | The `Drive.getOrCreate()` client span |
| [`log-app-line.json`](../samples/vercel-drive/log-app-line.json) | The lab's `drive run` log line as drained |
| [`usage-drive-lines.json`](../samples/vercel-drive/usage-drive-lines.json) | The three Drive services in `vercel usage --json`, before the drive |
| [`billing-drive-lines-dub1.jsonl`](../samples/vercel-drive/billing-drive-lines-dub1.jsonl) | Zero-value FOCUS lines for Drive Storage, Reads and Writes, 2026-10-25 |

## Sources

- Vercel docs and changelog, read 2026-10-27: [Drives](https://vercel.com/docs/sandbox/concepts/drives) (last updated 2026-09-21), [Sandbox pricing](https://vercel.com/docs/sandbox/pricing) (last updated 2026-09-10), [How Vercel Drives work](https://vercel.com/kb/guide/vercel-drives) (2026-10-15), [Drives private beta](https://vercel.com/changelog/drives-for-vercel-sandbox-in-private-beta) (2026-06-05), [Drives public beta](https://vercel.com/changelog/drives-for-vercel-sandbox-are-now-in-public-beta) (2026-09-23), [Vercel Drives GA](https://vercel.com/changelog/vercel-drives-is-now-generally-available) (2026-10-15).
- Source: `@vercel/sandbox` 3.9.0 (`dist/drive.d.ts`, `dist/sandbox.d.ts`).
- Lab: `lab/app/api/drive/route.ts`, deployment `dpl_14UbnR1c1cgJ2Kk4RkNXj5ChK3XJ`, runs 2026-10-27 10:11 UTC; Vercel CLI 65.2.0 (`vercel metrics`, `vercel api /v2/sandboxes/drives`, `vercel api /v1/billing/charges`); Bronto EU datasets `vercel-observability-lab/vercel-logs` and `.traces/vercel-observability-lab`; `lab/NOTES.md`.
