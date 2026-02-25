import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const PLACES_TEXT_URL = "https://places.googleapis.com/v1/places:searchText";
const PLACES_NEARBY_URL = "https://places.googleapis.com/v1/places:searchNearby";
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(MODULE_DIR, "..");
const TAXONOMY_JSON = path.join(ROOT_DIR, "data", "taxonomy.json");
const REQUEST_TIMEOUT_MS = 20000;
const MAX_GOOGLE_RADIUS_METERS = 50000;
const MAX_JOB_CONCURRENCY = 4;
const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.location",
  "places.types",
  "places.primaryType",
  "places.nationalPhoneNumber",
  "places.websiteUri",
  "places.googleMapsUri",
  "places.businessStatus",
  "places.rating",
  "places.userRatingCount"
].join(",");

let taxonomyCache = null;
let taxonomyMtime = 0;

function getGoogleApiKey() {
  if (process.env.GOOGLE_MAPS_API_KEY) return process.env.GOOGLE_MAPS_API_KEY.trim();

  const envPath = path.join(ROOT_DIR, ".env");
  if (!fs.existsSync(envPath)) return "";

  const line = fs
    .readFileSync(envPath, "utf8")
    .split(/\r?\n/)
    .find((r) => r.trim().startsWith("GOOGLE_MAPS_API_KEY="));

  if (!line) return "";
  return line.split("=").slice(1).join("=").trim().replace(/^['"]|['"]$/g, "");
}

function normalizeWebsite(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  try {
    return new URL(raw).toString();
  } catch {
    return "";
  }
}

function looksLikeEmail(value) {
  return /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[A-Za-z]{2,}$/.test(value);
}

function extractEmails(text) {
  const found = new Set();
  const re = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[A-Za-z]{2,}/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    const email = String(match[0]).toLowerCase();
    if (!looksLikeEmail(email)) continue;
    if (email.includes("noreply") || email.includes("no-reply")) continue;
    if (/\.(png|jpg|jpeg|svg|webp|gif|css|js|ico)$/.test(email)) continue;
    found.add(email);
  }
  return [...found];
}

async function fetchText(url, headers = {}) {
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return text;
}

async function scrapeDomainEmails(websiteUrl) {
  const website = normalizeWebsite(websiteUrl);
  if (!website) return [];

  const paths = ["/", "/contact", "/contact-us", "/about", "/team"];
  const emails = new Set();

  for (const p of paths) {
    try {
      const url = new URL(p, website).toString();
      const html = await fetchText(url, { "User-Agent": "subcontractor-finder/4.0" });
      extractEmails(html).forEach((e) => emails.add(e));
      await sleep(120);
    } catch {
      // Best effort.
    }
  }

  return [...emails].slice(0, 8);
}

function parseLatLngLocation(value) {
  const m = String(value || "").trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

function haversineMiles(aLat, aLng, bLat, bLng) {
  const R = 3958.8;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s1 = Math.sin(dLat / 2) ** 2;
  const s2 = Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s1 + s2));
}

function normalizeLabel(v) {
  return String(v || "").trim().toLowerCase();
}

function loadTaxonomy() {
  if (!fs.existsSync(TAXONOMY_JSON)) {
    return {
      version: "missing",
      defaults: {
        include_modifiers: ["commercial", "industrial", "new construction", "tenant build-out"],
        hard_exclude_terms: ["handyman", "home repair", "residential", "maid", "house painting"],
        global_exclude_terms: ["diy", "how to", "homeowner", "residential", "house", "handyman", "cheap"]
      },
      parents: [],
      indexes: {
        childByLabel: new Map(),
        childById: new Map(),
        parentById: new Map()
      }
    };
  }

  const stat = fs.statSync(TAXONOMY_JSON);
  const mtime = Number(stat.mtimeMs || 0);
  if (taxonomyCache && taxonomyMtime === mtime) return taxonomyCache;

  const raw = fs.readFileSync(TAXONOMY_JSON, "utf8");
  const parsed = JSON.parse(raw);
  const parents = Array.isArray(parsed?.parents) ? parsed.parents : [];
  const childByLabel = new Map();
  const childById = new Map();
  const parentById = new Map();

  for (const parent of parents) {
    const p = {
      parent_id: String(parent?.parent_id || "").trim(),
      parent_label: String(parent?.parent_label || "").trim(),
      children: Array.isArray(parent?.children) ? parent.children : []
    };
    if (p.parent_id) parentById.set(p.parent_id, p);

    for (const child of p.children) {
      const c = {
        child_id: String(child?.child_id || "").trim(),
        child_label: String(child?.child_label || "").trim(),
        parent_id: p.parent_id,
        parent_label: p.parent_label,
        query_profile: {
          mode: String(child?.query_profile?.mode || "TEXT_SEARCH").toUpperCase(),
          primary_terms: Array.isArray(child?.query_profile?.primary_terms) ? child.query_profile.primary_terms : [],
          secondary_terms: Array.isArray(child?.query_profile?.secondary_terms) ? child.query_profile.secondary_terms : [],
          include_modifiers: Array.isArray(child?.query_profile?.include_modifiers)
            ? child.query_profile.include_modifiers
            : Array.isArray(parsed?.defaults?.include_modifiers)
              ? parsed.defaults.include_modifiers
              : [],
          exclude_terms: Array.isArray(child?.query_profile?.exclude_terms) ? child.query_profile.exclude_terms : [],
          included_types: Array.isArray(child?.query_profile?.included_types) ? child.query_profile.included_types : [],
          excluded_types: Array.isArray(child?.query_profile?.excluded_types) ? child.query_profile.excluded_types : [],
          category_hints: Array.isArray(child?.query_profile?.category_hints) ? child.query_profile.category_hints : [],
          priority_weight: Number(child?.query_profile?.priority_weight || 1)
        }
      };

      if (c.child_id) childById.set(c.child_id, c);
      if (c.child_label) childByLabel.set(normalizeLabel(c.child_label), c);
    }
  }

  taxonomyCache = {
    version: String(parsed?.version || "1.0.0"),
    defaults: {
      include_modifiers: Array.isArray(parsed?.defaults?.include_modifiers) ? parsed.defaults.include_modifiers : [],
      hard_exclude_terms: Array.isArray(parsed?.defaults?.hard_exclude_terms) ? parsed.defaults.hard_exclude_terms : [],
      global_exclude_terms: Array.isArray(parsed?.defaults?.global_exclude_terms) ? parsed.defaults.global_exclude_terms : []
    },
    parents,
    indexes: {
      childByLabel,
      childById,
      parentById
    }
  };
  taxonomyMtime = mtime;
  return taxonomyCache;
}

async function resolveCenterFromPlaces(location, apiKey) {
  const res = await fetch(PLACES_TEXT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "places.location,places.displayName,places.formattedAddress"
    },
    body: JSON.stringify({
      textQuery: String(location || "").trim(),
      maxResultCount: 1,
      languageCode: "en",
      regionCode: "US"
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) return null;
  const p = Array.isArray(json.places) ? json.places[0] : null;
  const lat = Number(p?.location?.latitude);
  const lng = Number(p?.location?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

function buildFallbackTextQuery(textQuery) {
  const compact = String(textQuery || "").trim();
  if (!compact) return "";
  const withoutCommercial = compact.replace(/\bcommercial\b/gi, "").replace(/\s+/g, " ").trim();
  return withoutCommercial === compact ? "" : withoutCommercial;
}

function buildSelection({ query, queries = [] }) {
  const taxonomy = loadTaxonomy();
  const terms = [...new Set((Array.isArray(queries) ? queries : []).map((v) => String(v || "").trim()).filter(Boolean))];
  const selectedChildren = [];
  const seen = new Set();

  for (const term of terms) {
    const child = taxonomy.indexes.childByLabel.get(normalizeLabel(term));
    if (!child) continue;
    if (seen.has(child.child_id)) continue;
    seen.add(child.child_id);
    selectedChildren.push(child);
  }

  if (!selectedChildren.length && String(query || "").trim()) {
    const maybeChild = taxonomy.indexes.childByLabel.get(normalizeLabel(query));
    if (maybeChild) selectedChildren.push(maybeChild);
  }

  if (selectedChildren.length) {
    return {
      kind: "taxonomy",
      selectedChildren,
      manualTerms: []
    };
  }

  return {
    kind: "manual",
    selectedChildren: [],
    manualTerms: [String(query || "contractor").trim() || "contractor"]
  };
}

export function buildQueries(selection, location) {
  const taxonomy = loadTaxonomy();
  const center = location && Number.isFinite(location.lat) && Number.isFinite(location.lng)
    ? location
    : { lat: 0, lng: 0 };
  const radiusMeters = Math.min(MAX_GOOGLE_RADIUS_METERS, Math.max(1, Number(location?.radius_meters || 1609)));
  const jobs = [];

  const pushTextJob = ({ parent, child, term, profile }) => {
    const modifiers = (Array.isArray(profile.include_modifiers) && profile.include_modifiers.length
      ? profile.include_modifiers
      : taxonomy.defaults.include_modifiers
    ).join(" ").trim();

    const textQuery = [String(term || "").trim(), modifiers].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    if (!textQuery) return;

    jobs.push({
      parent_id: String(parent?.parent_id || ""),
      parent_label: String(parent?.parent_label || ""),
      child_id: String(child?.child_id || "manual"),
      child_label: String(child?.child_label || "Manual Override"),
      mode: "TEXT_SEARCH",
      term_used: String(term || "").trim(),
      child_weight: Number(profile.priority_weight || 1),
      category_hints: Array.isArray(profile.category_hints) ? profile.category_hints : [],
      exclude_terms: Array.isArray(profile.exclude_terms) ? profile.exclude_terms : [],
      headers: {
        "Content-Type": "application/json",
        "X-Goog-FieldMask": FIELD_MASK
      },
      request_url: PLACES_TEXT_URL,
      request_body: {
        textQuery,
        maxResultCount: 20,
        locationBias: {
          circle: {
            center: { latitude: center.lat, longitude: center.lng },
            radius: radiusMeters
          }
        },
        rankPreference: "RELEVANCE",
        languageCode: "en",
        regionCode: "US"
      },
      fallback_text_query: buildFallbackTextQuery(textQuery)
    });
  };

  if (selection.kind === "taxonomy") {
    for (const child of selection.selectedChildren) {
      const profile = child.query_profile || {};
      const parent = {
        parent_id: child.parent_id,
        parent_label: child.parent_label
      };
      if (String(profile.mode || "TEXT_SEARCH").toUpperCase() === "NEARBY_TYPES") {
        const includeTypes = (Array.isArray(profile.included_types) ? profile.included_types : []).filter(Boolean);
        if (includeTypes.length) {
          jobs.push({
            parent_id: String(parent.parent_id || ""),
            parent_label: String(parent.parent_label || ""),
            child_id: String(child.child_id || ""),
            child_label: String(child.child_label || ""),
            mode: "NEARBY_TYPES",
            term_used: includeTypes.join("|"),
            child_weight: Number(profile.priority_weight || 1),
            category_hints: Array.isArray(profile.category_hints) ? profile.category_hints : [],
            exclude_terms: Array.isArray(profile.exclude_terms) ? profile.exclude_terms : [],
            headers: {
              "Content-Type": "application/json",
              "X-Goog-FieldMask": FIELD_MASK
            },
            request_url: PLACES_NEARBY_URL,
            request_body: {
              includedTypes: includeTypes,
              excludedTypes: (Array.isArray(profile.excluded_types) ? profile.excluded_types : []).filter(Boolean),
              maxResultCount: 20,
              locationRestriction: {
                circle: {
                  center: { latitude: center.lat, longitude: center.lng },
                  radius: radiusMeters
                }
              },
              rankPreference: "DISTANCE"
            }
          });
        }
        continue;
      }

      const primaryTerms = Array.isArray(profile.primary_terms) ? profile.primary_terms.filter(Boolean) : [];
      const secondaryTerms = Array.isArray(profile.secondary_terms) ? profile.secondary_terms.filter(Boolean) : [];

      for (const term of primaryTerms) {
        pushTextJob({ parent, child, term, profile });
      }
      for (const term of secondaryTerms.slice(0, 2)) {
        pushTextJob({ parent, child, term, profile });
      }
    }
  } else {
    const parent = { parent_id: "manual", parent_label: "Manual Override" };
    const child = { child_id: "manual", child_label: "Manual Override" };
    const profile = {
      include_modifiers: taxonomy.defaults.include_modifiers,
      exclude_terms: taxonomy.defaults.global_exclude_terms,
      category_hints: selection.manualTerms,
      priority_weight: 1
    };
    for (const term of selection.manualTerms) {
      pushTextJob({ parent, child, term, profile });
    }
  }

  return jobs;
}

function buildLegacyQueries({ query, queries = [] }, location) {
  const center = location && Number.isFinite(location.lat) && Number.isFinite(location.lng)
    ? location
    : { lat: 0, lng: 0 };
  const radiusMeters = Math.min(MAX_GOOGLE_RADIUS_METERS, Math.max(1, Number(location?.radius_meters || 1609)));
  const rawTerms = Array.isArray(queries) && queries.length
    ? queries
    : [query || "contractor"];
  const terms = [...new Set(rawTerms.map((v) => String(v || "").trim()).filter(Boolean))];
  const jobs = [];
  const seenQuery = new Set();

  const pushLegacyJob = (term, label = "Legacy") => {
    const textQuery = String(term || "").trim().replace(/\s+/g, " ");
    if (!textQuery || seenQuery.has(textQuery.toLowerCase())) return;
    seenQuery.add(textQuery.toLowerCase());
    jobs.push({
      parent_id: "legacy",
      parent_label: label,
      child_id: "legacy",
      child_label: label,
      mode: "TEXT_SEARCH",
      term_used: textQuery,
      child_weight: 1,
      category_hints: [textQuery],
      exclude_terms: [],
      headers: {
        "Content-Type": "application/json",
        "X-Goog-FieldMask": FIELD_MASK
      },
      request_url: PLACES_TEXT_URL,
      request_body: {
        textQuery,
        maxResultCount: 20,
        locationBias: {
          circle: {
            center: { latitude: center.lat, longitude: center.lng },
            radius: radiusMeters
          }
        },
        rankPreference: "RELEVANCE",
        languageCode: "en",
        regionCode: "US"
      },
      fallback_text_query: ""
    });
  };

  for (const term of terms) {
    const t = String(term || "").trim();
    if (!t) continue;
    pushLegacyJob(t, t);
    if (!/\bcontractor\b/i.test(t)) pushLegacyJob(`${t} contractor`, t);
    if (!/\bcommercial\b/i.test(t)) pushLegacyJob(`commercial ${t}`, t);
  }

  return jobs;
}

async function fetchPlacesWithRetry({ url, payload, headers, apiKey }) {
  const maxAttempts = 4;
  const bodyPayload = { ...(payload || {}) };
  if (
    url === PLACES_TEXT_URL &&
    bodyPayload?.locationRestriction?.circle &&
    !bodyPayload?.locationBias?.circle
  ) {
    bodyPayload.locationBias = { circle: bodyPayload.locationRestriction.circle };
    delete bodyPayload.locationRestriction;
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        ...headers,
        "X-Goog-Api-Key": apiKey
      },
      body: JSON.stringify(bodyPayload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });

    const json = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true, places: Array.isArray(json?.places) ? json.places : [] };

    const code = Number(res.status || 0);
    const retriable = code === 429 || (code >= 500 && code < 600);
    if (!retriable || attempt === maxAttempts) {
      return {
        ok: false,
        error: String(json?.error?.message || `HTTP ${code}`)
      };
    }

    const waitMs = Math.min(4000, 350 * 2 ** (attempt - 1) + Math.floor(Math.random() * 120));
    await sleep(waitMs);
  }

  return { ok: false, error: "Unknown request failure" };
}

function mapPlaceToCandidate(place, job, center) {
  const lat = Number(place?.location?.latitude || 0);
  const lng = Number(place?.location?.longitude || 0);
  const hasCoords = Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0;
  const distance = hasCoords ? haversineMiles(center.lat, center.lng, lat, lng) : Number.POSITIVE_INFINITY;

  return {
    id: String(place?.id || "").trim(),
    name: String(place?.displayName?.text || "").trim(),
    formattedAddress: String(place?.formattedAddress || "").trim(),
    phone: String(place?.nationalPhoneNumber || "").trim(),
    website: normalizeWebsite(place?.websiteUri || ""),
    maps_url: String(place?.googleMapsUri || "").trim(),
    location: hasCoords ? { lat, lng } : null,
    primaryType: String(place?.primaryType || "").trim(),
    types: Array.isArray(place?.types) ? place.types.map((t) => String(t || "").trim()).filter(Boolean) : [],
    rating: Number(place?.rating || 0),
    userRatingCount: Number(place?.userRatingCount || 0),
    business_status: String(place?.businessStatus || "").trim(),
    distance_miles: Number.isFinite(distance) ? Number(distance.toFixed(2)) : "",
    matched_children: [job.child_id].filter(Boolean),
    matched_terms: [job.term_used].filter(Boolean),
    matched_sections: [job.parent_label].filter(Boolean),
    category_hints: Array.isArray(job.category_hints) ? job.category_hints : [],
    child_weight: Number(job.child_weight || 1),
    profile_exclude_terms: Array.isArray(job.exclude_terms) ? job.exclude_terms : []
  };
}

export async function runPlacesJobs(jobs, { apiKey, center, onProgress = () => {} } = {}) {
  const queue = Array.isArray(jobs) ? jobs.slice() : [];
  const out = [];
  const errors = [];
  let completed = 0;

  async function worker() {
    while (queue.length) {
      const job = queue.shift();
      if (!job) break;

      const result = await fetchPlacesWithRetry({
        url: job.request_url,
        payload: job.request_body,
        headers: job.headers,
        apiKey
      });

      if (!result.ok) {
        errors.push(result.error || "Request failed");
      } else {
        const baseRows = result.places.map((p) => mapPlaceToCandidate(p, job, center));
        out.push(...baseRows);

        if (job.mode === "TEXT_SEARCH" && baseRows.length < 5 && String(job.fallback_text_query || "").trim()) {
          const fallbackPayload = {
            ...job.request_body,
            textQuery: String(job.fallback_text_query).trim()
          };
          const retryResult = await fetchPlacesWithRetry({
            url: job.request_url,
            payload: fallbackPayload,
            headers: job.headers,
            apiKey
          });
          if (retryResult.ok) {
            out.push(...retryResult.places.map((p) => mapPlaceToCandidate(p, { ...job, term_used: `${job.term_used} (fallback)` }, center)));
          }
        }
      }

      completed += 1;
      onProgress(`Google search ${completed}/${jobs.length}: ${job.child_label} - ${job.term_used}`);
      await sleep(80);
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(MAX_JOB_CONCURRENCY, jobs.length)) }, () => worker());
  await Promise.all(workers);
  return { candidates: out, errors };
}

function inferCompanySize(userRatingCount) {
  const n = Number(userRatingCount || 0);
  if (n >= 100) return "large";
  if (n >= 25) return "medium";
  if (n > 0) return "small";
  return "";
}

function textBlobOf(row) {
  return [
    String(row?.name || ""),
    String(row?.formattedAddress || ""),
    String(row?.website || ""),
    String(row?.primaryType || ""),
    ...(Array.isArray(row?.types) ? row.types : [])
  ].join(" ").toLowerCase();
}

export function mergeDedupRank(allResults, { center, radiusMiles = 25, strictTypeFilter = true } = {}) {
  const taxonomy = loadTaxonomy();
  const hardExcludes = (taxonomy.defaults.hard_exclude_terms || []).map((s) => normalizeLabel(s));
  const globalSoftExcludes = (taxonomy.defaults.global_exclude_terms || []).map((s) => normalizeLabel(s));
  const expectedTypeHints = [
    "general_contractor",
    "contractor",
    "electrician",
    "plumber",
    "roofing_contractor",
    "hvac_contractor",
    "construction_company"
  ];

  const merged = new Map();
  for (const row of Array.isArray(allResults) ? allResults : []) {
    const key = String(row?.id || "").trim();
    if (!key) continue;
    if (!merged.has(key)) {
      merged.set(key, { ...row });
      continue;
    }

    const prev = merged.get(key);
    const next = {
      ...prev,
      phone: prev.phone || row.phone,
      website: prev.website || row.website,
      maps_url: prev.maps_url || row.maps_url,
      formattedAddress: prev.formattedAddress || row.formattedAddress,
      primaryType: prev.primaryType || row.primaryType,
      types: [...new Set([...(prev.types || []), ...(row.types || [])])],
      rating: Math.max(Number(prev.rating || 0), Number(row.rating || 0)),
      userRatingCount: Math.max(Number(prev.userRatingCount || 0), Number(row.userRatingCount || 0)),
      distance_miles: Math.min(Number(prev.distance_miles || Number.POSITIVE_INFINITY), Number(row.distance_miles || Number.POSITIVE_INFINITY)),
      matched_children: [...new Set([...(prev.matched_children || []), ...(row.matched_children || [])])],
      matched_terms: [...new Set([...(prev.matched_terms || []), ...(row.matched_terms || [])])],
      matched_sections: [...new Set([...(prev.matched_sections || []), ...(row.matched_sections || [])])],
      category_hints: [...new Set([...(prev.category_hints || []), ...(row.category_hints || [])])],
      profile_exclude_terms: [...new Set([...(prev.profile_exclude_terms || []), ...(row.profile_exclude_terms || [])])],
      child_weight: Math.max(Number(prev.child_weight || 1), Number(row.child_weight || 1))
    };
    merged.set(key, next);
  }

  const filtered = [];
  for (const row of merged.values()) {
    const blob = textBlobOf(row);

    const hardHit = hardExcludes.some((term) => term && blob.includes(term));
    if (hardHit) continue;

    if (!Number.isFinite(Number(row.distance_miles)) || Number(row.distance_miles) > Number(radiusMiles || 25)) {
      continue;
    }

    const typeText = [String(row.primaryType || ""), ...(Array.isArray(row.types) ? row.types : [])]
      .join(" ")
      .toLowerCase();
    const hintHit = (Array.isArray(row.category_hints) ? row.category_hints : []).some((h) =>
      h && String(row.name || "").toLowerCase().includes(String(h).toLowerCase())
    );

    let score = 0;
    if (expectedTypeHints.some((h) => typeText.includes(h))) score += 30;
    if (hintHit) score += 15;
    if (row.website) score += 10;
    if (Number(row.userRatingCount || 0) >= 20) score += 10;
    if (Number(row.rating || 0) >= 4.2) score += 5;

    const dist = Number(row.distance_miles || 9999);
    const proximityBonus = Math.max(0, 20 - Math.min(20, (dist / Math.max(1, Number(radiusMiles || 25))) * 20));
    score += proximityBonus;

    const softTerms = [...globalSoftExcludes, ...(Array.isArray(row.profile_exclude_terms) ? row.profile_exclude_terms.map((t) => normalizeLabel(t)) : [])]
      .filter(Boolean);
    const softHits = softTerms.filter((term) => blob.includes(term));
    if (softHits.length) score -= Math.min(30, softHits.length * 10);

    score = Math.max(0, Math.round(score * Number(row.child_weight || 1)));

    if (strictTypeFilter && score < 10) continue;

    filtered.push({
      id: row.id,
      source: "google_places_new",
      name: row.name,
      phone: row.phone,
      website: row.website,
      address: row.formattedAddress,
      maps_url: row.maps_url,
      place_id: row.id,
      business_status: row.business_status,
      location_lat: Number(row.location?.lat || 0),
      location_lng: Number(row.location?.lng || 0),
      primaryType: row.primaryType,
      types: row.types,
      rating: Number(row.rating || 0),
      user_rating_count: Number(row.userRatingCount || 0),
      distance_miles: Number(row.distance_miles || 0),
      matched_children: row.matched_children,
      matched_terms: row.matched_terms,
      category_section: (row.matched_sections || []).join("; "),
      confidence: score,
      reliability_score: score,
      relevance_score: score,
      company_size: inferCompanySize(row.userRatingCount),
      company_age: "",
      emails: ""
    });
  }

  filtered.sort((a, b) => {
    const scoreDiff = Number(b.relevance_score || 0) - Number(a.relevance_score || 0);
    if (scoreDiff !== 0) return scoreDiff;

    const ratingsDiff = Number(b.user_rating_count || 0) - Number(a.user_rating_count || 0);
    if (ratingsDiff !== 0) return ratingsDiff;

    const ratingDiff = Number(b.rating || 0) - Number(a.rating || 0);
    if (ratingDiff !== 0) return ratingDiff;

    return Number(a.distance_miles || 9999) - Number(b.distance_miles || 9999);
  });

  return filtered;
}

export async function searchSubcontractors({
  location,
  query,
  queries = [],
  strictTypeFilter = true,
  radiusMiles = 25,
  engineMode = "api",
  includeEmails = false,
  onProgress = () => {}
}) {
  const apiKey = getGoogleApiKey();
  if (!apiKey) {
    throw new Error("Missing GOOGLE_MAPS_API_KEY. Set it in .env or env vars.");
  }

  const center = parseLatLngLocation(location) || (await resolveCenterFromPlaces(location, apiKey));
  if (!center) {
    throw new Error(`Could not resolve center for "${location}"`);
  }

  const safeRadiusMiles = Math.max(1, Math.min(45, Number(radiusMiles || 25)));
  const selection = buildSelection({ query, queries });
  const normalizedEngineMode = String(engineMode || "api").toLowerCase() === "ggl" ? "ggl" : "api";
  const jobs = (normalizedEngineMode === "ggl" ? buildLegacyQueries({ query, queries }, {
    lat: center.lat,
    lng: center.lng,
    radius_meters: Math.round(safeRadiusMiles * 1609.34)
  }) : buildQueries(selection, {
    lat: center.lat,
    lng: center.lng,
    radius_meters: Math.round(safeRadiusMiles * 1609.34)
  }));

  if (!jobs.length) {
    return {
      meta: {
        provider: "google_places_new",
        location_label: location,
        radius_miles: safeRadiusMiles,
        variants: 0,
        query_context: selection.kind
      },
      rows: []
    };
  }

  const { candidates, errors } = await runPlacesJobs(jobs, {
    apiKey,
    center,
    onProgress
  });

  let rows = mergeDedupRank(candidates, {
    center,
    radiusMiles: safeRadiusMiles,
    strictTypeFilter: normalizedEngineMode === "ggl" ? false : strictTypeFilter
  });

  if (!rows.length && errors.length) {
    throw new Error(`Google Places failed: ${errors[0]}`);
  }

  if (includeEmails) {
    onProgress("Email enrichment...");
    for (let i = 0; i < rows.length; i += 1) {
      const emails = await scrapeDomainEmails(rows[i].website);
      rows[i].emails = emails.join("; ");
      if ((i + 1) % 10 === 0 || i === rows.length - 1) {
        onProgress(`Email enrichment ${i + 1}/${rows.length}`);
      }
    }
  }

  onProgress(`Done. ${rows.length} rows.`);

  return {
    meta: {
      provider: "google_places_new",
      query_engine: normalizedEngineMode,
      location_label: location,
      radius_miles: safeRadiusMiles,
      variants: jobs.length,
      query_context: normalizedEngineMode === "ggl" ? "legacy" : selection.kind
    },
    rows
  };
}

export function taxonomyForUi() {
  const taxonomy = loadTaxonomy();
  const sections = (taxonomy.parents || []).map((p) => ({
    id: String(p?.parent_id || ""),
    label: String(p?.parent_label || ""),
    section: String(p?.parent_label || ""),
    children: (Array.isArray(p?.children) ? p.children : [])
      .map((c) => String(c?.child_label || "").trim())
      .filter(Boolean)
  }));

  return {
    legend: "Selecting a parent runs all child categories in that section.",
    sections
  };
}

export function toCsv(rows) {
  const headers = [
    "category_section",
    "source",
    "name",
    "phone",
    "website",
    "address",
    "distance_miles",
    "maps_url",
    "place_id",
    "business_status",
    "confidence",
    "reliability_score",
    "relevance_score",
    "company_size",
    "company_age",
    "matched_children",
    "matched_terms",
    "emails"
  ];
  const cleanCategorySection = (value) =>
    String(value ?? "")
      .replace(/[\u2012\u2013\u2014\u2015]/g, "-")
      .replace(/[^\x20-\x7E]/g, "")
      .replace(/\s+/g, " ")
      .trim();

  const escape = (v, key = "") => {
    let raw = Array.isArray(v) ? v.join("; ") : v;
    if (key === "category_section") raw = cleanCategorySection(raw);
    const s = String(raw ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => escape(row[h], h)).join(","));
  }
  return `${lines.join("\n")}\n`;
}
