// Auto-Tuner — live retune for FeedBack.
//
// Shifts the song's audio by semitones/cents in real time (tempo unchanged)
// so a guitar in a different tuning can play along, and publishes the
// effective tuning as a chart-transform provider so note detection and the
// highway follow. Runtime only: song files are never modified.
import { autoShift, clampCents, resolveShift, tuningName, noteName, activeStrings, effectiveTuning } from './tuning.js';
import { createStore } from './store.js';
import { createEngine, currentRoute } from './engine.js';
import { createProviderLink } from './provider.js';
import { createUI } from './ui.js';

(function () {
    'use strict';

    // Re-hydration guard (plugin-runtime-idempotent.v1): a second evaluation
    // must not add listeners, shortcuts, timers, DOM roots, audio nodes or a
    // second chart-transform registration.
    const HOOKS = window.__feedBackAutotuneHooks || (window.__feedBackAutotuneHooks = {});
    if (HOOKS.installed) return;
    HOOKS.installed = true;

    let storage = null;
    try { storage = window.localStorage; } catch (_) { /* blocked */ }
    const store = createStore(storage);
    const engine = createEngine(window);

    const S = {
        file: null,
        manual: null,
        auto: { cents: 0, kind: 'none', from: '', to: '' },
        cents: 0,
        source: 'off',
        tuning: null,          // active-string tuning of the loaded arrangement
        centOffset: 0,
        route: null,
    };

    const provider = createProviderLink(window, () => S.cents);

    // ── Naming ──────────────────────────────────────────────────────────────
    function nameTuning(offsets) {
        if (!Array.isArray(offsets) || !offsets.length) return '';
        if (typeof window.displayTuningName === 'function') {
            try { const n = window.displayTuningName(null, offsets); if (n) return n; } catch (_) { /* fall back */ }
        }
        return tuningName(offsets);
    }
    // Name of the tuning the song would sound in after `cents`.
    function nameAfter(cents) {
        if (!S.tuning) return '';
        const eff = effectiveTuning(S.tuning, 0, cents);
        return nameTuning(eff ? eff.tuning : S.tuning);
    }

    function autoNote() {
        const a = S.auto;
        const home = store.getHome();
        if (a.kind === 'drop') return `Drop tuning: tune your low string down to ${noteName(home - 2)}.`;
        if (a.kind === 'mixed') return 'The low string is tuned differently from the rest; retune it by hand.';
        if (a.kind === 'open') return 'Open/custom tuning: no single shift matches your guitar, so auto leaves it alone.';
        return '';
    }

    function view() {
        return {
            cents: S.cents,
            source: S.source,
            auto: S.auto,
            autoEnabled: store.getAuto(),
            autoNote: autoNote(),
            original: S.tuning ? nameTuning(S.tuning) : '',
            effective: nameAfter(S.cents) || 'shifted',
            engine: engine.describe(),
        };
    }

    // ── Song state ──────────────────────────────────────────────────────────
    function readSong() {
        const hw = window.highway;
        let info = null;
        try { info = hw && typeof hw.getSongInfo === 'function' ? hw.getSongInfo() : null; } catch (_) { /* not ready */ }
        const cur = (window.feedBack && window.feedBack.currentSong) || {};
        info = info || cur;
        const tuning = Array.isArray(info.tuning) ? info.tuning : (Array.isArray(cur.tuning) ? cur.tuning : null);
        const isBass = /bass/i.test(String(info.arrangement || cur.arrangement || ''));
        const n = tuning ? activeStrings(tuning, { stringCount: info.stringCount, isBass }) : 0;
        return {
            tuning: tuning && n ? tuning.slice(0, n) : null,
            fullTuning: tuning,
            centOffset: Number(info.centOffset) || 0,
            stringCount: info.stringCount,
            isBass,
        };
    }

    function recompute() {
        const song = readSong();
        S.tuning = song.tuning;
        S.centOffset = song.centOffset;
        S.auto = song.fullTuning
            ? autoShift(song.fullTuning, {
                centOffset: song.centOffset, home: store.getHome(),
                stringCount: song.stringCount, isBass: song.isBass,
            })
            : { cents: 0, kind: 'none', from: '', to: '' };
        S.manual = store.loadManual(S.file);
        const r = resolveShift({ manual: S.manual, auto: S.auto, autoEnabled: store.getAuto() });
        const changed = r.cents !== S.cents;
        S.cents = r.cents;
        S.source = r.source;
        return changed;
    }

    // Push the current shift to audio + chart and redraw.
    function commit({ force = false } = {}) {
        S.route = currentRoute(window);
        Promise.resolve(engine.apply(S.cents, { force })).then(() => ui.render()).catch(() => {});
        provider.sync().catch(() => {});
        ui.render();
    }

    // ── Actions ─────────────────────────────────────────────────────────────
    const actions = {
        setManual(cents) {
            if (!S.file) return;
            store.saveManual(S.file, clampCents(cents));
            recompute();
            commit();
        },
        nudge(delta) { actions.setManual(S.cents + delta); },
        backToAuto() {
            if (!S.file) return;
            store.saveManual(S.file, null);
            recompute();
            commit();
        },
        hydrateSettings,
    };

    const ui = createUI({ view, actions, nameOf: nameAfter });

    // ── Settings (settings.html and the popover share data-autotune hooks) ─
    function hydrateSettings(root) {
        const scope = root || document;
        scope.querySelectorAll('[data-autotune="auto"]').forEach((el) => { el.checked = store.getAuto(); });
        scope.querySelectorAll('[data-autotune="home"]').forEach((el) => { el.value = String(store.getHome()); });
    }
    document.addEventListener('change', (e) => {
        const t = e.target;
        const key = t && t.getAttribute && t.getAttribute('data-autotune');
        if (key === 'auto') store.setAuto(!!t.checked);
        else if (key === 'home') store.setHome(Number(t.value));
        else return;
        hydrateSettings();
        if (S.file) { recompute(); commit(); }
    });
    document.addEventListener('toggle', (e) => {
        if (e.target && e.target.querySelector && e.target.querySelector('[data-autotune]')) hydrateSettings(e.target);
    }, true);

    // ── Keyboard shortcuts (player scope) ───────────────────────────────────
    // Core owns [ / ] (A/V offset) and - / + (volume); these keys are free.
    function registerShortcuts() {
        if (typeof window.registerShortcut !== 'function') return;
        const add = (key, description, fn) => window.registerShortcut({
            key, description, scope: 'player',
            handler: (e) => { if (e && e.preventDefault) e.preventDefault(); fn(); },
        });
        add(',', 'Auto-Tuner: song down a semitone', () => actions.nudge(-100));
        add('.', 'Auto-Tuner: song up a semitone', () => actions.nudge(100));
        add('<', 'Auto-Tuner: song down 5 cents', () => actions.nudge(-5));
        add('>', 'Auto-Tuner: song up 5 cents', () => actions.nudge(5));
        add('\\', 'Auto-Tuner: back to auto / original pitch', () => actions.backToAuto());
    }

    // ── Lifecycle ───────────────────────────────────────────────────────────
    function onSongLoaded(e) {
        const song = (e && e.detail !== undefined) ? e.detail : e;
        S.file = (song && song.filename) || (window.feedBack.currentSong && window.feedBack.currentSong.filename) || null;
        recompute();
        ui.mount();
        // Native transpose is engine state that outlives the song: re-assert.
        commit({ force: true });
    }

    function onSongReady() {
        // Arrangement switches re-fire ready with a possibly different tuning.
        const changed = recompute();
        ui.mount();
        if (changed) commit();
        else { engine.apply(S.cents).then(() => ui.render()).catch(() => {}); ui.render(); }
    }

    // The audible path can change under a loaded song (stems graph built
    // after ready, desktop rerouting between HTML5 and the native engine).
    function reapplyIfRouteChanged() {
        const route = currentRoute(window);
        if (route === S.route) return;
        S.route = route;
        engine.apply(S.cents).then(() => ui.render()).catch(() => {});
    }

    function init() {
        const fb = window.feedBack;
        if (!fb || typeof fb.on !== 'function') {
            window.addEventListener('load', init, { once: true });
            return;
        }
        fb.on('song:loaded', onSongLoaded);
        fb.on('song:ready', onSongReady);
        fb.on('song:play', () => { S.route = null; reapplyIfRouteChanged(); });
        fb.on('screen:changed', (e) => {
            const id = e && e.detail ? e.detail.id : undefined;
            if (id !== 'player') ui.close();
            if (id === 'settings' || id === 'plugins') hydrateSettings();
        });
        window.addEventListener('stems:state', (e) => {
            if (e && e.detail && e.detail.event === 'provider-ready') { S.route = null; reapplyIfRouteChanged(); }
        });
        // 1 Hz route check, only while a shift is in force on the player.
        setInterval(() => {
            if (!S.cents || document.hidden) return;
            const player = document.getElementById('player');
            if (player && !player.classList.contains('active')) return;
            reapplyIfRouteChanged();
        }, 1000);
        registerShortcuts();
        hydrateSettings();
        provider.register().then(() => provider.sync()).catch(() => {});
        if (fb.currentSong) onSongLoaded(fb.currentSong);
    }

    window.autotune = {
        getState: () => ({ ...S, auto: { ...S.auto }, engine: engine.describe(), providerActive: provider.isActive() }),
        setShift: (cents) => actions.setManual(cents),
        nudge: (delta) => actions.nudge(delta),
        backToAuto: () => actions.backToAuto(),
        open: () => ui.open(),
        close: () => ui.close(),
    };

    init();
})();
