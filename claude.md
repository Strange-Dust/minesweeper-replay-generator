# Minesweeper Replay Generator

## Project Overview
Browser extension (Chrome, Firefox, Safari) that passively records minesweeper gameplay on websites and generates `.rawvf` replay files. RAWVF is a plaintext replay format used in the minesweeper community.

## Architecture
This is a **Manifest V3 WebExtension** with three execution contexts:

- **Content script** (`src/content/`) — injected into minesweeper sites, observes DOM for board state changes, captures mouse events. This is the core data collection layer.
- **Background service worker** (`src/background/`) — extension lifecycle, badge updates. Minimal by design. Service worker can die at any time; no state stored in globals.
- **Popup** (`src/popup/`) — UI for start/stop/download controls. Ephemeral — destroyed when closed, queries background/content for state on every open.

Communication between contexts uses `browser.runtime.sendMessage()` / `browser.tabs.sendMessage()` with the `webextension-polyfill` library for cross-browser compatibility.

## Key Design Decisions

### Passive observation only (extremely important)
- The extension must NEVER modify game state, make network requests to the target site, auto-click, or provide unfair advantages.
- Content script reads the DOM only. It must not inject visible UI into the page.
- Mine positions should only be read AFTER being revealed, never before.
- Our extension MUST be functionally equivalent to screen recording software.
- It is extremely important that this extension does not have behaviour that could be mistaken for cheating.
- It would be terrible if a user were to get banned due to anti-cheat inadvertently thinking they were cheating.
- It is of the utmost importance that this tool be ethical and benevolent.

### Cross-browser compatibility
- Uses `webextension-polyfill` — always import from `src/utils/browser.ts`, never use `chrome.*` directly.
- Message listeners return Promises (polyfill pattern) instead of using `sendResponse` callbacks.
- Avoid Chrome-only APIs: no `offscreen`, careful with `storage.session`.
- Content scripts share the page's origin, so `localStorage.getItem()` reads the site's own storage directly — no `<script>` injection or `"world": "MAIN"` needed.

### Coordinate conventions
- Internal board positions: `(row, col)`, 0-indexed, row always comes first
- Pixel coordinates: `(x, y)`, standard screen coordinates
- RAWVF output: `(col, row)`, 1-indexed (conversion handled by the writer)

### SPA navigation and zombie observers
minesweeper.online is a single-page app (SPA). The content script loads once on first page load and survives all subsequent in-app navigation — clicking links to settings, leaderboards, etc. does NOT trigger a full page reload, so `document_idle` doesn't re-fire. The SPA destroys and recreates DOM elements as the user navigates.

This causes a critical problem: **zombie observers**. Any `MutationObserver` or `addEventListener` attached to a DOM element becomes a zombie when the SPA destroys that element — the observer/listener is still registered on the detached node but will never fire again. The code must handle this for:

1. **Board presence** — Polled every 300ms (`BOARD_POLL_INTERVAL_MS`). Compares the current `adapter.findBoardElement()` result against `lastKnownBoardElement` by identity (`===`) and `document.contains()`. When the element changes or disappears, all observers on the old element are cancelled and fresh ones are attached to the new element.

2. **Settings page watchers** — When the user navigates TO `/settings`, event listeners are attached to the settings DOM elements (`#property_chording`, etc.). When the user navigates AWAY, those elements are destroyed by the SPA. The navigation monitor (polls `window.location.pathname` every 500ms) calls `cancelWatchSettings()` on departure and re-attaches fresh listeners with `readAndWatchSettings()` on each arrival.

3. **Game end / board reset observers** — `MutationObserver` instances on `#top_area_face` and `#AreaBlock` become zombies when the board is destroyed. The board presence monitor cancels and recreates them.

**Key rule:** Never assume a DOM element or observer from a previous page view is still valid. Always cancel old watchers before attaching new ones, and always query the DOM fresh.

### Settings architecture
Settings (chording mode, keyboard-as-mouse) can come from two sources:
- **Auto-detected**: Parsed from the site's settings page DOM whenever the user visits `/settings`
- **Manual override**: Configured by the user in the extension popup

Both are stored independently in `browser.storage.local` via `StoredSettings`:
- `autoDetectedSettings: GameSettings | null` — always updated when visiting settings page, even if manual override is active
- `manualSettings: GameSettings | null` — set when user enables manual override
- `manualOverride: boolean` — which source is active

Effective settings priority: `manualSettings` (if override active) → `autoDetectedSettings` → `DEFAULT_SETTINGS`

This ensures the user can toggle manual override on/off without losing auto-detected values.

### First-click timing convention
In minesweeper replays, the timer starts on release (not press). The recorder buffers press events in `ready` state. When the first release event arrives, both the buffered press and the release are emitted at timeMs=0, and the timer starts from the release timestamp.

## Site Adapters
The `SiteAdapter` interface in `src/content/siteAdapters.ts` defines what each adapter must provide:
- `matches()` — detect if the current page is the target site
- `findBoardElement()` — locate the board in the DOM
- `getBoardConfig()` — extract dimensions, mine count, cell size
- `getCellSelector()` — CSS selector for individual cells
- `extractCellState()` — map DOM element state to RAWVF board event codes
- `extractCellPosition()` — get (row, col) from a cell element
- `getMinePositions()` — read mine locations (post-game only)
- `onGameEnd()` — detect win/loss

## Adding Support for a New Site

Implement the `SiteAdapter` interface in `src/content/siteAdapters.ts`:

```typescript
const myAdapter: SiteAdapter = {
  getProgramName: () => 'My Minesweeper Site',
  matches: () => window.location.hostname === 'myminesweeper.com',
  findBoardElement: () => document.querySelector('#game-board'),
  getBoardConfig: () => ({ cols: 30, rows: 16, mines: 99, squareSize: 24 }),
  getCellSelector: () => '.cell',
  extractCellState: (el) => { /* map CSS classes to board event codes */ },
  extractCellPosition: (el) => { /* extract row, col from data attrs */ },
}
registerSiteAdapter(myAdapter)
```

## Development

```bash
# Install dependencies
npm install

# Build the extension (output in dist/)
npm run build

# Watch mode (auto-rebuild on changes)
npm run watch

# Type-check
npm run typecheck
```

### minesweeper.online (`src/content/adapters/minesweeperOnline.ts`)
- Board container: `#AreaBlock`
- Cell elements: `.cell` with `id="cell_{x}_{y}"`, `data-x` (col), `data-y` (row)
- Cell state: skin-prefixed classes like `{skin}_closed`, `{skin}_type3`, `{skin}_flag`
- Skin prefix extracted from `#game` class `skin_{name}` (e.g. `hdd`, `xp`, `nn`)
- State suffix mapping: `closed`, `flag`, `pressed`, `type0`–`type8` (numbers), `type10` (mine), `type11` (blast), `type12` (wrong flag)
- Game end: detected via MutationObserver on `#top_area_face` class changes (`*-face-win`, `*-face-lose`)

## Build System
- **esbuild** bundles TypeScript into self-contained JS files in `dist/`.
- All npm dependencies (like `webextension-polyfill`) are inlined into the output bundles.
- Users install the extension from the `dist/` folder contents — no `node_modules` shipped.
- `npm run build` to build, `npm run watch` for dev mode.

## File Structure
```
src/
├── background/index.ts     — service worker (lifecycle, badge)
├── content/
│   ├── index.ts            — content script entry, message handling, recorder lifecycle
│   ├── siteAdapters.ts     — SiteAdapter interface and registry
│   └── adapters/
│       └── minesweeperOnline.ts — adapter for minesweeper.online
├── popup/
│   ├── popup.html          — popup markup
│   ├── popup.css           — popup styles
│   └── popup.ts            — popup logic (controls, status, download)
├── rawvf/writer.ts         — converts RecordingData to .rawvf text
├── recording/
│   ├── recorder.ts         — GameRecorder orchestrator (state machine, event buffering)
│   ├── mouseTracker.ts     — mouse + keyboard event capture on board element
├── storage/
│   ├── gameStorage.ts      — replay persistence (50MB budget)
│   └── settingsStorage.ts  — settings persistence (auto-detected + manual override)
├── types/
│   ├── rawvf.ts            — board, event, recording types
│   ├── messages.ts         — extension messaging types
│   └── settings.ts         — GameSettings, StoredSettings, ChordingMode types
└── utils/
    ├── browser.ts          — webextension-polyfill re-export
    └── zip.ts              — minimal zip creation for multi-game downloads
docs/
├── minesweeper terminology.md
├── minesweeper statistics.md
└── rawvf spec.md
```

## Documentation
Reference docs live in `docs/`:
- **minesweeper terminology.md** — domain terms (cells, clicks, chords, 3BV, openings, islands)
- **minesweeper statistics.md** — formulas for 3BV/s, IOE, RQP, STNB, ZiNi, etc.
- **rawvf spec.md** — the RAWVF file format grammar and field definitions

## Current Status
First site adapter (minesweeper.online) is implemented and tested. Settings auto-detection, manual override, SPA navigation handling, multi-game sessions, and RAWVF output are all functional.
