/**
 * Software renderer for level thumbnails — no WebGL, no three.js, no npm dependencies.
 *
 *   renderIso(level, world)  isometric view of the voxel diorama (top / +x / +z faces, culled
 *                            like the in-game chunk mesher) with the objective volume and small
 *                            marker cubes for the pods, guards, signs and crates
 *   renderTop(level, world)  top-down map: the highest solid voxel per column, shaded by height,
 *                            with the same markers
 *   encodePNG(w, h, rgba)    minimal PNG encoder (8-bit RGBA, zlib from node:zlib)
 */
import { deflateSync } from 'node:zlib';
import { voxelInfo, isSolid, isClimbable } from '../src/world/voxel.js';
import { GUARD_TYPES } from '../src/units/guard.js';
import { SIGNS } from '../src/items/sign.js';
import { EQUIPMENT } from '../src/items/equipment.js';
import { TEAM } from '../src/units/team.js';

const BACKGROUND = 0x1a2130;
const OBJECTIVE_COLOR = 0xffdd55;
const POD_COLORS = { [TEAM.PLAYER]: 0x8fd3ff, [TEAM.ENEMY]: 0xff8a6a };

// ---- PNG ------------------------------------------------------------------------------------

const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** Encode an RGBA buffer (row-major, 4 bytes per pixel) as a PNG file. */
export function encodePNG(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- canvas ---------------------------------------------------------------------------------

function shade(hex, k) {
  const ch = (v) => Math.max(0, Math.min(255, Math.round(v * k)));
  return (ch((hex >> 16) & 255) << 16) | (ch((hex >> 8) & 255) << 8) | ch(hex & 255);
}

class Canvas {
  constructor(w, h, bg = BACKGROUND) {
    this.w = Math.max(1, Math.round(w));
    this.h = Math.max(1, Math.round(h));
    this.px = Buffer.alloc(this.w * this.h * 4);
    for (let i = 0; i < this.w * this.h; i++) {
      this.px[i * 4] = (bg >> 16) & 255;
      this.px[i * 4 + 1] = (bg >> 8) & 255;
      this.px[i * 4 + 2] = bg & 255;
      this.px[i * 4 + 3] = 255;
    }
  }

  blend(x, y, r, g, b, a) {
    const i = (y * this.w + x) * 4;
    this.px[i] = Math.round(this.px[i] * (1 - a) + r * a);
    this.px[i + 1] = Math.round(this.px[i + 1] * (1 - a) + g * a);
    this.px[i + 2] = Math.round(this.px[i + 2] * (1 - a) + b * a);
    this.px[i + 3] = 255;
  }

  /** Axis-aligned rectangle (float corners, pixel-centre sampling). */
  fillRect(x, y, w, h, hex, alpha = 1) {
    this.fillPoly([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], hex, alpha);
  }

  /** Convex polygon by scanline, sampling pixel centres so adjacent faces tile without seams. */
  fillPoly(points, hex, alpha = 1) {
    const n = points.length;
    let minY = Infinity, maxY = -Infinity;
    for (const [, y] of points) { if (y < minY) minY = y; if (y > maxY) maxY = y; }
    const y0 = Math.max(0, Math.ceil(minY - 0.5)), y1 = Math.min(this.h - 1, Math.floor(maxY - 0.5));
    const r = (hex >> 16) & 255, g = (hex >> 8) & 255, b = hex & 255;
    for (let y = y0; y <= y1; y++) {
      const yc = y + 0.5;
      let xa = Infinity, xb = -Infinity;
      for (let i = 0; i < n; i++) {
        const [px, py] = points[i], [qx, qy] = points[(i + 1) % n];
        if ((py <= yc && yc < qy) || (qy <= yc && yc < py)) {
          const x = px + ((yc - py) * (qx - px)) / (qy - py);
          if (x < xa) xa = x;
          if (x > xb) xb = x;
        }
      }
      if (xa > xb) continue;
      const x0 = Math.max(0, Math.ceil(xa - 0.5)), x1 = Math.min(this.w - 1, Math.floor(xb - 0.5));
      for (let x = x0; x <= x1; x++) this.blend(x, y, r, g, b, alpha);
    }
  }
}

// ---- markers --------------------------------------------------------------------------------

/** Every entity of the level as { x, y, z, color, label } (positions are the air cells they occupy). */
export function collectMarkers(level) {
  const list = [];
  const add = (pos, color, label) => list.push({ x: pos[0], y: pos[1], z: pos[2], color, label });
  add(level.spawn.pos, POD_COLORS[TEAM.PLAYER], 'drop pod');
  for (const sp of level.enemySpawners || []) add(sp.pos, POD_COLORS[TEAM.ENEMY], 'enemy pod');
  for (const g of level.guards || []) add(g.pos, GUARD_TYPES[g.type]?.color ?? 0xd24a4a, g.type);
  for (const s of level.signs || []) add(s.pos, SIGNS[s.kind]?.color ?? 0xffffff, `${s.kind} sign`);
  for (const c of level.crates || []) add(c.pos, EQUIPMENT[c.kind]?.color ?? 0xffffff, `${c.kind} crate`);
  return list;
}

const inObjective = (o, x, y, z) =>
  !!o && x >= o.from[0] && x <= o.to[0] && y >= o.from[1] && y <= o.to[1] && z >= o.from[2] && z <= o.to[2];

// ---- isometric view ---------------------------------------------------------------------------

/**
 * Isometric render (camera above the +x/+z corner). `scale` is the pixel width of one voxel
 * face edge; a 40×14×16 level at scale 6 gives a 360×276 image.
 */
export function renderIso(level, world, { scale = 6 } = {}) {
  const s = scale;
  const W = world.w, H = world.h, D = world.d;
  const pad = 2 * s;
  const ox = D * s + pad, oy = H * s + pad;
  const cv = new Canvas((W + D) * s + 2 * pad, (W + D) * s * 0.5 + H * s + 2 * pad);
  const P = (x, y, z) => [ox + (x - z) * s, oy + (x + z) * s * 0.5 - y * s];
  const solidAt = (x, y, z) => world.inBounds(x, y, z) && world.isSolid(x, y, z); // out of bounds = air (outer walls show)

  // faces bitmask: 1 = top, 2 = +x, 4 = +z
  const cube = (x, y, z, hex, { inset = 0, top = hex, faces = 7, alpha = 1, light = 1 } = {}) => {
    const a = inset, b = 1 - inset;
    if (faces & 1) cv.fillPoly([P(x + a, y + b, z + a), P(x + b, y + b, z + a), P(x + b, y + b, z + b), P(x + a, y + b, z + b)], shade(top, light), alpha);
    if (faces & 2) cv.fillPoly([P(x + b, y + a, z + a), P(x + b, y + b, z + a), P(x + b, y + b, z + b), P(x + b, y + a, z + b)], shade(hex, 0.82 * light), alpha);
    if (faces & 4) cv.fillPoly([P(x + a, y + a, z + b), P(x + a, y + b, z + b), P(x + b, y + b, z + b), P(x + b, y + a, z + b)], shade(hex, 0.68 * light), alpha);
  };

  const markers = new Map();
  for (const m of collectMarkers(level)) markers.set(`${m.x},${m.y},${m.z}`, m);
  const o = level.objective;

  // Painter's order: by depth (x + z), then bottom to top.
  for (let d = 0; d <= W + D - 2; d++) {
    for (let y = 0; y < H; y++) {
      for (let x = Math.max(0, d - D + 1); x <= Math.min(W - 1, d); x++) {
        const z = d - x;
        const t = world.get(x, y, z);
        const checker = (x + y + z) & 1 ? 1 : 0.92;
        if (isSolid(t)) {
          const info = voxelInfo(t);
          let faces = 0;
          if (!solidAt(x, y + 1, z)) faces |= 1;
          if (!solidAt(x + 1, y, z)) faces |= 2;
          if (!solidAt(x, y, z + 1)) faces |= 4;
          if (faces) cube(x, y, z, info.color, { top: info.top ?? info.color, faces, light: checker });
        } else if (isClimbable(t)) {
          cube(x, y, z, voxelInfo(t).color, { inset: 0.3, light: checker });
        }
        if (!isSolid(t) && inObjective(o, x, y, z)) {
          cv.fillPoly([P(x, y, z), P(x + 1, y, z), P(x + 1, y, z + 1), P(x, y, z + 1)], OBJECTIVE_COLOR, 0.45);
        }
        const m = markers.get(`${x},${y},${z}`);
        if (m) cube(x, y, z, m.color, { inset: 0.22, light: 1.1 });
      }
    }
  }
  return cv;
}

// ---- top-down map -----------------------------------------------------------------------------

/** Top-down map: highest solid voxel per column shaded by height, objective and markers overlaid. */
export function renderTop(level, world, { scale = 6 } = {}) {
  const s = scale;
  const W = world.w, H = world.h, D = world.d;
  const cv = new Canvas(W * s, D * s);
  const o = level.objective;
  for (let z = 0; z < D; z++) {
    for (let x = 0; x < W; x++) {
      let top = -1;
      for (let y = H - 1; y >= 0; y--) if (world.isSolid(x, y, z)) { top = y; break; }
      if (top >= 0) {
        const info = voxelInfo(world.get(x, top, z));
        const k = (0.45 + 0.55 * (top / Math.max(1, H - 1))) * ((x + z) & 1 ? 1 : 0.94);
        cv.fillRect(x * s, z * s, s, s, shade(info.top ?? info.color, k));
      }
      for (let y = top + 1; y < H; y++) {
        if (isClimbable(world.get(x, y, z))) { cv.fillRect(x * s + s * 0.3, z * s, s * 0.4, s, voxelInfo(world.get(x, y, z)).color); break; }
      }
      for (let y = 0; y < H; y++) {
        if (inObjective(o, x, y, z) && !world.isSolid(x, y, z)) { cv.fillRect(x * s, z * s, s, s, OBJECTIVE_COLOR, 0.45); break; }
      }
    }
  }
  const inset = Math.max(1, s * 0.2);
  for (const m of collectMarkers(level)) cv.fillRect(m.x * s + inset, m.z * s + inset, s - 2 * inset, s - 2 * inset, m.color);
  return cv;
}

/** Both thumbnails as PNG buffers, keyed by file suffix. */
export function renderThumbnails(level, world, opts = {}) {
  const iso = renderIso(level, world, opts);
  const top = renderTop(level, world, opts);
  return {
    'iso.png': encodePNG(iso.w, iso.h, iso.px),
    'top.png': encodePNG(top.w, top.h, top.px),
  };
}