// Auto-Tuner player UI: the TUNE control (mounted in the v3 plugin-control
// slot), its popover, and the HUD line showing the effective tuning.
//
// Rendering is driven by `view()` (a plain snapshot from main.js) and user
// actions go back through `actions`, so this file holds no tuning state.
import { formatShift, noteName } from './tuning.js';

const STYLE_ID = 'autotune-styles';
const PRESETS = [2, 1, 0, -1, -2, -3, -4, -5];
const HOMES = [2, 1, 0, -1, -2, -3, -4, -5, -6, -7];
const GOLD = '#e8c040';

const CSS = `
.autotune-btn{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:8px;
  background:#22262d;border:1px solid #343a44;color:#9ca3af;font:600 12px/1 system-ui,sans-serif;cursor:pointer}
.autotune-btn:hover{background:#2c313a;color:#e5e7eb}
.autotune-btn[data-active="1"]{color:${GOLD};border-color:${GOLD}66}
.autotune-pop{position:fixed;z-index:1000;width:296px;max-width:calc(100vw - 16px);background:#1c2026;
  border:1px solid #3a4048;border-radius:10px;box-shadow:0 12px 32px rgba(0,0,0,.55);padding:10px;
  color:#d1d5db;font:12px/1.35 system-ui,sans-serif}
.autotune-pop[hidden]{display:none}
#player>.autotune-pop{z-index:50}
.autotune-pop h3{margin:0;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#9ca3af}
.autotune-row{display:flex;align-items:center;gap:6px;margin-top:8px}
.autotune-head{display:flex;align-items:center;justify-content:space-between}
.autotune-x{background:none;border:0;color:#9ca3af;font-size:16px;cursor:pointer;padding:0 4px}
.autotune-tunings{margin-top:6px;color:#9ca3af}
.autotune-tunings b{color:#e5e7eb;font-weight:600}
.autotune-step{flex:0 0 auto;min-width:28px;padding:5px 0;border-radius:6px;background:#2a2f37;border:1px solid #343a44;
  color:#d1d5db;cursor:pointer;font:600 12px system-ui,sans-serif}
.autotune-step:hover{background:#343a44}
.autotune-cents{flex:1 1 auto;min-width:0;text-align:center;padding:5px 4px;border-radius:6px;background:#111418;
  border:1px solid #343a44;color:#e5e7eb;font:600 13px system-ui,sans-serif;font-variant-numeric:tabular-nums}
.autotune-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:4px;margin-top:8px}
.autotune-preset{display:flex;flex-direction:column;align-items:center;gap:1px;padding:5px 2px;border-radius:6px;
  background:#2a2f37;border:1px solid transparent;color:#d1d5db;cursor:pointer;font:12px system-ui,sans-serif}
.autotune-preset:hover{background:#343a44}
.autotune-preset[data-on="1"]{border-color:${GOLD};color:${GOLD};background:#3a4048}
.autotune-preset span:first-child{font-weight:600;font-size:12px;white-space:nowrap}
.autotune-preset span:last-child{font-size:10px;color:#9ca3af}
.autotune-auto{width:100%;margin-top:8px;padding:6px 8px;border-radius:6px;background:#2a2f37;border:1px solid #343a44;
  color:#d1d5db;cursor:pointer;text-align:left;font:12px system-ui,sans-serif}
.autotune-auto[data-on="1"]{border-color:${GOLD}99}
.autotune-note{margin-top:4px;color:#fbbf24;font-size:11px}
.autotune-opts{margin-top:8px;padding-top:8px;border-top:1px solid #2f343c;display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center}
.autotune-opts label{display:flex;align-items:center;gap:5px;color:#c4c9d1}
.autotune-opts select{background:#111418;color:#e5e7eb;border:1px solid #343a44;border-radius:5px;padding:2px 4px;font:12px system-ui,sans-serif}
.autotune-foot{margin-top:8px;color:#8b929c;font-size:11px}
.autotune-foot .bad{color:#f87171}
.autotune-hud{color:${GOLD};font-size:12px;margin-top:2px}
`;

function h(tag, props, ...kids) {
    const n = document.createElement(tag);
    if (props) {
        for (const [k, v] of Object.entries(props)) {
            if (k === 'class') n.className = v;
            else if (k === 'text') n.textContent = v;
            else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
            else if (v !== undefined && v !== null) n.setAttribute(k, v);
        }
    }
    for (const kid of kids) if (kid) n.appendChild(kid);
    return n;
}

function playerSlot() {
    const fb = window.feedBack;
    return (fb && fb.uiVersion === 'v3' && fb.ui && typeof fb.ui.playerControlSlot === 'function')
        ? fb.ui.playerControlSlot() : null;
}

export function createUI({ view, actions, nameOf }) {
    let btn = null;
    let pop = null;
    let hud = null;
    const refs = {};

    function ensureStyles() {
        if (document.getElementById(STYLE_ID)) return;
        document.head.appendChild(h('style', { id: STYLE_ID, text: CSS }));
    }

    // ── TUNE control ────────────────────────────────────────────────────────
    function mount() {
        ensureStyles();
        const slot = playerSlot();
        const host = slot || document.getElementById('player-controls');
        if (!host) return false;
        if (btn && host.contains(btn)) return true;
        if (!btn) {
            btn = h('button', {
                type: 'button', id: 'autotune-btn', class: 'autotune-btn',
                'aria-haspopup': 'dialog', 'aria-expanded': 'false',
                onclick: (e) => { e.stopPropagation(); toggle(); },
            });
        }
        // v2 bar: keep the legacy position before the close button; the v3
        // slot has no such anchor, so just append.
        const anchor = slot ? null : host.querySelector('button:last-child');
        if (anchor && anchor !== btn) host.insertBefore(btn, anchor); else host.appendChild(btn);
        render();
        return true;
    }

    // ── Popover ─────────────────────────────────────────────────────────────
    function build() {
        if (pop) return pop;
        refs.tunings = h('div', { class: 'autotune-tunings' });
        refs.cents = h('input', {
            class: 'autotune-cents', type: 'number', step: '1', min: '-1200', max: '1200',
            'aria-label': 'Shift in cents (100 = one semitone)',
            onchange: () => actions.setManual(Number(refs.cents.value)),
            onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); refs.cents.blur(); } e.stopPropagation(); },
        });
        const step = (label, delta, title) => h('button', {
            type: 'button', class: 'autotune-step', title, text: label,
            onclick: () => actions.nudge(delta),
        });
        refs.grid = h('div', { class: 'autotune-grid', role: 'group', 'aria-label': 'Semitone presets' });
        for (const semis of PRESETS) {
            const b = h('button', {
                type: 'button', class: 'autotune-preset', 'data-semitones': String(semis),
                onclick: () => actions.setManual(semis * 100),
            }, h('span'), h('span'));
            refs.grid.appendChild(b);
        }
        refs.auto = h('button', { type: 'button', class: 'autotune-auto', onclick: () => actions.backToAuto() });
        refs.note = h('div', { class: 'autotune-note' });
        const homeSel = h('select', { 'data-autotune': 'home', 'aria-label': 'My guitar tuning' });
        for (const v of HOMES) homeSel.appendChild(h('option', { value: String(v), text: noteName(v) + ' Standard' }));
        refs.foot = h('div', { class: 'autotune-foot' });
        pop = h('div', { class: 'autotune-pop', id: 'autotune-popover', role: 'dialog', 'aria-label': 'Auto-Tuner', hidden: '' },
            h('div', { class: 'autotune-head' },
                h('h3', { text: 'Auto-Tuner' }),
                h('button', { type: 'button', class: 'autotune-x', 'aria-label': 'Close', text: '×', onclick: close })),
            refs.tunings,
            h('div', { class: 'autotune-row' },
                step('«', -100, 'Down a semitone'), step('‹', -1, 'Down 1 cent'),
                refs.cents,
                step('›', 1, 'Up 1 cent'), step('»', 100, 'Up a semitone')),
            refs.grid,
            refs.auto,
            refs.note,
            h('div', { class: 'autotune-opts' },
                h('label', null, h('input', { type: 'checkbox', 'data-autotune': 'auto' }),
                    document.createTextNode('Auto-shift songs')),
                h('label', null, document.createTextNode('My tuning'), homeSel)),
            refs.foot);
        pop.addEventListener('click', (e) => e.stopPropagation());
        return pop;
    }

    function position() {
        if (!pop || pop.hidden || !btn) return;
        const r = btn.getBoundingClientRect();
        const w = pop.offsetWidth || 296;
        const ph = pop.offsetHeight || 360;
        let left = r.right + 8;
        let top = Math.min(Math.max(8, r.top - 12), window.innerHeight - ph - 8);
        if (left + w > window.innerWidth - 8) {       // no room to the right → above
            left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
            top = Math.max(8, r.top - ph - 8);
        }
        pop.style.left = Math.round(left) + 'px';
        pop.style.top = Math.round(top) + 'px';
    }

    function onDocClick(e) { if (btn && btn.contains(e.target)) return; close(); }
    function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } }

    function open() {
        build();
        if (!pop.hidden) return;
        // Portal into #player (a fixed z-100 layer in v3) so the popover sits
        // above the player chrome (rail z-30, popovers z-40); body otherwise.
        const host = document.getElementById('player') || document.body;
        if (pop.parentNode !== host) host.appendChild(pop);
        pop.hidden = false;
        if (btn) btn.setAttribute('aria-expanded', 'true');
        render();
        position();
        actions.hydrateSettings(pop);
        // Defer so the opening click does not immediately close it.
        setTimeout(() => {
            if (pop.hidden) return;
            document.addEventListener('click', onDocClick);
            document.addEventListener('keydown', onKey, true);
            window.addEventListener('resize', position);
        }, 0);
    }

    function close() {
        if (!pop || pop.hidden) return;
        pop.hidden = true;
        if (btn) btn.setAttribute('aria-expanded', 'false');
        document.removeEventListener('click', onDocClick);
        document.removeEventListener('keydown', onKey, true);
        window.removeEventListener('resize', position);
    }

    function toggle() { if (pop && !pop.hidden) close(); else open(); }

    // ── HUD line under core's "Tuning: …" ─────────────────────────────────
    function renderHud(v) {
        const anchor = document.getElementById('hud-tuning');
        if (!anchor || !anchor.parentNode) return;
        if (!hud || !anchor.parentNode.contains(hud)) {
            hud = hud || h('div', { id: 'autotune-hud', class: 'autotune-hud' });
            anchor.parentNode.insertBefore(hud, anchor.nextSibling);
        }
        hud.hidden = !v.cents;
        hud.textContent = v.cents ? `Playing as ${v.effective} (${formatShift(v.cents)}, Auto-Tuner)` : '';
    }

    function render() {
        const v = view();
        if (btn) {
            btn.dataset.active = v.cents ? '1' : '0';
            btn.textContent = v.cents ? `TUNE ${formatShift(v.cents)}` : 'TUNE';
            btn.title = v.cents
                ? `Song shifted ${formatShift(v.cents)}: playing as ${v.effective}`
                : 'Auto-Tuner: shift the song to match your guitar’s tuning';
        }
        renderHud(v);
        if (!pop || pop.hidden) return;
        refs.tunings.textContent = '';
        refs.tunings.append('Song ', h('b', { text: v.original || '—' }));
        if (v.cents) refs.tunings.append(' → playing as ', h('b', { text: v.effective }));
        if (document.activeElement !== refs.cents) refs.cents.value = String(v.cents);
        for (const b of refs.grid.children) {
            const semis = Number(b.dataset.semitones);
            b.dataset.on = v.cents === semis * 100 ? '1' : '0';
            b.firstChild.textContent = nameOf(semis * 100);
            b.lastChild.textContent = semis ? formatShift(semis * 100) : 'original';
        }
        const a = v.auto;
        if (v.autoEnabled) {
            refs.auto.textContent = v.source === 'auto'
                ? `Auto: ${formatShift(a.cents)}${a.cents ? ' → ' + a.to : ''} (following)`
                : `Back to auto (${formatShift(a.cents)}${a.cents ? ' → ' + a.to : ''})`;
        } else {
            refs.auto.textContent = v.source === 'manual' ? 'Reset this song to original pitch' : 'Original pitch';
        }
        refs.auto.dataset.on = v.source === 'manual' ? '0' : '1';
        refs.note.textContent = v.autoEnabled ? (v.autoNote || '') : '';
        refs.note.hidden = !refs.note.textContent;
        const eng = v.engine;
        refs.foot.textContent = '';
        refs.foot.append('Audio: ' + eng.label + ' ');
        if (!eng.ok) refs.foot.append(h('span', { class: 'bad', text: '— ' + eng.reason }));
        refs.foot.append(h('br'), ', / . semitone · < / > 5¢ · \\ auto');
        position();
    }

    return { mount, render, open, close, isOpen: () => !!(pop && !pop.hidden) };
}
