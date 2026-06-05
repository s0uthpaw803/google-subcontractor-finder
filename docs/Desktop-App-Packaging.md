# Keystone Connect Desktop Packaging (Mac + Windows)

## Purpose
Package Keystone Connect as a local desktop program for internal use, while still allowing the web version to exist separately when needed.

## What is included
- Electron desktop entrypoint:
  - `/Users/mcdowell/Desktop/temp files/Keystone Connect/desktop/main.cjs`
- Packaging/cleanup automation:
  - `/Users/mcdowell/Desktop/temp files/Keystone Connect/desktop/organize-builds.mjs`
- Server lifecycle:
  - `/Users/mcdowell/Desktop/temp files/Keystone Connect/src/web-server.js`
- Build scripts/config:
  - `/Users/mcdowell/Desktop/temp files/Keystone Connect/package.json`

## Install dependencies
From project root:

```bash
cd "/Users/mcdowell/Desktop/temp files/Keystone Connect"
npm install
```

## Run locally in desktop mode
```bash
npm run desktop:dev
```

## Build desktop packages
All supported builds:

```bash
npm run desktop:build
```

Mac only:

```bash
npm run desktop:build:mac
```

Windows only:

```bash
npm run desktop:build:win
```

## Output structure
Desktop artifacts are organized under:

- `/Users/mcdowell/Desktop/temp files/Keystone Connect/dist-desktop/Run`
- `/Users/mcdowell/Desktop/temp files/Keystone Connect/dist-desktop/Share`
- `/Users/mcdowell/Desktop/temp files/Keystone Connect/dist-desktop/Compatibility`
- `/Users/mcdowell/Desktop/temp files/Keystone Connect/dist-desktop/Archive`

### Run
Only the current mainstream launch/install files stay here:

- `Keystone Connect - Mac (M-chip) - LATEST.dmg`
- `Keystone Connect - Mac (M-chip) Launcher - LATEST.app`
- `Keystone Connect - Windows (Most PCs) - LATEST.exe`

### Share
Only the current mainstream zipped share files stay here:

- `Keystone Connect - Mac (M-chip) - LATEST.zip`
- `Keystone Connect - Windows (Most PCs) - LATEST.zip`

### Compatibility
Older/edge-platform builds live here:

- `Keystone Connect - Mac (Intel) - LATEST.dmg`
- `Keystone Connect - Mac (Intel) - LATEST.zip`
- `Keystone Connect - Windows (ARM laptops) - LATEST.zip`

### Archive
Old raw build artifacts and replaced files are moved here automatically.

## Desktop behavior
- The desktop app runs its own local server on `127.0.0.1`.
- It starts at port `8788` and automatically moves to the next open port if that one is already in use.
- The Mac launcher opens the app in the system browser after the local server passes its health check.

## Notes for internal distribution
- Unsigned builds can still trigger macOS Gatekeeper or Windows SmartScreen warnings.
- For smoother rollout later, add proper Apple and Windows code signing.
- The mainstream files to send are the ones in `Run`.
- The zipped files in `Share` are optional convenience copies, not the preferred install path for normal Windows users.

## Future app-store path
Yes, this can still be converted later because the search logic remains reusable.

The likely long-term path is:

- keep Keystone Connect search/backend logic intact,
- expose stable API routes,
- and build native mobile clients on top of that backend when needed.
