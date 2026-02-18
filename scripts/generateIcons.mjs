/**
 * Quick script to generate placeholder PNG icons from the SVG.
 * Run: node scripts/generateIcons.mjs
 * 
 * For production, replace these with proper designed icons.
 * Currently creates 1x1 blue pixel PNGs as placeholders.
 */

import { writeFileSync, mkdirSync } from 'fs'

// Minimal valid PNG (1x1 blue pixel) — just enough for the manifest to load.
// Replace with real icons when ready.
function createMinimalPng() {
  // This is a valid 1x1 PNG with a blue pixel
  const header = Buffer.from([
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
    // IHDR chunk
    0x00, 0x00, 0x00, 0x0D, // length
    0x49, 0x48, 0x44, 0x52, // "IHDR"
    0x00, 0x00, 0x00, 0x01, // width: 1
    0x00, 0x00, 0x00, 0x01, // height: 1
    0x08, 0x02,             // bit depth: 8, color type: 2 (RGB)
    0x00, 0x00, 0x00,       // compression, filter, interlace
    0x90, 0x77, 0x53, 0xDE, // CRC
    // IDAT chunk
    0x00, 0x00, 0x00, 0x0C, // length
    0x49, 0x44, 0x41, 0x54, // "IDAT"
    0x08, 0xD7, 0x63, 0x48, 0xCD, 0x60, 0x00, 0x00,
    0x00, 0x22, 0x00, 0x01, // compressed data
    0xE2, 0x26, 0x05, 0xA4, // CRC
    // IEND chunk
    0x00, 0x00, 0x00, 0x00, // length
    0x49, 0x45, 0x4E, 0x44, // "IEND"
    0xAE, 0x42, 0x60, 0x82, // CRC
  ])
  return header
}

mkdirSync('icons', { recursive: true })
const png = createMinimalPng()
writeFileSync('icons/icon16.png', png)
writeFileSync('icons/icon48.png', png)
writeFileSync('icons/icon128.png', png)
console.log('Placeholder icons created.')
