# RuneScape TCG

A client-side RuneScape card-collection app for Alt1, inspired by the OSRS TCG RuneLite plugin.

## Features

- More than 10,000 cards based on RuneScape items, NPCs, skilling nodes, clue rewards, achievement rewards, and Invention components.
- Five-card packs with weighted rarities, foil cards, animated dealing, reveal sounds, individual reveals, and Reveal All.
- An Open Pack button that uses an owned pack or buys one with credits when no packs are available.
- A searchable collection with ownership, type, and rarity filters plus several sorting options.
- Duplicate storage, individual card sales, and a Sell Duplicates action.
- Always-on RuneMetrics XP detection through Alt1.
- RuneScape Wiki images and examine text, with resolved image URLs cached locally.
- Progress stored in the app's local browser storage. No backend or account is required.
- Exportable and restorable JSON save backups from Settings.

## Earning credits and packs

The app awards one credit per ten XP gained, rounded up for each detected XP drop. RuneMetrics must be open with its XP column visible so Alt1 can read changes to the counters.

Every XP drop also has a random chance to award a free pack. Higher XP drops have a better chance, while small, rapid XP drops have a reduced chance.

Cards can be sold from the collection for additional credits. Credits buy an Origin Pack when the player has no packs available.

## Local development

Install dependencies, create a debug build, and serve the repository over HTTP:

```powershell
npm install
npm run build
python -m http.server 8080
```

Open `http://localhost:8080/index.html`. Serving the files over HTTP allows Alt1 and browser APIs to load the manifest and assets consistently; do not open the page through `file://`.

Available build commands:

```powershell
npm run build          # Production bundle with the manual XP debug tool
npm run build:release  # Distribution bundle without debug tools
npm run watch          # Development bundle rebuilt when source files change
```

Both production commands write `dist/app.bundle.js`, so the last build command determines which version is present.

## Install in Alt1

With the local server running, open `http://localhost:8080/index.html` in Alt1. A hosted copy can be installed directly from its manifest:

```text
alt1://addapp/wisehorror.github.io/RS3-TCG-Alt1-Plugin/appconfig.json
```

The app requests Alt1's `pixel` permission to locate and read the visible RuneMetrics panel. It does not read game memory.

## Publishing

Run `npm run build:release`, commit the generated `dist/app.bundle.js`, and deploy the repository to any static HTTPS host such as GitHub Pages. Share either the hosted page or its `alt1://addapp/` manifest link.

Change the cache version in `appconfig.json` and the bundle query string in `index.html` for each release so existing Alt1 installations load the update.

## Catalogue tools

These scripts update or curate generated catalogue data. Review changes to `src/generated-cards.json` before committing them.

```powershell
npm run cards:update
npm run cards:clues
npm run cards:achievements
npm run cards:components
npm run cards:audit-images
npm run curate
```

## Important files

- `src/app.js`: application behavior and Alt1 XP detection
- `src/styles.css`: application and card styling
- `src/generated-cards.json`: generated card catalogue
- `src/rarity-config.json`: rarity chances and minimum card values
- `src/economy-config.json`: pack price and card-value cap
- `dist/app.bundle.js`: browser bundle loaded by `index.html`
- `appconfig.json`: Alt1 application manifest
