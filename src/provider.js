// chart-transform provider (core feedBack#952).
//
// The Auto-Tuner never rewrites notes: the frets the player plays are the
// same, only the pitch they sound at moves. So the transform returns just the
// effective `tuning` (original offsets + the whole semitones of the shift)
// and `centOffset` (the song's own reference offset + the sub-semitone
// remainder). Everything downstream that reads the host's effective getters
// (`highway.getTuning()` / `getCentOffset()`, the renderer bundle) follows:
// note detection scores against the pitch the shifted audio really sits at
// (feedBack-plugin-notedetect#72) and tuning-aware renderers show it.
import { effectiveTuning } from './tuning.js';

export const PROVIDER_ID = 'autotune';
export const PROVIDER_LABEL = 'Auto-Tuner (live retune)';

// `getCents()` returns the shift currently applied to the audio. The audio
// shift is one value per song, so every highway surface (primary and
// splitscreen panels) gets the same one.
export function makeTransform(getCents) {
    return function transform(input) {
        const info = (input && input.songInfo) || {};
        return effectiveTuning(info.tuning, info.centOffset, getCents());
    };
}

// Thin wrapper over the capability domain. Only one chart-transform provider
// is active at a time, so the plugin selects itself only while a shift is in
// force, remembers what it displaced, and hands the slot back at 0.
export function createProviderLink(win, getCents) {
    const state = { registered: false, displaced: null };
    const api = () => {
        const caps = win.feedBack && win.feedBack.capabilities;
        return caps && typeof caps.dispatch === 'function' ? caps : null;
    };
    const active = () => {
        const d = win.feedBack && win.feedBack.chartTransformDomain;
        try { return d && typeof d.snapshot === 'function' ? d.snapshot().active : null; }
        catch (_) { return null; }
    };
    const send = (command, payload) => {
        const caps = api();
        if (!caps) return Promise.resolve(null);
        return Promise.resolve(caps.dispatch({
            capability: 'chart-transform', command, source: PROVIDER_ID, payload: payload || {},
        })).catch((e) => {
            console.warn('[autotune] chart-transform', command, 'failed:', e && e.message ? e.message : e);
            return null;
        });
    };

    return {
        available() { return !!(api() && win.feedBack.chartTransformDomain); },
        isActive() { return active() === PROVIDER_ID; },
        async register() {
            if (!api()) return false;
            const res = await send('register-provider', {
                providerId: PROVIDER_ID, label: PROVIDER_LABEL, transform: makeTransform(getCents),
            });
            state.registered = !!(res && res.outcome === 'handled');
            return state.registered;
        },
        // Call after the shift changes.
        async sync() {
            if (!state.registered) return;
            const cents = getCents();
            const current = active();
            if (cents) {
                if (current === PROVIDER_ID) { await send('refresh'); return; }
                state.displaced = current || null;
                await send('select-provider', { providerId: PROVIDER_ID });
                return;
            }
            if (current !== PROVIDER_ID) return;
            // Back to 0: restore whatever we displaced, else clear the slot.
            const prev = state.displaced;
            state.displaced = null;
            const listed = await send('list-providers');
            const ids = (listed && listed.payload && listed.payload.providers || []).map((p) => p.id);
            if (prev && ids.includes(prev)) await send('select-provider', { providerId: prev });
            else await send('clear-provider');
        },
    };
}
