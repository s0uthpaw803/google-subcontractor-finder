import assert from "node:assert/strict";
import test from "node:test";

import {
  businessQueryInventory,
  getBusinessQuerySelection,
  getBusinessQuerySuggestions,
  resolveBusinessQuerySelection
} from "../src/business-query.js";

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

test("site returns common trade and official CSI entries", () => {
  const displays = getBusinessQuerySuggestions("site", 12).suggestions.map((item) => item.display);
  assert.ok(displays.includes("Civil / Sitework"));
  assert.ok(displays.includes("Site Clearing — 31 10 00"));
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

test("Manual Override is not part of the Business Query index", () => {
  const suggestions = getBusinessQuerySuggestions("manual override", 20).suggestions;
  assert.equal(suggestions.some((item) => /manual override/i.test(item.display)), false);
});
