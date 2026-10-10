// Offline DSP check of assets/pitch-shift-worklet.js (the browser fallback
// engine): load the real file under stubbed AudioWorklet globals, push a sine
// through it and measure what comes out. Nothing is played.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SR = 44100;
const QUANTUM = 128;
const W = 1024;
const N = SR;          // one second

function loadProcessor() {
    let name = null;
    let Cls = null;
    const sandbox = {
        AudioWorkletProcessor: class { constructor() { this.port = { onmessage: null, postMessage() {} }; } },
        registerProcessor: (n, c) => { name = n; Cls = c; },
        Math, Float32Array,
    };
    vm.createContext(sandbox);
    const src = readFileSync(new URL('../assets/pitch-shift-worklet.js', import.meta.url), 'utf8');
    vm.runInContext(src, sandbox, { filename: 'pitch-shift-worklet.js' });
    return { name, Cls };
}

function sine(freq, samples = N) {
    const a = new Float32Array(samples);
    for (let i = 0; i < samples; i++) a[i] = Math.sin((2 * Math.PI * freq * i) / SR);
    return a;
}

function run(proc, chans, semitones) {
    const out = chans.map((c) => new Float32Array(c.length));
    const params = { pitchSemitones: Float32Array.of(semitones) };
    for (let off = 0; off < chans[0].length; off += QUANTUM) {
        const n = Math.min(QUANTUM, chans[0].length - off);
        proc.process([chans.map((c) => c.subarray(off, off + n))], [out.map((c) => c.subarray(off, off + n))], params);
    }
    return out;
}

// Dominant frequency from the zero-crossing rate over the steady state.
function freqOf(buf, skip = 4 * W) {
    let crossings = 0;
    for (let i = skip + 1; i < buf.length; i++) {
        if ((buf[i - 1] <= 0 && buf[i] > 0) || (buf[i - 1] >= 0 && buf[i] < 0)) crossings++;
    }
    return crossings / 2 / ((buf.length - skip - 1) / SR);
}

const { name, Cls } = loadProcessor();

test('registers under the plugin-namespaced processor name', () => {
    assert.equal(name, 'autotune-pitch-shift');
    assert.equal(Cls.parameterDescriptors[0].name, 'pitchSemitones');
});

test('0 semitones is a sample-accurate passthrough', () => {
    const inp = sine(440);
    const [out] = run(new Cls({ processorOptions: { windowSize: W } }), [inp], 0);
    let maxErr = 0;
    for (let i = 0; i < N; i++) maxErr = Math.max(maxErr, Math.abs(out[i] - inp[i]));
    assert.ok(maxErr < 1e-6, `maxErr=${maxErr}`);
});

for (const semis of [12, -12, 2, -1, -2, -5, 0.5]) {
    test(`${semis > 0 ? '+' : ''}${semis} st shifts frequency by 2^(n/12), length unchanged`, () => {
        const [out] = run(new Cls({ processorOptions: { windowSize: W } }), [sine(440)], semis);
        const want = 440 * Math.pow(2, semis / 12);
        const got = freqOf(out);
        assert.equal(out.length, N);
        assert.ok(Math.abs(got - want) / want < 0.08, `got ${got.toFixed(1)} Hz, want ${want.toFixed(1)}`);
    });
}

test('stereo channels are shifted independently', () => {
    const [l, r] = run(new Cls({ processorOptions: { windowSize: W } }), [sine(330), sine(550)], -12);
    assert.ok(Math.abs(freqOf(l) - 165) / 165 < 0.08);
    assert.ok(Math.abs(freqOf(r) - 275) / 275 < 0.08);
});
