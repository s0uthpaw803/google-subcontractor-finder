import assert from "node:assert/strict";
import test from "node:test";

import {
  businessQueryInventory,
  getBusinessQuerySelection,
  getBusinessQuerySuggestions,
  resolveBusinessQuerySelection
} from "../src/business-query.js";
import { buildQueries, mergeDedupRank } from "../src/search-engine.js";

test("CSI inventory matches the authoritative workbook export", () => {
  const inventory = businessQueryInventory();
  assert.equal(inventory.divisions, 34);
  assert.equal(inventory.csi_entries, 8613);
  assert.equal(inventory.trades, 40);
  assert.equal(inventory.source.source_rows, 8614);
  assert.equal(inventory.source.sha256, "4644b176e85bbf3176b66aeeffd3ffa3089e858ec5e3fc7cce188abff0d2333b");
});

test("Preferred Results is always pinned first", () => {
  for (const query of ["", "paint", "09", "site"]) {
    const suggestions = getBusinessQuerySuggestions(query, 10).suggestions;
    assert.equal(suggestions[0].id, "preferred:all");
  }
});

test("paint ranks the common trade before official CSI categories", () => {
  const suggestions = getBusinessQuerySuggestions("paint", 10).suggestions;
  assert.equal(suggestions[1].display, "Painting");
  assert.ok(suggestions.some((item) => item.display === "Painting and Coating — 09 90 00"));
});

test("09 returns Finishes and representative official sections", () => {
  const displays = getBusinessQuerySuggestions("09", 12).suggestions.map((item) => item.display);
  assert.ok(displays.includes("Finishes — Division 09"));
  assert.ok(displays.includes("Painting and Coating — 09 90 00"));
  assert.ok(displays.includes("Gypsum Board — 09 29 00"));
  assert.ok(displays.includes("Flooring — 09 60 00"));
});

test("legacy Division 16 resolves to current Electrical Division 26", () => {
  for (const query of ["16", "Division 16"]) {
    const electrical = getBusinessQuerySuggestions(query, 10).suggestions.find((item) => item.id === "division:26");
    assert.equal(electrical?.display, "Electrical — Division 26");
    assert.match(electrical?.detail || "", /Legacy Division 16 → current Division 26/);
  }
});

test("site returns common trade and official CSI entries", () => {
  const displays = getBusinessQuerySuggestions("site", 12).suggestions.map((item) => item.display);
  assert.ok(displays.includes("Civil / Sitework"));
  assert.ok(displays.includes("Site Clearing — 31 10 00"));
});

test("casework prioritizes Division 06 before Division 12", () => {
  const displays = getBusinessQuerySuggestions("casework", 12).suggestions.map((item) => item.display);
  assert.ok(displays.indexOf("Architectural Wood Casework — 06 41 00") > 0);
  assert.ok(displays.indexOf("Casework — 12 30 00") > 0);
  assert.ok(displays.indexOf("Architectural Wood Casework — 06 41 00") < displays.indexOf("Casework — 12 30 00"));
  assert.ok(displays.indexOf("Wood, Plastics, And Composites — Division 06") < displays.indexOf("Furnishings — Division 12"));
});

test("display labels put words before CSI numbers", () => {
  for (const query of ["09", "paint", "site"]) {
    for (const item of getBusinessQuerySuggestions(query, 20).suggestions) {
      if (item.kind === "division") assert.match(item.display, /^.+ — Division \d{2}$/);
      if (item.kind === "category" || item.kind === "section") assert.match(item.display, /^.+ — \d{2} /);
    }
  }
});

test("trade, division, and CSI selections resolve to search profiles", () => {
  const painting = resolveBusinessQuerySelection("trade:painting");
  assert.equal(painting.selection_kind, "trade");
  assert.ok(painting.selectedChildren[0].query_profile.primary_terms.includes("commercial painting contractor"));
  assert.match(painting.legend, /Painting and Coating — 09 90 00/);

  const finishes = resolveBusinessQuerySelection("division:09");
  assert.equal(finishes.selection_kind, "division");
  assert.ok(finishes.selectedChildren.length > 1);

  const category = resolveBusinessQuerySelection("csi:09 90 00");
  assert.equal(category.selection_kind, "category");
  assert.equal(category.display, "Painting and Coating — 09 90 00");
  assert.equal(getBusinessQuerySelection("csi:09 90 00").kind, "category");
});

test("Division 02 parent search excludes generic Assessment but keeps explicit CSI access", () => {
  const division = resolveBusinessQuerySelection("division:02");
  assert.equal(division.selectedChildren.some((child) => child.child_id === "csi:02 20 00"), false);
  assert.equal(division.selectedChildren.some((child) => child.child_id === "csi:02 40 00"), true);

  const assessment = resolveBusinessQuerySelection("csi:02 20 00");
  assert.equal(assessment.display, "Assessment — 02 20 00");
});

test("taxonomy filtering rejects medical assessment businesses but keeps demolition contractors", () => {
  const rows = mergeDedupRank([
    {
      id: "medical-assessment",
      name: "Psychological Assessment Solutions",
      primaryType: "psychologist",
      types: ["psychologist", "health"],
      location: { lat: 32.1, lng: -81.1 },
      distance_miles: 10,
      qualification_profiles: [{ child_id: "csi:02 20 00", identity_terms: ["assessment"], specific_types: [] }]
    },
    {
      id: "demolition-contractor",
      name: "Checkpoint Demolition",
      phone: "(912) 555-0110",
      primaryType: "general_contractor",
      types: ["general_contractor"],
      location: { lat: 32.1, lng: -81.1 },
      distance_miles: 12,
      qualification_profiles: [{ child_id: "csi:02 40 00", identity_terms: ["demolition"], specific_types: [] }],
      matched_children: ["csi:02 40 00"],
      matched_terms: ["Demolition contractor"],
      matched_sections: ["Existing Conditions — Division 02"],
      category_hints: ["Demolition"]
    }
  ], {
    center: { lat: 32.1, lng: -81.1 },
    radiusMiles: 60,
    qualificationMode: "strict"
  });

  assert.deepEqual(rows.map((row) => row.id), ["demolition-contractor"]);
});

test("taxonomy filtering rejects unsupported generic-contractor records", () => {
  const profile = {
    child_id: "csi:02 50 00",
    identity_terms: ["site remediation", "remediation"],
    specific_types: []
  };
  const base = {
    id: "unsupported-remediation",
    name: "Remediation Resources",
    formattedAddress: "Pembroke, GA 31321",
    phone: "",
    website: "",
    primaryType: "general_contractor",
    types: ["general_contractor", "point_of_interest", "service", "establishment"],
    userRatingCount: 0,
    distance_miles: 20,
    matched_children: ["csi:02 50 00"],
    matched_terms: ["Site Remediation"],
    matched_sections: ["Existing Conditions — Division 02"],
    category_hints: ["remediation"],
    qualification_profiles: [profile],
    profile_exclude_terms: [],
    child_weight: 1
  };

  const unsupported = mergeDedupRank([base], {
    center: { lat: 32.28, lng: -81.08 },
    radiusMiles: 60,
    qualificationMode: "strict"
  });
  const supported = mergeDedupRank([{ ...base, id: "supported-remediation", phone: "(912) 555-0100" }], {
    center: { lat: 32.28, lng: -81.08 },
    radiusMiles: 60,
    qualificationMode: "strict"
  });

  assert.equal(unsupported.length, 0);
  assert.equal(supported.length, 1);
});

test("Manual Override is not part of the Business Query index", () => {
  const suggestions = getBusinessQuerySuggestions("manual override", 20).suggestions;
  assert.equal(suggestions.some((item) => /manual override/i.test(item.display)), false);
});

test("large-radius text searches use a rectangular restriction without exceeding Google circle limits", () => {
  const selection = resolveBusinessQuerySelection("trade:casework");
  const jobs = buildQueries(selection, {
    lat: 33.6891,
    lng: -78.8867,
    radius_meters: 500 * 1609.34
  });
  const textJobs = jobs.filter((job) => job.mode === "TEXT_SEARCH");
  assert.ok(textJobs.length > 0);
  for (const job of textJobs) {
    assert.ok(job.request_body.locationRestriction?.rectangle);
    assert.equal(job.request_body.locationBias, undefined);
  }
  for (const job of jobs.filter((job) => job.mode === "NEARBY_TYPES")) {
    assert.ok(job.request_body.locationRestriction.circle.radius <= 50000);
  }
});
