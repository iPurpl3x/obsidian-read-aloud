# Obsidian Read Aloud

Speaks the note you are looking at, with a neural voice that never leaves the machine.

Three ways in: the whole note, the current selection, or a speaker button on any heading
that reads just that section. A note you open is rendered in the background, so pressing
play is a cache read rather than a wait.

Built on [`athanor-code/read-aloud`](https://github.com/athanor-code/read-aloud) — the same
library, player and stylesheet used in the web apps, so the widget and its theming are
shared rather than reimplemented.

## Requirements

| | |
| --- | --- |
| macOS | The `say` engine is macOS-only; the neural engine is Apple Silicon only (MLX). |
| Node | Any recent version. Resolved automatically from homebrew, asdf, nvm, mise or volta. |
| Python | Installed once by the library's setup script into `~/.cache/read-aloud/venv`. |
| Desktop Obsidian | Needs `child_process`. There is no mobile support. |

## Install

### 1. The library

The plugin does not bundle it. The library's normalizer and stylesheet are read from disk,
so it has to exist unpacked:

```sh
git clone https://github.com/athanor-code/read-aloud.git ~/.local/share/read-aloud
cd ~/.local/share/read-aloud && node scripts/setup.mjs
```

`setup.mjs` creates `~/.cache/read-aloud/venv` with `mlx-audio`, `misaki[en]` and spacy's
`en_core_web_sm`. It is shared by every app on the machine that uses the library. The
Kokoro model itself (~350 MB) downloads on first use.

Any other location works — set it under **Library path** in the plugin's settings.

### 2. The plugin

**Manually.** Copy `main.js`, `manifest.json`, `styles.css` and `sidecar.cjs` into
`<vault>/.obsidian/plugins/read-aloud/`, then enable *Read Aloud* under
Settings → Community plugins.

**With [BRAT](https://github.com/TfTHacker/obsidian42-brat).** Add
`athanor-code/obsidian-read-aloud` as a beta plugin. BRAT authenticates as you against
GitHub, so this only works while you have access to the repository — it cannot install
from a private repository on someone else's behalf.

There is no build step. `main.js` is committed as it runs.

## Use

| Command | Does |
| --- | --- |
| `Read aloud: note` | Speaks the active note. |
| `Read aloud: selection` | Speaks the selection in the active editor. |
| `Read aloud: stop` | Stops and clears the player. |

In reading view every heading carries a speaker button that reads that heading and
everything beneath it, stopping before the next heading of the same or higher level.

The player is a filling ring in the corner. Hover, focus or tap it for the transport:
scrubber, ±10 s, speed, and the voice picker.

## Settings

| Setting | Default | |
| --- | --- | --- |
| Voice | `kokoro:bm_george` | Engine-qualified. Changing it restarts the service. |
| Pre-render the note you open | on | Costs GPU time on notes you never play. |
| Speaker button on every heading | on | |
| Skip seconds | 10 | |
| Library path | `~/.local/share/read-aloud` | |
| Node binary | auto-detect | An absolute path overrides detection. |

## How it works

```
 command / heading button
        │  POST {text, segment:true}
        ▼
 plugin ──── requestUrl ────►  node sidecar (127.0.0.1)
        ◄─── {segments[]} ───   createReadAloudService
                                      │
                        normalizer (python) ─► markdown to prose
                                      │
                               kokoro worker (warm)
```

The service runs in a child `node` process rather than inside Obsidian. That keeps the
library's file layout intact — it resolves its Python scripts and its stylesheet relative
to its own source — and puts the ~1.5 GB warm model in a process the plugin can kill. It
exits when Obsidian does.

Clips are content-addressed and cached in `~/.cache/read-aloud/obsidian`, outside the
vault: they are regenerable bytes, and a sync plugin has no reason to carry them between
machines.

A long passage is cut at sentence boundaries and starts playing on the first segment while
the rest render behind it.

## Limits

- No word-level highlighting. A clip is one file with no boundary events.
- Not a streaming API. Each segment is rendered fully before it plays.
- Markdown only. Non-markdown files are ignored by the pre-render.

## Development

```sh
node test.mjs   # section extraction, estimates, time formatting
```

## License

MIT
