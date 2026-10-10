import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTransform, createProviderLink, PROVIDER_ID } from '../src/provider.js';

const songInfo = { tuning: [-1, -1, -1, -1, -1, -1], centOffset: 0, arrangement: 'Lead' };

test('transform publishes only tuning + centOffset, never notes', () => {
    let cents = 100;
    const t = makeTransform(() => cents);
    const out = t({ notes: [{ t: 1, s: 0, f: 3 }], chords: [], songInfo });
    assert.deepEqual(out, { tuning: [0, 0, 0, 0, 0, 0], centOffset: 0 });
    cents = -150;
    const half = t({ songInfo });
    assert.deepEqual(half.tuning, [-2, -2, -2, -2, -2, -2]);
    assert.equal(half.centOffset, -50);
    cents = 0;
    assert.equal(t({ songInfo }), null);          // null = chart unchanged
    assert.equal(makeTransform(() => 100)({}), null);
    assert.equal(makeTransform(() => 100)(undefined), null);
});

test('transform keeps the chart reference pitch (bass octave, A443)', () => {
    const t = makeTransform(() => 100);
    assert.equal(t({ songInfo: { tuning: [-1, -1, -1, -1], centOffset: -1200 } }).centOffset, -1200);
    assert.ok(Math.abs(t({ songInfo: { tuning: [0, 0, 0, 0, 0, 0], centOffset: 11.8 } }).centOffset - 11.8) < 1e-9);
});

// Minimal stand-in for core's chart-transform domain: same commands, same
// single-active-provider rule.
function fakeHost() {
    const providers = new Map();
    let active = null;
    const calls = [];
    const win = {
        feedBack: {
            chartTransformDomain: { version: 1, snapshot: () => ({ active }) },
            capabilities: {
                async dispatch({ capability, command, source, payload }) {
                    calls.push(command);
                    assert.equal(capability, 'chart-transform');
                    assert.equal(source, PROVIDER_ID);
                    if (command === 'register-provider') {
                        providers.set(payload.providerId, payload);
                        return { outcome: 'handled', payload: {} };
                    }
                    if (command === 'select-provider') { active = payload.providerId; return { outcome: 'handled' }; }
                    if (command === 'clear-provider') { active = null; return { outcome: 'handled' }; }
                    if (command === 'list-providers') {
                        return { outcome: 'handled', payload: { providers: [...providers.keys()].map((id) => ({ id })) } };
                    }
                    return { outcome: 'handled' };
                },
            },
        },
    };
    return { win, providers, calls, setActive: (id) => { active = id; }, getActive: () => active };
}

test('provider registers once and selects itself only while shifted', async () => {
    const host = fakeHost();
    let cents = 0;
    const link = createProviderLink(host.win, () => cents);
    assert.equal(link.available(), true);
    assert.equal(await link.register(), true);
    assert.ok(host.providers.has(PROVIDER_ID));
    assert.equal(typeof host.providers.get(PROVIDER_ID).transform, 'function');

    await link.sync();                       // 0: nothing to select
    assert.equal(host.getActive(), null);

    cents = 100;
    await link.sync();
    assert.equal(host.getActive(), PROVIDER_ID);
    assert.equal(link.isActive(), true);

    cents = 200;                             // already active: refresh only
    await link.sync();
    assert.equal(host.calls.at(-1), 'refresh');

    cents = 0;
    await link.sync();
    assert.equal(host.getActive(), null);
});

test('provider hands the slot back to the transform it displaced', async () => {
    const host = fakeHost();
    host.providers.set('simplify', { providerId: 'simplify' });
    host.setActive('simplify');
    let cents = 0;
    const link = createProviderLink(host.win, () => cents);
    await link.register();
    await link.sync();
    assert.equal(host.getActive(), 'simplify');   // untouched at 0
    cents = -100;
    await link.sync();
    assert.equal(host.getActive(), PROVIDER_ID);
    cents = 0;
    await link.sync();
    assert.equal(host.getActive(), 'simplify');
});

test('provider is a no-op on hosts without the chart-transform domain', async () => {
    const link = createProviderLink({ feedBack: {} }, () => 100);
    assert.equal(link.available(), false);
    assert.equal(await link.register(), false);
    await link.sync();
});
