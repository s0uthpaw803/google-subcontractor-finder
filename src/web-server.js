#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { searchSubcontractors, toCsv } from "./search-engine.js";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = path.resolve(process.cwd());
const APP_HTML = path.join(ROOT, "ui", "app.html");
const UI_DIR = path.join(ROOT, "ui");

function contentTypeFor(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".jpg") || filePath.endsWith(".jpeg")) return "image/jpeg";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) {
        reject(new Error("Request too large"));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/") {
      const html = fs.readFileSync(APP_HTML, "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/assets/")) {
      const relPath = url.pathname.replace(/^\/+/, "");
      const filePath = path.join(UI_DIR, relPath);
      if (!filePath.startsWith(UI_DIR) || !fs.existsSync(filePath)) {
        sendJson(res, 404, { error: "Not found" });
        return;
      }
      const buf = fs.readFileSync(filePath);
      res.writeHead(200, { "Content-Type": contentTypeFor(filePath) });
      res.end(buf);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/search") {
      const raw = await readBody(req);
      const input = raw ? JSON.parse(raw) : {};

      if (!input.location) {
        sendJson(res, 400, { error: "Missing location" });
        return;
      }

      const logs = [];
      const result = await searchSubcontractors({
        location: input.location,
        query: input.query || "subcontractor",
        radiusMiles: input.radiusMiles,
        mode: input.mode === "statewide" ? "statewide" : "single",
        gridStepMiles: input.gridMiles,
        includeEmails: Boolean(input.includeEmails),
        onProgress: (msg) => logs.push(`${new Date().toISOString()} ${msg}`)
      });

      sendJson(res, 200, { ...result, logs });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/ping") {
      sendJson(res, 200, { ok: true, service: "subcontractor-finder" });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/csv") {
      const raw = await readBody(req);
      const input = raw ? JSON.parse(raw) : {};
      const rows = Array.isArray(input.rows) ? input.rows : [];
      const csv = toCsv(rows);
      res.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": "attachment; filename=subcontractors.csv"
      });
      res.end(csv);
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Server error" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Web app running at http://${HOST}:${PORT}`);
});
