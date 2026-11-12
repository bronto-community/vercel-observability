#!/usr/bin/env node
// Weekly mechanical check of the catalog. No dependencies; Node 22 or later.
//
// 1. Regenerates reference/vercel-metrics-schema.json with the Vercel CLI
//    (needs VERCEL_TOKEN; VERCEL_SCOPE picks the team). Skipped without a token.
// 2. Compares reference/tracked-versions.json with the npm registry.
// 3. Checks the links in README.md, METHOD.md, emitters/ and reference/.
//
// Writes a Markdown report to REPORT_PATH (default: weekly-check-report.md) and,
// on GitHub Actions, the outputs schema_changed and findings.

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const SCHEMA_PATH = join(ROOT, "reference/vercel-metrics-schema.json");
const VERSIONS_PATH = join(ROOT, "reference/tracked-versions.json");
const REPORT_PATH = process.env.REPORT_PATH || join(ROOT, "weekly-check-report.md");
const SKIP = new Set((process.env.SKIP || "").split(",").filter(Boolean));

const report = [];
let findings = 0;
let schemaChanged = false;

// ---------- 1. Metrics schema ----------

function vercel(args) {
  const full = [...args, "--json"];
  if (process.env.VERCEL_SCOPE) full.push("--scope", process.env.VERCEL_SCOPE);
  if (process.env.VERCEL_TOKEN) full.push("--token", process.env.VERCEL_TOKEN);
  const out = execFileSync(process.env.VERCEL_BIN || "vercel", full, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(out);
}

function checkSchema() {
  report.push("## Metrics schema\n");
  if (SKIP.has("schema")) {
    report.push("Skipped.\n");
    return;
  }
  if (!process.env.VERCEL_TOKEN && process.env.CI) {
    report.push("Skipped: no `VERCEL_TOKEN` secret.\n");
    return;
  }
  const cliVersion = execFileSync(process.env.VERCEL_BIN || "vercel", ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim().split("\n").pop();

  const list = vercel(["metrics", "schema"]);
  const fresh = list.map(({ id }) => {
    const detail = vercel(["metrics", "schema", id]);
    return Array.isArray(detail) ? detail.find((m) => m.id === id) ?? detail[0] : detail;
  });

  const old = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
  const oldById = new Map(old.map((m) => [m.id, m]));
  const newById = new Map(fresh.map((m) => [m.id, m]));
  const added = fresh.filter((m) => !oldById.has(m.id)).map((m) => m.id);
  const removed = old.filter((m) => !newById.has(m.id)).map((m) => m.id);
  const changed = [];
  for (const m of fresh) {
    const o = oldById.get(m.id);
    if (!o || JSON.stringify(o) === JSON.stringify(m)) continue;
    const parts = [];
    const dimsAdded = (m.dimensions || []).filter((d) => !(o.dimensions || []).includes(d));
    const dimsRemoved = (o.dimensions || []).filter((d) => !(m.dimensions || []).includes(d));
    if (dimsAdded.length) parts.push(`dimensions added: ${dimsAdded.map((d) => `\`${d}\``).join(", ")}`);
    if (dimsRemoved.length) parts.push(`dimensions removed: ${dimsRemoved.map((d) => `\`${d}\``).join(", ")}`);
    for (const k of ["description", "unit", "aggregations"]) {
      if (JSON.stringify(o[k]) !== JSON.stringify(m[k])) parts.push(`${k} changed`);
    }
    if (!parts.length) parts.push("dimension order changed");
    changed.push(`\`${m.id}\`: ${parts.join("; ")}`);
  }

  const text = JSON.stringify(fresh, null, 1) + "\n";
  if (text === readFileSync(SCHEMA_PATH, "utf8")) {
    report.push(`No change (${fresh.length} metrics, Vercel CLI ${cliVersion}).\n`);
    return;
  }
  writeFileSync(SCHEMA_PATH, text);
  schemaChanged = true;
  findings++;
  report.push(`Changed: now ${fresh.length} metrics (was ${old.length}), Vercel CLI ${cliVersion}. The file is updated in this run.\n`);
  if (added.length) report.push(`- New metrics: ${added.map((id) => `\`${id}\``).join(", ")}`);
  if (removed.length) report.push(`- Removed metrics: ${removed.map((id) => `\`${id}\``).join(", ")}`);
  for (const c of changed) report.push(`- ${c}`);
  report.push(
    "\nBefore merging: update the metrics count, CLI version and date in `README.md` (reference section), and check the entries that cite changed metrics.\n",
  );
}

// ---------- 2. Package versions ----------

async function checkVersions() {
  report.push("## Package versions\n");
  if (SKIP.has("versions")) {
    report.push("Skipped.\n");
    return;
  }
  const tracked = JSON.parse(readFileSync(VERSIONS_PATH, "utf8"));
  const rows = [];
  const errors = [];
  await Promise.all(
    Object.entries(tracked.packages).map(async ([pkg, version]) => {
      try {
        const res = await fetch(`https://registry.npmjs.org/${pkg.replace("/", "%2F")}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const doc = await res.json();
        const latest = doc["dist-tags"]?.latest;
        if (latest && latest !== version) {
          // Versions released after the tracked one, oldest first.
          const since = doc.time?.[version];
          const newer = Object.entries(doc.time || {})
            .filter(([v, t]) => /^\d/.test(v) && !v.includes("snapshot") && since && t > since)
            .filter(([v]) => !/-(canary|beta|alpha|snapshot)/.test(v) || /-rc/.test(latest))
            .sort((a, b) => a[1].localeCompare(b[1]))
            .map(([v]) => v);
          rows.push({ pkg, version, latest, date: doc.time?.[latest]?.slice(0, 10) ?? "?", newer });
        }
      } catch (e) {
        errors.push(`\`${pkg}\`: ${e.message}`);
      }
    }),
  );
  rows.sort((a, b) => a.pkg.localeCompare(b.pkg));
  if (!rows.length) {
    report.push(`All ${Object.keys(tracked.packages).length} tracked packages match npm's latest (checked against the catalog on ${tracked.checked}).\n`);
  } else {
    findings += rows.length;
    report.push(`Newer than the catalog's last check (${tracked.checked}):\n`);
    report.push("| Package | Catalog | npm latest | Released | Versions in between |");
    report.push("| --- | --- | --- | --- | --- |");
    for (const r of rows) {
      const between = r.newer.filter((v) => v !== r.latest);
      report.push(`| [\`${r.pkg}\`](https://www.npmjs.com/package/${r.pkg}?activeTab=versions) | ${r.version} | ${r.latest} | ${r.date} | ${between.length ? between.join(", ") : "none"} |`);
    }
    report.push(
      "\nFor each: read the release notes, update the entries that cite the package, then set the version in `reference/tracked-versions.json`.\n",
    );
  }
  if (errors.length) report.push(`Could not check: ${errors.join("; ")}\n`);
}

// ---------- 3. Links ----------

function markdownFiles() {
  const files = ["README.md", "METHOD.md", "TEMPLATE.md"].filter((f) => existsSync(join(ROOT, f)));
  for (const dir of ["emitters", "reference"]) {
    for (const f of readdirSync(join(ROOT, dir))) if (f.endsWith(".md")) files.push(`${dir}/${f}`);
  }
  return files;
}

async function fetchStatus(url) {
  const opts = { redirect: "follow", signal: AbortSignal.timeout(20000), headers: { "user-agent": "vercel-observability-link-check" } };
  try {
    let res = await fetch(url, { ...opts, method: "HEAD" });
    if (res.status === 405 || res.status === 403 || res.status === 404 || res.status >= 500) {
      res = await fetch(url, { ...opts, method: "GET" });
      res.body?.cancel();
    }
    return res.status;
  } catch (e) {
    return e.name === "TimeoutError" ? "timeout" : e.cause?.code || e.message;
  }
}

async function checkLinks() {
  report.push("## Links\n");
  if (SKIP.has("links")) {
    report.push("Skipped.\n");
    return;
  }
  const external = new Map(); // url -> [files]
  const broken = [];
  for (const file of markdownFiles()) {
    const text = readFileSync(join(ROOT, file), "utf8");
    for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^https?:\/\//.test(target)) {
        const url = target.replace(/#.*$/, "");
        if (!external.has(url)) external.set(url, []);
        external.get(url).push(file);
      } else if (!target.startsWith("#") && !target.startsWith("mailto:")) {
        const path = target.replace(/#.*$/, "");
        if (path && !existsSync(join(ROOT, dirname(file), decodeURIComponent(path)))) {
          broken.push({ target, files: [file], status: "missing file" });
        }
      }
    }
  }
  // Hosts that refuse automated requests; the version check covers npm packages.
  const urls = [...external.keys()].filter((u) => !/^https:\/\/(www\.)?npmjs\.com\//.test(u));
  const unsure = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (i < urls.length) {
        const url = urls[i++];
        const status = await fetchStatus(url);
        if (status === 404 || status === 410) broken.push({ target: url, files: external.get(url), status });
        else if (typeof status !== "number" || status >= 400) unsure.push({ target: url, files: external.get(url), status });
      }
    }),
  );
  const fmt = (l) => `- ${l.target} (${l.status}) in ${[...new Set(l.files)].map((f) => `\`${f}\``).join(", ")}`;
  if (!broken.length && !unsure.length) {
    report.push(`All ${urls.length} external links and the relative links resolve.\n`);
    return;
  }
  findings += broken.length;
  if (broken.length) {
    report.push("Broken:\n");
    report.push(...broken.sort((a, b) => a.target.localeCompare(b.target)).map(fmt), "");
  }
  if (unsure.length) {
    report.push("Could not check (blocked, rate-limited or server error; open them by hand):\n");
    report.push(...unsure.sort((a, b) => a.target.localeCompare(b.target)).map(fmt), "");
  }
  if (!broken.length) report.push(`The other ${urls.length - unsure.length} external links resolve.\n`);
}

// ---------- Run ----------

const day = new Date().toISOString().slice(0, 10);
try {
  checkSchema();
} catch (e) {
  report.push(`Failed: ${String(e.stderr || e.message).trim().split("\n").slice(-3).join(" ")}\n`);
  findings++;
}
await checkVersions();
await checkLinks();

const body = [
  `Weekly check of the catalog, ${day}. This covers the mechanical part only: the metrics schema, package versions and links. Changelog and docs changes still need a review.\n`,
  ...report,
].join("\n");
writeFileSync(REPORT_PATH, body);
console.log(body);
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `schema_changed=${schemaChanged}\nfindings=${findings}\n`);
}
