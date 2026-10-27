# Vercel Drives (Sandbox)

> **Documented only: the lab has no Drive, so no Drive has emitted anything yet.** Every record below is either an empty query result or a zero-value billing line. A Drive is persistent storage you mount as a directory into a Vercel Sandbox (private beta 2026-06-05, public beta 2026-09-23, GA on all plans 2026-10-15). It emits no logs and no spans of its own. Its usage shows up in two metrics, `vercel.drive.read_bytes` (with a `cacheResult` dimension) and `vercel.drive.write_bytes`. Querying them needs Observability Plus, and neither has a drain. Usage also appears in three billing lines (Drive Storage, Reads, Writes) per region, readable through `vercel usage` and the FOCUS billing API. To get Drive usage out of Vercel, pull the metrics or the billing lines on a schedule.

| | |
| --- | --- |
| Kind | Platform service (storage for Vercel Sandbox), used through `@vercel/sandbox`, the Python SDK or the `sandbox` CLI |
| Plans | All plans since GA on 2026-10-15. Hobby: 15 GB storage (lifetime), 30 GB reads and 30 GB writes per month included, drives up to 1 GiB. Pro and Enterprise: by usage, $0.05/GB-month storage, $0.0015/GB read, $0.004/GB write in `iad1`, other regions differ (Documented) |
| Signals | Metrics (inside Vercel only) · billing lines · API objects (drives) |
| Exit paths | `vercel metrics` pull · `vercel usage` / `GET /v1/billing/charges` pull · `GET /v2/sandboxes/drives` pull |
| Verified | 2026-10-27 · Vercel CLI 65.2.0 · lab team, project `vercel-observability-lab` (no drives) |

## 1. What it emits

| Signal | What | Where it lives | Retention |
| --- | --- | --- | --- |
| Metrics | `vercel.drive.read_bytes` by `projectId`, `driveId`, `billableRegion`, `cacheResult`; `vercel.drive.write_bytes` by `projectId`, `driveId`, `billableRegion` | Query, `vercel metrics` | As for other metrics: Pro 1 day, Plus 30 days (Documented, Observability Plus docs) |
| Billing | Drive Storage (GB, measured hourly on logical used size), Drive Reads (GB), Drive Writes (GB), per region | Usage page, `vercel usage`, `GET /v1/billing/charges` | See the Billing entry |
| API objects | One object per drive: name, region, maximum size, creation and update times, the sandbox it's mounted on, `parentDriveId` and `rootDriveId` for forks | `GET /v2/sandboxes/drives?projectId=…`, `sandbox drives ls` | Until the drive is deleted |

Both metrics (Captured: `metrics-schema.json`):

| Metric | Unit | Dimensions | Aggregations |
| --- | --- | --- | --- |
| `vercel.drive.read_bytes` | bytes | `projectId`, `driveId`, `billableRegion`, `cacheResult` | count, sum, avg, min, max, p50–p99, stddev |
| `vercel.drive.write_bytes` | bytes | `projectId`, `driveId`, `billableRegion` | same |

The values `cacheResult` takes are not documented. The Drives docs say reads are served at NVMe speed on a cache hit and more slowly on a miss, so the dimension presumably separates the two (Not observed).

The Sandbox's own metrics (`vercel.sandbox.*`) have no drive dimension, and the drive metrics have no sandbox name or session, so a read can't be tied to the sandbox that made it from the metrics alone (from the schema, Observed).

## 2. Out-of-the-box shape

What the lab returns today, with no drive on the team:

| Source | Command | Result |
| --- | --- | --- |
| Metric schema | `vercel metrics schema vercel.drive --json` | The two metrics above (Captured: `metrics-schema.json`) |
| Metrics, whole team, 30 days | `vercel metrics --all vercel.drive.read_bytes --group-by projectId --since 30d --json` (and `write_bytes`) | `"summary": []`, `"data": []` (Captured: `metrics-read-bytes-30d-empty.json`, `metrics-write-bytes-30d-empty.json`) |
| Drives in the lab project | `vercel api "/v2/sandboxes/drives?projectId=prj_Y3RSmZp5SNQvB6FhLb0LMH4HPWSM"` | `{"drives":[],"pagination":{"count":0,"next":null}}` (Captured: `api-drives-list-lab.json`). Without `projectId` the API answers `400 missing required property projectId` |
| Usage for the billing cycle | `vercel usage --json` | Three Drive services, all zero: `driveStorage`, `driveWrite`, `driveRead`, unit `gigabyte` (Captured: `usage-drive-lines.json`) |
| FOCUS billing lines, 2026-10-25 | `GET /v1/billing/charges` (from the Billing entry) | 63 Drive lines: Storage, Reads and Writes for each of 20 regions plus one line each without a region, all `ConsumedQuantity: 0`, `ServiceCategory: Sandbox` (Captured: `billing-drive-lines-dub1.jsonl`, the three `dub1` lines) |

A billing line as delivered (Captured):

```json
{ "ChargePeriodStart": "2026-10-25T07:00:00.000Z", "ChargePeriodEnd": "2026-10-26T07:00:00.000Z",
  "ChargeCategory": "Usage", "ServiceName": "Drive Reads", "ServiceCategory": "Sandbox",
  "ConsumedQuantity": 0, "ConsumedUnit": "gigabyte", "RegionId": "dub1", "BilledCost": 0, … }
```

The shape of a drive object in the API, of non-zero metric rows and of billing lines with usage: Not observed.

## 3. Extras beyond the default

| Extra | What it adds | Cost |
| --- | --- | --- |
| Observability Plus | Querying `vercel.drive.*` with 30-day retention | As for other metrics (see Functions) |
| Read-only snapshot mounts (`drive.snapshot()`) | Many sandboxes reading one drive at once; reads still count as Drive Reads (Documented) | Reads |
| Forks (`drive.fork()`) | A new drive with its own `driveId`; `parentDriveId`/`rootDriveId` link it to its source (Documented) | Storage of the fork's own changes |

## 4. Getting it out

| Signal | Exit path | Tested configuration |
| --- | --- | --- |
| Read and write bytes | None. Pull `vercel metrics vercel.drive.* --json` (Observability Plus) on a schedule | Query ran; returned no rows (no drives) |
| Storage, reads, writes as cost | Pull `GET /v1/billing/charges` (FOCUS) or `vercel usage --json` | Ran; zero-value lines (section 2) |
| Drive inventory | Pull `GET /v2/sandboxes/drives?projectId=…` per project | Ran; empty list |
| What the sandbox did with the files | Your code, through the Sandbox SDK's command output; see the Sandbox entry | Not observed |

What can't leave: no drain type carries drive activity, and nothing records which file was read or written (Documented: the docs, the GA changelog and the Drives guide describe only metering).

## 5. In Bronto

Nothing to show: no Drive usage exists to forward. A scheduled job that pulls `vercel metrics vercel.drive.read_bytes --group-by driveId --group-by cacheResult --json` and sends each row as an event would land the numbers in a dataset next to the billing records; Not observed.

## Gotchas

1. **The drive metrics don't name the sandbox.** Their dimensions are project, drive, billable region and (for reads) `cacheResult`; the sandbox metrics have no drive dimension (from the schema, Observed). With a drive shared through snapshots, per-sandbox attribution has to come from your own code.
2. **Billing lines appear before any drive does.** The team's daily FOCUS export already has 63 zero-value Drive lines, one per region and service (Captured). Filter on `ConsumedQuantity > 0`, not on the presence of a line, to find real use.
3. **The drives list needs a project.** `GET /v2/sandboxes/drives` without `projectId` returns 400; there is no team-wide list (Observed).
4. **Region is fixed.** A drive stays in the region it was created in (default `iad1`), and sandboxes that mount it must run there and can't use failover regions (Documented). Read costs vary by region; `billableRegion` on the metrics shows which rate applies.

## Samples

| File | What it shows |
| --- | --- |
| [`metrics-schema.json`](../samples/vercel-drive/metrics-schema.json) | `vercel metrics schema vercel.drive --json` |
| [`metrics-read-bytes-30d-empty.json`](../samples/vercel-drive/metrics-read-bytes-30d-empty.json) | Team-wide read bytes for 30 days: no rows |
| [`metrics-write-bytes-30d-empty.json`](../samples/vercel-drive/metrics-write-bytes-30d-empty.json) | Team-wide write bytes for 30 days: no rows |
| [`api-drives-list-lab.json`](../samples/vercel-drive/api-drives-list-lab.json) | Drives in the lab project: none |
| [`usage-drive-lines.json`](../samples/vercel-drive/usage-drive-lines.json) | The three Drive services in `vercel usage --json`, all zero |
| [`billing-drive-lines-dub1.jsonl`](../samples/vercel-drive/billing-drive-lines-dub1.jsonl) | FOCUS billing lines for Drive Storage, Reads and Writes in `dub1`, 2026-10-25, all zero |

## Sources

- Vercel docs and changelog, read 2026-10-27: [Drives](https://vercel.com/docs/sandbox/concepts/drives) (last updated 2026-09-21), [Sandbox pricing](https://vercel.com/docs/sandbox/pricing) (last updated 2026-09-10), [How Vercel Drives work](https://vercel.com/kb/guide/vercel-drives) (2026-10-15), [Drives private beta](https://vercel.com/changelog/drives-for-vercel-sandbox-in-private-beta) (2026-06-05), [Drives public beta](https://vercel.com/changelog/drives-for-vercel-sandbox-are-now-in-public-beta) (2026-09-23), [Vercel Drives GA](https://vercel.com/changelog/vercel-drives-is-now-generally-available) (2026-10-15). None of them describes Drive metrics, logs or dashboards.
- Lab: Vercel CLI 65.2.0 (`vercel metrics schema`, `vercel metrics --all`, `vercel api /v2/sandboxes/drives`, `vercel usage --json`); FOCUS billing lines from the Billing entry's capture of 2026-10-25.
- Not exercised: creating a drive needs a sandbox to mount it in, which creates two new billable resources in the lab project (a few cents at most for a one-minute run in `dub1`; the team's $20 monthly credit was used up on 2026-10-27, so it would be billed). Left for the lead to approve.
