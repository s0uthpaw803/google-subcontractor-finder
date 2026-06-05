# Keystone Connect Public Release FAQ

## What this app does
Keystone Connect finds local contractor businesses by location and business query category, then lets users review and export results.

## Which link should users use?
Use the current live deployment link for the web version, or the current `LATEST` package in `dist-desktop/Run` for desktop testing.

## What does `API / APIB / GGL` mean?
- `API`: tighter match
- `APIB`: broader than API
- `GGL`: broadest search mode

## What does `Use approximate location` do?
Uses browser/device geolocation as the search center.

## What does `Manual Override` do?
Allows a custom search term and is less restrictive than category-driven search.

## What does `PRIOR ON / OFF` do?
- `ON`: hides companies already seen in earlier radius expansions
- `OFF`: shows everything again

## What does `Get emails if available. (Slower)` do?
Attempts to retrieve relevant company email addresses. This is slower than normal search.

## What does the star icon do?
Adds or removes a company from Preferred Results.

## What does the trash icon do?
Removes that company from the current query results.

## What does `Reset fields` do?
Clears the current search inputs and current results.

## What does `DOWNLOAD .XLSX` do?
Exports the current visible results to an Excel file.

## Notes
- Distance shown is straight-line (air distance), not driving distance.
- Results are not sponsored ads.
- Results are sorted by relevance first, then distance.
- Result quality depends on Google listing quality and available profile data.

Maintainer note: keep this file current when feature names, search modes, export behavior, or distribution naming change.
