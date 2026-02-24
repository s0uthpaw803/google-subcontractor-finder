#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { searchSubcontractors } from "./search-engine.js";

const ROOT = path.resolve(process.cwd());
const CATEGORIES = path.join(ROOT, "data", "query-categories.json");

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {
    location: "Myrtle Beach, SC",
    radiusMiles: 25,
    max: 0
  };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--location" || a === "-l") out.location = String(args[i + 1] || out.location), i += 1;
    else if (a === "--radius" || a === "-r") out.radiusMiles = Number(args[i + 1] || out.radiusMiles), i += 1;
    else if (a === "--max") out.max = Number(args[i + 1] || 0), i += 1;
  }
  return out;
}

function loadSections() {
  if (!fs.existsSync(CATEGORIES)) throw new Error(`Missing categories: ${CATEGORIES}`);
  const raw = fs.readFileSync(CATEGORIES, "utf8");
  const data = JSON.parse(raw);
  const sections = Array.isArray(data?.sections) ? data.sections : [];
  return sections
    .map((s) => ({
      label: String(s?.label || s?.section || "").trim(),
      children: Array.isArray(s?.children) ? s.children.map((c) => String(c || "").trim()).filter(Boolean) : []
    }))
    .filter((s) => s.label);
}

async function run() {
  const { location, radiusMiles, max } = parseArgs();
  const sections = loadSections();
  const checks = [];

  for (const section of sections) {
    checks.push({
      label: section.label,
      queries: section.children.length ? section.children : [section.label],
      queryContexts: (section.children.length ? section.children : [section.label]).map((term) => ({ term, section: section.label }))
    });
  }

  const subset = max > 0 ? checks.slice(0, max) : checks;
  const summary = [];

  for (let i = 0; i < subset.length; i += 1) {
    const c = subset[i];
    process.stdout.write(`[${i + 1}/${subset.length}] ${c.label} ... `);
    try {
      const result = await searchSubcontractors({
        location,
        query: c.queries[0],
        queries: c.queries,
        queryContexts: c.queryContexts,
        strictTypeFilter: true,
        radiusMiles,
        onProgress: () => {}
      });
      const count = Array.isArray(result?.rows) ? result.rows.length : 0;
      summary.push({ section: c.label, count });
      process.stdout.write(`${count}\n`);
    } catch (err) {
      summary.push({ section: c.label, count: -1, error: String(err?.message || err) });
      process.stdout.write(`ERROR: ${String(err?.message || err)}\n`);
    }
  }

  const zeros = summary.filter((x) => x.count === 0).map((x) => x.section);
  const errors = summary.filter((x) => x.count < 0);
  const ok = summary.filter((x) => x.count > 0);
  const avg = ok.length ? (ok.reduce((s, x) => s + x.count, 0) / ok.length).toFixed(1) : "0.0";

  console.log("\nValidation summary");
  console.log(`location: ${location}`);
  console.log(`radiusMiles: ${radiusMiles}`);
  console.log(`sections tested: ${summary.length}`);
  console.log(`sections with results: ${ok.length}`);
  console.log(`sections with zero: ${zeros.length}`);
  console.log(`sections with errors: ${errors.length}`);
  console.log(`avg rows (non-zero): ${avg}`);

  if (zeros.length) {
    console.log("\nZero-result sections:");
    zeros.forEach((z) => console.log(`- ${z}`));
  }
  if (errors.length) {
    console.log("\nErrored sections:");
    errors.forEach((e) => console.log(`- ${e.section}: ${e.error}`));
  }
}

run().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
