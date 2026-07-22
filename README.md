# RuneScape TCG Alt1 App

A self-contained RuneScape 3 card collection app for Alt1, inspired by the OSRS TCG RuneLite plugin loop.

## Features

- Local card collection with rarities, duplicate conversion, pack opening, and an event log.
- Card images resolved from RuneScape Wiki page thumbnails through its MediaWiki API.
- Always-on RuneMetrics XP-counter detection using the same official `alt1/xpcounter` screen reader as AFK Warden.
- Manual RS3 activity rewards for skilling, boss kills, and clue caskets.
- Save import/export through base64 text.
- Alt1 manifest at `appconfig.json`.
- Manifest requests Alt1's `pixel` permission for RuneMetrics screen capture.

## Run locally

Build the browser bundle, then serve the folder with any static server.

```powershell
npm install
npm run build
python -m http.server 8080
```

Then open `http://localhost:8080` in a browser or Alt1.

## Install in Alt1

Host this folder and use:

```text
alt1://addapp/https://your-host.example/appconfig.json
```

For local testing, open the page in Alt1 and press the `+` button in the header.

## Next steps

Alt1 does not have RuneLite-style direct game events. Skill detection locates visible RuneMetrics counters by their skill icons and reads their values using Alt1's screen reader. RuneMetrics counters must remain visible; exact values provide the most reliable gain detection. Boss and clue readers can call the same `addReward` path once calibrated against your RS3 interface layout.
