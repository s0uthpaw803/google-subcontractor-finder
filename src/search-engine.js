import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const PLACES_TEXT_URL = "https://places.googleapis.com/v1/places:searchText";
const REQUEST_TIMEOUT_MS = 20000;

function getGoogleApiKey() {
  if (process.env.GOOGLE_MAPS_API_KEY) return process.env.GOOGLE_MAPS_API_KEY.trim();

  const envPath = path.resolve(process.cwd(), ".env");
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

async function fetchJson(url, headers = {}) {
  const raw = await fetchText(url, headers);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Non-JSON response from ${url}`);
  }
}

async function scrapeDomainEmails(websiteUrl) {
  const website = normalizeWebsite(websiteUrl);
  if (!website) return [];

  const paths = ["/", "/contact", "/contact-us", "/about", "/team"];
  const emails = new Set();

  for (const p of paths) {
    try {
      const url = new URL(p, website).toString();
      const html = await fetchText(url, { "User-Agent": "subcontractor-finder/3.0" });
      extractEmails(html).forEach((e) => emails.add(e));
      await sleep(120);
    } catch {
      // Best effort.
    }
  }

  return [...emails].slice(0, 8);
}

function buildVariantQueries(query, location) {
  const q = String(query || "general contractor").trim();
  const base = [
    `${q} in ${location}`,
    `commercial ${q} in ${location}`,
    `${q} company in ${location}`
  ];
  return [...new Set(base)];
}

function queryIntent(query) {
  const q = String(query || "").toLowerCase();
  if (q.includes("elect")) return "electrical";
  if (q.includes("plumb")) return "plumbing";
  if (q.includes("roof")) return "roofing";
  if (q.includes("hvac") || q.includes("mechanical")) return "hvac";
  if (q.includes("drywall")) return "drywall";
  if (q.includes("concrete")) return "concrete";
  if (q.includes("paint")) return "painting";
  return "contractor";
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

function isRelevantType(types, intent) {
  const all = Array.isArray(types) ? types.map((t) => String(t).toLowerCase()) : [];
  if (!all.length) return false;
  const joined = all.join(" ");

  const blocked = [
    "car_dealer",
    "vehicle",
    "apartment",
    "real_estate",
    "school",
    "restaurant",
    "bar",
    "lodging",
    "hotel",
    "bank",
    "atm",
    "hospital",
    "doctor",
    "supermarket"
  ];
  if (blocked.some((b) => joined.includes(b))) return false;

  if (intent === "electrical") return joined.includes("electrician");
  if (intent === "plumbing") return joined.includes("plumber");
  if (intent === "roofing") return joined.includes("roof") || joined.includes("contractor");
  if (intent === "hvac") return joined.includes("hvac") || joined.includes("heating") || joined.includes("air");
  if (intent === "drywall") return joined.includes("contractor") || joined.includes("home_improvement");
  if (intent === "concrete") return joined.includes("contractor") || joined.includes("home_improvement");
  if (intent === "painting") return joined.includes("painter") || joined.includes("contractor");
  return joined.includes("contractor") || joined.includes("electrician") || joined.includes("plumber");
}

function scorePlace(place, query) {
  const businessStatus = String(place.businessStatus || "");
  const hasAddress = Boolean(place.formattedAddress);
  const hasPhone = Boolean(place.nationalPhoneNumber);
  const hasWebsite = Boolean(place.websiteUri);
  const ratings = Number(place.userRatingCount || 0);
  const types = Array.isArray(place.types) ? place.types.map((t) => String(t).toLowerCase()) : [];
  const qWords = String(query || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4);

  let score = 0;
  if (businessStatus === "OPERATIONAL") score += 40;
  if (hasAddress) score += 20;
  if (hasPhone) score += 15;
  if (hasWebsite) score += 15;
  if (ratings >= 5) score += 10;
  if (qWords.some((w) => types.some((t) => t.includes(w)))) score += 15;

  return Math.min(100, score);
}

function mapGooglePlace(place, query) {
  const placeId = place.id || "";
  const score = scorePlace(place, query);
  return {
    source: "google_places_new",
    name: place.displayName?.text || "",
    phone: place.nationalPhoneNumber || "",
    website: normalizeWebsite(place.websiteUri || ""),
    address: place.formattedAddress || "",
    maps_url: place.googleMapsUri || "",
    place_id: placeId,
    business_status: place.businessStatus || "",
    location_lat: Number(place.location?.latitude || 0),
    location_lng: Number(place.location?.longitude || 0),
    types: Array.isArray(place.types) ? place.types : [],
    confidence: score,
    emails: ""
  };
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
      textQuery: location,
      pageSize: 1,
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

async function searchTextGoogle({ textQuery, radiusMeters, apiKey, center = null }) {
  const payload = {
    textQuery,
    pageSize: 20,
    languageCode: "en",
    regionCode: "US"
  };

  if (center) {
    payload.locationBias = {
      circle: {
        center: { latitude: center.lat, longitude: center.lng },
        radius: radiusMeters
      }
    };
  }

  const res = await fetch(PLACES_TEXT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": [
        "places.id",
        "places.displayName",
        "places.location",
        "places.formattedAddress",
        "places.nationalPhoneNumber",
        "places.websiteUri",
        "places.googleMapsUri",
        "places.businessStatus",
        "places.types",
        "places.userRatingCount"
      ].join(",")
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });

  const json = await res.json();
  if (!res.ok) {
    const msg = json?.error?.message || `HTTP ${res.status}`;
    throw new Error(msg);
  }

  return Array.isArray(json.places) ? json.places : [];
}

function dedupeRows(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = row.place_id || `${row.name.toLowerCase()}|${row.phone}|${row.website}`;
    if (!map.has(key)) {
      map.set(key, row);
      continue;
    }

    const prev = map.get(key);
    map.set(key, {
      ...prev,
      phone: prev.phone || row.phone,
      website: prev.website || row.website,
      address: prev.address || row.address,
      maps_url: prev.maps_url || row.maps_url,
      confidence: Math.max(Number(prev.confidence || 0), Number(row.confidence || 0))
    });
  }
  return [...map.values()];
}

export async function searchSubcontractors({
  location,
  query,
  radiusMiles = 25,
  mode = "single",
  gridStepMiles = 35,
  includeEmails = false,
  onProgress = () => {}
}) {
  const apiKey = getGoogleApiKey();
  if (!apiKey) {
    throw new Error("Missing GOOGLE_MAPS_API_KEY. Set it in .env or env vars.");
  }

  const safeRadiusMiles = Math.min(45, Math.max(5, Number(radiusMiles) || 25));
  const center = await resolveCenterFromPlaces(location, apiKey);
  if (!center) {
    throw new Error(`Could not resolve center for "${location}"`);
  }
  const intent = queryIntent(query);

  // Fast-first progression: local ring first, then expand.
  const rings = [8, 16, 28, safeRadiusMiles]
    .filter((m, idx, arr) => m <= safeRadiusMiles && arr.indexOf(m) === idx)
    .map((m) => Math.round(m * 1609.34));

  const variants = buildVariantQueries(query, location);
  const collected = [];
  const callErrors = [];

  let step = 0;
  const total = rings.length * variants.length;
  for (const ringMeters of rings) {
    for (const v of variants) {
      step += 1;
      onProgress(`Google search ${step}/${total}: ${v} (${Math.round(ringMeters / 1609.34)} mi)`);
      const places = await searchTextGoogle({
        textQuery: v,
        radiusMeters: ringMeters,
        apiKey,
        center
      }).catch((error) => {
        const msg = error?.message || "Google Places request failed";
        callErrors.push(msg);
        onProgress(`Google error: ${msg}`);
        return [];
      });

      places.forEach((p) => collected.push(mapGooglePlace(p, query)));
      await sleep(120);
    }
  }

  let rows = dedupeRows(collected)
    .filter((r) => r.name && r.address)
    .filter((r) => String(r.business_status || "") === "OPERATIONAL" || !r.business_status)
    .filter((r) => isRelevantType(r.types, intent))
    .map((r) => {
      const hasCoords = Number.isFinite(r.location_lat) && Number.isFinite(r.location_lng) && r.location_lat !== 0 && r.location_lng !== 0;
      const d = hasCoords ? haversineMiles(center.lat, center.lng, r.location_lat, r.location_lng) : null;
      return { ...r, distance_miles: d == null ? "" : Number(d.toFixed(1)) };
    })
    .filter((r) => r.distance_miles === "" || Number(r.distance_miles) <= safeRadiusMiles + 1)
    .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0));

  if (!rows.length && callErrors.length) {
    const uniqueErrors = [...new Set(callErrors)];
    throw new Error(`Google Places failed: ${uniqueErrors[0]}`);
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
      location_label: location,
      mode,
      radius_miles: safeRadiusMiles,
      boxes: 1,
      variants: variants.length
    },
    rows
  };
}

export function toCsv(rows) {
  const headers = [
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
    "emails"
  ];
  const escape = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => escape(row[h])).join(","));
  }
  return `${lines.join("\n")}\n`;
}
