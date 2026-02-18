# Minesweeper Replay Generator

A browser extension (Chrome & Firefox) that records minesweeper games played online and generates `.rawvf` replay files.

## What is RAWVF?

RAWVF is a plain-text replay format used in the minesweeper community. It captures:
- **Board layout** — mine positions
- **Mouse events** — every click, release, and movement with pixel-precise coordinates and millisecond timestamps
- **Board events** — cell state changes (opens, flags, blasts)
- **Game events** — start, win, loss

RAWVF files can be loaded into replay analyzers (like [Minesweeper Replay Analyzer](https://github.com/user/minesweeper-replay-analyzer)) for detailed playback and statistics.

## Architecture

```
src/
├── content/              # Content script — injected into minesweeper sites
│   ├── index.ts          # Entry point, message handling
│   └── siteAdapters.ts   # Site-specific board detection interface
├── background/           # Service worker — extension lifecycle, badge
│   └── index.ts
├── popup/                # Popup UI — controls, status, download
│   ├── popup.html
│   ├── popup.css
│   └── popup.ts
├── recording/            # Core recording engine
│   ├── recorder.ts       # Game recorder orchestrator
│   ├── mouseTracker.ts   # Mouse event capture
│   └── boardTracker.ts   # DOM-based board state observation
├── rawvf/                # RAWVF file generation
│   └── writer.ts         # Converts recording data to .rawvf text
└── types/                # TypeScript type definitions
    ├── rawvf.ts           # RAWVF & recording types
    └── messages.ts        # Extension messaging types
```

## How It Works

1. User navigates to a minesweeper website and clicks **Start Recording**
2. A **site adapter** detects the board element and configuration
3. The **mouse tracker** listens for mouse events over the board
4. The **board tracker** observes DOM mutations to detect cell state changes
5. When the game ends (or user stops), the **RAWVF writer** generates the replay file
6. User downloads the `.rawvf` file from the popup

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

### Loading in Chrome
1. Go to `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked" → select the `dist/` folder

### Loading in Firefox
1. Go to `about:debugging#/runtime/this-firefox`
2. Click "Load Temporary Add-on" → select `dist/manifest.json`

## Status

🚧 **Early development** — core infrastructure is in place. 
Site adapters for specific minesweeper websites are the next step.

## Coordinate Conventions

- **Board positions**: `(row, col)` — row always comes first
- **Pixel coordinates**: `(x, y)` — standard screen coordinates
- **RAWVF file format**: uses 1-indexed `(col, row)` in the event stream (handled by the writer)
