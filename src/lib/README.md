# Minesweeper Replay Generator (library)

Self-contained TypeScript module for capturing minesweeper.online games and producing [RAWVF](https://github.com/thefinerminer/minesweeper-rawvf) replay files.

This is the same code that powers the [`minesweeper-replay-generator`](https://github.com/) browser extension, packaged so it can be dropped into another project (Electron mod, userscript, custom client, etc.).

## What's included

| Module | What it does |
| --- | --- |
| `GameRecorder` | Orchestrates a recording session — state machine, event buffering, multi-game freeze/unfreeze. |
| `MouseTracker` | Captures mouse + keyboard events on a DOM element. |
| `MinesweeperOnlineSite` | Reads the minesweeper.online DOM — board element, dimensions, mine positions, game-end events, settings. |
| `generateRawvf(data)` | Renders a `RecordingData` object as a `.rawvf` text file. |
| `generateFilename(data)` | Builds a canonical filename for a recording. |
| `convertWomReplay(data)` | Converts a server-side WoM 203 replay payload into `RecordingData`. |
| `parseSocketIoReplayFrame(payload)` | Pulls the 203 array out of a `42["response", …]` socket.io frame. |
| `parseWomReplayPaste(text)` | Tolerant parser for manually pasted replay frames (3 input formats). |
| `setLogLevel(level)` / `setLogPrefix(p)` | Configure or silence the library's `[MSR …]` console output. |

## What's *not* included

- Storage / persistence — the library returns RAWVF strings; you decide what to do with them.
- Session orchestration — board-presence polling, multi-game session lifecycle, SPA-navigation handling. The reference extension implements these in [`src/content/index.ts`](../content/index.ts) on top of this library.
- UI, message passing, browser-extension APIs.
- Site adapter abstraction. Only minesweeper.online is realistically supportable today (other popular clients render to canvas, which can't be read passively).

## Constraints

- **Browser context required.** The library uses `document`, `window`, `MutationObserver`, `localStorage`, `addEventListener`. It runs anywhere those exist (extension content script, userscript, Electron renderer, …).
- **Passive only.** It never modifies the page, never makes network requests, never simulates input. It's functionally equivalent to a screen recorder.

## Quick start — recording a live game

```ts
import {
  MinesweeperOnlineSite,
  GameRecorder,
  generateRawvf,
  generateFilename,
  DEFAULT_SETTINGS,
} from './lib'

const site = new MinesweeperOnlineSite()
if (!site.matches()) throw new Error('Not on minesweeper.online')

const board = site.findBoardElement()
const config = site.getBoardConfig()
const border = site.findBorderElement()
if (!board || !config) throw new Error('Board not ready')

let settings = site.readSettings() ?? DEFAULT_SETTINGS
site.initSettingsBridge(s => { settings = s })

const recorder = new GameRecorder({
  board: config,
  mouseTrackerConfig: {
    boardElement: board,
    squareSize: config.squareSize,
    borderElement: border ?? undefined,
    keyboardMouse: settings.keyboardMouse,
  },
  metadata: {
    program: site.getProgramName(),
    version: site.getVersion(),
    player: site.getPlayerName() ?? '',
    chordingMode: settings.chording,
  },
})

recorder.start()

site.onGameEnd(result => {
  recorder.finish()
  const minePositions = site.getMinePositions(result)
  const data = recorder.getRecordingData()
  data.minePositions = minePositions
  data.board.mines = minePositions.length
  data.result = result

  const rawvf = generateRawvf(data)
  const filename = generateFilename(data)
  // …save / upload / display rawvf…
})
```

For full session handling (multiple games per page, SPA navigation, board element being replaced under your feet, etc.) see [`src/content/index.ts`](../content/index.ts).

## Quick start — converting a server replay (WoM 203)

minesweeper.online sends each saved replay over its socket.io connection as a `42["response",[id, 203, [...]]]` frame. Once you have that frame string (or just the inner array), conversion is one call:

```ts
import {
  parseWomReplayPaste,
  convertWomReplay,
  generateRawvf,
  generateFilename,
} from './lib'

const data = parseWomReplayPaste(rawFrameText) // accepts 3 input formats
if (!data) throw new Error('Could not parse frame')

const { recording, gameId } = convertWomReplay(data)
const rawvf = generateRawvf(recording)
const filename = generateFilename(recording)
```

If you're capturing frames at the WebSocket level and want the library to extract the 203 payload from a raw `42[...]` string, use `parseSocketIoReplayFrame` instead.

## Logging

By default the library logs at `debug` level to the browser console with the `[MSR ISO-timestamp]` prefix. Configure once at startup:

```ts
import { setLogLevel, setLogPrefix } from './lib'

setLogLevel('warn')          // 'debug' | 'info' | 'warn' | 'error' | 'silent'
setLogPrefix('[MyApp/MSR')   // bracket prefix; closing bracket is added automatically
```

## File layout

```
src/lib/
├── index.ts                 — public barrel
├── recording/
│   ├── recorder.ts          — GameRecorder
│   └── mouseTracker.ts      — MouseTracker
├── site/
│   └── minesweeperOnline.ts — MinesweeperOnlineSite
├── rawvf/
│   ├── writer.ts            — generateRawvf, generateFilename
│   └── womConverter.ts      — convertWomReplay
├── utils/
│   ├── socketIoParser.ts    — frame parsers
│   ├── format.ts            — date formatting
│   └── log.ts               — mlog/minfo/mwarn/merr + setLogLevel/setLogPrefix
└── types/
    ├── rawvf.ts             — RecordingData, BoardConfig, RecordedMouseEvent, …
    └── settings.ts          — GameSettings, ChordingMode, KeyboardMouseConfig, …
```

## How to copy this library into another project

1. Copy the entire `src/lib/` folder into your project (rename the destination as you like).
2. Make sure your TypeScript / bundler picks up `.ts` files in that folder. No external runtime dependencies — only TypeScript types from your toolchain.
3. Import from `./lib` (the barrel) or from individual sub-modules.

That's it — no `package.json`, no install step, no build artifacts. Re-sync periodically by copying again.
