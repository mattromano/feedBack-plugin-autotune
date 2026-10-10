import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    clampCents, splitCents, foldOctaves, noteName, tuningName, activeStrings,
    effectiveTuning, autoShift, resolveShift, formatShift, pitchRatio,
} from '../src/tuning.js';

const std = (n, len = 6) => Array(len).fill(n);

test('clampCents rounds, clamps and treats junk as 0', () => {
    assert.equal(clampCents(99.6), 100);
    assert.equal(clampCents(-5000), -1200);
    assert.equal(clampCents(5000), 1200);
    assert.equal(clampCents('abc'), 0);
    assert.ok(Object.is(clampCents(-0.2), 0));
});

test('splitCents gives whole semitones plus a remainder within 50 cents', () => {
    assert.deepEqual(splitCents(100), { semitones: 1, cents: 0 });
    assert.deepEqual(splitCents(-200), { semitones: -2, cents: 0 });
    assert.deepEqual(splitCents(130), { semitones: 1, cents: 30 });
    assert.deepEqual(splitCents(-170), { semitones: -2, cents: 30 });
    assert.deepEqual(splitCents(-35), { semitones: 0, cents: -35 });
});

test('foldOctaves drops whole octaves (extended-range bass) but keeps detunes', () => {
    assert.equal(foldOctaves(-1200), 0);
    assert.equal(foldOctaves(11.8), 11.8);
    assert.ok(Math.abs(foldOctaves(-1211.8) - -11.8) < 1e-9);
    assert.equal(foldOctaves(NaN), 0);
});

test('pitch ratio is 2^(semitones/12)', () => {
    assert.equal(pitchRatio(0), 1);
    assert.ok(Math.abs(pitchRatio(1200) - 2) < 1e-12);
    assert.ok(Math.abs(pitchRatio(-100) - Math.pow(2, -1 / 12)) < 1e-12);
    assert.ok(Math.abs(pitchRatio(700) - 1.4983070768766815) < 1e-12);
});

test('tuning names match core spelling', () => {
    assert.equal(noteName(-1), 'Eb');
    assert.equal(noteName(-3), 'C#');
    assert.equal(tuningName(std(0)), 'E Standard');
    assert.equal(tuningName(std(-1)), 'Eb Standard');
    assert.equal(tuningName(std(-1, 4)), 'Eb Standard');
    assert.equal(tuningName([-2, 0, 0, 0, 0, 0]), 'Drop D');
    assert.equal(tuningName([-3, -1, -1, -1, -1, -1]), 'Drop C#');
    assert.equal(tuningName([-2, 0, 0, 0, -2, 0]), 'DADGAD');
    assert.equal(tuningName([0, 1, 0, 0, 0, 3]), 'Custom Tuning');
    assert.equal(tuningName([]), '');
});

test('activeStrings uses stringCount, else 4 for bass and 6 for guitar', () => {
    assert.equal(activeStrings(std(0), { stringCount: 4 }), 4);
    assert.equal(activeStrings(std(0), { isBass: true }), 4);
    assert.equal(activeStrings(std(0, 7), { stringCount: 7 }), 7);
    assert.equal(activeStrings(std(0)), 6);
});

test('effectiveTuning moves strings by whole semitones and carries the rest', () => {
    assert.equal(effectiveTuning(std(-1), 0, 0), null);
    assert.equal(effectiveTuning(null, 0, 100), null);
    assert.deepEqual(effectiveTuning(std(-1), 0, 100), { tuning: std(0), centOffset: 0 });
    assert.deepEqual(effectiveTuning([-2, 0, 0, 0, 0, 0], 0, -200),
        { tuning: [-4, -2, -2, -2, -2, -2], centOffset: 0 });
    const r = effectiveTuning(std(0), 0, 130);
    assert.deepEqual(r.tuning, std(1));
    assert.equal(r.centOffset, 30);
    // The chart's own reference offset is preserved (bass -1200 octave).
    assert.equal(effectiveTuning(std(-1, 4), -1200, 100).centOffset, -1200);
});

test('auto: any Standard song lands on the player Standard tuning', () => {
    assert.deepEqual(autoShift(std(-1)), { cents: 100, kind: 'standard', from: 'Eb Standard', to: 'E Standard' });
    assert.equal(autoShift(std(-2)).cents, 200);
    assert.equal(autoShift(std(1)).cents, -100);
    assert.equal(autoShift(std(0)).cents, 0);
    // Player in Eb: an E standard song goes down a semitone.
    assert.deepEqual(autoShift(std(0), { home: -1 }),
        { cents: -100, kind: 'standard', from: 'E Standard', to: 'Eb Standard' });
});

test('auto: Drop songs land on Drop D (low string tuned by hand)', () => {
    assert.deepEqual(autoShift([-3, -1, -1, -1, -1, -1]),
        { cents: 100, kind: 'drop', from: 'Drop C#', to: 'Drop D' });
    assert.equal(autoShift([-2, 0, 0, 0, 0, 0]).cents, 0);
    assert.equal(autoShift([-4, -2, -2, -2, -2, -2]).to, 'Drop D');
});

test('auto: bass uses only its 4 strings and ignores the octave centOffset', () => {
    const a = autoShift([-1, -1, -1, -1, 0, 0], { isBass: true, centOffset: -1200 });
    assert.equal(a.cents, 100);
    assert.equal(a.kind, 'standard');
});

test('auto: corrects the song reference pitch (A443 recording)', () => {
    assert.equal(autoShift(std(0), { centOffset: 11.8 }).cents, -12);
    assert.equal(autoShift(std(-1), { centOffset: -20 }).cents, 120);
});

test('auto: open and custom tunings are left alone, odd low strings flagged', () => {
    assert.deepEqual(autoShift([-2, 0, 0, 0, -2, 0]), { cents: 0, kind: 'open', from: 'DADGAD', to: 'DADGAD' });
    const m = autoShift([-4, -1, -1, -1, -1, -1]);
    assert.equal(m.kind, 'mixed');
    assert.equal(m.cents, 100);
    assert.equal(autoShift(null).kind, 'none');
    assert.equal(autoShift([0]).kind, 'none');
});

test('resolveShift: manual wins, then auto when enabled, else off', () => {
    const auto = { cents: 100 };
    assert.deepEqual(resolveShift({ manual: -250, auto, autoEnabled: true }), { cents: -250, source: 'manual' });
    assert.deepEqual(resolveShift({ manual: 0, auto, autoEnabled: true }), { cents: 0, source: 'manual' });
    assert.deepEqual(resolveShift({ manual: null, auto, autoEnabled: true }), { cents: 100, source: 'auto' });
    assert.deepEqual(resolveShift({ manual: null, auto, autoEnabled: false }), { cents: 0, source: 'off' });
});

test('formatShift', () => {
    assert.equal(formatShift(0), '0');
    assert.equal(formatShift(100), '+1 st');
    assert.equal(formatShift(-200), '−2 st');
    assert.equal(formatShift(112), '+1 st +12¢');
    assert.equal(formatShift(-35), '−35¢');
});
