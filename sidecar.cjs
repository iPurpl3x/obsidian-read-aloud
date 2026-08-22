/**
 * The read-aloud service in its own process.
 *
 * Not bundled into main.js on purpose: the library's normalizer resolves
 * `python/normalize_cli.py` from its own `import.meta.url` and offers no
 * override, so an esbuild bundle makes `available()` false and speech silently
 * degrades to raw markdown with the asterisks read out. Here the library sits
 * unpacked on disk, every relative path is real, and the ~1.5 GB warm model
 * lives in a process the plugin can kill.
 *
 * CommonJS, not ESM, even though the library it loads is ESM. This runs under
 * Obsidian's own Electron via ELECTRON_RUN_AS_NODE, and an ESM entry point
 * there depends on the Electron version; a CJS entry that reaches the ESM
 * library through dynamic `import()` works everywhere.
 *
 * Speaks one line of JSON on **fd 3** when listening, then nothing. Not stdout:
 * Obsidian's Electron logs its own startup lines to the child's stdout, and a
 * handshake that has to be picked out of someone else's log lines is a parser
 * waiting to break. Falls back to stdout when there is no fd 3.
 *
 * Exits when stdin closes, which is how it dies with Obsidian rather than
 * leaking. Anything that goes wrong on the way up is printed to stderr, which
 * the plugin reports rather than swallowing behind a timeout.
 */

'use strict'

const fs = require('fs')
const http = require('http')
const path = require('path')
const { pathToFileURL } = require('url')

const [, , libPath, cacheDir, defaultVoice] = process.argv

async function main() {
  const entry = path.join(libPath, 'src', 'server', 'index.js')
  if (!fs.existsSync(entry)) {
    throw new Error(`no read-aloud library at ${entry} — check the library path in settings`)
  }

  const { createReadAloudService } = await import(pathToFileURL(entry).href)

  const basePath = '/api/read-aloud'
  const service = createReadAloudService({
    basePath,
    cacheDir,
    defaultVoice: defaultVoice || 'kokoro:bm_george',
    // The plugin segments every passage into ~700-char clips, so a long note is
    // never one giant render — the library's 20k default would reject whole
    // notes before they reached the segmenter ("Passage is too long to speak",
    // with no way past it). A million characters is a guard, not a budget:
    // streaming means only the first ~700-char clip is rendered before play,
    // and the rest follow in the background.
    maxTextLength: 1_000_000,
    onLog: (message) => console.error(`[read-aloud] ${message}`),
  })

  const server = http.createServer((req, res) => service.handleRequest(req, res))
  server.on('error', (err) => {
    console.error(`[read-aloud] server error: ${err.message}`)
    process.exit(1)
  })

  // Port 0: the OS picks a free one. A fixed port collides with the next vault.
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

  const hello = `${JSON.stringify({ ready: true, port: server.address().port, basePath })}\n`
  try {
    fs.writeSync(3, hello)
  } catch (err) {
    // No fd 3 (run by hand, or a host that gives only three pipes). stdout is
    // the fallback, noise and all.
    process.stdout.write(hello)
  }

  let closing = false
  function shutdown() {
    if (closing) return
    closing = true
    service.shutdown()
    server.close(() => process.exit(0))
    // The warm model can take a moment to let go; don't hang on it.
    setTimeout(() => process.exit(0), 2000).unref()
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
  process.stdin.on('end', shutdown)
  process.stdin.on('close', shutdown)
  process.stdin.resume()
}

main().catch((err) => {
  console.error(`[read-aloud] sidecar failed to start: ${err?.stack || err}`)
  process.exit(1)
})
