# Subcontractor Finder

Local + deployable subcontractor search app.

## Project layout

- `src/` backend search engine + web server
- `ui/` single-page app + logo assets
- `scripts/` helper scripts
- `data/scllr-contractors.json` SCLLR-only cache dataset for verification-mode app
- `data/exports/` CSV output folder (ignored in git)

## Local run (recommended)

1. Open clickable launcher:

`/Users/mcdowell/Desktop/temp files/google-subcontractor-finder/ui/Open-App.command`

2. It starts backend and opens:

[http://127.0.0.1:8787](http://127.0.0.1:8787)

SCLLR-only version:

[http://127.0.0.1:8787/scllr](http://127.0.0.1:8787/scllr)

## CLI run

```bash
cd /Users/mcdowell/Desktop/temp\ files/google-subcontractor-finder
npm start -- --location "Augusta, GA" --query "subcontractor" --radius 50000 --output data/exports/augusta.csv
```

## Email enrichment

```bash
npm run enrich:emails -- --input data/exports/augusta.csv --output data/exports/augusta-with-emails.csv
```

## Push to GitHub

```bash
cd /Users/mcdowell/Desktop/temp\ files/google-subcontractor-finder
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin <YOUR_GITHUB_REPO_URL>
git push -u origin main
```

## Deploy to Render (backend supported)

This repo includes `render.yaml` and is ready for Render.

1. Push to GitHub.
2. In Render: New + -> Blueprint.
3. Select this GitHub repo.
4. Render reads `render.yaml` and deploys.
5. Open deployed URL.

Health check endpoint:

- `/api/ping`

SCLLR-only endpoints:

- `POST /api/scllr/search`
- `POST /api/scllr/refresh`
- `GET /api/scllr/stats`

## Notes

- Netlify static hosting is not a fit for this app’s backend scraping flow.
- `logs/` and CSV exports are git-ignored.
- SCLLR data mode uses cache file `data/scllr-contractors.json` and can be refreshed from public SCLLR verification pages.
