# RuneScape TCG

A client-side RuneScape 3 card-collection app for Alt1, inspired by the gameplay loop of the OSRS TCG RuneLite plugin.

## Features

- More than 9,000 cards based on RuneScape items, NPCs, skilling nodes, clue rewards, and Invention components.
- RuneScape Wiki images and examine text resolved through the MediaWiki API and cached locally.
- Five-card packs with rarity rolls, foil cards, individual reveals, Reveal All, and batch opening.
- Single, ten-pack, custom, and maximum-affordable pack purchases.
- Searchable collection with ownership, type, and rarity filters plus multiple sorting options.
- Duplicate storage and manual card sales, including Sell All Duplicates.
- Always-on RuneMetrics XP detection through Alt1.
- Progress stored locally in the app's browser storage. No backend or database is required.

## XP rewards

The app awards one credit per ten XP gained, rounded up. The RuneMetrics metrics panel must be open and its XP column must be visible.

An XP gain of 100 XP has a 1-in-500 chance to award a free pack. Smaller gains scale down by their XP, while larger gains scale up linearly to a maximum 1-in-100 chance at 1,000 XP. Credits are not reduced. The activity reward controls shown in debug builds are testing tools and are omitted from release builds.

## Local development

Install dependencies and create a debug build:

```powershell
npm install
npm run build
python -m http.server 8080
```

Open `http://localhost:8080/index.html`. The app must be served over HTTP rather than opened using `file://` so Alt1 and browser APIs can load its manifest and assets consistently.

Available build commands:

```powershell
npm run build          # Includes manual debug reward controls
npm run build:release  # Removes debug controls for distribution
npm run watch          # Rebuilds while source files change
```

Both production commands write `dist/app.bundle.js`. The most recently run command determines which version is present.

## Install in Alt1

While the local server is running, open `http://localhost:8080/index.html` and use the **Add to Alt1** button. For a hosted release, install the manifest URL directly:

```text
alt1://addapp/https://your-host.example/appconfig.json
```

The app requests Alt1's `pixel` permission to locate and read the visible RuneMetrics metrics panel. It does not read game memory.

## Catalogue tools

The scripts below update or curate generated catalogue data. Review changes to `src/generated-cards.json` before committing them.

```powershell
npm run cards:update
npm run cards:clues
npm run cards:components
npm run curate
```

## Data and builds

- `src/generated-cards.json`: generated card catalogue
- `src/rarity-config.json`: rarity chances and minimum card values
- `src/economy-config.json`: pack price and card-value cap
- `dist/app.bundle.js`: browser bundle loaded by `index.html`
- `appconfig.json`: Alt1 application manifest
