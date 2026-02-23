#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { importScllrCsv, scllrStats } from "../src/scllr-engine.js";

const ROOT = path.resolve(process.cwd());
const DEFAULT_DROP_DIR = path.join(ROOT, "data", "scllr-monthly-drop");

function parseArgs(argv) {
  const out = {
    input: "",
    dir: DEFAULT_DROP_DIR,
    replace: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--input" || a === "-i") {
      out.input = String(argv[i + 1] || "");
      i += 1;
      continue;
    }
    if (a === "--dir" || a === "-d") {
      out.dir = String(argv[i + 1] || DEFAULT_DROP_DIR);
      i += 1;
      continue;
    }
    if (a === "--replace") {
      out.replace = true;
      continue;
    }
  }
  return out;
}

function listCsvFilesFromDir(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  return fs
    .readdirSync(dirPath)
    .filter((f) => /\.csv$/i.test(f))
    .map((f) => path.join(dirPath, f))
    .sort((a, b) => a.localeCompare(b));
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const files = args.input
    ? args.input
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
        .map((x) => (path.isAbsolute(x) ? x : path.join(ROOT, x)))
    : listCsvFilesFromDir(args.dir);

  if (!files.length) {
    console.error(
      [
        "No SCLLR CSV files found.",
        "Use --input <file.csv> or drop CSV files into data/scllr-monthly-drop/",
        `Checked: ${args.dir}`
      ].join("\n")
    );
    process.exitCode = 1;
    return;
  }

  console.log(`SCLLR monthly import started. Files: ${files.length}`);
  let importedTotal = 0;
  let merge = !args.replace;

  for (const filePath of files) {
    if (!fs.existsSync(filePath)) {
      console.warn(`Skip missing file: ${filePath}`);
      continue;
    }
    const csvText = fs.readFileSync(filePath, "utf8");
    const result = await importScllrCsv({
      csvText,
      merge,
      onProgress: (msg) => console.log(`  ${msg}`)
    });
    importedTotal += Number(result.rows_imported || 0);
    console.log(
      `Imported ${result.rows_imported} rows from ${path.basename(filePath)} (cached: ${result.rows_cached}).`
    );
    merge = true; // after first import, always merge additional files
  }

  const stats = scllrStats();
  console.log(
    `SCLLR monthly import complete. Imported: ${importedTotal}. Cached total: ${stats.rows}. Refreshed: ${stats.refreshed_at || "n/a"}.`
  );
}

run().catch((error) => {
  console.error(`SCLLR monthly import failed: ${error?.message || String(error)}`);
  process.exitCode = 1;
});

