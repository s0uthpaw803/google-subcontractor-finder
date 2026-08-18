import assert from "node:assert/strict";
import test from "node:test";

import { enrichCompanyEmails, extractEmailCandidates } from "../src/email-enrichment.js";
import { toCsv } from "../src/search-engine.js";

function response(url, body, contentType = "text/html") {
  const bytes = Buffer.from(body, "utf8");
  return {
    ok: true,
    status: 200,
    url,
    headers: {
      get(name) {
        if (String(name).toLowerCase() === "content-type") return contentType;
        if (String(name).toLowerCase() === "content-length") return String(bytes.length);
        return null;
      }
    },
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
  };
}

test("extracts normal and HTML-obfuscated public email addresses", () => {
  assert.deepEqual(
    extractEmailCandidates("Info&#64;Acme.com and bids@acme.com and image@logo.png"),
    ["info@acme.com", "bids@acme.com"]
  );
});

test("enrichment keeps every non-invalid company-related email with evidence", async () => {
  const pages = new Map([
    ["https://acme.example/", `
      <a href="mailto:estimating@acme.example">Bids</a>
      <span>info@acme.example</span>
      <a href="/team">Team</a>
      <a href="https://facebook.com/acmecontracting">Facebook</a>
      <span>bad@missing.invalid</span>
    `],
    ["https://acme.example/team", "Jane.Smith@acme.example"],
    ["https://facebook.com/acmecontracting", "Public contact: acmecontracting@gmail.com"]
  ]);
  const fetchImpl = async (url) => response(url, pages.get(url) || "");
  const resolveMxImpl = async (domain) => {
    if (domain === "missing.invalid") {
      const error = new Error("not found");
      error.code = "ENOTFOUND";
      throw error;
    }
    return [{ exchange: `mx.${domain}`, priority: 10 }];
  };

  const result = await enrichCompanyEmails(
    { name: "Acme Contracting", website: "https://acme.example/" },
    { fetchImpl, resolveMxImpl, timeoutMs: 1000 }
  );

  const byEmail = new Map(result.email_records.map((record) => [record.email, record]));
  assert.equal(byEmail.has("bad@missing.invalid"), false);
  assert.equal(byEmail.get("estimating@acme.example")?.email_status, "Valid");
  assert.equal(byEmail.get("estimating@acme.example")?.email_type, "Estimating");
  assert.equal(byEmail.get("info@acme.example")?.email_type, "General");
  assert.equal(byEmail.get("jane.smith@acme.example")?.email_type, "Employee");
  assert.equal(byEmail.get("acmecontracting@gmail.com")?.email_status, "Likely");
  assert.equal(byEmail.get("acmecontracting@gmail.com")?.email_source, "Company Social Profile");
  assert.ok(Number(byEmail.get("acmecontracting@gmail.com")?.company_relationship_confidence) > 0);
  assert.equal(new Set(result.email_records.map((record) => record.email)).size, result.email_records.length);
  for (const record of result.email_records) {
    for (const key of ["email", "email_status", "email_source", "source_url", "email_type", "company_relationship_confidence"]) {
      assert.notEqual(record[key], undefined);
    }
  }
});

test("CSV expands one company into one row per included email and excludes Invalid", () => {
  const csv = toCsv([{
    name: "Acme Contracting",
    category_section: "Division 26",
    emails: "bids@acme.example; old@invalid.example",
    email_records: [
      {
        email: "bids@acme.example",
        email_status: "Likely",
        email_source: "Company Website",
        source_url: "https://acme.example/contact",
        email_type: "Estimating",
        company_relationship_confidence: 96
      },
      {
        email: "old@invalid.example",
        email_status: "Invalid",
        email_source: "Business Directory",
        source_url: "https://directory.example/acme",
        email_type: "Other",
        company_relationship_confidence: 20
      }
    ]
  }]);

  assert.match(csv, /email_status,email_source,source_url,email_type,company_relationship_confidence/);
  assert.match(csv, /bids@acme\.example,Likely,Company Website/);
  assert.doesNotMatch(csv, /old@invalid\.example/);
});
