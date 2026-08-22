# Install Read Aloud on a fresh Mac

Step-by-step guide for installing the Obsidian **Read Aloud** plugin and its
neural TTS library on a new machine. Written to be run by an agent on the
target computer — every command is copy-pasteable, and a checklist is included
so you can verify the result.

## What you end up with

| Path | What it is |
| --- | --- |
| `~/.local/share/read-aloud` | The library (`athanor-code/read-aloud`): markdown normalizer, Kokoro voice, and the server the plugin talks to. |
| `<vault>/.obsidian/plugins/read-aloud/` | The plugin (`athanor-code/obsidian-read-aloud`): commands, heading buttons, the player. |
| `~/.cache/read-aloud/` | Python venv + audio clip cache. Regenerable — safe to delete. |

## 0. Prerequisites

- macOS on **Apple Silicon** — the neural voice is MLX-only. On Intel Macs the
  plugin still works using the system `say` voice via the voice picker.
- **Obsidian desktop** installed (community plugins need `child_process`; no
  mobile support).
- **Git**, a recent **Node.js** (≥ 18, any install method), **Python 3**
  (3.10–3.13).
- Access to the `athanor-code` GitHub org — **both repos are private**.

## 1. GitHub access

Both repos are private, so authenticate first:

```sh
gh auth login
# or: set up an SSH key and use the git@github.com: URLs below
```

Sanity check (should succeed):

```sh
git ls-remote git@github.com:athanor-code/read-aloud.git
```

## 2. Install the library

```sh
git clone git@github.com:athanor-code/read-aloud.git ~/.local/share/read-aloud
cd ~/.local/share/read-aloud
node scripts/setup.mjs
```

`setup.mjs` creates `~/.cache/read-aloud/venv` and installs `mlx-audio`,
`misaki[en]` and spacy's `en_core_web_sm` model. The ~350 MB Kokoro model
downloads on **first use**, not during setup.

## 3. Install the plugin

**Option A — manual copy (no tokens, no BRAT):**

```sh
git clone git@github.com:athanor-code/obsidian-read-aloud.git /tmp/ora
mkdir -p "<vault>/.obsidian/plugins/read-aloud"
cp /tmp/ora/main.js /tmp/ora/manifest.json /tmp/ora/styles.css /tmp/ora/sidecar.cjs \
  "<vault>/.obsidian/plugins/read-aloud/"
```

(`<vault>` = the Obsidian vault folder, e.g. `~/Nexus`. Adjust if the vault
lives elsewhere, e.g. an iCloud folder.)

**Option B — BRAT:** add `athanor-code/obsidian-read-aloud` as a beta plugin.
Because the repo is private, BRAT needs a GitHub personal access token
(`repo` scope) in its settings first — it authenticates as you.

Then in Obsidian: Settings → Community plugins → turn off **Restricted mode**
if prompted → enable **Read Aloud**.

## 4. First run

1. Open any markdown note and run the command palette → **Read aloud: note**.
2. The player appears bottom-right. First playback is slow (model load + first
   render): up to ~10 s cold; afterwards it is a cache read.
3. If anything fails, open the dev console (Cmd+Option+I) and look for
   `[read-aloud]` messages.

## Verify (run all of these)

- [ ] Settings → Community plugins → Read Aloud shows version **0.1.1** or newer.
- [ ] Command palette has *Read aloud: note*, *Read aloud: selection*,
      *Read aloud: stop*.
- [ ] In reading view, every heading has a small speaker button; clicking one
      reads that section.
- [ ] A long note plays across segments without stopping (no mid-playback
      drop) — this is the queued-segment fix, present only on `dad72e8`+.
- [ ] The player's speed chip has padding (text not flush to the pill edge),
      the scrubber spans the card, and the handle sits centered on its bar.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Sidecar fails with `spawn node ENOENT` | Obsidian launched from Finder has `PATH=/usr/bin:/bin`. Set an absolute path in plugin settings → **Node binary** (e.g. `/opt/homebrew/bin/node`), or install Node via Homebrew. |
| First play dies with "No virtual environment found" | spacy model missing. Run `VIRTUAL_ENV=$HOME/.cache/read-aloud/venv $HOME/.cache/read-aloud/venv/bin/python -m spacy download en_core_web_sm`, then restart Obsidian. |
| Player says "no voices available" | Kokoro needs Apple Silicon + the MLX packages from setup. Re-run `node scripts/setup.mjs`. The `say` voice remains available via the voice picker. |
| Playback stops mid-passage | Library is an old version. `cd ~/.local/share/read-aloud && git pull && node scripts/setup.mjs`, then restart Obsidian. |
| Player looks unstyled (tall buttons, 100px scrubber) | The plugin folder is missing `styles.css` or Obsidian hasn't reloaded. Re-copy the plugin files and restart Obsidian. |
| Wrong version / stale behaviour after editing | Obsidian scans **every** folder under `.obsidian/plugins/` and indexes by plugin id — a leftover duplicate folder (e.g. a backup) shadows the real one. Keep exactly one. |

## Updating

```sh
cd ~/.local/share/read-aloud && git pull && node scripts/setup.mjs
# then re-copy the plugin files (step 3A) or update via BRAT
```

## Notes for agents

- The plugin is **not bundled**: it reads the library's normalizer and
  stylesheet from `~/.local/share/read-aloud` at runtime. Don't move the
  library after install without updating the plugin's **Library path** setting.
- There is **no build step** — the plugin's `main.js` is hand-written CommonJS
  and runs exactly as committed.
- Clips are content-addressed and cached in `~/.cache/read-aloud/obsidian`,
  deliberately outside the vault (regenerable bytes; a sync plugin has no
  business carrying them).
