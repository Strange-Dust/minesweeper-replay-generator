# Minesweeper Replay Generator

A browser extension that records minesweeper games played online and generates `.rawvf` replay files.

## What is RAWVF?

RAWVF is a plain-text, human-readable replay format.

It captures:
- **Board layout** — mine positions
- **Mouse events** — every click, release, and movement with pixel-precise coordinates and millisecond timestamps
- **Board events** — cell state changes (opens, flags, blasts)
- **Game events** — start, win, loss

## How It Works

1. User navigates to a minesweeper website and clicks **Start Recording**
2. A **site adapter** detects the board element and configuration
3. The **mouse tracker** listens for mouse events over the board
4. The **board tracker** passively observes DOM mutations to detect cell state changes
5. When the game ends (or user stops), the **RAWVF writer** generates the replay file
6. User downloads the `.rawvf` file from the popup

### Loading in Chrome
1. Go to `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked" → select the `dist/` folder

### Loading in Firefox
1. Go to `about:debugging#/runtime/this-firefox`
2. Click "Load Temporary Add-on" → select `dist/manifest.json`

