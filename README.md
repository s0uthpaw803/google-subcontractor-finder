# Keystone Connect

Lean Google Places (New) construction-business finder.

## Run local

- Double-click: `ui/Open-App.command`
- Or run:

```bash
cd "/Users/mcdowell/Desktop/temp files/google-subcontractor-finder"
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
- `src/search-engine.js` taxonomy-driven Places search, merge, rank, CSV output
- `data/taxonomy.json` parent/child trade taxonomy + query profiles
- `ui/app.html` main UI
- `ui/assets/*` branding assets

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
