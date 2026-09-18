import { TEAM } from '../units/team.js';

/**
 * Styling for the widgets built here: the two tool slots (the crate and the sign currently
 * selected) with their popout lists, and the auto-pausing game menu. Injected once so the HUD
 * stays self-contained; everything else keeps using the stylesheet's .panel / .tool / .btn rules.
 */
const HUD_CSS = `
#hud-palette { display: flex; gap: 4px; }
#hud-palette .slot-row { position: relative; display: flex; align-items: stretch; gap: 4px; }
#hud-palette .slot-row > .tool { flex: 1 1 auto; }
#hud-palette .slot-more { flex: none; padding: 2px 8px; }
#hud-palette .tool-popout { position: absolute; left: 0; bottom: calc(100% + 6px); z-index: 6;
  display: none; flex-direction: column; gap: 2px; min-width: 220px; padding: 6px; }
#hud-palette .tool-popout.open { display: flex; }
/* The hint is a one-liner by default; long text is clipped and expands on hover/focus. */
#hud-hint { max-width: min(52ch, calc(100vw - 24px)); white-space: nowrap; overflow: hidden;
   text-overflow: ellipsis; transition: max-width 120ms ease; }
#hud-hint.clipped { cursor: help; }
#hud-hint.clipped:hover, #hud-hint.clipped:focus-visible {
   max-width: min(80ch, calc(100vw - 24px)); white-space: normal; overflow: visible;
   text-overflow: clip; outline: none; }
#hud-menu { position: fixed; inset: 0; z-index: 30; pointer-events: auto; display: flex;
  align-items: center; justify-content: center; background: rgba(8, 10, 16, 0.55); }
#hud-menu.hidden { display: none; }
#hud-menu .card { min-width: 280px; }
#hud-menu .row { flex-wrap: wrap; gap: 6px; }
`;

function ensureStyles() {
  if (document.getElementById('hud-layout-css')) return;
  const s = document.createElement('style');
  s.id = 'hud-layout-css';
  s.textContent = HUD_CSS;
  document.head.append(s);
}

function el(tag, className, id) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (id) e.id = id;
  return e;
}

function button(label, onClick, className = 'btn') {
  const b = el('button', className);
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

const hex = (c) => `#${c.toString(16).padStart(6, '0')}`;

/**
 * Counters, the tool slots (one per kind: crates, signs — the rest of each kind lives behind the
 * ▾ popout), the auto-pausing menu and the end-of-level overlay.
 */
export class Hud {
  constructor(root, handlers) {
    ensureStyles();
    this.root = root;
    this.handlers = handlers;
    this.tools = handlers.tools;
    this.entries = new Map(); // tool id -> { btn, count, tool, group } (popout row)
    this.groups = []; // one slot per tool kind
    this.selected = null;
    root.innerHTML = '';

    // Stats
    this.top = el('div', 'panel', 'hud-top');
    this.title = el('h1');
    this.top.append(this.title);
    this.stats = {};
    for (const [key, label] of [
      ['pool', 'Reinforcements'],
      ['out', 'Marching'],
      ['enemies', 'Enemies'],
      ['saved', 'Saved'],
      ['lost', 'Lost'],
      ['time', 'Time'],
    ]) {
      const row = el('div', 'stat');
      const l = el('span');
      l.textContent = label;
      const v = el('span');
      row.append(l, v);
      this.top.append(row);
      this.stats[key] = v;
    }
    root.append(this.top);

    // Controls — everything that is not needed mid-assault lives in the menu.
    this.controls = el('div', 'panel', 'hud-controls');
    this.pauseBtn = button('Pause [Space]', handlers.onTogglePause);
    this.speedBtn = button('Speed 1× [F]', handlers.onCycleSpeed);
    this.isoBtn = button('Isometric [I]', handlers.onToggleIso);
    this.viewBtn = button('Reset view [V]', handlers.onResetView);
    this.menuBtn = button('Menu [M]', () => handlers.onToggleMenu?.(true));
    this.menuBtn.title = 'Restart, campaign and the level designer (pauses the assault)';
    this.controls.append(this.pauseBtn, this.speedBtn, this.isoBtn, this.viewBtn, this.menuBtn);
    root.append(this.controls);

    // Palette: one slot per kind, showing the selected tool of that kind.
    this.palette = el('div', 'panel', 'hud-palette');
    const kinds = [];
    for (const t of this.tools) if (!kinds.includes(t.kind)) kinds.push(t.kind);
    for (const kind of kinds) this.palette.append(this.buildSlot(kind));
    root.append(this.palette);

    // Hint / toast
    this.hint = el('div', 'panel', 'hud-hint');
    this.hint.tabIndex = 0; // so the clipped text can also be expanded from the keyboard
    root.append(this.hint);
    this.toast = el('div', 'panel hidden', 'hud-toast');
    root.append(this.toast);
    this.toastTimer = 0;

    // Menu (pauses the game while it is open)
    this.menu = el('div', 'hidden', 'hud-menu');
    const menuCard = el('div', 'card');
    const menuTitle = el('h2');
    menuTitle.textContent = 'Assault on hold';
    const menuText = el('p');
    menuText.textContent = 'The simulation is paused while this menu is open.';
    const menuRow = el('div', 'row');
    const close = () => handlers.onToggleMenu?.(false);
    menuRow.append(
      button('Resume [M]', close, 'btn primary'),
      button('Restart [R]', () => {
        close();
        handlers.onRestart();
      }),
      button('Campaign [C]', () => {
        close();
        handlers.onStartCampaign();
      }),
      button('Level designer [E]', () => {
        close();
        handlers.onOpenEditor();
      })
    );
    menuCard.append(menuTitle, menuText, menuRow);
    this.menu.append(menuCard);
    this.menu.addEventListener('click', (e) => {
      if (e.target === this.menu) close();
    });
    root.append(this.menu);

    // End overlay
    this.overlay = el('div', 'hidden', 'hud-overlay');
    const card = el('div', 'card');
    this.overlayTitle = el('h2');
    this.overlayText = el('p');
    this.nextBtn = button('Next level [N]', handlers.onNextLevel, 'btn primary');
    const buttons = el('div', 'row');
    buttons.append(this.nextBtn, button('Play again', handlers.onRestart));
    card.append(this.overlayTitle, this.overlayText, buttons);
    this.overlay.append(card);
    root.append(this.overlay);
  }

  // ---- tool slots ----------------------------------------------------------------

  /** The slot for one tool kind: the current tool, a ▾ button and the popout with all of them. */
  buildSlot(kind) {
    const tools = this.tools.filter((t) => t.kind === kind);
    const row = el('div', 'slot-row');
    const btn = el('button', 'tool');
    const swatch = el('span', 'swatch');
    const name = el('span');
    const count = el('span', 'count');
    btn.append(swatch, name, count);
    const more = el('button', 'btn slot-more');
    more.textContent = '▾';
    more.title = `All ${kind}s`;
    const popout = el('div', 'panel tool-popout');
    const group = { kind, tools, current: tools[0], btn, swatch, name, count, popout };

    btn.addEventListener('click', () => this.handlers.onSelectTool(group.current.id));
    more.addEventListener('click', () => this.togglePopout(group));

    for (const tool of tools) {
      const entry = el('button', 'tool');
      const sw = el('span', 'swatch');
      sw.style.background = hex(tool.color);
      const label = el('span');
      label.textContent = tool.label;
      const n = el('span', 'count');
      const key = el('span', 'count');
      key.textContent = tool.hotkey ? `[${tool.hotkey}]` : '';
      entry.append(sw, label, n, key);
      entry.addEventListener('click', () => {
        group.current = tool;
        this.closePopouts();
        this.handlers.onSelectTool(tool.id);
      });
      this.entries.set(tool.id, { btn: entry, count: n, tool, group });
      popout.append(entry);
    }

    row.append(btn, more, popout);
    this.groups.push(group);
    this.renderSlot(group, 0);
    return row;
  }

  renderSlot(group, n) {
    const t = group.current;
    group.swatch.style.background = hex(t.color);
    if (group.name.textContent !== t.label) group.name.textContent = t.label;
    const text = `×${n}`;
    if (group.count.textContent !== text) group.count.textContent = text;
    group.btn.disabled = n <= 0;
    group.btn.classList.toggle('active', this.selected === t.id);
    group.btn.title = t.hotkey ? `${t.label} [${t.hotkey}]` : t.label;
  }

  togglePopout(group) {
    const open = !group.popout.classList.contains('open');
    this.closePopouts();
    group.popout.classList.toggle('open', open);
  }

  closePopouts() {
    for (const g of this.groups) g.popout.classList.remove('open');
  }

  setTool(id) {
    this.selected = id;
    const entry = id ? this.entries.get(id) : null;
    if (entry) entry.group.current = entry.tool;
    for (const [tid, e] of this.entries) e.btn.classList.toggle('active', tid === id);
    for (const g of this.groups) g.btn.classList.toggle('active', this.selected === g.current.id);
    this.closePopouts();
  }

  // ---- state ---------------------------------------------------------------------

  setHint(text) {
    if (this.hint.textContent === text) return;
    this.hint.textContent = text;
    // Only advertise the expand affordance when the text actually got cut off.
    const clipped = this.hint.scrollWidth > this.hint.clientWidth + 1;
    this.hint.classList.toggle('clipped', clipped);
    if (clipped) this.hint.title = text;
    else this.hint.removeAttribute('title');
  }

  setPaused(paused) {
    this.pauseBtn.textContent = paused ? 'Resume [Space]' : 'Pause [Space]';
    this.pauseBtn.classList.toggle('active', paused);
  }

  setSpeed(speed) {
    this.speedBtn.textContent = `Speed ${speed}× [F]`;
  }

  setIso(on) {
    this.isoBtn.classList.toggle('active', on);
  }

  /** Show / hide the auto-pausing menu (the game does the pausing, see main.js). */
  setMenuOpen(on) {
    this.menu.classList.toggle('hidden', !on);
    if (on) this.closePopouts();
  }

  /** Hide the whole HUD (used while the level designer is open). */
  setVisible(on) {
    this.root.classList.toggle('hidden', !on);
    if (!on) this.closePopouts();
  }

  showToast(text, ms = 2000) {
    this.toast.textContent = text;
    this.toast.classList.remove('hidden');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toast.classList.add('hidden'), ms);
  }

  update(sim, budgetFor) {
    this.title.textContent = sim.level.name;
    const marching = sim.countTroops(TEAM.PLAYER);
    this.stats.pool.textContent = String(sim.pool);
    this.stats.out.textContent = String(marching);
    this.stats.enemies.textContent = String(sim.troops.length - marching + sim.guards.length);
    this.stats.saved.textContent = `${sim.saved} / ${sim.objective.required}`;
    this.stats.lost.textContent = String(sim.lost);
    this.stats.time.textContent =
      sim.timeLimit > 0
        ? `${formatTime(sim.time)} / ${formatTime(sim.timeLimit)}`
        : formatTime(sim.time);

    const counts = new Map();
    for (const tool of this.tools) {
      const n = budgetFor(tool);
      counts.set(tool.id, n);
      const entry = this.entries.get(tool.id);
      if (!entry) continue;
      const text = `×${n}`;
      if (entry.count.textContent !== text) entry.count.textContent = text;
      entry.btn.disabled = n <= 0;
    }
    for (const group of this.groups) {
      // An exhausted slot shows the next kind that still has stock (unless it is the selected one).
      if (group.current.id !== this.selected && (counts.get(group.current.id) ?? 0) <= 0) {
        const next = group.tools.find((t) => (counts.get(t.id) ?? 0) > 0);
        if (next) group.current = next;
      }
      this.renderSlot(group, counts.get(group.current.id) ?? 0);
    }
  }

  /** End-of-level card; `hasNext` shows the "Next level" button of the campaign progression. */
  showEnd(status, sim, { hasNext = false } = {}) {
    const won = status === 'won';
    this.closePopouts();
    this.overlayTitle.textContent = won ? 'Objective Secured' : 'Assault Failed';
    this.overlayText.textContent = `${won ? '' : `${sim.loseReason}. `}Saved ${sim.saved}/${sim.objective.required} · Lost ${sim.lost} · Time ${formatTime(sim.time)}`;
    this.nextBtn.classList.toggle('hidden', !(won && hasNext));
    this.overlay.classList.remove('hidden');
  }

  hideEnd() {
    this.overlay.classList.add('hidden');
  }
}
