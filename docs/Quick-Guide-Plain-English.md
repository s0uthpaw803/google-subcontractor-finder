# Keystone Connect - Quick Guide (Plain English)

## What This App Does
Keystone Connect helps me find local contractor businesses fast.
I pick a location and a business type, then the app gives me matching companies.

## Quick Steps
1. Enter a location, or check **Use approximate location**.
2. Pick a **Business Query** category, or choose **Manual Override** to type my own search.
3. Set the search **Radius (mi)**.
4. Click **Search**.
5. Review the results and click **website** or **map**.
6. Click **DOWNLOAD .XLSX** if I want a file of the results.

## Main Options (Simple)
- **Use approximate location**: Uses device/browser location.
- **Business Query**:
  - Picking a **parent category** searches all child trades in that group.
  - **Manual Override** lets me type any search phrase.
  - **Preferred Results** shows companies I starred.
- **Radius (mi)**: How far out to search.
- **API / APIB / GGL**:
  - `API`: tighter, cleaner matches
  - `APIB`: broader than API
  - `GGL`: broadest search mode
- **PRIOR ON / OFF**:
  - `ON`: hides companies I already saw when I expand radius
  - `OFF`: shows everything
- **Get emails if available. (Slower)**:
  - Tries to retrieve business email addresses when available
- **Reset fields**:
  - Clears the current search inputs and results

## Result Actions
- **Star icon**: Save or remove a company from Preferred Results.
- **Trash icon**: Remove a company from that specific query.
- **Clear results**: Clear the current visible results from the screen.

## Important Notes
- Distance shown is **air distance** (straight-line), not driving distance.
- Results are not sponsored ads.
- Results are ranked by relevance first, then distance.
- Result quality depends on Google business listing data.
- Some businesses may not have website/email data available.

## .xlsx Export
- Exports the results currently shown on screen.
- Includes key business fields and category section.
- UI actions like star/remove are not exported as extra columns.

## If Something Looks Wrong
- If no results: try a broader search term, bigger radius, or another search mode.
- If location suggestions overlap or look stuck: refresh and try again.
- If location is blocked: allow location access in browser/site settings.
