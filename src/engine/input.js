import * as THREE from 'three';

const CLICK_DRAG_THRESHOLD = 6; // px — anything further is an orbit/pan, not a click
const WHEEL_NOTCH = 40; // accumulated wheel pixels per rotation step (trackpads send many tiny deltas)

/**
 * Mouse/keyboard input with raycasting into the voxel grid, instanced units and signs.
 * Hits look like:
 *   { type: 'voxel', cell, adjacent, normal, point }  — cell = solid voxel hit,
 *                                                       adjacent = air cell on the hit face
 *   { type: 'unit', batch: 'troops'|'guards', index, unit, point } — instanced unit under the cursor
 *                                                       (unit = the sim object, resolved via the batch)
 *   { type: 'sign', id, point }                        — a placed sign
 * When nothing solid is hit, the y = 0 ground plane inside the level bounds is used as a
 * virtual floor (cell.y = -1) so the editor can paint on empty maps.
 *
 * Handlers: onClick(hit, e) for left clicks, onRightClick(hit, e) for right clicks, onHover,
 * onKey, and onWheel(hit, steps, e) where steps is -1 / 0 / +1 per accumulated notch. When
 * onWheel returns true the event is consumed and no longer zooms the camera.
 */
export class Input {
  constructor(renderer, handlers) {
    this.renderer = renderer;
    this.handlers = handlers;
    this.raycaster = new THREE.Raycaster();
    this.ndc = new THREE.Vector2();
    this.down = null;
    this.wheelAcc = 0;
    this.wheelTime = 0;

    const dom = renderer.gl.domElement;
    dom.addEventListener('pointerdown', (e) => {
      this.down = { x: e.clientX, y: e.clientY, button: e.button };
    });
    dom.addEventListener('pointerup', (e) => {
      if (!this.down) return;
      const moved = Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y);
      const button = this.down.button;
      this.down = null;
      if (moved >= CLICK_DRAG_THRESHOLD) return; // that was a camera drag
      const hit = this.pick(e);
      if (button === 0) handlers.onClick?.(hit, e);
      else if (button === 2) handlers.onRightClick?.(hit, e);
    });
    dom.addEventListener('pointermove', (e) => {
      if (this.down) return; // dragging the camera
      handlers.onHover?.(this.pick(e), e);
    });
    dom.addEventListener('pointerleave', () => handlers.onHover?.(null));
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
    // Capture on the container so this runs before OrbitControls' zoom handler on the canvas.
    renderer.container.addEventListener('wheel', (e) => this.onWheel(e), {
      capture: true,
      passive: false,
    });
    window.addEventListener('keydown', (e) => {
      const t = e.target;
      if (
        t instanceof HTMLInputElement ||
        t instanceof HTMLTextAreaElement ||
        t instanceof HTMLSelectElement ||
        t?.isContentEditable
      )
        return;
      handlers.onKey?.(e);
    });
  }

  onWheel(e) {
    if (!this.handlers.onWheel) return;
    const now = performance.now();
    if (now - this.wheelTime > 400) this.wheelAcc = 0;
    this.wheelTime = now;
    const scale = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1; // lines / pages -> pixels
    this.wheelAcc += e.deltaY * scale;
    let steps = 0;
    if (Math.abs(this.wheelAcc) >= WHEEL_NOTCH) {
      steps = Math.sign(this.wheelAcc);
      this.wheelAcc = 0;
    }
    if (this.handlers.onWheel(this.pick(e), steps, e)) {
      e.preventDefault();
      e.stopPropagation();
    } else {
      this.wheelAcc = 0;
    }
  }

  pick(event) {
    const dom = this.renderer.gl.domElement;
    const rect = dom.getBoundingClientRect();
    this.ndc.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
    this.raycaster.setFromCamera(this.ndc, this.renderer.camera);
    const hits = this.raycaster.intersectObjects(this.renderer.pickables(), false);
    if (!hits.length) return this.pickGround();
    const hit = hits[0];
    const obj = hit.object;

    if (obj.isInstancedMesh) {
      return {
        type: 'unit',
        batch: obj.userData.batch,
        index: hit.instanceId,
        unit: obj.userData.units?.[hit.instanceId] ?? null,
        point: hit.point,
      };
    }
    if (obj.userData.signId !== undefined) {
      return { type: 'sign', id: obj.userData.signId, point: hit.point };
    }

    const n = hit.face.normal; // chunk meshes are untransformed, so object space == world space
    const p = hit.point;
    const cell = {
      x: Math.floor(p.x - n.x * 0.5),
      y: Math.floor(p.y - n.y * 0.5),
      z: Math.floor(p.z - n.z * 0.5),
    };
    const adjacent = {
      x: Math.floor(p.x + n.x * 0.5),
      y: Math.floor(p.y + n.y * 0.5),
      z: Math.floor(p.z + n.z * 0.5),
    };
    return { type: 'voxel', cell, adjacent, normal: { x: n.x, y: n.y, z: n.z }, point: p };
  }

  /** Intersect the y = 0 plane inside the world bounds; behaves like the top face of a slab at y = -1. */
  pickGround() {
    const world = this.renderer.world;
    if (!world) return null;
    const ray = this.raycaster.ray;
    if (Math.abs(ray.direction.y) < 1e-6) return null;
    const t = -ray.origin.y / ray.direction.y;
    if (t <= 0) return null;
    const p = ray.origin.clone().addScaledVector(ray.direction, t);
    const x = Math.floor(p.x),
      z = Math.floor(p.z);
    if (x < 0 || x >= world.w || z < 0 || z >= world.d) return null;
    return {
      type: 'voxel',
      cell: { x, y: -1, z },
      adjacent: { x, y: 0, z },
      normal: { x: 0, y: 1, z: 0 },
      point: p,
      ground: true,
    };
  }
}
