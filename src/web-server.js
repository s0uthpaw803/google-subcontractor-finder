#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { pathToFileURL } from "node:url";
import { searchSubcontractors, toCsv, taxonomyForUi } from "./search-engine.js";

const DEFAULT_PORT = Number(process.env.PORT || 8787);
const DEFAULT_HOST = process.env.HOST || "0.0.0.0";
const ROOT = path.resolve(process.env.KEYSTONE_ROOT || process.cwd());
const APP_HTML = path.join(ROOT, "ui", "app.html");
const APP_V2_HTML = path.join(ROOT, "ui-v2", "app.html");
const UI_DIR = path.join(ROOT, "ui");
const UI_V2_DIR = path.join(ROOT, "ui-v2");
const SOURCE_DATA_DIR = path.join(ROOT, "data");
const DATA_DIR = path.resolve(
  process.env.KEYSTONE_DATA_DIR ||
  (String(process.env.RENDER || "").toLowerCase() === "true" ? "/var/data" : SOURCE_DATA_DIR)
);
const IRRELEVANT_JSON = path.join(DATA_DIR, "irrelevant-filters.json");
const PREFERRED_JSON = path.join(DATA_DIR, "preferred-results.json");
const GOOGLE_AUTOCOMPLETE_URL = "https://places.googleapis.com/v1/places:autocomplete";
const NOMINATIM_REVERSE_URL = "https://nominatim.openstreetmap.org/reverse";
const NOMINATIM_SEARCH_URL = "https://nominatim.openstreetmap.org/search";
const REQUEST_TIMEOUT_MS = 12000;

function initializeRuntimeDataFile(fileName) {
  const targetPath = path.join(DATA_DIR, fileName);
  if (fs.existsSync(targetPath)) return;

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const sourcePath = path.join(SOURCE_DATA_DIR, fileName);
  if (sourcePath !== targetPath && fs.existsSync(sourcePath)) {
    fs.copyFileSync(sourcePath, targetPath);
    return;
  }
  fs.writeFileSync(targetPath, "[]\n", "utf8");
}

initializeRuntimeDataFile("irrelevant-filters.json");
initializeRuntimeDataFile("preferred-results.json");

function normalizeValue(v) {
  return String(v || "").trim().toLowerCase();
}

function buildSearchSignature({ location = "", query = "", queries = [], radiusMiles = 25, engineMode = "api" }) {
  const q = Array.isArray(queries) ? queries.map(normalizeValue).filter(Boolean).sort() : [];
  return [
    normalizeValue(engineMode),
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

function loadPreferredRows() {
  if (!fs.existsSync(PREFERRED_JSON)) return [];
  try {
    const raw = fs.readFileSync(PREFERRED_JSON, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function savePreferredRows(rows) {
  fs.mkdirSync(path.dirname(PREFERRED_JSON), { recursive: true });
  fs.writeFileSync(PREFERRED_JSON, `${JSON.stringify(rows, null, 2)}\n`, "utf8");
}

function sanitizePreferredRow(input) {
  const row = input && typeof input === "object" ? input : {};
  return {
    result_key: buildRowKey(row),
    source: String(row.source || ""),
    name: String(row.name || ""),
    phone: String(row.phone || ""),
    website: String(row.website || ""),
    address: String(row.address || ""),
    distance_miles: Number.isFinite(Number(row.distance_miles)) ? Number(row.distance_miles) : "",
    maps_url: String(row.maps_url || row.map_url || ""),
    place_id: String(row.place_id || ""),
    business_status: String(row.business_status || ""),
    confidence: Number.isFinite(Number(row.confidence)) ? Number(row.confidence) : "",
    reliability_score: Number.isFinite(Number(row.reliability_score)) ? Number(row.reliability_score) : "",
    company_size: String(row.company_size || ""),
    company_age: String(row.company_age || ""),
    emails: String(row.emails || ""),
    category_section: String(row.category_section || ""),
    preferred_city: String(row.preferred_city || ""),
    preferred_category: String(row.preferred_category || ""),
    preferred_at: new Date().toISOString()
  };
}

function getGoogleApiKey() {
  const direct =
    String(process.env.GOOGLE_MAPS_API_KEY || "").trim() ||
    String(process.env.KEYSTONE_GOOGLE_MAPS_API_KEY || "").trim();
  if (direct) return direct;

  const readKeyFromEnvFile = (envPath) => {
    try {
      if (!envPath || !fs.existsSync(envPath)) return "";
      const line = fs
        .readFileSync(envPath, "utf8")
        .split(/\r?\n/)
        .find((r) => /^(\s*export\s+)?GOOGLE_MAPS_API_KEY\s*=/.test(r));
      if (!line) return "";
      return line
        .replace(/^(\s*export\s+)?GOOGLE_MAPS_API_KEY\s*=\s*/, "")
        .trim()
        .replace(/^['"]|['"]$/g, "");
    } catch {
      return "";
    }
  };

  const candidates = [];
  const push = (p) => {
    const v = String(p || "").trim();
    if (!v || candidates.includes(v)) return;
    candidates.push(v);
  };

  push(process.env.KEYSTONE_ENV_PATH);
  push(path.join(ROOT, ".env"));
  push(path.join(process.cwd(), ".env"));
  push(path.join(String(process.env.KEYSTONE_ROOT || ROOT), ".env"));
  if (process.env.KEYSTONE_USER_DATA) push(path.join(process.env.KEYSTONE_USER_DATA, ".env"));
  if (process.resourcesPath) push(path.join(process.resourcesPath, ".env"));
  if (process.execPath) push(path.join(path.dirname(process.execPath), ".env"));

  for (const envPath of candidates) {
    const key = readKeyFromEnvFile(envPath);
    if (key) return key;
  }
  return "";
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

async function reverseZipLookup(lat, lng) {
  const url = new URL(NOMINATIM_REVERSE_URL);
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lng));
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("zoom", "18");

  const res = await fetch(url, {
    headers: {
      "User-Agent": "keystone-connect/1.0"
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) return { zip: "", label: "" };

  const zip = String(json?.address?.postcode || "").trim();
  const city =
    String(
      json?.address?.city ||
      json?.address?.town ||
      json?.address?.village ||
      json?.address?.hamlet ||
      ""
    ).trim();
  const state = String(json?.address?.state || "").trim();
  const label = [city, state].filter(Boolean).join(", ");
  return { zip, label };
}

async function resolveCityFromLocation(location) {
  const q = String(location || "").trim();
  if (!q) return { city: "" };
  const url = new URL(NOMINATIM_SEARCH_URL);
  url.searchParams.set("q", q);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("limit", "1");
  url.searchParams.set("countrycodes", "us");

  const res = await fetch(url, {
    headers: {
      "User-Agent": "keystone-connect/1.0"
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  const json = await res.json().catch(() => []);
  if (!res.ok) return { city: "" };
  const first = Array.isArray(json) ? json[0] : null;
  const address = first?.address || {};
  const city = String(address.city || address.town || address.village || address.hamlet || "").trim();
  return { city };
}

function requestClientIp(req) {
  const forwarded = String(req?.headers?.["x-forwarded-for"] || "")
    .split(",")[0]
    .trim();
  const direct = String(
    req?.headers?.["cf-connecting-ip"] ||
    req?.headers?.["x-real-ip"] ||
    ""
  ).trim();
  let ip = forwarded || direct;
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(ip)) ip = ip.replace(/:\d+$/, "");
  return ip;
}

async function fetchApproxLocationFromIp(clientIp = "") {
  const encodedIp = encodeURIComponent(String(clientIp || "").trim());
  const endpoints = encodedIp
    ? [
        `https://ipapi.co/${encodedIp}/json/`,
        `https://ipwho.is/${encodedIp}`
      ]
    : [
        "https://ipapi.co/json/",
        "https://ipwho.is/"
      ];

  for (const endpoint of endpoints) {
    try {
      const res = await fetch(endpoint, {
        headers: {
          "User-Agent": "keystone-connect/1.0",
          Accept: "application/json"
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) continue;

      const lat = Number(
        json?.latitude ??
        json?.lat
      );
      const lng = Number(
        json?.longitude ??
        json?.lon ??
        json?.lng
      );
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

      const city = String(
        json?.city ||
        json?.city_name ||
        ""
      ).trim();
      const state = String(
        json?.region ||
        json?.region_code ||
        json?.state ||
        ""
      ).trim();
      const label = [city, state].filter(Boolean).join(", ");
      return {
        lat,
        lng,
        label,
        source: endpoint.includes("ipapi.co") ? "ipapi" : "ipwhois"
      };
    } catch {
      // try next provider
    }
  }
  return null;
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
      const html = fs.readFileSync(APP_V2_HTML, "utf8");
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        Pragma: "no-cache",
        Expires: "0"
      });
      res.end(html);
      return;
    }

    if (req.method === "GET" && url.pathname === "/v2") {
      const html = fs.readFileSync(APP_V2_HTML, "utf8");
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        Pragma: "no-cache",
        Expires: "0"
      });
      res.end(html);
      return;
    }

    if (req.method === "GET" && (url.pathname === "/ui-v2" || url.pathname === "/ui-v2/app.html")) {
      const html = fs.readFileSync(APP_V2_HTML, "utf8");
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        Pragma: "no-cache",
        Expires: "0"
      });
      res.end(html);
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1") {
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

    if (req.method === "GET" && url.pathname.startsWith("/v2/assets/")) {
      const relPath = url.pathname.replace(/^\/v2\/+/, "");
      const filePath = path.join(UI_V2_DIR, relPath);
      if (!filePath.startsWith(UI_V2_DIR) || !fs.existsSync(filePath)) {
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

    if (req.method === "GET" && url.pathname.startsWith("/ui-v2/assets/")) {
      const relPath = url.pathname.replace(/^\/ui-v2\/+/, "");
      const filePath = path.join(UI_V2_DIR, relPath);
      if (!filePath.startsWith(UI_V2_DIR) || !fs.existsSync(filePath)) {
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
        radiusMiles: input.radiusMiles,
        engineMode: input.engineMode
      });
      const result = await searchSubcontractors({
        location: input.location,
        query: input.query || "general contractor",
        queries: Array.isArray(input.queries) ? input.queries : [],
        queryContexts: Array.isArray(input.queryContexts) ? input.queryContexts : [],
        strictTypeFilter: input.strictTypeFilter !== false,
        radiusMiles: input.radiusMiles,
        engineMode: (() => {
          const mode = String(input.engineMode || "apib").toLowerCase();
          if (mode === "ggl" || mode === "api" || mode === "apib") return mode;
          return "apib";
        })(),
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

    if (req.method === "GET" && url.pathname === "/api/preferred") {
      sendJson(res, 200, { rows: loadPreferredRows() });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/preferred") {
      const raw = await readBody(req);
      const input = raw ? JSON.parse(raw) : {};
      const action = String(input.action || "add").trim().toLowerCase();
      const key = String(input.key || "").trim();
      let rows = loadPreferredRows();

      if (action === "remove") {
        if (!key) {
          sendJson(res, 400, { error: "Missing key" });
          return;
        }
        rows = rows.filter((r) => String(r.result_key || "").trim() !== key);
        savePreferredRows(rows);
        sendJson(res, 200, { ok: true, action: "remove", key, rows });
        return;
      }

      const row = sanitizePreferredRow(input.row || {});
      if (!row.result_key) {
        sendJson(res, 400, { error: "Missing row key" });
        return;
      }
      rows = rows.filter((r) => String(r.result_key || "").trim() !== row.result_key);
      rows.push(row);
      savePreferredRows(rows);
      sendJson(res, 200, { ok: true, action: "add", row, rows });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/query-categories") {
      sendJson(res, 200, taxonomyForUi());
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

    if (req.method === "GET" && url.pathname === "/api/reverse-zip") {
      const lat = Number(url.searchParams.get("lat"));
      const lng = Number(url.searchParams.get("lng"));
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        sendJson(res, 400, { error: "Missing or invalid lat/lng" });
        return;
      }
      const result = await reverseZipLookup(lat, lng);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/location-city") {
      const q = String(url.searchParams.get("q") || "").trim();
      if (!q) {
        sendJson(res, 200, { city: "" });
        return;
      }
      const result = await resolveCityFromLocation(q);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/ip-location") {
      const result = await fetchApproxLocationFromIp(requestClientIp(req));
      if (!result) {
        sendJson(res, 503, { error: "IP location unavailable" });
        return;
      }
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/ping") {
      sendJson(res, 200, { ok: true, service: "keystone-connect" });
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

let started = false;
let currentHost = DEFAULT_HOST;
let currentPort = DEFAULT_PORT;

export async function startServer({ host = DEFAULT_HOST, port = DEFAULT_PORT } = {}) {
  if (started) {
    return { server, host: currentHost, port: currentPort };
  }

  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      started = true;
      currentHost = host;
      currentPort = port;
      console.log(`Web app running at http://${host}:${port}`);
      resolve({ server, host, port });
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

export async function stopServer() {
  if (!started) return;
  await new Promise((resolve) => {
    server.close(() => resolve());
  });
  started = false;
}

const isDirectRun = (() => {
  const argPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
  if (!argPath) return false;
  return import.meta.url === pathToFileURL(argPath).href;
})();

if (isDirectRun) {
  startServer().catch((error) => {
    console.error(error?.message || error);
    process.exit(1);
  });
}
