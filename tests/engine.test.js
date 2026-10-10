import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, currentRoute, desktopPitchApi, stemsGraph } from '../src/engine.js';

// ── Tiny Web Audio fake: records the connection graph ─────────────────────────
class FakeNode {
    constructor(ctx, name) { this.ctx = ctx; this.name = name; this.out = new Set(); }
    connect(n) { this.out.add(n); return n; }
    disconnect(n) {
        if (n === undefined) { this.out.clear(); return; }
        if (!this.out.has(n)) { const e = new Error('not connected'); e.name = 'InvalidAccessError'; throw e; }
        this.out.delete(n);
    }
}
class FakeCtx {
    constructor() {
        this.destination = new FakeNode(this, 'destination');
        this.currentTime = 0;
        this.state = 'running';
        this.modules = [];
        this.audioWorklet = { addModule: async (url) => { this.modules.push(url); } };
        this.sources = 0;
    }
    createMediaElementSource(el) {
        if (el.captured) { const e = new Error('already'); e.name = 'InvalidStateError'; throw e; }
        el.captured = true; this.sources += 1;
        return new FakeNode(this, 'source');
    }
    createAnalyser() { return new FakeNode(this, 'analyser'); }
    resume() { return Promise.resolve(); }
    close() { this.closed = true; }
}
class FakeWorkletNode extends FakeNode {
    constructor(ctx, name) {
        super(ctx, name);
        this.value = 0;
        const self = this;
        this.parameters = new Map([['pitchSemitones', {
            setValueAtTime(v) { self.value = v; },
            set value(v) { self.value = v; },
        }]]);
        this.port = { postMessage() {} };
    }
}

function makeWin(extra = {}) {
    const audio = { captured: false, addEventListener() {} };
    return {
        document: { getElementById: (id) => (id === 'audio' ? audio : null) },
        AudioContext: FakeCtx,
        AudioWorkletNode: FakeWorkletNode,
        feedBack: {},
        audio,
        ...extra,
    };
}

test('route follows the audible path', () => {
    assert.equal(currentRoute(makeWin()), 'element');
    const ctx = new FakeCtx();
    const stems = { context: ctx, masterNode: new FakeNode(ctx, 'master') };
    assert.equal(currentRoute(makeWin({ feedBack: { stems: { audioGraph: stems } } })), 'stems');
    assert.equal(stemsGraph({ slopsmith: { stems: { audioGraph: stems } } }), stems);
    assert.equal(currentRoute(makeWin({ _juceMode: true, feedBack: { stems: { audioGraph: stems } } })), 'desktop');
});

test('desktop: setBackingPitch gets fractional semitones; web path untouched', async () => {
    const sent = [];
    const win = makeWin({
        _juceMode: true,
        feedBackDesktop: { audio: { setBackingPitch: async (s) => { sent.push(s); return true; } } },
    });
    assert.ok(desktopPitchApi(win));
    const eng = createEngine(win);
    await eng.apply(100);
    await eng.apply(130);
    await eng.apply(130);                 // unchanged: not re-sent
    await eng.apply(130, { force: true }); // song load: re-asserted
    await eng.apply(0);
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(sent, [1, 1.3, 1.3, 0]);
    assert.equal(win.audio.captured, false);
    assert.equal(eng.describe().route, 'desktop');
    assert.equal(eng.describe().ok, true);
});

test('desktop without the pitch API reports it instead of failing', async () => {
    const win = makeWin({ _juceMode: true, feedBackDesktop: { audio: {} } });
    const eng = createEngine(win);
    await eng.apply(100);
    assert.equal(eng.describe().ok, false);
    assert.match(eng.describe().reason, /no backing pitch control/);
});

test('element: nothing is captured until a shift is needed', async () => {
    const win = makeWin();
    const eng = createEngine(win);
    await eng.apply(0);
    assert.equal(win.audio.captured, false);
    await eng.apply(-200);
    assert.equal(win.audio.captured, true);
    const tap = win.__feedBackAudioTap;
    assert.ok(tap && tap.analyser && tap.mediaEl === win.audio, 'publishes the shared tap');
    // source → worklet → analyser → destination: the shared analyser hears
    // the shifted audio, and is what reaches the speakers.
    assert.ok(tap.analyser.out.has(tap.ctx.destination));
    assert.equal(tap.ctx.modules.length, 1);
    assert.match(tap.ctx.modules[0], /assets\/pitch-shift-worklet\.js$/);
});

test('element: adopts an existing shared tap instead of re-capturing', async () => {
    const win = makeWin();
    const ctx = new FakeCtx();
    const analyser = ctx.createAnalyser();
    analyser.connect(ctx.destination);
    win.__feedBackAudioTap = { ctx, analyser, mediaEl: win.audio };
    win.audio.captured = true;            // a 3D highway already owns the element
    const eng = createEngine(win);
    await eng.apply(100);
    assert.equal(analyser.out.has(ctx.destination), false);
    const node = [...analyser.out][0];
    assert.ok(node instanceof FakeWorkletNode);
    assert.ok(node.out.has(ctx.destination));
    assert.equal(node.value, 1);
    assert.equal(eng.describe().ok, true);
});

test('element: an element captured by someone else degrades with a reason', async () => {
    const win = makeWin();
    win.audio.captured = true;            // captured, but no shared tap published
    const eng = createEngine(win);
    await eng.apply(100);
    assert.equal(eng.describe().ok, false);
    assert.match(eng.describe().reason, /already captured/);
});

test('stems: worklet spliced after the master bus, re-spliced per song', async () => {
    const ctx = new FakeCtx();
    const win = makeWin();
    const master1 = new FakeNode(ctx, 'master1');
    master1.connect(ctx.destination);
    win.feedBack.stems = { audioGraph: { context: ctx, masterNode: master1 } };
    const eng = createEngine(win);
    await eng.apply(0);
    assert.ok(master1.out.has(ctx.destination), 'no splice at 0');
    await eng.apply(-100);
    const node1 = [...master1.out][0];
    assert.ok(node1 instanceof FakeWorkletNode);
    assert.ok(node1.out.has(ctx.destination));
    assert.equal(node1.value, -1);
    assert.equal(win.audio.captured, false, 'silent <audio> transport is left alone');

    // New song: Stems builds a new master on the same context.
    const master2 = new FakeNode(ctx, 'master2');
    master2.connect(ctx.destination);
    win.feedBack.stems.audioGraph = { context: ctx, masterNode: master2 };
    await eng.apply(-100);
    const node2 = [...master2.out][0];
    assert.ok(node2 instanceof FakeWorkletNode && node2 !== node1);
    assert.equal(node1.out.size, 0, 'old node detached');
    assert.equal(ctx.modules.length, 1, 'module added once per context');

    await eng.apply(0);                    // stays inline, bypassed
    assert.equal(node2.value, 0);
});
