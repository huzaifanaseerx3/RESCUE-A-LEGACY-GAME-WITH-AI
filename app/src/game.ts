import { mat4, vec3 } from "wgpu-matrix";
import { AudioEngine } from "./audio";
import { Camera } from "./camera";
import { Input } from "./input";
import { FIXED_STEP, Loop } from "./timing";
import { LEVELS } from "./levels";
import { Ui } from "./ui";
import { Gfx, Mesh, Renderer, UnsupportedError, VERTEX_FLOATS, defaultPostParams, showUnsupported } from "./graphics";

var v3 = (x = 0, y = 0, z = 0) => [x, y, z];
function set(o, x, y, z) {
  o[0] = x;
  o[1] = y;
  o[2] = z;
  return o;
}
function copy(o, a) {
  o[0] = a[0];
  o[1] = a[1];
  o[2] = a[2];
  return o;
}
function scale(o, a, s) {
  o[0] = a[0] * s;
  o[1] = a[1] * s;
  o[2] = a[2] * s;
  return o;
}
function lerp(o, a, b, t) {
  o[0] = a[0] + (b[0] - a[0]) * t;
  o[1] = a[1] + (b[1] - a[1]) * t;
  o[2] = a[2] + (b[2] - a[2]) * t;
  return o;
}
var dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
var lenSq = (a) => a[0] * a[0] + a[1] * a[1] + a[2] * a[2];
var len = (a) => Math.sqrt(lenSq(a));
function distSq(a, b) {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
}
function distXZ(a, b) {
  return Math.hypot(a[0] - b[0], a[2] - b[2]);
}
function normalize(o, a) {
  const l = len(a);
  if (l < 1e-9)
    return set(o, 0, 0, 0);
  return scale(o, a, 1 / l);
}
var clamp = (x, lo, hi) => x < lo ? lo : x > hi ? hi : x;
var lerpN = (a, b, t) => a + (b - a) * t;
function approach(current, target, tau, dt) {
  if (tau <= 0)
    return target;
  return target + (current - target) * Math.exp(-dt / tau);
}
function angleDiff(a, b) {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI)
    d -= Math.PI * 2;
  if (d < -Math.PI)
    d += Math.PI * 2;
  return d;
}
function lerpAngle(a, b, t) {
  return a + angleDiff(b, a) * t;
}
function turnToward(a, b, maxStep) {
  const d = angleDiff(b, a);
  if (Math.abs(d) <= maxStep)
    return b;
  return a + Math.sign(d) * maxStep;
}
function yawOf(dx, dz) {
  return Math.atan2(-dx, -dz);
}
function dirFromYawPitch(o, yaw, pitch) {
  const cp = Math.cos(pitch);
  return set(o, -Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
}

var KEY = "stillframe.save";
function defaultSettings() {
  return {
    fov: 90,
    sensitivity: 1,
    invertY: false,
    masterVolume: 0.8,
    sfxVolume: 1,
    musicVolume: 0.5,
    resolutionScale: 1,
    autoResolution: true,
    postQuality: "high",
    showFps: false,
    reduceMotion: false,
    crosshairScale: 1
  };
}
function loadSave() {
  const fresh = { version: 1, settings: defaultSettings(), levels: {} };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw)
      return fresh;
    const parsed = JSON.parse(raw);
    if (parsed.version !== 1)
      return fresh;
    return {
      version: 1,
      settings: { ...defaultSettings(), ...parsed.settings ?? {} },
      levels: parsed.levels ?? {}
    };
  } catch (err) {
    console.warn("[save] could not read save data:", err);
    return fresh;
  }
}
function writeSave(data) {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch (err) {
    console.warn("[save] could not write save data:", err);
  }
}

var DebugOverlay = class {
  el;
  visible = true;
  frames = 0;
  accum = 0;
  fps = 0;
  frameMs = 0;
  extra = {};
  constructor(el) {
    this.el = el;
  }
  set(key, value) {
    this.extra[key] = value;
  }
  update(time) {
    this.frames++;
    this.accum += time.realDt;
    if (this.accum < 0.25)
      return;
    this.fps = this.frames / this.accum;
    this.frameMs = this.accum / this.frames * 1e3;
    this.frames = 0;
    this.accum = 0;
    if (!this.visible) {
      this.el.textContent = "";
      return;
    }
    const lines = [
      `fps ${this.fps.toFixed(0)}  (${this.frameMs.toFixed(2)} ms)`,
      `timeScale ${time.effectiveScale().toFixed(3)}  lock ${time.lock}`,
      `sim steps/frame ${time.stepsThisFrame}  simTime ${time.simTime.toFixed(2)}s`,
      ...Object.entries(this.extra).map(([k, v]) => `${k} ${v}`)
    ];
    this.el.textContent = lines.join("\n");
  }
};

function srgbHex(hex) {
  const toLinear = (c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return [toLinear(hex >> 16 & 255), toLinear(hex >> 8 & 255), toLinear(hex & 255)];
}
var BOX_FACES = [
  [[1, 0, 0], [0, 0, -1], [0, 1, 0]],
  [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
  [[0, 1, 0], [1, 0, 0], [0, 0, -1]],
  [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
  [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
  [[0, 0, -1], [-1, 0, 0], [0, 1, 0]]
];
var CORNER_SIGNS = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1]
];
var MeshBuilder = class {
  vertices = [];
  indices = [];
  get vertexCount() {
    return this.vertices.length / VERTEX_FLOATS;
  }
  get isEmpty() {
    return this.indices.length === 0;
  }
  pushVertex(p, n, c, emissive) {
    this.vertices.push(p[0], p[1], p[2], n[0], n[1], n[2], c[0], c[1], c[2], emissive);
  }
  addTri(a, b, c, color, emissive = 0) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    const n = [nx, ny, nz];
    const base = this.vertexCount;
    this.pushVertex(a, n, color, emissive);
    this.pushVertex(b, n, color, emissive);
    this.pushVertex(c, n, color, emissive);
    this.indices.push(base, base + 1, base + 2);
    return this;
  }
  addQuad(a, b, c, d, color, emissive = 0) {
    this.addTri(a, b, c, color, emissive);
    this.addTri(a, c, d, color, emissive);
    return this;
  }
  addBox(center, size, color, emissive = 0) {
    const half = [size[0] / 2, size[1] / 2, size[2] / 2];
    for (const [n, u, v] of BOX_FACES) {
      const base = this.vertexCount;
      for (const [su, sv] of CORNER_SIGNS) {
        const p = [
          center[0] + half[0] * (n[0] + su * u[0] + sv * v[0]),
          center[1] + half[1] * (n[1] + su * u[1] + sv * v[1]),
          center[2] + half[2] * (n[2] + su * u[2] + sv * v[2])
        ];
        this.pushVertex(p, n, color, emissive);
      }
      this.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    return this;
  }
  addBoxMinMax(min, max, color, emissive = 0) {
    return this.addBox([(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2], [max[0] - min[0], max[1] - min[1], max[2] - min[2]], color, emissive);
  }
  addTaperedBox(cx, cz, y0, y1, bw, bd, tw, td, color, emissive = 0) {
    const b = [
      [cx - bw / 2, y0, cz + bd / 2],
      [cx + bw / 2, y0, cz + bd / 2],
      [cx + bw / 2, y0, cz - bd / 2],
      [cx - bw / 2, y0, cz - bd / 2]
    ];
    const t = [
      [cx - tw / 2, y1, cz + td / 2],
      [cx + tw / 2, y1, cz + td / 2],
      [cx + tw / 2, y1, cz - td / 2],
      [cx - tw / 2, y1, cz - td / 2]
    ];
    const flip = y1 < y0;
    const quad = (p0, p1, p2, p3) => {
      if (flip)
        this.addQuad(p3, p2, p1, p0, color, emissive);
      else
        this.addQuad(p0, p1, p2, p3, color, emissive);
    };
    quad(t[0], t[1], t[2], t[3]);
    quad(b[3], b[2], b[1], b[0]);
    quad(b[0], b[1], t[1], t[0]);
    quad(b[1], b[2], t[2], t[1]);
    quad(b[2], b[3], t[3], t[2]);
    quad(b[3], b[0], t[0], t[3]);
    return this;
  }
  build(device, label) {
    return new Mesh(device, new Float32Array(this.vertices), new Uint32Array(this.indices), label);
  }
};

var m = (hex, emissive = 0) => ({ color: srgbHex(hex), emissive });
var THEMES = {
  transit: {
    lighting: {
      keyDir: [0.35, 0.85, 0.4],
      keyColor: [1.7, 0.98, 0.52],
      fillDir: [-0.55, 0.35, -0.6],
      fillColor: [0.16, 0.3, 0.36],
      ambientSky: [0.15, 0.16, 0.19],
      ambientGround: [0.07, 0.06, 0.055],
      fogColor: [0.03, 0.035, 0.04],
      fogDensity: 0.025
    },
    materials: {
      floor: m(7104354),
      wall: m(9209730),
      dark: m(5130823),
      light: m(11840932),
      trim: m(7827819),
      metal: m(6120038),
      accent: m(16751164, 6),
      glow: m(6283480, 5),
      window: m(1911344, 1.2)
    }
  },
  office: {
    lighting: {
      keyDir: [-0.4, 0.8, 0.45],
      keyColor: [1.5, 1.05, 0.7],
      fillDir: [0.6, 0.3, -0.5],
      fillColor: [0.2, 0.3, 0.36],
      ambientSky: [0.18, 0.19, 0.21],
      ambientGround: [0.08, 0.075, 0.07],
      fogColor: [0.045, 0.05, 0.056],
      fogDensity: 0.02
    },
    materials: {
      floor: m(6052440),
      wall: m(10130830),
      dark: m(4605002),
      light: m(12762290),
      trim: m(8419954),
      metal: m(6449004),
      accent: m(16756835, 5),
      glow: m(7330047, 4),
      window: m(2306104, 1.5)
    }
  },
  rooftop: {
    lighting: {
      keyDir: [0.5, 0.65, -0.55],
      keyColor: [0.55, 0.75, 1],
      fillDir: [-0.5, 0.25, 0.6],
      fillColor: [0.7, 0.36, 0.14],
      ambientSky: [0.09, 0.11, 0.17],
      ambientGround: [0.06, 0.045, 0.04],
      fogColor: [0.025, 0.03, 0.055],
      fogDensity: 0.018
    },
    materials: {
      floor: m(5657679),
      wall: m(7696747),
      dark: m(3947325),
      light: m(10459535),
      trim: m(6775646),
      metal: m(5330524),
      accent: m(16747066, 7),
      glow: m(5822696, 5),
      window: m(2767434, 2)
    }
  }
};

var CELL = 2;
var EPS = 1e-4;
var StaticWorld = class {
  boxes;
  bounds;
  cells = new Map();
  stamps;
  stampId = 0;
  scratch = [];
  constructor(boxes) {
    this.boxes = boxes;
    this.stamps = new Uint32Array(Math.max(1, boxes.length));
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    boxes.forEach((b, i) => {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], b.min[k]);
        max[k] = Math.max(max[k], b.max[k]);
      }
      const x0 = Math.floor(b.min[0] / CELL), x1 = Math.floor(b.max[0] / CELL);
      const z0 = Math.floor(b.min[2] / CELL), z1 = Math.floor(b.max[2] / CELL);
      for (let x = x0; x <= x1; x++) {
        for (let z = z0; z <= z1; z++) {
          const key = cellKey(x, z);
          let list = this.cells.get(key);
          if (!list)
            this.cells.set(key, list = []);
          list.push(i);
        }
      }
    });
    if (boxes.length === 0) {
      min.fill(-1);
      max.fill(1);
    }
    this.bounds = { min, max };
  }
  query(minX, minZ, maxX, maxZ, out) {
    out.length = 0;
    this.stampId = this.stampId + 1 >>> 0;
    if (this.stampId === 0) {
      this.stamps.fill(0);
      this.stampId = 1;
    }
    const x0 = Math.floor(minX / CELL), x1 = Math.floor(maxX / CELL);
    const z0 = Math.floor(minZ / CELL), z1 = Math.floor(maxZ / CELL);
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        const list = this.cells.get(cellKey(x, z));
        if (!list)
          continue;
        for (const i of list) {
          if (this.stamps[i] === this.stampId)
            continue;
          this.stamps[i] = this.stampId;
          out.push(i);
        }
      }
    }
    return out;
  }
  raycast(origin, dir, maxDist) {
    const ex = origin[0] + dir[0] * maxDist;
    const ez = origin[2] + dir[2] * maxDist;
    const cand = this.query(Math.min(origin[0], ex), Math.min(origin[2], ez), Math.max(origin[0], ex), Math.max(origin[2], ez), this.scratch);
    let best = maxDist;
    let bestBox = -1;
    let bestAxis = 0;
    let bestSign = 0;
    for (const i of cand) {
      const b = this.boxes[i];
      const r = rayBox(origin, dir, b, best);
      if (r !== null && r.t < best) {
        best = r.t;
        bestBox = i;
        bestAxis = r.axis;
        bestSign = r.sign;
      }
    }
    if (bestBox < 0)
      return null;
    const normal = [0, 0, 0];
    normal[bestAxis] = bestSign;
    return {
      t: best,
      normal,
      point: [origin[0] + dir[0] * best, origin[1] + dir[1] * best, origin[2] + dir[2] * best],
      box: bestBox
    };
  }
  lineClear(a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const l = Math.hypot(dx, dy, dz);
    if (l < 1e-6)
      return true;
    return this.raycast(a, [dx / l, dy / l, dz / l], l) === null;
  }
  overlapsAabb(min, max) {
    const cand = this.query(min[0], min[2], max[0], max[2], this.scratch);
    for (const i of cand) {
      const b = this.boxes[i];
      if (min[0] < b.max[0] - EPS && max[0] > b.min[0] + EPS && min[1] < b.max[1] - EPS && max[1] > b.min[1] + EPS && min[2] < b.max[2] - EPS && max[2] > b.min[2] + EPS) {
        return true;
      }
    }
    return false;
  }
  moveCharacter(pos, delta, r, h, stepHeight, canStep) {
    const res = { grounded: false, hitWall: false, hitCeiling: false };
    const maxD = Math.max(Math.abs(delta[0]), Math.abs(delta[1]), Math.abs(delta[2]));
    const n = Math.max(1, Math.ceil(maxD / (r * 0.8)));
    for (let s = 0; s < n; s++) {
      this.moveAxis(pos, 0, delta[0] / n, r, h, stepHeight, canStep, res);
      this.moveAxis(pos, 2, delta[2] / n, r, h, stepHeight, canStep, res);
      this.moveAxis(pos, 1, delta[1] / n, r, h, stepHeight, canStep, res);
    }
    return res;
  }
  moveAxis(pos, axis, d, r, h, stepHeight, canStep, res) {
    if (d === 0)
      return;
    pos[axis] = pos[axis] + d;
    const cand = this.query(pos[0] - r - 0.1, pos[2] - r - 0.1, pos[0] + r + 0.1, pos[2] + r + 0.1, this.scratch);
    const list = cand.slice();
    for (const i of list) {
      const b = this.boxes[i];
      if (!(pos[0] - r < b.max[0] - EPS && pos[0] + r > b.min[0] + EPS && pos[1] < b.max[1] - EPS && pos[1] + h > b.min[1] + EPS && pos[2] - r < b.max[2] - EPS && pos[2] + r > b.min[2] + EPS)) {
        continue;
      }
      if (axis === 1) {
        if (d < 0) {
          pos[1] = b.max[1];
          res.grounded = true;
        } else {
          pos[1] = b.min[1] - h - EPS;
          res.hitCeiling = true;
        }
        continue;
      }
      const rise = b.max[1] - pos[1];
      if (canStep && rise > 0 && rise <= stepHeight) {
        const y = b.max[1] + 1e-3;
        if (!this.overlapsAabb([pos[0] - r, y, pos[2] - r], [pos[0] + r, y + h, pos[2] + r])) {
          pos[1] = y;
          continue;
        }
      }
      pos[axis] = d > 0 ? b.min[axis] - r - EPS : b.max[axis] + r + EPS;
      res.hitWall = true;
    }
  }
  resolveSphere(pos, vel, r, restitution, friction) {
    const res = { grounded: false, impact: 0, normal: [0, 1, 0] };
    const cand = this.query(pos[0] - r, pos[2] - r, pos[0] + r, pos[2] + r, this.scratch);
    for (const i of cand) {
      const b = this.boxes[i];
      const qx = clampN(pos[0], b.min[0], b.max[0]);
      const qy = clampN(pos[1], b.min[1], b.max[1]);
      const qz = clampN(pos[2], b.min[2], b.max[2]);
      let nx = pos[0] - qx, ny = pos[1] - qy, nz = pos[2] - qz;
      const d2 = nx * nx + ny * ny + nz * nz;
      if (d2 > r * r)
        continue;
      let pen;
      if (d2 > 1e-12) {
        const d = Math.sqrt(d2);
        nx /= d;
        ny /= d;
        nz /= d;
        pen = r - d;
      } else {
        const faces = [
          [pos[0] - b.min[0], -1, 0, 0],
          [b.max[0] - pos[0], 1, 0, 0],
          [pos[1] - b.min[1], 0, -1, 0],
          [b.max[1] - pos[1], 0, 1, 0],
          [pos[2] - b.min[2], 0, 0, -1],
          [b.max[2] - pos[2], 0, 0, 1]
        ];
        let best = faces[0];
        for (const f of faces)
          if (f[0] < best[0])
            best = f;
        nx = best[1];
        ny = best[2];
        nz = best[3];
        pen = best[0] + r;
      }
      pos[0] += nx * pen;
      pos[1] += ny * pen;
      pos[2] += nz * pen;
      const vn = vel[0] * nx + vel[1] * ny + vel[2] * nz;
      if (vn < 0) {
        res.impact = Math.max(res.impact, -vn);
        const tx = vel[0] - nx * vn, ty = vel[1] - ny * vn, tz = vel[2] - nz * vn;
        const f = 1 - friction;
        vel[0] = tx * f - nx * vn * restitution;
        vel[1] = ty * f - ny * vn * restitution;
        vel[2] = tz * f - nz * vn * restitution;
      }
      if (ny > 0.6)
        res.grounded = true;
      res.normal = [nx, ny, nz];
    }
    return res;
  }
};
function cellKey(x, z) {
  return x + 4096 << 13 | z + 4096;
}
function clampN(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}
function rayBox(o, d, b, maxT) {
  let tmin = 0;
  let tmax = maxT;
  let axis = -1;
  let sign = 0;
  for (let k = 0; k < 3; k++) {
    const ok = o[k];
    const dk = d[k];
    const lo = b.min[k];
    const hi = b.max[k];
    if (Math.abs(dk) < 1e-12) {
      if (ok < lo || ok > hi)
        return null;
      continue;
    }
    const inv = 1 / dk;
    let t0 = (lo - ok) * inv;
    let t1 = (hi - ok) * inv;
    let s = -1;
    if (t0 > t1) {
      const tmp2 = t0;
      t0 = t1;
      t1 = tmp2;
      s = 1;
    }
    if (t0 > tmin) {
      tmin = t0;
      axis = k;
      sign = s;
    }
    if (t1 < tmax)
      tmax = t1;
    if (tmin > tmax)
      return null;
  }
  if (axis < 0) {
    return { t: 0, axis: 1, sign: 1 };
  }
  return { t: tmin, axis, sign };
}
function segmentSphere(p0, p1, c, r) {
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1], dz = p1[2] - p0[2];
  const mx = p0[0] - c[0], my = p0[1] - c[1], mz = p0[2] - c[2];
  const a = dx * dx + dy * dy + dz * dz;
  const b = mx * dx + my * dy + mz * dz;
  const cc = mx * mx + my * my + mz * mz - r * r;
  if (cc <= 0)
    return 0;
  if (a < 1e-12)
    return -1;
  const disc = b * b - a * cc;
  if (disc < 0)
    return -1;
  const t = (-b - Math.sqrt(disc)) / a;
  return t >= 0 && t <= 1 ? t : -1;
}
function segmentCapsule(p0, p1, a, b, r) {
  const d1x = p1[0] - p0[0], d1y = p1[1] - p0[1], d1z = p1[2] - p0[2];
  const d2x = b[0] - a[0], d2y = b[1] - a[1], d2z = b[2] - a[2];
  const rx = p0[0] - a[0], ry = p0[1] - a[1], rz = p0[2] - a[2];
  const aa = d1x * d1x + d1y * d1y + d1z * d1z;
  const ee = d2x * d2x + d2y * d2y + d2z * d2z;
  const ff = d2x * rx + d2y * ry + d2z * rz;
  let s;
  let t;
  if (aa < 1e-12) {
    s = 0;
    t = clampN(ff / ee, 0, 1);
  } else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    const bb = d1x * d2x + d1y * d2y + d1z * d2z;
    const denom = aa * ee - bb * bb;
    s = denom > 1e-12 ? clampN((bb * ff - c * ee) / denom, 0, 1) : 0;
    t = (bb * s + ff) / ee;
    if (t < 0) {
      t = 0;
      s = clampN(-c / aa, 0, 1);
    } else if (t > 1) {
      t = 1;
      s = clampN((bb - c) / aa, 0, 1);
    }
  }
  const cx = p0[0] + d1x * s - (a[0] + d2x * t);
  const cy = p0[1] + d1y * s - (a[1] + d2y * t);
  const cz = p0[2] + d1z * s - (a[2] + d2z * t);
  const dsq = cx * cx + cy * cy + cz * cz;
  if (dsq > r * r)
    return -1;
  const segLen = Math.sqrt(aa);
  if (segLen < 1e-9)
    return 0;
  const back = Math.sqrt(Math.max(0, r * r - dsq)) / segLen;
  return clampN(s - back, 0, 1);
}

var CELL2 = 0.5;
var AGENT_RADIUS = 0.32;
var STEP = 0.4;
var HEADROOM = 1.75;
var MAX_FLOOR = 3.3;
var NavGrid = class {
  world;
  originX;
  originZ;
  w;
  h;
  floor;
  gScore;
  fScore;
  cameFrom;
  closed;
  openStamp;
  searchId = 0;
  heap = [];
  constructor(world) {
    this.world = world;
    const b = world.bounds;
    this.originX = Math.floor(b.min[0]);
    this.originZ = Math.floor(b.min[2]);
    this.w = Math.max(1, Math.ceil((b.max[0] - this.originX) / CELL2));
    this.h = Math.max(1, Math.ceil((b.max[2] - this.originZ) / CELL2));
    const n = this.w * this.h;
    this.floor = new Float32Array(n).fill(NaN);
    this.gScore = new Float32Array(n);
    this.fScore = new Float32Array(n);
    this.cameFrom = new Int32Array(n);
    this.closed = new Uint32Array(n);
    this.openStamp = new Uint32Array(n);
    this.bake();
  }
  bake() {
    const boxes = this.world.boxes;
    const cand = [];
    for (let cz = 0; cz < this.h; cz++) {
      for (let cx = 0; cx < this.w; cx++) {
        const x = this.originX + (cx + 0.5) * CELL2;
        const z = this.originZ + (cz + 0.5) * CELL2;
        this.world.query(x - AGENT_RADIUS, z - AGENT_RADIUS, x + AGENT_RADIUS, z + AGENT_RADIUS, cand);
        let floorY = -Infinity;
        for (const i of cand) {
          const bx = boxes[i];
          if (x >= bx.min[0] && x <= bx.max[0] && z >= bx.min[2] && z <= bx.max[2] && bx.max[1] <= MAX_FLOOR && bx.max[1] > floorY) {
            floorY = bx.max[1];
          }
        }
        if (floorY === -Infinity)
          continue;
        let blocked = false;
        for (const i of cand) {
          const bx = boxes[i];
          if (bx.min[0] < x + AGENT_RADIUS && bx.max[0] > x - AGENT_RADIUS && bx.min[2] < z + AGENT_RADIUS && bx.max[2] > z - AGENT_RADIUS && bx.max[1] > floorY + STEP && bx.min[1] < floorY + HEADROOM) {
            blocked = true;
            break;
          }
        }
        if (!blocked)
          this.floor[cz * this.w + cx] = floorY;
      }
    }
  }
  cellOf(x, z) {
    const cx = Math.floor((x - this.originX) / CELL2);
    const cz = Math.floor((z - this.originZ) / CELL2);
    if (cx < 0 || cz < 0 || cx >= this.w || cz >= this.h)
      return -1;
    return cz * this.w + cx;
  }
  walkable(cell) {
    return cell >= 0 && !Number.isNaN(this.floor[cell]);
  }
  center(cell, out) {
    const cx = cell % this.w;
    const cz = (cell - cx) / this.w;
    out[0] = this.originX + (cx + 0.5) * CELL2;
    out[1] = this.floor[cell];
    out[2] = this.originZ + (cz + 0.5) * CELL2;
    return out;
  }
  nearestWalkable(x, z, nearY) {
    const c0 = this.cellOf(x, z);
    if (this.walkable(c0) && Math.abs(this.floor[c0] - nearY) < 1.2)
      return c0;
    const cx0 = Math.floor((x - this.originX) / CELL2);
    const cz0 = Math.floor((z - this.originZ) / CELL2);
    for (let ring = 1; ring <= 6; ring++) {
      let best = -1;
      let bestD = Infinity;
      for (let dz = -ring; dz <= ring; dz++) {
        for (let dx = -ring; dx <= ring; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring)
            continue;
          const cx = cx0 + dx, cz = cz0 + dz;
          if (cx < 0 || cz < 0 || cx >= this.w || cz >= this.h)
            continue;
          const c = cz * this.w + cx;
          if (!this.walkable(c))
            continue;
          const d = dx * dx + dz * dz + Math.abs(this.floor[c] - nearY) * 4;
          if (d < bestD) {
            bestD = d;
            best = c;
          }
        }
      }
      if (best >= 0)
        return best;
    }
    return -1;
  }
  findPath(from, to, maxExpansions = 4e3) {
    const start = this.nearestWalkable(from[0], from[2], from[1]);
    const goal = this.nearestWalkable(to[0], to[2], to[1]);
    if (start < 0 || goal < 0)
      return null;
    if (start === goal)
      return [[to[0], this.floor[goal], to[2]]];
    this.searchId = this.searchId + 1 >>> 0;
    const sid = this.searchId;
    const w = this.w;
    const gx = goal % w, gz = (goal - gx) / w;
    const heur = (c) => {
      const cx = c % w, cz = (c - cx) / w;
      const dx = Math.abs(cx - gx), dz = Math.abs(cz - gz);
      return Math.max(dx, dz) + 0.4142 * Math.min(dx, dz);
    };
    const heap = this.heap;
    heap.length = 0;
    this.gScore[start] = 0;
    this.fScore[start] = heur(start);
    this.cameFrom[start] = -1;
    this.openStamp[start] = sid;
    this.heapPush(start);
    let expansions = 0;
    let found = false;
    while (heap.length > 0) {
      const cur = this.heapPop();
      if (cur === goal) {
        found = true;
        break;
      }
      if (this.closed[cur] === sid)
        continue;
      this.closed[cur] = sid;
      if (++expansions > maxExpansions)
        break;
      const cx = cur % w, cz = (cur - cx) / w;
      const fy = this.floor[cur];
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dz === 0)
            continue;
          const nx = cx + dx, nz = cz + dz;
          if (nx < 0 || nz < 0 || nx >= w || nz >= this.h)
            continue;
          const nb = nz * w + nx;
          if (!this.walkable(nb) || this.closed[nb] === sid)
            continue;
          if (Math.abs(this.floor[nb] - fy) > STEP)
            continue;
          if (dx !== 0 && dz !== 0) {
            if (!this.walkable(cz * w + nx) || !this.walkable(nz * w + cx))
              continue;
          }
          const cost = this.gScore[cur] + (dx !== 0 && dz !== 0 ? 1.4142 : 1);
          if (this.openStamp[nb] === sid && cost >= this.gScore[nb])
            continue;
          this.openStamp[nb] = sid;
          this.gScore[nb] = cost;
          this.fScore[nb] = cost + heur(nb);
          this.cameFrom[nb] = cur;
          this.heapPush(nb);
        }
      }
    }
    if (!found)
      return null;
    const cells = [];
    for (let c = goal; c !== -1; c = this.cameFrom[c])
      cells.push(c);
    cells.reverse();
    return this.smooth(cells, to);
  }
  smooth(cells, to) {
    const out = [];
    let anchor = 0;
    let i = 1;
    while (i < cells.length) {
      if (i + 1 < cells.length && this.gridLineClear(cells[anchor], cells[i + 1])) {
        i++;
        continue;
      }
      out.push(this.center(cells[i], [0, 0, 0]));
      anchor = i;
      i++;
    }
    const last = out[out.length - 1];
    const goalCell = cells[cells.length - 1];
    if (last) {
      last[0] = to[0];
      last[2] = to[2];
      last[1] = this.floor[goalCell];
    } else {
      out.push([to[0], this.floor[goalCell], to[2]]);
    }
    return out;
  }
  gridLineClear(a, b) {
    const pa = this.center(a, [0, 0, 0]);
    const pb = this.center(b, [0, 0, 0]);
    const d = Math.hypot(pb[0] - pa[0], pb[2] - pa[2]);
    const steps = Math.ceil(d / (CELL2 * 0.5));
    let prevY = pa[1];
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const x = pa[0] + (pb[0] - pa[0]) * t;
      const z = pa[2] + (pb[2] - pa[2]) * t;
      for (const [ox, oz] of [[0, 0], [AGENT_RADIUS * 0.7, 0], [-AGENT_RADIUS * 0.7, 0], [0, AGENT_RADIUS * 0.7], [0, -AGENT_RADIUS * 0.7]]) {
        const c = this.cellOf(x + ox, z + oz);
        if (!this.walkable(c))
          return false;
        if (ox === 0 && oz === 0) {
          const y = this.floor[c];
          if (Math.abs(y - prevY) > STEP)
            return false;
          prevY = y;
        }
      }
    }
    return true;
  }
  heapPush(c) {
    const heap = this.heap;
    const f = this.fScore;
    heap.push(c);
    let i = heap.length - 1;
    while (i > 0) {
      const p = i - 1 >> 1;
      if (f[heap[p]] <= f[heap[i]])
        break;
      const tmp2 = heap[p];
      heap[p] = heap[i];
      heap[i] = tmp2;
      i = p;
    }
  }
  heapPop() {
    const heap = this.heap;
    const f = this.fScore;
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (; ; ) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m2 = i;
        if (l < heap.length && f[heap[l]] < f[heap[m2]])
          m2 = l;
        if (r < heap.length && f[heap[r]] < f[heap[m2]])
          m2 = r;
        if (m2 === i)
          break;
        const tmp2 = heap[m2];
        heap[m2] = heap[i];
        heap[i] = tmp2;
        i = m2;
      }
    }
    return top;
  }
};

function buildLevelMesh(device, def) {
  const scene = buildLevelScene(device, def);
  const boxes = def.boxes.filter((b) => b.collide).map((b) => ({ min: [b.min[0], b.min[1], b.min[2]], max: [b.max[0], b.max[1], b.max[2]] }));
  const st = new StaticWorld(boxes);
  const nav = new NavGrid(st);
  return { scene, shared: { static: st, nav } };
}
function buildLevelScene(device, def) {
  const theme = THEMES[def.theme];
  const b = new MeshBuilder();
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const box of def.boxes) {
    const mat = theme.materials[box.mat];
    b.addBoxMinMax(box.min, box.max, mat.color, mat.emissive);
    if (box.collide) {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], box.min[k]);
        max[k] = Math.max(max[k], box.max[k]);
      }
    }
  }
  if (!Number.isFinite(min[0])) {
    min[0] = min[1] = min[2] = -10;
    max[0] = max[1] = max[2] = 10;
  }
  min[1] = Math.max(min[1], -1);
  max[1] = Math.min(max[1], 8);
  return { mesh: b.build(device, `level-${def.id}`), min, max };
}

var Rng = class {
  s;
  constructor(seed) {
    this.s = seed >>> 0 || 2654435769;
  }
  next() {
    let t = this.s = this.s + 1831565813 >>> 0;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  }
  range(lo, hi) {
    return lo + (hi - lo) * this.next();
  }
  sym(m2) {
    return (this.next() * 2 - 1) * m2;
  }
  int(lo, hiInclusive) {
    return lo + Math.floor(this.next() * (hiInclusive - lo + 1));
  }
  pick(items) {
    return items[Math.floor(this.next() * items.length)];
  }
};
var visualRng = new Rng(12648430);

var PART_IDS = [
  "pelvis",
  "torso",
  "head",
  "upperArmL",
  "lowerArmL",
  "upperArmR",
  "lowerArmR",
  "upperLegL",
  "lowerLegL",
  "upperLegR",
  "lowerLegR"
];
var PART_EXTENTS = {
  pelvis: [0.17, 0.08, 0.1],
  torso: [0.22, 0.28, 0.12],
  head: [0.12, 0.14, 0.12],
  upperArmL: [0.06, 0.15, 0.06],
  lowerArmL: [0.05, 0.15, 0.05],
  upperArmR: [0.06, 0.15, 0.06],
  lowerArmR: [0.05, 0.15, 0.05],
  upperLegL: [0.08, 0.21, 0.08],
  lowerLegL: [0.07, 0.21, 0.07],
  upperLegR: [0.08, 0.21, 0.08],
  lowerLegR: [0.07, 0.21, 0.07]
};
var PART_CENTER = {
  pelvis: [0, 0, 0],
  torso: [0, 0.28, 0],
  head: [0, 0.14, 0],
  upperArmL: [0, -0.15, 0],
  lowerArmL: [0, -0.15, 0],
  upperArmR: [0, -0.15, 0],
  lowerArmR: [0, -0.15, 0],
  upperLegL: [0, -0.21, 0],
  lowerLegL: [0, -0.21, 0],
  upperLegR: [0, -0.21, 0],
  lowerLegR: [0, -0.21, 0]
};
var WHITE2 = srgbHex(16052714);
var OFFWHITE = srgbHex(14276044);
var DARK = srgbHex(2763310);
var GLASS = srgbHex(16777215);
var GLOVE = srgbHex(1842208);
var GLOVE_DARK = srgbHex(1184276);
function buildMeshLibrary(device) {
  const part = (fn, label) => {
    const b = new MeshBuilder();
    fn(b);
    return b.build(device, label);
  };
  const parts = {
    pelvis: part((b) => b.addTaperedBox(0, 0, -0.08, 0.08, 0.26, 0.18, 0.34, 0.2, GLASS, 0.6), "pelvis"),
    torso: part((b) => {
      b.addTaperedBox(0, 0, 0, 0.3, 0.32, 0.2, 0.44, 0.24, GLASS, 0.9);
      b.addTaperedBox(0, 0, 0.3, 0.56, 0.44, 0.24, 0.3, 0.18, GLASS, 0.9);
    }, "torso"),
    head: part((b) => {
      b.addTaperedBox(0, 0, 0, 0.06, 0.08, 0.08, 0.1, 0.1, GLASS, 0.5);
      b.addTaperedBox(0, 0.01, 0.06, 0.2, 0.15, 0.17, 0.22, 0.22, GLASS, 1.2);
      b.addTaperedBox(0, 0.01, 0.2, 0.3, 0.22, 0.22, 0.14, 0.15, GLASS, 1.2);
    }, "head"),
    upperArmL: part((b) => b.addTaperedBox(0, 0, 0, -0.3, 0.12, 0.12, 0.09, 0.09, GLASS, 0.7), "upperArm"),
    lowerArmL: part((b) => {
      b.addTaperedBox(0, 0, 0, -0.26, 0.09, 0.09, 0.07, 0.07, GLASS, 0.7);
      b.addBox([0, -0.29, 0], [0.09, 0.08, 0.09], GLASS, 0.9);
    }, "lowerArm"),
    upperArmR: part((b) => b.addTaperedBox(0, 0, 0, -0.3, 0.12, 0.12, 0.09, 0.09, GLASS, 0.7), "upperArmR"),
    lowerArmR: part((b) => {
      b.addTaperedBox(0, 0, 0, -0.26, 0.09, 0.09, 0.07, 0.07, GLASS, 0.7);
      b.addBox([0, -0.29, 0], [0.09, 0.08, 0.09], GLASS, 0.9);
    }, "lowerArmR"),
    upperLegL: part((b) => b.addTaperedBox(0, 0, 0, -0.42, 0.17, 0.17, 0.12, 0.12, GLASS, 0.6), "upperLeg"),
    lowerLegL: part((b) => {
      b.addTaperedBox(0, 0, 0, -0.4, 0.12, 0.12, 0.09, 0.09, GLASS, 0.6);
      b.addBox([0, -0.43, -0.04], [0.1, 0.06, 0.2], GLASS, 0.6);
    }, "lowerLeg"),
    upperLegR: part((b) => b.addTaperedBox(0, 0, 0, -0.42, 0.17, 0.17, 0.12, 0.12, GLASS, 0.6), "upperLegR"),
    lowerLegR: part((b) => {
      b.addTaperedBox(0, 0, 0, -0.4, 0.12, 0.12, 0.09, 0.09, GLASS, 0.6);
      b.addBox([0, -0.43, -0.04], [0.1, 0.06, 0.2], GLASS, 0.6);
    }, "lowerLegR")
  };
  const items = {
    pistol: part((b) => {
      b.addBox([0, 0.03, -0.04], [0.04, 0.045, 0.21], WHITE2);
      b.addBox([0, -0.04, 0.03], [0.036, 0.11, 0.05], OFFWHITE);
      b.addBox([0, -0.012, -0.015], [0.012, 0.03, 0.035], DARK);
    }, "pistol"),
    scatter: part((b) => {
      b.addBox([0, 0.02, -0.2], [0.05, 0.05, 0.6], WHITE2);
      b.addBox([0, -0.01, -0.22], [0.055, 0.04, 0.16], OFFWHITE);
      b.addBox([0, -0.02, 0.17], [0.05, 0.09, 0.26], WHITE2);
      b.addBox([0, -0.06, 0.06], [0.035, 0.08, 0.04], OFFWHITE);
    }, "scatter"),
    carbine: part((b) => {
      b.addBox([0, 0.02, -0.08], [0.05, 0.08, 0.36], WHITE2);
      b.addBox([0, 0.03, -0.33], [0.025, 0.025, 0.18], OFFWHITE);
      b.addBox([0, -0.07, -0.06], [0.035, 0.12, 0.05], OFFWHITE);
      b.addBox([0, -0.05, 0.05], [0.035, 0.09, 0.04], WHITE2);
      b.addBox([0, 0, 0.2], [0.045, 0.09, 0.2], WHITE2);
      b.addBox([0, 0.075, -0.05], [0.02, 0.025, 0.12], DARK);
    }, "carbine"),
    blade: part((b) => {
      b.addBox([0, 0, 0.1], [0.035, 0.035, 0.2], DARK);
      b.addBox([0, 0, -5e-3], [0.11, 0.02, 0.03], OFFWHITE);
      b.addBox([0, 0, -0.38], [0.012, 0.045, 0.72], WHITE2, 0.2);
    }, "blade"),
    bottle: part((b) => {
      b.addBox([0, -0.02, 0], [0.075, 0.18, 0.075], WHITE2);
      b.addTaperedBox(0, 0, 0.07, 0.12, 0.075, 0.075, 0.03, 0.03, WHITE2);
      b.addBox([0, 0.15, 0], [0.03, 0.06, 0.03], OFFWHITE);
    }, "bottle"),
    brick: part((b) => b.addBox([0, 0, 0], [0.21, 0.065, 0.1], OFFWHITE), "brick"),
    mug: part((b) => {
      b.addBox([0, 0, 0], [0.09, 0.1, 0.09], WHITE2);
      b.addBox([0.06, 0, 0], [0.03, 0.06, 0.02], WHITE2);
    }, "mug")
  };
  const rng = new Rng(4242);
  const shards = [];
  for (let i = 0; i < 6; i++) {
    const s = rng.range(0.6, 1);
    const p = () => [rng.sym(0.06) * s, rng.sym(0.06) * s, rng.sym(0.06) * s];
    const a = [0, 0.07 * s, 0];
    const bb = [-0.06 * s, -0.04 * s, 0.05 * s];
    const c = [0.06 * s, -0.04 * s, 0.05 * s];
    const d = [0, -0.04 * s, -0.07 * s];
    const j = p();
    const jitter = (v) => [v[0] + j[0] * 0.4, v[1] + j[1] * 0.4, v[2] + j[2] * 0.4];
    const ja = jitter(a);
    const b = new MeshBuilder();
    b.addTri(ja, bb, c, GLASS, 1);
    b.addTri(ja, c, d, GLASS, 1);
    b.addTri(ja, d, bb, GLASS, 1);
    b.addTri(bb, d, c, GLASS, 1);
    shards.push(b.build(device, `shard-${i}`));
  }
  const fist = part((b) => {
    b.addBox([0, 0, 0], [0.09, 0.09, 0.1], GLOVE);
    b.addBox([0, 0.025, -0.055], [0.085, 0.035, 0.02], GLOVE_DARK);
  }, "fist");
  const forearm = part((b) => b.addTaperedBox(0, 0, 0, 0.36, 0.08, 0.08, 0.1, 0.1, GLOVE), "forearm");
  const spawnRing = part((b) => {
    for (let i = 0; i < 8; i++) {
      const a0 = i / 8 * Math.PI * 2;
      b.addBox([Math.cos(a0) * 0.45, 0.01, Math.sin(a0) * 0.45], [0.12, 0.02, 0.12], GLASS, 2);
    }
  }, "spawn-ring");
  return { parts, items, shards, fist, forearm, spawnRing };
}

var BULLET_SPEED = 25;
var BULLET_RADIUS = 0.03;
var BULLET_LIFE = 5;
var WEAPONS = {
  pistol: { kind: "pistol", ammo: 6, cooldown: 0.4, pellets: 1, spread: 0, burst: 1, burstInterval: 0, melee: false, muzzle: [0, 0.03, -0.14] },
  scatter: { kind: "scatter", ammo: 3, cooldown: 0.9, pellets: 5, spread: 5, burst: 1, burstInterval: 0, melee: false, muzzle: [0, 0.02, -0.5] },
  carbine: { kind: "carbine", ammo: 12, cooldown: 0.55, pellets: 1, spread: 0.6, burst: 3, burstInterval: 0.09, melee: false, muzzle: [0, 0.03, -0.42] },
  blade: { kind: "blade", ammo: 0, cooldown: 0.45, pellets: 0, spread: 0, burst: 0, burstInterval: 0, melee: true, muzzle: [0, 0, -0.6] }
};
var isWeapon = (k) => k in WEAPONS;
var isGun = (k) => isWeapon(k) && !WEAPONS[k].melee;
function newItem(kind) {
  return { kind, ammo: isWeapon(kind) ? WEAPONS[kind].ammo : 0 };
}
var ITEM_NAMES = {
  pistol: "PISTOL",
  scatter: "SCATTER",
  carbine: "CARBINE",
  blade: "BLADE",
  bottle: "BOTTLE",
  brick: "BRICK",
  mug: "MUG"
};
var ITEM_RADIUS = {
  pistol: 0.1,
  scatter: 0.14,
  carbine: 0.13,
  blade: 0.12,
  bottle: 0.1,
  brick: 0.09,
  mug: 0.08
};
var FRAGILE = { bottle: true, mug: true };

var ENEMY_PARAMS = {
  walker: { speed: 2.3, turnRate: 5, reaction: 0.5, aimError: 3.2, keepDist: 6, cooldownMul: 2.4, hp: 2, defaultWeapon: "pistol" },
  rusher: { speed: 5.2, turnRate: 9, reaction: 0.25, aimError: 0, keepDist: 0, cooldownMul: 1, hp: 2, defaultWeapon: null },
  marksman: { speed: 1.1, turnRate: 3.2, reaction: 0.7, aimError: 1, keepDist: 40, cooldownMul: 1, hp: 2, defaultWeapon: "carbine" }
};
var ENEMY_RADIUS = 0.3;
var ENEMY_HEIGHT = 1.8;
var HEAD_OFFSET = 1.7;
var HEAD_RADIUS = 0.17;
var BODY_A = 0.25;
var BODY_B = 1.45;
var BODY_RADIUS = 0.27;
var SPAWN_TIME = 0.6;
var MELEE_TIME = 0.55;
var MELEE_STRIKE_AT = 0.65;
var MELEE_RANGE = 1.5;
var TELEGRAPH = 0.6;
var MARKSMAN_COOLDOWN = 1.9;
var GRAVITY = 18;
var MUZZLE_LOCAL = [0.24, 1.48, -0.72];
function createEnemy(id, kind, pos, yaw, weapon, idle, seed) {
  const params = ENEMY_PARAMS[kind];
  const w = weapon === void 0 ? params.defaultWeapon : weapon;
  return {
    id,
    kind,
    alive: true,
    pos: [pos[0], pos[1], pos[2]],
    prevPos: [pos[0], pos[1], pos[2]],
    vel: v3(),
    yaw,
    prevYaw: yaw,
    grounded: false,
    state: idle ? "idle" : "alert",
    stateTime: 0,
    hp: params.hp,
    weapon: w ? newItem(w) : null,
    fireCooldown: 0.6,
    burstLeft: 0,
    burstTimer: 0,
    aimTimer: params.reaction,
    telegraph: 0,
    lockedDir: [0, 0, -1],
    meleeT: 0,
    prevMeleeT: 0,
    meleeCooldown: 0,
    stunTimer: 0,
    path: null,
    pathIndex: 0,
    repathTimer: 0,
    seesPlayer: false,
    walkPhase: seed * 6.28,
    prevWalkPhase: seed * 6.28,
    moveBlend: 0,
    prevMoveBlend: 0,
    aimBlend: 0,
    prevAimBlend: 0,
    aimPitch: 0,
    hitFlash: 0,
    spawnT: 0,
    prevSpawnT: 0,
    strafeSeed: seed * 10,
    targetPropId: -1,
    lastShotId: -1
  };
}
function enemyIsTwoHanded(e) {
  return !!e.weapon && (e.weapon.kind === "scatter" || e.weapon.kind === "carbine");
}
function enemyMuzzle(e, out) {
  const c = Math.cos(e.yaw);
  const s = Math.sin(e.yaw);
  const lx = MUZZLE_LOCAL[0], lz = MUZZLE_LOCAL[2];
  out[0] = e.pos[0] + lx * c + lz * s;
  out[1] = e.pos[1] + MUZZLE_LOCAL[1];
  out[2] = e.pos[2] - lx * s + lz * c;
  return out;
}
var scratchA = v3();
var scratchB = v3();
var scratchC = v3();
function savePrev(e) {
  copy(e.prevPos, e.pos);
  e.prevYaw = e.yaw;
  e.prevWalkPhase = e.walkPhase;
  e.prevMoveBlend = e.moveBlend;
  e.prevAimBlend = e.aimBlend;
  e.prevSpawnT = e.spawnT;
  e.prevMeleeT = e.meleeT;
}
function updateEnemy(world, e, dt) {
  const params = ENEMY_PARAMS[e.kind];
  e.stateTime += dt;
  e.hitFlash = Math.max(0, e.hitFlash - dt * 4);
  if (e.spawnT < 1) {
    e.spawnT = Math.min(1, e.spawnT + dt / SPAWN_TIME);
    applyGravityAndMove(world, e, 0, 0, dt);
    return;
  }
  e.fireCooldown -= dt;
  e.meleeCooldown -= dt;
  e.stunTimer -= dt;
  const player = world.player;
  const eye = [e.pos[0], e.pos[1] + 1.6, e.pos[2]];
  const playerEye = world.playerEye(scratchA);
  const dx = playerEye[0] - eye[0];
  const dz = playerEye[2] - eye[2];
  const distP = Math.hypot(dx, dz);
  const yawToPlayer = yawOf(dx, dz);
  let canSee = false;
  if (player.alive) {
    const inFov = Math.abs(angleDiff(yawToPlayer, e.yaw)) < 1.25 || distP < 5 || e.state !== "idle";
    canSee = inFov && distP < 45 && world.static.lineClear(eye, playerEye);
  }
  if (canSee && !e.seesPlayer)
    e.aimTimer = Math.max(e.aimTimer, params.reaction * 0.6);
  e.seesPlayer = canSee;
  let desiredYaw = e.yaw;
  let moveTarget = null;
  let speed = 0;
  let aimWanted = false;
  let stopDist = 0.3;
  if (e.state === "stunned") {
    if (e.stunTimer <= 0)
      setState(e, "pursue");
  } else if (e.state === "idle") {
    if (canSee || world.heardShot(e.pos)) {
      setState(e, "alert");
      e.aimTimer = params.reaction;
    }
  } else if (e.state === "alert") {
    desiredYaw = yawToPlayer;
    if (e.stateTime >= params.reaction)
      setState(e, "pursue");
  }
  if (e.state === "pursue" && player.alive) {
    const hasGun = !!e.weapon && isGun(e.weapon.kind);
    let fetching = false;
    if (!e.weapon && e.kind !== "rusher") {
      const prop = world.findGunPropFor(e);
      if (prop) {
        fetching = true;
        moveTarget = prop.pos;
        speed = params.speed * 1.2;
        stopDist = 0;
        desiredYaw = yawOf(prop.pos[0] - e.pos[0], prop.pos[2] - e.pos[2]);
        if (distXZ(prop.pos, e.pos) < 0.75 && Math.abs(prop.pos[1] - e.pos[1]) < 1.2)
          world.enemyPickUp(e, prop);
      }
    }
    if (!fetching && hasGun) {
      if (canSee) {
        aimWanted = true;
        desiredYaw = yawToPlayer;
        if (distP > params.keepDist) {
          moveTarget = player.pos;
          speed = params.speed * 0.7;
        } else if (e.kind === "walker") {
          const strafe = Math.sin(world.simTime * 0.9 + e.strafeSeed) * 1.2;
          const rx = Math.cos(e.yaw), rz = -Math.sin(e.yaw);
          scratchB[0] = e.pos[0] + rx * strafe;
          scratchB[1] = e.pos[1];
          scratchB[2] = e.pos[2] + rz * strafe;
          moveTarget = scratchB;
          speed = params.speed * 0.35;
          stopDist = 0.1;
        }
        e.aimTimer -= dt;
        e.aimPitch = Math.atan2(playerEye[1] - 0.35 - (e.pos[1] + 1.48), Math.max(0.1, distP));
        handleShooting(world, e, dt, Math.abs(angleDiff(yawToPlayer, e.yaw)) < 0.14);
      } else {
        e.aimTimer = Math.max(e.aimTimer, params.reaction * 0.5);
        e.telegraph = 0;
        if (e.kind !== "marksman") {
          moveTarget = player.pos;
          speed = params.speed;
        } else {
          desiredYaw = yawToPlayer;
        }
        if (e.burstLeft > 0)
          handleShooting(world, e, dt, false);
      }
    } else if (!fetching) {
      const meleeSpeed = e.kind === "rusher" ? params.speed : params.speed * 1.3;
      desiredYaw = yawToPlayer;
      if (e.meleeT > 0) {
        e.meleeT += dt / MELEE_TIME;
        const before = e.prevMeleeT;
        if (before < MELEE_STRIKE_AT && e.meleeT >= MELEE_STRIKE_AT)
          meleeStrike(world, e);
        if (e.meleeT >= 1)
          e.meleeT = 0;
        speed = e.meleeT < MELEE_STRIKE_AT ? meleeSpeed * 0.25 : 0;
        moveTarget = player.pos;
      } else {
        moveTarget = player.pos;
        speed = meleeSpeed;
        stopDist = 0.9;
        if (distP < MELEE_RANGE && e.meleeCooldown <= 0 && Math.abs(angleDiff(yawToPlayer, e.yaw)) < 0.7 && Math.abs(playerEye[1] - eye[1]) < 1.2) {
          e.meleeT = 1e-3;
          world.events.push({ type: "melee", pos: [eye[0], eye[1], eye[2]] });
        }
      }
    }
  } else if (e.state === "pursue") {
    e.telegraph = 0;
  }
  let wantX = 0;
  let wantZ = 0;
  if (moveTarget && speed > 0 && e.state !== "stunned") {
    const tdist = distXZ(moveTarget, e.pos);
    if (tdist > stopDist) {
      const wp = nextWaypoint(world, e, moveTarget, dt);
      const wx = wp[0] - e.pos[0];
      const wz = wp[2] - e.pos[2];
      const wl = Math.hypot(wx, wz);
      if (wl > 1e-4) {
        const sp = tdist < 1 ? speed * Math.max(0.3, tdist) : speed;
        wantX = wx / wl * sp;
        wantZ = wz / wl * sp;
        if (!aimWanted && e.meleeT === 0 && e.state === "pursue" && distP > 4)
          desiredYaw = yawOf(wx, wz);
      }
    }
  }
  for (const o of world.enemies) {
    if (o === e || !o.alive)
      continue;
    const sx = e.pos[0] - o.pos[0];
    const sz = e.pos[2] - o.pos[2];
    const sd = Math.hypot(sx, sz);
    if (sd < 0.75 && sd > 1e-4) {
      const push = (0.75 - sd) * 6;
      wantX += sx / sd * push;
      wantZ += sz / sd * push;
    }
  }
  const accel = e.state === "stunned" ? 4 : 14;
  e.vel[0] += clamp(wantX - e.vel[0], -accel * dt, accel * dt);
  e.vel[2] += clamp(wantZ - e.vel[2], -accel * dt, accel * dt);
  if (e.state !== "stunned")
    e.yaw = turnToward(e.yaw, desiredYaw, params.turnRate * dt);
  applyGravityAndMove(world, e, e.vel[0], e.vel[2], dt);
  const hs = Math.hypot(e.vel[0], e.vel[2]);
  e.moveBlend = approach(e.moveBlend, clamp(hs / 2.4, 0, 1), 0.12, dt);
  e.walkPhase += hs * dt * (e.kind === "rusher" ? 2.6 : 3.4);
  e.aimBlend = approach(e.aimBlend, aimWanted || e.telegraph > 0 || e.burstLeft > 0 ? 1 : 0, 0.12, dt);
  if (!aimWanted)
    e.aimPitch = approach(e.aimPitch, 0, 0.3, dt);
  if (e.pos[1] < -6)
    world.killEnemy(e, [0, -1, 0], e.pos, true);
}
function setState(e, s) {
  e.state = s;
  e.stateTime = 0;
}
function applyGravityAndMove(world, e, vx, vz, dt) {
  e.vel[1] -= GRAVITY * dt;
  if (e.vel[1] < -30)
    e.vel[1] = -30;
  scratchC[0] = vx * dt;
  scratchC[1] = e.vel[1] * dt;
  scratchC[2] = vz * dt;
  const res = world.static.moveCharacter(e.pos, scratchC, ENEMY_RADIUS, ENEMY_HEIGHT, 0.42, e.grounded);
  e.grounded = res.grounded;
  if (res.grounded && e.vel[1] < 0)
    e.vel[1] = 0;
  if (res.hitCeiling && e.vel[1] > 0)
    e.vel[1] = 0;
}
function nextWaypoint(world, e, target, dt) {
  const straight = distXZ(target, e.pos) < 2.2 && Math.abs(target[1] - e.pos[1]) < 0.5;
  if (straight) {
    e.path = null;
    return target;
  }
  e.repathTimer -= dt;
  const pathEnd = e.path ? e.path[e.path.length - 1] : void 0;
  if (!e.path || e.repathTimer <= 0 || pathEnd && distXZ(pathEnd, target) > 2) {
    e.path = world.nav.findPath(e.pos, target);
    e.pathIndex = 0;
    e.repathTimer = 0.5 + world.rng.next() * 0.3;
  }
  const path = e.path;
  if (!path || path.length === 0)
    return target;
  while (e.pathIndex < path.length - 1 && distXZ(path[e.pathIndex], e.pos) < 0.4)
    e.pathIndex++;
  return path[e.pathIndex];
}
function handleShooting(world, e, dt, aligned) {
  const w = e.weapon;
  if (!w || !isGun(w.kind))
    return;
  const def = WEAPONS[w.kind];
  const params = ENEMY_PARAMS[e.kind];
  if (e.kind === "marksman") {
    if (e.telegraph > 0) {
      e.telegraph -= dt;
      if (e.telegraph <= 0) {
        e.telegraph = 0;
        fireVolley(world, e, e.lockedDir, 1, 0);
        e.fireCooldown = MARKSMAN_COOLDOWN + world.rng.next() * 0.4;
      }
      return;
    }
    if (e.aimTimer <= 0 && e.fireCooldown <= 0 && aligned) {
      aimDirection(world, e, params.aimError, e.lockedDir);
      e.telegraph = TELEGRAPH;
    }
    return;
  }
  if (e.burstLeft > 0) {
    e.burstTimer -= dt;
    if (e.burstTimer <= 0) {
      const dir = aimDirection(world, e, params.aimError * 1.3, v3());
      fireVolley(world, e, dir, def.pellets, def.spread);
      e.burstLeft--;
      e.burstTimer = def.burstInterval * 1.4;
    }
    return;
  }
  if (e.aimTimer <= 0 && e.fireCooldown <= 0 && aligned) {
    const dir = aimDirection(world, e, params.aimError, v3());
    fireVolley(world, e, dir, def.pellets, def.spread);
    e.burstLeft = def.burst - 1;
    e.burstTimer = def.burstInterval * 1.4;
    e.fireCooldown = def.cooldown * params.cooldownMul + world.rng.next() * 0.6;
  }
}
function aimDirection(world, e, errorDeg, out) {
  const muzzle = enemyMuzzle(e, v3());
  const p = world.player;
  const tx = p.pos[0], ty = p.pos[1] + 1.25, tz = p.pos[2];
  const d = Math.hypot(tx - muzzle[0], ty - muzzle[1], tz - muzzle[2]);
  const lead = d / BULLET_SPEED * 0.5;
  out[0] = tx + p.vel[0] * lead - muzzle[0];
  out[1] = ty + p.vel[1] * lead * 0.3 - muzzle[1];
  out[2] = tz + p.vel[2] * lead - muzzle[2];
  world.perturbDirection(out, errorDeg);
  return out;
}
function fireVolley(world, e, dir, pellets, spread) {
  const muzzle = enemyMuzzle(e, v3());
  const chest = [e.pos[0], e.pos[1] + 1.4, e.pos[2]];
  if (!world.static.lineClear(chest, muzzle))
    return;
  const shotId = world.newShotId();
  e.lastShotId = shotId;
  for (let i = 0; i < Math.max(1, pellets); i++) {
    const d = [dir[0], dir[1], dir[2]];
    if (pellets > 1)
      world.perturbDirection(d, spread);
    world.spawnProjectile(muzzle, d, e.id, shotId);
  }
  world.events.push({ type: "shot", pos: muzzle, dir: [dir[0], dir[1], dir[2]], weapon: e.weapon?.kind ?? "pistol", byPlayer: false });
}
function meleeStrike(world, e) {
  e.meleeCooldown = 0.9;
  const p = world.player;
  if (!p.alive)
    return;
  const dx = p.pos[0] - e.pos[0];
  const dz = p.pos[2] - e.pos[2];
  const d = Math.hypot(dx, dz);
  const facing = Math.abs(angleDiff(yawOf(dx, dz), e.yaw)) < 0.9;
  const vertical = Math.abs(p.pos[1] - e.pos[1]) < 1.2;
  if (d < MELEE_RANGE + 0.15 && facing && vertical) {
    world.killPlayer([dx / Math.max(d, 1e-3), 0, dz / Math.max(d, 1e-3)]);
  }
}

var EYE_HEIGHT = 1.6;
var PLAYER_RADIUS = 0.3;
var PLAYER_HEIGHT = 1.75;
var PLAYER_BODY_A = 0.3;
var PLAYER_BODY_B = 1.5;
var PLAYER_BODY_R = 0.26;
var REACH = 2.6;
var PROP_PHYS_RADIUS = 0.05;
var GRAVITY2 = 16;
var THROW_SPEED = 15;
var PUNCH_COOLDOWN = 0.32;
var PUNCH_RANGE = 1.7;
var SLASH_RANGE = 2.2;
var SHOT_HEARING = 16;
var REST_ROT = {
  pistol: [0, Math.PI / 2],
  scatter: [0, Math.PI / 2],
  carbine: [0, Math.PI / 2],
  blade: [0, Math.PI / 2],
  bottle: [Math.PI / 2, 0],
  brick: [0, 0],
  mug: [0, 0]
};
var World = class {
  def;
  static;
  nav;
  rng;
  events = [];
  enemies = [];
  props = [];
  projectiles = [];
  player;
  stats = { kills: 0, shots: 0 };
  simTime = 0;
  cleared = false;
  failed = false;
  aimProp = null;
  nextId = 1;
  shotCounter = 0;
  waveIndex = 0;
  waveArmed = false;
  waveDelay = 0;
  lastWaveTime = 0;
  spawnQueue = [];
  recentShots = [];
  constructor(def, sharedStatic) {
    this.def = def;
    this.rng = new Rng(def.seed);
    if (sharedStatic) {
      this.static = sharedStatic.static;
      this.nav = sharedStatic.nav;
    } else {
      const boxes = def.boxes.filter((b) => b.collide).map((b) => ({ min: [...b.min], max: [...b.max] }));
      this.static = new StaticWorld(boxes);
      this.nav = new NavGrid(this.static);
    }
    const p = def.player;
    this.player = {
      pos: [p.pos[0], p.pos[1], p.pos[2]],
      vel: v3(),
      yaw: p.yaw,
      pitch: 0,
      grounded: true,
      alive: true,
      invulnerable: false,
      held: p.item ? newItem(p.item) : null,
      fireCooldown: 0,
      burstLeft: 0,
      burstTimer: 0,
      punchCooldown: 0,
      punchSide: 1,
      punchAge: 99,
      recoilAge: 99,
      throwAge: 99,
      slashAge: 99,
      pickupAge: 99
    };
    for (const ps of def.props)
      this.addProp(newItem(ps.kind), ps.pos, [0, 0, 0], false);
    this.updateWaves(0);
    this.flushSpawnQueue(true);
  }
  get staticData() {
    return { static: this.static, nav: this.nav };
  }
  playerEye(out) {
    out[0] = this.player.pos[0];
    out[1] = this.player.pos[1] + EYE_HEIGHT;
    out[2] = this.player.pos[2];
    return out;
  }
  newShotId() {
    return ++this.shotCounter;
  }
  get aliveEnemies() {
    return this.enemies.length;
  }
  get remainingEnemies() {
    let queued = this.spawnQueue.length;
    for (let i = this.waveIndex; i < this.def.waves.length; i++)
      queued += this.def.waves[i].spawns.length;
    return this.enemies.length + queued;
  }
  applyPlayerFrame(f) {
    const p = this.player;
    copy(p.pos, f.pos);
    copy(p.vel, f.vel);
    p.yaw = f.yaw;
    p.pitch = f.pitch;
    p.grounded = f.grounded;
    if (!p.alive)
      return false;
    this.aimProp = this.findAimProp();
    let acted = false;
    if (f.interact) {
      const target = this.aimProp ?? this.nearestPropInRadius(1.4);
      if (target) {
        if (p.held)
          this.throwHeld(0.35);
        this.pickUp(target);
        acted = true;
      }
    }
    if (f.throwItem && p.held) {
      this.throwHeld(1);
      acted = true;
    }
    if (f.fire) {
      acted = this.primaryAction() || acted;
    }
    if (p.pos[1] < -6)
      this.killPlayer([0, -1, 0]);
    return acted;
  }
  primaryAction() {
    const p = this.player;
    const held = p.held;
    if (held) {
      if (isGun(held.kind)) {
        if (p.fireCooldown > 0 || p.burstLeft > 0)
          return false;
        if (held.ammo <= 0) {
          this.events.push({ type: "dryFire" });
          this.throwHeld(1);
          return true;
        }
        const def = WEAPONS[held.kind];
        held.ammo--;
        p.fireCooldown = def.cooldown;
        p.burstLeft = def.burst - 1;
        p.burstTimer = def.burstInterval;
        this.playerVolley(held.kind);
        return true;
      }
      if (held.kind === "blade") {
        if (p.fireCooldown > 0)
          return false;
        p.fireCooldown = WEAPONS.blade.cooldown;
        this.slash();
        return true;
      }
      this.throwHeld(1);
      return true;
    }
    if (this.aimProp && distSq(this.aimProp.pos, this.playerEye(v3())) < 2.2 * 2.2) {
      this.pickUp(this.aimProp);
      return true;
    }
    if (p.punchCooldown <= 0) {
      this.punch();
      return true;
    }
    return false;
  }
  forward(out) {
    return dirFromYawPitch(out, this.player.yaw, this.player.pitch);
  }
  playerVolley(kind) {
    const p = this.player;
    const def = WEAPONS[kind];
    const eye = this.playerEye(v3());
    const fwd = this.forward(v3());
    const right = [Math.cos(p.yaw), 0, -Math.sin(p.yaw)];
    const hit = this.static.raycast(eye, fwd, 80);
    const target = hit ? hit.point : [eye[0] + fwd[0] * 80, eye[1] + fwd[1] * 80, eye[2] + fwd[2] * 80];
    let muzzle = [
      eye[0] + fwd[0] * 0.45 + right[0] * 0.14,
      eye[1] + fwd[1] * 0.45 - 0.1,
      eye[2] + fwd[2] * 0.45 + right[2] * 0.14
    ];
    if (!this.static.lineClear(eye, muzzle))
      muzzle = [eye[0], eye[1], eye[2]];
    const dir = [target[0] - muzzle[0], target[1] - muzzle[1], target[2] - muzzle[2]];
    if (len(dir) < 1.5)
      copy(dir, fwd);
    normalize(dir, dir);
    const shotId = this.newShotId();
    for (let i = 0; i < Math.max(1, def.pellets); i++) {
      const d = [dir[0], dir[1], dir[2]];
      if (def.pellets > 1 || def.spread > 0)
        this.perturbDirection(d, def.spread);
      this.spawnProjectile(muzzle, d, 0, shotId);
    }
    this.stats.shots++;
    p.recoilAge = 0;
    this.recentShots.push({ pos: [eye[0], eye[1], eye[2]], time: this.simTime });
    this.events.push({ type: "shot", pos: muzzle, dir, weapon: kind, byPlayer: true });
  }
  punch() {
    const p = this.player;
    p.punchCooldown = PUNCH_COOLDOWN;
    p.punchAge = 0;
    p.punchSide = -p.punchSide;
    const target = this.meleeTarget(PUNCH_RANGE, 0.65);
    const fwd = this.forward(v3());
    if (!target) {
      this.events.push({ type: "punch", hit: false, pos: this.playerEye(v3()) });
      return;
    }
    target.hp--;
    target.hitFlash = 1;
    const hitPos = [target.pos[0], target.pos[1] + 1.3, target.pos[2]];
    this.events.push({ type: "punch", hit: true, pos: hitPos });
    if (target.hp <= 0) {
      this.killEnemy(target, fwd, hitPos, false);
    } else {
      this.disarm(target, fwd);
      this.stun(target, 0.9, fwd, 2.5);
    }
  }
  slash() {
    const p = this.player;
    p.slashAge = 0;
    const eye = this.playerEye(v3());
    const fwd = this.forward(v3());
    let hit = false;
    for (const e of this.enemies) {
      if (!e.alive || e.spawnT < 1)
        continue;
      const to = [e.pos[0] - eye[0], e.pos[1] + 1.1 - eye[1], e.pos[2] - eye[2]];
      const d = len(to);
      if (d > SLASH_RANGE)
        continue;
      normalize(to, to);
      if (dot(to, fwd) < 0.45)
        continue;
      if (!this.static.lineClear(eye, [e.pos[0], e.pos[1] + 1.1, e.pos[2]]))
        continue;
      this.killEnemy(e, fwd, [e.pos[0], e.pos[1] + 1.2, e.pos[2]], false);
      hit = true;
    }
    for (const b of this.projectiles) {
      if (!b.alive || b.ownerId === 0)
        continue;
      const to = [b.pos[0] - eye[0], b.pos[1] - eye[1], b.pos[2] - eye[2]];
      const d = len(to);
      if (d > 2)
        continue;
      normalize(to, to);
      if (dot(to, fwd) < 0.25)
        continue;
      b.alive = false;
      this.events.push({ type: "slice", pos: [b.pos[0], b.pos[1], b.pos[2]], dir: [b.vel[0], b.vel[1], b.vel[2]] });
      hit = true;
    }
    this.events.push({ type: "slash", hit });
  }
  meleeTarget(range, minDot) {
    const eye = this.playerEye(v3());
    const fwd = this.forward(v3());
    let best = null;
    let bestD = Infinity;
    for (const e of this.enemies) {
      if (!e.alive || e.spawnT < 1)
        continue;
      const chest = [e.pos[0], e.pos[1] + 1.25, e.pos[2]];
      const to = [chest[0] - eye[0], chest[1] - eye[1], chest[2] - eye[2]];
      const d = len(to);
      if (d > range + 0.3)
        continue;
      normalize(to, to);
      if (dot(to, fwd) < minDot)
        continue;
      if (d < bestD && this.static.lineClear(eye, chest)) {
        best = e;
        bestD = d;
      }
    }
    return best;
  }
  throwHeld(strength) {
    const p = this.player;
    const item = p.held;
    if (!item)
      return;
    p.held = null;
    p.burstLeft = 0;
    p.throwAge = 0;
    const eye = this.playerEye(v3());
    const fwd = this.forward(v3());
    const right = [Math.cos(p.yaw), 0, -Math.sin(p.yaw)];
    let start = [eye[0] + fwd[0] * 0.45 + right[0] * 0.12, eye[1] + fwd[1] * 0.45 - 0.08, eye[2] + fwd[2] * 0.45 + right[2] * 0.12];
    if (!this.static.lineClear(eye, start))
      start = [eye[0], eye[1] - 0.05, eye[2]];
    const s = THROW_SPEED * strength;
    const vel = [fwd[0] * s + p.vel[0], fwd[1] * s + 1.2 * strength + p.vel[1] * 0.5, fwd[2] * s + p.vel[2]];
    const prop = this.addProp(item, start, vel, strength > 0.5);
    prop.rot = [0, p.yaw, 0];
    prop.angVel = [this.rng.sym(12) - 8 * strength, this.rng.sym(4), this.rng.sym(6)];
    this.events.push({ type: "throw" });
  }
  pickUp(prop) {
    const p = this.player;
    prop.alive = false;
    p.held = prop.item;
    p.fireCooldown = Math.max(p.fireCooldown, 0.12);
    p.pickupAge = 0;
    this.events.push({ type: "pickup", kind: prop.item.kind });
  }
  findAimProp() {
    const eye = this.playerEye(v3());
    const fwd = this.forward(v3());
    let best = null;
    let bestScore = Infinity;
    for (const pr of this.props) {
      if (!pr.alive || pr.thrown)
        continue;
      const to = [pr.pos[0] - eye[0], pr.pos[1] - eye[1], pr.pos[2] - eye[2]];
      const along = dot(to, fwd);
      if (along < 0.1 || along > REACH)
        continue;
      const perp = Math.sqrt(Math.max(0, distSq(to, [0, 0, 0]) - along * along));
      const tol = 0.3 + along * 0.06;
      if (perp > tol)
        continue;
      const score = perp / tol + along * 0.1;
      if (score < bestScore && this.static.lineClear(eye, pr.pos)) {
        best = pr;
        bestScore = score;
      }
    }
    return best;
  }
  nearestPropInRadius(r) {
    let best = null;
    let bestD = r;
    for (const pr of this.props) {
      if (!pr.alive || pr.thrown)
        continue;
      const d = distXZ(pr.pos, this.player.pos);
      if (d < bestD && Math.abs(pr.pos[1] - this.player.pos[1]) < 1.8) {
        best = pr;
        bestD = d;
      }
    }
    return best;
  }
  spawnProjectile(origin, dir, ownerId, shotId) {
    this.projectiles.push({
      pos: [origin[0], origin[1], origin[2]],
      prevPos: [origin[0], origin[1], origin[2]],
      vel: [dir[0] * BULLET_SPEED, dir[1] * BULLET_SPEED, dir[2] * BULLET_SPEED],
      spawnPos: [origin[0], origin[1], origin[2]],
      ownerId,
      shotId,
      age: 0,
      alive: true
    });
    if (ownerId !== 0)
      this.recentShots.push({ pos: [origin[0], origin[1], origin[2]], time: this.simTime });
  }
  perturbDirection(d, coneDeg) {
    normalize(d, d);
    if (coneDeg <= 0)
      return;
    const ang = coneDeg * Math.PI / 180;
    const up = Math.abs(d[1]) < 0.95 ? [0, 1, 0] : [1, 0, 0];
    const ax = [d[1] * up[2] - d[2] * up[1], d[2] * up[0] - d[0] * up[2], d[0] * up[1] - d[1] * up[0]];
    normalize(ax, ax);
    const ay = [d[1] * ax[2] - d[2] * ax[1], d[2] * ax[0] - d[0] * ax[2], d[0] * ax[1] - d[1] * ax[0]];
    const r = Math.sqrt(this.rng.next()) * Math.tan(ang);
    const phi = this.rng.next() * Math.PI * 2;
    const ox = Math.cos(phi) * r, oy = Math.sin(phi) * r;
    d[0] += ax[0] * ox + ay[0] * oy;
    d[1] += ax[1] * ox + ay[1] * oy;
    d[2] += ax[2] * ox + ay[2] * oy;
    normalize(d, d);
  }
  heardShot(pos) {
    for (const s of this.recentShots) {
      if (this.simTime - s.time < 0.5 && distSq(s.pos, pos) < SHOT_HEARING * SHOT_HEARING)
        return true;
    }
    return false;
  }
  killPlayer(dir) {
    const p = this.player;
    if (!p.alive || p.invulnerable)
      return;
    p.alive = false;
    this.failed = true;
    this.events.push({ type: "playerDeath", dir });
  }
  killEnemy(e, dir, point, silent) {
    if (!e.alive)
      return;
    e.alive = false;
    this.stats.kills++;
    if (!silent)
      this.disarm(e, dir);
    this.events.push({ type: "enemyDeath", enemy: e, dir: [dir[0], dir[1], dir[2]], point: [point[0], point[1], point[2]], silent });
  }
  disarm(e, dir) {
    if (!e.weapon)
      return;
    const item = e.weapon;
    e.weapon = null;
    e.burstLeft = 0;
    e.telegraph = 0;
    if (!isWeapon(item.kind))
      return;
    const dropped = newItem(item.kind);
    const muzzle = enemyMuzzle(e, v3());
    const vel = [dir[0] * 2 + this.rng.sym(0.8), 2.2 + this.rng.next(), dir[2] * 2 + this.rng.sym(0.8)];
    const pos = [muzzle[0], muzzle[1], muzzle[2]];
    if (!this.static.lineClear([e.pos[0], e.pos[1] + 1.3, e.pos[2]], pos)) {
      pos[0] = e.pos[0];
      pos[1] = e.pos[1] + 1.3;
      pos[2] = e.pos[2];
    }
    const pr = this.addProp(dropped, pos, vel, false);
    pr.angVel = [this.rng.sym(8), this.rng.sym(8), this.rng.sym(8)];
  }
  stun(e, seconds, dir, push) {
    e.state = "stunned";
    e.stateTime = 0;
    e.stunTimer = seconds;
    e.meleeT = 0;
    e.telegraph = 0;
    e.burstLeft = 0;
    e.vel[0] += dir[0] * push;
    e.vel[2] += dir[2] * push;
    this.events.push({ type: "enemyHit", pos: [e.pos[0], e.pos[1] + 1.3, e.pos[2]], dir: [dir[0], dir[1], dir[2]] });
  }
  findGunPropFor(e) {
    if (e.targetPropId >= 0) {
      const cur = this.props.find((p) => p.id === e.targetPropId && p.alive && !p.thrown);
      if (cur)
        return cur;
      e.targetPropId = -1;
    }
    let best = null;
    let bestD = 10;
    for (const pr of this.props) {
      if (!pr.alive || pr.thrown || !isGun(pr.item.kind) || pr.claimedBy >= 0 && pr.claimedBy !== e.id)
        continue;
      if (Math.hypot(pr.vel[0], pr.vel[1], pr.vel[2]) > 1)
        continue;
      const d = distXZ(pr.pos, e.pos);
      if (d < bestD && Math.abs(pr.pos[1] - e.pos[1]) < 1.2) {
        best = pr;
        bestD = d;
      }
    }
    if (best) {
      best.claimedBy = e.id;
      e.targetPropId = best.id;
    }
    return best;
  }
  enemyPickUp(e, prop) {
    prop.alive = false;
    e.weapon = prop.item;
    e.targetPropId = -1;
    e.fireCooldown = 0.8;
    e.aimTimer = 0.6;
  }
  step(dt) {
    this.simTime += dt;
    const p = this.player;
    for (const e of this.enemies)
      savePrev(e);
    for (const pr of this.props) {
      copy(pr.prevPos, pr.pos);
      copy(pr.prevRot, pr.rot);
    }
    p.fireCooldown -= dt;
    p.punchCooldown -= dt;
    p.punchAge += dt;
    p.recoilAge += dt;
    p.throwAge += dt;
    p.slashAge += dt;
    p.pickupAge += dt;
    if (p.burstLeft > 0 && p.alive) {
      p.burstTimer -= dt;
      if (p.burstTimer <= 0) {
        const held = p.held;
        if (held && isGun(held.kind) && held.ammo > 0) {
          held.ammo--;
          this.playerVolley(held.kind);
          p.burstLeft--;
          p.burstTimer = WEAPONS[held.kind].burstInterval;
        } else {
          p.burstLeft = 0;
        }
      }
    }
    this.updateWaves(dt);
    this.flushSpawnQueue(false);
    for (const e of this.enemies)
      if (e.alive)
        updateEnemy(this, e, dt);
    this.stepProps(dt);
    this.stepProjectiles(dt);
    removeDead(this.enemies);
    removeDead(this.props);
    removeDead(this.projectiles);
    while (this.recentShots.length > 0 && this.simTime - this.recentShots[0].time > 1)
      this.recentShots.shift();
    this.checkWin();
  }
  updateWaves(dt) {
    const waves = this.def.waves;
    while (this.waveIndex < waves.length) {
      const w = waves[this.waveIndex];
      if (!this.waveArmed) {
        let ok = false;
        const t = w.when;
        switch (t.type) {
          case "start":
            ok = true;
            break;
          case "remaining":
            ok = this.enemies.length + this.spawnQueue.length <= t.count;
            break;
          case "zone": {
            const [x0, z0, x1, z1] = t.rect;
            const px = this.player.pos[0], pz = this.player.pos[2];
            ok = px >= Math.min(x0, x1) && px <= Math.max(x0, x1) && pz >= Math.min(z0, z1) && pz <= Math.max(z0, z1);
            break;
          }
          case "time":
            ok = this.simTime - this.lastWaveTime >= t.seconds;
            break;
        }
        if (!ok)
          break;
        this.waveArmed = true;
        this.waveDelay = w.delay ?? 0;
      }
      this.waveDelay -= dt;
      if (this.waveDelay > 0)
        break;
      for (const s of w.spawns)
        this.spawnQueue.push({ spawn: s });
      this.waveIndex++;
      this.waveArmed = false;
      this.lastWaveTime = this.simTime;
    }
  }
  flushSpawnQueue(initial) {
    const max = this.def.maxActive ?? 8;
    while (this.spawnQueue.length > 0 && this.enemies.length < max) {
      const q = this.spawnQueue.shift();
      const s = q.spawn;
      const pos = s.pos.length === 2 ? [s.pos[0], 0.05, s.pos[1]] : [s.pos[0], s.pos[1] + 0.05, s.pos[2]];
      const yaw = s.yaw ?? Math.atan2(-(this.player.pos[0] - pos[0]), -(this.player.pos[2] - pos[2]));
      const e = createEnemy(this.nextId++, s.kind, pos, yaw, s.weapon, !!s.idle, this.rng.next());
      if (initial)
        e.spawnT = 1;
      e.prevSpawnT = e.spawnT;
      this.enemies.push(e);
      if (!initial)
        this.events.push({ type: "spawn", pos: [pos[0], pos[1], pos[2]] });
    }
  }
  checkWin() {
    if (this.cleared || this.failed || !this.player.alive)
      return;
    const allSpawned = this.waveIndex >= this.def.waves.length && this.spawnQueue.length === 0;
    const allDead = allSpawned && this.enemies.length === 0;
    const exit = this.def.exit;
    if (exit) {
      const [x0, z0, x1, z1] = exit.rect;
      const px = this.player.pos[0], pz = this.player.pos[2];
      const inside = px >= Math.min(x0, x1) && px <= Math.max(x0, x1) && pz >= Math.min(z0, z1) && pz <= Math.max(z0, z1);
      if (inside && (!exit.requiresClear || allDead))
        this.cleared = true;
    } else if (allDead) {
      this.cleared = true;
    }
    if (this.cleared)
      this.player.invulnerable = true;
  }
  addProp(item, pos, vel, thrown) {
    const pr = {
      id: this.nextId++,
      item,
      pos: [pos[0], pos[1], pos[2]],
      prevPos: [pos[0], pos[1], pos[2]],
      vel: [vel[0], vel[1], vel[2]],
      rot: [REST_ROT[item.kind][0], 0, REST_ROT[item.kind][1]],
      prevRot: [REST_ROT[item.kind][0], 0, REST_ROT[item.kind][1]],
      angVel: v3(),
      thrown,
      sleeping: false,
      restTimer: 0,
      alive: true,
      claimedBy: -1
    };
    this.props.push(pr);
    return pr;
  }
  stepProps(dt) {
    for (const pr of this.props) {
      if (!pr.alive || pr.sleeping)
        continue;
      const prev = [pr.pos[0], pr.pos[1], pr.pos[2]];
      pr.vel[1] -= GRAVITY2 * dt;
      const drag = 1 - 0.05 * dt;
      pr.vel[0] *= drag;
      pr.vel[2] *= drag;
      pr.pos[0] += pr.vel[0] * dt;
      pr.pos[1] += pr.vel[1] * dt;
      pr.pos[2] += pr.vel[2] * dt;
      pr.rot[0] += pr.angVel[0] * dt;
      pr.rot[1] += pr.angVel[1] * dt;
      pr.rot[2] += pr.angVel[2] * dt;
      if (pr.thrown) {
        const hitR = ITEM_RADIUS[pr.item.kind];
        for (const e of this.enemies) {
          if (!e.alive || e.spawnT < 1)
            continue;
          const head = [e.pos[0], e.pos[1] + HEAD_OFFSET, e.pos[2]];
          const th = segmentSphere(prev, pr.pos, head, HEAD_RADIUS + hitR);
          const tb = segmentCapsule(prev, pr.pos, [e.pos[0], e.pos[1] + BODY_A, e.pos[2]], [e.pos[0], e.pos[1] + BODY_B, e.pos[2]], BODY_RADIUS + hitR);
          if (th < 0 && tb < 0)
            continue;
          const dir = normalize(v3(), pr.vel);
          const heavy = pr.item.kind === "brick" || isWeapon(pr.item.kind);
          if (th >= 0) {
            this.killEnemy(e, dir, head, false);
          } else {
            this.disarm(e, dir);
            this.stun(e, heavy ? 1.6 : 1.3, dir, 3);
            e.hitFlash = 1;
          }
          pr.vel[0] *= -0.25;
          pr.vel[1] = Math.abs(pr.vel[1]) * 0.3 + 1;
          pr.vel[2] *= -0.25;
          pr.thrown = false;
          if (FRAGILE[pr.item.kind])
            this.breakProp(pr);
          break;
        }
        if (!pr.alive)
          continue;
      }
      const res = this.static.resolveSphere(pr.pos, pr.vel, PROP_PHYS_RADIUS, 0.3, 0.12);
      if (res.impact > 0.5) {
        pr.angVel[0] *= 0.6;
        pr.angVel[1] *= 0.6;
        pr.angVel[2] *= 0.6;
        if (res.impact > 2)
          this.events.push({ type: "propImpact", pos: [pr.pos[0], pr.pos[1], pr.pos[2]], speed: res.impact });
        if (pr.thrown && FRAGILE[pr.item.kind] && res.impact > 4) {
          this.breakProp(pr);
          continue;
        }
        if (pr.thrown && res.impact > 3)
          pr.thrown = false;
      }
      const speed = len(pr.vel);
      if (pr.thrown && speed < 4)
        pr.thrown = false;
      if (res.grounded && speed < 0.35) {
        pr.restTimer += dt;
        pr.angVel[0] *= 0.8;
        pr.angVel[1] *= 0.8;
        pr.angVel[2] *= 0.8;
        if (pr.restTimer > 0.35) {
          pr.sleeping = true;
          pr.vel[0] = pr.vel[1] = pr.vel[2] = 0;
          const rest = REST_ROT[pr.item.kind];
          pr.rot[0] = rest[0];
          pr.rot[2] = rest[1];
          copy(pr.prevRot, pr.rot);
        }
      } else {
        pr.restTimer = 0;
      }
      if (pr.pos[1] < -10)
        pr.alive = false;
    }
  }
  breakProp(pr) {
    pr.alive = false;
    this.events.push({ type: "itemBreak", pos: [pr.pos[0], pr.pos[1], pr.pos[2]], kind: pr.item.kind });
  }
  wake(pr) {
    pr.sleeping = false;
    pr.restTimer = 0;
  }
  stepProjectiles(dt) {
    const bullets = this.projectiles;
    const playerHead = v3();
    const pa = v3();
    const pb = v3();
    const dirN = v3();
    for (const b of bullets) {
      if (!b.alive)
        continue;
      copy(b.prevPos, b.pos);
      b.age += dt;
      if (b.age > BULLET_LIFE) {
        b.alive = false;
        continue;
      }
      const next = [b.pos[0] + b.vel[0] * dt, b.pos[1] + b.vel[1] * dt, b.pos[2] + b.vel[2] * dt];
      const segLen = BULLET_SPEED * dt;
      normalize(dirN, b.vel);
      let bestT = 1;
      let hitKind = "none";
      let hitEnemy = null;
      let hitProp = null;
      let hitNormal = [0, 1, 0];
      const sh = this.static.raycast(b.pos, dirN, segLen);
      if (sh) {
        bestT = sh.t / segLen;
        hitKind = "static";
        hitNormal = sh.normal;
      }
      for (const e of this.enemies) {
        if (!e.alive || e.spawnT < 1)
          continue;
        if (e.id === b.ownerId && b.age < 0.25)
          continue;
        if (Math.abs(e.pos[0] - b.pos[0]) > 3 || Math.abs(e.pos[2] - b.pos[2]) > 3)
          continue;
        const head = [e.pos[0], e.pos[1] + HEAD_OFFSET, e.pos[2]];
        const th = segmentSphere(b.pos, next, head, HEAD_RADIUS + BULLET_RADIUS);
        if (th >= 0 && th < bestT) {
          bestT = th;
          hitKind = "head";
          hitEnemy = e;
        }
        pa[0] = e.pos[0];
        pa[1] = e.pos[1] + BODY_A;
        pa[2] = e.pos[2];
        pb[0] = e.pos[0];
        pb[1] = e.pos[1] + BODY_B;
        pb[2] = e.pos[2];
        const tb = segmentCapsule(b.pos, next, pa, pb, BODY_RADIUS + BULLET_RADIUS);
        if (tb >= 0 && tb < bestT) {
          bestT = tb;
          hitKind = "enemy";
          hitEnemy = e;
        }
      }
      const p = this.player;
      if (b.ownerId !== 0 && p.alive) {
        pa[0] = p.pos[0];
        pa[1] = p.pos[1] + PLAYER_BODY_A;
        pa[2] = p.pos[2];
        pb[0] = p.pos[0];
        pb[1] = p.pos[1] + PLAYER_BODY_B;
        pb[2] = p.pos[2];
        const tp = segmentCapsule(b.pos, next, pa, pb, PLAYER_BODY_R + BULLET_RADIUS);
        this.playerEye(playerHead);
        const thd = segmentSphere(b.pos, next, playerHead, 0.16);
        const t = tp >= 0 && thd >= 0 ? Math.min(tp, thd) : Math.max(tp, thd);
        if (t >= 0 && t < bestT) {
          bestT = t;
          hitKind = "player";
        }
      }
      for (const pr of this.props) {
        if (!pr.alive)
          continue;
        if (Math.abs(pr.pos[0] - b.pos[0]) > 1.5 || Math.abs(pr.pos[2] - b.pos[2]) > 1.5)
          continue;
        const t = segmentSphere(b.pos, next, pr.pos, ITEM_RADIUS[pr.item.kind] + BULLET_RADIUS);
        if (t >= 0 && t < bestT) {
          bestT = t;
          hitKind = "prop";
          hitProp = pr;
        }
      }
      const hitPoint = [b.pos[0] + (next[0] - b.pos[0]) * bestT, b.pos[1] + (next[1] - b.pos[1]) * bestT, b.pos[2] + (next[2] - b.pos[2]) * bestT];
      switch (hitKind) {
        case "none":
          copy(b.pos, next);
          break;
        case "static":
          b.alive = false;
          copy(b.pos, hitPoint);
          this.events.push({ type: "impact", pos: hitPoint, normal: hitNormal });
          break;
        case "head":
        case "enemy":
          b.alive = false;
          copy(b.pos, hitPoint);
          if (hitEnemy)
            this.killEnemy(hitEnemy, [dirN[0], dirN[1], dirN[2]], hitPoint, false);
          break;
        case "player":
          b.alive = false;
          copy(b.pos, hitPoint);
          this.killPlayer([dirN[0], dirN[1], dirN[2]]);
          break;
        case "prop":
          b.alive = false;
          copy(b.pos, hitPoint);
          if (hitProp) {
            this.wake(hitProp);
            hitProp.vel[0] += dirN[0] * 3;
            hitProp.vel[1] += 1.5;
            hitProp.vel[2] += dirN[2] * 3;
            hitProp.angVel[0] += this.rng.sym(10);
            hitProp.angVel[2] += this.rng.sym(10);
            if (FRAGILE[hitProp.item.kind])
              this.breakProp(hitProp);
          }
          this.events.push({ type: "impact", pos: hitPoint, normal: [-dirN[0], -dirN[1], -dirN[2]] });
          break;
      }
    }
    const n = bullets.length;
    for (let i = 0; i < n; i++) {
      const a = bullets[i];
      if (!a.alive)
        continue;
      for (let j = i + 1; j < n; j++) {
        const c = bullets[j];
        if (!c.alive || c.shotId === a.shotId)
          continue;
        if (distSq(a.pos, c.pos) < 0.16 * 0.16 || segmentSphere(a.prevPos, a.pos, c.pos, 0.12) >= 0) {
          a.alive = false;
          c.alive = false;
          this.events.push({ type: "bulletClash", pos: [(a.pos[0] + c.pos[0]) / 2, (a.pos[1] + c.pos[1]) / 2, (a.pos[2] + c.pos[2]) / 2] });
          break;
        }
      }
    }
  }
  activeLasers() {
    const out = [];
    for (const e of this.enemies) {
      if (!e.alive || e.telegraph <= 0)
        continue;
      out.push({ origin: enemyMuzzle(e, v3()), dir: [...e.lockedDir], progress: clamp(1 - e.telegraph / 0.6, 0, 1) });
    }
    return out;
  }
};
function removeDead(list) {
  let w = 0;
  for (let r = 0; r < list.length; r++) {
    const item = list[r];
    if (item.alive)
      list[w++] = item;
  }
  list.length = w;
}

var WALK_SPEED = 4;
var ACCEL = 30;
var AIR_ACCEL = 10;
var GRAVITY3 = 16;
var JUMP_VELOCITY = Math.sqrt(2 * GRAVITY3 * 1);
var MAX_PITCH2 = Math.PI / 2 - 0.02;
var STEP_HEIGHT = 0.42;
var PlayerController = class {
  pos = v3();
  vel = v3();
  yaw = 0;
  pitch = 0;
  grounded = true;
  lookSpeed = 0;
  stride = 0;
  mouseDx = 0;
  mouseDy = 0;
  delta = v3();
  reset(pos, yaw) {
    this.pos[0] = pos[0];
    this.pos[1] = pos[1];
    this.pos[2] = pos[2];
    this.vel[0] = this.vel[1] = this.vel[2] = 0;
    this.yaw = yaw;
    this.pitch = 0;
    this.grounded = true;
    this.stride = 0;
  }
  look(input, dt, s) {
    this.mouseDx = input.mouseDx;
    this.mouseDy = input.mouseDy;
    this.yaw += input.mouseDx * s.sensitivity;
    this.pitch -= input.mouseDy * s.sensitivity * (s.invertY ? -1 : 1);
    this.pitch = clamp(this.pitch, -MAX_PITCH2, MAX_PITCH2);
    this.yaw %= Math.PI * 2;
    this.lookSpeed = dt > 0 ? Math.hypot(input.mouseDx, input.mouseDy) / dt : 0;
  }
  update(input, dt, world, s, canMove) {
    this.look(input, dt, s);
    const axes = canMove ? input.moveAxes() : { x: 0, y: 0 };
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
    const wishX = (fx * axes.y + rx * axes.x) * WALK_SPEED;
    const wishZ = (fz * axes.y + rz * axes.x) * WALK_SPEED;
    const a = (this.grounded ? ACCEL : AIR_ACCEL) * dt;
    this.vel[0] += clamp(wishX - this.vel[0], -a, a);
    this.vel[2] += clamp(wishZ - this.vel[2], -a, a);
    if (canMove && this.grounded && input.wasPressed("jump")) {
      this.vel[1] = JUMP_VELOCITY;
      this.grounded = false;
    }
    this.vel[1] -= GRAVITY3 * dt;
    if (this.vel[1] < -40)
      this.vel[1] = -40;
    this.delta[0] = this.vel[0] * dt;
    this.delta[1] = this.vel[1] * dt;
    this.delta[2] = this.vel[2] * dt;
    const res = world.static.moveCharacter(this.pos, this.delta, PLAYER_RADIUS, PLAYER_HEIGHT, STEP_HEIGHT, this.grounded);
    this.grounded = res.grounded;
    if (res.grounded && this.vel[1] < 0)
      this.vel[1] = 0;
    if (res.hitCeiling && this.vel[1] > 0)
      this.vel[1] = 0;
    for (const e of world.enemies) {
      if (!e.alive || e.spawnT < 1)
        continue;
      if (Math.abs(e.pos[1] - this.pos[1]) > 1.6)
        continue;
      const dx = this.pos[0] - e.pos[0];
      const dz = this.pos[2] - e.pos[2];
      const d = Math.hypot(dx, dz);
      const minD = PLAYER_RADIUS + 0.3;
      if (d < minD && d > 1e-4) {
        const push = [dx / d * (minD - d), 0, dz / d * (minD - d)];
        world.static.moveCharacter(this.pos, push, PLAYER_RADIUS, PLAYER_HEIGHT, 0, false);
      }
    }
    this.stride += Math.hypot(this.vel[0], this.vel[2]) * dt;
  }
  get planarSpeed() {
    return Math.hypot(this.vel[0], this.vel[2]);
  }
  toFrame(fire, throwItem, interact) {
    return {
      pos: [this.pos[0], this.pos[1], this.pos[2]],
      vel: [this.vel[0], this.vel[1], this.vel[2]],
      yaw: this.yaw,
      pitch: this.pitch,
      grounded: this.grounded,
      fire,
      throwItem,
      interact,
      steps: 0
    };
  }
};

var TimeScaleDriver = class _TimeScaleDriver {
  static MIN = 0.015;
  static LOOK_WEIGHT = 0.35;
  static LOOK_FULL = 900;
  static KICK_TIME = 0.12;
  static RISE = 0.05;
  static FALL = 0.1;
  value = _TimeScaleDriver.MIN;
  kick = 0;
  reset() {
    this.value = _TimeScaleDriver.MIN;
    this.kick = 0;
  }
  actionKick() {
    this.kick = _TimeScaleDriver.KICK_TIME;
  }
  update(realDt, planarSpeed, maxSpeed, lookSpeed, airborne, busy) {
    this.kick = Math.max(0, this.kick - realDt);
    const moveInput = clamp(planarSpeed / maxSpeed, 0, 1);
    const lookInput = clamp(lookSpeed / _TimeScaleDriver.LOOK_FULL, 0, 1) * _TimeScaleDriver.LOOK_WEIGHT;
    const kickInput = this.kick > 0 || busy ? 1 : 0;
    let target = Math.max(moveInput, lookInput, kickInput);
    if (airborne)
      target = Math.max(target, 0.8);
    target = Math.max(target, _TimeScaleDriver.MIN);
    const tau = target > this.value ? _TimeScaleDriver.RISE : _TimeScaleDriver.FALL;
    this.value = clamp(approach(this.value, target, tau, realDt), _TimeScaleDriver.MIN, 1);
    return this.value;
  }
};

var MAX_PARTICLES = 3e3;
var MAX_SHARDS = 900;
var SHARD_LIFE = 7;
var FxSystem = class {
  particles = [];
  shards = [];
  model = mat4.create();
  tmpA = v3();
  tmpB = v3();
  clear() {
    this.particles.length = 0;
    this.shards.length = 0;
  }
  get particleCount() {
    return this.particles.length;
  }
  get shardCount() {
    return this.shards.length;
  }
  emit(p) {
    if (this.particles.length >= MAX_PARTICLES)
      this.particles.shift();
    this.particles.push({ ...p, alive: true });
  }
  sparks(pos, normal, count, color = [6, 3.2, 1.2]) {
    for (let i = 0; i < count; i++) {
      const s = visualRng.range(2, 7);
      this.emit({
        pos: [pos[0], pos[1], pos[2]],
        vel: [normal[0] * s + visualRng.sym(3), normal[1] * s + visualRng.sym(3) + 1, normal[2] * s + visualRng.sym(3)],
        life: 0,
        maxLife: visualRng.range(0.15, 0.4),
        size: visualRng.range(6e-3, 0.014),
        color,
        drag: 2,
        gravity: 9,
        streak: 0.035
      });
    }
  }
  dust(pos, normal, count) {
    for (let i = 0; i < count; i++) {
      const s = visualRng.range(0.3, 1.2);
      this.emit({
        pos: [pos[0], pos[1], pos[2]],
        vel: [normal[0] * s + visualRng.sym(0.5), normal[1] * s + visualRng.sym(0.5), normal[2] * s + visualRng.sym(0.5)],
        life: 0,
        maxLife: visualRng.range(0.5, 1.2),
        size: visualRng.range(0.04, 0.09),
        color: [0.25, 0.23, 0.21],
        drag: 3,
        gravity: -0.2,
        streak: 0
      });
    }
  }
  glints(pos, count, tint, speed = 3) {
    for (let i = 0; i < count; i++) {
      const s = visualRng.range(0.5, speed);
      const dir = randomUnit(this.tmpA);
      this.emit({
        pos: [pos[0], pos[1], pos[2]],
        vel: [dir[0] * s, dir[1] * s + 0.8, dir[2] * s],
        life: 0,
        maxLife: visualRng.range(0.3, 0.9),
        size: visualRng.range(8e-3, 0.02),
        color: [tint[0] * 5, tint[1] * 5, tint[2] * 5],
        drag: 1.5,
        gravity: 5,
        streak: 0.02
      });
    }
  }
  muzzleFlash(pos, dir, big) {
    const n = big ? 10 : 6;
    for (let i = 0; i < n; i++) {
      const s = visualRng.range(1, big ? 6 : 4);
      this.emit({
        pos: [pos[0], pos[1], pos[2]],
        vel: [dir[0] * s + visualRng.sym(1), dir[1] * s + visualRng.sym(1), dir[2] * s + visualRng.sym(1)],
        life: 0,
        maxLife: visualRng.range(0.04, 0.09),
        size: visualRng.range(0.02, big ? 0.06 : 0.04),
        color: [9, 5.5, 2.2],
        drag: 8,
        gravity: 0,
        streak: 0.02
      });
    }
    this.emit({ pos: [pos[0], pos[1], pos[2]], vel: [0, 0, 0], life: 0, maxLife: 0.05, size: big ? 0.12 : 0.08, color: [10, 7, 3], drag: 0, gravity: 0, streak: 0 });
  }
  spawnShimmer(pos, tint) {
    for (let i = 0; i < 24; i++) {
      const a = visualRng.next() * Math.PI * 2;
      const r = visualRng.range(0.2, 0.6);
      this.emit({
        pos: [pos[0] + Math.cos(a) * r, pos[1] + visualRng.range(0, 1.8), pos[2] + Math.sin(a) * r],
        vel: [0, visualRng.range(0.3, 1.2), 0],
        life: 0,
        maxLife: visualRng.range(0.4, 0.9),
        size: visualRng.range(0.01, 0.025),
        color: [tint[0] * 4, tint[1] * 4, tint[2] * 4],
        drag: 0.5,
        gravity: -0.5,
        streak: 0.05
      });
    }
  }
  shatter(pose, dir, point, tint, meshCount) {
    const local = this.tmpB;
    for (const id of PART_IDS) {
      const m2 = pose.parts[id];
      const ext = PART_EXTENTS[id];
      const c = PART_CENTER[id];
      const n = id === "torso" ? 9 : id === "head" || id === "pelvis" ? 5 : 3;
      for (let i = 0; i < n; i++) {
        local[0] = c[0] + visualRng.sym(ext[0]);
        local[1] = c[1] + visualRng.sym(ext[1]);
        local[2] = c[2] + visualRng.sym(ext[2]);
        const wx = m2[0] * local[0] + m2[4] * local[1] + m2[8] * local[2] + m2[12];
        const wy = m2[1] * local[0] + m2[5] * local[1] + m2[9] * local[2] + m2[13];
        const wz = m2[2] * local[0] + m2[6] * local[1] + m2[10] * local[2] + m2[14];
        const near = Math.max(0, 1 - Math.hypot(wx - point[0], wy - point[1], wz - point[2]) / 1.2);
        const s = visualRng.range(1.5, 3.5) + near * 4;
        const out = randomUnit(this.tmpA);
        if (this.shards.length >= MAX_SHARDS)
          this.shards.shift();
        this.shards.push({
          pos: [wx, wy, wz],
          vel: [dir[0] * s + out[0] * 1.8, dir[1] * s + out[1] * 1.8 + 1.5, dir[2] * s + out[2] * 1.8],
          rot: [visualRng.next() * 6.28, visualRng.next() * 6.28, visualRng.next() * 6.28],
          angVel: [visualRng.sym(14), visualRng.sym(14), visualRng.sym(14)],
          scale: visualRng.range(0.7, 1.5) * (id === "torso" ? 1.3 : 1),
          life: 0,
          mesh: Math.floor(visualRng.next() * meshCount),
          tint,
          sleeping: false
        });
      }
    }
    this.glints(point, 30, tint, 5);
  }
  smallShatter(pos, tint, meshCount) {
    for (let i = 0; i < 8; i++) {
      const out = randomUnit(this.tmpA);
      if (this.shards.length >= MAX_SHARDS)
        this.shards.shift();
      this.shards.push({
        pos: [pos[0], pos[1], pos[2]],
        vel: [out[0] * 2.5, Math.abs(out[1]) * 2 + 1, out[2] * 2.5],
        rot: [visualRng.next() * 6.28, visualRng.next() * 6.28, visualRng.next() * 6.28],
        angVel: [visualRng.sym(14), visualRng.sym(14), visualRng.sym(14)],
        scale: visualRng.range(0.3, 0.6),
        life: 0,
        mesh: Math.floor(visualRng.next() * meshCount),
        tint,
        sleeping: false
      });
    }
    this.glints(pos, 12, [1, 1, 1], 3);
  }
  update(dt, world) {
    if (dt <= 0)
      return;
    for (const p of this.particles) {
      p.life += dt;
      if (p.life >= p.maxLife) {
        p.alive = false;
        continue;
      }
      const d = Math.max(0, 1 - p.drag * dt);
      p.vel[0] *= d;
      p.vel[1] = p.vel[1] * d - p.gravity * dt;
      p.vel[2] *= d;
      p.pos[0] += p.vel[0] * dt;
      p.pos[1] += p.vel[1] * dt;
      p.pos[2] += p.vel[2] * dt;
    }
    compact(this.particles);
    const sub = dt > 1 / 60 ? Math.ceil(dt / (1 / 60)) : 1;
    const h = dt / sub;
    for (const s of this.shards) {
      s.life += dt;
      if (s.sleeping)
        continue;
      for (let k = 0; k < sub; k++) {
        s.vel[1] -= 12 * h;
        s.pos[0] += s.vel[0] * h;
        s.pos[1] += s.vel[1] * h;
        s.pos[2] += s.vel[2] * h;
        if (world) {
          const res = world.resolveSphere(s.pos, s.vel, 0.035 * s.scale, 0.35, 0.25);
          if (res.impact > 0.2) {
            s.angVel[0] *= 0.6;
            s.angVel[1] *= 0.6;
            s.angVel[2] *= 0.6;
          }
          if (res.grounded && Math.hypot(s.vel[0], s.vel[1], s.vel[2]) < 0.15)
            s.sleeping = true;
        }
      }
      s.rot[0] += s.angVel[0] * dt;
      s.rot[1] += s.angVel[1] * dt;
      s.rot[2] += s.angVel[2] * dt;
      if (s.pos[1] < -20)
        s.life = SHARD_LIFE;
    }
    let w = 0;
    for (let i = 0; i < this.shards.length; i++) {
      const s = this.shards[i];
      if (s.life < SHARD_LIFE)
        this.shards[w++] = s;
    }
    this.shards.length = w;
  }
  draw(renderer, meshes) {
    for (const p of this.particles) {
      const fade = 1 - p.life / p.maxLife;
      const c = [p.color[0] * fade, p.color[1] * fade, p.color[2] * fade];
      if (p.streak > 0) {
        const tail = [p.pos[0] - p.vel[0] * p.streak, p.pos[1] - p.vel[1] * p.streak, p.pos[2] - p.vel[2] * p.streak];
        renderer.drawSegment(tail, p.pos, p.size, c, 0.2, 1.5);
      } else {
        renderer.drawSegment(p.pos, p.pos, p.size, c, 1, 2.5);
      }
    }
    const m2 = this.model;
    for (const s of this.shards) {
      const fadeStart = SHARD_LIFE - 1.5;
      const fade = s.life > fadeStart ? Math.max(0, 1 - (s.life - fadeStart) / 1.5) : 1;
      mat4.translation(s.pos, m2);
      mat4.rotateY(m2, s.rot[1], m2);
      mat4.rotateX(m2, s.rot[0], m2);
      mat4.rotateZ(m2, s.rot[2], m2);
      mat4.uniformScale(m2, s.scale * (0.4 + 0.6 * fade), m2);
      const mesh = meshes.shards[s.mesh] ?? meshes.shards[0];
      renderer.drawMesh(mesh, m2, s.tint, 0.6, "glass", 0, fade);
    }
  }
};
function randomUnit(out) {
  for (; ; ) {
    const x = visualRng.sym(1), y = visualRng.sym(1), z = visualRng.sym(1);
    const l = x * x + y * y + z * z;
    if (l > 1e-4 && l <= 1) {
      const il = 1 / Math.sqrt(l);
      out[0] = x * il;
      out[1] = y * il;
      out[2] = z * il;
      return out;
    }
  }
}
function compact(list) {
  let w = 0;
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (p.alive)
      list[w++] = p;
  }
  list.length = w;
}

var GLOVE2 = [1, 1, 1];
var Viewmodel = class {
  swayX = 0;
  swayY = 0;
  bobAmount = 0;
  cam = mat4.create();
  m = mat4.create();
  hand = mat4.create();
  update(realDt, mouseDx, mouseDy, planarSpeed, grounded) {
    this.swayX = approach(this.swayX, clamp(-mouseDx * 9e-4, -0.05, 0.05), 0.08, realDt);
    this.swayY = approach(this.swayY, clamp(mouseDy * 9e-4, -0.05, 0.05), 0.08, realDt);
    this.bobAmount = approach(this.bobAmount, grounded ? clamp(planarSpeed / 4, 0, 1) : 0, 0.1, realDt);
  }
  draw(renderer, meshes, eye, yaw, pitch, p, stride, reduceMotion) {
    const cam = this.cam;
    mat4.translation([eye[0], eye[1], eye[2]], cam);
    mat4.rotateY(cam, yaw, cam);
    mat4.rotateX(cam, pitch, cam);
    const bobScale = reduceMotion ? 0.3 : 1;
    const bobX = Math.sin(stride * 2.2) * 0.012 * this.bobAmount * bobScale;
    const bobY = -Math.abs(Math.cos(stride * 2.2)) * 0.012 * this.bobAmount * bobScale;
    const sx = this.swayX * bobScale + bobX;
    const sy = this.swayY * bobScale + bobY;
    const pickup = p.pickupAge < 0.2 ? 1 - p.pickupAge / 0.2 : 0;
    const throwT = p.throwAge < 0.3 ? p.throwAge / 0.3 : -1;
    const held = p.held;
    if (!held) {
      for (const side of [1, -1]) {
        const punching = p.punchSide === side && p.punchAge < 0.24;
        const t = punching ? p.punchAge / 0.24 : 0;
        const ext = punching ? Math.sin(t * Math.PI) : 0;
        const x = 0.2 * side + sx - ext * 0.12 * side;
        let y = -0.2 + sy + ext * 0.07;
        let z = -0.4 - ext * 0.32;
        if (throwT >= 0 && side === 1) {
          const k = Math.sin(throwT * Math.PI);
          z -= k * 0.25;
          y += k * 0.08;
        }
        y -= pickup * 0.15;
        this.drawArm(renderer, meshes, x, y, z, side, ext);
      }
      return;
    }
    const kind = held.kind;
    const recoilScale = kind === "scatter" ? 1.6 : kind === "carbine" ? 0.7 : 1;
    const recoil = Math.exp(-p.recoilAge * 14) * recoilScale;
    const hx = 0.19 + sx;
    let hy = -0.2 + sy - pickup * 0.2;
    let hz = -0.38 + recoil * 0.07;
    if (throwT >= 0) {
      const k = Math.sin(throwT * Math.PI);
      hz -= k * 0.25;
      hy += k * 0.1;
    }
    const hand = this.hand;
    mat4.translate(cam, [hx, hy, hz], hand);
    mat4.rotateX(hand, recoil * 0.22, hand);
    if (kind === "blade") {
      const slash = p.slashAge < 0.25 ? p.slashAge / 0.25 : -1;
      if (slash >= 0) {
        const k = Math.sin(slash * Math.PI);
        mat4.translate(hand, [-k * 0.25, k * 0.05, -k * 0.15], hand);
        mat4.rotateY(hand, 0.9 - slash * 1.8, hand);
        mat4.rotateZ(hand, -k * 0.9, hand);
      } else {
        mat4.rotateY(hand, 0.25, hand);
        mat4.rotateX(hand, 0.55, hand);
      }
    }
    this.drawItem(renderer, meshes, kind, hand);
    this.drawFistAt(renderer, meshes, hand);
    this.drawArmFromHand(renderer, meshes, hand);
    if (kind === "scatter" || kind === "carbine") {
      mat4.translate(hand, [-0.03, -0.04, -0.3], this.m);
      this.drawFistAt(renderer, meshes, this.m);
    }
  }
  drawItem(renderer, meshes, kind, hand) {
    const m2 = this.m;
    switch (kind) {
      case "pistol":
        mat4.translate(hand, [0, 0.045, -0.03], m2);
        break;
      case "scatter":
        mat4.translate(hand, [0, 0.05, -0.12], m2);
        break;
      case "carbine":
        mat4.translate(hand, [0, 0.06, -0.08], m2);
        break;
      case "blade":
        mat4.translate(hand, [0, 0.02, -0.1], m2);
        break;
      default:
        mat4.translate(hand, [0, 0.07, -0.04], m2);
    }
    renderer.drawMesh(meshes.items[kind], m2, [1, 1, 1], 0.08, "viewmodel");
  }
  drawArm(renderer, meshes, x, y, z, side, ext) {
    const m2 = this.hand;
    mat4.translate(this.cam, [x, y, z], m2);
    mat4.rotateY(m2, side * 0.12 - ext * 0.1 * side, m2);
    mat4.rotateX(m2, 0.15 + ext * 0.1, m2);
    this.drawFistAt(renderer, meshes, m2);
    this.drawArmFromHand(renderer, meshes, m2);
  }
  drawFistAt(renderer, meshes, m2) {
    renderer.drawMesh(meshes.fist, m2, GLOVE2, 0, "viewmodel");
  }
  drawArmFromHand(renderer, meshes, hand) {
    const fa = mat4.translate(hand, [0, -0.01, 0.04]);
    mat4.rotateX(fa, Math.PI / 2 - 0.15, fa);
    renderer.drawMesh(meshes.forearm, fa, GLOVE2, 0, "viewmodel");
  }
};

var ReplayRecorder = class {
  frames = [];
  reset() {
    this.frames = [];
  }
  push(f) {
    this.frames.push({ ...f, pos: [...f.pos], vel: [...f.vel] });
  }
  setLastSteps(steps) {
    const last = this.frames[this.frames.length - 1];
    if (last)
      last.steps += steps;
  }
};
var ReplayPlayer = class {
  frames;
  world;
  index = 0;
  simPlayed = 0;
  clock = 0;
  speed = 1;
  constructor(def, frames, shared) {
    this.frames = frames;
    this.world = new World(def, shared);
  }
  get done() {
    return this.index >= this.frames.length;
  }
  get progress() {
    return this.frames.length === 0 ? 1 : this.index / this.frames.length;
  }
  current = null;
  update(realDt) {
    this.clock += realDt * this.speed;
    let steps = 0;
    let applied = 0;
    while (this.index < this.frames.length && (this.simPlayed < this.clock || applied === 0)) {
      const f = this.frames[this.index++];
      this.world.applyPlayerFrame({ ...f, pos: [...f.pos], vel: [...f.vel] });
      for (let i = 0; i < f.steps; i++)
        this.world.step(FIXED_STEP);
      this.simPlayed += f.steps * FIXED_STEP;
      steps += f.steps;
      this.current = f;
      applied++;
      if (applied > 2e3)
        break;
    }
    return steps;
  }
};

function createPose() {
  const parts = {};
  for (const id of PART_IDS)
    parts[id] = mat4.create();
  return { parts, weapon: mat4.create() };
}
var tmp = mat4.create();
function computePose(p, out) {
  const P = out.parts;
  const move = p.moveBlend;
  const ph = p.walkPhase;
  const s = Math.sin(ph);
  const runScale = p.kind === "rusher" ? 1.5 : 1;
  const spawnScale = 0.3 + 0.7 * easeOut(p.spawnT);
  const root = mat4.translation([p.pos[0], p.pos[1], p.pos[2]]);
  mat4.rotateY(root, p.yaw, root);
  mat4.uniformScale(root, spawnScale, root);
  const bob = Math.abs(Math.cos(ph)) * 0.05 * move * runScale;
  const hipY = 0.92 + bob - p.stun * 0.05;
  mat4.translate(root, [0, hipY, 0], P.pelvis);
  mat4.rotateY(P.pelvis, s * 0.12 * move, P.pelvis);
  const lean = -0.1 * move * runScale - (p.attackT > 0 ? Math.sin(p.attackT * Math.PI) * 0.35 : 0) + p.stun * (0.25 + Math.sin(ph * 3) * 0.1);
  mat4.translate(P.pelvis, [0, 0.08, 0], P.torso);
  mat4.rotateX(P.torso, lean, P.torso);
  mat4.rotateY(P.torso, -s * 0.1 * move, P.torso);
  mat4.translate(P.torso, [0, 0.56, 0], P.head);
  mat4.rotateX(P.head, p.aimPitch * 0.5 - lean * 0.5, P.head);
  const swing = s * 0.5 * move * runScale;
  const aimAngle = Math.PI / 2 + p.aimPitch;
  const strike = p.attackT > 0 ? Math.sin(Math.min(1, p.attackT * 1.3) * Math.PI) : 0;
  let rUpper = lerp2(-swing, aimAngle, p.aimBlend);
  let rElbow = lerp2(0.35 + Math.max(0, swing) * 0.4, 0.05, p.aimBlend);
  if (p.attackT > 0) {
    rUpper = lerp2(rUpper, Math.PI / 2 + 0.2, strike);
    rElbow = lerp2(rElbow, 0, strike);
  }
  mat4.translate(P.torso, [0.25, 0.5, 0], P.upperArmR);
  mat4.rotateX(P.upperArmR, rUpper - p.stun * 0.6, P.upperArmR);
  mat4.rotateZ(P.upperArmR, 0.12 - p.aimBlend * 0.1, P.upperArmR);
  mat4.translate(P.upperArmR, [0, -0.3, 0], P.lowerArmR);
  mat4.rotateX(P.lowerArmR, rElbow, P.lowerArmR);
  const support = p.twoHanded ? p.aimBlend : 0;
  const lUpper = lerp2(swing, aimAngle - 0.25, support);
  const lElbow = lerp2(0.35 + Math.max(0, -swing) * 0.4, 0.5, support);
  mat4.translate(P.torso, [-0.25, 0.5, 0], P.upperArmL);
  mat4.rotateX(P.upperArmL, lUpper - p.stun * 0.6, P.upperArmL);
  mat4.rotateZ(P.upperArmL, -0.12 + support * 0, P.upperArmL);
  mat4.rotateY(P.upperArmL, -support * 0.5, P.upperArmL);
  mat4.translate(P.upperArmL, [0, -0.3, 0], P.lowerArmL);
  mat4.rotateX(P.lowerArmL, lElbow, P.lowerArmL);
  const legSwing = s * 0.55 * move * runScale;
  const kneeR = 0.08 + Math.max(0, -Math.sin(ph - 0.6)) * 0.9 * move;
  const kneeL = 0.08 + Math.max(0, Math.sin(ph - 0.6)) * 0.9 * move;
  mat4.translate(P.pelvis, [0.1, -0.05, 0], P.upperLegR);
  mat4.rotateX(P.upperLegR, legSwing + p.stun * 0.15, P.upperLegR);
  mat4.translate(P.upperLegR, [0, -0.42, 0], P.lowerLegR);
  mat4.rotateX(P.lowerLegR, -kneeR, P.lowerLegR);
  mat4.translate(P.pelvis, [-0.1, -0.05, 0], P.upperLegL);
  mat4.rotateX(P.upperLegL, -legSwing + p.stun * 0.15, P.upperLegL);
  mat4.translate(P.upperLegL, [0, -0.42, 0], P.lowerLegL);
  mat4.rotateX(P.lowerLegL, -kneeL, P.lowerLegL);
  mat4.translate(P.lowerArmR, [0, -0.3, 0], tmp);
  mat4.rotateX(tmp, -Math.PI / 2, out.weapon);
  return out;
}
function lerp2(a, b, t) {
  return a + (b - a) * t;
}
function easeOut(t) {
  const c = Math.min(1, Math.max(0, t));
  return 1 - (1 - c) * (1 - c);
}

var BASE_SENSITIVITY = 22e-4;
var ENEMY_TINT = {
  walker: [0.8, 0.32, 1],
  rusher: [1, 0.26, 0.48],
  marksman: [0.42, 0.48, 1]
};
var ENEMY_EMISSIVE = { walker: 0.9, rusher: 1.1, marksman: 1 };
var SHOT_SFX = { pistol: "pistol", scatter: "scatter", carbine: "carbine", blade: "whoosh" };
var Game = class {
  gfx;
  renderer;
  input;
  audio = new AudioEngine();
  ui;
  overlay;
  loop;
  meshes;
  save;
  camera = new Camera();
  vmCamera = new Camera();
  player = new PlayerController();
  driver = new TimeScaleDriver();
  recorder = new ReplayRecorder();
  fx = new FxSystem();
  viewmodel = new Viewmodel();
  pose = createPose();
  model = mat4.create();
  post = defaultPostParams();
  state = "title";
  stateTime = 0;
  levelIndex = 0;
  def = LEVELS[0];
  scene = null;
  shared = null;
  sceneCache = new Map();
  world;
  replay = null;
  runRealTime = 0;
  flash = [1, 1, 1, 0];
  threat = 0;
  deathDir = [0, 0, -1];
  telegraphing = new Set();
  lastResults = null;
  debugOverlayForced = false;
  perfAccum = 0;
  perfFrames = 0;
  autoScale = 1;
  constructor(gfx, canvas, overlayEl) {
    this.gfx = gfx;
    this.renderer = new Renderer(gfx);
    this.input = new Input(canvas);
    this.overlay = new DebugOverlay(overlayEl);
    this.meshes = buildMeshLibrary(gfx.device);
    this.save = loadSave();
    this.ui = new Ui({
      onPlayLevel: (i) => this.startLevel(i, true),
      onResume: () => this.resume(),
      onRestart: () => this.restart(true),
      onMenu: () => this.toMenu(),
      onNext: () => this.startLevel(Math.min(LEVELS.length - 1, this.levelIndex + 1), true),
      onReplay: () => this.startReplay(),
      onSkipReplay: () => this.endReplay(),
      onSettingsChanged: (s) => this.applySettings(s),
      onUiSound: () => {
        this.audio.unlock();
        this.audio.play("ui", { ignoreTime: true });
      }
    }, this.save, LEVELS);
    this.applySettings(this.save.settings);
    const applyAspect = () => {
      this.camera.aspect = gfx.aspect;
      this.camera.setHorizontalFov(this.save.settings.fov);
      this.vmCamera.aspect = gfx.aspect;
      this.vmCamera.fovYDeg = 54;
    };
    applyAspect();
    gfx.onResize(applyAspect);
    this.vmCamera.near = this.camera.near;
    this.vmCamera.far = this.camera.far;
    document.addEventListener("pointerlockchange", () => {
      if (!this.input.pointerLocked && (this.state === "playing" || this.state === "intro"))
        this.pause();
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden && (this.state === "playing" || this.state === "intro"))
        this.pause();
    });
    window.addEventListener("pointerdown", () => this.audio.unlock(), { capture: true });
    window.addEventListener("keydown", () => this.audio.unlock(), { capture: true });
    this.loadLevel(this.firstUncleared());
    this.toMenu();
    this.loop = new Loop({
      frame: (t) => this.frame(t),
      fixedStep: () => this.fixedStep(),
      render: (t) => this.render(t)
    });
  }
  start() {
    this.loop.start();
  }
  stop() {
    this.loop.stop();
  }
  firstUncleared() {
    const i = LEVELS.findIndex((l) => !this.save.levels[l.id]?.cleared);
    return i < 0 ? 0 : i;
  }
  loadLevel(index) {
    this.levelIndex = clamp(index, 0, LEVELS.length - 1);
    this.def = LEVELS[this.levelIndex];
    let cached = this.sceneCache.get(this.def.id);
    if (!cached) {
      const t0 = performance.now();
      const { scene, shared } = buildLevelMesh(this.gfx.device, this.def);
      cached = { scene, shared };
      this.sceneCache.set(this.def.id, cached);
      console.info(`[game] built level ${this.def.id} in ${(performance.now() - t0).toFixed(1)} ms (${this.def.boxes.length} boxes)`);
    }
    this.scene = cached.scene;
    this.shared = cached.shared;
    const theme = THEMES[this.def.theme];
    this.renderer.lighting = theme.lighting;
    this.renderer.setShadowBounds(this.scene.min, this.scene.max);
    this.resetWorld();
  }
  resetWorld() {
    this.world = new World(this.def, this.shared ?? void 0);
    this.shared = this.world.staticData;
    this.player.reset(this.def.player.pos, this.def.player.yaw);
    this.driver.reset();
    this.recorder.reset();
    this.fx.clear();
    this.telegraphing.clear();
    this.runRealTime = 0;
    this.flash = [1, 1, 1, 0];
    this.replay = null;
  }
  setState(s) {
    this.state = s;
    this.stateTime = 0;
  }
  startLevel(index, lock) {
    if (!this.ui.isUnlocked(index))
      return;
    this.audio.unlock();
    if (lock)
      this.input.requestPointerLock();
    this.loadLevel(index);
    this.ui.hideScreen();
    this.beginIntro(this.def.words, 0.34);
  }
  beginIntro(words, wordTime) {
    this.setState("intro");
    this.ui.titleCard(words, wordTime, () => {
      if (this.state === "intro")
        this.beginPlaying();
    });
  }
  beginPlaying() {
    this.setState("playing");
    this.loop.time.clearAccumulator();
    this.recorder.reset();
    this.runRealTime = 0;
  }
  restart(lock) {
    if (lock)
      this.input.requestPointerLock();
    this.ui.hideScreen();
    this.resetWorld();
    this.beginIntro([this.def.name], 0.45);
  }
  pause() {
    if (this.state !== "playing" && this.state !== "intro")
      return;
    this.ui.hideCard();
    this.setState("paused");
    this.ui.showPause();
  }
  resume() {
    this.input.requestPointerLock();
    this.ui.hideScreen();
    this.state = this.recorder.frames.length > 0 ? "playing" : "intro";
    this.stateTime = 0;
    if (this.state === "intro")
      this.beginIntro(["GO."], 0.3);
    this.loop.time.clearAccumulator();
  }
  toMenu() {
    this.ui.hideCard();
    this.replay = null;
    if (document.pointerLockElement)
      document.exitPointerLock();
    this.loadLevel(this.firstUncleared());
    this.setState("title");
    this.ui.showTitle();
  }
  enterDead() {
    this.setState("dead");
    this.flash = [1, 0.25, 0.3, 0.85];
    this.audio.play("death", { ignoreTime: true });
    this.ui.titleCard(["AGAIN."], 0.6);
  }
  enterCleared() {
    this.setState("cleared");
    this.lastResults = { real: this.runRealTime, sim: this.world.simTime, kills: this.world.stats.kills, shots: this.world.stats.shots };
    this.flash = [1, 1, 1, 0.5];
    this.audio.play("clear", { ignoreTime: true });
    this.ui.titleCard(["CLEAR.", "CLEAR.", "CLEAR."], 0.38, () => this.showResults());
  }
  showResults() {
    if (document.pointerLockElement)
      document.exitPointerLock();
    const r = this.lastResults ?? { real: 0, sim: 0, kills: 0, shots: 0 };
    const rec = this.save.levels[this.def.id] ?? { cleared: false };
    const newBest = rec.best === void 0 || r.real < rec.best;
    rec.cleared = true;
    if (newBest) {
      rec.best = r.real;
      rec.bestSim = r.sim;
    }
    this.save.levels[this.def.id] = rec;
    writeSave(this.save);
    this.setState("results");
    this.ui.showResults({
      level: this.def,
      realTime: r.real,
      simTime: r.sim,
      kills: r.kills,
      shots: r.shots,
      best: rec.best,
      newBest,
      hasNext: this.levelIndex < LEVELS.length - 1
    });
  }
  startReplay() {
    if (!this.shared || this.recorder.frames.length === 0)
      return;
    this.fx.clear();
    this.telegraphing.clear();
    this.replay = new ReplayPlayer(this.def, this.recorder.frames, this.shared);
    this.setState("replay");
    this.ui.showReplayBar();
  }
  endReplay() {
    if (this.state !== "replay")
      return;
    this.replay = null;
    this.fx.clear();
    this.showResults();
  }
  applySettings(s) {
    this.save.settings = s;
    this.ui.setSave(this.save);
    writeSave(this.save);
    this.camera.aspect = this.gfx.aspect;
    this.camera.setHorizontalFov(s.fov);
    this.renderer.quality = s.postQuality;
    this.audio.setVolumes(s.masterVolume, s.sfxVolume, s.musicVolume);
    this.autoScale = 1;
    this.gfx.setResolutionScale(s.resolutionScale);
  }
  frame(t) {
    const dt = t.realDt;
    const input = this.input;
    input.update(dt);
    this.stateTime += dt;
    this.ui.update(dt);
    if (input.wasPressed("debugTimeFreeze"))
      t.lock = t.lock === "frozen" ? "none" : "frozen";
    if (input.wasPressed("debugTimeRealtime"))
      t.lock = t.lock === "realtime" ? "none" : "realtime";
    if (input.wasPressed("debugOverlay"))
      this.debugOverlayForced = !this.debugOverlayForced;
    const look = { sensitivity: BASE_SENSITIVITY * this.save.settings.sensitivity, invertY: this.save.settings.invertY };
    const locked = input.pointerLocked;
    this.ui.showLockHint((this.state === "playing" || this.state === "intro") && !locked);
    switch (this.state) {
      case "title":
        t.timeScale = 0;
        break;
      case "intro":
        if (locked)
          this.player.look(input, dt, look);
        t.timeScale = 0;
        break;
      case "playing": {
        if (!locked) {
          t.timeScale = 0;
          break;
        }
        if (input.wasPressed("restart")) {
          this.restart(false);
          t.timeScale = 0;
          break;
        }
        this.player.update(input, dt, this.world, look, true);
        const f = this.player.toFrame(input.wasPressed("fire"), input.wasPressed("throw"), input.wasPressed("interact"));
        const acted = this.world.applyPlayerFrame(f);
        this.recorder.push(f);
        if (acted)
          this.driver.actionKick();
        const busy = this.world.player.burstLeft > 0;
        t.timeScale = this.driver.update(dt, this.player.planarSpeed, WALK_SPEED, this.player.lookSpeed, !this.player.grounded, busy);
        this.runRealTime += dt;
        break;
      }
      case "dead":
        t.timeScale = approach(t.timeScale, 0.04, 0.2, dt);
        if (this.stateTime > 0.35 && (input.wasPressed("restart") || input.wasPressed("fire")))
          this.restart(false);
        else if (this.stateTime > 1.4)
          this.restart(false);
        break;
      case "cleared":
        if (locked)
          this.player.look(input, dt, look);
        t.timeScale = approach(t.timeScale, 0.25, 0.3, dt);
        break;
      case "paused":
      case "results":
        t.timeScale = 0;
        break;
      case "replay":
        t.timeScale = 0;
        if (this.stateTime > 0.3 && input.anyPressed()) {
          this.endReplay();
          break;
        }
        if (this.replay) {
          this.replay.update(dt);
          this.ui.setReplayProgress(this.replay.progress);
          if (this.replay.done && this.stateTime > 0.5)
            this.endReplay();
        }
        break;
    }
  }
  fixedStep() {
    if (this.state === "playing" || this.state === "dead" || this.state === "cleared") {
      this.world.step(FIXED_STEP);
    }
  }
  render(t) {
    if (this.state === "playing")
      this.recorder.setLastSteps(t.stepsThisFrame);
    if (this.state === "playing" && this.world.failed)
      this.enterDead();
    else if (this.state === "playing" && this.world.cleared)
      this.enterCleared();
    const world = this.replay?.world ?? this.world;
    const inReplay = this.state === "replay" && !!this.replay;
    const ts = inReplay ? 1 : t.effectiveScale();
    const visualDt = inReplay ? t.realDt : t.simDt;
    this.handleEvents(world);
    this.fx.update(visualDt, world.static);
    this.updateAutoResolution(t.realDt);
    const eye = v3();
    let yaw;
    let pitch;
    if (inReplay && this.replay?.current) {
      const f = this.replay.current;
      eye[0] = f.pos[0];
      eye[1] = f.pos[1] + EYE_HEIGHT;
      eye[2] = f.pos[2];
      yaw = f.yaw;
      pitch = f.pitch;
    } else if (inReplay) {
      eye[0] = this.def.player.pos[0];
      eye[1] = this.def.player.pos[1] + EYE_HEIGHT;
      eye[2] = this.def.player.pos[2];
      yaw = this.def.player.yaw;
      pitch = 0;
    } else if (this.state === "title" || this.state === "results" && !this.lastResults) {
      const sc = this.scene;
      const cx = (sc.min[0] + sc.max[0]) / 2;
      const cz = (sc.min[2] + sc.max[2]) / 2;
      const r = Math.max(4, Math.min(sc.max[0] - sc.min[0], sc.max[2] - sc.min[2]) * 0.32);
      const a = t.realTime * 0.06;
      eye[0] = cx + Math.cos(a) * r;
      eye[1] = 2.4;
      eye[2] = cz + Math.sin(a) * r;
      yaw = Math.atan2(-(cx - eye[0]), -(cz - eye[2]));
      pitch = -0.12;
    } else {
      eye[0] = this.player.pos[0];
      eye[1] = this.player.pos[1] + EYE_HEIGHT;
      eye[2] = this.player.pos[2];
      yaw = this.player.yaw;
      pitch = this.player.pitch;
      if (this.state === "dead") {
        const k = Math.min(1, this.stateTime / 0.6);
        eye[1] -= k * 0.5;
        pitch = lerpN(pitch, -0.4, k * 0.5);
      }
    }
    const cam = this.camera;
    cam.position[0] = eye[0];
    cam.position[1] = eye[1];
    cam.position[2] = eye[2];
    cam.yaw = yaw;
    cam.pitch = pitch;
    cam.update();
    const vm = this.vmCamera;
    vm.position[0] = eye[0];
    vm.position[1] = eye[1];
    vm.position[2] = eye[2];
    vm.yaw = yaw;
    vm.pitch = pitch;
    vm.update();
    this.audio.setListener({ x: eye[0], y: eye[1], z: eye[2], yaw });
    this.audio.setTimeScale(this.state === "title" || this.state === "results" || this.state === "paused" ? 0.35 : ts);
    const alpha = inReplay ? 1 : t.alpha;
    this.drawWorld(world, alpha, ts, t.realTime);
    this.fx.draw(this.renderer, this.meshes);
    const showViewmodel = this.state === "playing" || this.state === "intro" || this.state === "cleared" || this.state === "paused" || inReplay;
    if (showViewmodel) {
      const pState = world.player;
      if (!inReplay)
        this.viewmodel.update(t.realDt, this.player.mouseDx, this.player.mouseDy, this.player.planarSpeed, this.player.grounded);
      const stride = inReplay ? this.replay?.current ? Math.hypot(this.replay.current.pos[0], this.replay.current.pos[2]) : 0 : this.player.stride;
      this.viewmodel.draw(this.renderer, this.meshes, eye, yaw, pitch, pState, stride, this.save.settings.reduceMotion);
    }
    this.updatePost(world, ts, t.realDt);
    this.renderer.render(cam, vm, this.post, t.realTime);
    this.updateHud(world, ts);
    const showFps = this.save.settings.showFps || this.debugOverlayForced;
    this.overlay.visible = showFps;
    if (showFps) {
      this.overlay.set("res", `${this.gfx.width}x${this.gfx.height} (${(this.gfx.getResolutionScale() * 100).toFixed(0)}%)`);
      this.overlay.set("draws", `${this.renderer.lastDrawCalls} calls, ${this.renderer.lastInstances} inst, ${this.renderer.lastSegments} fx`);
      this.overlay.set("world", `enemies ${world.enemies.length}  bullets ${world.projectiles.length}  props ${world.props.length}  shards ${this.fx.shardCount}`);
      this.overlay.set("state", this.state);
    }
    this.overlay.update(t);
  }
  drawWorld(world, alpha, ts, realTime) {
    const r = this.renderer;
    if (this.scene)
      r.drawMesh(this.scene.mesh, IDENTITY);
    const m2 = this.model;
    const tmp2 = v3();
    for (const pr of world.props) {
      lerp(tmp2, pr.prevPos, pr.pos, alpha);
      mat4.translation(tmp2, m2);
      mat4.rotateY(m2, lerpN(pr.prevRot[1], pr.rot[1], alpha), m2);
      mat4.rotateX(m2, lerpN(pr.prevRot[0], pr.rot[0], alpha), m2);
      mat4.rotateZ(m2, lerpN(pr.prevRot[2], pr.rot[2], alpha), m2);
      const highlight = world.aimProp === pr && this.state === "playing" ? 0.45 + 0.25 * Math.sin(realTime * 8) : 0;
      r.drawMesh(this.meshes.items[pr.item.kind], m2, WHITE3, 0.06, "opaque", 0, 1, highlight);
    }
    for (const e of world.enemies)
      this.drawEnemy(e, alpha);
    const trailLen = 0.6 + 5 * (1 - ts);
    const head = v3();
    const tail = v3();
    for (const b of world.projectiles) {
      lerp(head, b.prevPos, b.pos, alpha);
      const vx = b.vel[0], vy = b.vel[1], vz = b.vel[2];
      const vl = Math.hypot(vx, vy, vz) || 1;
      const traveled = Math.hypot(head[0] - b.spawnPos[0], head[1] - b.spawnPos[1], head[2] - b.spawnPos[2]);
      const l = Math.min(trailLen, traveled);
      tail[0] = head[0] - vx / vl * l;
      tail[1] = head[1] - vy / vl * l;
      tail[2] = head[2] - vz / vl * l;
      const enemyShot = b.ownerId !== 0;
      r.drawSegment(tail, head, 0.016, enemyShot ? TRAIL_ENEMY : TRAIL_PLAYER, 0, 1.2);
      r.drawSegment(head, head, 0.035, CORE, 1, 2);
    }
    const lasers = world.activeLasers();
    for (const l of lasers) {
      const hit = world.static.raycast(l.origin, l.dir, 60);
      const d = hit ? hit.t : 60;
      const end = [l.origin[0] + l.dir[0] * d, l.origin[1] + l.dir[1] * d, l.origin[2] + l.dir[2] * d];
      const k = l.progress;
      r.drawSegment(l.origin, end, 4e-3 + k * 8e-3, [0.9 * (1 + k * 6), 0.25 * (1 + k * 3), 1.6 * (1 + k * 6)], 1, 1.2);
    }
  }
  drawEnemy(e, alpha) {
    const p = this.pose;
    const pos = lerp(v3(), e.prevPos, e.pos, alpha);
    computePose({
      pos,
      yaw: lerpAngle(e.prevYaw, e.yaw, alpha),
      walkPhase: lerpN(e.prevWalkPhase, e.walkPhase, alpha),
      moveBlend: lerpN(e.prevMoveBlend, e.moveBlend, alpha),
      aimBlend: lerpN(e.prevAimBlend, e.aimBlend, alpha),
      aimPitch: e.aimPitch,
      attackT: e.meleeT > 0 ? lerpN(e.prevMeleeT, e.meleeT, alpha) : 0,
      stun: e.state === "stunned" ? 1 : 0,
      spawnT: lerpN(e.prevSpawnT, e.spawnT, alpha),
      twoHanded: enemyIsTwoHanded(e),
      kind: e.kind
    }, p);
    const tint = ENEMY_TINT[e.kind];
    const spawnT = lerpN(e.prevSpawnT, e.spawnT, alpha);
    const emissive = ENEMY_EMISSIVE[e.kind] + (1 - spawnT) * 3;
    const flash = Math.max(e.hitFlash, (1 - spawnT) * 0.5);
    for (const id of PART_IDS) {
      this.renderer.drawMesh(this.meshes.parts[id], p.parts[id], tint, emissive, "glass", flash, 0.25 + 0.75 * spawnT);
    }
    if (e.weapon)
      this.renderer.drawMesh(this.meshes.items[e.weapon.kind], p.weapon, WHITE3, 0.04, "opaque");
  }
  incomingThreat(world) {
    if (this.state !== "playing")
      return 0;
    const eye = world.playerEye(v3());
    let threat = 0;
    for (const b of world.projectiles) {
      if (!b.alive || b.ownerId === 0)
        continue;
      const d = Math.hypot(b.pos[0] - eye[0], b.pos[1] - eye[1], b.pos[2] - eye[2]);
      threat = Math.max(threat, clamp(2 - d / 8, 0, 1));
    }
    for (const e of world.enemies) {
      if (e.alive && e.telegraph > 0)
        threat = 1;
    }
    return threat;
  }
  updatePost(world, ts, realDt) {
    const s = this.save.settings;
    const p = this.post;
    const reduce = s.reduceMotion;
    let freeze = 1 - ts;
    if (this.state === "title" || this.state === "results" || this.state === "paused")
      freeze = 0.6;
    if (this.state === "replay")
      freeze = 0;
    p.freeze = freeze;
    p.desaturation = this.state === "replay" ? 0.25 : freeze * 0.7;
    p.aberration = reduce ? 0 : freeze * 0.6 + this.flash[3] * 0.8;
    p.grain = reduce ? 0 : this.state === "replay" ? 0.07 : 0.025 + freeze * 0.03;
    p.vignette = this.state === "replay" ? 0.6 : 0.3 + freeze * 0.25;
    p.bloomStrength = s.postQuality === "high" ? 0.7 : 0.5;
    p.bloomThreshold = 1;
    p.exposure = 1;
    p.outline = 1;
    this.flash[3] = approach(this.flash[3], 0, this.state === "dead" ? 0.6 : 0.25, realDt);
    if (this.state === "dead") {
      p.desaturation = Math.max(p.desaturation, 0.85);
    }
    p.flash = this.flash;
    const incoming = this.incomingThreat(world);
    this.threat = approach(this.threat, incoming, incoming > this.threat ? 0.05 : 2.5, realDt);
    p.threat = reduce ? 0 : this.threat;
  }
  updateHud(world, ts) {
    const visible = this.state === "playing" || this.state === "intro" || this.state === "cleared";
    const held = world.player.held;
    let hint = null;
    if (this.state === "playing" && world.aimProp)
      hint = `E  ${ITEM_NAMES[world.aimProp.item.kind]}`;
    else if (this.state === "playing" && held && isGun(held.kind) && held.ammo === 0)
      hint = "EMPTY — CLICK TO THROW";
    const exit = this.def.exit;
    const hud = {
      visible,
      timeScale: ts,
      itemName: held ? ITEM_NAMES[held.kind] : null,
      ammo: held && isGun(held.kind) ? held.ammo : 0,
      maxAmmo: held && isGun(held.kind) ? WEAPONS[held.kind].ammo : 0,
      hint,
      levelName: `${this.def.id}  ${this.def.name}${exit ? "  ·  REACH THE EXIT" : ""}`,
      remaining: exit ? 0 : world.remainingEnemies,
      crosshairScale: this.save.settings.crosshairScale
    };
    this.ui.updateHud(hud);
  }
  handleEvents(world) {
    const a = this.audio;
    const fx = this.fx;
    for (const ev of world.events)
      this.handleEvent(ev, a, fx);
    world.events.length = 0;
    const now = new Set();
    for (const e of world.enemies) {
      if (e.telegraph > 0) {
        now.add(e.id);
        if (!this.telegraphing.has(e.id))
          a.play("charge", { pos: e.pos });
      }
    }
    this.telegraphing = now;
  }
  handleEvent(ev, a, fx) {
    switch (ev.type) {
      case "shot":
        a.play(ev.byPlayer ? SHOT_SFX[ev.weapon] : "enemyShot", { pos: ev.byPlayer ? void 0 : ev.pos, volume: ev.byPlayer ? 0.8 : 1 });
        fx.muzzleFlash(ev.pos, ev.dir, ev.weapon === "scatter");
        break;
      case "impact":
        a.play("impact", { pos: ev.pos, volume: 0.6 });
        fx.sparks(ev.pos, ev.normal, 8);
        fx.dust(ev.pos, ev.normal, 3);
        break;
      case "enemyDeath": {
        if (ev.silent)
          break;
        const e = ev.enemy;
        computePose({
          pos: e.pos,
          yaw: e.yaw,
          walkPhase: e.walkPhase,
          moveBlend: e.moveBlend,
          aimBlend: e.aimBlend,
          aimPitch: e.aimPitch,
          attackT: e.meleeT,
          stun: e.state === "stunned" ? 1 : 0,
          spawnT: e.spawnT,
          twoHanded: enemyIsTwoHanded(e),
          kind: e.kind
        }, this.pose);
        fx.shatter(this.pose, ev.dir, ev.point, ENEMY_TINT[e.kind], this.meshes.shards.length);
        a.play("shatter", { pos: ev.point });
        break;
      }
      case "enemyHit":
        a.play("punch", { pos: ev.pos });
        fx.glints(ev.pos, 10, [0.9, 0.6, 1], 2);
        break;
      case "playerDeath":
        this.deathDir = ev.dir;
        break;
      case "bulletClash":
        a.play("clash", { pos: ev.pos });
        fx.sparks(ev.pos, [0, 1, 0], 16, [6, 6, 7]);
        break;
      case "slice":
        a.play("slice", { pos: ev.pos });
        fx.sparks(ev.pos, [0, 1, 0], 10, [7, 6, 5]);
        break;
      case "punch":
        a.play(ev.hit ? "punch" : "punchMiss", { volume: ev.hit ? 1 : 0.5 });
        break;
      case "slash":
        a.play("whoosh");
        if (ev.hit)
          a.play("slice", { volume: 0.6 });
        break;
      case "throw":
        a.play("whoosh", { volume: 0.7 });
        break;
      case "pickup":
        a.play("pickup");
        break;
      case "dryFire":
        a.play("dryFire");
        break;
      case "itemBreak":
        a.play("glassBreak", { pos: ev.pos });
        fx.smallShatter(ev.pos, [0.9, 0.95, 1], this.meshes.shards.length);
        break;
      case "propImpact":
        a.play("propImpact", { pos: ev.pos, volume: clamp(ev.speed / 8, 0.1, 0.8) });
        break;
      case "spawn":
        a.play("spawn", { pos: ev.pos });
        fx.spawnShimmer(ev.pos, [0.8, 0.4, 1]);
        break;
      case "melee":
        a.play("melee", { pos: ev.pos });
        break;
      case "telegraph":
        break;
    }
  }
  updateAutoResolution(realDt) {
    const s = this.save.settings;
    if (!s.autoResolution || this.state !== "playing")
      return;
    this.perfAccum += realDt;
    this.perfFrames++;
    if (this.perfAccum < 2)
      return;
    const avg = this.perfAccum / this.perfFrames;
    this.perfAccum = 0;
    this.perfFrames = 0;
    const prev = this.autoScale;
    if (avg > 1 / 52)
      this.autoScale = Math.max(0.5, this.autoScale - 0.1);
    else if (avg < 1 / 75)
      this.autoScale = Math.min(1, this.autoScale + 0.05);
    if (prev !== this.autoScale) {
      console.info(`[game] auto resolution: avg frame ${(avg * 1e3).toFixed(1)} ms → scale ${(s.resolutionScale * this.autoScale).toFixed(2)}`);
      this.gfx.setResolutionScale(s.resolutionScale * this.autoScale);
    }
  }
  get lastDeathDir() {
    return dirFromYawPitch(v3(), Math.atan2(-this.deathDir[0], -this.deathDir[2]), 0);
  }
};
var IDENTITY = mat4.identity();
var WHITE3 = [1, 1, 1];
var CORE = [9, 8.5, 7.5];
var TRAIL_PLAYER = [3.2, 2.2, 1.2];
var TRAIL_ENEMY = [4, 1.4, 0.6];

export async function boot() {
  const canvas = document.getElementById("gfx");
  const overlayEl = document.getElementById("overlay");
  if (!canvas || !overlayEl)
    throw new Error("Missing #gfx canvas or #overlay element.");
  let game = null;
  let gfx;
  try {
    gfx = await Gfx.create(canvas, (info) => {
      game?.stop();
      if (info.reason !== "destroyed")
        showUnsupported(`The GPU device was lost: ${info.message || info.reason}. Reload the page to continue.`);
    });
  } catch (err) {
    console.error("[boot] WebGPU init failed:", err);
    showUnsupported(err instanceof UnsupportedError ? err.message : `WebGPU initialisation failed: ${String(err)}`);
    return;
  }
  game = new Game(gfx, canvas, overlayEl);
  game.start();
}