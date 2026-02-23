#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { searchSubcontractors, toCsv } from "./search-engine.js";
import {
  refreshScllrCache,
  searchScllrOnly,
  scllrStats,
  importScllrCsv,
  ensureScllrCacheReady
} from "./scllr-engine.js";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = path.resolve(process.cwd());
const APP_HTML = path.join(ROOT, "ui", "app.html");
const SCLLR_HTML = path.join(ROOT, "ui", "scllr.html");
const UI_DIR = path.join(ROOT, "ui");
const QUERY_CATEGORIES_JSON = path.join(ROOT, "data", "query-categories.json");
const IRRELEVANT_JSON = path.join(ROOT, "data", "irrelevant-filters.json");
const GOOGLE_AUTOCOMPLETE_URL = "https://places.googleapis.com/v1/places:autocomplete";
const REQUEST_TIMEOUT_MS = 12000;

function normalizeValue(v) {
  return String(v || "").trim().toLowerCase();
}

function buildSearchSignature({ location = "", query = "", queries = [], radiusMiles = 25 }) {
  const q = Array.isArray(queries) ? queries.map(normalizeValue).filter(Boolean).sort() : [];
  return [
    normalizeValue(location),
    normalizeValue(query),
    q.join("|"),
    String(Number(radiusMiles || 25))
  ].join("::");
}

function buildRowKey(row) {
  if (row?.place_id) return `place:${String(row.place_id).trim()}`;
  if (row?.maps_url) return `map:${String(row.maps_url).trim()}`;
  if (row?.website) return `web:${String(row.website).trim()}`;
  return `name:${String(row?.name || "").trim()}|addr:${String(row?.address || "").trim()}`;
}

function loadIrrelevantRules() {
  if (!fs.existsSync(IRRELEVANT_JSON)) return [];
  try {
    const raw = fs.readFileSync(IRRELEVANT_JSON, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveIrrelevantRules(rules) {
  fs.mkdirSync(path.dirname(IRRELEVANT_JSON), { recursive: true });
  fs.writeFileSync(IRRELEVANT_JSON, `${JSON.stringify(rules, null, 2)}\n`, "utf8");
}

function getBlockedKeySet(signature) {
  const sig = normalizeValue(signature);
  const out = new Set();
  loadIrrelevantRules().forEach((rule) => {
    if (normalizeValue(rule?.signature) !== sig) return;
    const key = String(rule?.key || "").trim();
    if (key) out.add(key);
  });
  return out;
}

function getGoogleApiKey() {
  if (process.env.GOOGLE_MAPS_API_KEY) return process.env.GOOGLE_MAPS_API_KEY.trim();
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return "";
  const line = fs
    .readFileSync(envPath, "utf8")
    .split(/\r?\n/)
    .find((r) => r.trim().startsWith("GOOGLE_MAPS_API_KEY="));
  if (!line) return "";
  return line.split("=").slice(1).join("=").trim().replace(/^['"]|['"]$/g, "");
}

function extractSuggestionText(item) {
  return (
    item?.placePrediction?.text?.text ||
    item?.placePrediction?.structuredFormat?.mainText?.text ||
    item?.queryPrediction?.text?.text ||
    ""
  );
}

async function fetchLocationSuggestions(input) {
  const apiKey = getGoogleApiKey();
  if (!apiKey) return [];
  const q = String(input || "").trim();
  if (q.length < 2) return [];

  const res = await fetch(GOOGLE_AUTOCOMPLETE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey
    },
    body: JSON.stringify({
      input: q,
      languageCode: "en",
      includedRegionCodes: ["US"]
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) return [];

  const arr = Array.isArray(json.suggestions) ? json.suggestions : [];
  const out = [];
  for (const item of arr) {
    const text = extractSuggestionText(item).trim();
    if (text && !out.includes(text)) out.push(text);
    if (out.length >= 8) break;
  }
  return out;
}

function contentTypeFor(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".jpg") || filePath.endsWith(".jpeg")) return "image/jpeg";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) {
        reject(new Error("Request too large"));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/") {
      const html = fs.readFileSync(APP_HTML, "utf8");
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        Pragma: "no-cache",
        Expires: "0"
      });
      res.end(html);
      return;
    }

    if (req.method === "GET" && url.pathname === "/scllr") {
      const html = fs.readFileSync(SCLLR_HTML, "utf8");
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        Pragma: "no-cache",
        Expires: "0"
      });
      res.end(html);
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/assets/")) {
      const relPath = url.pathname.replace(/^\/+/, "");
      const filePath = path.join(UI_DIR, relPath);
      if (!filePath.startsWith(UI_DIR) || !fs.existsSync(filePath)) {
        sendJson(res, 404, { error: "Not found" });
        return;
      }
      const buf = fs.readFileSync(filePath);
      res.writeHead(200, {
        "Content-Type": contentTypeFor(filePath),
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        Pragma: "no-cache",
        Expires: "0"
      });
      res.end(buf);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/search") {
      const raw = await readBody(req);
      const input = raw ? JSON.parse(raw) : {};

      if (!input.location) {
        sendJson(res, 400, { error: "Missing location" });
        return;
      }

      const logs = [];
      const searchSignature = buildSearchSignature({
        location: input.location,
        query: input.query || "general contractor",
        queries: Array.isArray(input.queries) ? input.queries : [],
        radiusMiles: input.radiusMiles
      });
      const result = await searchSubcontractors({
        location: input.location,
        query: input.query || "general contractor",
        queries: Array.isArray(input.queries) ? input.queries : [],
        queryContexts: Array.isArray(input.queryContexts) ? input.queryContexts : [],
        strictTypeFilter: input.strictTypeFilter !== false,
        radiusMiles: input.radiusMiles,
        mode: input.mode === "statewide" ? "statewide" : "single",
        gridStepMiles: input.gridMiles,
        includeEmails: Boolean(input.includeEmails),
        onProgress: (msg) => logs.push(`${new Date().toISOString()} ${msg}`)
      });

      const blocked = getBlockedKeySet(searchSignature);
      const rows = (Array.isArray(result.rows) ? result.rows : [])
        .map((row) => ({ ...row, result_key: buildRowKey(row) }))
        .filter((row) => !blocked.has(row.result_key));

      sendJson(res, 200, {
        ...result,
        rows,
        logs,
        search_signature: searchSignature
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/irrelevant") {
      const raw = await readBody(req);
      const input = raw ? JSON.parse(raw) : {};
      const signature = String(input.signature || "").trim();
      const key = String(input.key || "").trim();
      const action = String(input.action || "add").trim().toLowerCase();
      if (!signature || !key) {
        sendJson(res, 400, { error: "Missing signature or key" });
        return;
      }

      let rules = loadIrrelevantRules();
      rules = rules.filter((r) => !(String(r.signature || "").trim() === signature && String(r.key || "").trim() === key));
      if (action !== "remove") {
        rules.push({
          signature,
          key,
          created_at: new Date().toISOString()
        });
      }
      saveIrrelevantRules(rules);
      sendJson(res, 200, { ok: true, action, signature, key });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/query-categories") {
      if (!fs.existsSync(QUERY_CATEGORIES_JSON)) {
        sendJson(res, 404, { error: "Query categories file not found" });
        return;
      }
      const raw = fs.readFileSync(QUERY_CATEGORIES_JSON, "utf8");
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(raw);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/location-suggest") {
      const q = String(url.searchParams.get("q") || "").trim();
      if (!q || q.length < 2) {
        sendJson(res, 200, { suggestions: [] });
        return;
      }
      const suggestions = await fetchLocationSuggestions(q);
      sendJson(res, 200, { suggestions });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/ping") {
      sendJson(res, 200, { ok: true, service: "subcontractor-finder" });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/scllr/stats") {
      sendJson(res, 200, scllrStats());
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/scllr/search") {
      const raw = await readBody(req);
      const input = raw ? JSON.parse(raw) : {};
      if (!input.location) {
        sendJson(res, 400, { error: "Missing location" });
        return;
      }
      const logs = [];
      const onProgress = (msg) => logs.push(`${new Date().toISOString()} ${msg}`);
      const ready = await ensureScllrCacheReady({
        query: String(input.query || "contractor"),
        onProgress
      });
      const result = await searchScllrOnly({
        location: String(input.location || ""),
        query: String(input.query || ""),
        radiusMiles: Number(input.radiusMiles || 25),
        onProgress
      });
      sendJson(res, 200, { ...result, cache_ready: ready, logs });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/scllr/refresh") {
      const raw = await readBody(req);
      const input = raw ? JSON.parse(raw) : {};
      const logs = [];
      const result = await refreshScllrCache({
        query: String(input.query || "contractor"),
        city: String(input.city || ""),
        onProgress: (msg) => logs.push(`${new Date().toISOString()} ${msg}`)
      });
      sendJson(res, 200, { ...result, logs });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/scllr/import") {
      const raw = await readBody(req);
      const input = raw ? JSON.parse(raw) : {};
      const logs = [];
      const result = await importScllrCsv({
        csvText: String(input.csvText || ""),
        merge: input.merge !== false,
        onProgress: (msg) => logs.push(`${new Date().toISOString()} ${msg}`)
      });
      sendJson(res, 200, { ...result, logs });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/csv") {
      const raw = await readBody(req);
      const input = raw ? JSON.parse(raw) : {};
      const rows = Array.isArray(input.rows) ? input.rows : [];
      const csv = toCsv(rows);
      res.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": "attachment; filename=subcontractors.csv"
      });
      res.end(csv);
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Server error" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Web app running at http://${HOST}:${PORT}`);
});
