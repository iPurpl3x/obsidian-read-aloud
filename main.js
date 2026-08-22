/**
 * Read Aloud — Obsidian front end for `athanor-code/read-aloud`.
 *
 * Plain CommonJS, no build step. The usual reason an Obsidian plugin needs
 * esbuild is bundling its dependencies; this one deliberately bundles nothing
 * (see sidecar.cjs for why), so there is nothing to build.
 *
 * The library's server half does all the real work — normalizing, segmenting,
 * synthesis, the content-addressed cache. Its React half cannot run here, so
 * the player below rebuilds the library's own player in plain DOM, using the
 * library's own class names and its own stylesheet read off disk. That is the
 * difference between this and a lookalike: the widget is the one from modicom
 * and trading-analysis, themed through `--ra-*`, not a second design.
 */

'use strict'

const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

// ponytail: swallowed so test.mjs can load the pure helpers at the bottom of
// this file outside Obsidian. Inside Obsidian this never throws.
let obsidian = {}
try {
  obsidian = require('obsidian')
} catch (err) {
  /* not running inside Obsidian */
}
const { Plugin, PluginSettingTab, Setting, Notice, requestUrl } = obsidian

const DEFAULTS = {
  libPath: path.join(os.homedir(), '.local', 'share', 'read-aloud'),
  // Empty means auto-detect. See resolveNode().
  nodePath: '',
  voice: 'kokoro:bm_george',
  rate: 1,
  rates: [1, 1.25, 1.5, 2],
  skipSeconds: 10,
  headingButtons: true,
  warmOnOpen: true,
}

/** How long the card stays open after the pointer leaves. Without a grace
 *  period, expanding on hover is a trap: the widget grows, reflows under the
 *  cursor, and the first move towards a button crosses a boundary that closes
 *  the thing you were reaching for. Same value as the library's player. */
const CLOSE_DELAY_MS = 500

/* ------------------------------------------------------------------ helpers */

/**
 * The line range of the section a heading owns: the heading itself, everything
 * under it, and nothing from the next heading of the same or higher level.
 *
 * Fence-aware, because `# not a heading` inside a code block is a comment and
 * cutting the section there reads half a paragraph and stops.
 *
 * @returns {[number, number]} `[start, end)` line indices.
 */
function sectionRange(lines, startLine) {
  const heading = /^(#{1,6})\s/.exec(lines[startLine] ?? '')
  if (!heading) return [startLine, startLine + 1]
  const level = heading[1].length

  let fence = null
  for (let i = startLine + 1; i < lines.length; i += 1) {
    const line = lines[i]
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)
    if (marker) {
      const char = marker[1][0]
      if (!fence) fence = char
      else if (fence === char) fence = null
      continue
    }
    if (fence) continue
    const next = /^(#{1,6})\s/.exec(line)
    if (next && next[1].length <= level) return [startLine, i]
  }
  return [startLine, lines.length]
}

/** Rough seconds for a segment whose audio does not exist yet, so the total can
 *  be shown (with a `~`) instead of jumping around as segments arrive. */
function estimateSeconds(chars) {
  return Math.max(1, Math.round((Number(chars) || 0) / 14))
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0
  const whole = Math.floor(seconds)
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

/**
 * Finds a real `node` binary by absolute path.
 *
 * Three approaches are ruled out by experiment, not taste:
 *
 * - `spawn('node')` — Obsidian launched from Finder inherits `PATH=/usr/bin:/bin`,
 *   so this is ENOENT on any Mac whose node came from homebrew, asdf or nvm.
 * - Obsidian's own binary with `ELECTRON_RUN_AS_NODE=1` — Obsidian is a packaged
 *   app that parses argv itself and answers "Command line interface is not
 *   enabled" instead of running the script.
 * - A version manager's *shim* — a shim is a script that needs the shell
 *   environment `PATH` was already missing, so it only moves the problem.
 *
 * What is left is the real interpreter inside a version manager's install
 * directory, which runs with no environment at all. Newest version first, and
 * each candidate has to answer `--version` before it is trusted.
 */
function resolveNode() {
  const home = os.homedir()
  const candidates = ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node']

  const managed = [
    path.join(home, '.asdf', 'installs', 'nodejs'),
    path.join(home, '.nvm', 'versions', 'node'),
    path.join(home, '.local', 'share', 'mise', 'installs', 'node'),
    path.join(home, '.volta', 'tools', 'image', 'node'),
  ]
  const byVersionDesc = (a, b) =>
    b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' })

  for (const root of managed) {
    let versions
    try {
      versions = fs.readdirSync(root).sort(byVersionDesc)
    } catch (err) {
      continue
    }
    for (const version of versions) candidates.push(path.join(root, version, 'bin', 'node'))
  }

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' })
    if (probe.status === 0) return candidate
  }
  return null
}

/* -------------------------------------------------------------------- icons */

const SVG_NS = 'http://www.w3.org/2000/svg'

function svg(tag, attrs = {}, parent = null) {
  const el = document.createElementNS(SVG_NS, tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== null && value !== undefined) el.setAttribute(key, String(value))
  }
  if (parent) parent.appendChild(el)
  return el
}

/** Every glyph on the same 24-unit grid in `currentColor`, as the library draws
 *  them — so they inherit size and colour from whatever they sit in. */
function icon(size, paths) {
  const root = svg('svg', {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    focusable: 'false',
  })
  for (const spec of paths) svg(spec.tag ?? 'path', spec, root)
  return root
}

const Icons = {
  speaker: (size = 16) =>
    icon(size, [
      { d: 'M11 5 6 9H2v6h4l5 4z' },
      { d: 'M15.5 8.5a5 5 0 0 1 0 7' },
      { d: 'M19 5a9 9 0 0 1 0 14' },
    ]),
  play: (size = 16) => icon(size, [{ d: 'M6 4.5 19 12 6 19.5z', fill: 'currentColor', 'stroke-width': '1.5' }]),
  pause: (size = 16) => icon(size, [{ d: 'M8 5v14M16 5v14' }]),
  close: (size = 16) => icon(size, [{ d: 'M6 6l12 12M18 6 6 18' }]),
  chevron: (size = 14) => icon(size, [{ d: 'm6 9 6 6 6-6' }]),

  /** Arc plus a number — the convention every podcast player uses, and it beats
   *  a bare chevron for "how far does this jump?". The arc is drawn pointing
   *  forwards, so it is the *back* variant that goes unmirrored. */
  skip(seconds = 10, back = false, size = 22) {
    const root = icon(size, [])
    const group = svg('g', back ? {} : { transform: 'scale(-1,1) translate(-24,0)' }, root)
    svg('path', { d: 'M4 12a8 8 0 1 0 2.6-5.9' }, group)
    svg('path', { d: 'M4 3.5V8h4.5' }, group)
    const text = svg(
      'text',
      {
        x: '12',
        y: '15.5',
        'text-anchor': 'middle',
        'font-size': '8',
        'font-weight': '700',
        fill: 'currentColor',
        stroke: 'none',
      },
      root,
    )
    text.textContent = String(seconds)
    return root
  },
}

/** Three dots, not a spinner: a spinner implies a duration we do not know.
 *  Animated in the library's CSS, which respects prefers-reduced-motion. */
function loadingDots(parent, size) {
  const wrap = parent.createSpan({ cls: 'ra-dots' })
  wrap.style.width = `${size}px`
  wrap.style.height = `${size}px`
  wrap.createSpan()
  wrap.createSpan()
  wrap.createSpan()
  return wrap
}

const RING = { mini: { size: 34, stroke: 2, glyph: 12 }, control: { size: 54, stroke: 2.5, glyph: 20 } }

/**
 * A circle that fills as the passage is read.
 *
 * Used twice, and that is the point. Collapsed it *is* the player: a 34px ring
 * answering the only question you have while listening. Expanded, the same ring
 * is the card's play button, in the same place — so the card reads as unfolding
 * around the control that was already there.
 */
function progressRing(parent, { progress, status, variant }) {
  const { size, stroke, glyph } = RING[variant]
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius

  const wrap = parent.createSpan({ cls: `ra-player__ring ra-player__ring--${variant}` })
  wrap.setAttribute('aria-hidden', 'true')

  const root = svg('svg', { width: size, height: size, viewBox: `0 0 ${size} ${size}` })
  wrap.appendChild(root)
  svg(
    'circle',
    { cx: size / 2, cy: size / 2, r: radius, fill: 'none', stroke: 'currentColor', 'stroke-opacity': 0.18, 'stroke-width': stroke },
    root,
  )
  svg(
    'circle',
    {
      cx: size / 2,
      cy: size / 2,
      r: radius,
      fill: 'none',
      stroke: 'var(--ra-accent)',
      'stroke-width': stroke,
      'stroke-linecap': 'round',
      'stroke-dasharray': circumference,
      'stroke-dashoffset': circumference * (1 - progress),
      transform: `rotate(-90 ${size / 2} ${size / 2})`,
      class: 'ra-player__ring-fill',
    },
    root,
  )

  const glyphWrap = wrap.createSpan({ cls: 'ra-player__ring-glyph' })
  if (status === 'preparing') loadingDots(glyphWrap, glyph)
  else glyphWrap.appendChild(status === 'playing' ? Icons.pause(glyph) : Icons.play(glyph))
  return wrap
}

/* ------------------------------------------------------------------ sidecar */

class Sidecar {
  constructor(plugin) {
    this.plugin = plugin
    this.child = null
    this.starting = null
    this.origin = null
    this.basePath = '/api/read-aloud'
  }

  /** Idempotent. Resolves to the origin, e.g. `http://127.0.0.1:53401`. */
  start() {
    if (this.origin) return Promise.resolve(this.origin)
    if (this.starting) return this.starting

    const { libPath, nodePath, voice } = this.plugin.settings
    const cacheDir = path.join(this.plugin.cacheRoot(), 'clips')
    const script = path.join(this.plugin.dir(), 'sidecar.cjs')

    const runtime = nodePath || resolveNode()
    if (!runtime) {
      return Promise.reject(
        new Error('no node binary found. Install node, or set an absolute path in Read Aloud settings.'),
      )
    }

    this.starting = new Promise((resolve, reject) => {
      let child
      try {
        child = spawn(runtime, [script, libPath, cacheDir, voice], {
          // The fourth pipe is fd 3, the handshake channel. Obsidian logs its
          // own lines to the child's stdout, so stdout cannot carry a protocol.
          stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
          env: { ...process.env },
        })
      } catch (err) {
        return reject(new Error(`could not start the runtime (${runtime}): ${err.message}`))
      }
      this.child = child

      // Everything the child said, kept so a failure can explain itself. A bare
      // "did not come up within 20s" sends you reading logs you do not have.
      const said = []
      let settled = false

      const timer = setTimeout(() => {
        const tail = said.join('\n').trim().slice(-600)
        reject(
          new Error(
            tail
              ? `the service did not come up within 20s. It said: ${tail}`
              : `the service did not come up within 20s and printed nothing. Runtime: ${runtime}`,
          ),
        )
        this.stop()
      }, 20_000)

      const accept = (line) => {
        let hello
        try {
          hello = JSON.parse(line)
        } catch (err) {
          return false
        }
        if (!hello?.ready || settled) return false
        settled = true
        clearTimeout(timer)
        this.origin = `http://127.0.0.1:${hello.port}`
        this.basePath = hello.basePath || this.basePath
        resolve(this.origin)
        return true
      }

      let buffered = ''
      child.stdio[3]?.on('data', (chunk) => {
        buffered += chunk.toString()
        let cut = buffered.indexOf('\n')
        while (cut !== -1) {
          accept(buffered.slice(0, cut).trim())
          buffered = buffered.slice(cut + 1)
          cut = buffered.indexOf('\n')
        }
      })

      // stdout and stderr are logs. The exception: if fd 3 was unavailable the
      // sidecar falls back to stdout, so a handshake seen there is still
      // honoured rather than waiting out the full timeout.
      const log = (chunk) => {
        for (const line of chunk.toString().split('\n')) {
          const text = line.trim()
          if (!text) continue
          if (!settled && text.startsWith('{') && accept(text)) continue
          if (!settled) said.push(text)
          console.log(`[read-aloud] ${text}`)
        }
      }
      child.stdout.on('data', log)
      child.stderr.on('data', log)

      child.on('error', (err) => {
        clearTimeout(timer)
        reject(new Error(`the runtime failed to run (${runtime}): ${err.message}`))
      })
      child.on('exit', (code, signal) => {
        this.child = null
        this.origin = null
        this.starting = null
        if (code) console.log(`[read-aloud] service exited with code ${code}`)
        if (!settled) {
          clearTimeout(timer)
          const tail = said.join('\n').trim().slice(-600)
          reject(
            new Error(`the service exited (${signal || `code ${code}`}) before it was ready${tail ? `: ${tail}` : ''}`),
          )
        }
      })
    })

    this.starting.catch(() => {
      this.starting = null
    })
    return this.starting
  }

  stop() {
    if (!this.child) return
    const child = this.child
    this.child = null
    this.origin = null
    this.starting = null
    // Closing stdin is the polite exit the sidecar listens for; SIGTERM is the
    // backstop, because the warm model can be mid-render.
    try {
      child.stdin.end()
    } catch (err) {
      /* already gone */
    }
    const kill = setTimeout(() => child.kill('SIGKILL'), 3000)
    kill.unref?.()
    child.once('exit', () => clearTimeout(kill))
    child.kill('SIGTERM')
  }

  /**
   * `requestUrl` rather than `fetch`, for both directions: it goes through
   * Obsidian's own network stack, so neither the renderer's CSP nor CORS has an
   * opinion about a loopback port.
   */
  async json(method, urlPath, body) {
    const origin = await this.start()
    const response = await requestUrl({
      url: `${origin}${urlPath}`,
      method,
      contentType: body ? 'application/json' : undefined,
      body: body ? JSON.stringify(body) : undefined,
      throw: false,
    })
    if (response.status >= 400) throw new Error(response.json?.error || `HTTP ${response.status}`)
    return response.json
  }

  /** A clip as an object URL. The service *waits* for a segment that is still
   *  queued or rendering rather than 404ing, which is what makes the next
   *  segment requestable before it exists. */
  async clip(urlPath) {
    const origin = await this.start()
    const response = await requestUrl({ url: `${origin}${urlPath}`, throw: false })
    if (response.status >= 400) throw new Error(`clip unavailable (HTTP ${response.status})`)
    return URL.createObjectURL(new Blob([response.arrayBuffer], { type: 'audio/wav' }))
  }
}

/* ------------------------------------------------------------------- player */

class Player {
  constructor(plugin) {
    this.plugin = plugin
    this.audio = new Audio()
    this.audio.preload = 'auto'
    this.segments = []
    this.index = 0
    this.title = ''
    this.error = null
    this.preparing = false
    this.token = 0

    this.root = null
    this.expanded = false
    this.pinned = false
    this.closeTimer = null
    this.scrubbing = false

    this.audio.addEventListener('timeupdate', () => this.paint())
    this.audio.addEventListener('loadedmetadata', () => {
      const segment = this.segments[this.index]
      if (segment && Number.isFinite(this.audio.duration)) {
        segment.seconds = this.audio.duration
        segment.exact = true
      }
      this.paint()
    })
    this.audio.addEventListener('ended', () => this.next())
    this.audio.addEventListener('play', () => this.render())
    this.audio.addEventListener('pause', () => this.render())
  }

  /* ---- state */

  get status() {
    if (this.error) return 'error'
    if (this.preparing) return 'preparing'
    if (!this.segments.length) return 'idle'
    if (!this.audio.paused) return 'playing'
    if (this.index === this.segments.length - 1 && this.audio.ended) return 'ended'
    return 'paused'
  }

  get durations() {
    return this.segments.map((s) => (s.exact ? s.seconds : (s.seconds ?? estimateSeconds(s.chars))))
  }

  get total() {
    return this.durations.reduce((sum, n) => sum + n, 0)
  }

  get estimated() {
    return this.segments.some((s) => !s.exact)
  }

  get elapsed() {
    const offset = this.durations.slice(0, this.index).reduce((sum, n) => sum + n, 0)
    return offset + (this.audio.currentTime || 0)
  }

  get progress() {
    const total = this.total
    return total > 0 ? Math.min(1, this.elapsed / total) : 0
  }

  /* ---- transport */

  async speak({ text, title, headingEl }) {
    const body = String(text ?? '').trim()
    if (!body) {
      new Notice('Read aloud: nothing to read here.')
      return
    }

    const token = ++this.token
    this.stopAudio()
    // Kept so changing the voice can re-speak what you were listening to.
    this.lastPassage = { text: body, title, headingEl }
    this.title = title || 'Passage'
    this.error = null
    this.preparing = true
    this.markHeading(headingEl ?? null)
    // Every new passage starts collapsed, like the library's player: otherwise
    // opening the card once means every later button pops a card into the
    // corner instead of the quiet ring.
    this.expanded = false
    this.pinned = false
    this.render()

    try {
      const data = await this.plugin.sidecar.json('POST', this.plugin.sidecar.basePath, {
        text: body,
        voice: this.plugin.settings.voice,
        // What makes a long note start on its first sentence rather than after
        // the whole thing renders. Without it there is no `segments` array.
        segment: true,
      })
      if (token !== this.token) return
      this.segments = (data.segments || []).map((s) => ({ ...s, exact: Number.isFinite(s.seconds) }))
      if (!this.segments.length) throw new Error('the service returned no audio')
      console.log(`[read-aloud] ${this.segments.length} segment(s), voice ${data.voice}`)
      await this.playSegment(0, 0, token)
    } catch (err) {
      if (token !== this.token) return
      this.preparing = false
      this.error = err.message
      this.render()
      new Notice(`Read aloud: ${err.message}`)
    }
  }

  async playSegment(index, at, token = this.token) {
    const segment = this.segments[index]
    if (!segment) return
    this.index = index

    try {
      if (!segment.blobUrl) segment.blobUrl = await this.plugin.sidecar.clip(segment.url)
      if (token !== this.token) return
      this.audio.src = segment.blobUrl
      this.audio.playbackRate = this.plugin.settings.rate
      this.audio.currentTime = at || 0
      await this.audio.play()
      this.preparing = false
      this.render()
      this.prefetch(index + 1, token)
    } catch (err) {
      if (token !== this.token) return
      this.preparing = false
      this.error = err.message
      this.render()
    }
  }

  /** Segment two is fetched while segment one plays; the service blocks on a
   *  queued render rather than 404ing, so the gap is inaudible. */
  prefetch(index, token) {
    const segment = this.segments[index]
    if (!segment || segment.blobUrl) return
    this.plugin.sidecar
      .clip(segment.url)
      .then((blobUrl) => {
        if (token === this.token) segment.blobUrl = blobUrl
        else URL.revokeObjectURL(blobUrl)
      })
      .catch(() => {})
  }

  next() {
    if (this.index + 1 < this.segments.length) return this.playSegment(this.index + 1, 0)
    this.render()
    // "Still listening" — restarts the model's idle countdown from the end of
    // playback rather than from render, which is when you are actually done.
    this.plugin.sidecar.json('POST', `${this.plugin.sidecar.basePath}/warm`).catch(() => {})
  }

  toggle() {
    if (!this.segments.length) return
    if (this.audio.paused) this.audio.play().catch(() => {})
    else this.audio.pause()
  }

  seek(seconds) {
    const durations = this.durations
    let target = Math.max(0, Math.min(seconds, this.total))
    for (let i = 0; i < durations.length; i += 1) {
      if (target < durations[i] || i === durations.length - 1) {
        if (i === this.index) {
          this.audio.currentTime = Math.min(target, this.audio.duration || target)
          return
        }
        return this.playSegment(i, target)
      }
      target -= durations[i]
    }
  }

  skip(delta) {
    this.seek(this.elapsed + delta)
  }

  cycleRate() {
    const rates = this.plugin.settings.rates
    const at = rates.indexOf(this.plugin.settings.rate)
    this.plugin.settings.rate = rates[(at + 1) % rates.length]
    this.plugin.saveSettings()
    this.audio.playbackRate = this.plugin.settings.rate
    this.render()
  }

  async setVoice(voiceId) {
    this.plugin.settings.voice = voiceId
    await this.plugin.saveSettings()
    // The voice is the service's default, baked in at spawn time, so the
    // service has to be restarted for it to take effect.
    const passage = this.lastPassage
    this.stop()
    this.plugin.sidecar.stop()
    this.plugin.warmed = null
    if (passage) this.speak(passage)
  }

  stopAudio() {
    this.audio.pause()
    this.audio.removeAttribute('src')
    for (const segment of this.segments) {
      if (segment.blobUrl) URL.revokeObjectURL(segment.blobUrl)
    }
    this.segments = []
    this.index = 0
  }

  stop() {
    this.token += 1
    this.preparing = false
    this.error = null
    this.stopAudio()
    this.markHeading(null)
    this.root?.remove()
    this.root = null
  }

  /* ---- the heading whose section is playing */

  markHeading(el) {
    this.reading?.removeAttribute('data-reading')
    this.reading = el
    el?.setAttribute('data-reading', 'true')
  }

  /* ---- UI: the library's player, in plain DOM */

  openNow() {
    if (this.closeTimer) clearTimeout(this.closeTimer)
    this.closeTimer = null
    if (!this.expanded) {
      this.expanded = true
      this.render()
    }
  }

  scheduleClose() {
    if (this.closeTimer) clearTimeout(this.closeTimer)
    this.closeTimer = setTimeout(() => {
      this.closeTimer = null
      this.expanded = false
      this.pinned = false
      this.render()
    }, CLOSE_DELAY_MS)
  }

  render() {
    if (this.status === 'idle' && !this.error) {
      this.root?.remove()
      this.root = null
      return
    }

    if (!this.root) {
      this.root = document.body.createDiv({ cls: 'ra-player ra-player--fixed ra-player--end' })
      this.root.setAttribute('role', 'region')
      this.root.setAttribute('aria-label', 'Read aloud player')
      this.root.addEventListener('pointerenter', () => this.openNow())
      this.root.addEventListener('pointerdown', () => {
        this.pinned = true
        this.openNow()
      })
      this.root.addEventListener('pointerleave', () => this.scheduleClose())
      this.root.addEventListener('focusin', () => this.openNow())
      this.root.addEventListener('focusout', (event) => {
        if (!this.root?.contains(event.relatedTarget)) this.scheduleClose()
      })
    }

    const status = this.status
    const expanded = this.expanded || this.pinned
    this.root.setAttribute('data-state', status)
    this.root.setAttribute('data-active', status === 'playing' || status === 'preparing' ? 'true' : 'false')
    this.root.setAttribute('data-expanded', expanded ? 'true' : 'false')
    this.root.empty()

    if (expanded) this.buildCard(status)
    else this.buildCollapsed(status)
    this.paint()
  }

  buildCollapsed(status) {
    const button = this.root.createEl('button', { cls: 'ra-player__collapsed', attr: { type: 'button' } })
    button.setAttribute('aria-expanded', 'false')
    button.setAttribute(
      'aria-label',
      `Read aloud controls — ${Math.round(this.progress * 100)}% through ${this.title}`,
    )
    button.setAttribute('title', this.title)
    // Tapping opens rather than pausing: hover does not exist on a touch
    // screen, and a control that means different things per device is worse
    // than one extra tap. Pause is one press away inside.
    button.onclick = () => {
      this.pinned = true
      this.openNow()
    }
    progressRing(button, { progress: this.progress, status, variant: 'mini' })
  }

  buildCard(status) {
    const preparing = status === 'preparing'
    const card = this.root.createDiv({ cls: 'ra-player__card' })

    const head = card.createDiv({ cls: 'ra-player__head' })
    const title = head.createEl('p', { cls: 'ra-player__title' })
    if (this.error) title.createSpan({ cls: 'ra-player__error', text: this.error })
    else {
      title.setText(this.title)
      title.setAttribute('title', this.title)
    }
    const close = head.createEl('button', { cls: 'ra-player__icon ra-player__close', attr: { type: 'button' } })
    close.setAttribute('aria-label', 'Stop reading')
    close.setAttribute('title', 'Stop reading')
    close.appendChild(Icons.close(15))
    close.onclick = () => this.stop()

    // A real range input: keyboard support, a screen-reader announcement of the
    // position, and the platform's own touch behaviour all come with it.
    this.scrubEl = card.createEl('input', { cls: 'ra-player__scrubber', type: 'range' })
    this.scrubEl.min = '0'
    this.scrubEl.step = '0.1'
    this.scrubEl.disabled = preparing || !this.total
    this.scrubEl.setAttribute('aria-label', 'Playback position')
    this.scrubEl.addEventListener('pointerdown', () => {
      this.scrubbing = true
    })
    const release = () => {
      if (!this.scrubbing) return
      this.scrubbing = false
      this.seek(Number(this.scrubEl.value))
    }
    this.scrubEl.addEventListener('pointerup', release)
    this.scrubEl.addEventListener('change', release)
    this.scrubEl.addEventListener('input', () => this.paintTimes())

    // Elapsed left, total right, under the bar they belong to — where a music
    // player puts them. "0:18 / 0:25" as one string is a stopwatch.
    const times = card.createDiv({ cls: 'ra-player__times' })
    times.setAttribute('aria-hidden', 'true')
    this.elapsedEl = times.createSpan()
    this.totalEl = times.createSpan()

    const transport = card.createDiv({ cls: 'ra-player__transport' })
    const { skipSeconds } = this.plugin.settings

    const back = transport.createEl('button', { cls: 'ra-player__icon', attr: { type: 'button' } })
    back.disabled = preparing || !this.total
    back.setAttribute('aria-label', `Back ${skipSeconds} seconds`)
    back.setAttribute('title', `Back ${skipSeconds}s`)
    back.appendChild(Icons.skip(skipSeconds, true, 22))
    back.onclick = () => this.skip(-skipSeconds)

    const play = transport.createEl('button', { cls: 'ra-player__play', attr: { type: 'button' } })
    play.disabled = preparing || status === 'error'
    play.setAttribute('aria-label', status === 'playing' ? 'Pause' : 'Play')
    play.setAttribute('title', status === 'playing' ? 'Pause' : 'Play')
    progressRing(play, { progress: this.progress, status, variant: 'control' })
    play.onclick = () => this.toggle()

    const forward = transport.createEl('button', { cls: 'ra-player__icon', attr: { type: 'button' } })
    forward.disabled = preparing || !this.total
    forward.setAttribute('aria-label', `Forward ${skipSeconds} seconds`)
    forward.setAttribute('title', `Forward ${skipSeconds}s`)
    forward.appendChild(Icons.skip(skipSeconds, false, 22))
    forward.onclick = () => this.skip(skipSeconds)

    // Settings last and quietest: things you set once and forget.
    const settings = card.createDiv({ cls: 'ra-player__settings' })
    const rateChip = settings.createEl('button', {
      cls: 'ra-player__chip',
      text: `${this.plugin.settings.rate}× speed`,
      attr: { type: 'button' },
    })
    rateChip.setAttribute('title', 'Playback speed')
    rateChip.onclick = () => this.cycleRate()

    const groups = this.plugin.voiceGroups()
    if (groups.length) {
      const wrap = settings.createSpan({ cls: 'ra-player__select' })
      const select = wrap.createEl('select', { cls: 'ra-player__chip ra-player__voice' })
      select.setAttribute('aria-label', 'Voice')
      select.setAttribute('title', 'Voice')
      for (const { group, voices } of groups) {
        const optgroup = select.createEl('optgroup')
        optgroup.label = group
        for (const voice of voices) optgroup.createEl('option', { text: voice.name, value: voice.id })
      }
      select.value = this.plugin.settings.voice
      select.onchange = () => this.setVoice(select.value)
      wrap.appendChild(Icons.chevron(14))
    }
  }

  paintTimes() {
    if (!this.elapsedEl) return
    const shown = this.scrubbing ? Number(this.scrubEl.value) : this.elapsed
    this.elapsedEl.setText(formatTime(shown))
    this.totalEl.setText(`${this.estimated ? '~' : ''}${formatTime(this.total)}`)
    if (this.estimated) this.totalEl.setAttribute('title', 'Estimated — still being generated')
    else this.totalEl.removeAttribute('title')
  }

  /** The cheap per-tick update: progress, times, scrubber. Never rebuilds. */
  paint() {
    if (!this.root) return
    const total = this.total
    const progress = this.progress

    for (const fill of this.root.querySelectorAll('.ra-player__ring-fill')) {
      const radius = Number(fill.getAttribute('r'))
      const circumference = 2 * Math.PI * radius
      fill.setAttribute('stroke-dashoffset', String(circumference * (1 - progress)))
    }

    if (this.scrubEl) {
      this.scrubEl.max = String(total || 0)
      if (!this.scrubbing) this.scrubEl.value = String(Math.min(this.elapsed, total || 0))
      this.scrubEl.style.setProperty('--ra-progress', `${progress * 100}%`)
      this.scrubEl.setAttribute('aria-valuetext', `${formatTime(this.elapsed)} of ${formatTime(total)}`)
    }
    this.paintTimes()
  }
}

/* ------------------------------------------------------------------- plugin */

class ReadAloudPlugin extends (Plugin ?? Object) {
  async onload() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData())
    this.sidecar = new Sidecar(this)
    this.player = new Player(this)
    this.injectStyles()

    this.addCommand({ id: 'note', name: 'Read aloud: note', callback: () => this.speakNote() })
    this.addCommand({
      id: 'selection',
      name: 'Read aloud: selection',
      editorCallback: (editor, view) => this.speakSelection(editor, view),
    })
    this.addCommand({ id: 'stop', name: 'Read aloud: stop', callback: () => this.player.stop() })

    this.registerMarkdownPostProcessor((el, ctx) => this.addHeadingButtons(el, ctx))
    this.addSettingTab(new ReadAloudSettingTab(this.app, this))

    // Warming the *active note* on open, through the same segmented path a play
    // uses, so pressing play is a cache read. Debounced: browsing a vault
    // should not queue a render per note you glance at.
    this.registerEvent(this.app.workspace.on('file-open', () => this.scheduleWarm()))

    // Starting the service now, not on the first click: a cold Kokoro load is
    // ~7.5s, and left until the first click that load *is* the first impression.
    this.sidecar
      .start()
      .then(() => this.sidecar.json('GET', this.sidecar.basePath))
      .then((info) => {
        this.info = info
        if (!info.available) new Notice(`Read aloud: no voices available. ${info.reason ?? ''}`)
        else this.scheduleWarm()
      })
      .catch((err) => console.log(`[read-aloud] service unavailable: ${err.message}`))
  }

  onunload() {
    if (this.warmTimer) clearTimeout(this.warmTimer)
    this.styleEl?.remove()
    this.player?.stop()
    this.sidecar?.stop()
  }

  /**
   * Both stylesheets, read from disk and injected here — including the
   * plugin's own.
   *
   * The library's stylesheet is read from disk rather than copied for the
   * reason above. The plugin's own styles.css is injected for the reason the
   * sidecar exists: Obsidian loads plugin CSS through its vault adapter, and
   * that adapter does not follow a plugin directory that is a symlink into a
   * git checkout — the stylesheet is skipped silently (no error, no console
   * line), and the player falls back to raw browser chrome: tall unstyled
   * heading buttons, filled transport buttons, a 100px scrubber. Node's own
   * fs follows the symlink, and the rules are identical either way, so this
   * is belt and suspenders: if Obsidian does load styles.css natively the
   * same rules apply twice and nothing changes.
   */
  injectStyles() {
    const parts = []
    try {
      // manifest.dir is the plugin's own folder as Obsidian resolved it (it
      // uses the same path for loadData), so this is correct even when the
      // folder is a symlink into a git checkout.
      const dir = this.manifest.dir ?? this.dir()
      parts.push(fs.readFileSync(path.join(dir, 'styles.css'), 'utf8'))
    } catch (err) {
      console.log(`[read-aloud] could not read the plugin stylesheet: ${err.message}`)
    }
    const cssPath = path.join(this.settings.libPath, 'src', 'style.css')
    try {
      parts.push(fs.readFileSync(cssPath, 'utf8'))
    } catch (err) {
      console.log(`[read-aloud] could not read the player stylesheet at ${cssPath}: ${err.message}`)
      new Notice('Read aloud: the player stylesheet is missing — check the library path in settings.')
    }
    this.styleEl?.remove()
    if (!parts.length) return
    this.styleEl = document.head.createEl('style', { attr: { 'data-read-aloud': 'all' } })
    this.styleEl.setText(parts.join('\n'))
  }

  dir() {
    return path.join(
      this.app.vault.adapter.getBasePath(),
      this.app.vault.configDir,
      'plugins',
      this.manifest.id,
    )
  }

  /** Clips live outside the vault: they are regenerable bytes, and a sync
   *  plugin has no business carrying wav files between machines. */
  cacheRoot() {
    return path.join(os.homedir(), '.cache', 'read-aloud', 'obsidian')
  }

  async saveSettings() {
    await this.saveData(this.settings)
  }

  /** Voices grouped for a picker, as the library groups them. */
  voiceGroups() {
    const voices = this.info?.voices ?? []
    const groups = new Map()
    for (const voice of voices) {
      if (!groups.has(voice.group)) groups.set(voice.group, [])
      groups.get(voice.group).push(voice)
    }
    return [...groups].map(([group, list]) => ({ group, voices: list }))
  }

  /* ---- warming */

  scheduleWarm() {
    if (!this.settings.warmOnOpen) return
    if (this.warmTimer) clearTimeout(this.warmTimer)
    this.warmTimer = setTimeout(() => this.warmActive(), 1500)
  }

  async warmActive() {
    const file = this.app.workspace.getActiveFile()
    if (!file || file.extension !== 'md' || !this.sidecar.origin) return
    if (this.warmed === file.path) return
    this.warmed = file.path
    try {
      const text = await this.app.vault.cachedRead(file)
      if (!text.trim()) return
      // `segment: true` matters: a segmented play hashes each part separately,
      // so warming without it renders a whole-passage clip under a key the
      // player never asks for — full cost, and you still wait.
      await this.sidecar.json('POST', this.sidecar.basePath, {
        text,
        voice: this.settings.voice,
        segment: true,
      })
      console.log(`[read-aloud] warmed ${file.basename}`)
    } catch (err) {
      console.log(`[read-aloud] warm failed: ${err.message}`)
    }
  }

  /* ---- the three entry points */

  async speakNote() {
    const file = this.app.workspace.getActiveFile()
    if (!file) return new Notice('Read aloud: no note is open.')
    const text = await this.app.vault.cachedRead(file)
    this.player.speak({ text, title: file.basename })
  }

  speakSelection(editor, view) {
    const selection = editor.getSelection()
    if (!selection.trim()) return new Notice('Read aloud: nothing selected.')
    this.player.speak({ text: selection, title: `Selection — ${view.file?.basename ?? ''}` })
  }

  addHeadingButtons(el, ctx) {
    if (!this.settings.headingButtons) return
    const headings = el.matches?.('h1,h2,h3,h4,h5,h6')
      ? [el]
      : Array.from(el.querySelectorAll('h1,h2,h3,h4,h5,h6'))
    for (const heading of headings) {
      if (heading.querySelector('.read-aloud-heading-btn')) continue
      const button = heading.createEl('button', { cls: 'read-aloud-heading-btn', attr: { type: 'button' } })
      button.appendChild(Icons.speaker(14))
      button.setAttribute('aria-label', 'Read this section aloud')
      button.onclick = (event) => {
        event.preventDefault()
        event.stopPropagation()
        const section = ctx.getSectionInfo(heading)
        if (!section) return new Notice('Read aloud: cannot locate this section in the source.')
        const lines = section.text.split('\n')
        const [start, end] = sectionRange(lines, section.lineStart)
        this.player.speak({
          text: lines.slice(start, end).join('\n'),
          title: heading.textContent.trim(),
          headingEl: button,
        })
      }
    }
  }
}

/* ----------------------------------------------------------------- settings */

class ReadAloudSettingTab extends (PluginSettingTab ?? Object) {
  constructor(app, plugin) {
    super(app, plugin)
    this.plugin = plugin
  }

  display() {
    const { containerEl } = this
    containerEl.empty()

    new Setting(containerEl)
      .setName('Voice')
      .setDesc('Engine-qualified, e.g. kokoro:bm_george or say:Karen.')
      .addDropdown((dropdown) => {
        const groups = this.plugin.voiceGroups()
        if (!groups.length) dropdown.addOption(this.plugin.settings.voice, this.plugin.settings.voice)
        for (const { group, voices } of groups) {
          for (const voice of voices) dropdown.addOption(voice.id, `${group} — ${voice.name}`)
        }
        dropdown.setValue(this.plugin.settings.voice).onChange((value) => this.plugin.player.setVoice(value))
      })

    new Setting(containerEl)
      .setName('Pre-render the note you open')
      .setDesc('Renders the open note in the background so pressing play is instant. Costs GPU time on notes you never play.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.warmOnOpen).onChange(async (value) => {
          this.plugin.settings.warmOnOpen = value
          await this.plugin.saveSettings()
        }),
      )

    new Setting(containerEl)
      .setName('Speaker button on every heading')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.headingButtons).onChange(async (value) => {
          this.plugin.settings.headingButtons = value
          await this.plugin.saveSettings()
        }),
      )

    new Setting(containerEl).setName('Skip seconds').addText((text) =>
      text.setValue(String(this.plugin.settings.skipSeconds)).onChange(async (value) => {
        this.plugin.settings.skipSeconds = Number(value) || 10
        await this.plugin.saveSettings()
      }),
    )

    new Setting(containerEl)
      .setName('Library path')
      .setDesc('Unpacked clone of athanor-code/read-aloud. Not bundled: its normalizer and stylesheet are read from disk.')
      .addText((text) =>
        text.setValue(this.plugin.settings.libPath).onChange(async (value) => {
          this.plugin.settings.libPath = value
          await this.plugin.saveSettings()
          this.plugin.injectStyles()
          this.plugin.sidecar.stop()
        }),
      )

    new Setting(containerEl)
      .setName('Node binary')
      .setDesc(
        `Leave empty to auto-detect. Currently: ${this.plugin.settings.nodePath || resolveNode() || 'nothing found — set a path'}`,
      )
      .addText((text) =>
        text
          .setPlaceholder('auto-detect')
          .setValue(this.plugin.settings.nodePath)
          .onChange(async (value) => {
            this.plugin.settings.nodePath = value.trim()
            await this.plugin.saveSettings()
            this.plugin.sidecar.stop()
          }),
      )
  }
}

module.exports = ReadAloudPlugin
// Exposed for test.mjs — the pure bits, which are the only bits worth a test.
module.exports.sectionRange = sectionRange
module.exports.estimateSeconds = estimateSeconds
module.exports.formatTime = formatTime
module.exports.resolveNode = resolveNode
