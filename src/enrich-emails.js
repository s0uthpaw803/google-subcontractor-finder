#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const USER_AGENT = "subcontractor-email-enricher/1.0";
const TIMEOUT_MS = 15000;

function parseArgs(argv) {
  const args = {
    input: "subcontractors.csv",
    output: "subcontractors-with-emails.csv",
    pages: 4
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--input" || arg === "-i") {
      args.input = argv[i + 1] || args.input;
      i += 1;
    } else if (arg === "--output" || arg === "-o") {
      args.output = argv[i + 1] || args.output;
      i += 1;
    } else if (arg === "--pages") {
      const value = Number(argv[i + 1]);
      if (Number.isFinite(value) && value >= 1 && value <= 8) {
        args.pages = value;
      }
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    }
  }

  return args;
}

function printHelp() {
  console.log(`
Usage:
  npm run enrich:emails -- --input atlanta-osm.csv --output atlanta-with-emails.csv [--pages 4]

Options:
  --input, -i   Input CSV path (must contain at least website, phone, name columns)
  --output, -o  Output CSV path with added emails/domain columns
  --pages       Max pages per domain to scan (default 4, max 8)
`);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        field += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      row.push(field);
      field = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(field);
      if (row.length > 1 || row[0] !== "") {
        rows.push(row);
      }
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }

  if (!rows.length) {
    return { headers: [], data: [] };
  }

  const headers = rows[0];
  const data = rows.slice(1).map((r) => {
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = r[idx] || "";
    });
    return obj;
  });

  return { headers, data };
}

function csvEscape(value) {
  const str = String(value ?? "");
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function toCsv(headers, rows) {
  const lines = [headers.join(",")];
  rows.forEach((row) => {
    lines.push(headers.map((h) => csvEscape(row[h] || "")).join(","));
  });
  return `${lines.join("\n")}\n`;
}

function normalizeUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  try {
    if (!/^https?:\/\//i.test(raw)) {
      return new URL(`https://${raw}`).toString();
    }
    return new URL(raw).toString();
  } catch {
    return "";
  }
}

function domainFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return text;
}

function extractEmails(text) {
  const out = new Set();
  const regex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[A-Za-z]{2,}/g;
  const blocked = new Set([
    "example.com",
    "email.com",
    "domain.com",
    "yourdomain.com",
    "sentry.io",
    "wixpress.com"
  ]);
  const blockedTlds = new Set(["png", "jpg", "jpeg", "svg", "webp", "gif", "css", "js", "ico"]);

  let match;
  while ((match = regex.exec(text)) !== null) {
    const email = match[0].toLowerCase();
    const domain = email.split("@")[1] || "";
    const tld = domain.split(".").pop() || "";
    if (blocked.has(domain)) continue;
    if (blockedTlds.has(tld)) continue;
    if (email.includes("noreply") || email.includes("no-reply")) continue;
    out.add(email);
  }

  return [...out];
}

function candidatePaths(maxPages) {
  const defaults = ["/", "/contact", "/contact-us", "/about", "/team", "/company", "/locations", "/privacy"];
  return defaults.slice(0, maxPages);
}

async function scrapeDomainEmails(baseUrl, maxPages) {
  const base = normalizeUrl(baseUrl);
  if (!base) {
    return { emails: [], domain: "" };
  }

  const domain = domainFromUrl(base);
  const urls = candidatePaths(maxPages)
    .map((p) => {
      try {
        return new URL(p, base).toString();
      } catch {
        return "";
      }
    })
    .filter(Boolean);

  const unique = new Set();

  for (const url of urls) {
    try {
      const html = await fetchText(url);
      extractEmails(html).forEach((e) => unique.add(e));
    } catch {
      // Best-effort scrape; ignore individual page failures.
    }
  }

  const prioritized = [...unique].sort((a, b) => {
    const aMatches = a.endsWith(`@${domain}`) ? 1 : 0;
    const bMatches = b.endsWith(`@${domain}`) ? 1 : 0;
    return bMatches - aMatches;
  });

  return { emails: prioritized.slice(0, 8), domain };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const inputPath = path.resolve(process.cwd(), args.input);
  const outputPath = path.resolve(process.cwd(), args.output);

  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input CSV not found: ${inputPath}`);
  }

  const text = fs.readFileSync(inputPath, "utf8");
  const { headers, data } = parseCsv(text);

  if (!headers.length) {
    throw new Error("Input CSV is empty.");
  }

  const outHeaders = [...headers];
  if (!outHeaders.includes("domain")) outHeaders.push("domain");
  if (!outHeaders.includes("emails")) outHeaders.push("emails");

  const websiteField = headers.includes("website") ? "website" : "";
  const rows = [];

  for (let i = 0; i < data.length; i += 1) {
    const row = { ...data[i] };
    if ((i + 1) % 10 === 0 || i === data.length - 1) {
      console.log(`Enriching ${i + 1}/${data.length}`);
    }

    const website = websiteField ? row[websiteField] : "";
    const { emails, domain } = await scrapeDomainEmails(website, args.pages);

    row.domain = domain;
    row.emails = emails.join("; ");
    rows.push(row);
  }

  fs.writeFileSync(outputPath, toCsv(outHeaders, rows), "utf8");
  console.log(`Wrote ${rows.length} rows to ${outputPath}`);
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
