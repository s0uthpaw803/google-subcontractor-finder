import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CSI_INDEX_PATH = path.join(ROOT_DIR, "data", "csi-query-index.json");
const TRADES_PATH = path.join(ROOT_DIR, "data", "trades.json");

let cache = null;
let cacheKey = "";

function normalize(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizedCode(value) {
  return String(value || "").replace(/[^0-9]/g, "");
}

function unique(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || "").trim()).filter(Boolean))];
}

function kindLabel(kind) {
  if (kind === "preferred") return "Preferred Results";
  if (kind === "trade") return "Trade";
  if (kind === "division") return "CSI Division";
  if (kind === "category") return "CSI Category";
  return "CSI Section";
}

function loadData() {
  const csiMtime = Number(fs.statSync(CSI_INDEX_PATH).mtimeMs || 0);
  const tradesMtime = Number(fs.statSync(TRADES_PATH).mtimeMs || 0);
  const nextKey = `${csiMtime}:${tradesMtime}`;
  if (cache && cacheKey === nextKey) return cache;

  const csi = JSON.parse(fs.readFileSync(CSI_INDEX_PATH, "utf8"));
  const tradeData = JSON.parse(fs.readFileSync(TRADES_PATH, "utf8"));
  const entries = Array.isArray(csi.entries) ? csi.entries : [];
  const divisions = Array.isArray(csi.divisions) ? csi.divisions : [];
  const trades = Array.isArray(tradeData.trades) ? tradeData.trades : [];
  const entryByCode = new Map(entries.map((entry) => [String(entry.section_code || ""), entry]));
  const divisionByCode = new Map(divisions.map((division) => [String(division.division_code || ""), division]));
  const tradeById = new Map(trades.map((trade) => [String(trade.id || ""), trade]));
  const popularCodes = new Set();

  for (const trade of trades) {
    for (const ref of Array.isArray(trade.csi_refs) ? trade.csi_refs : []) {
      if (!String(ref).startsWith("division:")) popularCodes.add(String(ref));
    }
  }

  const indexedTrades = trades.map((trade, order) => ({
    ...trade,
    order,
    normalizedLabel: normalize(trade.label),
    normalizedAliases: (Array.isArray(trade.aliases) ? trade.aliases : []).map(normalize),
    normalizedKeywords: normalize([
      trade.label,
      ...(Array.isArray(trade.aliases) ? trade.aliases : []),
      ...(Array.isArray(trade.search_terms) ? trade.search_terms : [])
    ].join(" "))
  }));
  const indexedDivisions = divisions.map((division) => ({
    ...division,
    normalizedTitle: normalize(division.division_title),
    normalizedCode: normalizedCode(division.division_code)
  }));
  const indexedEntries = entries.map((entry) => ({
    ...entry,
    normalizedTitle: normalize(entry.section_title),
    normalizedCode: normalizedCode(entry.section_code),
    normalizedKeywords: normalize(entry.keywords)
  }));

  cache = {
    source: csi.source || {},
    entries,
    divisions,
    trades,
    entryByCode,
    divisionByCode,
    tradeById,
    popularCodes,
    indexedTrades,
    indexedDivisions,
    indexedEntries
  };
  cacheKey = nextKey;
  return cache;
}

function tradeCoverage(trade, data) {
  const coverage = [];
  for (const ref of Array.isArray(trade.csi_refs) ? trade.csi_refs : []) {
    if (String(ref).startsWith("division:")) {
      const division = data.divisionByCode.get(String(ref).split(":", 2)[1]);
      if (division) coverage.push(division.display);
      continue;
    }
    const entry = data.entryByCode.get(String(ref));
    if (entry) coverage.push(`${entry.section_title} — ${entry.section_code}`);
  }
  return unique(coverage);
}

function scoreTrade(trade, query) {
  if (!query) return 700 - trade.order;
  if (trade.normalizedLabel === query) return 1000;
  if (trade.normalizedAliases.includes(query)) return 980;
  if (trade.normalizedLabel.startsWith(query)) return 760;
  if (trade.normalizedAliases.some((alias) => alias.startsWith(query))) return 750;
  if (trade.normalizedLabel.includes(query)) return 720;
  if (trade.normalizedAliases.some((alias) => alias.includes(query))) return 710;
  if (trade.normalizedKeywords.includes(query)) return 620;
  return 0;
}

function scoreDivision(division, query, relatedDivisionCodes, relatedDivisionRanks = new Map()) {
  if (!query) return 0;
  const queryCode = normalizedCode(query);
  if (division.normalizedTitle === query) return 800;
  if (queryCode && division.normalizedCode === queryCode) return 790;
  if (division.normalizedTitle.startsWith(query)) return 670;
  if (division.normalizedTitle.includes(query)) return 630;
  if (queryCode && division.normalizedCode.startsWith(queryCode)) return 650;
  const divisionCode = String(division.division_code || "");
  const relatedRank = relatedDivisionRanks.get(divisionCode);
  if (Number.isInteger(relatedRank)) return 645 - relatedRank;
  if (relatedDivisionCodes.has(divisionCode)) return 640;
  return 0;
}

function scoreEntry(entry, query, popularCodes, relatedRefRanks = new Map()) {
  if (!query) return 0;
  const queryCode = normalizedCode(query);
  let score = 0;
  if (entry.normalizedTitle === query) score = entry.kind === "category" ? 900 : 880;
  else if (queryCode && entry.normalizedCode === queryCode) score = entry.kind === "category" ? 890 : 870;

  else if (entry.normalizedTitle.startsWith(query)) score = entry.kind === "category" ? 660 : 650;
  else if (entry.normalizedTitle.includes(query)) score = entry.kind === "category" ? 620 : 610;
  else if (queryCode && entry.normalizedCode.startsWith(queryCode)) score = entry.kind === "category" ? 630 : 600;
  else if (query.length >= 3 && entry.normalizedKeywords.includes(query)) score = 500;

  const relatedRank = relatedRefRanks.get(String(entry.section_code || ""));
  if (Number.isInteger(relatedRank)) score = Math.max(score, 930 - relatedRank);
  if (score && popularCodes.has(String(entry.section_code || ""))) score += 45;
  return score;
}

export function getBusinessQuerySuggestions(rawQuery, requestedLimit = 10) {
  const data = loadData();
  const query = normalize(rawQuery);
  const limit = Math.max(4, Math.min(20, Number(requestedLimit || 10)));
  const suggestions = [{
    id: "preferred:all",
    kind: "preferred",
    label: "Preferred Results — All",
    display: "Preferred Results — All",
    detail: "Starred companies",
    kind_label: kindLabel("preferred"),
    priority: Number.MAX_SAFE_INTEGER
  }];
  const ranked = [];
  const matchedTrades = [];

  for (const trade of data.indexedTrades) {
    const score = scoreTrade(trade, query);
    if (!score) continue;
    const coverage = tradeCoverage(trade, data);
    const divisionDisplays = unique((Array.isArray(trade.csi_refs) ? trade.csi_refs : []).map((ref) => {
      const value = String(ref || "");
      const divisionCode = value.startsWith("division:") ? value.split(":", 2)[1] : value.slice(0, 2);
      return data.divisionByCode.get(divisionCode)?.display;
    }));
    matchedTrades.push(trade);
    ranked.push({
      id: `trade:${trade.id}`,
      kind: "trade",
      label: trade.label,
      display: trade.label,
      detail: coverage.slice(0, 3).join("; "),
      kind_label: kindLabel("trade"),
      legend: divisionDisplays.length === 1
        ? `CSI: ${divisionDisplays[0]} | Primary Category: ${coverage.join("; ")}`
        : `CSI Coverage: ${coverage.join("; ")}`,
      priority: score
    });
  }

  if (query) {
    const relatedDivisionCodes = new Set();
    const relatedDivisionRanks = new Map();
    const relatedRefRanks = new Map();
    for (const trade of matchedTrades) {
      for (const [refIndex, ref] of (Array.isArray(trade.csi_refs) ? trade.csi_refs : []).entries()) {
        const value = String(ref || "");
        if (value.startsWith("division:")) {
          const divisionCode = value.split(":", 2)[1];
          relatedDivisionCodes.add(divisionCode);
          const existingRank = relatedDivisionRanks.get(divisionCode);
          if (!Number.isInteger(existingRank) || refIndex < existingRank) relatedDivisionRanks.set(divisionCode, refIndex);
        }
        else if (/^\d{2}\s/.test(value)) {
          const divisionCode = value.slice(0, 2);
          relatedDivisionCodes.add(divisionCode);
          const existingDivisionRank = relatedDivisionRanks.get(divisionCode);
          if (!Number.isInteger(existingDivisionRank) || refIndex < existingDivisionRank) relatedDivisionRanks.set(divisionCode, refIndex);
          const existingRank = relatedRefRanks.get(value);
          if (!Number.isInteger(existingRank) || refIndex < existingRank) relatedRefRanks.set(value, refIndex);
        }
      }
    }

    for (const division of data.indexedDivisions) {
      const score = scoreDivision(division, query, relatedDivisionCodes, relatedDivisionRanks);
      if (!score) continue;
      ranked.push({
        id: division.id,
        kind: "division",
        label: division.division_title,
        display: division.display,
        detail: "CSI Division",
        kind_label: kindLabel("division"),
        legend: `CSI: ${division.display}`,
        priority: score
      });
    }

    for (const entry of data.indexedEntries) {
      if (entry.kind === "division") continue;
      const score = scoreEntry(entry, query, data.popularCodes, relatedRefRanks);
      if (!score) continue;
      ranked.push({
        id: entry.id,
        kind: entry.kind,
        label: entry.section_title,
        display: `${entry.section_title} — ${entry.section_code}`,
        detail: `${entry.division_title} — Division ${entry.division_code}`,
        kind_label: kindLabel(entry.kind),
        legend: `CSI: ${entry.division_title} — Division ${entry.division_code} | Primary Category: ${entry.section_title} — ${entry.section_code}`,
        priority: score
      });
    }
  }

  ranked.sort((a, b) => b.priority - a.priority || a.display.localeCompare(b.display, undefined, { numeric: true }));
  suggestions.push(...ranked.slice(0, limit - 1));
  return {
    query: String(rawQuery || ""),
    suggestions,
    source: {
      filename: data.source.filename,
      sha256: data.source.sha256,
      unique_sections: data.source.unique_sections
    }
  };
}

function divisionMajorEntries(divisionCode, data) {
  const entries = data.entries.filter((entry) => {
    if (String(entry.division_code) !== String(divisionCode) || entry.kind !== "category") return false;
    const parts = String(entry.section_code || "").split(" ");
    const family = Number(parts[1]);
    if (!Number.isInteger(family) || family === 0) return false;
    if (family % 10 !== 0) return false;
    return !/maintenance|common work results|schedules|commissioning/i.test(String(entry.section_title || ""));
  });
  return entries.slice(0, 16);
}

function dynamicChild({ id, label, parentId, parentLabel, terms, hints, qualificationTerms = [] }) {
  const cleanedTerms = unique(terms);
  return {
    child_id: id,
    child_label: label,
    parent_id: parentId,
    parent_label: parentLabel,
    query_profile: {
      mode: "TEXT_SEARCH",
      primary_terms: cleanedTerms.slice(0, 4),
      secondary_terms: [],
      include_modifiers: ["commercial", "industrial", "new construction", "tenant build-out"],
      exclude_terms: ["DIY", "how to", "homeowner", "residential", "house", "handyman", "cheap"],
      included_types: [],
      excluded_types: [],
      category_hints: unique(hints),
      required_name_terms: unique(qualificationTerms),
      priority_weight: 1
    }
  };
}

export function resolveBusinessQuerySelection(selectionId) {
  const data = loadData();
  const id = String(selectionId || "").trim();
  if (!id || id === "preferred:all") return null;

  if (id.startsWith("trade:")) {
    const trade = data.tradeById.get(id.slice(6));
    if (!trade) return null;
    const coverage = tradeCoverage(trade, data);
    const divisionDisplays = unique((Array.isArray(trade.csi_refs) ? trade.csi_refs : []).map((ref) => {
      const divisionCode = String(ref).startsWith("division:") ? String(ref).split(":", 2)[1] : String(ref).slice(0, 2);
      return data.divisionByCode.get(divisionCode)?.display;
    }));
    const parentLabel = `Trade: ${trade.label} | CSI: ${coverage.join("; ")}`;
    const child = dynamicChild({
      id,
      label: trade.label,
      parentId: id,
      parentLabel,
      terms: trade.search_terms,
      hints: [trade.label, ...(trade.aliases || []), ...coverage],
      qualificationTerms: trade.qualification_terms || [trade.label, ...(trade.aliases || [])]
    });
    return {
      id,
      kind: "taxonomy",
      selection_kind: "trade",
      display: trade.label,
      legend: divisionDisplays.length === 1
        ? `CSI: ${divisionDisplays[0]} | Primary Category: ${coverage.join("; ")}`
        : `CSI Coverage: ${coverage.join("; ")}`,
      selectedChildren: [child],
      manualTerms: []
    };
  }

  if (id.startsWith("division:")) {
    const divisionCode = id.slice(9);
    const division = data.divisionByCode.get(divisionCode);
    if (!division) return null;
    const majorEntries = divisionMajorEntries(divisionCode, data);
    const sourceEntries = majorEntries.length ? majorEntries : data.entries.filter((entry) => String(entry.division_code) === divisionCode && entry.kind === "category").slice(0, 12);
    const selectedChildren = sourceEntries.map((entry) => dynamicChild({
      id: entry.id,
      label: entry.section_title,
      parentId: id,
      parentLabel: division.display,
      terms: [entry.section_title, `${entry.section_title} contractor`],
      hints: [entry.section_title, division.division_title]
    }));
    if (!selectedChildren.length) {
      selectedChildren.push(dynamicChild({
        id,
        label: division.division_title,
        parentId: id,
        parentLabel: division.display,
        terms: [division.division_title, `${division.division_title} contractor`],
        hints: [division.division_title]
      }));
    }
    return {
      id,
      kind: "taxonomy",
      selection_kind: "division",
      display: division.display,
      legend: `CSI: ${division.display}`,
      selectedChildren,
      manualTerms: []
    };
  }

  if (id.startsWith("csi:")) {
    const code = id.slice(4);
    const entry = data.entryByCode.get(code);
    if (!entry) return null;
    const division = data.divisionByCode.get(entry.division_code);
    const display = `${entry.section_title} — ${entry.section_code}`;
    const parentLabel = `${division?.display || entry.division_title} | ${display}`;
    return {
      id,
      kind: "taxonomy",
      selection_kind: entry.kind,
      display,
      legend: `CSI: ${division?.display || entry.division_title} | Primary Category: ${display}`,
      selectedChildren: [dynamicChild({
        id,
        label: entry.section_title,
        parentId: `division:${entry.division_code}`,
        parentLabel,
        terms: [entry.section_title, `${entry.section_title} contractor`],
        hints: [entry.section_title, entry.division_title]
      })],
      manualTerms: []
    };
  }

  return null;
}

export function getBusinessQuerySelection(selectionId) {
  const selection = resolveBusinessQuerySelection(selectionId);
  if (!selection) return null;
  return {
    id: selection.id,
    kind: selection.selection_kind,
    display: selection.display,
    legend: selection.legend
  };
}

export function businessQueryInventory() {
  const data = loadData();
  return {
    source: data.source,
    divisions: data.divisions.length,
    csi_entries: data.entries.length,
    trades: data.trades.length
  };
}
