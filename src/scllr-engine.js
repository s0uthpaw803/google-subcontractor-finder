import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.cwd());
const CACHE_FILE = path.join(ROOT, "data", "scllr-contractors.json");
const MONTHLY_DROP_DIR = path.join(ROOT, "data", "scllr-monthly-drop");
const USER_AGENT = "keystone-connect/1.0 (SCLLR verification ingestion)";
const REQUEST_TIMEOUT_MS = 20000;
const MONTHLY_MAX_AGE_DAYS = Number(process.env.SCLLR_MONTHLY_MAX_AGE_DAYS || 31);

const DEFAULT_SOURCES = [
  "https://verify.llronline.com/LicLookup/LookupMain.aspx",
  "https://verify.llronline.com/LicLookup/Contractor/Contractor.aspx?div=4",
  "https://verify.llronline.com/LicLookup/Resbu/Resbu.aspx?div=46"
];

function ensureCacheFile() {
  const dir = path.dirname(CACHE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(CACHE_FILE)) {
    fs.writeFileSync(
      CACHE_FILE,
      JSON.stringify(
        {
          source: "scllr",
          refreshed_at: "",
          rows: []
        },
        null,
        2
      )
    );
  }
}

function readCache() {
  ensureCacheFile();
  try {
    const json = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    return {
      source: "scllr",
      refreshed_at: String(json?.refreshed_at || ""),
      rows: Array.isArray(json?.rows) ? json.rows : []
    };
  } catch {
    return { source: "scllr", refreshed_at: "", rows: [] };
  }
}

function writeCache(rows) {
  ensureCacheFile();
  const payload = {
    source: "scllr",
    refreshed_at: new Date().toISOString(),
    rows
  };
  fs.writeFileSync(CACHE_FILE, JSON.stringify(payload, null, 2));
  return payload;
}

function cacheAgeDays(isoDate) {
  const ts = Date.parse(String(isoDate || ""));
  if (!Number.isFinite(ts)) return Number.POSITIVE_INFINITY;
  return (Date.now() - ts) / (1000 * 60 * 60 * 24);
}

function listMonthlyCsvFiles(dirPath = MONTHLY_DROP_DIR) {
  if (!fs.existsSync(dirPath)) return [];
  try {
    return fs
      .readdirSync(dirPath)
      .filter((f) => /\.csv$/i.test(f))
      .map((f) => path.join(dirPath, f))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function readMonthlyCsvUrls() {
  const raw = String(process.env.SCLLR_MONTHLY_CSV_URLS || "").trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function parseCsvRows(text) {
  const rows = [];
  let cur = "";
  let row = [];
  let inQuotes = false;
  const src = String(text || "");
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    const next = src[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') {
        cur += '"';
        i += 1;
        continue;
      }
      if (ch === '"') {
        inQuotes = false;
        continue;
      }
      cur += ch;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      row.push(cur);
      cur = "";
      continue;
    }
    if (ch === "\n") {
      row.push(cur);
      rows.push(row);
      row = [];
      cur = "";
      continue;
    }
    if (ch === "\r") continue;
    cur += ch;
  }
  if (cur.length || row.length) {
    row.push(cur);
    rows.push(row);
  }
  return rows;
}

function normalizeHeader(h) {
  return String(h || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function pickField(obj, keys) {
  for (const key of keys) {
    const v = obj[key];
    if (v !== undefined && v !== null && String(v).trim()) return String(v).trim();
  }
  return "";
}

function normalizeImportedRow(raw) {
  const name = pickField(raw, ["name", "company_name", "business_name", "legal_name"]);
  const license_number = pickField(raw, ["license_number", "license", "lic_no", "license_no"]);
  if (!name && !license_number) return null;
  return {
    source: "scllr",
    category_section: pickField(raw, ["category_section", "section"]) || "SCLLR Contractor License",
    name,
    license_number,
    license_status: pickField(raw, ["license_status", "status"]),
    trade: pickField(raw, ["trade", "classification", "type"]),
    phone: pickField(raw, ["phone", "phone_number"]),
    website: pickField(raw, ["website", "website_url", "url"]),
    address: pickField(raw, ["address", "street", "location"]),
    city: pickField(raw, ["city"]),
    state: pickField(raw, ["state"]) || "SC",
    zip: pickField(raw, ["zip", "zipcode", "postal_code"]),
    location_lat: Number(pickField(raw, ["location_lat", "lat", "latitude"]) || 0),
    location_lng: Number(pickField(raw, ["location_lng", "lng", "lon", "longitude"]) || 0),
    distance_miles: "",
    confidence: 100,
    reliability_score: 100,
    company_size: pickField(raw, ["company_size"]),
    company_age: pickField(raw, ["company_age"]),
    maps_url: pickField(raw, ["maps_url"]),
    place_id: pickField(raw, ["place_id"]),
    business_status: pickField(raw, ["business_status", "status"]),
    emails: pickField(raw, ["emails", "email"]),
    source_url: pickField(raw, ["source_url"]),
    verified_at: pickField(raw, ["verified_at"]) || new Date().toISOString(),
    data_use_notice: "verification_only_no_solicitation"
  };
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeLicense(value) {
  const v = String(value || "").trim();
  return /^[A-Za-z0-9-]{4,}$/.test(v) && /[0-9]/.test(v);
}

function extractRowsFromHtml(html, onProgress = () => {}) {
  const tableRows = String(html || "").match(/<tr[\s\S]*?<\/tr>/gi) || [];
  const out = [];
  for (const tr of tableRows) {
    const cellsRaw = tr.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || [];
    const cells = cellsRaw.map((c) => stripHtml(c)).filter(Boolean);
    if (cells.length < 3) continue;
    if (cells.some((c) => /license/i.test(c) && /status/i.test(c))) continue;
    if (cells.some((c) => /search results/i.test(c))) continue;
    const license = cells.find((c) => looksLikeLicense(c)) || "";
    const name = cells.find((c) => !looksLikeLicense(c) && /[A-Za-z]/.test(c)) || "";
    const status = cells.find((c) => /(active|inactive|expired|suspended|revoked)/i.test(c)) || "";
    const address = cells.find((c) => /, SC\b|South Carolina|[0-9]{5}/i.test(c)) || "";
    if (!name || !license) continue;
    out.push({
      source: "scllr",
      category_section: "SCLLR Contractor License",
      name,
      license_number: license,
      license_status: status,
      trade: "",
      phone: "",
      website: "",
      address,
      city: "",
      state: "SC",
      zip: "",
      location_lat: 0,
      location_lng: 0,
      distance_miles: "",
      confidence: 100,
      reliability_score: 100,
      company_size: "",
      company_age: "",
      maps_url: "",
      place_id: "",
      business_status: status || "",
      emails: "",
      source_url: "",
      verified_at: new Date().toISOString(),
      data_use_notice: "verification_only_no_solicitation"
    });
  }
  onProgress(`Parsed ${out.length} potential rows from SCLLR HTML.`);
  return out;
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} at ${url}`);
  return text;
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} at ${url}`);
  return text;
}

function dedupe(rows) {
  const map = new Map();
  for (const r of rows) {
    const key = `${String(r.license_number || "").toLowerCase()}|${String(r.name || "").toLowerCase()}`;
    if (!map.has(key)) map.set(key, r);
  }
  return [...map.values()];
}

function toMiles(aLat, aLng, bLat, bLng) {
  const R = 3958.8;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const q =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(q));
}

async function geocode(location) {
  const q = String(location || "").trim();
  if (!q) return null;
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=us&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  const json = await res.json().catch(() => []);
  const first = Array.isArray(json) ? json[0] : null;
  const lat = Number(first?.lat);
  const lon = Number(first?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lng: lon };
}

function normalizeText(v) {
  return String(v || "").toLowerCase().trim();
}

function matchQuery(row, query) {
  const q = normalizeText(query);
  if (!q) return true;
  const hay = [
    row.name,
    row.trade,
    row.license_number,
    row.license_status,
    row.address,
    row.city,
    row.zip
  ]
    .map((x) => normalizeText(x))
    .join(" ");
  return q
    .split(/\s+/)
    .filter(Boolean)
    .every((part) => hay.includes(part));
}

function withDistance(rows, center, radiusMiles) {
  return rows
    .map((r) => {
      if (!center || !Number.isFinite(Number(r.location_lat)) || !Number.isFinite(Number(r.location_lng))) {
        return { ...r, distance_miles: r.distance_miles || "" };
      }
      const d = toMiles(center.lat, center.lng, Number(r.location_lat), Number(r.location_lng));
      return { ...r, distance_miles: Number(d.toFixed(1)) };
    })
    .filter((r) => {
      if (r.distance_miles === "" || !Number.isFinite(Number(r.distance_miles))) return true;
      return Number(r.distance_miles) <= radiusMiles;
    });
}

export async function refreshScllrCache({
  query = "",
  city = "",
  onProgress = () => {}
} = {}) {
  const collected = [];
  const failures = [];
  const prevCache = readCache();

  for (const src of DEFAULT_SOURCES) {
    try {
      onProgress(`Fetching SCLLR source: ${src}`);
      const html = await fetchHtml(src);
      const parsed = extractRowsFromHtml(html, onProgress).map((r) => ({
        ...r,
        source_url: src
      }));
      collected.push(...parsed);
    } catch (error) {
      failures.push(error?.message || String(error));
      onProgress(`Source failed: ${src}`);
    }
  }

  const rows = dedupe(
    collected.filter((r) => {
      if (query && !matchQuery(r, query)) return false;
      // Never hard-filter ingest rows by city; city matching happens at search time.
      return true;
    })
  );

  let payload;
  let keptPreviousCache = false;
  if (!rows.length && prevCache.rows.length) {
    payload = {
      source: "scllr",
      refreshed_at: prevCache.refreshed_at,
      rows: prevCache.rows
    };
    keptPreviousCache = true;
    onProgress("No fresh rows parsed; keeping previous SCLLR cache.");
  } else {
    payload = writeCache(rows);
  }

  if (!payload.rows.length) {
    const reason = failures.length ? failures[0] : "No records were parsed from SCLLR sources.";
    throw new Error(`SCLLR refresh returned zero records. ${reason}`);
  }

  return {
    ok: true,
    source: "scllr",
    refreshed_at: payload.refreshed_at,
    rows_added: rows.length,
    rows_cached: payload.rows.length,
    kept_previous_cache: keptPreviousCache,
    city_filter_ignored_at_ingest: Boolean(city),
    failures
  };
}

export async function searchScllrOnly({
  location,
  query = "",
  radiusMiles = 25,
  onProgress = () => {}
}) {
  const safeRadius = Math.min(100, Math.max(5, Number(radiusMiles) || 25));
  const cache = readCache();
  onProgress(`Loaded ${cache.rows.length} rows from SCLLR cache.`);
  if (!cache.rows.length) {
    throw new Error("SCLLR cache is empty. Click Refresh SCLLR Cache before searching.");
  }
  const center = await geocode(location).catch(() => null);
  if (!center) {
    onProgress("Location geocoding unavailable; returning text-filtered results only.");
  }
  const filtered = cache.rows.filter((r) => matchQuery(r, query));
  const rows = withDistance(filtered, center, safeRadius).sort(
    (a, b) => Number(a.distance_miles || 9999) - Number(b.distance_miles || 9999)
  );
  return {
    meta: {
      provider: "scllr_cache",
      location_label: location,
      mode: "scllr_only",
      radius_miles: safeRadius,
      refreshed_at: cache.refreshed_at,
      records_total: cache.rows.length
    },
    rows
  };
}

export function scllrStats() {
  const cache = readCache();
  return {
    source: "scllr",
    refreshed_at: cache.refreshed_at,
    rows: cache.rows.length
  };
}

async function importLocalMonthlyDrop({ onProgress = () => {} } = {}) {
  const files = listMonthlyCsvFiles();
  if (!files.length) {
    onProgress(`No monthly CSV files found in ${MONTHLY_DROP_DIR}.`);
    return { importedRows: 0, files: 0 };
  }
  let merge = true;
  let importedRows = 0;
  onProgress(`Found ${files.length} monthly CSV file(s) in ${MONTHLY_DROP_DIR}.`);
  for (const filePath of files) {
    const csvText = fs.readFileSync(filePath, "utf8");
    const result = await importScllrCsv({
      csvText,
      merge,
      onProgress
    });
    importedRows += Number(result.rows_imported || 0);
    merge = true;
    onProgress(`Imported ${result.rows_imported} rows from ${path.basename(filePath)}.`);
  }
  return { importedRows, files: files.length };
}

async function importMonthlyUrls({ onProgress = () => {} } = {}) {
  const urls = readMonthlyCsvUrls();
  if (!urls.length) {
    onProgress("No SCLLR_MONTHLY_CSV_URLS configured.");
    return { importedRows: 0, urls: 0 };
  }
  let merge = true;
  let importedRows = 0;
  onProgress(`Attempting monthly URL import from ${urls.length} source(s).`);
  for (const url of urls) {
    try {
      const csvText = await fetchText(url);
      const result = await importScllrCsv({ csvText, merge, onProgress });
      importedRows += Number(result.rows_imported || 0);
      merge = true;
      onProgress(`Imported ${result.rows_imported} rows from URL: ${url}`);
    } catch (error) {
      onProgress(`Monthly URL import failed: ${url}`);
      onProgress(String(error?.message || error));
    }
  }
  return { importedRows, urls: urls.length };
}

export async function ensureScllrCacheReady({
  query = "",
  onProgress = () => {}
} = {}) {
  const before = readCache();
  const age = cacheAgeDays(before.refreshed_at);
  if (before.rows.length > 0 && age <= MONTHLY_MAX_AGE_DAYS) {
    onProgress(
      `SCLLR cache ready (${before.rows.length} rows, age ${age.toFixed(1)} days).`
    );
    return {
      ok: true,
      strategy: "cache_fresh",
      rows: before.rows.length,
      refreshed_at: before.refreshed_at
    };
  }

  const attempts = [];
  try {
    const refresh = await refreshScllrCache({ query, city: "", onProgress });
    attempts.push("live_refresh");
    const afterLive = readCache();
    if (afterLive.rows.length) {
      return {
        ok: true,
        strategy: "live_refresh",
        rows: afterLive.rows.length,
        refreshed_at: afterLive.refreshed_at,
        refresh
      };
    }
  } catch (error) {
    attempts.push("live_refresh_failed");
    onProgress(`Live SCLLR refresh failed: ${error?.message || String(error)}`);
  }

  const localImport = await importLocalMonthlyDrop({ onProgress });
  if (localImport.importedRows > 0) {
    attempts.push("local_monthly_drop");
    const afterLocal = readCache();
    return {
      ok: true,
      strategy: "local_monthly_drop",
      rows: afterLocal.rows.length,
      refreshed_at: afterLocal.refreshed_at,
      localImport
    };
  }

  const urlImport = await importMonthlyUrls({ onProgress });
  if (urlImport.importedRows > 0) {
    attempts.push("monthly_urls");
    const afterUrl = readCache();
    return {
      ok: true,
      strategy: "monthly_urls",
      rows: afterUrl.rows.length,
      refreshed_at: afterUrl.refreshed_at,
      urlImport
    };
  }

  const after = readCache();
  if (!after.rows.length) {
    throw new Error(
      "SCLLR cache unavailable. Live refresh failed and no monthly SCLLR CSV source was available."
    );
  }

  return {
    ok: true,
    strategy: "cache_existing",
    rows: after.rows.length,
    refreshed_at: after.refreshed_at,
    attempts
  };
}

export async function importScllrCsv({
  csvText = "",
  merge = true,
  onProgress = () => {}
} = {}) {
  const parsed = parseCsvRows(csvText);
  if (parsed.length < 2) throw new Error("CSV is empty or missing headers.");
  const headers = parsed[0].map(normalizeHeader);
  const rows = [];
  for (let i = 1; i < parsed.length; i += 1) {
    const cols = parsed[i];
    if (!cols || !cols.length) continue;
    const raw = {};
    for (let c = 0; c < headers.length; c += 1) raw[headers[c]] = cols[c] ?? "";
    const normalized = normalizeImportedRow(raw);
    if (normalized) rows.push(normalized);
  }
  const dedupedImport = dedupe(rows);
  const existing = readCache().rows;
  const finalRows = merge ? dedupe([...existing, ...dedupedImport]) : dedupe(dedupedImport);
  const payload = writeCache(finalRows);
  onProgress(`Imported ${dedupedImport.length} rows from CSV.`);
  return {
    ok: true,
    source: "scllr",
    refreshed_at: payload.refreshed_at,
    rows_imported: dedupedImport.length,
    rows_cached: payload.rows.length,
    merge
  };
}
