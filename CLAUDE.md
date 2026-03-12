# Marin Century Timing Tool — Claude Instructions

## Project Overview
Pure client-side GitHub Pages tool for predicting rider volumes at rest stops and CHP/police positions during the 2026 Marin Century cycling event.

Live: https://rdy4trvl.github.io/marin-century-timing-2026/

## Key Files
- `index.html` — UI with tabs: Routes, Riders, Settings, Police/CHP, Reports
- `index.css` — styles
- `js/app.js` — main controller, state management, render functions
- `js/gpxParser.js` — parses GPX files, extracts `restStops` and `policeStops`
- `js/aggregation.js` — heatmap, rest stop summaries, police summaries
- `js/simulation.js` — rider slug simulation engine
- `js/speedModel.js` — gradient-based speed model
- `marin-century-config.json` — committed fallback config (v3), auto-loaded if no localStorage
- `2026-routes/` — GPX files for all 5 routes (auto-fetched on page load)

## Routes (all GPX files in `2026-routes/`)
| Route | Riders | Color | File |
|-------|--------|-------|------|
| Geronimo 37 | 151 | purple | `Geronimo_-_2026_Marin_Century_-_Official_Route (2).gpx` |
| Metric Century 64 | 878 | amber | `Metric_Century_-_2026_Marin_Century_-_Official_Route.gpx` |
| Century 100 | 795 | green | `Century_-_2026_Marin_Century_-_Official_Route.gpx` |
| Mt Tam 93 | 258 | blue | `Mt._Tam_-_2026_Marin_Century_Official_Route.gpx` |
| Double Metric 127 | 117 | yellow | `Double_Metric_-_Marin_Century_2026_-_Official_Route.gpx` |

## Architecture Rules

### No backend
This is pure client-side. No servers, no APIs, no build step. All logic runs in the browser.

### Config persistence
- **Primary**: `localStorage` key `marin-century-config-v3`
- **Fallback**: `marin-century-config.json` fetched from server
- When changing config schema, bump the version in both the localStorage key and the JSON file
- Settings tab has a "Reset to Server Defaults" button that clears localStorage

### GPX wins principle
GPX files are the source of truth for waypoint names and locations. Config only overlays dwell times. The `overlayDwellTimes()` function in `gpxParser.js` implements this — never reverse this priority.

### CHP/Police waypoints
- Detected automatically by `gpxParser.js` when waypoint name starts with `"CHP "`
- Convention: name waypoints `"CHP [location]"` in RideWithGPS (e.g., `"CHP Alexander"`, `"CHP mile 4"`)
- All 5 route GPX files already have CHP waypoints
- Police/CHP tab uses 0 dwell time; "Arrive By" = 30 min before first rider

## Dev Workflow
- No build step — edit files directly, commit, push to `main`, GitHub Pages auto-deploys
- Test in Chrome (Claude in Chrome extension available for visual verification)
- Always verify the live site after a merge to confirm changes rendered correctly
- Branch from `main`, PR back to `main`

## GitHub
- Repo: `rdy4trvl/marin-century-timing-2026` (inferred from live URL; verify if uncertain)
- `GH_TOKEN` is set as a Windows system environment variable — load it with:
  ```bash
  GH_TOKEN=$(powershell.exe -Command "[System.Environment]::GetEnvironmentVariable('GH_TOKEN', 'Machine')" 2>/dev/null | tr -d '\r')
  ```
- Token scopes: `repo`, `workflow`

## What Not To Do
- Do not add a backend, build system, or bundler without explicit discussion
- Do not change the localStorage key name without migrating existing data and bumping the version
- Do not let config override GPX waypoint names or locations
- Do not mock or stub GPX parsing in tests — the parser must handle real GPX files
