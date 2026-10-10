# Auto-Tuner for FeedBack

Shifts the song's pitch live, with tempo unchanged, so your guitar can stay in its
tuning. An Eb Standard song can play in E Standard, a Drop C# song in Drop D, or
a song can come down a half step to match a guitar you keep in Eb. Note detection
and the highway follow the shift, so scoring still works. Your song files are
never modified.

- Plugin ID: `autotune`
- Category: `audio`
- Minimum FeedBack: the first release after `0.3.0-alpha.1` (`minHost: 0.3.0-alpha.2`)
- License: MIT

## Features

- **TUNE control** in the player's plugin controls (the v3 "Plugins" rail
  popover). It shows the current shift, e.g. `TUNE −1 st`.
- **Semitone presets**, +2 to −5. Each preset is labelled with the tuning the
  song will sound in (for an E Standard song, "Eb Standard −1 st", "D Standard
  −2 st", and so on).
- **Cent control**: ±1 cent and ±1 semitone steps, or type any value from −1200
  to +1200 cents. Useful for recordings that aren't at A440, or a guitar you keep
  slightly flat.
- **Auto mode** (off by default): every song is shifted into your tuning family.
  Set "My tuning" once (E Standard by default).
  - Any Standard tuning moves to your Standard (Eb, D, C# Standard → E Standard).
  - Any Drop tuning moves to your Drop tuning (Drop C#, Drop C → Drop D). Tune
    only the low string.
  - The chart's own reference offset is corrected as well (an A=443 recording is
    pulled back by about 12 cents).
  - Open and custom tunings can't be matched with one shift, so they are left
    alone, and the popover tells you why.
- **Per-song memory**: a shift you set by hand is saved for that song and always
  wins over auto. "Back to auto" (or `\`) clears it.
- **Tuning badge**: while a shift is active, a line under the HUD tuning reads
  "Playing as Eb Standard (−1 st, Auto-Tuner)".
- **Note detection follows**: the shift is published to the core `chart-transform`
  domain as the effective tuning and cent offset. Note Detection (from
  feedBack-plugin-notedetect#72 on) scores against the pitch the audio actually
  plays at. Renderers that read the effective tuning (the 3D highway's string
  labels, for example) show it too.

### Keyboard shortcuts (player)

| Key | Action |
|-----|--------|
| `,` / `.` | Song down / up one semitone |
| `<` / `>` | Song down / up 5 cents |
| `\` | Back to auto (or the original pitch when auto is off) |

Core already uses `[` / `]` (A/V offset) and `-` / `+` (volume), so the plugin
avoids those keys. The shortcuts show up in the `?` help panel.

## How it works

### Audio

FeedBack can play a song through three different paths, and the path can change
during a song (the desktop app moves the song to its native engine when the
output device switches to exclusive or ASIO). The plugin applies the shift to
whichever path is playing:

| Path | When | How the shift is applied |
|------|------|--------------------------|
| Desktop engine | FeedBack Desktop with the song on the JUCE backing player (`window._juceMode`) | `window.feedBackDesktop.audio.setBackingPitch(semitones)` (fractional semitones, cent precision). The engine uses signalsmith-stretch and corrects the reported playhead for its latency, so the chart stays in sync. |
| Stems | Multi-stem feedpaks/sloppaks played by the Stems plugin (browser, or desktop in shared mode) | The plugin's pitch-shift AudioWorklet is inserted between the stem mix's master bus (`window.feedBack.stems.audioGraph.masterNode`) and the output. |
| Browser audio | Everything else on the core `<audio>` element | The element is routed through the same worklet with a `MediaElementSource`. The plugin shares the one-per-element tap with the 3D highways through `window.__feedBackAudioTap`, so their audio-reactive visuals keep working. |

Whenever the desktop API is present, the native value is set on every song load
(including 0), because the engine keeps the transpose across songs. The browser
worklet is built only the first time a non-zero shift is needed, so with no
shift the plugin never touches the audio graph.

The browser fallback (`assets/pitch-shift-worklet.js`) is an original MIT
time-domain granular shifter: two Hann-windowed read taps at constant overlap-add,
no FFT, fixed CPU per sample. At 0 it passes audio through sample for sample.
It is fine for half steps and whole steps. At larger shifts you will hear some
roughness; the desktop engine sounds better.

### Chart and detection

The plugin registers a `chart-transform` provider (feedBack#952). The transform
never changes notes or frets. It returns only:

- `tuning`: the chart's offsets plus the whole semitones of the shift;
- `centOffset`: the chart's own offset plus any leftover cents.

Core exposes these through `highway.getTuning()` / `getCentOffset()` and the
renderer bundle, while `getSongInfo()` keeps the original metadata. Only one
chart-transform provider can be active at a time. The plugin therefore selects
itself only while a shift is active, and at 0 it hands the slot back to whatever
it displaced.

The plugin does not use the old Slopsmith `retune:offset` event.

## Requirements

- FeedBack newer than `0.3.0-alpha.1` (today: current `main`). The plugin needs
  module plugins (`scriptType: "module"`, #812), the `chart-transform` domain
  (#952/#1000) and the v3 player-control slot. Neither of the first two is in the
  `0.3.0-alpha.1` tag, so `minHost` is `0.3.0-alpha.2`.
- **Desktop native path:** a FeedBack Desktop build that includes the backing
  track pitch transpose (`setBackingPitch`, feedBack-desktop#132). On older
  desktop builds, songs on the native engine can't be shifted and the popover
  says so. Songs that play in the renderer (stems in shared mode) still use the
  browser path.
- **Browser / Docker:** any browser with AudioWorklet support. Nothing else to
  install.
- **Note detection following the shift:** feedBack-plugin-notedetect with
  effective-tuning support (#72). Older versions still play the shifted audio
  but score against the chart's original tuning.

## Install

Clone into your FeedBack plugins directory and restart FeedBack:

```bash
git clone https://github.com/mattromano/feedBack-plugin-autotune autotune
```

On Docker, mount a directory and point `FEEDBACK_PLUGINS_DIR` at it. On desktop,
use the app's user plugins folder. The folder name must be `autotune` (the
plugin id).

## Relation to Retune (feedBack#1081)

The two plugins do different jobs and work fine side by side:

- **Retune** converts a feedpak **offline**. It writes a new pack with
  pitch-shifted audio (rubberband) and re-fretted charts, e.g. a real Drop D
  chart made from a Drop C# song. Use it when you want a permanent converted
  copy, or when the chart itself has to change (Standard ↔ Drop).
- **Auto-Tuner** is a **live, non-destructive** overlay. It works on every song
  format (archives included), costs nothing on disk, can be changed per song or
  mid-song, and supports cent-level tweaks. The frets stay the same; only the
  pitch you play them at moves.

## Known limitations

- **One chart-transform at a time.** While a shift is active it takes the single
  chart-transform slot. It hands the slot back at 0.
- **Exclusive/ASIO desktop output with stems songs:** the desktop renderer-bus
  feeder captures the stems master bus before the plugin's worklet, so those
  songs play unshifted in that mode. Single-file songs on the native engine are
  shifted natively.
- **Browser `<audio>` capture is permanent** for the page: once routed through
  Web Audio, the element stays routed (a Web Audio rule). If another component
  has captured the element without sharing it, the browser path reports itself
  unavailable rather than breaking playback.
- **Large shifts** (beyond about ±3 semitones) start to sound processed on any
  engine.
- Core's own "Tuning:" HUD line keeps showing the chart's original tuning. The
  plugin's badge under it shows the tuning the song is actually playing in.

## Develop

```bash
npm test          # node --test: tuning math, auto mapping, provider, storage, engine routing, worklet DSP
```

To try it locally, run core FeedBack with `FEEDBACK_PLUGINS_DIR` pointing at a
folder that contains this repo as `autotune/`.

Storage keys, all in `localStorage`:

- `autotune.song.<hash>`: per-song manual shift in cents;
- `autotune.auto`: auto mode on/off;
- `autotune.home`: your tuning.

Shifts saved by the earlier Slopsmith build of this plugin (`autotune.<hash>`,
in semitones) are migrated on first read.

## License

[MIT](LICENSE)
