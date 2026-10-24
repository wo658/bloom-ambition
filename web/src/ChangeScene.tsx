// 3D에서 도면이 Before → After 로 바뀌는 과정을 재생한다(계약은 compare.ts). Canvas 안에 놓인다.
// 비교 중에는 App이 Assembly로 proposal.before / after 의 focus 단계를 "끝난 모습"(still)으로 그리되 바뀐 판·철물은 숨기고(hidden),
// 여기서 그 자리에 대역(proxy)을 그려 늘이고 옮기고 빼고 넣는다. 옛 모습은 점선 윤곽·붉은 잔상으로 남아 바뀐 곳이 계속 읽힌다.
// 값은 모두 gsap이 상태 객체에 쓰고, useFrame이 매 프레임 메쉬·카메라·DOM 말풍선에 옮긴다(React 상태 없음).
import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Edges, type EdgesRef } from "@react-three/drei";
import gsap from "gsap";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { EDGE, HIGHLIGHT, ON_WALL, poses, stepWorld, type RenderStyle } from "./Assembly";
import { StraightArrow } from "./Arrows";
import { setCompare, useCompare, type CompareState, type Proposal } from "./compare";
import { HardwareMesh, METAL, orientation } from "./Hardware";
import { t } from "./lang";
import { diffScenes } from "./sceneDiff";
import type { Scene, SmallPart, Step, Vec3 } from "./types";
import { oakMaps, woodBox } from "./wood";

const RED = "#e5484d";
const GREEN = "#1fa463";
const AMBER = HIGHLIGHT;
const WHITE = new THREE.Color("#ffffff");
const X_AXIS = new THREE.Vector3(1, 0, 0);

// 시간표(초). After 재생은 약 3초: Before 보여 주기 → 변하기 → 자리 잡기.
const T = {
  cam: 0.6, // 카메라가 바뀐 곳을 담는 시간(= Before 박자)
  change: 0.65, // 변하기 시작
  morph: 1.3, // 늘고 줄고 미끄러지는 시간
  remove: 1.0,
  dropAt: 0.35, // 변하기 시작부터 새 부품이 떨어지기 시작할 때까지
  drop: 0.8,
  settle: 2.3, // 강조가 옅어지며 자리 잡는 때
  back: 0.7, // Before로 되돌리는 시간(더 빠르게)
};
const LIFT = 3; // 빠지는 부품이 들리는 높이(cm)
const DROP = 12; // 새 판이 떨어지기 시작하는 높이
const DROP_SMALL = 6;
const HW_MAGNIFY = 1.6; // 바뀐 철물은 판 속에 묻혀도 보이게 크게, 맨 위에 그린다
const PAD = 0.45; // 숨 쉬는 테두리 두께(cm)
const TRAIL = 3; // 미끄러지는 판 뒤에 남는 잔상 수
const CAM_MIN = 55;
const CAM_MAX = 360;
const HOME_DIRECTION = new THREE.Vector3(150, 118, 200).normalize();
const FRONT_DIRECTION = new THREE.Vector3(0.4, -0.06, 1).normalize();
const LYING_DIRECTION = HOME_DIRECTION.clone().add(new THREE.Vector3(0, 0.75, 0)).normalize();
// 먼지 알갱이가 흩어지는 방향(고정값이라 매번 같은 모양).
const DUST = Array.from({ length: 10 }, (_, i) => {
  const a = i * 2.39996, y = 1 - (i + 0.5) / 10;
  const r = Math.sqrt(1 - y * y);
  return [Math.cos(a) * r, Math.abs(y) * 0.6 + 0.2, Math.sin(a) * r] as Vec3;
});

const add = (a: Vec3, b: Vec3, k = 1): Vec3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const lerp = (a: Vec3, b: Vec3, u: number): Vec3 => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smooth = (u: number) => u * u * (3 - 2 * u);
const fmt = (n: number) => String(Number(n.toFixed(1)));
const same = (a: Vec3, b: Vec3, eps = 0.05) => a.every((v, k) => Math.abs(v - b[k]) <= eps);

// ---------- 재생 계획(어느 단계를 보여 주고, 무엇을 대역으로 그릴지) ----------

type Mode = "added" | "removed" | "resized" | "moved" | "swapped";
export type Item = {
  kind: "panel" | "small"; mode: Mode; id: string; name: string; entry: number;
  // 판: 크기·위치(가구 좌표). 철물: pos가 at, size는 쓰지 않는다.
  size0: Vec3; size1: Vec3; pos0: Vec3; pos1: Vec3;
  part0?: SmallPart; part1?: SmallPart; onWall: boolean;
};
type Callout =
  | { kind: "dim"; item: number; label: string; from: number; to: number }
  | { kind: "move"; item: number; dist: number; dir: Vec3 }
  | { kind: "add" | "remove" | "swap"; item: number; text: string };
export type ComparePlan = { beforeIdx: number; afterIdx: number; items: Item[]; callouts: Callout[]; hidden: Set<string> };

// 그 단계가 끝났을 때 보이는 판·철물(Assembly와 같은 규칙: 지난 단계의 잠깐 쓰는 것은 빠지고, 같은 철물은 마지막 것).
function shownAt(scene: Scene, idx: number) {
  const steps = scene.steps.slice(0, idx + 1);
  const panels = new Set(steps.flatMap((s) => s.adds));
  const smalls = new Map<string, SmallPart>();
  steps.forEach((s, i) => s.small.forEach((p) => { if (!p.transient || i === idx) smalls.set(p.id, p); }));
  return { panels, smalls };
}

function axisName(size: Vec3, k: number) {
  const sorted = [...size].sort((a, b) => a - b);
  return size[k] === sorted[0] ? "두께" : size[k] === sorted[2] ? "길이" : "폭";
}

const inBox = (p: Vec3, pos: Vec3, size: Vec3, tol = 1) => p.every((c, k) => Math.abs(c - pos[k]) <= size[k] / 2 + tol);

export function comparePlan(proposal: Pick<Proposal, "before" | "after" | "diff">, fallback: number): ComparePlan {
  const { before, after, diff } = proposal;
  const idxOf = (s: Scene, n?: number) => (n === undefined ? -1 : s.steps.findIndex((x) => x.number === n));
  // focusStep은 after 단계 번호. before 쪽은 같은 단계를 가리키는 줄의 짝 번호로 찾는다.
  const refs = diff.entries.flatMap((e) => ("step" in e && typeof e.step === "object" && e.step ? [e.step] : []));
  let aNo = diff.focusStep ?? undefined;
  let bNo: number | undefined;
  if (aNo === undefined && refs.length) { aNo = refs[0].after; bNo = refs[0].before; }
  bNo ??= refs.find((r) => r.after === aNo && r.before !== undefined)?.before;
  let ai = idxOf(after, aNo), bi = idxOf(before, bNo ?? aNo);
  if (ai < 0) ai = Math.min(Math.max(bi >= 0 ? bi : fallback, 0), after.steps.length - 1);
  if (bi < 0) bi = Math.min(ai, before.steps.length - 1);
  const B = shownAt(before, bi), A = shownAt(after, ai);
  const bPanel = new Map(before.panels.map((p) => [p.id, p]));
  const aPanel = new Map(after.panels.map((p) => [p.id, p]));

  const byId = new Map<string, Item>();
  const put = (it: Item) => {
    const old = byId.get(it.id);
    // 같은 철물이 바뀌고(swapped) 옮겨지면(moved) 한 대역으로 합친다.
    if (old) Object.assign(old, { ...it, mode: old.mode === "swapped" || it.mode === "swapped" ? "swapped" : it.mode, entry: old.entry });
    else byId.set(it.id, it);
  };
  const zero: Vec3 = [0, 0, 0];
  diff.entries.forEach((e, entry) => {
    switch (e.type) {
      case "panel_added":
        if (A.panels.has(e.id)) put({ kind: "panel", mode: "added", id: e.id, name: e.name, entry, size0: e.size, size1: e.size, pos0: e.pos, pos1: e.pos, onWall: false });
        break;
      case "panel_removed":
        if (B.panels.has(e.id)) put({ kind: "panel", mode: "removed", id: e.id, name: e.name, entry, size0: e.size, size1: e.size, pos0: e.pos, pos1: e.pos, onWall: false });
        break;
      case "panel_resized":
        if (A.panels.has(e.id) || B.panels.has(e.id)) put({ kind: "panel", mode: "resized", id: e.id, name: e.name, entry, size0: e.from, size1: e.to, pos0: e.posFrom, pos1: e.posTo, onWall: false });
        break;
      case "panel_moved": {
        const size = (aPanel.get(e.id) ?? bPanel.get(e.id))?.size;
        if (size && (A.panels.has(e.id) || B.panels.has(e.id))) put({ kind: "panel", mode: "moved", id: e.id, name: e.name, entry, size0: size, size1: size, pos0: e.from, pos1: e.to, onWall: false });
        break;
      }
      case "small_added": {
        const p = A.smalls.get(e.id);
        if (p) put({ kind: "small", mode: "added", id: e.id, name: e.name, entry, size0: zero, size1: zero, pos0: p.at, pos1: p.at, part1: p, onWall: ON_WALL.includes(p.model) });
        break;
      }
      case "small_removed": {
        const p = B.smalls.get(e.id);
        if (p) put({ kind: "small", mode: "removed", id: e.id, name: e.name, entry, size0: zero, size1: zero, pos0: p.at, pos1: p.at, part0: p, onWall: ON_WALL.includes(p.model) });
        break;
      }
      case "small_moved": {
        const p0 = B.smalls.get(e.id), p1 = A.smalls.get(e.id);
        const p = p1 ?? p0;
        if (p) put({ kind: "small", mode: "moved", id: e.id, name: e.name, entry, size0: zero, size1: zero, pos0: e.from, pos1: e.to, part0: p0 ?? p, part1: p1 ?? p, onWall: ON_WALL.includes(p.model) });
        break;
      }
      case "small_swapped": {
        const p0 = B.smalls.get(e.id), p1 = A.smalls.get(e.id);
        if (p0 && p1) put({ kind: "small", mode: "swapped", id: e.id, name: `${e.fromName}→${e.toName}`, entry, size0: zero, size1: zero, pos0: p0.at, pos1: p1.at, part0: p0, part1: p1, onWall: ON_WALL.includes(p1.model) });
        break;
      }
    }
  });
  const items = [...byId.values()];

  // 말풍선: 판마다 하나, 철물은 같은 종류·같은 변화를 하나로 묶는다. 바뀐 판에 붙어 같이 움직이는 철물은 따로 말하지 않는다.
  const callouts: Callout[] = [];
  const panels = items.filter((it) => it.kind === "panel");
  const riding = (it: Item) => panels.some((p) => p.mode !== "added" && p.mode !== "removed"
    && (inBox(it.pos0, p.pos0, p.size0) || inBox(it.pos1, p.pos1, p.size1)));
  const groups = new Map<string, { item: number; n: number; it: Item }>();
  items.forEach((it, i) => {
    if (it.kind === "panel") {
      if (it.mode === "resized") {
        const k = [0, 1, 2].find((a) => Math.abs(it.size0[a] - it.size1[a]) > 0.05) ?? 1;
        callouts.push({ kind: "dim", item: i, label: axisName(it.size0, k), from: it.size0[k], to: it.size1[k] });
      } else if (it.mode === "moved") {
        const d = add(it.pos1, it.pos0, -1);
        callouts.push({ kind: "move", item: i, dist: Math.hypot(...d), dir: d });
      } else callouts.push({ kind: it.mode === "added" ? "add" : "remove", item: i, text: t(it.name) });
      return;
    }
    if (it.mode === "moved" && riding(it)) return;
    const d = add(it.pos1, it.pos0, -1);
    const key = it.mode === "moved" ? `m|${d.map((v) => v.toFixed(1))}` : `${it.mode}|${it.name}`;
    const g = groups.get(key);
    if (g) g.n += 1;
    else groups.set(key, { item: i, n: 1, it });
  });
  for (const { item, n, it } of groups.values()) {
    const count = n > 1 ? ` ×${n}` : "";
    if (it.mode === "moved") {
      const d = add(it.pos1, it.pos0, -1);
      callouts.push({ kind: "move", item, dist: Math.hypot(...d), dir: d });
    } else if (it.mode === "swapped") {
      const [a, b] = it.name.split("→");
      callouts.push({ kind: "swap", item, text: `${t(a)} → ${t(b)}${count}` });
    } else callouts.push({ kind: it.mode === "added" ? "add" : "remove", item, text: `${t(it.name)}${count}` });
  }
  return { beforeIdx: bi, afterIdx: ai, items, callouts, hidden: new Set(items.map((it) => it.id)) };
}

// ---------- App이 쓰는 훅: 비교 중이면 뷰어가 그릴 scene·단계·숨길 부품 ----------

export type CompareView = {
  cmp: CompareState; plan: ComparePlan; scene: Scene; stepIndex: number; hidden: Set<string>; key: string;
};

export function useCompareView(live: Scene | null, stepIndex: number): CompareView | null {
  const cmp = useCompare();
  const p = cmp?.proposal;
  // 지금 단계는 수정안에 단계 정보가 하나도 없을 때만 쓰는 대체값이라, 수정안이 바뀔 때만 다시 계산한다.
  const plan = useMemo(() => (p ? comparePlan(p, stepIndex) : null), [p?.before, p?.after, p?.diff]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!cmp || !plan || !live) return null;
  const before = cmp.mode === "before";
  return {
    cmp, plan,
    scene: before ? cmp.proposal.before : cmp.proposal.after,
    stepIndex: before ? plan.beforeIdx : plan.afterIdx,
    hidden: plan.hidden,
    key: `cmp-${cmp.proposal.id}-${cmp.mode}`,
  };
}

// 개발 중에는 Playwright·콘솔에서 수정안을 바로 띄울 수 있게 열어 둔다.
if (import.meta.env.DEV) {
  (window as unknown as { __compare?: unknown }).__compare = { setCompare, diffScenes };
}

// ---------- 재질 ----------

// 판 대역: Assembly의 Material과 같은 모양(도면 흰 면, 툰, 원목). 물들이고 흐리려고 직접 만든다.
function boardMaterial(style: RenderStyle) {
  if (style === "technical") return new THREE.MeshBasicMaterial({ color: "#ffffff" });
  if (style === "toon") return new THREE.MeshToonMaterial({ color: "#ffffff" });
  return new THREE.MeshStandardMaterial({ color: "#ffffff", ...oakMaps(), normalScale: new THREE.Vector2(0.6, 0.6), roughness: 1, metalness: 0 });
}

// 철물 대역: 판에 가려져도 보이게 깊이 테스트를 끄고 맨 위에 그린다(지금 단계 철물과 같은 규칙).
function hardwareMaterial(style: RenderStyle, color: string, metal: boolean) {
  const common = { color, depthTest: false, transparent: true, side: THREE.DoubleSide };
  if (style === "technical") return new THREE.MeshBasicMaterial(common);
  if (style === "toon") return new THREE.MeshToonMaterial(common);
  return new THREE.MeshStandardMaterial({ ...common, metalness: metal ? 0.7 : 0, roughness: metal ? 0.35 : 0.8 });
}

function fade(m: THREE.Material, opacity: number) {
  m.opacity = opacity;
  const want = opacity < 0.999;
  if (m.transparent !== want) { m.transparent = want; m.needsUpdate = true; }
}

function tone(mode: Mode) {
  return mode === "added" ? GREEN : mode === "removed" ? RED : AMBER;
}

// 숨 쉬는 테두리 세기(0→1 사이를 오간다).
const breathe = (pulse: number, time: number) => pulse * (0.6 + 0.4 * Math.sin(time * 6.5));

// 동그란 후광(철물의 숨 쉬는 테두리). 한 장 만들어 나눠 쓴다.
let haloTex: THREE.CanvasTexture | null = null;
function haloMap() {
  if (haloTex) return haloTex;
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(64, 64, 26, 64, 64, 62);
  grad.addColorStop(0, "rgba(255,255,255,0)");
  grad.addColorStop(0.55, "rgba(255,255,255,1)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  haloTex = new THREE.CanvasTexture(c);
  return haloTex;
}

// ---------- 상태 ----------

// k: 늘고 줄고 옮겨진 정도(0=Before, 1=After). rm: 빠지는 진행, ad: 들어오는 진행(넘침 포함).
// pulse: 숨 쉬는 테두리, ghost: 옛 모습(점선·붉은 잔상), glow: 새 부품의 초록 빛, dust: 먼지 퍼짐(0→1).
type ItemState = { k: number; rm: number; ad: number; pulse: number; ghost: number; glow: number; dust: number };
type CallState = { a: number; n: number };

function beforeState(s: ItemState) {
  Object.assign(s, { k: 0, rm: 0, ad: 0, ghost: 0, glow: 0, dust: 0 });
}
function afterState(s: ItemState, it: Item) {
  const leaves = it.mode === "removed" || it.mode === "swapped";
  Object.assign(s, { k: 1, rm: 1, ad: 1, ghost: it.mode === "added" ? 0 : 1, glow: 0.35, dust: leaves ? 1 : 0 });
}

// ---------- 대역: 판 ----------

function PanelProxy({ item, st, style, up, anchor }: {
  item: Item; st: ItemState; style: RenderStyle; up: Vec3; anchor: (g: THREE.Object3D | null) => void;
}) {
  const { mode } = item;
  const base = mode === "removed" ? item.size0 : item.size1;
  const geometry = useMemo(() => woodBox(base, item.id), [base, item.id]);
  const unit = useMemo(() => new THREE.BoxGeometry(1, 1, 1), []);
  const dust = useMemo(() => new THREE.IcosahedronGeometry(0.5, 0), []);
  // 옛 모습 점선: 늘고 옮겨진 판은 옛 자리, 새 판은 들어올 자리(Before에서), 빠진 판은 붉은 잔상.
  const ghostAt = mode === "added" ? item.pos1 : item.pos0;
  const ghostSize = mode === "added" ? item.size1 : item.size0;
  const ghostGeo = useMemo(() => new THREE.BoxGeometry(...ghostSize), [ghostSize]);
  const color = tone(mode);
  const m = useMemo(() => ({
    board: boardMaterial(style),
    hull: new THREE.MeshBasicMaterial({ color, side: THREE.BackSide, transparent: true, opacity: 0, depthWrite: false }),
    fill: new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false }),
    trail: new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false }),
    dust: new THREE.MeshBasicMaterial({ color: "#b9aa97", transparent: true, opacity: 0, depthWrite: false }),
  }), [style, color]);
  useEffect(() => () => { Object.values(m).forEach((x) => x.dispose()); }, [m]);
  useEffect(() => () => { geometry.dispose(); unit.dispose(); dust.dispose(); ghostGeo.dispose(); }, [geometry, unit, dust, ghostGeo]);
  const tint = useMemo(() => new THREE.Color(color), [color]);

  const group = useRef<THREE.Group>(null);
  const mesh = useRef<THREE.Mesh>(null);
  const edges = useRef<EdgesRef>(null);
  const hull = useRef<THREE.Mesh>(null);
  const ghost = useRef<THREE.Group>(null);
  const ghostEdges = useRef<EdgesRef>(null);
  const trails = useRef<(THREE.Mesh | null)[]>([]);
  const dusts = useRef<THREE.Group>(null);
  const arrow = useRef<THREE.Group>(null);
  const travels = !same(item.pos0, item.pos1) && (mode === "moved" || mode === "resized");
  // 옮겨지는 판의 화살표는 판 앞쪽 모서리 밖에서 옛 자리 → 새 자리를 가리킨다.
  const side: Vec3 = [0, 0, base[2] / 2 + 3];
  const delta = add(item.pos1, item.pos0, -1);
  const showArrow = mode === "moved" && Math.hypot(...delta) > 1;

  useFrame(({ clock }) => {
    const g = group.current, me = mesh.current;
    if (!g || !me) return;
    let pos: Vec3 = item.pos1, size: Vec3 = item.size1, opacity = 1, mix = 0;
    if (mode === "resized" || mode === "moved") {
      pos = lerp(item.pos0, item.pos1, st.k);
      size = lerp(item.size0, item.size1, st.k);
    } else if (mode === "added") {
      pos = add(item.pos1, up, (1 - st.ad) * DROP);
      opacity = clamp01(st.ad * 2.5);
      mix = st.glow * 0.6;
    } else {
      // 빠지는 판: 붉게 물든 뒤 살짝 들리고, 작아지며 사라진다.
      const out = clamp01((st.rm - 0.45) / 0.55);
      pos = add(item.pos0, up, smooth(clamp01((st.rm - 0.12) / 0.5)) * LIFT);
      size = item.size0.map((v) => v * (1 - 0.22 * out)) as Vec3;
      opacity = 1 - out;
      mix = clamp01(st.rm / 0.3) * 0.75;
    }
    g.position.set(...pos);
    me.scale.set(size[0] / base[0], size[1] / base[1], size[2] / base[2]);
    me.visible = opacity > 0.01;
    fade(m.board, opacity);
    m.board.color.copy(WHITE).lerp(tint, mix);
    const em = edges.current?.material;
    if (em) { em.opacity = opacity; em.transparent = true; }
    const p = breathe(st.pulse, clock.elapsedTime);
    if (hull.current) {
      const pad = PAD + p * 0.35;
      hull.current.scale.set(size[0] + pad * 2, size[1] + pad * 2, size[2] + pad * 2);
      m.hull.opacity = Math.max(p * 0.85, st.glow * 0.7) * opacity;
      hull.current.visible = m.hull.opacity > 0.01;
    }
    if (ghost.current) {
      ghost.current.visible = st.ghost > 0.01;
      m.fill.opacity = mode === "removed" ? 0.16 * st.ghost : 0;
      const ge = ghostEdges.current?.material;
      if (ge) ge.opacity = 0.9 * st.ghost;
    }
    // 잔상: 미끄러지는 동안만 조금씩 늦게 따라오며 옅어진다.
    const moving = travels && st.k > 0.01 && st.k < 0.99;
    trails.current.forEach((tr, i) => {
      if (!tr) return;
      tr.visible = moving;
      if (!moving) return;
      const kk = clamp01(st.k - (i + 1) * 0.07);
      tr.position.set(...lerp(item.pos0, item.pos1, kk));
      const sz = lerp(item.size0, item.size1, kk);
      tr.scale.set(...sz);
    });
    m.trail.opacity = 0.14 * Math.sin(Math.PI * clamp01(st.k));
    if (dusts.current) {
      const d = st.dust;
      dusts.current.visible = d > 0.001 && d < 0.999;
      dusts.current.children.forEach((c, i) => {
        const dir = DUST[i];
        const r = 2 + 14 * d;
        c.position.set(dir[0] * r + up[0] * (LIFT + 4 * d), dir[1] * r * 0.4 + up[1] * (LIFT + 4 * d), dir[2] * r + up[2] * (LIFT + 4 * d));
        c.scale.setScalar(0.6 + 2.2 * d);
      });
      m.dust.opacity = 0.55 * (1 - d);
    }
    if (arrow.current) arrow.current.visible = showArrow && st.k > 0.02;
  });

  return (
    <>
      <group ref={(g) => { group.current = g; anchor(g); }} position={item.pos0}>
        <mesh ref={mesh} geometry={geometry} material={m.board} castShadow receiveShadow>
          <Edges ref={edges} color={EDGE[style]} lineWidth={style === "technical" ? 2 : 1} transparent />
        </mesh>
        <mesh ref={hull} geometry={unit} material={m.hull} renderOrder={1} />
      </group>
      <group ref={ghost} position={ghostAt} visible={false}>
        <mesh geometry={ghostGeo} material={m.fill} renderOrder={2} />
        <Edges ref={ghostEdges} geometry={ghostGeo} color={color} lineWidth={1.6} dashed dashSize={1.4} gapSize={0.9}
          transparent depthWrite={false} renderOrder={3} />
      </group>
      {travels && Array.from({ length: TRAIL }, (_, i) => (
        <mesh key={i} ref={(x) => { trails.current[i] = x; }} geometry={unit} material={m.trail} visible={false} />
      ))}
      {(mode === "removed") && (
        <group ref={dusts} position={item.pos0} visible={false}>
          {DUST.map((_, i) => <mesh key={i} geometry={dust} material={m.dust} />)}
        </group>
      )}
      {showArrow && (
        <StraightArrow ref={arrow} tail={add(item.pos0, side)} head={add(item.pos1, side)} width={Math.min(4, Math.max(2, Math.hypot(...delta) * 0.5))} />
      )}
    </>
  );
}

// ---------- 대역: 철물 ----------

// 철물 하나의 모습. role: in(들어옴)·out(빠짐)·move(옮겨짐).
function SmallView({ part, role, item, st, style, up, anchor }: {
  part: SmallPart; role: "in" | "out" | "move"; item: Item; st: ItemState; style: RenderStyle; up: Vec3;
  anchor?: (g: THREE.Object3D | null) => void;
}) {
  const quaternion = useMemo(() => orientation(part.axis, part.up), [part.axis, part.up]);
  const metal = METAL.includes(part.model);
  const baseColor = style === "technical" ? (metal ? "#b5b5b5" : "#e2e2e2") : part.color;
  const color = role === "in" ? GREEN : role === "move" ? AMBER : RED;
  const m = useMemo(() => ({
    main: hardwareMaterial(style, role === "out" ? baseColor : color, metal),
    accent: hardwareMaterial(style, "#2b2b2b", false),
    ghost: new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, depthTest: false, depthWrite: false, side: THREE.DoubleSide }),
    halo: new THREE.SpriteMaterial({ map: haloMap(), color, transparent: true, opacity: 0, depthTest: false, depthWrite: false }),
    dust: new THREE.MeshBasicMaterial({ color: "#b9aa97", transparent: true, opacity: 0, depthWrite: false, depthTest: false }),
  }), [style, role, color, baseColor, metal]);
  useEffect(() => () => { Object.values(m).forEach((x) => x.dispose()); }, [m]);
  const dust = useMemo(() => new THREE.IcosahedronGeometry(0.22, 0), []);
  useEffect(() => () => dust.dispose(), [dust]);
  const from = useMemo(() => new THREE.Color(baseColor), [baseColor]);
  const red = useMemo(() => new THREE.Color(RED), []);
  const reach = Math.max(part.dims.length ?? 0, part.dims.head_d ?? part.dims.d ?? part.dims.width ?? 1, 1.5) * HW_MAGNIFY;

  const group = useRef<THREE.Group>(null);
  const scaler = useRef<THREE.Group>(null);
  const halo = useRef<THREE.Sprite>(null);
  const ghost = useRef<THREE.Group>(null);
  const dusts = useRef<THREE.Group>(null);
  // 옛 자리 잔상: 옮겨진 것은 옛 자리, 빠진 것은 붉게, 새로 들어올 것은 Before에서 초록으로.
  const ghostAt = role === "in" ? item.pos1 : item.pos0;
  const at0 = role === "in" ? item.pos1 : item.pos0;

  useFrame(({ clock }) => {
    const g = group.current;
    if (!g) return;
    let pos: Vec3 = at0, opacity = 1, scale = 1;
    if (role === "move") pos = lerp(item.pos0, item.pos1, st.k);
    else if (role === "in") {
      pos = add(item.pos1, up, (1 - st.ad) * DROP_SMALL);
      opacity = clamp01(st.ad * 2.5);
      scale = 0.6 + 0.4 * Math.min(st.ad, 1.15);
    } else {
      const out = clamp01((st.rm - 0.45) / 0.55);
      pos = add(item.pos0, up, smooth(clamp01((st.rm - 0.12) / 0.5)) * LIFT);
      opacity = 1 - out;
      scale = 1 - 0.4 * out;
      (m.main as THREE.MeshBasicMaterial).color.lerpColors(from, red, clamp01(st.rm / 0.3));
    }
    g.position.set(...pos);
    g.visible = opacity > 0.01;
    m.main.opacity = opacity;
    m.accent.opacity = opacity;
    scaler.current?.scale.setScalar(HW_MAGNIFY * scale);
    const p = breathe(st.pulse, clock.elapsedTime);
    if (halo.current) {
      m.halo.opacity = Math.max(p * 0.75, role === "in" ? st.glow * 0.6 : 0) * opacity;
      halo.current.scale.setScalar(reach * (0.95 + 0.2 * p) + 2);
    }
    if (ghost.current) {
      ghost.current.visible = st.ghost > 0.01;
      m.ghost.opacity = 0.32 * st.ghost;
    }
    if (dusts.current) {
      const d = st.dust;
      dusts.current.visible = role === "out" && d > 0.001 && d < 0.999;
      dusts.current.children.forEach((c, i) => {
        const dir = DUST[i], r = 0.6 + 4 * d;
        c.position.set(dir[0] * r + up[0] * (LIFT + d), dir[1] * r * 0.4 + up[1] * (LIFT + d), dir[2] * r + up[2] * (LIFT + d));
        c.scale.setScalar(0.6 + 2 * d);
      });
      m.dust.opacity = 0.6 * (1 - d);
    }
  });

  return (
    <>
      <group ref={(g) => { group.current = g; anchor?.(g); }} position={at0}>
        <group quaternion={quaternion}>
          <group ref={scaler} scale={HW_MAGNIFY}>
            <HardwareMesh part={part} material={m.main} accent={m.accent} renderOrder={14} />
          </group>
        </group>
        <sprite ref={halo} material={m.halo} renderOrder={13} />
      </group>
      <group ref={ghost} position={ghostAt} quaternion={quaternion} scale={HW_MAGNIFY} visible={false}>
        <HardwareMesh part={part} material={m.ghost} accent={m.ghost} renderOrder={12} />
      </group>
      {role === "out" && (
        <group ref={dusts} position={item.pos0} visible={false}>
          {DUST.map((_, i) => <mesh key={i} geometry={dust} material={m.dust} renderOrder={15} />)}
        </group>
      )}
    </>
  );
}

function SmallProxy({ item, st, style, up, anchor }: {
  item: Item; st: ItemState; style: RenderStyle; up: Vec3; anchor: (g: THREE.Object3D | null) => void;
}) {
  if (item.mode === "swapped") {
    return (
      <>
        <SmallView part={item.part0!} role="out" item={item} st={st} style={style} up={up} />
        <SmallView part={item.part1!} role="in" item={item} st={st} style={style} up={up} anchor={anchor} />
      </>
    );
  }
  const role = item.mode === "added" ? "in" : item.mode === "removed" ? "out" : "move";
  const part = (role === "out" ? item.part0 : item.part1) ?? item.part0 ?? item.part1!;
  return <SmallView part={part} role={role} item={item} st={st} style={style} up={up} anchor={anchor} />;
}

// ---------- 말풍선(DOM) ----------

type CallEl = { root: HTMLDivElement; num?: HTMLElement; arrow?: HTMLElement; last: string };

function buildCallouts(host: HTMLElement, callouts: Callout[]) {
  const layer = document.createElement("div");
  layer.className = "chg-layer";
  const els: CallEl[] = callouts.map((c) => {
    const root = document.createElement("div");
    root.className = `chg-callout chg-${c.kind}`;
    const span = (cls: string, text = "") => {
      const s = document.createElement("span");
      s.className = cls;
      s.textContent = text;
      root.appendChild(s);
      return s;
    };
    const el: CallEl = { root, last: "" };
    if (c.kind === "dim") {
      span("chg-key", t(c.label));
      span("chg-was", fmt(c.from));
      span("chg-to", "→");
      el.num = span("chg-num", fmt(c.from));
      span("chg-unit", "cm");
    } else if (c.kind === "move") {
      el.arrow = span("chg-arrow", "➜");
      el.num = span("chg-num", "+0");
      span("chg-unit", "cm");
    } else {
      span("chg-sign", c.kind === "add" ? "+" : c.kind === "remove" ? "−" : "⇄");
      span("chg-name", c.text);
    }
    layer.appendChild(root);
    return el;
  });
  host.appendChild(layer);
  return { layer, els };
}

// 세로·가로 시야각 중 좁은 쪽의 절반(rad).
function narrowHalf(cam: THREE.PerspectiveCamera) {
  const half = THREE.MathUtils.degToRad(cam.fov / 2);
  return Math.min(half, Math.atan(Math.tan(half) * cam.aspect));
}

// ---------- 본체 ----------

export default function ChangeScene({ view, style }: { scene: Scene; style: RenderStyle; view: CompareView | null }) {
  if (!view) return null;
  // 수정안마다 새로 만든다(대역·상태·말풍선).
  return <Player key={view.cmp.proposal.id} view={view} style={style} />;
}

function Player({ view, style }: { view: CompareView; style: RenderStyle }) {
  const { camera, controls, gl } = useThree();
  const { plan, cmp } = view;
  const { items, callouts } = plan;
  const step: Step = view.scene.steps[view.stepIndex];
  const pose = poses(view.scene);
  const rot = pose[step.pose].rot;
  const rootPos = add(pose[step.pose].pos, step.unit_offset ?? [0, 0, 0]);
  const up = useMemo(() => new THREE.Vector3(0, 1, 0).applyAxisAngle(X_AXIS, -rot).toArray() as Vec3, [rot]);
  const wallUp: Vec3 = [0, 1, 0];

  const st = useMemo(() => ({
    items: items.map((): ItemState => ({ k: 0, rm: 0, ad: 0, pulse: 0, ghost: 0, glow: 0, dust: 0 })),
    calls: callouts.map((c): CallState => ({ a: 0, n: c.kind === "dim" ? c.from : 0 })),
  }), [items, callouts]);
  const anchors = useRef<(THREE.Object3D | null)[]>([]);
  const dom = useRef<ReturnType<typeof buildCallouts> | null>(null);
  const before = useRef(false);

  useEffect(() => {
    const host = gl.domElement.parentElement;
    if (!host) return;
    dom.current = buildCallouts(host, callouts);
    return () => { dom.current?.layer.remove(); dom.current = null; };
  }, [gl, callouts]);

  // 바뀐 곳(또는 카드에서 고른 줄)을 감싸는 구로 카메라를 옮긴다.
  const frame = (only?: number) => {
    const world = stepWorld(view.scene, step);
    const chosen = items.filter((it) => only === undefined || it.entry === only);
    const pick = chosen.length ? chosen : items;
    const pts: THREE.Vector3[] = [];
    for (const it of pick) {
      if (it.kind === "panel") {
        for (const [p, s] of [[it.pos0, it.size0], [it.pos1, it.size1]] as [Vec3, Vec3][]) {
          for (const c of [[-1, -1, -1], [1, 1, 1], [-1, 1, 1], [1, -1, -1]]) pts.push(new THREE.Vector3(...world(add(p, s.map((v, k) => v * c[k] / 2) as Vec3), false)));
        }
      } else {
        for (const p of [it.pos0, it.pos1]) pts.push(new THREE.Vector3(...world(p, it.onWall)));
      }
    }
    if (!pts.length) return null;
    const sphere = new THREE.Box3().setFromPoints(pts).getBoundingSphere(new THREE.Sphere());
    // 바뀐 곳이 가구 뒤쪽이면 앞쪽 판이 화면을 다 덮으므로, 가구 가운데 쪽으로 조금 당기고 가구 일부가 함께 보이게 한다.
    const unit = new THREE.Vector3(...world([0, view.scene.size[1] / 2, 0], false));
    const unitRadius = Math.hypot(...view.scene.size) / 2;
    const pull = Math.min(0.4, sphere.center.distanceTo(unit) / unitRadius * 0.4);
    sphere.center.lerp(unit, pull);
    const cam = camera as THREE.PerspectiveCamera;
    const radius = Math.max(sphere.radius, unitRadius * pull * 1.6, 6);
    // 말풍선·검토 막대가 들어갈 여유를 두고 화면 좁은 쪽에 맞춘다.
    // 가구 앞쪽 모서리가 화면을 덮지 않게, 가구 전체를 담는 거리의 일부(판이 바뀌면 더 멀리)보다는 가까이 가지 않는다.
    const sin = Math.sin(narrowHalf(cam));
    const whole = unitRadius / sin + sphere.center.distanceTo(unit);
    const keep = pick.some((it) => it.kind === "panel") ? 1.15 : 0.85;
    const distance = Math.min(CAM_MAX, Math.max(CAM_MIN, (radius * 1.35) / sin, whole * keep));
    // 누운 가구는 칸 입구가 위를 보므로 평소보다 높이서 내려다봐야 안쪽 판·철물이 옆판에 가리지 않는다.
    const dir = step.pose === "upright" ? FRONT_DIRECTION : LYING_DIRECTION;
    const target = sphere.center;
    const position = target.clone().addScaledVector(dir, distance);
    const orbit = controls as unknown as OrbitControlsImpl | null;
    gsap.killTweensOf(camera.position);
    if (orbit) gsap.killTweensOf(orbit.target);
    const tl = gsap.timeline({ onUpdate: () => orbit?.update() });
    tl.to(camera.position, { x: position.x, y: position.y, z: position.z, duration: T.cam, ease: "power2.inOut" }, 0);
    if (orbit) tl.to(orbit.target, { x: target.x, y: target.y, z: target.z, duration: T.cam, ease: "power2.inOut" }, 0);
    return tl;
  };

  // 재생: playKey가 바뀌거나 Before/After를 바꿀 때마다 처음부터.
  useEffect(() => {
    const tl = gsap.timeline();
    const cam = frame(cmp.focus?.entry);
    if (cam) tl.add(cam, 0);
    const toBefore = cmp.mode === "before";
    before.current = toBefore;
    dom.current?.layer.classList.toggle("chg-before", toBefore);
    const C = T.change;
    if (!toBefore) {
      // 1. Before 박자: 카메라가 바뀐 곳을 담는 동안 바뀔 부품이 숨 쉬듯 테두리를 띄운다.
      items.forEach((it, i) => {
        const s = st.items[i];
        beforeState(s);
        s.pulse = 0;
        tl.to(s, { pulse: 1, duration: 0.35, ease: "power2.out" }, 0.05);
        // 2. 변하기
        if (it.mode === "resized" || it.mode === "moved") {
          tl.to(s, { k: 1, duration: T.morph, ease: "power3.inOut" }, C);
          tl.to(s, { ghost: 1, duration: 0.35, ease: "power1.out" }, C);
        }
        if (it.mode === "removed" || it.mode === "swapped") {
          tl.to(s, { rm: 1, duration: T.remove, ease: "none" }, C);
          tl.to(s, { dust: 1, duration: 0.8, ease: "power2.out" }, C + 0.5);
          tl.to(s, { ghost: 1, duration: 0.5, ease: "power1.out" }, C + 0.95);
        }
        if (it.mode === "added" || it.mode === "swapped") {
          const at = C + (it.mode === "swapped" ? 0.55 : T.dropAt);
          tl.set(s, { glow: 1 }, at);
          tl.to(s, { ad: 1, duration: T.drop, ease: "back.out(2.2)" }, at);
          tl.to(s, { glow: 0.35, duration: 0.6, ease: "power2.inOut" }, at + T.drop);
        }
        // 3. 자리 잡기: 테두리는 옅게 남기고 옛 모습은 그대로 둔다.
        tl.to(s, { pulse: 0.3, duration: 0.6, ease: "power2.inOut" }, T.settle);
      });
      callouts.forEach((c, i) => {
        const s = st.calls[i];
        s.a = 0;
        s.n = c.kind === "dim" ? c.from : 0;
        const show = c.kind === "add" ? C + T.dropAt + 0.2 : c.kind === "remove" ? C + 0.15 : C - 0.1;
        tl.to(s, { a: 1, duration: 0.4, ease: "back.out(2.4)" }, show);
        if (c.kind === "dim") tl.to(s, { n: c.to, duration: T.morph, ease: "power3.inOut" }, C);
        if (c.kind === "move") tl.to(s, { n: c.dist, duration: T.morph, ease: "power3.inOut" }, C);
      });
    } else {
      // Before: After 모습에서 빠르게 되돌린 뒤, 바뀔 부품에 테두리를 남긴다.
      items.forEach((it, i) => {
        const s = st.items[i];
        afterState(s, it);
        s.pulse = 0.3;
        tl.to(s, { pulse: 1, duration: 0.25, ease: "power2.out" }, 0);
        tl.to(s, { k: 0, ghost: it.mode === "added" ? 0.8 : 0, duration: T.back, ease: "power3.inOut" }, 0.1);
        tl.to(s, { rm: 0, dust: 0, duration: T.back * 0.8, ease: "power2.out" }, 0.1);
        tl.to(s, { ad: 0, glow: 0, duration: T.back * 0.6, ease: "power2.in" }, 0.1);
        tl.to(s, { pulse: 0.6, duration: 0.5, ease: "power2.inOut" }, 0.1 + T.back);
      });
      callouts.forEach((c, i) => {
        const s = st.calls[i];
        s.a = 1;
        s.n = c.kind === "dim" ? c.to : c.kind === "move" ? c.dist : 0;
        if (c.kind === "dim") tl.to(s, { n: c.from, duration: T.back, ease: "power3.inOut" }, 0.1);
        if (c.kind === "move") tl.to(s, { a: 0, n: 0, duration: T.back * 0.6, ease: "power2.in" }, 0.1);
      });
    }
    return () => { tl.kill(); };
  }, [cmp.mode, cmp.playKey, st]); // eslint-disable-line react-hooks/exhaustive-deps

  // 카드에서 줄을 누르면 그 항목으로 카메라를 옮기고 그 부품만 한 번 더 숨 쉬게 한다.
  useEffect(() => {
    if (!cmp.focus) return;
    const tl = gsap.timeline();
    const cam = frame(cmp.focus.entry);
    if (cam) tl.add(cam, 0);
    items.forEach((it, i) => {
      if (it.entry !== cmp.focus!.entry) return;
      tl.fromTo(st.items[i], { pulse: 1 }, { pulse: before.current ? 0.6 : 0.3, duration: 1.4, ease: "power2.inOut" }, 0);
    });
    return () => { tl.kill(); };
  }, [cmp.focus?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  const v = useMemo(() => new THREE.Vector3(), []);
  const w = useMemo(() => new THREE.Vector3(), []);
  const root = useRef<THREE.Group>(null);
  useFrame(({ size }) => {
    const d = dom.current;
    if (!d) return;
    callouts.forEach((c, i) => {
      const el = d.els[i], s = st.calls[i], a = anchors.current[c.item];
      if (!a) return;
      a.getWorldPosition(v).project(camera);
      const x = ((v.x + 1) / 2) * size.width, y = ((1 - v.y) / 2) * size.height;
      const sc = 0.75 + 0.25 * s.a;
      el.root.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, calc(-100% - 16px)) scale(${sc.toFixed(3)})`;
      el.root.style.opacity = clamp01(s.a).toFixed(3);
      el.root.style.visibility = v.z < 1 && s.a > 0.01 ? "visible" : "hidden";
      if (el.num) {
        const text = c.kind === "move" ? `+${fmt(s.n)}` : fmt(s.n);
        if (text !== el.last) { el.num.textContent = text; el.last = text; }
      }
      if (c.kind === "move" && el.arrow && root.current) {
        // 옮겨 가는 방향을 화면에 투영해 화살표를 돌린다.
        const it = items[c.item];
        const parent = a.parent ?? root.current;
        parent.localToWorld(w.set(...it.pos0)).project(camera);
        const x0 = ((w.x + 1) / 2) * size.width, y0 = ((1 - w.y) / 2) * size.height;
        parent.localToWorld(w.set(...it.pos1)).project(camera);
        const x1 = ((w.x + 1) / 2) * size.width, y1 = ((1 - w.y) / 2) * size.height;
        el.arrow.style.transform = `rotate(${Math.atan2(y1 - y0, x1 - x0).toFixed(3)}rad)`;
      }
    });
  });

  const proxy = (it: Item, i: number, upv: Vec3) => {
    const props = { item: it, st: st.items[i], style, up: upv, anchor: (g: THREE.Object3D | null) => { anchors.current[i] = g; } };
    return it.kind === "panel" ? <PanelProxy key={it.id} {...props} /> : <SmallProxy key={it.id} {...props} />;
  };
  return (
    <>
      <group ref={root} rotation={[rot, 0, 0]} position={rootPos}>
        {items.map((it, i) => (it.onWall ? null : proxy(it, i, up)))}
      </group>
      {/* 벽 철물은 Assembly처럼 세운 자세 기준 좌표에 둔다. */}
      <group position={pose.upright.pos}>
        {items.map((it, i) => (it.onWall ? proxy(it, i, wallUp) : null))}
      </group>
    </>
  );
}
