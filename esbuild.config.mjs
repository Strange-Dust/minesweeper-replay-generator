import * as esbuild from 'esbuild'
import { cpSync, mkdirSync } from 'fs'

const isWatch = process.argv.includes('--watch')

/** @type {import('esbuild').BuildOptions} */
const commonOptions = {
  bundle: true,
  sourcemap: true,
  target: 'es2022',
  format: 'esm',
  logLevel: 'info',
}

// Entry points for the extension
const entryPoints = [
  { in: 'src/content/index.ts', out: 'content/index' },
  { in: 'src/background/index.ts', out: 'background/index' },
  { in: 'src/popup/popup.ts', out: 'popup/popup' },
]

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
  ...commonOptions,
  entryPoints: entryPoints.map(ep => ({ in: ep.in, out: ep.out })),
  outdir: 'dist',
  // Content scripts must be IIFE (not ESM) for browser injection
  // We handle this per entry point below
}

async function build() {
  // Ensure dist directories exist
  mkdirSync('dist/popup', { recursive: true })
  mkdirSync('dist/icons', { recursive: true })

  // Build content script as IIFE (content scripts can't use ES modules)
  const contentBuild = esbuild.build({
    ...commonOptions,
    entryPoints: ['src/content/index.ts'],
    outfile: 'dist/content/index.js',
    format: 'iife',
  })

  // Build background service worker as ESM (service workers support ESM in MV3... 
  // but Firefox doesn't yet, so use IIFE for compatibility)
  const backgroundBuild = esbuild.build({
    ...commonOptions,
    entryPoints: ['src/background/index.ts'],
    outfile: 'dist/background/index.js',
    format: 'iife',
  })

  // Build popup script as IIFE
  const popupBuild = esbuild.build({
    ...commonOptions,
    entryPoints: ['src/popup/popup.ts'],
    outfile: 'dist/popup/popup.js',
    format: 'iife',
  })

  await Promise.all([contentBuild, backgroundBuild, popupBuild])

  // Copy static assets to dist
  cpSync('manifest.json', 'dist/manifest.json')
  cpSync('src/popup/popup.html', 'dist/popup/popup.html')
  cpSync('src/popup/popup.css', 'dist/popup/popup.css')
  cpSync('icons', 'dist/icons', { recursive: true })

  console.log('Build complete.')
}

async function watch() {
  // For watch mode, build contexts and watch
  const contentCtx = await esbuild.context({
    ...commonOptions,
    entryPoints: ['src/content/index.ts'],
    outfile: 'dist/content/index.js',
    format: 'iife',
  })

  const backgroundCtx = await esbuild.context({
    ...commonOptions,
    entryPoints: ['src/background/index.ts'],
    outfile: 'dist/background/index.js',
    format: 'iife',
  })

  const popupCtx = await esbuild.context({
    ...commonOptions,
    entryPoints: ['src/popup/popup.ts'],
    outfile: 'dist/popup/popup.js',
    format: 'iife',
  })

  // Initial copy of static assets
  mkdirSync('dist/popup', { recursive: true })
  mkdirSync('dist/icons', { recursive: true })
  cpSync('manifest.json', 'dist/manifest.json')
  cpSync('src/popup/popup.html', 'dist/popup/popup.html')
  cpSync('src/popup/popup.css', 'dist/popup/popup.css')
  cpSync('icons', 'dist/icons', { recursive: true })

  await Promise.all([
    contentCtx.watch(),
    backgroundCtx.watch(),
    popupCtx.watch(),
  ])

  console.log('Watching for changes...')
}

if (isWatch) {
  watch()
} else {
  build()
}
