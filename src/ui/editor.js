import { VOXEL, VOXEL_TYPES } from '../world/voxel.js';
import { Simulation } from '../simulation.js';
import { GUARD_TYPES } from '../units/guard.js';
import { EQUIPMENT, isExclusive } from '../items/equipment.js';
import { SIGNS, describeSign } from '../items/sign.js';
import { TEAM, TEAM_LABELS, otherTeam } from '../units/team.js';
import { DIRS, DIR_LABELS, dirIndexFromVector, turnLeft, turnRight } from '../units/pathing.js';
import {
  buildWorld,
  exportLevel,
  normalizeLevel,
  parseLevel,
  stringifyLevel,
  newBlankLevel,
  encodeLevelHash,
} from '../world/level-loader.js';
import {
  buildLevel,
  buildCampaignLevel,
  getGenerator,
  listGenerators,
  normalizeParams,
  resolveParams,
  DEFAULT_GENERATOR,
  CAMPAIGN_LENGTH,
} from '../world/level-builder.js';
import { RULE_DEFS } from '../rules.js';

const FACINGS = [
  { label: '+X (east)', dir: [1, 0] },
  { label: '+Z (south)', dir: [0, 1] },
  { label: '-X (west)', dir: [-1, 0] },
  { label: '-Z (north)', dir: [0, -1] },
];

const HOTKEYS = '1234567890';
const MIN_SIZE = 8;
const MAX_SIZE = 256;
const LAYOUT_STORAGE_KEY = 'level-designer.layout';
const TAB_STORAGE_KEY = 'level-designer.tab';
const MIN_PANEL = { w: 300, h: 240 }; // smallest floating panel (CSS px)
const DEFAULT_PANEL = { w: 400, h: 780 }; // preferred size when nothing is remembered
const RESIZE_DIRS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
/** Designer tabs in display order; each gets its own page under the tab bar. */
const TABS = [
  ['tools', 'Tools'],
  ['level', 'Level'],
  ['rules', 'Rules & budgets'],
  ['generate', 'Generate'],
  ['share', 'Share'],
];

/**
 * Editor palette. The team selector is a "paint": the Drop pod tool moves the player's pod or
 * adds enemy pods, and the sign / crate tools place items for whichever team is selected, so no
 * button is duplicated per team.
 */
const TOOLS = [
  ...VOXEL_TYPES.filter((t) => t.solid || t.climbable).map((t) => ({
    id: `voxel:${t.name}`,
    kind: 'voxel',
    type: t.id,
    label: t.name[0].toUpperCase() + t.name.slice(1),
    color: t.top ?? t.color,
  })),
  { id: 'erase', kind: 'erase', label: 'Erase', color: 0x2a2f3a },
  { id: 'spawn', kind: 'spawn', label: 'Drop pod', color: 0x8fd3ff },
  ...Object.entries(GUARD_TYPES).map(([type, def]) => ({
    id: `guard:${type}`,
    kind: 'guard',
    type,
    label: def.label,
    color: def.color,
  })),
  { id: 'objective', kind: 'objective', label: 'Objective zone', color: 0xffdd55 },
  ...Object.entries(SIGNS).map(([key, def]) => ({
    id: `sign:${key}`,
    kind: 'sign',
    key,
    label: def.label,
    color: def.color,
  })),
  ...Object.entries(EQUIPMENT).map(([key, def]) => ({
    id: `crate:${key}`,
    kind: 'crate',
    key,
    label: def.label,
    color: def.color,
  })),
].map((t, i) => ({ ...t, hotkey: HOTKEYS[i] ?? null }));

const DEFAULT_HINT =
  'Click a voxel face to use the selected tool. Shift-click or Box mode [B] fills between two corners. ' +
  'Q / wheel rotate facing, T switches team, right-click removes signs, crates, guards and enemy pods. ' +
  'Left-drag orbits, right-drag pans, V resets the view, P plays.';

// ---- DOM helpers ------------------------------------------------------------------------
/**
 * Layout of the floating designer window. Injected once from here so the designer is
 * self-contained; `#editor-panel` rules beat the generic `.panel` styling of the stylesheet.
 */
const EDITOR_CSS = `
.editor-floating { position: fixed; inset: 0; width: auto; height: auto; margin: 0; padding: 0;
   background: none; border: none; box-shadow: none; pointer-events: none; z-index: 20; }
.editor-floating > * { pointer-events: auto; }
#editor-panel { position: fixed; display: flex; flex-direction: column; box-sizing: border-box;
   min-width: ${MIN_PANEL.w}px; min-height: ${MIN_PANEL.h}px; max-width: none; max-height: none;
   margin: 0; padding: 0; overflow: hidden; resize: none; }
#editor-panel .editor-header { display: flex; align-items: center; gap: 8px; padding: 8px 12px;
   cursor: move; user-select: none; flex: none; border-bottom: 1px solid rgba(255,255,255,0.12); }
#editor-panel .editor-header h1 { flex: 1 1 auto; margin: 0; font-size: 15px; white-space: nowrap;
   overflow: hidden; text-overflow: ellipsis; }
#editor-panel .editor-header .row { margin: 0; flex: none; flex-wrap: nowrap; }
#editor-panel .status { margin: 6px 12px 0; flex: none; }
#editor-panel .editor-tabs { display: flex; flex-wrap: wrap; gap: 2px; padding: 6px 12px 0; flex: none;
   border-bottom: 1px solid rgba(255,255,255,0.12); }
#editor-panel .editor-tab { font: inherit; color: inherit; background: none; border: 1px solid transparent;
   border-bottom: none; border-radius: 6px 6px 0 0; padding: 5px 10px; margin-bottom: -1px; opacity: 0.7; cursor: pointer; }
#editor-panel .editor-tab:hover { opacity: 1; }
#editor-panel .editor-tab.active { opacity: 1; border-color: rgba(255,255,255,0.12);
   background: rgba(255,255,255,0.06); }
#editor-panel .editor-body { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 4px 12px 12px; }
#editor-panel .editor-page { display: none; }
#editor-panel .editor-page.active { display: block; }
#editor-panel .editor-cols { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
   column-gap: 18px; align-items: start; }
#editor-panel .editor-block { min-width: 0; }
#editor-panel .editor-block h2 { margin: 12px 0 6px; }
#editor-panel .editor-tools { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 4px; }
#editor-panel .field { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
#editor-panel .field label { flex: 1 1 auto; min-width: 0; }
#editor-panel .field input[type=number] { width: 5.5em; flex: none; }
#editor-panel textarea, #editor-panel input[type=text] { box-sizing: border-box; width: 100%; resize: vertical; }
#editor-panel .editor-resize { position: absolute; z-index: 2; }
#editor-panel .editor-resize.n, #editor-panel .editor-resize.s { left: 10px; right: 10px; height: 6px; cursor: ns-resize; }
#editor-panel .editor-resize.e, #editor-panel .editor-resize.w { top: 10px; bottom: 10px; width: 6px; cursor: ew-resize; }
#editor-panel .editor-resize.n { top: 0; }
#editor-panel .editor-resize.s { bottom: 0; }
#editor-panel .editor-resize.e { right: 0; }
#editor-panel .editor-resize.w { left: 0; }
#editor-panel .editor-resize.ne, #editor-panel .editor-resize.nw,
#editor-panel .editor-resize.se, #editor-panel .editor-resize.sw { width: 12px; height: 12px; }
#editor-panel .editor-resize.ne { top: 0; right: 0; cursor: nesw-resize; }
#editor-panel .editor-resize.nw { top: 0; left: 0; cursor: nwse-resize; }
#editor-panel .editor-resize.se { bottom: 0; right: 0; cursor: nwse-resize; }
#editor-panel .editor-resize.sw { bottom: 0; left: 0; cursor: nesw-resize; }
#editor-hint { position: fixed; left: 50%; bottom: 14px; transform: translateX(-50%);
   max-width: min(70vw, 900px); margin: 0; }
`;
function ensureStyles() {
  if (document.getElementById('editor-layout-css')) return;
  const s = el('style', null, 'editor-layout-css');
  s.textContent = EDITOR_CSS;
  document.head.append(s);
}
function readStorage(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStorage(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode / quota: simply not remembered */
  }
}
/**
 * Pointer drag on `handle`: `onStart(e)` may return false to ignore the press, `onMove(dx, dy)`
 * gets the offset from the press while the button is held, `onEnd()` runs on release.
 */
function trackPointer(handle, onStart, onMove, onEnd) {
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || onStart(e) === false) return;
    e.preventDefault();
    const x0 = e.clientX,
      y0 = e.clientY;
    handle.setPointerCapture(e.pointerId);
    const move = (ev) => onMove(ev.clientX - x0, ev.clientY - y0);
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      onEnd();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  });
}

function el(tag, className, id) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (id) e.id = id;
  return e;
}

function button(label, onClick, className = 'btn') {
  const b = el('button', className);
  b.type = 'button';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function section(title) {
  const h = el('h2');
  h.textContent = title;
  return h;
}

function field(label, control) {
  const row = el('div', 'field');
  const l = el('label');
  l.textContent = label;
  row.append(l, control);
  return row;
}

function numberInput({ min, max, step = 1 }, onChange) {
  const i = el('input');
  i.type = 'number';
  if (min !== undefined) i.min = String(min);
  if (max !== undefined) i.max = String(max);
  i.step = String(step);
  i.addEventListener('change', () => {
    let v = Number(i.value);
    if (!Number.isFinite(v)) v = min ?? 0;
    if (min !== undefined) v = Math.max(min, v);
    if (max !== undefined) v = Math.min(max, v);
    if (step === 1) v = Math.round(v);
    i.value = String(v);
    onChange(v);
  });
  return i;
}

function textInput(onChange) {
  const i = el('input');
  i.type = 'text';
  i.addEventListener('input', () => onChange(i.value));
  return i;
}

const hex = (c) => `#${c.toString(16).padStart(6, '0')}`;
const cellArr = (c) => [c.x, c.y, c.z];
const cellStr = (c) => `(${c.x}, ${c.y}, ${c.z})`;
const sameCell = (arr, c) => arr[0] === c.x && arr[1] === c.y && arr[2] === c.z;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const dirArr = (i) => [DIRS[i].dx, DIRS[i].dz];
const dirIdx = (v) => dirIndexFromVector(v[0], v[1]);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function slugify(name) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'level'
  );
}

function download(filename, text) {
  const blob = new Blob([text], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function copyText(text, fallbackArea) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    if (fallbackArea) {
      fallbackArea.value = text;
      fallbackArea.focus();
      fallbackArea.select();
    }
    return false;
  }
}

// ---- terrain helpers ----------------------------------------------------------------------

/** The solid run up from y = 0 in one column: the "ground" under that cell. */
function groundStack(world, x, z) {
  const stack = [];
  for (let y = 0; y < world.h && world.isSolid(x, y, z); y++) stack.push(world.get(x, y, z));
  return stack;
}

/** The most common ground column around the map's border — what new terrain should look like. */
function typicalGround(world) {
  const counts = new Map();
  const tally = (x, z) => {
    const k = groundStack(world, x, z).join(',');
    counts.set(k, (counts.get(k) ?? 0) + 1);
  };
  for (let x = 0; x < world.w; x++) {
    tally(x, 0);
    tally(x, world.d - 1);
  }
  for (let z = 1; z < world.d - 1; z++) {
    tally(0, z);
    tally(world.w - 1, z);
  }
  let best = '',
    bestN = -1;
  for (const [k, n] of counts)
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  return best ? best.split(',').map(Number) : [];
}

/**
 * In-browser level designer (idea.md §4.2). Owns an editable World + level metadata, shows a
 * non-ticking Simulation so pods, guards, signs, crates and the objective zone render exactly as
 * in play, and hands a validated level object back to the game on Play.
 */
export class Editor {
  /**
   * @param root      container element for the editor UI
   * @param renderer  shared Renderer (world meshes, cursor, bounds)
   * @param handlers  { onPlay(level) }
   */
  constructor(root, renderer, handlers) {
    this.root = root;
    this.renderer = renderer;
    this.handlers = handlers;
    this.level = null;
    this.world = null;
    this.sim = null;
    this.tool = TOOLS.find((t) => t.id === 'voxel:dirt') || TOOLS[0];
    this.team = TEAM.PLAYER; // the "paint" applied by the pod / sign / crate tools
    this.facing = 0; // DIRS index given to new signs and pods (Q / wheel rotates)
    this.enemyDefaults = { count: 10, rate: 2 };
    this.generatorId = DEFAULT_GENERATOR; // Generate tab: the selected generator (level-builder.js) ...
    this.genParams = {}; // ... its normalised parameters (auto values are null) ...
    this.genParamsById = {}; // ... and the parameters remembered per generator
    this.boxMode = false;
    this.pending = null; // first corner of a box / objective zone
    this.hover = null;
    this.statusTimer = 0;
    this.f = {}; // form controls
    this.toolButtons = new Map();
    this.tabButtons = new Map();
    this.pages = {}; // tab id -> page element
    this.layout = null; // floating panel geometry { x, y, w, h } in CSS px
    this.buildUI();
    this.setGenerator(DEFAULT_GENERATOR);
    this.setLayout(this.loadLayout());
    this.selectTab(readStorage(TAB_STORAGE_KEY) || TABS[0][0]);
    window.addEventListener('resize', () => this.setLayout({}));
    this.selectTool(this.tool.id);
    this.setTeam(TEAM.PLAYER);
    this.updateFacingInfo();
    this.setHint(DEFAULT_HINT);
  }

  get isOpen() {
    return !this.root.classList.contains('hidden');
  }

  // ---- lifecycle ----------------------------------------------------------------------

  /** Load a level (any valid level JSON object) into the designer. */
  open(level, { keepCamera = false } = {}) {
    const lv = normalizeLevel(level);
    this.world = buildWorld(lv);
    this.level = exportLevel(lv, this.world); // world is authoritative for voxels from now on
    this.pending = null;
    this.facing = dirIdx(lv.spawn.dir);
    if (lv.generator) this.setGenerator(lv.generator.id, lv.generator); // show the generator that made it
    if (lv.enemySpawners.length) {
      this.enemyDefaults = { count: lv.enemySpawners[0].count, rate: lv.enemySpawners[0].rate };
    }
    this.renderer.setWorld(this.world, { resetCamera: !keepCamera });
    this.renderer.setBoundsVisible(true);
    this.rebuildSim();
    this.syncForm();
    this.root.classList.remove('hidden');
    this.onHover(this.hover);
  }

  close() {
    this.root.classList.add('hidden');
    this.renderer.setBoundsVisible(false);
    this.renderer.setCursor(null);
    this.renderer.setSignPreview(null);
  }

  /** Re-create the preview simulation (never stepped) so pods / guards / signs / crates re-render. */
  rebuildSim() {
    this.sim = new Simulation(this.world, this.level);
    this.renderer.setupLevel(this.sim);
    this.updateInfo();
  }

  /** Validated deep copy of the current level, including the voxel blob. */
  currentLevel() {
    return normalizeLevel(exportLevel(this.level, this.world));
  }

  play() {
    if (!this.level) return;
    this.handlers.onPlay?.(this.currentLevel());
  }

  newLevel() {
    this.open(newBlankLevel());
    this.setStatus('Started a new blank level.');
  }
  /** Build a level from the Generate section's parameters (optionally overriding some) and load it. */
  generate(overrides = {}) {
    const gen = this.generator;
    this.genParams = normalizeParams(gen, { ...this.genParams, ...overrides });
    this.genParamsById[gen.id] = this.genParams;
    let level;
    try {
      level = buildLevel(gen, this.genParams);
    } catch (err) {
      console.error(err);
      this.setStatus(`⚠ ${gen.label}: ${err.message}`);
      this.syncGenForm();
      return;
    }
    this.open(level);
    this.setStatus(
      `Generated "${level.name}" with ${gen.label} (${level.size.join(' × ')}) — edit it or press Play.`
    );
  }
  /** Load a level of the standard progression into the designer (0-based index). */
  loadCampaignLevel(index) {
    const level = buildCampaignLevel(index);
    this.open(level);
    this.setStatus(`Loaded ${level.name} — edit it or press Play.`);
  }

  loadText(text, source = 'pasted JSON') {
    try {
      const level = parseLevel(text);
      this.open(level);
      this.setStatus(`Loaded "${level.name}" from ${source}.`);
    } catch (err) {
      console.error(err);
      this.setStatus(`⚠ ${err.message}`);
    }
  }

  // ---- UI -------------------------------------------------------------------------------

  buildUI() {
    ensureStyles();
    const root = this.root;
    root.innerHTML = '';
    root.classList.add('editor-floating'); // an inert full-screen layer; only the panels take clicks
    const panel = el('div', 'panel', 'editor-panel');
    this.panel = panel;
    const f = this.f;
    // Title bar: drag handle with the main actions, then the status line.
    const header = el('div', 'editor-header');

    const title = el('h1');
    title.textContent = 'Level Designer';

    const actions = el('div', 'row');
    actions.append(
      button('▶ Play [P]', () => this.play(), 'btn primary'),
      button('New', () => this.newLevel()),
      button('Reset view [V]', () => this.renderer.resetView())
    );
    header.append(title, actions);
    panel.append(header);

    this.status = el('div', 'status hidden');
    panel.append(this.status);

    // Tab bar and one scrolling page per tab.
    const tabs = el('div', 'editor-tabs');
    const body = el('div', 'editor-body');
    for (const [id, label] of TABS) {
      const b = el('button', 'editor-tab');
      b.type = 'button';
      b.textContent = label;
      b.addEventListener('click', () => this.selectTab(id));
      this.tabButtons.set(id, b);
      tabs.append(b);
      this.pages[id] = el('div', 'editor-page');
      body.append(this.pages[id]);
    }
    panel.append(tabs, body);
    const P = this.pages;
    /** A titled group; groups inside a `cols` container sit side by side when the panel is wide. */
    const block = (parent, heading) => {
      const b = el('div', 'editor-block');
      b.append(section(heading));
      parent.append(b);
      return b;
    };
    const cols = (parent) => {
      const c = el('div', 'editor-cols');
      parent.append(c);
      return c;
    };

    // ---- Tools tab: palette, box mode, team paint and facing --------------------------------
    const toolsBlock = block(P.tools, 'Tools');
    const grid = el('div', 'editor-tools');
    for (const tool of TOOLS) {
      const btn = el('button', 'tool');
      btn.type = 'button';
      const swatch = el('span', 'swatch');
      swatch.style.background = hex(tool.color);
      const name = el('span');
      name.textContent = tool.label;
      const key = el('span', 'count');
      key.textContent = tool.hotkey ? `[${tool.hotkey}]` : '';
      btn.append(swatch, name, key);
      btn.addEventListener('click', () => this.selectTool(tool.id));
      this.toolButtons.set(tool.id, btn);
      grid.append(btn);
    }
    toolsBlock.append(grid);
    f.box = el('input');
    f.box.type = 'checkbox';
    f.box.addEventListener('change', () => this.setBoxMode(f.box.checked));
    toolsBlock.append(field('Box mode [B] (two-corner fill)', f.box));
    this.guardInfo = el('div', 'info');
    toolsBlock.append(this.guardInfo);

    const teamBlock = block(P.tools, 'Team [T] — pods, signs & crates');
    const teamRow = el('div', 'row');
    f.teamBtns = {};
    for (const team of [TEAM.PLAYER, TEAM.ENEMY]) {
      const b = button(TEAM_LABELS[team], () => this.setTeam(team));
      f.teamBtns[team] = b;
      teamRow.append(b);
    }
    teamBlock.append(teamRow);
    const facingRow = el('div', 'row');
    this.facingInfo = el('div', 'info');
    facingRow.append(
      this.facingInfo,
      button('Rotate [Q]', () => this.rotateFacing(1))
    );
    teamBlock.append(facingRow);

    // ---- Level tab: metadata, size, pods and objective --------------------------------------
    const meta = block(P.level, 'Level');
    f.name = textInput((v) => {
      this.level.name = v;
    });
    meta.append(field('Name', f.name));
    f.description = el('textarea');
    f.description.rows = 2;
    f.description.placeholder = 'Description shown when the level starts';
    f.description.addEventListener('input', () => {
      this.level.description = f.description.value;
    });

    meta.append(f.description);

    const levelCols = cols(P.level);
    const sizeBlock = block(levelCols, 'Size (w × h × d)');
    const sizeRow = el('div', 'row');
    f.w = numberInput({ min: MIN_SIZE, max: MAX_SIZE }, () => {});
    f.h = numberInput({ min: MIN_SIZE, max: MAX_SIZE }, () => {});
    f.d = numberInput({ min: MIN_SIZE, max: MAX_SIZE }, () => {});
    sizeRow.append(
      f.w,
      f.h,
      f.d,
      button('Resize', () => this.resize())
    );
    sizeBlock.append(sizeRow);

    const podBlock = block(levelCols, 'Drop pod');
    f.count = numberInput({ min: 1, max: 500 }, (v) => {
      this.level.spawn.count = v;
    });
    podBlock.append(field('Troops', f.count));
    f.rate = numberInput({ min: 0.1, max: 30, step: 0.1 }, (v) => {
      this.level.spawn.rate = v;
    });
    podBlock.append(field('Seconds / troop', f.rate));
    f.facing = el('select');
    FACINGS.forEach((fc, i) => {
      const opt = el('option');
      opt.value = String(i);
      opt.textContent = fc.label;
      f.facing.append(opt);
    });
    f.facing.addEventListener('change', () => {
      this.level.spawn.dir = [...FACINGS[Number(f.facing.value)].dir];
      this.rebuildSim();
    });
    podBlock.append(field('Facing', f.facing));
    this.spawnInfo = el('div', 'info');
    podBlock.append(this.spawnInfo);

    const enemyBlock = block(levelCols, 'Enemy pods');
    f.enemyCount = numberInput({ min: 1, max: 500 }, (v) => {
      this.enemyDefaults.count = v;
      this.applyEnemyDefaults();
    });
    enemyBlock.append(field('Troops per pod', f.enemyCount));
    f.enemyRate = numberInput({ min: 0.1, max: 60, step: 0.1 }, (v) => {
      this.enemyDefaults.rate = v;
      this.applyEnemyDefaults();
    });
    enemyBlock.append(field('Seconds / troop', f.enemyRate));
    this.enemyInfo = el('div', 'info');
    enemyBlock.append(this.enemyInfo);

    const objBlock = block(levelCols, 'Objective (reach)');
    f.required = numberInput({ min: 1, max: 500 }, (v) => {
      this.level.objective.required = v;
    });
    objBlock.append(field('Troops required', f.required));
    this.objInfo = el('div', 'info');
    objBlock.append(this.objInfo);

    // ---- Rules & budgets tab ----------------------------------------------------------------
    const rulesCols = cols(P.rules);
    const rulesBlock = block(rulesCols, 'Rules');
    f.lethalFall = numberInput({ min: 1, max: 64 }, (v) => {
      this.level.lethalFall = v;
    });
    rulesBlock.append(field('Lethal fall (voxels)', f.lethalFall));
    f.timeLimit = numberInput({ min: 0, max: 3600 }, (v) => {
      this.level.timeLimit = v;
    });
    rulesBlock.append(field('Time limit (s, 0 = none)', f.timeLimit));
    // Tunable stats (rules.js), one block per group: hit points, kits, guard scaling, exclusivity flags.
    f.rules = {};
    const ruleBlocks = { Rules: rulesBlock };
    for (const r of RULE_DEFS) {
      const g = r.group || 'Rules';
      if (!ruleBlocks[g]) ruleBlocks[g] = block(rulesCols, g);
      let i;
      if (r.type === 'boolean') {
        i = el('input');
        i.type = 'checkbox';
        i.addEventListener('change', () => {
          this.level.rules[r.key] = i.checked;
        });
      } else {
        i = numberInput({ min: r.min, max: r.max, step: r.step }, (v) => {
          this.level.rules[r.key] = v;
        });
      }
      f.rules[r.key] = i;
      ruleBlocks[g].append(field(r.label, i));
    }

    f.budget = { crates: {}, signs: {}, roles: {} };
    const crateBlock = block(rulesCols, 'Player budget — crates');
    for (const [key, def] of Object.entries(EQUIPMENT)) {
      const i = numberInput({ min: 0, max: 99 }, (v) => {
        this.level.budget.crates[key] = v;
      });
      f.budget.crates[key] = i;
      crateBlock.append(field(def.label, i));
    }
    const signBlock = block(rulesCols, 'Player budget — signs');
    for (const [key, def] of Object.entries(SIGNS)) {
      const i = numberInput({ min: 0, max: 99 }, (v) => {
        this.level.budget.signs[key] = v;
      });
      f.budget.signs[key] = i;
      signBlock.append(field(def.label, i));
    }
    // Roles are no longer placed by the player: the Builder comes out of the Builder Crate above,
    // and legacy `budget.roles` entries are folded into the crate budget by the level loader.

    // ---- Generate tab: pluggable generators (docs/generators.md) and the campaign -------------
    const genCols = cols(P.generate);
    const genBlock = block(genCols, 'Generator');
    f.generator = el('select');
    for (const g of listGenerators()) {
      const opt = el('option');
      opt.value = g.id;
      opt.textContent = g.label;
      f.generator.append(opt);
    }
    f.generator.addEventListener('change', () => this.setGenerator(f.generator.value));
    genBlock.append(field('Generator', f.generator));
    this.genDescription = el('div', 'info');
    genBlock.append(this.genDescription);
    // One field per declared parameter; rebuilt by setGenerator() from the generator's schema.
    this.genFields = el('div');
    genBlock.append(this.genFields);
    f.gen = {};
    f.genLabels = {};
    const genRow = el('div', 'row');
    f.randomSeed = button('Random seed', () => this.randomSeed());
    genRow.append(
      button('Generate', () => this.generate()),
      f.randomSeed,
      button('Auto values', () => this.resetAutoParams())
    );
    genBlock.append(genRow);

    const campaignBlock = block(genCols, 'Campaign');
    f.campaign = el('select');
    for (let i = 0; i < CAMPAIGN_LENGTH; i++) {
      const opt = el('option');
      opt.value = String(i);
      opt.textContent = `Campaign level ${i + 1}`;
      f.campaign.append(opt);
    }
    const campaignRow = el('div', 'row');
    campaignRow.append(
      f.campaign,
      button('Load', () => this.loadCampaignLevel(Number(f.campaign.value)))
    );
    campaignBlock.append(campaignRow);
    const genInfo = el('div', 'info');
    genInfo.textContent =
      'Values marked (auto) are derived by the generator until you type one ("Auto values" hands them back). ' +
      'The same generator and parameters always give the same level; the campaign is built with the Siege ' +
      'generator. New generators: src/world/generators/ and docs/generators.md.';
    P.generate.append(genInfo);

    // ---- Share tab: export / import ---------------------------------------------------------
    const exportBlock = block(P.share, 'Export');
    const exportRow = el('div', 'row');
    exportRow.append(
      button('Download JSON', () => this.downloadJSON()),
      button('Copy JSON', () => this.copyJSON()),
      button('Copy play link', () => this.copyLink())
    );
    exportBlock.append(exportRow);

    const importBlock = block(P.share, 'Import');
    f.file = el('input');
    f.file.type = 'file';
    f.file.accept = '.json,application/json';
    f.file.classList.add('hidden');
    f.file.addEventListener('change', async () => {
      const file = f.file.files?.[0];
      if (!file) return;
      this.loadText(await file.text(), file.name);
      f.file.value = '';
    });
    importBlock.append(f.file);

    f.paste = el('textarea');
    f.paste.rows = 5;
    f.paste.placeholder = 'Paste level JSON here…';
    importBlock.append(f.paste);
    const importRow = el('div', 'row');
    importRow.append(
      button('Load pasted JSON', () => this.loadText(f.paste.value)),
      button('Load file…', () => f.file.click())
    );
    importBlock.append(importRow);

    // ---- floating window: drag by the title bar, resize from any edge or corner ---------------
    let start = null;
    trackPointer(
      header,
      (e) => {
        if (e.target.closest('button, input, select, textarea')) return false;
        start = { ...this.layout };
      },
      (dx, dy) => this.setLayout({ x: start.x + dx, y: start.y + dy }),
      () => this.setLayout({}, { save: true })
    );
    for (const dir of RESIZE_DIRS) {
      const handle = el('div', `editor-resize ${dir}`);
      trackPointer(
        handle,
        () => {
          start = { ...this.layout };
        },
        (dx, dy) => this.resizeFrom(start, dir, dx, dy),
        () => this.setLayout({}, { save: true })
      );
      panel.append(handle);
    }

    root.append(panel);

    this.hint = el('div', 'panel', 'editor-hint');
    root.append(this.hint);
  }
  // ---- floating panel -------------------------------------------------------------------
  selectTab(id) {
    if (!this.pages[id]) id = TABS[0][0];
    this.tab = id;
    for (const [tid, b] of this.tabButtons) b.classList.toggle('active', tid === id);
    for (const [pid, page] of Object.entries(this.pages))
      page.classList.toggle('active', pid === id);
    writeStorage(TAB_STORAGE_KEY, id);
  }
  /** Remembered panel geometry, or a default docked to the top-right of the viewport. */
  loadLayout() {
    let saved = null;
    try {
      saved = JSON.parse(readStorage(LAYOUT_STORAGE_KEY));
    } catch {
      /* ignore corrupt data */
    }
    const w = Math.min(DEFAULT_PANEL.w, window.innerWidth - 32);
    const h = Math.min(DEFAULT_PANEL.h, window.innerHeight - 32);
    const def = { x: window.innerWidth - w - 16, y: 16, w, h };
    return saved && typeof saved === 'object' ? { ...def, ...saved } : def;
  }
  /** Apply (part of) a geometry, keeping the whole panel inside the viewport. */
  setLayout(patch, { save = false } = {}) {
    const L = { ...this.layout, ...patch };
    const vw = window.innerWidth,
      vh = window.innerHeight;
    L.w = clamp(Math.round(L.w) || DEFAULT_PANEL.w, MIN_PANEL.w, Math.max(MIN_PANEL.w, vw));
    L.h = clamp(Math.round(L.h) || DEFAULT_PANEL.h, MIN_PANEL.h, Math.max(MIN_PANEL.h, vh));
    L.x = clamp(Math.round(L.x) || 0, 0, Math.max(0, vw - L.w));
    L.y = clamp(Math.round(L.y) || 0, 0, Math.max(0, vh - L.h));
    this.layout = L;
    const s = this.panel.style;
    s.left = `${L.x}px`;
    s.top = `${L.y}px`;
    s.width = `${L.w}px`;
    s.height = `${L.h}px`;
    if (save) writeStorage(LAYOUT_STORAGE_KEY, JSON.stringify(L));
  }
  /** Resize from edge / corner `dir` ('n', 'se', ...) by a pointer offset, anchoring the opposite side. */
  resizeFrom(start, dir, dx, dy) {
    let { x, y, w, h } = start;
    if (dir.includes('e')) w += dx;
    if (dir.includes('s')) h += dy;
    if (dir.includes('w')) {
      w = clamp(w - dx, MIN_PANEL.w, start.x + start.w); // never push the left edge off-screen
      x = start.x + start.w - w;
    }
    if (dir.includes('n')) {
      h = clamp(h - dy, MIN_PANEL.h, start.y + start.h);
      y = start.y + start.h - h;
    }
    this.setLayout({ x, y, w, h });
  }

  syncForm() {
    const L = this.level,
      f = this.f;
    f.name.value = L.name;
    f.description.value = L.description;
    this.syncGenForm();
    if (L.campaign && Number.isInteger(L.campaign.index))
      f.campaign.value = String(L.campaign.index);
    [f.w.value, f.h.value, f.d.value] = L.size.map(String);
    f.count.value = String(L.spawn.count);
    f.rate.value = String(L.spawn.rate);
    const facing = FACINGS.findIndex(
      (fc) => fc.dir[0] === L.spawn.dir[0] && fc.dir[1] === L.spawn.dir[1]
    );
    f.facing.value = String(facing < 0 ? 0 : facing);
    f.enemyCount.value = String(this.enemyDefaults.count);
    f.enemyRate.value = String(this.enemyDefaults.rate);
    f.required.value = String(L.objective.required);
    f.lethalFall.value = String(L.lethalFall);
    f.timeLimit.value = String(L.timeLimit);
    for (const r of RULE_DEFS) {
      if (r.type === 'boolean') f.rules[r.key].checked = !!L.rules[r.key];
      else f.rules[r.key].value = String(L.rules[r.key]);
    }
    for (const k of Object.keys(f.budget.crates))
      f.budget.crates[k].value = String(L.budget.crates[k] ?? 0);
    for (const k of Object.keys(f.budget.signs))
      f.budget.signs[k].value = String(L.budget.signs[k] ?? 0);
    for (const k of Object.keys(f.budget.roles))
      f.budget.roles[k].value = String(L.budget.roles[k] ?? 0);
    f.box.checked = this.boxMode;
    this.updateFacingInfo();
    this.updateInfo();
  }
  // ---- generators -----------------------------------------------------------------------
  /** The generator selected on the Generate tab. */
  get generator() {
    return getGenerator(this.generatorId);
  }
  /**
   * Select a generator and rebuild its parameter form from its schema. `params` seeds the form
   * (e.g. `level.generator` of a loaded level); otherwise the values last used for it come back.
   */
  setGenerator(id, params) {
    let gen;
    try {
      gen = getGenerator(id);
    } catch (err) {
      if (id !== undefined) {
        console.warn(err);
        this.setStatus(`⚠ ${err.message} — using the default generator.`);
      }
      gen = getGenerator(DEFAULT_GENERATOR);
    }
    this.generatorId = gen.id;
    this.genParams = normalizeParams(gen, params ?? this.genParamsById[gen.id] ?? {});
    this.genParamsById[gen.id] = this.genParams;
    this.f.generator.value = gen.id;
    this.genDescription.textContent = gen.description || '';
    this.f.randomSeed.disabled = !gen.params.some((d) => d.key === 'seed');
    this.buildGenFields(gen);
    this.syncGenForm();
  }
  /** One form control per parameter definition, by type (generator.d.ts `ParamDef`). */
  buildGenFields(gen) {
    const f = this.f;
    f.gen = {};
    f.genLabels = {};
    this.genFields.innerHTML = '';
    for (const def of gen.params) {
      // Typing into an auto field makes it explicit; "Auto values" hands it back to the generator.
      const set = (v) => {
        this.genParams[def.key] = v;
        this.syncGenForm();
      };
      let input;
      if (def.type === 'boolean') {
        input = el('input');
        input.type = 'checkbox';
        input.addEventListener('change', () => set(input.checked));
      } else if (def.type === 'select') {
        input = el('select');
        for (const o of def.options) {
          const opt = el('option');
          opt.value = String(o.value);
          opt.textContent = o.label ?? String(o.value);
          input.append(opt);
        }
        input.addEventListener('change', () => set(input.value));
      } else if (def.type === 'string') {
        input = textInput(set);
      } else {
        input = numberInput(
          { min: def.min, max: def.max, step: def.step ?? (def.type === 'int' ? 1 : 'any') },
          set
        );
      }
      const row = field(def.label, input);
      if (def.help) {
        input.title = def.help;
        row.firstChild.title = def.help;
      }
      f.gen[def.key] = input;
      f.genLabels[def.key] = row.firstChild;
      this.genFields.append(row);
    }
  }
  /** Show the generator inputs; auto parameters display their derived value and are labelled (auto). */
  syncGenForm() {
    const gen = this.generator;
    const resolved = resolveParams(gen, this.genParams);
    for (const def of gen.params) {
      const input = this.f.gen[def.key];
      if (!input) continue;
      const v = resolved[def.key];
      if (def.type === 'boolean') {
        input.checked = !!v;
      } else {
        const s = v === null || v === undefined ? '' : String(v);
        if (input.value !== s) input.value = s; // only touch the control when needed (keeps the caret)
      }
      const auto = !!def.auto && this.genParams[def.key] === null;
      this.f.genLabels[def.key].textContent = auto ? `${def.label} (auto)` : def.label;
    }
  }
  resetAutoParams() {
    for (const def of this.generator.params) if (def.auto) this.genParams[def.key] = null;
    this.syncGenForm();
  }
  /** Generate with a fresh random seed (generators expose that as a parameter with the key `seed`). */
  randomSeed() {
    const gen = this.generator;
    const def = gen.params.find((d) => d.key === 'seed');
    if (!def) {
      this.setStatus(`${gen.label} has no seed parameter.`);
      return;
    }
    const lo = def.min ?? 0,
      hi = def.max ?? 999999;
    this.generate({ seed: lo + Math.floor(Math.random() * (hi - lo + 1)) });
  }

  updateInfo() {
    if (!this.level) return;
    const L = this.level;
    const s = L.spawn.pos,
      o = L.objective;
    this.spawnInfo.textContent = `Pod at (${s.join(', ')}) — Drop pod tool with the Player team moves it.`;
    this.enemyInfo.textContent =
      `${plural(L.enemySpawners.length, 'enemy pod')} — Drop pod tool with the Enemy team adds one; right-click removes. ` +
      'Enemy columns follow enemy signs and crates and fight your troops.';
    this.objInfo.textContent = `Zone (${o.from.join(', ')}) → (${o.to.join(', ')}) — Objective tool: click two corners.`;
    this.guardInfo.textContent = `${plural(L.guards.length, 'guard')}, ${plural(L.signs.length, 'sign')}, ${plural(L.crates.length, 'crate')} placed — right-click any of them to remove it.`;
  }

  updateFacingInfo() {
    this.facingInfo.textContent = `Facing ${DIR_LABELS[this.facing]} — for signs and pods (Q / wheel)`;
  }

  setStatus(text) {
    this.status.textContent = text;
    this.status.classList.remove('hidden');
    clearTimeout(this.statusTimer);
    this.statusTimer = setTimeout(() => this.status.classList.add('hidden'), 6000);
  }

  setHint(text) {
    if (this.hint.textContent !== text) this.hint.textContent = text;
  }

  selectTool(id) {
    this.tool = TOOLS.find((t) => t.id === id) || this.tool;
    this.pending = null;
    for (const [tid, btn] of this.toolButtons) btn.classList.toggle('active', tid === this.tool.id);
    this.onHover(this.hover);
  }

  setTeam(team) {
    this.team = team;
    for (const [t, b] of Object.entries(this.f.teamBtns)) b.classList.toggle('active', t === team);
    this.onHover(this.hover);
  }

  rotateFacing(steps = 1) {
    this.facing = steps < 0 ? turnLeft(this.facing) : turnRight(this.facing);
    this.updateFacingInfo();
    this.onHover(this.hover);
  }

  setBoxMode(on) {
    this.boxMode = on;
    this.f.box.checked = on;
    this.pending = null;
    this.onHover(this.hover);
  }

  // ---- export helpers -------------------------------------------------------------------

  downloadJSON() {
    const level = this.currentLevel();
    download(`${slugify(level.name)}.json`, stringifyLevel(level));
    this.setStatus(`Downloaded ${slugify(level.name)}.json`);
  }

  async copyJSON() {
    const ok = await copyText(stringifyLevel(this.currentLevel()), this.f.paste);
    this.setStatus(
      ok
        ? 'Level JSON copied to clipboard.'
        : 'Clipboard unavailable — JSON placed in the text box below.'
    );
  }

  async copyLink() {
    const url = new URL(location.href);
    url.search = '';
    url.hash = `level=${encodeLevelHash(this.currentLevel())}`;
    const ok = await copyText(url.toString(), this.f.paste);
    const kb = (url.toString().length / 1024).toFixed(1);
    this.setStatus(
      ok
        ? `Play link copied (${kb} KB). Add &edit to the hash to open it in the designer.`
        : 'Clipboard unavailable — link placed in the text box below.'
    );
  }

  // ---- level operations -----------------------------------------------------------------

  resize() {
    const w = clamp(Math.round(Number(this.f.w.value)) || MIN_SIZE, MIN_SIZE, MAX_SIZE);
    const h = clamp(Math.round(Number(this.f.h.value)) || MIN_SIZE, MIN_SIZE, MAX_SIZE);
    const d = clamp(Math.round(Number(this.f.d.value)) || MIN_SIZE, MIN_SIZE, MAX_SIZE);
    const old = this.world;
    const ground = typicalGround(old);
    this.world = old.resized(w, h, d);
    // Newly exposed columns get the map's typical ground stack so nothing marches into a void;
    // everything outside the new bounds has already been dropped by resized().
    let filled = 0;
    for (let z = 0; z < d; z++) {
      for (let x = 0; x < w; x++) {
        if (x < old.w && z < old.d) continue;
        for (let y = 0; y < Math.min(ground.length, h); y++) this.world.set(x, y, z, ground[y]);
        filled++;
      }
    }
    const L = this.level;
    L.size = [w, h, d];
    const max = [w - 1, h - 1, d - 1];
    const inb = (p) => p.every((v, i) => v >= 0 && v <= max[i]);
    L.spawn.pos = L.spawn.pos.map((v, i) => clamp(v, 0, max[i]));
    L.objective.from = L.objective.from.map((v, i) => clamp(v, 0, max[i]));
    L.objective.to = L.objective.to.map((v, i) => clamp(v, 0, max[i]));
    L.guards = L.guards.filter((g) => inb(g.pos));
    L.enemySpawners = L.enemySpawners.filter((s) => inb(s.pos));
    L.signs = L.signs.filter((s) => inb(s.pos));
    L.crates = L.crates.filter((c) => inb(c.pos));
    this.pending = null;
    this.renderer.setWorld(this.world, { resetCamera: true });
    this.rebuildSim();
    this.syncForm();
    this.setStatus(
      `Resized to ${w} × ${h} × ${d}${filled ? ` — ground added under ${filled} new columns` : ''}.`
    );
  }

  applyEnemyDefaults() {
    for (const sp of this.level.enemySpawners) {
      sp.count = this.enemyDefaults.count;
      sp.rate = this.enemyDefaults.rate;
    }
    this.rebuildSim();
  }

  toggleGuard(c, type = 'sentry') {
    const i = this.level.guards.findIndex((g) => sameCell(g.pos, c));
    if (i >= 0) {
      this.level.guards.splice(i, 1);
    } else {
      const f = this.level.spawn.dir;
      this.level.guards.push({ type, pos: cellArr(c), dir: [-f[0], -f[1]] });
    }
    this.rebuildSim();
  }

  toggleEnemySpawner(c) {
    const L = this.level;
    const i = L.enemySpawners.findIndex((s) => sameCell(s.pos, c));
    if (i >= 0) L.enemySpawners.splice(i, 1);
    else
      L.enemySpawners.push({
        pos: cellArr(c),
        dir: dirArr(this.facing),
        count: this.enemyDefaults.count,
        rate: this.enemyDefaults.rate,
      });
    this.rebuildSim();
  }

  signAt(c) {
    return this.level.signs.find((s) => sameCell(s.pos, c)) || null;
  }
  crateAt(c) {
    return this.level.crates.find((cr) => sameCell(cr.pos, c)) || null;
  }
  guardAt(c) {
    return this.level.guards.find((g) => sameCell(g.pos, c)) || null;
  }
  spawnerAt(c) {
    return this.level.enemySpawners.find((s) => sameCell(s.pos, c)) || null;
  }

  /** Air cell with solid ground below — where signs and crates may sit. */
  isFloor(c) {
    const w = this.world;
    return (
      w.inBounds(c.x, c.y, c.z) &&
      w.get(c.x, c.y, c.z) === VOXEL.AIR &&
      w.isSolid(c.x, c.y - 1, c.z)
    );
  }

  /** Label of the level item (sign, crate, guard, enemy pod) occupying `c`, or null. */
  itemLabelAt(c) {
    const s = this.signAt(c);
    if (s) return `${TEAM_LABELS[s.team]} ${SIGNS[s.kind].label}`;
    const cr = this.crateAt(c);
    if (cr) return `${TEAM_LABELS[cr.team]} ${EQUIPMENT[cr.kind].label}`;
    const g = this.guardAt(c);
    if (g) return GUARD_TYPES[g.type].label;
    if (this.spawnerAt(c)) return 'enemy pod';
    return null;
  }

  /** Removes whatever level item occupies `c`. Returns its label, or null when there was none. */
  removeItemAt(c) {
    const label = this.itemLabelAt(c);
    if (!label) return null;
    const L = this.level;
    L.signs = L.signs.filter((s) => !sameCell(s.pos, c));
    L.crates = L.crates.filter((cr) => !sameCell(cr.pos, c));
    L.guards = L.guards.filter((g) => !sameCell(g.pos, c));
    L.enemySpawners = L.enemySpawners.filter((s) => !sameCell(s.pos, c));
    this.rebuildSim();
    return label;
  }

  /** Place / rotate / remove a sign or crate of the selected team with the current tool. */
  placeItem(c) {
    const t = this.tool,
      L = this.level;
    if (!this.isFloor(c)) {
      this.setStatus(`${t.label}s need an air cell with solid ground below.`);
      return;
    }
    const isSign = t.kind === 'sign';
    const list = isSign ? L.signs : L.crates;
    const i = list.findIndex((it) => sameCell(it.pos, c));
    const existing = i >= 0 ? list[i] : null;
    if (existing && existing.kind === t.key && existing.team === this.team) {
      // Same item again: rotate a directional sign, otherwise toggle it away.
      if (isSign && SIGNS[t.key].directional)
        existing.dir = dirArr(turnRight(dirIdx(existing.dir)));
      else list.splice(i, 1);
    } else {
      const item = isSign
        ? { kind: t.key, pos: cellArr(c), dir: dirArr(this.facing), team: this.team }
        : { kind: t.key, pos: cellArr(c), team: this.team };
      if (i >= 0) list[i] = item;
      else list.push(item);
      // One item per cell: a sign replaces a crate there and vice versa.
      const other = isSign ? L.crates : L.signs;
      const j = other.findIndex((it) => sameCell(it.pos, c));
      if (j >= 0) other.splice(j, 1);
    }
    this.rebuildSim();
  }

  /** Which cell a tool acts on: erase removes the hit voxel, everything else uses the air cell on its face. */
  targetCell(hit) {
    if (hit.type === 'sign') {
      const s = this.sim ? this.sim.signById(hit.id) : null;
      return s ? { ...s.cell } : null;
    }
    if (hit.type === 'unit') return hit.unit ? { ...hit.unit.cell } : null;
    return this.tool.kind === 'erase' ? hit.cell : hit.adjacent;
  }

  /** The cell a level item under this hit would occupy (items live in the air cell above a face). */
  itemCell(hit) {
    if (hit.type === 'voxel') return hit.adjacent;
    return this.targetCell(hit);
  }

  inBounds(c) {
    return !!c && this.world.inBounds(c.x, c.y, c.z);
  }

  // ---- input ------------------------------------------------------------------------------

  onHover(hit) {
    this.hover = hit;
    if (!this.world || !this.isOpen) return;
    const r = this.renderer;
    const t = this.tool;
    r.setSignPreview(null); // re-shown below when a sign is about to be planted

    if (!hit) {
      r.setCursor(null);
      this.setHint(DEFAULT_HINT);
      return;
    }
    if (hit.type === 'unit') {
      const g = hit.batch === 'guards' ? hit.unit : null;
      if (g) {
        r.setCursor(g.cell, 0xff6a6a);
        this.setHint(
          `${g.def.label} at ${cellStr(g.cell)} — right-click removes it${t.kind === 'guard' ? ' (click toggles)' : ''}`
        );
      } else {
        r.setCursor(null);
        this.setHint('Click a voxel face');
      }
      return;
    }
    if (hit.type === 'sign') {
      const target = this.targetCell(hit);
      const s = target ? this.signAt(target) : null;
      if (!s) {
        r.setCursor(null);
        return;
      }
      const def = SIGNS[s.kind];
      const desc = `${TEAM_LABELS[s.team]} ${def.label}${def.directional ? ` facing ${DIR_LABELS[dirIdx(s.dir)]}` : ''}`;
      r.setCursor(target, t.color);
      const same = t.kind === 'sign' && s.kind === t.key && s.team === this.team;
      if (same && def.directional)
        this.setHint(
          `${desc} at ${cellStr(target)} — click or wheel rotates it, right-click removes`
        );
      else
        this.setHint(
          `${desc} at ${cellStr(target)} — right-click removes${t.kind === 'sign' || t.kind === 'crate' ? ', click replaces' : ''}`
        );
      return;
    }

    const target = this.targetCell(hit);
    if (!this.inBounds(target)) {
      r.setCursor(null);
      this.setHint('Outside the level bounds — resize the level to grow the map');
      return;
    }
    const c = cellStr(target);
    if (this.pending) {
      r.setCursor(this.pending, t.color, target);
      this.setHint(`${t.label}: click to fill ${cellStr(this.pending)} → ${c} (Esc cancels)`);
      return;
    }
    r.setCursor(target, t.color);
    const corner = this.boxMode ? ' — first corner' : '';
    const team = TEAM_LABELS[this.team].toLowerCase();
    const facing = `facing ${DIR_LABELS[this.facing]} (Q / wheel rotates)`;
    switch (t.kind) {
      case 'voxel':
        this.setHint(`Place ${t.label} at ${c}${corner}`);
        break;
      case 'erase': {
        const item = this.boxMode ? null : this.itemLabelAt(hit.adjacent);
        this.setHint(
          item ? `Remove the ${item} at ${cellStr(hit.adjacent)}` : `Erase voxel at ${c}${corner}`
        );
        break;
      }
      case 'spawn':
        if (this.team === TEAM.ENEMY) {
          this.setHint(
            this.spawnerAt(target)
              ? `Remove the enemy pod at ${c}`
              : `Place an enemy pod at ${c} ${facing}`
          );
        } else {
          this.setHint(`Move the drop pod to ${c} ${facing}`);
        }
        break;
      case 'guard':
        this.setHint(
          this.guardAt(target)
            ? `Remove the guard at ${c}`
            : `Place a ${t.label.toLowerCase()} at ${c}`
        );
        break;
      case 'objective':
        this.setHint(`Objective zone: click the first corner at ${c}`);
        break;
      case 'sign': {
        const def = SIGNS[t.key];
        const s = this.signAt(target);
        if (!this.isFloor(target)) {
          r.setCursor(target, 0xff6a6a);
          this.setHint(`${t.label}: needs an air cell with solid ground below`);
        } else if (s && s.kind === t.key && s.team === this.team) {
          this.setHint(
            def.directional
              ? `Rotate the ${team} ${t.label} at ${c} (right-click removes)`
              : `Remove the ${team} ${t.label} at ${c}`
          );
        } else {
          const verb = s || this.crateAt(target) ? 'Replace with' : 'Plant';
          r.setSignPreview(t.key, target, this.facing, true);
          this.setHint(
            `${verb} a ${team} ${t.label} at ${c}${def.directional ? ` ${facing}` : ''} — ${describeSign(t.key, this.facing)}`
          );
        }
        break;
      }
      case 'crate': {
        const cr = this.crateAt(target);
        if (!this.isFloor(target)) {
          r.setCursor(target, 0xff6a6a);
          this.setHint(`${t.label}: needs an air cell with solid ground below`);
        } else if (cr && cr.kind === t.key && cr.team === this.team) {
          this.setHint(`Remove the ${team} ${t.label} at ${c}`);
        } else {
          const verb = cr || this.signAt(target) ? 'Replace with' : 'Drop';
          const stack = isExclusive(t.key, this.level.rules)
            ? ''
            : ' (stackable: even equipped troops take it)';
          const cap = EQUIPMENT[t.key].capacity ?? this.level.rules.crateCapacity;
          this.setHint(
            `${verb} a ${team} ${t.label} at ${c} — the first ${cap} ${team} troops over it take its contents${stack}`
          );
        }
        break;
      }
      default:
        break;
    }
  }

  onClick(hit, e) {
    if (!hit || !this.world) return;
    const t = this.tool;

    if (hit.type === 'unit') {
      if (hit.batch === 'guards' && t.kind === 'guard' && hit.unit)
        this.toggleGuard(hit.unit.cell, t.type);
      this.onHover(hit);
      return;
    }
    const target = this.targetCell(hit);
    if (!this.inBounds(target)) {
      this.setStatus('That cell is outside the level bounds.');
      return;
    }
    if (hit.type === 'sign') {
      if (t.kind === 'erase') {
        const label = this.removeItemAt(target);
        if (label) this.setStatus(`Removed ${label}.`);
      } else if (t.kind === 'sign' || t.kind === 'crate') {
        this.placeItem(target);
      } else {
        this.setStatus('Right-click removes a sign; click a voxel face to build.');
      }
      this.onHover(hit);
      return;
    }

    switch (t.kind) {
      case 'voxel':
      case 'erase': {
        const type = t.kind === 'erase' ? VOXEL.AIR : t.type;
        if (this.boxMode || e?.shiftKey || this.pending) {
          if (!this.pending) {
            this.pending = target;
            break;
          }
          this.world.fill(cellArr(this.pending), cellArr(target), type);
          this.pending = null;
        } else if (t.kind === 'erase' && this.itemLabelAt(hit.adjacent)) {
          this.setStatus(`Removed ${this.removeItemAt(hit.adjacent)}.`); // an item on the face beats the voxel
        } else {
          this.world.set(target.x, target.y, target.z, type);
        }
        break;
      }
      case 'spawn':
        if (this.team === TEAM.ENEMY) {
          this.toggleEnemySpawner(target);
        } else {
          this.level.spawn.pos = cellArr(target);
          this.level.spawn.dir = dirArr(this.facing);
          this.rebuildSim();
          this.syncForm();
        }
        break;
      case 'guard':
        this.toggleGuard(target, t.type);
        break;
      case 'objective': {
        if (!this.pending) {
          this.pending = target;
          break;
        }
        const a = this.pending,
          b = target;
        this.level.objective.from = [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.min(a.z, b.z)];
        this.level.objective.to = [Math.max(a.x, b.x), Math.max(a.y, b.y), Math.max(a.z, b.z)];
        this.pending = null;
        this.rebuildSim();
        break;
      }
      case 'sign':
      case 'crate':
        this.placeItem(target);
        break;
      default:
        break;
    }
    this.updateInfo();
    this.onHover(hit);
  }

  /** Right-click removes the sign / crate / guard / enemy pod under the cursor. */
  onRightClick(hit) {
    if (!hit || !this.world) return;
    const c = hit.type === 'unit' ? (hit.unit ? hit.unit.cell : null) : this.itemCell(hit);
    if (!c) return;
    const label = this.removeItemAt(c);
    if (label) this.setStatus(`Removed ${label} at ${cellStr(c)}.`);
    this.onHover(hit);
  }

  /**
   * Mouse wheel rotates facing while a directional sign tool or the Drop pod tool is selected
   * (an existing sign of the same kind under the cursor is rotated in place). Otherwise it zooms.
   */
  onWheel(hit, steps) {
    const t = this.tool;
    const rotates = (t.kind === 'sign' && SIGNS[t.key].directional) || t.kind === 'spawn';
    if (!rotates || !this.world) return false;
    if (steps) {
      const cell = hit && hit.type !== 'unit' ? this.itemCell(hit) : null;
      const s = cell && t.kind === 'sign' ? this.signAt(cell) : null;
      if (s && s.kind === t.key && s.team === this.team) {
        const d = dirIdx(s.dir);
        s.dir = dirArr(steps > 0 ? turnRight(d) : turnLeft(d));
        this.rebuildSim();
        this.onHover(hit);
      } else {
        this.rotateFacing(steps);
      }
    }
    return true;
  }

  /** Returns true when the key was consumed by the editor. */
  onKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    const tool = TOOLS.find((t) => t.hotkey === e.key);
    if (tool) {
      this.selectTool(tool.id);
      return true;
    }
    switch (e.code) {
      case 'Escape':
        this.pending = null;
        this.onHover(this.hover);
        return true;
      case 'KeyB':
        this.setBoxMode(!this.boxMode);
        return true;
      case 'KeyP':
        this.play();
        return true;
      case 'KeyQ':
        this.rotateFacing(1);
        return true;
      case 'KeyT':
        this.setTeam(otherTeam(this.team));
        return true;
      default:
        return false;
    }
  }
}
