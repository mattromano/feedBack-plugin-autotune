# Changelog

## [1.0.0] - Unreleased

First FeedBack release; replaces the Slopsmith-era Auto-Tuner prototype.

- Live pitch shift of the song (semitones and cents, tempo unchanged) on the
  path that is actually playing: the FeedBack Desktop engine
  (`feedBackDesktop.audio.setBackingPitch`), the Stems plugin's master bus, or
  the core `<audio>` element through a bundled AudioWorklet.
- `chart-transform` provider publishing the effective `tuning` / `centOffset`,
  so note detection and tuning-aware renderers follow the shift. The old
  `retune:offset` event is gone.
- Auto mode: shift every song into your tuning family (Standard → your
  Standard, Drop → your Drop), correcting the chart's reference pitch.
- Per-song manual shifts, presets, cent control, HUD tuning badge, player
  shortcuts (`,` `.` `<` `>` `\`), settings panel.
- Prototype per-song offsets (`autotune.<hash>`, semitones) migrate to cents.
