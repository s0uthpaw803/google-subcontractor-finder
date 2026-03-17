const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const { app, shell, dialog } = require("electron");

const APP_HOST = "127.0.0.1";
const DEFAULT_PORT = Number(process.env.KEYSTONE_DESKTOP_PORT || 8788);
const ROOT_DIR = path.resolve(__dirname, "..");

let serverModule = null;
let serverStopping = false;
let appPort = DEFAULT_PORT;

process.env.KEYSTONE_ROOT = ROOT_DIR;
process.env.HOST = APP_HOST;
process.env.PORT = String(DEFAULT_PORT);

function ensureEarlyApiKey() {
  const existing =
    String(process.env.GOOGLE_MAPS_API_KEY || "").trim() ||
    String(process.env.KEYSTONE_GOOGLE_MAPS_API_KEY || "").trim();
  if (existing) {
    process.env.GOOGLE_MAPS_API_KEY = existing;
    return existing;
  }

  const candidates = [];
  const push = (p) => {
    const v = String(p || "").trim();
    if (!v || candidates.includes(v)) return;
    candidates.push(v);
  };

  push(process.env.KEYSTONE_ENV_PATH);
  push(path.join(process.cwd(), ".env"));
  push(path.join(ROOT_DIR, ".env"));

  for (const envPath of candidates) {
    const key = loadEnvValueFromFile(envPath, "GOOGLE_MAPS_API_KEY");
    if (!key) continue;
    process.env.GOOGLE_MAPS_API_KEY = key;
    return key;
  }
  return "";
}

const chromiumGeoApiKey = ensureEarlyApiKey();
if (chromiumGeoApiKey) {
  app.commandLine.appendSwitch("google-api-key", chromiumGeoApiKey);
}

function loadEnvValueFromFile(envPath, keyName) {
  try {
    if (!envPath || !fs.existsSync(envPath)) return "";
    const line = fs
      .readFileSync(envPath, "utf8")
      .split(/\r?\n/)
      .find((r) => new RegExp(`^(\\s*export\\s+)?${keyName}\\s*=`).test(r));
    if (!line) return "";
    return line
      .replace(new RegExp(`^(\\s*export\\s+)?${keyName}\\s*=\\s*`), "")
      .trim()
      .replace(/^['"]|['"]$/g, "");
  } catch {
    return "";
  }
}

function ensureDesktopApiKey() {
  const existing =
    String(process.env.GOOGLE_MAPS_API_KEY || "").trim() ||
    String(process.env.KEYSTONE_GOOGLE_MAPS_API_KEY || "").trim();
  if (existing) {
    process.env.GOOGLE_MAPS_API_KEY = existing;
    return;
  }

  const candidates = [];
  const push = (p) => {
    const v = String(p || "").trim();
    if (!v || candidates.includes(v)) return;
    candidates.push(v);
  };

  push(process.env.KEYSTONE_ENV_PATH);
  push(path.join(process.cwd(), ".env"));
  push(path.join(ROOT_DIR, ".env"));
  push(path.join(app.getPath("userData"), ".env"));
  if (process.resourcesPath) push(path.join(process.resourcesPath, ".env"));
  if (process.execPath) push(path.join(path.dirname(process.execPath), ".env"));

  for (const envPath of candidates) {
    const key = loadEnvValueFromFile(envPath, "GOOGLE_MAPS_API_KEY");
    if (!key) continue;
    process.env.GOOGLE_MAPS_API_KEY = key;
    break;
  }
}

function appUrl() {
  return `http://${APP_HOST}:${appPort}/`;
}

async function waitForServer(timeoutMs = 20000) {
  const started = Date.now();
  const url = `http://${APP_HOST}:${appPort}/api/ping`;
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (res.ok) return;
    } catch {
      // Retry until timeout.
    }
    await new Promise((r) => setTimeout(r, 220));
  }
  throw new Error("Desktop server did not become ready in time.");
}

async function startEmbeddedServer() {
  const moduleUrl = pathToFileURL(path.join(ROOT_DIR, "src", "web-server.js")).href;
  serverModule = await import(moduleUrl);
  const tryPorts = [DEFAULT_PORT, ...Array.from({ length: 40 }, (_, i) => DEFAULT_PORT + i + 1)];
  let lastPortError = null;

  for (const port of tryPorts) {
    try {
      await serverModule.startServer({ host: APP_HOST, port });
      appPort = port;
      process.env.PORT = String(port);
      await waitForServer();
      return;
    } catch (error) {
      if (error?.code === "EADDRINUSE") {
        lastPortError = error;
        continue;
      }
      throw error;
    }
  }

  throw lastPortError || new Error("No open local port available for Keystone Connect.");
}

async function openInSystemBrowser() {
  const url = appUrl();
  await shell.openExternal(url);
}

async function bootstrap() {
  await app.whenReady();
  try {
    process.env.KEYSTONE_USER_DATA = app.getPath("userData");
    ensureDesktopApiKey();
    await startEmbeddedServer();
    await openInSystemBrowser();
  } catch (error) {
    dialog.showErrorBox("Keystone Connect failed to start", String(error?.message || error));
    app.quit();
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    void openInSystemBrowser();
  });
  app.on("activate", () => void openInSystemBrowser());
  bootstrap();
}

app.on("before-quit", (event) => {
  if (!serverModule?.stopServer || serverStopping) return;
  event.preventDefault();
  serverStopping = true;
  Promise.resolve(serverModule.stopServer())
    .catch(() => null)
    .finally(() => app.exit(0));
});
