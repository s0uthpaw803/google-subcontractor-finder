const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const { app, shell, dialog, BrowserWindow } = require("electron");

const APP_HOST = "127.0.0.1";
const APP_DISPLAY_HOST = "localhost";
const DEFAULT_PORT = Number(process.env.KEYSTONE_DESKTOP_PORT || 8788);
const DESKTOP_LOG = "/tmp/keystone-connect-desktop.log";
function fileExists(p) {
  try {
    return Boolean(p) && fs.existsSync(p);
  } catch {
    return false;
  }
}

function resolveRootDir() {
  const candidates = [];
  const push = (p) => {
    if (!p) return;
    const resolved = path.resolve(String(p));
    if (!candidates.includes(resolved)) candidates.push(resolved);
  };

  push(process.env.KEYSTONE_ROOT);
  push(path.resolve(__dirname, ".."));
  if (process.resourcesPath) {
    push(path.join(process.resourcesPath, "app"));
    push(path.join(process.resourcesPath, "app.asar"));
  }
  try {
    push(app.getAppPath());
  } catch {
    // app path may not be available this early in some contexts
  }

  for (const candidate of candidates) {
    if (fileExists(path.join(candidate, "src", "web-server.js"))) {
      return candidate;
    }
  }

  return path.resolve(__dirname, "..");
}

let ROOT_DIR = "";

let serverModule = null;
let serverStopping = false;
let appPort = DEFAULT_PORT;
let keepAliveWindow = null;

process.env.HOST = APP_HOST;
process.env.PORT = String(DEFAULT_PORT);

function writeDesktopLog(message) {
  try {
    fs.appendFileSync(DESKTOP_LOG, `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    // ignore logging failures
  }
}

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
  return `http://${APP_DISPLAY_HOST}:${appPort}/`;
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
  writeDesktopLog(`Starting embedded server from root: ${ROOT_DIR}`);
  const serverPath = path.join(ROOT_DIR, "src", "web-server.js");
  if (!fileExists(serverPath)) {
    writeDesktopLog(`Server path missing: ${serverPath}`);
    throw new Error(`Embedded server entry not found at ${serverPath}`);
  }
  const moduleUrl = pathToFileURL(serverPath).href;
  serverModule = await import(moduleUrl);
  const tryPorts = [DEFAULT_PORT, ...Array.from({ length: 40 }, (_, i) => DEFAULT_PORT + i + 1)];
  let lastPortError = null;

  for (const port of tryPorts) {
    try {
      await serverModule.startServer({ host: APP_HOST, port });
      appPort = port;
      process.env.PORT = String(port);
      writeDesktopLog(`Embedded server bound to ${APP_HOST}:${port}`);
      await waitForServer();
      writeDesktopLog(`Embedded server passed health check on ${APP_HOST}:${port}`);
      return;
    } catch (error) {
      if (error?.code === "EADDRINUSE") {
        writeDesktopLog(`Port ${port} already in use`);
        lastPortError = error;
        continue;
      }
      writeDesktopLog(`Embedded server failed: ${String(error?.stack || error)}`);
      throw error;
    }
  }

  throw lastPortError || new Error("No open local port available for Keystone Connect.");
}

async function openInSystemBrowser() {
  const url = appUrl();
  await shell.openExternal(url);
}

function ensureKeepAliveWindow() {
  if (keepAliveWindow && !keepAliveWindow.isDestroyed()) return keepAliveWindow;
  keepAliveWindow = new BrowserWindow({
    width: 1,
    height: 1,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    focusable: false,
    skipTaskbar: true,
    webPreferences: {
      backgroundThrottling: false,
    },
  });
  keepAliveWindow.loadURL("data:text/plain,Keystone%20Connect");
  keepAliveWindow.on("closed", () => {
    keepAliveWindow = null;
  });
  return keepAliveWindow;
}

async function bootstrap() {
  await app.whenReady();
  try {
    fs.writeFileSync(DESKTOP_LOG, "");
    process.env.KEYSTONE_USER_DATA = app.getPath("userData");
    ROOT_DIR = resolveRootDir();
    process.env.KEYSTONE_ROOT = ROOT_DIR;
    writeDesktopLog(`Resolved root: ${ROOT_DIR}`);
    ensureDesktopApiKey();
    await startEmbeddedServer();
    ensureKeepAliveWindow();
    await openInSystemBrowser();
    writeDesktopLog(`Opened browser at ${appUrl()}`);
  } catch (error) {
    writeDesktopLog(`Bootstrap failed: ${String(error?.stack || error)}`);
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
  if (keepAliveWindow && !keepAliveWindow.isDestroyed()) {
    keepAliveWindow.destroy();
    keepAliveWindow = null;
  }
  Promise.resolve(serverModule.stopServer())
    .catch(() => null)
    .finally(() => app.exit(0));
});
