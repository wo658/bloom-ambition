// 키트(비행기) 조각 형상. kit_layout.py가 정한 model·dims로 three.js 지오메트리를 만든다.
// 좌표는 cm, +x 왼쪽(좌현), +y 위, +z 앞(기수).
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { KitPiece } from "./kitTypes";

type Dims = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const DEG = Math.PI / 180;

// 행(row)마다 점 개수가 같은 격자 → 삼각형 면.
function grid(rows: THREE.Vector3[][]): THREE.BufferGeometry {
  const cols = rows[0].length;
  const pos: number[] = [];
  const uv: number[] = [];
  rows.forEach((row, i) => row.forEach((p, j) => {
    pos.push(p.x, p.y, p.z);
    uv.push(j / (cols - 1), i / (rows.length - 1));
  }));
  const index: number[] = [];
  for (let i = 0; i < rows.length - 1; i++) {
    for (let j = 0; j < cols - 1; j++) {
      const a = i * cols + j, b = a + 1, c = a + cols, d = c + 1;
      index.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

function merge(list: THREE.BufferGeometry[]) {
  const clean = list.map((g) => {
    const n = g.index ? g.toNonIndexed() : g;
    for (const name of Object.keys(n.attributes)) if (!["position", "normal", "uv"].includes(name)) n.deleteAttribute(name);
    if (!n.attributes.uv) n.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array((n.attributes.position.count) * 2), 2));
    if (!n.attributes.normal) n.computeVertexNormals();
    return n;
  });
  return mergeGeometries(clean)!;
}

// (z, y) 다각형을 x 방향으로 t만큼 밀어낸다. x0은 시작 x.
function extrudeZY(pts: number[][], t: number, x0: number) {
  const shape = new THREE.Shape(pts.map(([z, y]) => new THREE.Vector2(z, y)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: Math.abs(t), bevelEnabled: false });
  // (u, v, w) → (x = x0 + w·sign, y = v, z = u)
  const s = Math.sign(t) || 1;
  g.applyMatrix4(new THREE.Matrix4().set(0, 0, s, x0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1));
  return g;
}

function lerpProfile(profile: number[][], z: number) {
  for (let i = 0; i < profile.length - 1; i++) {
    const [z0, ...a] = profile[i];
    const [z1, ...b] = profile[i + 1];
    if (z <= z0 && z >= z1) {
      const t = (z0 - z) / (z0 - z1);
      return a.map((v, k) => v + (b[k] - v) * t);
    }
  }
  return profile[z > profile[0][0] ? 0 : profile.length - 1].slice(1);
}

function fuselageHalf(d: Dims) {
  const profile: number[][] = d.profile;
  const side: number = d.side;
  const zTop = profile[0][0], zEnd = profile[profile.length - 1][0];
  const rows: THREE.Vector3[][] = [];
  const N = 90, M = 22;
  for (let i = 0; i <= N; i++) {
    const z = zTop + (zEnd - zTop) * (i / N);
    const [rw, rh, cy] = lerpProfile(profile, z);
    const cut = (d.cuts as number[][]).find(([a, b]) => z >= a && z <= b);
    const start = cut ? cut[2] : 0;
    const row = [];
    for (let j = 0; j <= M; j++) {
      const a = (start + (180 - start) * (j / M)) * DEG;
      row.push(new THREE.Vector3(side * rw * Math.sin(a), cy + rh * Math.cos(a), z));
    }
    rows.push(row);
  }
  return merge([grid(rows), extrudeZY(d.fin, side * d.fin_t, 0)]);
}

function shell(d: Dims) {
  const rows: THREE.Vector3[][] = [];
  const N = 6, M = Math.max(6, Math.round((d.a1 - d.a0) / 8));
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const z = d.z0 + (d.z1 - d.z0) * t;
    const r = d.r0 + (d.r1 - d.r0) * t;
    const row = [];
    for (let j = 0; j <= M; j++) {
      const a = (d.a0 + (d.a1 - d.a0) * (j / M)) * DEG;
      row.push(new THREE.Vector3(r * Math.sin(a), d.cy + r * Math.cos(a), z));
    }
    rows.push(row);
  }
  return grid(rows);
}

const lin = (base: number[], x: number) => base[0] + base[1] * x;
// 대칭 날개꼴 두께 분포(앞전 둥글고 뒷전 얇게). 최댓값 1.
const airfoil = (v: number) => (Math.sqrt(Math.max(v, 0)) * (1 - v)) / 0.385;

function wingSide(d: Dims, side: number) {
  const xs = new Set<number>();
  const N = 44;
  for (let i = 0; i <= N; i++) xs.add(d.x0 + (d.x1 - d.x0) * (i / N));
  if (d.cut) for (const c of d.cut.x) if (c > d.x0 && c < d.x1) { xs.add(c - 1e-3); xs.add(c + 1e-3); }
  const us = [...xs].sort((a, b) => a - b);
  const surfaces: ("upper" | "lower")[] = d.surface === "both" ? ["upper", "lower"] : [d.surface];
  const M = 14;
  return surfaces.map((surface) => {
    const rows = us.map((ax) => {
      let le = lin(d.le, ax), te = lin(d.te, ax);
      if (ax > d.tip) {
        const f = Math.sqrt(Math.max(0, 1 - ((ax - d.tip) / (d.span - d.tip)) ** 2));
        const mid = (le + te) / 2;
        le = mid + (le - mid) * f;
        te = mid + (te - mid) * f;
      }
      const y = lin(d.y, ax);
      const t = lin(d.t, ax);
      const cut = d.cut && ax > d.cut.x[0] && ax < d.cut.x[1];
      const v1 = cut ? Math.min(d.v1, d.cut.v) : d.v1;
      const row = [];
      for (let j = 0; j <= M; j++) {
        const v = d.v0 + (v1 - d.v0) * (j / M);
        const h = (t / 2) * airfoil(v);
        row.push(new THREE.Vector3(side * ax, y + (surface === "upper" ? h : -h), le + (te - le) * v));
      }
      return row;
    });
    return grid(rows);
  });
}

function wing(d: Dims) {
  const sides = d.side === 0 ? [1, -1] : [d.side];
  return merge(sides.flatMap((s) => wingSide(d, s)));
}

function cylinder(d: Dims) {
  const g = new THREE.CylinderGeometry(d.r2 ?? d.r, d.r, d.len, 24, 1, !!d.open);
  if (d.axis === "z") g.rotateX(Math.PI / 2);
  if (d.axis === "x") g.rotateZ(-Math.PI / 2);
  return g;
}

function radial(d: Dims) {
  const parts: THREE.BufferGeometry[] = [];
  const crank = new THREE.CylinderGeometry(d.r_in, d.r_in, d.t, 24);
  crank.rotateX(Math.PI / 2);
  parts.push(crank);
  const len = d.r_out - d.r_in;
  for (let k = 0; k < d.n; k++) {
    const a = ((k + d.phase) / d.n) * Math.PI * 2;
    const c = new THREE.CylinderGeometry(d.cyl_r * 0.85, d.cyl_r, len, 12);
    c.translate(0, d.r_in + len / 2, 0);
    c.rotateZ(a);
    parts.push(c);
  }
  return merge(parts);
}

function blades(d: Dims) {
  const R = d.radius, c = d.chord;
  const outline = [[-0.3 * c, 0.25], [-0.5 * c, 0.4 * R], [-0.42 * c, 0.9 * R], [0, R], [0.42 * c, 0.9 * R], [0.5 * c, 0.4 * R], [0.3 * c, 0.25]];
  const shape = new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x, y)));
  const parts: THREE.BufferGeometry[] = [];
  for (let k = 0; k < d.n; k++) {
    const g = new THREE.ExtrudeGeometry(shape, { depth: 0.06, bevelEnabled: false });
    g.translate(0, 0, -0.03);
    g.rotateY(0.45); // 날개 각도
    g.rotateZ((k / d.n) * Math.PI * 2);
    parts.push(g);
  }
  const hub = new THREE.CylinderGeometry(0.3, 0.3, 0.35, 20);
  hub.rotateX(Math.PI / 2);
  parts.push(hub);
  return merge(parts);
}

function canopy(d: Dims) {
  const rows: THREE.Vector3[][] = [];
  const N = 8, M = 16;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const z = d.z0 + (d.z1 - d.z0) * t;
    const w = d.w0 + (d.w1 - d.w0) * t;
    const h = d.h0 + (d.h1 - d.h0) * t;
    const row = [];
    for (let j = 0; j <= M; j++) {
      const a = (-90 + 180 * (j / M)) * DEG;
      row.push(new THREE.Vector3(w * Math.sin(a), d.y + h * Math.cos(a) - 0.25, z));
    }
    rows.push(row);
  }
  return grid(rows);
}

function capsule(d: Dims) {
  const L = d.len, r = d.r;
  const profile = [[0.001, -L / 2], [r * 0.35, -L / 2], [r * 0.9, -L * 0.25], [r, -L * 0.05], [r, L * 0.25],
    [r * 0.8, L * 0.4], [r * 0.4, L * 0.48], [0.001, L / 2]].map(([x, y]) => new THREE.Vector2(x, y));
  const [start, length] = d.half > 0 ? [0, Math.PI] : d.half < 0 ? [Math.PI, Math.PI] : [0, Math.PI * 2];
  const body = new THREE.LatheGeometry(profile, 24, start, length);
  body.rotateX(Math.PI / 2);
  const parts: THREE.BufferGeometry[] = [body];
  if (d.fins && d.half >= 0) {
    for (const a of [0, Math.PI / 2]) {
      const fin = new THREE.BoxGeometry(0.03, r * 2.4, L * 0.16);
      fin.translate(0, 0, -L / 2 + L * 0.08);
      fin.rotateZ(a + Math.PI / 4);
      parts.push(fin);
    }
  }
  return merge(parts);
}

function seat(d: Dims) {
  const t = 0.06;
  const pan = new THREE.BoxGeometry(d.w, t, d.d);
  pan.translate(0, -d.h / 2, 0);
  const back = new THREE.BoxGeometry(d.w, d.h, t);
  back.translate(0, 0, -d.d / 2);
  const left = new THREE.BoxGeometry(t, d.h * 0.55, d.d);
  left.translate(d.w / 2, -d.h * 0.2, 0);
  const right = left.clone().translate(-d.w, 0, 0);
  return merge([pan, back, left, right]);
}

function detail(d: Dims) {
  const s = d.size;
  if (d.kind === "photo_etch") return new THREE.BoxGeometry(s, s * 0.7, 0.025);
  if (d.kind === "clear") return new THREE.SphereGeometry(s / 2, 12, 8);
  return new THREE.BoxGeometry(s, s * 0.8, s * 0.6);
}

export function buildGeometry(piece: Pick<KitPiece, "model" | "dims">): THREE.BufferGeometry {
  const d = piece.dims as Dims;
  switch (piece.model) {
    case "fuselage_half": return fuselageHalf(d);
    case "shell": return shell(d);
    case "wing": return wing(d);
    case "box": return new THREE.BoxGeometry(...(d.size as [number, number, number]));
    case "cyl": return cylinder(d);
    case "dome": return new THREE.SphereGeometry(d.r, 14, 10);
    case "disc": { const g = new THREE.CylinderGeometry(d.r, d.r, d.t, 32); g.rotateX(Math.PI / 2); return g; }
    case "ring": return new THREE.TorusGeometry(d.r, d.tube, 8, 36);
    case "wheel": { const g = new THREE.TorusGeometry(d.r - d.w / 2, d.w / 2, 12, 32); g.rotateY(Math.PI / 2); return g; }
    case "hub": { const g = new THREE.CylinderGeometry(d.r, d.r, d.w, 24); g.rotateZ(Math.PI / 2); return g; }
    case "radial": return radial(d);
    case "blades": return blades(d);
    case "canopy": return canopy(d);
    case "capsule": return capsule(d);
    case "polygon": return extrudeZY(d.pts, d.t, -d.t / 2);
    case "seat": return seat(d);
    default: return detail(d);
  }
}
