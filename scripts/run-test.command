#!/bin/zsh
set -euo pipefail

cd "$(dirname "$0")/.."

echo "Google Subcontractor Finder - Run Test"
echo "--------------------------------------"

read "location?Location (city/zip/state): "
read "query?Query [subcontractor]: "
query=${query:-subcontractor}

read "radius_miles?Radius miles [25]: "
radius_miles=${radius_miles:-25}

read "statewide?Statewide mode? (y/N): "
statewide=${statewide:-N}

read "grid?Grid step miles [35]: "
grid=${grid:-35}

read "output?Output CSV [test-results.csv]: "
output=${output:-test-results.csv}

radius_meters=$(awk "BEGIN { m=$radius_miles*1609.344; if (m>50000) m=50000; printf \"%d\", m }")
cmd=(npm start -- --location "$location" --query "$query" --radius "$radius_meters" --output "$output")

if [[ "$statewide" =~ ^[Yy]$ ]]; then
  cmd+=(--statewide --grid-step-miles "$grid")
fi

echo ""
echo "Running: ${cmd[*]}"
echo ""
"${cmd[@]}"

echo ""
echo "Done. CSV path: $PWD/$output"
echo "Open the app here: $PWD/ui/app.html"
read "_done?Press Enter to close..."
