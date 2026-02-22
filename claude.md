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
- This is functionally equivalent to screen recording software.
- It is of the utmost importance that this tool be ethical and benevolent.

### Cross-browser compatibility
- Uses `webextension-polyfill` — always import from `src/utils/browser.ts`, never use `chrome.*` directly.
- Message listeners return Promises (polyfill pattern) instead of using `sendResponse` callbacks.
- Avoid Chrome-only APIs: no `offscreen`, careful with `storage.session`.
- For page JS access, use `<script>` tag injection + `window.postMessage()` rather than `"world": "MAIN"` (Safari doesn't support it).

### Coordinate conventions
- Internal board positions: `(row, col)`, 0-indexed
- Pixel coordinates: `(x, y)`, standard screen coordinates
- RAWVF output: `(col, row)`, 1-indexed (conversion handled by the writer)

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
│   ├── recorder.ts         — GameRecorder orchestrator
│   ├── mouseTracker.ts     — mouse event capture on board element
│   └── boardTracker.ts     — MutationObserver-based cell state tracking
├── types/
│   ├── rawvf.ts            — board, event, recording types
│   └── messages.ts         — extension messaging types
└── utils/browser.ts        — webextension-polyfill re-export
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
First site adapter (minesweeper.online) is implemented. Next steps: end-to-end testing, verifying RAWVF output correctness.
