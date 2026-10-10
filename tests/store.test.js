import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, songHash, songKey, PREFIX } from '../src/store.js';

function fakeStorage(init = {}) {
    const m = new Map(Object.entries(init));
    return {
        m,
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => { m.set(k, String(v)); },
        removeItem: (k) => { m.delete(k); },
    };
}

test('song keys are prefixed, short and stable', () => {
    assert.equal(songHash('a/b c.feedpak'), songHash('a/b c.feedpak'));
    assert.notEqual(songHash('a.psarc'), songHash('b.psarc'));
    assert.match(songKey('Some Song_p.psarc'), /^autotune\.song\.[0-9a-z]+$/);
});

test('manual shift round-trips per song; null clears it', () => {
    const st = fakeStorage();
    const s = createStore(st);
    assert.equal(s.loadManual('x.psarc'), null);
    s.saveManual('x.psarc', 130);
    assert.equal(s.loadManual('x.psarc'), 130);
    assert.equal(s.loadManual('y.psarc'), null);
    s.saveManual('x.psarc', 0);            // an explicit 0 is a real override
    assert.equal(s.loadManual('x.psarc'), 0);
    s.saveManual('x.psarc', null);
    assert.equal(s.loadManual('x.psarc'), null);
    s.saveManual('x.psarc', 99999);
    assert.equal(s.loadManual('x.psarc'), 1200);
    for (const k of st.m.keys()) assert.ok(k.startsWith(PREFIX));
});

test('auto mode and home tuning persist with safe defaults', () => {
    const s = createStore(fakeStorage());
    assert.equal(s.getAuto(), false);
    assert.equal(s.getHome(), 0);
    s.setAuto(true);
    s.setHome(-1);
    assert.equal(s.getAuto(), true);
    assert.equal(s.getHome(), -1);
    s.setHome(9);                         // out of range: ignored
    assert.equal(s.getHome(), -1);
    assert.equal(createStore(fakeStorage({ 'autotune.home': 'junk' })).getHome(), 0);
});

test('legacy semitone keys migrate to cents', () => {
    const st = fakeStorage({ [PREFIX + songHash('old.psarc')]: '-2' });
    const s = createStore(st);
    assert.equal(s.loadManual('old.psarc'), -200);
    assert.equal(st.m.get(songKey('old.psarc')), '-200');
    assert.equal(st.m.has(PREFIX + songHash('old.psarc')), false);
});

test('legacy pitchCents keys are read (raw or URL-encoded filename)', () => {
    const s = createStore(fakeStorage({ 'pitchCents:My%20Song.sloppak': '100' }));
    assert.equal(s.loadManual('My Song.sloppak'), 100);
});

test('works in memory when storage throws', () => {
    const bad = {
        getItem() { throw new Error('blocked'); },
        setItem() { throw new Error('blocked'); },
        removeItem() { throw new Error('blocked'); },
    };
    const s = createStore(bad);
    s.saveManual('a', 50);
    assert.equal(s.loadManual('a'), 50);
    s.setAuto(true);
    assert.equal(s.getAuto(), true);
    assert.equal(createStore(null).loadManual('a'), null);
});
