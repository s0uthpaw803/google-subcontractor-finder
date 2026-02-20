import { setTimeout as sleep } from "node:timers/promises";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const OVERPASS_URLS = [
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://overpass.openstreetmap.fr/api/interpreter"
];

const HTTP_HEADERS = {
  "User-Agent": "subcontractor-finder/2.0",
  Accept: "application/json,text/html;q=0.9,*/*;q=0.8"
};

const REQUEST_TIMEOUT_MS = 12000;
const MAX_RADIUS_MILES = 45;

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripTags(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseNominatimBounds(boundingbox) {
  if (!Array.isArray(boundingbox) || boundingbox.length < 4) return null;
  const south = Number(boundingbox[0]);
  const north = Number(boundingbox[1]);
  const west = Number(boundingbox[2]);
  const east = Number(boundingbox[3]);
  if (![south, north, west, east].every(Number.isFinite)) return null;
  return { south, north, west, east };
}

function milesToLatitudeDegrees(miles) {
  return miles / 69;
}

function milesToLongitudeDegrees(miles, lat) {
  const cosLat = Math.max(Math.cos((lat * Math.PI) / 180), 0.15);
  return miles / (69 * cosLat);
}

function buildQueryVariants(query) {
  const base = String(query || "subcontractor").trim();
  const words = base.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
  const set = new Set([
    base,
    "subcontractor",
    "general contractor",
    "commercial contractor",
    "construction company",
    "electrical contractor",
    "plumbing contractor",
    "hvac contractor",
    "mechanical contractor",
    "roofing contractor",
    "drywall contractor",
    "concrete contractor",
    "framing contractor",
    "painting contractor",
    "site contractor"
  ]);
  words.forEach((w) => set.add(w));
  return [...set].slice(0, 12);
}

async function fetchText(url, options = {}) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const res = await fetch(url, {
      ...options,
      headers: { ...HTTP_HEADERS, ...(options.headers || {}) },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    const text = await res.text();

    if (res.ok) {
      return text;
    }

    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await sleep(800 * (attempt + 1));
      continue;
    }

    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  throw new Error(`HTTP request failed for ${url}`);
}

async function fetchJson(url, options = {}) {
  const raw = await fetchText(url, options);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Non-JSON response from ${url}`);
  }
}

async function geocodeLocation(location) {
  const fallback = {
    "augusta, ga": {
      label: "Augusta, Richmond County, Georgia, United States",
      lat: 33.47097,
      lng: -81.97484,
      bounds: { south: 33.3242, north: 33.6115, west: -82.1756, east: -81.7809 }
    }
  };

  let arr = null;
  try {
    const url = new URL(NOMINATIM_URL);
    url.searchParams.set("q", location);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("countrycodes", "us");
    url.searchParams.set("limit", "1");
    arr = await fetchJson(url);
  } catch (error) {
    const key = String(location || "").trim().toLowerCase();
    if (fallback[key]) {
      return fallback[key];
    }
    throw error;
  }

  if (!Array.isArray(arr) || !arr.length) {
    const key = String(location || "").trim().toLowerCase();
    if (fallback[key]) {
      return fallback[key];
    }
    throw new Error(`No geocode result for "${location}"`);
  }

  const first = arr[0];
  return {
    label: first.display_name,
    lat: Number(first.lat),
    lng: Number(first.lon),
    bounds: parseNominatimBounds(first.boundingbox)
  };
}

function singleBoxFromCenter(lat, lng, radiusMiles) {
  const latPad = milesToLatitudeDegrees(radiusMiles);
  const lngPad = milesToLongitudeDegrees(radiusMiles, lat);
  return { south: lat - latPad, north: lat + latPad, west: lng - lngPad, east: lng + lngPad };
}

function buildGridBoxes(bounds, stepMiles, radiusMiles) {
  const boxes = [];
  const latStep = milesToLatitudeDegrees(stepMiles);
  for (let lat = bounds.south; lat <= bounds.north; lat += latStep) {
    const lngStep = milesToLongitudeDegrees(stepMiles, lat);
    for (let lng = bounds.west; lng <= bounds.east; lng += lngStep) {
      boxes.push(singleBoxFromCenter(lat, lng, radiusMiles));
    }
  }
  return boxes;
}

function normalizeOsmType(osmType) {
  if (osmType === "N") return "node";
  if (osmType === "W") return "way";
  if (osmType === "R") return "relation";
  return osmType || "node";
}

function mapNominatimRow(item) {
  const ext = item.extratags || {};
  const t = normalizeOsmType(item.osm_type);
  const id = item.osm_id || item.place_id;
  return {
    source: "nominatim",
    name: item.name || String(item.display_name || "").split(",")[0] || "",
    phone: ext.phone || ext["contact:phone"] || "",
    website: ext.website || ext["contact:website"] || "",
    address: item.display_name || "",
    maps_url: `https://www.openstreetmap.org/${t}/${id}`,
    place_id: `osm:${t}/${id}`
  };
}

async function nominatimSearchText(query, location, limit = 25) {
  const url = new URL(NOMINATIM_URL);
  url.searchParams.set("q", `${query} ${location}`);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("countrycodes", "us");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("extratags", "1");
  url.searchParams.set("limit", String(limit));
  const arr = await fetchJson(url);
  if (!Array.isArray(arr)) return [];
  return arr.map(mapNominatimRow).filter((r) => r.name);
}

async function nominatimSearchBox(query, box, limit = 50) {
  const url = new URL(NOMINATIM_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("countrycodes", "us");
  url.searchParams.set("bounded", "1");
  url.searchParams.set("viewbox", `${box.west},${box.north},${box.east},${box.south}`);
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("extratags", "1");
  url.searchParams.set("limit", String(limit));

  const arr = await fetchJson(url);
  if (!Array.isArray(arr)) return [];
  return arr.map(mapNominatimRow).filter((r) => r.name);
}

function overpassQuery(query, box) {
  const regex = buildQueryVariants(query)
    .slice(0, 10)
    .map(escapeRegex)
    .join("|");

  return `
[out:json][timeout:50];
(
  nwr["name"~"(${regex})",i](${box.south},${box.west},${box.north},${box.east});
  nwr["craft"~"electrician|plumber|roofer|builder|hvac|carpenter|painter",i](${box.south},${box.west},${box.north},${box.east});
  nwr["office"~"contractor|construction_company|company",i](${box.south},${box.west},${box.north},${box.east});
);
out center tags;`;
}

function mapOverpassRow(el) {
  const tags = el.tags || {};
  const type = el.type || "node";
  const id = el.id;
  const line1 = [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean).join(" ");
  const line2 = [tags["addr:city"], tags["addr:state"], tags["addr:postcode"]].filter(Boolean).join(", ");
  const address = [line1, line2].filter(Boolean).join(", ");

  return {
    source: "overpass",
    name: tags.name || tags.operator || "",
    phone: tags.phone || tags["contact:phone"] || "",
    website: tags.website || tags["contact:website"] || "",
    address,
    maps_url: `https://www.openstreetmap.org/${type}/${id}`,
    place_id: `osm:${type}/${id}`
  };
}

async function overpassSearchBox(query, box) {
  const q = overpassQuery(query, box);
  for (const endpoint of OVERPASS_URLS) {
    try {
      const url = new URL(endpoint);
      url.searchParams.set("data", q);
      const data = await fetchJson(url);
      if (!Array.isArray(data.elements)) continue;
      return data.elements.map(mapOverpassRow).filter((r) => r.name);
    } catch {
      // Try next endpoint.
    }
  }
  return [];
}

function extractBetween(value, startToken, endToken) {
  const s = value.indexOf(startToken);
  if (s < 0) return "";
  const from = s + startToken.length;
  const e = value.indexOf(endToken, from);
  if (e < 0) return "";
  return value.slice(from, e);
}

function parseYellowPages(html) {
  const segments = html.split('<div class="result"').slice(1);
  const out = [];

  for (const seg of segments) {
    const nameRaw = extractBetween(seg, 'class="business-name"', "</a>");
    const href = extractBetween(seg, 'class="business-name" href="', '"');
    const phone = stripTags(extractBetween(seg, 'class="phones phone primary">', "</div>"));
    const addr = stripTags(extractBetween(seg, 'class="street-address">', "</div>"));
    const locality = stripTags(extractBetween(seg, 'class="locality">', "</div>"));
    const website = extractBetween(seg, 'class="track-visit-website" href="', '"');

    const name = stripTags(nameRaw.replace(/^.*?>/, ""));
    if (!name) continue;

    out.push({
      source: "yellowpages",
      name,
      phone,
      website,
      address: [addr, locality].filter(Boolean).join(", "),
      maps_url: href ? `https://www.yellowpages.com${href}` : "",
      place_id: `yp:${href || name.toLowerCase().replace(/\W+/g, "-")}`
    });
  }

  return out;
}

async function yellowPagesSearch(query, location, page = 1) {
  const url = new URL("https://www.yellowpages.com/search");
  url.searchParams.set("search_terms", query);
  url.searchParams.set("geo_location_terms", location);
  if (page > 1) url.searchParams.set("page", String(page));

  try {
    const html = await fetchText(url);
    return parseYellowPages(html);
  } catch {
    return [];
  }
}

function decodeDdgUrl(href) {
  try {
    const parsed = new URL(href, "https://duckduckgo.com");
    const uddg = parsed.searchParams.get("uddg");
    if (uddg) return decodeURIComponent(uddg);
    return parsed.toString();
  } catch {
    return "";
  }
}

function parseDuckDuckGo(html) {
  const out = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let match;
  while ((match = re.exec(html)) !== null) {
    const rawUrl = match[1];
    const title = stripTags(match[2]);
    const website = decodeDdgUrl(rawUrl);
    if (!website || !title) continue;
    if (!/^https?:\/\//i.test(website)) continue;
    out.push({
      source: "duckduckgo",
      name: title,
      phone: "",
      website,
      address: "",
      maps_url: website,
      place_id: `ddg:${website.toLowerCase()}`
    });
  }
  return out;
}

async function duckDuckGoSearch(query, location) {
  const url = new URL("https://html.duckduckgo.com/html/");
  url.searchParams.set("q", `${query} ${location} contractor`);
  try {
    const html = await fetchText(url);
    return parseDuckDuckGo(html).slice(0, 25);
  } catch {
    return [];
  }
}

function normalizeWebsite(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  try {
    return new URL(raw.startsWith("http") ? raw : `https://${raw}`).toString();
  } catch {
    return "";
  }
}

function normalizePhone(phone) {
  return String(phone || "").replace(/\D+/g, "");
}

function domainFromWebsite(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function isAggregatorDomain(domain) {
  const blocked = [
    "indeed.com",
    "glassdoor.com",
    "linkedin.com",
    "yelp.com",
    "angi.com",
    "bbb.org",
    "simplyhired.com",
    "trustoria.com",
    "yellowpages.com",
    "mapquest.com",
    "facebook.com",
    "instagram.com",
    "x.com",
    "twitter.com",
    "youtube.com",
    "tiktok.com",
    "reddit.com",
    "wikipedia.org"
  ];
  return blocked.some((d) => domain === d || domain.endsWith(`.${d}`));
}

function isLeadCandidate(row) {
  const domain = domainFromWebsite(row.website);
  const name = String(row.name || "").toLowerCase();
  const url = String(row.website || "").toLowerCase();
  if (isAggregatorDomain(domain)) return false;
  if (name.includes("jobs") || name.includes("employment")) return false;
  if (url.includes("/search?") || url.includes("find_desc=") || url.includes("/directory/")) return false;
  return true;
}

function dedupeRows(rows) {
  const map = new Map();

  for (const row of rows) {
    row.website = normalizeWebsite(row.website);
    const domainKey = domainFromWebsite(row.website);
    const key = domainKey || row.place_id || `${row.name.toLowerCase()}|${normalizePhone(row.phone)}|${row.website}`;

    if (!map.has(key)) {
      map.set(key, row);
      continue;
    }

    const existing = map.get(key);
    map.set(key, {
      ...existing,
      source: [existing.source, row.source].filter(Boolean).join("+"),
      phone: existing.phone || row.phone,
      website: existing.website || row.website,
      address: existing.address || row.address,
      maps_url: existing.maps_url || row.maps_url
    });
  }

  return [...map.values()];
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

async function scrapeDomainEmails(url) {
  const normalized = normalizeWebsite(url);
  if (!normalized) return [];

  const paths = ["/", "/contact", "/contact-us", "/about", "/team"];
  const emails = new Set();

  for (const p of paths) {
    try {
      const page = new URL(p, normalized).toString();
      const html = await fetchText(page);
      extractEmails(html).forEach((e) => emails.add(e));
      await sleep(120);
    } catch {
      // Best effort.
    }
  }

  return [...emails].slice(0, 8);
}

function extractPhones(text) {
  const out = new Set();
  const re = /(?:\+1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    out.add(m[0].trim());
  }
  return [...out];
}

async function enrichPhoneFromWebsite(row) {
  if (row.phone || !row.website) return row;
  try {
    const html = await fetchText(row.website);
    const phones = extractPhones(html);
    if (phones.length) {
      row.phone = phones[0];
    }
  } catch {
    // Ignore.
  }
  return row;
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
  const safeRadiusMiles = Math.min(MAX_RADIUS_MILES, Math.max(5, Number(radiusMiles) || 25));
  const safeGridStep = Math.max(10, Number(gridStepMiles) || 35);
  const variants = buildQueryVariants(query);

  onProgress("Resolving location...");
  const geo = await geocodeLocation(location);

  const boxes = mode === "statewide" && geo.bounds
    ? buildGridBoxes(geo.bounds, safeGridStep, safeRadiusMiles)
    : [singleBoxFromCenter(geo.lat, geo.lng, safeRadiusMiles)];

  const collected = [];
  let step = 0;
  const totalSteps = boxes.length * variants.length;

  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = 0; j < variants.length; j += 1) {
      const variant = variants[j];
      step += 1;
      onProgress(`Searching ${step}/${totalSteps}: ${variant}`);

      const runOverpass = i === 0 && j === 0;
      const runBroadNominatim = j < 8;
      const [nominatimRows, overpassRows, broadRows] = await Promise.all([
        nominatimSearchBox(variant, boxes[i], 50).catch(() => []),
        runOverpass ? overpassSearchBox(variant, boxes[i]).catch(() => []) : Promise.resolve([]),
        runBroadNominatim ? nominatimSearchText(variant, location, 20).catch(() => []) : Promise.resolve([])
      ]);

      collected.push(...nominatimRows, ...overpassRows, ...broadRows);
      if (step % 2 === 0) await sleep(180);
    }
  }

  onProgress("Running YellowPages fallback...");
  for (const variant of variants.slice(0, 3)) {
    const p1 = await yellowPagesSearch(variant, location, 1);
    collected.push(...p1);
    await sleep(220);
  }

  onProgress("Running DuckDuckGo domain fallback...");
  for (const variant of variants.slice(0, 8)) {
    const ddg = await duckDuckGoSearch(variant, location);
    collected.push(...ddg);
    await sleep(180);
  }

  let rows = dedupeRows(collected)
    .filter((r) => r.name)
    .filter((r) => isLeadCandidate(r))
    .sort((a, b) => (b.website ? 1 : 0) - (a.website ? 1 : 0));

  onProgress("Backfilling phones from websites...");
  for (let i = 0; i < rows.length; i += 1) {
    await enrichPhoneFromWebsite(rows[i]);
    if ((i + 1) % 15 === 0 || i === rows.length - 1) {
      onProgress(`Phone enrichment ${i + 1}/${rows.length}`);
    }
  }

  if (includeEmails) {
    onProgress("Enriching emails from websites...");
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
      location_label: geo.label,
      mode,
      radius_miles: safeRadiusMiles,
      boxes: boxes.length,
      variants: variants.length
    },
    rows
  };
}

export function toCsv(rows) {
  const headers = ["source", "name", "phone", "website", "address", "maps_url", "place_id", "emails"];
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
