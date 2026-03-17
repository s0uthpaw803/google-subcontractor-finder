import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const DIST = path.join(ROOT, "dist-desktop");
const RUN_DIR = path.join(DIST, "Run");
const SHARE_DIR = path.join(DIST, "Share");
const COMPAT_DIR = path.join(DIST, "Compatibility");
const ARCHIVE_DIR = path.join(DIST, "Archive");
const pkg = JSON.parse(await fs.readFile(path.join(ROOT, "package.json"), "utf8"));
const version = pkg.version;
const latestTag = "LATEST";
const labels = {
  macMChipRun: `Keystone Connect - Mac (M-chip) - ${latestTag}.dmg`,
  macIntelRun: `Keystone Connect - Mac (Intel) - ${latestTag}.dmg`,
  winMostPcsRun: `Keystone Connect - Windows (Most PCs) - ${latestTag}.exe`,
  macMChipShare: `Keystone Connect - Mac (M-chip) - ${latestTag}.zip`,
  macIntelShare: `Keystone Connect - Mac (Intel) - ${latestTag}.zip`,
  winMostPcsShare: `Keystone Connect - Windows (Most PCs) - ${latestTag}.zip`,
  winArmShare: `Keystone Connect - Windows (ARM laptops) - ${latestTag}.zip`,
  macLauncherApp: `Keystone Connect - Mac (M-chip) Launcher - ${latestTag}.app`,
  macLauncherTxt: `Keystone Connect - Mac (M-chip) Launcher - ${latestTag}.txt`,
};

const timestamp = new Date()
  .toISOString()
  .replace(/[-:]/g, "")
  .replace("T", "-")
  .slice(0, 13);

const rawArchiveDir = path.join(ARCHIVE_DIR, `${timestamp}-raw`);
const replacedArchiveDir = path.join(ARCHIVE_DIR, `${timestamp}-replaced`);

const artifacts = [
  {
    src: `Keystone Connect-${version}-arm64.dmg`,
    dest: path.join("Run", labels.macMChipRun),
  },
  {
    src: `Keystone Connect-${version}.dmg`,
    dest: path.join("Compatibility", labels.macIntelRun),
  },
  {
    src: `Keystone Connect Setup ${version}.exe`,
    dest: path.join("Run", labels.winMostPcsRun),
  },
  {
    src: `Keystone Connect-${version}-arm64-mac.zip`,
    dest: path.join("Share", labels.macMChipShare),
  },
  {
    src: `Keystone Connect-${version}-mac.zip`,
    dest: path.join("Compatibility", labels.macIntelShare),
  },
  {
    src: `Keystone Connect-${version}-win.zip`,
    dest: path.join("Share", labels.winMostPcsShare),
  },
  {
    src: `Keystone Connect-${version}-arm64-win.zip`,
    dest: path.join("Compatibility", labels.winArmShare),
  },
  {
    src: path.join("mac-arm64", "Keystone Connect.app"),
    dest: path.join("Run", labels.macLauncherApp),
    directory: true,
  },
];

const launchNotes = `Keystone Connect Mac launcher\nOpen "${labels.macLauncherApp}" to test the live Mac M-chip build locally.\n`;

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function newestArchiveDir(suffix) {
  if (!(await exists(ARCHIVE_DIR))) return null;
  const entries = await fs.readdir(ARCHIVE_DIR, { withFileTypes: true });
  const matches = entries
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(suffix))
    .map((entry) => entry.name)
    .sort();
  if (!matches.length) return null;
  return path.join(ARCHIVE_DIR, matches.at(-1));
}

async function resolveSource(src) {
  const livePath = path.join(DIST, src);
  if (await exists(livePath)) return livePath;

  const latestRawDir = await newestArchiveDir("-raw");
  if (latestRawDir) {
    const rawPath = path.join(latestRawDir, src);
    if (await exists(rawPath)) return rawPath;
  }

  const latestReplacedDir = await newestArchiveDir("-replaced");
  if (latestReplacedDir) {
    const replacedPath = path.join(latestReplacedDir, path.basename(src));
    if (await exists(replacedPath)) return replacedPath;
  }

  return null;
}

async function moveToArchiveIfExists(target, archiveBase) {
  if (!(await exists(target))) return;
  await ensureDir(archiveBase);
  const archivedTarget = path.join(archiveBase, path.basename(target));
  if (await exists(archivedTarget)) {
    await fs.rm(archivedTarget, { recursive: true, force: true });
  }
  await fs.rename(target, archivedTarget);
}

async function copyArtifact({ src, dest, directory = false }) {
  const srcPath = await resolveSource(src);
  if (!srcPath) return;
  const destPath = path.join(DIST, dest);
  await ensureDir(path.dirname(destPath));
  await moveToArchiveIfExists(destPath, replacedArchiveDir);
  await fs.cp(srcPath, destPath, { recursive: directory, force: true });
}

async function archiveTopLevelClutter() {
  const keep = new Set(["Run", "Share", "Compatibility", "Archive"]);
  const entries = await fs.readdir(DIST, { withFileTypes: true });
  for (const entry of entries) {
    if (keep.has(entry.name)) continue;
    const entryPath = path.join(DIST, entry.name);
    await ensureDir(rawArchiveDir);
    const archivedPath = path.join(rawArchiveDir, entry.name);
    if (await exists(archivedPath)) {
      await fs.rm(archivedPath, { recursive: true, force: true });
    }
    await fs.rename(entryPath, archivedPath);
  }
}

async function cleanStageDir(stageDir, allowedNames) {
  if (!(await exists(stageDir))) return;
  const entries = await fs.readdir(stageDir, { withFileTypes: true });
  for (const entry of entries) {
    if (allowedNames.has(entry.name)) continue;
    await moveToArchiveIfExists(path.join(stageDir, entry.name), replacedArchiveDir);
  }
}

async function main() {
  await ensureDir(DIST);
  await ensureDir(RUN_DIR);
  await ensureDir(SHARE_DIR);
  await ensureDir(COMPAT_DIR);
  await ensureDir(ARCHIVE_DIR);

  const runKeep = new Set([
    labels.macMChipRun,
    labels.winMostPcsRun,
    labels.macLauncherApp,
    labels.macLauncherTxt,
  ]);
  const shareKeep = new Set([
    labels.macMChipShare,
    labels.winMostPcsShare,
  ]);
  const compatKeep = new Set([
    labels.macIntelRun,
    labels.macIntelShare,
    labels.winArmShare,
  ]);

  await cleanStageDir(RUN_DIR, runKeep);
  await cleanStageDir(SHARE_DIR, shareKeep);
  await cleanStageDir(COMPAT_DIR, compatKeep);

  for (const artifact of artifacts) {
    await copyArtifact(artifact);
  }

  await fs.writeFile(path.join(RUN_DIR, labels.macLauncherTxt), launchNotes, "utf8");

  await archiveTopLevelClutter();
  console.log("Organized desktop build artifacts in dist-desktop.");
}

await main();
