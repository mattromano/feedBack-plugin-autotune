// Tuning math for the Auto-Tuner. Pure functions only (no DOM, no window), so
// the node --test suite can import this file directly.
//
// Vocabulary:
//   - A *tuning* is the chart's per-string semitone offsets from the standard
//     base (E standard for guitar/bass), e.g. Eb Standard = [-1,-1,-1,-1,-1,-1].
//   - A *shift* is how far the plugin moves the song's audio, in cents
//     (100 cents = 1 semitone). Positive = higher.
//   - The *effective* tuning is what the song sounds like after the shift:
//     the original offsets plus the whole semitones of the shift, with any
//     sub-semitone remainder carried as a reference-pitch `centOffset`.

export const MIN_CENTS = -1200;
export const MAX_CENTS = 1200;

// Note names indexed by semitones above E, spelled the way core's
// tuning-display helper spells them (Eb, C#, Bb...).
const NOTE_FROM_E = ['E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B', 'C', 'C#', 'D', 'Eb'];

const mod12 = (n) => ((n % 12) + 12) % 12;

// Clamp to the supported range and round to a whole cent (the desktop engine
// also rounds to cents). Non-numeric input is 0, i.e. no shift.
export function clampCents(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    const c = Math.round(Math.max(MIN_CENTS, Math.min(MAX_CENTS, n)));
    return Object.is(c, -0) ? 0 : c;
}

// Split a shift into whole semitones (nearest) plus the cent remainder, so
// that semitones * 100 + cents === shift and |cents| <= 50.
export function splitCents(cents) {
    const c = Number(cents) || 0;
    const semitones = Math.round(c / 100);
    const rest = c - semitones * 100;
    return { semitones: semitones || 0, cents: Math.abs(rest) < 1e-9 ? 0 : rest };
}

// Drop whole octaves from a reference-pitch offset. An extended-range bass
// chart carries centOffset -1200; that is an octave, not a detune.
export function foldOctaves(cents) {
    const c = Number(cents);
    if (!Number.isFinite(c)) return 0;
    const r = c - 1200 * Math.round(c / 1200);
    return Math.abs(r) < 1e-6 ? 0 : r;
}

// "E", "Eb", "D"... for a uniform offset from E.
export function noteName(offset) {
    return NOTE_FROM_E[mod12(Math.round(Number(offset) || 0))];
}

// Name a tuning the same way core's tuning-display helper does (Standard
// family, Drop family, a few named open tunings, else "Custom Tuning"). The
// plugin prefers window.displayTuningName at runtime; this is the fallback
// and what the tests exercise.
export function tuningName(offsets) {
    if (!Array.isArray(offsets) || !offsets.length) return '';
    const o = offsets.map((v) => Math.round(Number(v) || 0));
    if (o.length >= 4 && o.every((v) => v === o[0])) return noteName(o[0]) + ' Standard';
    if (o.length >= 4 && o[0] === o[1] - 2 && o.slice(1).every((v) => v === o[1])) {
        return 'Drop ' + noteName(o[0]);
    }
    const named = {
        '-2,-2,0,0,0,0': 'Double Drop D',
        '0,0,0,-1,0,0': 'Open G',
        '-2,-2,0,0,-2,-2': 'Open D',
        '-2,0,0,0,-2,0': 'DADGAD',
        '0,2,2,1,0,0': 'Open E',
    };
    return (o.length === 6 && named[o.join(',')]) || 'Custom Tuning';
}

// How many entries of the chart's tuning array are real strings. Rocksmith
// bass charts carry 6 offsets of which only the first 4 matter.
export function activeStrings(tuning, { stringCount, isBass } = {}) {
    const len = Array.isArray(tuning) ? tuning.length : 0;
    const sc = Number(stringCount);
    if (Number.isFinite(sc) && sc >= 1) return Math.min(len, Math.trunc(sc));
    return Math.min(len, isBass ? 4 : 6);
}

// Shift every string by the whole semitones of `cents`; carry the remainder
// on the reference pitch. Returns the chart-transform fields, or null for
// "leave the chart alone" (no shift, or no tuning to shift).
export function effectiveTuning(tuning, centOffset, cents) {
    const c = clampCents(cents);
    if (!c || !Array.isArray(tuning) || !tuning.length) return null;
    const { semitones, cents: rest } = splitCents(c);
    const base = Number(centOffset);
    return {
        tuning: tuning.map((v) => (Number(v) || 0) + semitones),
        centOffset: (Number.isFinite(base) ? base : 0) + rest,
    };
}

// The "auto" shift: move the song into the player's tuning family.
//
// `home` is the player's guitar tuning as a uniform offset from E standard
// (0 = E standard, -1 = Eb standard...). A song in any Standard tuning is
// shifted to <home> Standard; a song in any Drop tuning is shifted to Drop
// <home - 2> (Drop D for an E-standard player: tune only the low string).
// The song's own reference pitch (e.g. an A=443 recording, +11.8 cents) is
// corrected too. Open and custom tunings can't be matched by one shift, so
// they stay unshifted.
//
// Returns { cents, kind, from, to }:
//   kind 'standard' | 'drop'  → the shift lands exactly on the home family
//   kind 'mixed'              → upper strings match, the low string is off by
//                               some other amount (shifted, but flagged)
//   kind 'open'               → not shiftable into the family (cents 0)
//   kind 'none'               → no tuning information (cents 0)
export function autoShift(tuning, { centOffset = 0, home = 0, stringCount, isBass } = {}) {
    const n = activeStrings(tuning, { stringCount, isBass });
    if (n < 2) return { cents: 0, kind: 'none', from: '', to: '' };
    const t = tuning.slice(0, n).map((v) => Math.round(Number(v) || 0));
    const from = tuningName(t);
    const upper = t.slice(1);
    if (!upper.every((v) => v === upper[0])) return { cents: 0, kind: 'open', from, to: from };
    const s = upper[0];
    const low = t[0] - s;
    const cents = clampCents((Math.round(Number(home) || 0) - s) * 100 - foldOctaves(centOffset));
    const { semitones } = splitCents(cents);
    const to = tuningName(t.map((v) => v + semitones));
    const kind = low === 0 ? 'standard' : low === -2 ? 'drop' : 'mixed';
    return { cents, kind, from, to };
}

// Which shift is in force: a per-song manual value wins; otherwise the auto
// shift when auto mode is on; otherwise nothing.
export function resolveShift({ manual = null, auto = null, autoEnabled = false } = {}) {
    if (manual !== null && manual !== undefined && Number.isFinite(Number(manual))) {
        return { cents: clampCents(manual), source: 'manual' };
    }
    if (autoEnabled && auto && Number.isFinite(Number(auto.cents))) {
        return { cents: clampCents(auto.cents), source: 'auto' };
    }
    return { cents: 0, source: 'off' };
}

// "+1 st", "−2 st", "+1 st +12¢", "−35¢", "0".
export function formatShift(cents) {
    const c = clampCents(cents);
    if (!c) return '0';
    const sign = (v) => (v > 0 ? '+' : '−');
    const { semitones, cents: rest } = splitCents(c);
    const r = Math.round(rest);
    if (!semitones) return `${sign(r)}${Math.abs(r)}¢`;
    const st = `${sign(semitones)}${Math.abs(semitones)} st`;
    return r ? `${st} ${sign(r)}${Math.abs(r)}¢` : st;
}

// Semitone ratio for a shift in cents (what the worklet / engine apply).
export function pitchRatio(cents) {
    return Math.pow(2, (Number(cents) || 0) / 1200);
}
