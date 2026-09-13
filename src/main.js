import { Renderer } from './engine/renderer.js';
import { Input } from './engine/input.js';
import { loadLevel, buildWorld, decodeLevelHash } from './world/level-loader.js';
import { buildCampaignLevel, CAMPAIGN_LENGTH } from './world/level-builder.js';
import { Simulation, GAME_STATUS } from './simulation.js';
import { Hud } from './ui/hud.js';
import { Editor } from './ui/editor.js';
import { EQUIPMENT } from './items/equipment.js';
import { SIGNS, describeSign } from './items/sign.js';
import { ROLES } from './units/roles/index.js';
import { TEAM } from './units/team.js';
import { DIR_LABELS, turnLeft, turnRight } from './units/pathing.js';

// Fixed-timestep simulation decoupled from the render frame rate (idea.md §6).
const FIXED_DT = 1 / 60;
const MAX_STEPS_PER_FRAME = 8;
const SPEEDS = [1, 2, 4];
const DEFAULT_LEVEL_URL = new URL('./levels/tutorial-outpost.json', import.meta.url);

const MODE = Object.freeze({ PLAY: 'play', EDIT: 'edit' });

/** Player palette: crates, then signs, then roles — hotkeys along the number row (1..9, 0, -, =) in that order. */
const HOTKEYS = '1234567890-=[';
const TOOLS = [
  ...Object.entries(EQUIPMENT).map(([key, def]) => ({ id: `crate:${key}`, kind: 'crate', key, label: def.label, color: def.color })),
  ...Object.entries(SIGNS).map(([key, def]) => ({ id: `sign:${key}`, kind: 'sign', key, label: def.label, color: def.color })),
  ...Object.entries(ROLES).map(([key, role]) => ({ id: `role:${key}`, kind: 'role', key, label: role.label, color: role.color })),
].map((t, i) => ({ ...t, hotkey: HOTKEYS[i] ?? null }));
const HOTKEY_RANGE = `${TOOLS[0].hotkey}…${TOOLS.filter((t) => t.hotkey).pop().hotkey}`;

const DEFAULT_HINT =
    `Pick a tool (${HOTKEY_RANGE}), then click the map — even through a crowd. Q / mouse wheel rotate the sign you are about to plant (its ghost shows where troops will go); ` +
   'right-click or shift-click a placed sign to pick it up, or a builder to pause / resume it. V resets the view, E opens the level designer, C starts the campaign.';

/**
 * Startup options from the page URL:
 *   ?level=<url>     fetch a level JSON file (relative or absolute URL)
 *   #level=<data>    play a level embedded in the URL (created by the designer's "Copy play link")
  *   ?campaign=<n>    play level n (1-based) of the generated campaign
 *   ?edit  /  #edit  open the level designer instead of playing
 */
function readStartupOptions() {
  const query = new URLSearchParams(location.search);
  const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
  return {
    levelUrl: query.get('level'),
    levelData: hash.get('level'),
     campaign: query.get('campaign') ?? hash.get('campaign'),
    edit: query.has('edit') || hash.has('edit'),
  };
}

class Game {
  constructor(appRoot, hudRoot, editorRoot) {
    this.renderer = new Renderer(appRoot);
    this.hud = new Hud(hudRoot, {
      tools: TOOLS,
      onSelectTool: (id) => this.selectTool(this.tool && this.tool.id === id ? null : id),
      onRestart: () => this.reset({ keepCamera: true }),
      onTogglePause: () => this.togglePause(),
      onToggleIso: () => this.toggleIso(),
      onCycleSpeed: () => this.cycleSpeed(),
      onOpenEditor: () => this.openEditor(),
      onRotateSign: () => this.rotateSignDir(1),
      onResetView: () => this.renderer.resetView(),
       onStartCampaign: () => this.startCampaign(),
       onNextLevel: () => this.playNextCampaignLevel(),
    });
    this.editor = new Editor(editorRoot, this.renderer, {
      onPlay: (level) => this.playLevel(level, { keepCamera: true }),
    });
    this.input = new Input(this.renderer, {
      onClick: (hit, e) => this.onClick(hit, e),
      onRightClick: (hit, e) => this.onRightClick(hit, e),
      onHover: (hit) => this.onHover(hit),
      onKey: (e) => this.onKey(e),
      onWheel: (hit, steps) => this.onWheel(hit, steps),
    });

    this.mode = MODE.PLAY;
    this.level = null;
    this.world = null;
    this.sim = null;
    this.tool = null;
    this.hover = null;
    this.paused = false;
    this.speedIndex = 0;
    this.iso = false;
    this.accumulator = 0;
    this.lastTime = performance.now();
    this.ended = false;
    this.signDir = 0; // facing given to the next sign placed (DIRS index)

    this.hud.setHint(DEFAULT_HINT);
  }

  async start() {
    const opts = readStartupOptions();
    let level = null;
    let warning = null;
    try {
      if (opts.levelData) level = decodeLevelHash(opts.levelData);
      else if (opts.levelUrl) level = await loadLevel(new URL(opts.levelUrl, location.href));
       else if (opts.campaign !== null) {
         const n = Number(opts.campaign);
         if (!Number.isInteger(n) || n < 1 || n > CAMPAIGN_LENGTH) {
           throw new Error(`campaign must be a number between 1 and ${CAMPAIGN_LENGTH}`);
         }
         level = buildCampaignLevel(n - 1);
       }
    } catch (err) {
      console.error(err);
      warning = `Could not load the requested level: ${err.message}. Loaded the tutorial instead.`;
    }
    this.level = level || (await loadLevel(DEFAULT_LEVEL_URL));

    if (opts.edit) this.openEditor();
    else this.reset();
    if (warning) this.notify(warning, 8000);
    requestAnimationFrame((t) => this.loop(t));
  }

  notify(text, ms = 3000) {
    if (this.mode === MODE.EDIT) this.editor.setStatus(text);
    else this.hud.showToast(text, ms);
  }

  reset({ keepCamera = false } = {}) {
    this.world = buildWorld(this.level);
    this.sim = new Simulation(this.world, this.level);
    this.renderer.setWorld(this.world, { resetCamera: !keepCamera });
    this.renderer.setupLevel(this.sim);
    this.accumulator = 0;
    this.ended = false;
    this.paused = false;
    this.signDir = this.sim.spawn.dir;
    this.hud.setSignDir(DIR_LABELS[this.signDir]);
    this.hud.hideEnd();
    this.hud.setPaused(false);
    this.hud.showToast(this.level.description || `Level: ${this.level.name}`, 6000);
  }

  // ---- modes ----------------------------------------------------------------------

  /** Play any (validated) level object — used by the designer's Play button. */
  playLevel(level, { keepCamera = false } = {}) {
    this.level = level;
    this.mode = MODE.PLAY;
    this.editor.close();
    this.hud.setVisible(true);
    this.hud.setHint(DEFAULT_HINT);
    this.reset({ keepCamera });
  }

  openEditor() {
    if (this.mode === MODE.EDIT) return;
    this.mode = MODE.EDIT;
    this.selectTool(null);
    this.renderer.setCursor(null);
     this.renderer.setSignPreview(null);
    this.hud.setVisible(false);
    this.editor.open(this.level, { keepCamera: !!this.sim });
  }
   /** Index of the campaign level after the current one, or null when this is not a campaign level / it is the last. */
   get nextCampaignIndex() {
     const c = this.level && this.level.campaign;
     if (!c || !Number.isInteger(c.index)) return null;
     return c.index + 1 < CAMPAIGN_LENGTH ? c.index + 1 : null;
   }
   /** Play a level of the generated standard progression (0-based). */
   startCampaign(index = 0) {
     this.playLevel(buildCampaignLevel(index));
   }
   playNextCampaignLevel() {
     const next = this.nextCampaignIndex;
     if (next === null) { this.hud.showToast('That was the last campaign level — the tower is yours!', 3000); return; }
     this.startCampaign(next);
   }


  // ---- frame ----------------------------------------------------------------------

  loop(now) {
    requestAnimationFrame((t) => this.loop(t));
    const frameDt = Math.min(0.1, (now - this.lastTime) / 1000);
    this.lastTime = now;

    const editing = this.mode === MODE.EDIT;
    const sim = editing ? this.editor.sim : this.sim;
    const world = editing ? this.editor.world : this.world;

    if (!editing) {
      if (!this.paused) this.accumulator += frameDt * SPEEDS[this.speedIndex];
      let steps = 0;
      while (this.accumulator >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
        sim.step(FIXED_DT);
        this.accumulator -= FIXED_DT;
        steps++;
      }
      if (steps === MAX_STEPS_PER_FRAME) this.accumulator = 0; // drop backlog instead of spiralling
    }

    if (world) this.renderer.syncWorld(world);
    if (sim) {
      this.renderer.syncUnits(sim);
      this.renderer.consumeEvents(sim.events);
      sim.events.length = 0;
    }
    this.renderer.update(frameDt);
    this.renderer.render();

    if (editing || !sim) return;
    this.hud.update(sim, (tool) => sim.budgetFor(tool.kind, tool.key));
    if (sim.status !== GAME_STATUS.PLAYING && !this.ended) {
      this.ended = true;
      this.selectTool(null);
       this.hud.showEnd(sim.status, sim, { hasNext: this.nextCampaignIndex !== null });
    }
  }

  // ---- player interaction -------------------------------------------------

  selectTool(id) {
    this.tool = id ? TOOLS.find((t) => t.id === id) || null : null;
    this.hud.setTool(this.tool ? this.tool.id : null);
    if (this.mode === MODE.PLAY) this.onHover(this.hover);
  }

  /** Rotate the facing given to the next sign: clockwise for positive steps. */
  rotateSignDir(steps = 1) {
    this.signDir = steps < 0 ? turnLeft(this.signDir) : turnRight(this.signDir);
    this.hud.setSignDir(DIR_LABELS[this.signDir]);
    this.hud.showToast(`Next sign faces ${DIR_LABELS[this.signDir]}.`, 1200);
    this.onHover(this.hover);
  }

  /**
   * The walkable cell an item would go on for this hit: the air cell on top of a floor voxel, the
   * cell a troop stands in (so crowded areas can still be managed), or a placed sign's cell.
   */
  floorCellFromHit(hit) {
    if (!hit || !this.sim) return null;
    if (hit.type === 'voxel') return hit.normal.y > 0.5 ? hit.adjacent : null;
    if (hit.type === 'unit') return hit.batch === 'troops' && hit.unit && hit.unit.alive ? { ...hit.unit.cell } : null;
    if (hit.type === 'sign') {
      const s = this.sim.signById(hit.id);
      return s ? s.cell : null;
    }
    return null;
  }

  findTroopFromHit(hit) {
    if (!hit || !this.sim) return null;
    if (hit.type === 'unit') {
      const u = hit.unit;
      return hit.batch === 'troops' && u && u.alive && u.team === TEAM.PLAYER ? u : null;
    }
    if (hit.type === 'voxel') return this.sim.troopAt(hit.adjacent, TEAM.PLAYER) || this.sim.troopAt(hit.cell, TEAM.PLAYER);
    return null;
  }

  /** Any sign under the cursor (either team): hit directly, or standing on the cell that was hit. */
  signFromHit(hit) {
    if (!hit || !this.sim) return null;
    if (hit.type === 'sign') return this.sim.signById(hit.id);
    const cell = this.floorCellFromHit(hit);
    return cell ? this.sim.signAt(cell) : null;
  }

  /** A sign under the cursor the player owns (and may rotate / pick up). */
  ownSignFromHit(hit) {
    const s = this.signFromHit(hit);
    return s && s.team === TEAM.PLAYER ? s : null;
  }

  signSummary(sign) {
    const facing = sign.def.directional ? ` facing ${DIR_LABELS[sign.dir]}` : '';
    return `${sign.def.label}${facing}`;
  }
  /** "Builder — 7 planks left" / "Builder (paused) — 7 planks left" for a troop with an active or paused role. */
  roleSummary(troop) {
    const role = troop.role || (troop.suspended && troop.suspended.role);
    if (!role) return '';
    const data = troop.role ? troop.roleData : troop.suspended.data;
    const progress = role.progress ? ` — ${role.progress(data)}` : '';
    return `${role.label}${troop.role ? '' : ' (paused)'}${progress}`;
  }


  onHover(hit) {
    if (this.mode === MODE.EDIT) { this.editor.onHover(hit); return; }
    this.hover = hit;
     this.renderer.setSignPreview(null); // re-shown below when a sign is about to be planted
    const sim = this.sim;
    if (!hit || !sim || sim.status !== GAME_STATUS.PLAYING) {
      this.renderer.setCursor(null);
      this.hud.setHint(DEFAULT_HINT);
      return;
    }
    const sign = this.signFromHit(hit);
    const own = !!sign && sign.team === TEAM.PLAYER;
    const cell = this.floorCellFromHit(hit);

    if (!this.tool) {
      const worker = this.findTroopFromHit(hit);
      if (worker && (worker.role || worker.suspended)) {
        this.renderer.setCursor(worker.cell, 0xffd75a);
        this.hud.setHint(`Troop #${worker.id}: ${this.roleSummary(worker)} — right-click or shift-click ${worker.role ? 'pauses' : 'resumes'} it`);
      } else if (sign) {
        this.renderer.setCursor(sign.cell, own ? 0xffd75a : 0xff6a6a);
        this.hud.setHint(own
          ? `${this.signSummary(sign)} — ${describeSign(sign.kind, sign.dir)}. Q / wheel rotates, right-click or shift-click picks it up`
          : `Enemy ${this.signSummary(sign)} — steers the enemy column only`);
      } else {
        this.renderer.setCursor(null);
        this.hud.setHint(DEFAULT_HINT);
      }
      return;
    }

    const label = this.tool.label;
    if (this.tool.kind === 'crate') {
      if (cell) {
        const ok = sim.canPlaceCrate(this.tool.key, cell);
        this.renderer.setCursor(cell, ok ? 0x7cff7c : 0xff6a6a);
        this.hud.setHint(ok ? `Place ${label} here` : `Can't place ${label} here`);
      } else {
        this.renderer.setCursor(null);
        this.hud.setHint(`Click the top of a floor voxel (or a troop standing on it) to drop a ${label}`);
      }
    } else if (this.tool.kind === 'sign') {
      const def = SIGNS[this.tool.key];
      if (sign) {
        if (own && sign.kind === this.tool.key && sign.def.directional) {
          this.renderer.setCursor(sign.cell, 0xffd75a);
          this.hud.setHint(`Click or wheel to rotate this ${this.signSummary(sign)}; right-click or shift-click picks it up`);
        } else if (own) {
          this.renderer.setCursor(sign.cell, 0xff6a6a);
          this.hud.setHint(`${sign.def.label} here — right-click or shift-click to pick it up`);
        } else {
          this.renderer.setCursor(sign.cell, 0xff6a6a);
          this.hud.setHint(`Enemy ${sign.def.label} here — it is part of the level`);
        }
      } else if (cell) {
        const ok = sim.canPlaceSign(this.tool.key, cell);
        this.renderer.setCursor(cell, ok ? 0x7cff7c : 0xff6a6a);
         this.renderer.setSignPreview(this.tool.key, cell, this.signDir, ok);
        const facing = def.directional ? ` facing ${DIR_LABELS[this.signDir]} (Q / wheel rotates)` : '';
        this.hud.setHint(ok ? `Place ${label} here${facing} — ${describeSign(this.tool.key, this.signDir)}` : `Can't place ${label} here`);
      } else {
        this.renderer.setCursor(null);
        this.hud.setHint(`Click the top of a floor voxel (or a troop standing on it) to plant a ${label}`);
      }
    } else {
      const troop = this.findTroopFromHit(hit);
      if (troop) {
        this.renderer.setCursor(troop.cell, 0xffd75a);
        const resume = troop.suspended && troop.suspended.role === ROLES[this.tool.key];
        this.hud.setHint(resume
          ? `Resume ${this.roleSummary(troop)} on troop #${troop.id} (no cost)`
          : `Assign ${label} to troop #${troop.id}`);
      } else {
        this.renderer.setCursor(null);
        this.hud.setHint(`Click a troop (or the voxel it stands on) to make it a ${label}`);
      }
    }
  }

  onClick(hit, e) {
    if (this.mode === MODE.EDIT) { this.editor.onClick(hit, e); return; }
    const sim = this.sim;
    if (!hit || !sim || sim.status !== GAME_STATUS.PLAYING) return;
    if (e && e.shiftKey) { if (!this.toggleRoleFromHit(hit)) this.pickUpSign(hit); return; }
    if (!this.tool) {
       this.hud.showToast(`Select a tool first (keys ${HOTKEY_RANGE}). Right-click or shift-click a sign to pick it up.`, 2000);
      return;
    }
    const cell = this.floorCellFromHit(hit);
    let placed = false;
    if (this.tool.kind === 'crate') {
      if (cell) placed = sim.placeCrate(this.tool.key, cell);
      if (!placed) this.hud.showToast(`Can't place a ${this.tool.label} there.`, 1500);
    } else if (this.tool.kind === 'sign') {
      const sign = this.signFromHit(hit);
      if (sign) {
        if (sign.team !== TEAM.PLAYER) this.hud.showToast('That is an enemy sign — it belongs to the level.', 2000);
        else if (sign.kind === this.tool.key && sign.def.directional) sim.rotateSign(sign, 1);
        else this.hud.showToast(`There is already a ${sign.def.label} here — right-click or shift-click to pick it up.`, 2000);
      } else if (cell) {
        placed = sim.placeSign(this.tool.key, cell, this.signDir);
        if (!placed) this.hud.showToast(`Can't plant a ${this.tool.label} there.`, 1500);
      } else {
        this.hud.showToast('Click the top of a floor voxel to plant a sign.', 1500);
      }
    } else {
      const troop = this.findTroopFromHit(hit);
      placed = troop ? sim.assignRole(troop, this.tool.key) : false;
      if (!placed) this.hud.showToast(troop ? `Can't assign ${this.tool.label} right now.` : 'No troop there.', 1500);
    }
    if (placed && sim.budgetFor(this.tool.kind, this.tool.key) <= 0) this.selectTool(null);
    this.onHover(hit);
  }

  onRightClick(hit) {
    if (this.mode === MODE.EDIT) { this.editor.onRightClick(hit); return; }
    if (!this.toggleRoleFromHit(hit)) this.pickUpSign(hit);
  }
  /**
   * Right-click / shift-click on a troop with a job: pause it (it marches on, keeping its
   * planks) or resume a paused one. Returns false when there was no such troop under the cursor.
   */
  toggleRoleFromHit(hit) {
    const sim = this.sim;
    if (!hit || !sim || sim.status !== GAME_STATUS.PLAYING) return false;
    const troop = this.findTroopFromHit(hit);
    if (!troop || !(troop.role || troop.suspended)) return false;
    const result = sim.toggleRole(troop);
    if (result) this.hud.showToast(`Troop #${troop.id}: ${this.roleSummary(troop)} — ${result}.`, 1500);
    else this.hud.showToast(`Can't change troop #${troop.id}'s job right now.`, 1500);
    this.onHover(hit);
    return true;
  }


  /**
   * Mouse wheel: rotates the sign under the cursor (with no tool or a sign tool selected) or the
   * facing of the next sign (with a directional sign tool selected). Otherwise it zooms.
   */
  onWheel(hit, steps) {
    if (this.mode === MODE.EDIT) return this.editor.onWheel(hit, steps);
    const sim = this.sim;
    if (!sim || sim.status !== GAME_STATUS.PLAYING) return false;
    const sign = this.ownSignFromHit(hit);
    if (sign && sign.def.directional && (!this.tool || this.tool.kind === 'sign')) {
      if (steps) { sim.rotateSign(sign, steps); this.onHover(hit); }
      return true;
    }
    if (this.tool && this.tool.kind === 'sign' && SIGNS[this.tool.key].directional) {
      if (steps) this.rotateSignDir(steps);
      return true;
    }
    return false;
  }

  /** Signs go back to the inventory at no cost. */
  pickUpSign(hit) {
    const sim = this.sim;
    if (!hit || !sim || sim.status !== GAME_STATUS.PLAYING) return;
    const sign = this.signFromHit(hit);
    if (!sign) { this.hud.showToast('No sign there to pick up.', 1500); return; }
    if (sign.team !== TEAM.PLAYER) { this.hud.showToast('Enemy signs cannot be picked up.', 1500); return; }
    sim.pickUpSign(sign);
    this.signDir = sign.dir; // re-placing it keeps the facing unless you rotate
    this.hud.setSignDir(DIR_LABELS[this.signDir]);
    this.hud.showToast(`${sign.def.label} returned to inventory.`, 1500);
    this.onHover(hit);
  }

  onKey(e) {
    if (this.mode === MODE.EDIT) {
      if (this.editor.onKey(e)) return;
      if (e.code === 'KeyI') this.toggleIso();
      if (e.code === 'KeyV') this.renderer.resetView();
      return;
    }
     const tool = TOOLS.find((t) => t.hotkey && t.hotkey === e.key);
    if (tool) { this.selectTool(this.tool && this.tool.id === tool.id ? null : tool.id); return; }
    switch (e.code) {
      case 'Escape': this.selectTool(null); break;
      case 'Space': e.preventDefault(); this.togglePause(); break;
      case 'KeyF': this.cycleSpeed(); break;
      case 'KeyI': this.toggleIso(); break;
      case 'KeyV': this.renderer.resetView(); break;
      case 'KeyR': this.reset({ keepCamera: true }); break;
      case 'KeyE': this.openEditor(); break;
       case 'KeyC': this.startCampaign(); break;
       case 'KeyN':
         if (this.ended && this.sim && this.sim.status === GAME_STATUS.WON) this.playNextCampaignLevel();
         break;
      case 'KeyQ': {
        // Rotate the sign under the cursor when there is one, else the next sign's facing.
        const sign = this.ownSignFromHit(this.hover);
        if (this.sim && sign && sign.def.directional && (!this.tool || this.tool.kind === 'sign')) {
          this.sim.rotateSign(sign, 1);
          this.onHover(this.hover);
        } else {
          this.rotateSignDir(1);
        }
        break;
      }
      default: break;
    }
  }

  togglePause() {
    this.paused = !this.paused;
    this.hud.setPaused(this.paused);
  }

  cycleSpeed() {
    this.speedIndex = (this.speedIndex + 1) % SPEEDS.length;
    this.hud.setSpeed(SPEEDS[this.speedIndex]);
  }

  toggleIso() {
    this.iso = !this.iso;
    this.renderer.setIsometric(this.iso);
    this.hud.setIso(this.iso);
  }
}

const game = new Game(
  document.getElementById('app'),
  document.getElementById('hud'),
  document.getElementById('editor'),
);
game.start().catch((err) => {
  console.error(err);
  document.getElementById('hud').innerHTML =
    `<div class="panel" style="top:12px;left:12px">Failed to start: ${err.message}<br>` +
    'Serve this folder over HTTP (e.g. <code>npx serve .</code>) — ES modules and level fetching do not work from file://.</div>';
});