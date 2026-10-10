// Persistence for the Auto-Tuner. Storage is injected so the tests can use a
// Map-backed fake; every access is guarded because localStorage can throw
// (private mode, blocked site data) and the plugin must still work in memory.
import { clampCents } from './tuning.js';

export const PREFIX = 'autotune.';
const SONG_PREFIX = PREFIX + 'song.';
const AUTO_KEY = PREFIX + 'auto';
const HOME_KEY = PREFIX + 'home';
// The pre-FeedBack Slopsmith build of this plugin stored whole semitones
// under `autotune.<hash>`; a private predecessor stored cents under
// `pitchCents:<filename>`. Both are read once and migrated.
const LEGACY_PITCH_CENTS = 'pitchCents:';

// djb2 → base36: short, stable, free of path separators and unicode.
export function songHash(filename) {
    const str = String(filename || '');
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = (((h << 5) + h) + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
}

export function songKey(filename) {
    return SONG_PREFIX + songHash(filename);
}

export function createStore(storage) {
    const mem = new Map();          // fallback when storage throws
    const get = (k) => {
        try { const v = storage && storage.getItem(k); if (v !== null && v !== undefined) return v; }
        catch (_) { /* storage unavailable */ }
        return mem.has(k) ? mem.get(k) : null;
    };
    const set = (k, v) => {
        mem.set(k, v);
        try { if (storage) storage.setItem(k, v); } catch (_) { /* memory only */ }
    };
    const del = (k) => {
        mem.delete(k);
        try { if (storage) storage.removeItem(k); } catch (_) { /* memory only */ }
    };

    function readLegacy(filename) {
        const old = get(PREFIX + songHash(filename));
        if (old !== null && /^-?\d+$/.test(old)) {
            del(PREFIX + songHash(filename));
            return Number(old) * 100;
        }
        for (const name of [filename, encodeURIComponent(filename)]) {
            const v = get(LEGACY_PITCH_CENTS + name);
            if (v !== null && Number.isFinite(Number(v))) return Number(v);
        }
        return null;
    }

    return {
        // Per-song manual shift in cents, or null when the song follows auto.
        loadManual(filename) {
            if (!filename) return null;
            const raw = get(songKey(filename));
            if (raw !== null) {
                const n = Number(raw);
                return Number.isFinite(n) ? clampCents(n) : null;
            }
            const legacy = readLegacy(filename);
            if (legacy === null) return null;
            const c = clampCents(legacy);
            set(songKey(filename), String(c));
            return c;
        },
        // null clears the override (the song goes back to auto / off).
        saveManual(filename, cents) {
            if (!filename) return;
            if (cents === null || cents === undefined) del(songKey(filename));
            else set(songKey(filename), String(clampCents(cents)));
        },
        getAuto() { return get(AUTO_KEY) === '1'; },
        setAuto(on) { set(AUTO_KEY, on ? '1' : '0'); },
        // The player's guitar tuning as a uniform offset from E standard.
        getHome() {
            const n = Number(get(HOME_KEY));
            return Number.isFinite(n) && n >= -7 && n <= 2 ? Math.round(n) : 0;
        },
        setHome(n) {
            const v = Math.round(Number(n));
            if (Number.isFinite(v) && v >= -7 && v <= 2) set(HOME_KEY, String(v));
        },
    };
}
