import * as esbuild from 'esbuild'
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'fs'

const isWatch = process.argv.includes('--watch')

/** @type {import('esbuild').BuildOptions} */
const commonOptions = {
  bundle: true,
  sourcemap: true,
  target: 'es2022',
  format: 'iife',
  logLevel: 'info',
}

/**
 * Generate a browser-specific manifest.json from the source manifest.
 * The source manifest contains BOTH background.service_worker (Chrome)
 * and background.scripts (Firefox). Each browser only wants its own key.
 * @param {'chrome' | 'firefox'} browser
 */
function generateManifest(browser) {
  const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'))

  if (browser === 'chrome') {
    // Chrome MV3: uses service_worker, warns on scripts
    delete manifest.background.scripts
    // Chrome ignores browser_specific_settings, but clean it out anyway
    delete manifest.browser_specific_settings
  } else if (browser === 'firefox') {
    // Firefox MV3: uses scripts, warns on service_worker
    delete manifest.background.service_worker
  }

  return JSON.stringify(manifest, null, 2) + '\n'
}

/**
 * Build JS bundles into a shared temp directory, then copy to browser-specific
 * output directories with the correct manifest.
 */
async function build() {
  const buildDir = 'dist/.build'

  // Ensure build directories exist
  mkdirSync(`${buildDir}/content`, { recursive: true })
  mkdirSync(`${buildDir}/background`, { recursive: true })
  mkdirSync(`${buildDir}/popup`, { recursive: true })

  // Build all entry points as IIFE (compatible with both browsers)
  const contentBuild = esbuild.build({
    ...commonOptions,
    entryPoints: ['src/content/index.ts'],
    outfile: `${buildDir}/content/index.js`,
  })

  const backgroundBuild = esbuild.build({
    ...commonOptions,
    entryPoints: ['src/background/index.ts'],
    outfile: `${buildDir}/background/index.js`,
  })

  const popupBuild = esbuild.build({
    ...commonOptions,
    entryPoints: ['src/popup/popup.ts'],
    outfile: `${buildDir}/popup/popup.js`,
  })

  await Promise.all([contentBuild, backgroundBuild, popupBuild])

  // Copy static assets into the shared build dir
  cpSync('src/popup/popup.html', `${buildDir}/popup/popup.html`)
  cpSync('src/popup/popup.css', `${buildDir}/popup/popup.css`)
  cpSync('icons', `${buildDir}/icons`, { recursive: true })

  // Produce browser-specific output directories
  for (const browser of ['chrome', 'firefox']) {
    const outDir = `dist/${browser}`
    mkdirSync(outDir, { recursive: true })

    // Copy all built files
    cpSync(buildDir, outDir, { recursive: true })

    // Write the browser-specific manifest
    writeFileSync(`${outDir}/manifest.json`, generateManifest(browser))
  }

  console.log('Build complete: dist/chrome/ and dist/firefox/')
}

async function watch() {
  // In watch mode, build to dist/chrome by default (load this in your browser)
  const target = process.argv.includes('--firefox') ? 'firefox' : 'chrome'
  const outDir = `dist/${target}`

  mkdirSync(`${outDir}/content`, { recursive: true })
  mkdirSync(`${outDir}/background`, { recursive: true })
  mkdirSync(`${outDir}/popup`, { recursive: true })
  mkdirSync(`${outDir}/icons`, { recursive: true })

  const contentCtx = await esbuild.context({
    ...commonOptions,
    entryPoints: ['src/content/index.ts'],
    outfile: `${outDir}/content/index.js`,
  })

  const backgroundCtx = await esbuild.context({
    ...commonOptions,
    entryPoints: ['src/background/index.ts'],
    outfile: `${outDir}/background/index.js`,
  })

  const popupCtx = await esbuild.context({
    ...commonOptions,
    entryPoints: ['src/popup/popup.ts'],
    outfile: `${outDir}/popup/popup.js`,
  })

  // Copy static assets
  cpSync('src/popup/popup.html', `${outDir}/popup/popup.html`)
  cpSync('src/popup/popup.css', `${outDir}/popup/popup.css`)
  cpSync('icons', `${outDir}/icons`, { recursive: true })

  // Write browser-specific manifest
  writeFileSync(`${outDir}/manifest.json`, generateManifest(target))

  await Promise.all([
    contentCtx.watch(),
    backgroundCtx.watch(),
    popupCtx.watch(),
  ])

  console.log(`Watching for changes (target: ${target})... Output: ${outDir}/`)
}

if (isWatch) {
  watch()
} else {
  build()
}
