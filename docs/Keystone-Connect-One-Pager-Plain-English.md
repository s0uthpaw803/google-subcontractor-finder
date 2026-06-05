# Keystone Connect — One-Page Guide

## What this app does
Keystone Connect helps me quickly find local contractor companies by:

- location
- business category
- search radius

It then lets me review results, save preferred companies, remove irrelevant ones, and download the current list to `.xlsx`.

## How to use it
1. Enter a location, or check **Use approximate location**.
2. Pick a **Business Query** category, or use **Manual Override**.
3. Set **Radius (mi)**.
4. Click **Search**.
5. Review results and open **website** or **map**.
6. Click **DOWNLOAD .XLSX** when I want to export.

## Main controls
- **API / APIB / GGL**
  - `API`: tighter, cleaner matches
  - `APIB`: broader than API
  - `GGL`: broadest search mode
- **PRIOR ON / OFF**
  - `ON`: hides companies already seen in earlier radius expansions
  - `OFF`: shows everything
- **Get emails if available. (Slower)**
  - Tries to pull business email addresses when available
- **Use approximate location**
  - Uses device/browser location as the search center
- **Reset fields**
  - Clears the current search inputs and results

## Result actions
- **Star**
  - Saves or removes a company from Preferred Results
- **Trash**
  - Removes a company from that specific query result set
- **Clear results**
  - Clears only the current visible results

## Important notes
- Distance shown is straight-line distance, not drive time.
- Results are not sponsored ads.
- Results are ranked by relevance first, then distance.
- Some businesses may not have a website or email available.
- The app supports both desktop and mobile layouts.

## Best workflow
1. Start with `API` and a smaller radius.
2. If results are thin, increase the radius and keep `PRIOR ON`.
3. Try `APIB` if `API` feels too strict.
4. Use `GGL` when I want the broadest net.
5. Star good companies as I go.
6. Export the final list to `.xlsx`.
