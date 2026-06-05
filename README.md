# Keystone Connect

Contractor discovery platform powered by Google Places.

## Run local

- Double-click: `ui/Open-App.command`
- Or run:

```bash
cd "/Users/mcdowell/Desktop/temp files/Keystone Connect"
npm start
```

App URL:

- [http://127.0.0.1:8787](http://127.0.0.1:8787)

## Required env

Create `.env` in project root:

```env
GOOGLE_MAPS_API_KEY=YOUR_KEY
```

## Main files

- `src/web-server.js` HTTP API + static app serving
- `src/search-engine.js` taxonomy-driven Places search, merge, rank, `.xlsx` export helpers
- `data/taxonomy.json` parent/child trade taxonomy + query profiles
- `ui-v2/app.html` current primary UI
- `ui-v2/assets/*` current branding assets
- `desktop/main.cjs` Electron desktop launcher
- `desktop/organize-builds.mjs` desktop artifact cleanup/renaming

## API endpoints

- `POST /api/search`
- `POST /api/csv`
- `GET /api/query-categories`
- `GET /api/location-suggest`
- `GET /api/reverse-zip`
- `GET /api/location-city`
- `GET /api/preferred`
- `POST /api/preferred`
- `POST /api/irrelevant`
- `GET /api/ping`

## Deploy

- Uses `render.yaml`.
- Start command: `npm start`
