# Keystone Connect Desktop Packaging (macOS + Windows)

## Purpose
Package Keystone Connect as an internal desktop program while keeping Render/web deployment unchanged.

## What was added
- Electron entrypoint:
  - `/Users/mcdowell/Desktop/temp files/Keystone Connect/desktop/main.cjs`
- Server export lifecycle:
  - `/Users/mcdowell/Desktop/temp files/Keystone Connect/src/web-server.js`
  - Exposes `startServer()` and `stopServer()`
- Packaging scripts/config:
  - `/Users/mcdowell/Desktop/temp files/Keystone Connect/package.json`

## Install dependencies
From project root:

```bash
cd "/Users/mcdowell/Desktop/temp files/Keystone Connect"
npm install
```

## Run desktop app locally
```bash
npm run desktop:dev
```

## Build installers
All platforms (on supported build environment):
```bash
npm run desktop:build
```

macOS only:
```bash
npm run desktop:build:mac
```

Windows only:
```bash
npm run desktop:build:win
```

Output directory:
- `/Users/mcdowell/Desktop/temp files/Keystone Connect/dist-desktop`

## Notes for internal distribution
- Unsinged builds may show OS warnings.
- For smooth rollout, add code-signing certificates later.
- App embeds local API server and opens the main UI at `/`.

## Future mobile app-store path (iOS/Android)
Yes, this can be converted later, because core logic remains reusable:

- Keep server/search engine as backend API.
- Build native mobile clients (Swift/Kotlin/React Native/Flutter) that call the same API routes.
- App Store/Play Store will require platform-specific packaging, policy compliance, and signing.

