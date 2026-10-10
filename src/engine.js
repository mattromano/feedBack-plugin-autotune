// Audio side of the Auto-Tuner: put the shift on whatever is actually playing
// the song right now.
//
// FeedBack plays song audio through one of three paths, and which one is live
// can change mid-song (the desktop reroutes when the output device goes
// exclusive/ASIO):
//
//   desktop  window._juceMode === true: the JUCE engine's backing player owns
//            the song. Shifted natively with feedBackDesktop.audio
//            .setBackingPitch(semitones) (feedBack-desktop backing pitch
//            transpose; the engine compensates the reported playhead for the
//            stretcher latency, so the chart stays aligned).
//   stems    a stems sloppak/feedpak in the browser (or shared-mode desktop):
//            the Stems plugin plays a Web Audio graph and publishes its master
//            on window.feedBack.stems.audioGraph. The plugin's pitch worklet
//            is spliced between that master and the destination.
//   element  everything else: the core <audio id="audio"> element, routed
//            through the worklet via a MediaElementSource.
//
// The native transpose is engine state that survives song loads, so it is set
// on every apply (including 0) whenever the desktop API exists, whichever path
// is audible; the web worklet is only built once a non-zero shift is needed.

const WORKLET_NAME = 'autotune-pitch-shift';
const WORKLET_URL = new URL('../assets/pitch-shift-worklet.js', import.meta.url).href;

export function desktopPitchApi(win) {
    const a = win && win.feedBackDesktop && win.feedBackDesktop.audio;
    return a && typeof a.setBackingPitch === 'function' ? a : null;
}

export function stemsGraph(win) {
    const ns = win && (win.feedBack || win.slopsmith);
    const g = ns && ns.stems && ns.stems.audioGraph;
    return g && g.context && g.masterNode ? g : null;
}

// Which path is audible right now (see the header).
export function currentRoute(win) {
    if (win && win._juceMode === true) return 'desktop';
    if (stemsGraph(win)) return 'stems';
    return 'element';
}

export function createEngine(win) {
    const doc = win.document;
    let cents = 0;
    const modules = new WeakMap();            // AudioContext → Promise<boolean>
    const el = { node: null, ctx: null, failed: null, building: null };
    const st = { master: null, node: null, ctx: null, failed: null, building: null };
    let lastNative = null;
    let nativeError = null;

    function workletModule(ctx) {
        if (!modules.has(ctx)) {
            const p = ctx.audioWorklet && typeof ctx.audioWorklet.addModule === 'function'
                ? ctx.audioWorklet.addModule(WORKLET_URL).then(() => true)
                : Promise.reject(new Error('AudioWorklet unsupported'));
            modules.set(ctx, p.catch((e) => { modules.delete(ctx); throw e; }));
        }
        return modules.get(ctx);
    }

    async function makeNode(ctx) {
        await workletModule(ctx);
        return new win.AudioWorkletNode(ctx, WORKLET_NAME, {
            numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
            processorOptions: { windowSize: 1024 },
        });
    }

    function setNodePitch(node, ctx) {
        if (!node) return;
        const semis = cents / 100;
        const p = node.parameters && node.parameters.get && node.parameters.get('pitchSemitones');
        if (p) {
            try { p.setValueAtTime(semis, ctx.currentTime); } catch (_) { p.value = semis; }
        }
        try { node.port.postMessage({ type: 'pitch', value: semis }); } catch (_) { /* closed */ }
    }

    // ── core <audio> element ────────────────────────────────────────────────
    // createMediaElementSource is one-shot per element. FeedBack's 3D
    // highways share the first tap through window.__feedBackAudioTap
    // ({ ctx, analyser, mediaEl }): if one already exists, re-point its
    // analyser through our worklet; otherwise create the tap ourselves (with
    // an analyser AFTER the shifter) and publish it so they adopt it.
    async function ensureElement() {
        if (el.node) return true;
        if (el.failed) return false;
        if (el.building) return el.building;
        el.building = (async () => {
            const audio = doc.getElementById('audio');
            const Ctx = win.AudioContext || win.webkitAudioContext;
            if (!audio || !Ctx || typeof win.AudioWorkletNode !== 'function') {
                el.failed = 'Web Audio is not available in this browser';
                return false;
            }
            const tap = win.__feedBackAudioTap;
            try {
                if (tap && tap.mediaEl === audio && tap.ctx && tap.analyser) {
                    const node = await makeNode(tap.ctx);
                    tap.analyser.disconnect();
                    tap.analyser.connect(node);
                    node.connect(tap.ctx.destination);
                    el.node = node; el.ctx = tap.ctx;
                } else {
                    const ctx = new Ctx();
                    let node;
                    try {
                        node = await makeNode(ctx);
                        // Synchronous from here: no gap where the element is
                        // captured but not yet audible.
                        const source = ctx.createMediaElementSource(audio);
                        const analyser = ctx.createAnalyser();
                        analyser.fftSize = 256;
                        source.connect(node);
                        node.connect(analyser);
                        analyser.connect(ctx.destination);
                        try { win.__feedBackAudioTap = { ctx, analyser, mediaEl: audio }; } catch (_) { /* frozen */ }
                    } catch (e) {
                        try { ctx.close(); } catch (_) { /* already closed */ }
                        throw e;
                    }
                    const resume = () => {
                        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
                    };
                    resume();
                    audio.addEventListener('play', resume);
                    el.node = node; el.ctx = ctx;
                }
                return true;
            } catch (e) {
                el.failed = e && e.name === 'InvalidStateError'
                    ? 'The song audio is already captured by another component'
                    : 'Could not start the browser pitch shifter';
                console.warn('[autotune] browser pitch path unavailable:', e && e.message ? e.message : e);
                return false;
            } finally {
                el.building = null;
            }
        })();
        return el.building;
    }

    // ── Stems master bus ────────────────────────────────────────────────────
    // The Stems plugin rebuilds its master GainNode per song (the context is
    // reused), so the splice is keyed on the master node's identity.
    async function ensureStems(g) {
        if (st.master === g.masterNode && st.node) return true;
        if (st.building) return st.building;
        st.building = (async () => {
            try {
                const node = await makeNode(g.context);
                if (stemsGraph(win) !== g) { try { node.disconnect(); } catch (_) { /* unused */ } return false; }
                g.masterNode.disconnect(g.context.destination);   // throws if not wired there
                g.masterNode.connect(node);
                node.connect(g.context.destination);
                if (st.node) { try { st.node.disconnect(); } catch (_) { /* gone */ } }
                st.master = g.masterNode; st.node = node; st.ctx = g.context; st.failed = null;
                return true;
            } catch (e) {
                st.failed = 'Could not attach to the stems mix';
                console.warn('[autotune] stems pitch path unavailable:', e && e.message ? e.message : e);
                return false;
            } finally {
                st.building = null;
            }
        })();
        return st.building;
    }

    function applyNative(force) {
        const api = desktopPitchApi(win);
        if (!api) return;
        const semis = cents / 100;
        if (lastNative === semis && !force) return;
        lastNative = semis;
        Promise.resolve()
            .then(() => api.setBackingPitch(semis))
            .then((ok) => { nativeError = ok === false ? 'The desktop engine rejected the shift' : null; })
            .catch((e) => { nativeError = 'Desktop pitch call failed'; console.warn('[autotune] setBackingPitch failed:', e); });
    }

    // Apply `next` (cents) to every relevant path. Safe to call often;
    // `force` re-sends the native value (song load) even if unchanged.
    async function apply(next, { force = false } = {}) {
        cents = Number(next) || 0;
        applyNative(force);
        const route = currentRoute(win);
        if (route === 'desktop') return;
        if (route === 'stems') {
            const g = stemsGraph(win);
            if (cents || (st.node && st.master === g.masterNode)) {
                if (await ensureStems(g)) setNodePitch(st.node, st.ctx);
            }
            return;
        }
        if (cents || el.node) {
            if (await ensureElement()) setNodePitch(el.node, el.ctx);
        }
    }

    // What the UI shows about the audio side.
    function describe() {
        const route = currentRoute(win);
        if (route === 'desktop') {
            if (!desktopPitchApi(win)) {
                return { route, ok: false, label: 'Desktop engine', reason: 'This FeedBack Desktop build has no backing pitch control yet' };
            }
            return { route, ok: !nativeError, label: 'Desktop engine', reason: nativeError || '' };
        }
        if (route === 'stems') {
            return { route, ok: !st.failed, label: 'Stems mix (browser)', reason: st.failed || '' };
        }
        return { route, ok: !el.failed, label: 'Browser audio', reason: el.failed || '' };
    }

    return { apply, describe, get cents() { return cents; } };
}
