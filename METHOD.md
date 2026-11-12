# Method

How the entries in this catalog are verified.

## The lab

Captured records come from [petclinic-agent](https://github.com/bronto-community/petclinic-agent): an eve agent and a Next.js 16 app on Vercel (Pro team, region `dub1`), Spring PetClinic outside Vercel, synthetic traffic from a cron job and a headless browser. Drains and OTLP exporters send everything to one OTLP-capable backend (Bronto EU in this case).

Emitters the lab doesn't use (Blob, Sandbox, Global Config, Flags and others) get a small test project of their own, listed in the entry.

## Evidence levels

Every claim in an entry carries one of these:

| Level | Meaning |
| --- | --- |
| **Captured** | A record in `samples/` shows it |
| **Observed** | Seen in the lab through a query or the Vercel CLI/API, with the query given |
| **Documented** | Vercel's docs say so, not yet seen in the lab |
| **Not observed** | Expected from the docs, but the lab hasn't produced the case yet |

## Samples

- Log drain samples are the record exactly as delivered (the `@raw` body stored by the backend), pretty-printed.
- Trace samples are spans as stored by the backend after OTLP ingestion: attributes flattened to `name = value`, resource and span attributes in one map, values shown as strings. They are not the OTLP wire format. Wire captures will be added from a request sink where the wire format matters.
- Redacted: client IP addresses (replaced with `203.0.113.10`, a documentation address) and the Vercel team ID (`team_REDACTED`). Project, deployment, request and trace IDs are kept; they belong to the public lab project.

## Versions

Each entry states the date it was verified and the versions involved. `reference/vercel-metrics-schema.json` is the output of `vercel metrics schema <id> --json` for every metric the CLI lists, in the CLI's order.

## Keeping it current

A GitHub Action ([`weekly-check.yml`](.github/workflows/weekly-check.yml)) runs [`scripts/weekly-check.mjs`](scripts/weekly-check.mjs) every Monday:

- It regenerates the metrics schema with the latest Vercel CLI and opens a pull request when it changed.
- It compares [`reference/tracked-versions.json`](reference/tracked-versions.json), the package versions the catalog was last checked against, with npm.
- It checks every link in the Markdown files.

Findings go into one issue labelled `weekly-check`, which closes itself when a run finds nothing. The check never edits entries: a newer package version or a changed metric means an entry needs a review, and the evidence level of any claim it touches stays as it is until that review. Run it locally with `node scripts/weekly-check.mjs`; it needs a logged-in Vercel CLI for the schema step, or `SKIP=schema`.
