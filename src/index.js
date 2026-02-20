#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json";
const PLACES_NEARBY_URL = "https://maps.googleapis.com/maps/api/place/nearbysearch/json";
const PLACE_DETAILS_URL = "https://maps.googleapis.com/maps/api/place/details/json";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";

const DEFAULT_RADIUS_METERS = 50000;
const DEFAULT_QUERY = "general contractor";
const DEFAULT_GRID_STEP_MILES = 35;
const HTTP_HEADERS = { "User-Agent": "google-subcontractor-finder/1.0" };
const REQUEST_TIMEOUT_MS = 30000;

function parseArgs(argv) {
  const args = {
    location: "",
    radius: DEFAULT_RADIUS_METERS,
    query: DEFAULT_QUERY,
    output: "subcontractors.csv",
    statewide: false,
    gridStepMiles: DEFAULT_GRID_STEP_MILES
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--location" || arg === "-l") {
      args.location = argv[i + 1] || "";
      i += 1;
    } else if (arg === "--radius" || arg === "-r") {
      const value = Number(argv[i + 1]);
      if (Number.isFinite(value) && value > 0) {
        args.radius = Math.min(value, 50000);
      }
      i += 1;
    } else if (arg === "--query" || arg === "-q") {
      args.query = argv[i + 1] || DEFAULT_QUERY;
      i += 1;
    } else if (arg === "--output" || arg === "-o") {
      args.output = argv[i + 1] || args.output;
      i += 1;
    } else if (arg === "--statewide") {
      args.statewide = true;
    } else if (arg === "--grid-step-miles") {
      const value = Number(argv[i + 1]);
      if (Number.isFinite(value) && value >= 5) {
        args.gridStepMiles = value;
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
  node src/index.js --location "Atlanta, GA" [--radius 30000] [--query "electrical subcontractor"] [--output results.csv]
  node src/index.js --location "Texas" --statewide [--grid-step-miles 35] [--query "roofing subcontractor"]

Required:
  --location, -l         City, ZIP code, or state (examples: "Denver, CO", "90210", "Texas")

Optional:
  --radius, -r           Search radius in meters (default 50000, max 50000)
  --query, -q            Search term (default "general contractor")
  --output, -o           Output CSV path (default "subcontractors.csv")
  --statewide            Multi-city grid sweep for broad state coverage
  --grid-step-miles      Grid spacing when --statewide is set (default 35, min 5)
  --help, -h             Show help

Env:
  GOOGLE_MAPS_API_KEY optional.
  With key: Google Geocoding + Places.
  Without key: OpenStreetMap Nominatim search (no key).
`);
}

function getEnvValue(name) {
  if (process.env[name]) {
    return process.env[name];
  }

  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) {
    return "";
  }

  const content = fs.readFileSync(envPath, "utf8");
  const line = content
    .split(/\r?\n/)
    .find((row) => row.trim().startsWith(`${name}=`));

  if (!line) {
    return "";
  }

  return line.split("=").slice(1).join("=").trim().replace(/^['"]|['"]$/g, "");
}

function csvEscape(value) {
  const str = String(value ?? "");
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function toCsv(rows) {
  const headers = [
    "name",
    "phone",
    "website",
    "address",
    "rating",
    "ratings_total",
    "maps_url",
    "place_id"
  ];

  const lines = [headers.join(",")];
  rows.forEach((row) => {
    const line = headers.map((h) => csvEscape(row[h])).join(",");
    lines.push(line);
  });
  return `${lines.join("\n")}\n`;
}

function writeCsv(rows, outputPath) {
  fs.writeFileSync(outputPath, toCsv(rows), "utf8");
}

function milesToLatitudeDegrees(miles) {
  return miles / 69;
}

function milesToLongitudeDegrees(miles, lat) {
  const cosLat = Math.max(Math.cos((lat * Math.PI) / 180), 0.15);
  return miles / (69 * cosLat);
}

function generateGridPoints(bounds, stepMiles) {
  if (!bounds?.southwest || !bounds?.northeast) {
    return [];
  }

  const minLat = Math.min(bounds.southwest.lat, bounds.northeast.lat);
  const maxLat = Math.max(bounds.southwest.lat, bounds.northeast.lat);
  const minLng = Math.min(bounds.southwest.lng, bounds.northeast.lng);
  const maxLng = Math.max(bounds.southwest.lng, bounds.northeast.lng);

  const points = [];
  let lat = minLat;

  while (lat <= maxLat) {
    const lngStep = milesToLongitudeDegrees(stepMiles, lat);
    let lng = minLng;

    while (lng <= maxLng) {
      points.push({ lat, lng });
      lng += lngStep;
    }

    lat += milesToLatitudeDegrees(stepMiles);
  }

  return points;
}

function parseGoogleBounds(geometry) {
  const b = geometry.bounds || geometry.viewport;
  if (!b?.southwest || !b?.northeast) {
    return null;
  }
  return {
    southwest: { lat: b.southwest.lat, lng: b.southwest.lng },
    northeast: { lat: b.northeast.lat, lng: b.northeast.lng }
  };
}

function parseNominatimBounds(boundingbox) {
  if (!Array.isArray(boundingbox) || boundingbox.length < 4) {
    return null;
  }

  const south = Number(boundingbox[0]);
  const north = Number(boundingbox[1]);
  const west = Number(boundingbox[2]);
  const east = Number(boundingbox[3]);

  if (![south, north, west, east].every((v) => Number.isFinite(v))) {
    return null;
  }

  return {
    southwest: { lat: south, lng: west },
    northeast: { lat: north, lng: east }
  };
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: HTTP_HEADERS,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  const raw = await response.text();
  try {
    return JSON.parse(raw);
  } catch {
    const preview = raw.slice(0, 200).replace(/\s+/g, " ");
    throw new Error(`Upstream returned non-JSON: ${preview}`);
  }
}

// ---------------- Google provider ----------------

async function geocodeLocationGoogle(location, apiKey) {
  const url = new URL(GEOCODE_URL);
  url.searchParams.set("address", location);
  url.searchParams.set("key", apiKey);

  const data = await fetchJson(url);
  if (data.status !== "OK" || !data.results?.length) {
    throw new Error(`Google geocoding failed for "${location}". Status: ${data.status}`);
  }

  const result = data.results[0];
  return {
    formattedAddress: result.formatted_address,
    lat: result.geometry.location.lat,
    lng: result.geometry.location.lng,
    bounds: parseGoogleBounds(result.geometry)
  };
}

async function fetchNearbyPageGoogle({ lat, lng, radius, query, apiKey, pageToken }) {
  const url = new URL(PLACES_NEARBY_URL);
  url.searchParams.set("location", `${lat},${lng}`);
  url.searchParams.set("radius", String(radius));
  url.searchParams.set("keyword", query);
  url.searchParams.set("key", apiKey);
  if (pageToken) {
    url.searchParams.set("pagetoken", pageToken);
  }

  return fetchJson(url);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchNearbyPlacesGoogle(params) {
  const all = [];
  let pageToken = "";

  for (let i = 0; i < 3; i += 1) {
    if (pageToken) {
      await sleep(2200);
    }

    const data = await fetchNearbyPageGoogle({ ...params, pageToken });
    if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
      throw new Error(`Google places search failed. Status: ${data.status}`);
    }

    if (Array.isArray(data.results)) {
      all.push(...data.results);
    }

    if (!data.next_page_token) {
      break;
    }
    pageToken = data.next_page_token;
  }

  const unique = new Map();
  all.forEach((place) => {
    if (!unique.has(place.place_id)) {
      unique.set(place.place_id, place);
    }
  });
  return [...unique.values()];
}

async function fetchPlaceDetailsGoogle(placeId, apiKey) {
  const fields = [
    "name",
    "formatted_phone_number",
    "website",
    "formatted_address",
    "rating",
    "user_ratings_total",
    "url"
  ].join(",");

  const url = new URL(PLACE_DETAILS_URL);
  url.searchParams.set("place_id", placeId);
  url.searchParams.set("fields", fields);
  url.searchParams.set("key", apiKey);

  const data = await fetchJson(url);
  if (data.status !== "OK") {
    return null;
  }
  return data.result || null;
}

async function searchGoogle({ args, geo, apiKey }) {
  let places = [];

  if (args.statewide) {
    const gridPoints = generateGridPoints(geo.bounds, args.gridStepMiles);
    if (!gridPoints.length) {
      throw new Error("Statewide mode requires geocoding bounds; try a full state name like \"Texas\".");
    }

    console.log(`Statewide grid generated ${gridPoints.length} search points.`);

    const unique = new Map();
    for (let i = 0; i < gridPoints.length; i += 1) {
      const point = gridPoints[i];
      console.log(`Google grid ${i + 1}/${gridPoints.length}: ${point.lat.toFixed(4)}, ${point.lng.toFixed(4)}`);

      const chunk = await fetchNearbyPlacesGoogle({
        lat: point.lat,
        lng: point.lng,
        radius: args.radius,
        query: args.query,
        apiKey
      });

      chunk.forEach((place) => unique.set(place.place_id, place));
    }

    places = [...unique.values()];
  } else {
    places = await fetchNearbyPlacesGoogle({
      lat: geo.lat,
      lng: geo.lng,
      radius: args.radius,
      query: args.query,
      apiKey
    });
  }

  const rows = [];
  for (let i = 0; i < places.length; i += 1) {
    const place = places[i];
    const details = await fetchPlaceDetailsGoogle(place.place_id, apiKey);
    rows.push({
      name: details?.name || place.name || "",
      phone: details?.formatted_phone_number || "",
      website: details?.website || "",
      address: details?.formatted_address || place.vicinity || "",
      rating: details?.rating || "",
      ratings_total: details?.user_ratings_total || "",
      maps_url: details?.url || "",
      place_id: place.place_id
    });
  }

  return rows;
}

// ---------------- OSM provider (no key) ----------------

async function geocodeLocationOsm(location) {
  const url = new URL(NOMINATIM_URL);
  url.searchParams.set("q", location);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "1");
  url.searchParams.set("countrycodes", "us");

  const data = await fetchJson(url);
  if (!Array.isArray(data) || !data.length) {
    throw new Error(`OSM geocoding failed for "${location}".`);
  }

  const result = data[0];
  return {
    formattedAddress: result.display_name,
    lat: Number(result.lat),
    lng: Number(result.lon),
    bounds: parseNominatimBounds(result.boundingbox)
  };
}

function normalizeOsmType(osmType) {
  if (osmType === "N") return "node";
  if (osmType === "W") return "way";
  if (osmType === "R") return "relation";
  return osmType || "node";
}

function mapNominatimRow(item) {
  const ext = item.extratags || {};
  const type = normalizeOsmType(item.osm_type);
  const id = item.osm_id || item.place_id;

  const website = ext.website || ext["contact:website"] || "";
  const phone = ext.phone || ext["contact:phone"] || "";

  return {
    name: item.name || String(item.display_name || "").split(",")[0] || "",
    phone,
    website,
    address: item.display_name || "",
    rating: "",
    ratings_total: "",
    maps_url: `https://www.openstreetmap.org/${type}/${id}`,
    place_id: `osm:${type}/${id}`
  };
}

async function searchNominatimViewbox({ query, south, north, west, east, limit = 50 }) {
  const url = new URL(NOMINATIM_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("countrycodes", "us");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("extratags", "1");
  url.searchParams.set("bounded", "1");
  url.searchParams.set("viewbox", `${west},${north},${east},${south}`);

  const data = await fetchJson(url);
  if (!Array.isArray(data)) {
    return [];
  }

  return data.map(mapNominatimRow).filter((r) => r.name);
}

function buildNominatimQueryVariants(query) {
  const words = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 4);

  const variants = new Set([
    query,
    "contractor",
    "construction company",
    "electrician",
    "plumber",
    "roofer"
  ]);

  words.forEach((w) => variants.add(w));
  return [...variants].slice(0, 8);
}

async function searchNominatimViewboxMulti({ query, south, north, west, east }) {
  const variants = buildNominatimQueryVariants(query);
  const unique = new Map();

  for (const variant of variants) {
    const rows = await searchNominatimViewbox({
      query: variant,
      south,
      north,
      west,
      east,
      limit: 30
    });
    rows.forEach((row) => unique.set(row.place_id, row));
  }

  return [...unique.values()];
}

async function searchOsmSingleCenter({ lat, lng, radius, query }) {
  const latPad = Math.min(milesToLatitudeDegrees(radius / 1609.34), 1.2);
  const lngPad = Math.min(milesToLongitudeDegrees(radius / 1609.34, lat), 1.2);

  return searchNominatimViewboxMulti({
    query,
    south: lat - latPad,
    north: lat + latPad,
    west: lng - lngPad,
    east: lng + lngPad
  });
}

async function searchOsmStatewide({ geo, radius, query, stepMiles }) {
  const points = generateGridPoints(geo.bounds, stepMiles);
  if (!points.length) {
    throw new Error("Statewide mode requires geocoding bounds; try a full state name like \"Texas\".");
  }

  const unique = new Map();
  for (let i = 0; i < points.length; i += 1) {
    const point = points[i];
    console.log(`OSM grid ${i + 1}/${points.length}: ${point.lat.toFixed(4)}, ${point.lng.toFixed(4)}`);

    const chunk = await searchOsmSingleCenter({
      lat: point.lat,
      lng: point.lng,
      radius,
      query
    });

    chunk.forEach((row) => unique.set(row.place_id, row));

    if (i % 8 === 7) {
      await sleep(1100);
    }
  }

  return [...unique.values()];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  if (!args.location) {
    printHelp();
    throw new Error("Missing required --location value.");
  }

  const outputPath = path.resolve(process.cwd(), args.output);
  const apiKey = getEnvValue("GOOGLE_MAPS_API_KEY");

  if (apiKey) {
    console.log("Provider: Google Maps API");
    const geo = await geocodeLocationGoogle(args.location, apiKey);
    console.log(`Using center: ${geo.formattedAddress} (${geo.lat}, ${geo.lng})`);

    const rows = await searchGoogle({ args, geo, apiKey });
    writeCsv(rows, outputPath);
    console.log(`Wrote ${rows.length} rows to ${outputPath}`);
    return;
  }

  console.log("Provider: OpenStreetMap (no API key)");
  const geo = await geocodeLocationOsm(args.location);
  console.log(`Using center: ${geo.formattedAddress} (${geo.lat}, ${geo.lng})`);

  let rows = [];
  if (args.statewide) {
    rows = await searchOsmStatewide({
      geo,
      radius: args.radius,
      query: args.query,
      stepMiles: args.gridStepMiles
    });
  } else {
    rows = await searchOsmSingleCenter({
      lat: geo.lat,
      lng: geo.lng,
      radius: args.radius,
      query: args.query
    });
  }

  writeCsv(rows, outputPath);
  console.log(`Wrote ${rows.length} rows to ${outputPath}`);
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
