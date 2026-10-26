# <Emitter name>

> One paragraph that answers the whole file: what this emits, what leaves Vercel without code, what needs code, and the one thing most people get wrong.

| | |
| --- | --- |
| Kind | Platform service / library / client script |
| Plans | Which Vercel plans emit it; which add-ons unlock more |
| Signals | Logs · Metrics · Traces · Events (webhooks) · Other |
| Exit paths | Log drain · Trace drain · Other drain type · OTLP from code · Webhook · API · none |
| Verified | YYYY-MM-DD, versions (Vercel CLI, packages) |

## 1. What it emits

One row per signal. "Where it lives" is where Vercel keeps it without any setup.

| Signal | What | Where it lives | Retention |
| --- | --- | --- | --- |

## 2. Out-of-the-box shape

The records as Vercel produces them with zero setup, from captured samples (`samples/<slug>/`). Field tables list every field seen, with a note when the field isn't in Vercel's published schema.

## 3. Extras beyond the default

What you can add: add-ons (Observability Plus, Speed Insights Plus), configuration, framework hooks, instrumentation libraries. Each extra says what it adds to the records in section 2.

## 4. Getting it out

Per signal: the exit path, the exact configuration that was tested, and what can't leave Vercel at all.

## 5. In Bronto

The example backend. Dataset names, how fields are named after ingestion, tested queries with the result they returned in the lab, and the matching dashboard and monitor templates.

## Gotchas

Behaviour that surprises people, each with its evidence.

## Samples

| File | What it shows |
| --- | --- |

## Sources

Vercel docs pages (with the date they were read) and the lab evidence behind each claim.
