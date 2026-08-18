import fs from "node:fs";
import path from "node:path";
import { resolveMx } from "node:dns/promises";
import {
  BLOCKED_EMAIL_ADDRESSES,
  BLOCKED_EMAIL_DOMAINS,
  BLOCKED_EMAIL_LOCAL_PARTS,
  CONDITIONAL_PLACEHOLDER_DOMAINS
} from "./email-filter-config.js";

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[A-Za-z]{2,}/g;
const EMAIL_FORMAT_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10000;
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SOURCES_PER_COMPANY = 10;
const SOCIAL_HOSTS = new Set([
  "facebook.com", "www.facebook.com", "instagram.com", "www.instagram.com",
  "linkedin.com", "www.linkedin.com", "x.com", "www.x.com",
  "twitter.com", "www.twitter.com"
]);
const DIRECTORY_HOSTS = new Set([
  "bbb.org", "www.bbb.org", "buildzoom.com", "www.buildzoom.com",
  "chamberofcommerce.com", "www.chamberofcommerce.com", "mapquest.com",
  "www.mapquest.com", "yellowpages.com", "www.yellowpages.com",
  "yelp.com", "www.yelp.com"
]);
const FREE_MAIL_DOMAINS = new Set([
  "aol.com", "gmail.com", "hotmail.com", "icloud.com", "live.com",
  "mail.com", "msn.com", "outlook.com", "proton.me", "protonmail.com",
  "yahoo.com", "ymail.com"
]);
const ESTIMATING_LOCALS = new Set([
  "bid", "bids", "estimating", "estimator", "precon", "preconstruction",
  "procurement", "proposals", "quotes", "rfp", "rfq", "subcontracts"
]);
const GENERAL_LOCALS = new Set([
  "admin", "contact", "hello", "info", "office", "sales", "service",
  "support", "team"
]);
const RELEVANT_PATH_RE = /(about|bid|brochure|capabilit|company|contact|directory|estim|license|precon|procure|profile|staff|team|vendor)/i;
const INVALID_EMAIL_PART_RE = /(privacy@|sentry@|wixpress|wordpress)/i;

function compactLocalPart(value) {
  return String(value || "").toLowerCase().replace(/[._-]+/g, "");
}

const BLOCKED_LOCAL_COMPACT = new Set([...BLOCKED_EMAIL_LOCAL_PARTS].map(compactLocalPart));

export function normalizeEmailAddress(value) {
  return String(value || "").trim().toLowerCase().replace(/[),.;:]+$/g, "");
}

export function isBlockedEmailAddress(value) {
  const email = normalizeEmailAddress(value);
  if (!email || /\s/.test(email) || !EMAIL_FORMAT_RE.test(email)) return true;
  if (email.includes("..")) return true;

  const separator = email.lastIndexOf("@");
  const local = email.slice(0, separator);
  const domain = email.slice(separator + 1);
  if (!local || !domain || local.startsWith(".") || local.endsWith(".")) return true;
  if (BLOCKED_EMAIL_ADDRESSES.has(email)) return true;

  const compactLocal = compactLocalPart(local);
  const blockedLocal = BLOCKED_EMAIL_LOCAL_PARTS.has(local) || BLOCKED_LOCAL_COMPACT.has(compactLocal);
  if (blockedLocal) return true;
  if (/^\d+$/.test(local) || /^x+$/i.test(local)) return true;
  if (BLOCKED_EMAIL_DOMAINS.has(domain)) return true;
  if (CONDITIONAL_PLACEHOLDER_DOMAINS.has(domain) && blockedLocal) return true;
  return INVALID_EMAIL_PART_RE.test(email);
}

export function normalizeAndFilterEmails(values) {
  const output = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : [values]) {
    const email = normalizeEmailAddress(value);
    if (isBlockedEmailAddress(email) || seen.has(email)) continue;
    seen.add(email);
    output.push(email);
  }
  return output;
}

const EMAIL_TYPE_PRIORITY = { Estimating: 4, General: 3, Employee: 2, Other: 1 };
const EMAIL_STATUS_PRIORITY = { Valid: 3, Likely: 2, Unverified: 1 };

function compareEmailRecords(a, b) {
  return (EMAIL_TYPE_PRIORITY[b.email_type] || 0) - (EMAIL_TYPE_PRIORITY[a.email_type] || 0) ||
    (EMAIL_STATUS_PRIORITY[b.email_status] || 0) - (EMAIL_STATUS_PRIORITY[a.email_status] || 0) ||
    Number(b.company_relationship_confidence || 0) - Number(a.company_relationship_confidence || 0) ||
    a.email.localeCompare(b.email);
}

export function prepareEmailColumns(input = {}) {
  const recordsByEmail = new Map();
  const sourceRecords = Array.isArray(input?.email_records) ? input.email_records : [];
  const fallbackValues = (sourceRecords.length ? [] : [input?.emails, input?.email, input?.email_1, input?.email_2])
    .flatMap((value) => String(value || "").split(/[;,]/))
    .map((email) => email.trim())
    .filter(Boolean)
    .map((email) => ({
      email,
      email_status: "Unverified",
      email_source: "Legacy Website Crawl",
      source_url: String(input?.website || ""),
      email_type: "Other",
      company_relationship_confidence: ""
    }));

  for (const sourceRecord of [...sourceRecords, ...fallbackValues]) {
    const email = normalizeEmailAddress(sourceRecord?.email);
    if (isBlockedEmailAddress(email) || String(sourceRecord?.email_status || "") === "Invalid") continue;
    const record = {
      ...sourceRecord,
      email,
      email_status: String(sourceRecord?.email_status || "Unverified"),
      email_type: String(sourceRecord?.email_type || "Other")
    };
    const existing = recordsByEmail.get(email);
    if (!existing || compareEmailRecords(record, existing) < 0) recordsByEmail.set(email, record);
  }

  const records = [...recordsByEmail.values()].sort(compareEmailRecords);
  return {
    records,
    primary_record: records[0] || {},
    email_1: records[0]?.email || "",
    email_2: records.slice(1).map((record) => record.email).join(", ")
  };
}

function normalizeWebsite(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&commat;|&#64;|&#x40;/gi, "@")
    .replace(/&period;|&#46;|&#x2e;/gi, ".")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

export function extractEmailCandidates(text) {
  const source = decodeHtml(text);
  const found = [];
  for (const match of source.matchAll(EMAIL_RE)) {
    const email = normalizeEmailAddress(match[0]);
    if (isBlockedEmailAddress(email)) continue;
    if (/\.(css|gif|ico|jpeg|jpg|js|png|svg|webp)$/i.test(email)) continue;
    found.push(email);
  }
  return normalizeAndFilterEmails(found);
}

function sanitizeEnrichment(enrichment) {
  let sourceRecords = Array.isArray(enrichment?.email_records) ? enrichment.email_records : [];
  if (!sourceRecords.length && String(enrichment?.emails || "").trim()) {
    sourceRecords = String(enrichment.emails).split(";").map((email) => ({
      email,
      email_status: "Unverified",
      email_source: "Legacy Website Crawl",
      source_url: "",
      email_type: "Other",
      company_relationship_confidence: ""
    }));
  }
  const prepared = prepareEmailColumns({ ...enrichment, email_records: sourceRecords });
  return {
    ...enrichment,
    email_records: prepared.records,
    emails: prepared.records.map((record) => record.email).join("; "),
    email_1: prepared.email_1,
    email_2: prepared.email_2
  };
}

function extractLinks(html, baseUrl) {
  const links = [];
  const decoded = decodeHtml(html);
  const hrefRe = /\bhref\s*=\s*["']([^"']+)["']/gi;
  for (const match of decoded.matchAll(hrefRe)) {
    const href = String(match[1] || "").trim();
    if (!href || href.startsWith("#") || /^(javascript|tel):/i.test(href)) continue;
    if (/^mailto:/i.test(href)) {
      links.push({ url: href, kind: "mailto" });
      continue;
    }
    try {
      const url = new URL(href, baseUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      url.hash = "";
      links.push({ url: url.toString(), kind: "link" });
    } catch {
      // Ignore malformed links.
    }
  }
  return links;
}

function sourceTypeFor(url, officialHost, contentType = "") {
  let host = "";
  try { host = new URL(url).hostname.toLowerCase(); } catch { /* empty */ }
  if (/pdf/i.test(contentType) || /\.pdf(?:$|\?)/i.test(url)) return "Company PDF";
  if (SOCIAL_HOSTS.has(host)) return "Company Social Profile";
  if (DIRECTORY_HOSTS.has(host)) return "Business Directory";
  if (host === officialHost || host.endsWith(`.${officialHost}`)) return "Company Website";
  return "Public Business Page";
}

function emailType(email, sourceUrl = "") {
  const local = String(email || "").split("@")[0].toLowerCase();
  if (ESTIMATING_LOCALS.has(local) || /(estim|bid|precon|proposal|quote|procure|rf[qp])/.test(local)) return "Estimating";
  if (GENERAL_LOCALS.has(local) || /(contact|general|office|admin|hello|info|sales|support)/.test(local)) return "General";
  if (/team|staff|leadership|people/i.test(sourceUrl) || /^[a-z]+[._-][a-z]+$/.test(local)) return "Employee";
  return "Other";
}

function relationshipConfidence({ email, sourceType, officialHost, sourceUrl, mailto }) {
  const domain = String(email || "").split("@")[1]?.toLowerCase() || "";
  const officialDomain = domain === officialHost || officialHost.endsWith(`.${domain}`) || domain.endsWith(`.${officialHost}`);
  if (sourceType === "Company Website" && officialDomain && mailto) return 99;
  if (sourceType === "Company Website" && officialDomain) return 96;
  if (sourceType === "Company PDF" && officialDomain) return 94;
  if (sourceType === "Company Website" && FREE_MAIL_DOMAINS.has(domain)) return 90;
  if (sourceType === "Company PDF") return 88;
  if (sourceType === "Company Social Profile") return 82;
  if (sourceType === "Business Directory") return 74;
  if (/license|government|\.gov\//i.test(sourceUrl)) return 86;
  return 68;
}

async function fetchResource(url, fetchImpl, timeoutMs) {
  const response = await fetchImpl(url, {
    redirect: "follow",
    headers: {
      Accept: "text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.5",
      "User-Agent": "KeystoneConnect/1.0 (+contractor-email-enrichment)"
    },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const contentLength = Number(response.headers?.get?.("content-length") || 0);
  if (contentLength > MAX_RESPONSE_BYTES) throw new Error("Response too large");
  const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase();
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_RESPONSE_BYTES) throw new Error("Response too large");
  return {
    finalUrl: normalizeWebsite(response.url) || url,
    contentType,
    text: buffer.toString("latin1")
  };
}

function dedupeSources(items) {
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const key = String(item?.url || "").toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function buildSourceQueue(homeUrl, homepageText, homepageFinalUrl) {
  const official = new URL(homepageFinalUrl || homeUrl);
  const officialHost = official.hostname.toLowerCase();
  const commonPaths = ["/contact", "/contact-us", "/about", "/team", "/staff", "/estimating", "/bids", "/preconstruction"];
  const sources = commonPaths.map((pathname) => ({ url: new URL(pathname, official).toString(), linkedFromOfficial: true }));

  for (const link of extractLinks(homepageText, official.toString())) {
    if (link.kind === "mailto") continue;
    const url = new URL(link.url);
    const host = url.hostname.toLowerCase();
    const sameHost = host === officialHost || host.endsWith(`.${officialHost}`);
    if ((sameHost && (RELEVANT_PATH_RE.test(url.pathname) || /\.pdf$/i.test(url.pathname))) || SOCIAL_HOSTS.has(host) || DIRECTORY_HOSTS.has(host)) {
      sources.push({ url: url.toString(), linkedFromOfficial: true });
    }
  }
  return dedupeSources(sources).slice(0, MAX_SOURCES_PER_COMPANY - 1);
}

async function validateDomain(domain, resolveMxImpl) {
  try {
    const records = await resolveMxImpl(domain);
    const valid = Array.isArray(records) && records.some((record) => String(record?.exchange || "").trim());
    return { valid, status: valid ? "verified" : "invalid", records: valid ? records.length : 0 };
  } catch (error) {
    const code = String(error?.code || "");
    if (["ENODATA", "ENOTFOUND", "ENONAME", "NXDOMAIN"].includes(code)) return { valid: false, status: "invalid", records: 0 };
    return { valid: null, status: "unavailable", records: 0 };
  }
}

function cacheKeyFor(row) {
  return String(row?.place_id || row?.website || `${row?.name || ""}|${row?.phone || ""}`).trim().toLowerCase();
}

function loadCache(cachePath) {
  if (!cachePath || !fs.existsSync(cachePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function saveCache(cachePath, cache) {
  if (!cachePath) return;
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  const tempPath = `${cachePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, cachePath);
}

export async function enrichCompanyEmails(company, options = {}) {
  const website = normalizeWebsite(company?.website);
  if (!website) return { email_records: [], emails: "", invalid_email_count: 0, sources_checked: 0 };

  const fetchImpl = options.fetchImpl || fetch;
  const resolveMxImpl = options.resolveMxImpl || resolveMx;
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || DEFAULT_TIMEOUT_MS));
  const officialHost = new URL(website).hostname.toLowerCase();
  const evidence = [];
  let invalidEmailCount = 0;
  let homepage;

  try {
    homepage = await fetchResource(website, fetchImpl, timeoutMs);
  } catch {
    return { email_records: [], emails: "", invalid_email_count: 0, sources_checked: 1 };
  }

  const collectFromSource = (resource, sourceUrl, linkedFromOfficial = true) => {
    const sourceType = sourceTypeFor(sourceUrl, officialHost, resource.contentType);
    const mailtoEmails = new Set(
      extractLinks(resource.text, sourceUrl)
        .filter((link) => link.kind === "mailto")
        .flatMap((link) => extractEmailCandidates(link.url.replace(/^mailto:/i, "")))
    );
    for (const email of extractEmailCandidates(resource.text)) {
      evidence.push({ email, sourceType, sourceUrl, linkedFromOfficial, mailto: mailtoEmails.has(email) });
    }
  };

  collectFromSource(homepage, homepage.finalUrl, true);
  const queue = buildSourceQueue(website, homepage.text, homepage.finalUrl);
  const resources = await Promise.all(queue.map(async (source) => {
    try {
      const resource = await fetchResource(source.url, fetchImpl, timeoutMs);
      return { source, resource };
    } catch {
      return null;
    }
  }));
  for (const item of resources) {
    if (!item) continue;
    collectFromSource(item.resource, item.resource.finalUrl || item.source.url, item.source.linkedFromOfficial);
  }

  const bestEvidence = new Map();
  for (const item of evidence) {
    const confidence = relationshipConfidence({
      email: item.email,
      sourceType: item.sourceType,
      officialHost,
      sourceUrl: item.sourceUrl,
      mailto: item.mailto
    });
    const existing = bestEvidence.get(item.email);
    if (!existing || confidence > existing.company_relationship_confidence) {
      bestEvidence.set(item.email, { ...item, company_relationship_confidence: confidence });
    }
  }

  const domainValidation = new Map();
  const records = [];
  for (const item of bestEvidence.values()) {
    const domain = item.email.split("@")[1].toLowerCase();
    if (!domainValidation.has(domain)) domainValidation.set(domain, await validateDomain(domain, resolveMxImpl));
    const validation = domainValidation.get(domain);
    if (validation.valid === false) {
      invalidEmailCount += 1;
      continue;
    }

    const isOfficialDomain = domain === officialHost || domain.endsWith(`.${officialHost}`) || officialHost.endsWith(`.${domain}`);
    const emailStatus = validation.valid === null
      ? "Unverified"
      : (item.mailto && isOfficialDomain ? "Valid" : "Likely");
    records.push({
      email: item.email,
      email_status: emailStatus,
      email_source: item.sourceType,
      source_url: item.sourceUrl,
      email_type: emailType(item.email, item.sourceUrl),
      company_relationship_confidence: item.company_relationship_confidence,
      domain_mx_status: validation.status,
      mailbox_verification: "Unavailable"
    });
  }

  records.sort((a, b) => {
    const statusRank = { Valid: 3, Likely: 2, Unverified: 1 };
    return (statusRank[b.email_status] - statusRank[a.email_status]) ||
      (b.company_relationship_confidence - a.company_relationship_confidence) ||
      a.email.localeCompare(b.email);
  });

  return sanitizeEnrichment({
    email_records: records,
    emails: records.map((record) => record.email).join("; "),
    invalid_email_count: invalidEmailCount,
    sources_checked: 1 + resources.filter(Boolean).length
  });
}

export async function enrichCompaniesEmails(rows, options = {}) {
  const input = Array.isArray(rows) ? rows : [];
  const concurrency = Math.max(1, Math.min(6, Number(options.concurrency || 3)));
  const cachePath = String(options.cachePath || "").trim();
  const cache = loadCache(cachePath);
  const output = new Array(input.length);
  let cursor = 0;
  let completed = 0;

  const worker = async () => {
    while (cursor < input.length) {
      const index = cursor;
      cursor += 1;
      const row = input[index];
      const key = cacheKeyFor(row);
      const cached = cache[key];
      let enrichment;
      if (cached && Date.now() - Number(cached.cached_at || 0) < CACHE_TTL_MS) {
        enrichment = sanitizeEnrichment(cached.enrichment);
        cache[key] = { cached_at: Number(cached.cached_at || Date.now()), enrichment };
      } else {
        enrichment = sanitizeEnrichment(await enrichCompanyEmails(row, options));
        if (key) cache[key] = { cached_at: Date.now(), enrichment };
      }
      output[index] = { ...row, ...enrichment };
      completed += 1;
      options.onProgress?.({ completed, total: input.length, row: output[index] });
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, input.length || 1) }, () => worker()));
  saveCache(cachePath, cache);
  return output;
}
