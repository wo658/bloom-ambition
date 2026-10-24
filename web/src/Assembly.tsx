import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { Edges, Outlines } from "@react-three/drei";
import gsap from "gsap";
import * as THREE from "three";
import { StraightArrow, TurnArrow } from "./Arrows";
import { CameraShake, ImpactFx, fxBus, hammerPose, popBadge, spinPose, type FxHandle } from "./fx";
import { HardwareMesh, METAL, SPINS, TOOLS, orientation } from "./Hardware";
import type { MotionTarget } from "./bridge";
import { mentionPart, partTag, smallTag, useTaggedParts, type PartTag } from "./partTags";
import type { HardwareSpec, Scene, SmallPart, Step, Vec3 } from "./types";
import { oakMaps, woodBox } from "./wood";
import { RoomDecor, RoomShell, ShelfDecor, WallShade } from "./Room";

export const HIGHLIGHT = "#ff7a1a";
// 채팅 입력창에 태그된 부품. 지금 단계 강조(주황)와 헷갈리지 않게 파란색으로 칠한다.
export const TAGGED = "#2563eb";

// 도면: IKEA 설명서처럼 흰 면 + 굵은 외곽선, 툰: 흰 면에 계단식 음영, 컬러: 오일 마감 원목.
export type RenderStyle = "technical" | "toon" | "color";
const BOARD: Record<RenderStyle, string> = { technical: "#ffffff", toon: "#ffffff", color: "#ffffff" };
export const EDGE: Record<RenderStyle, string> = { technical: "#1f1f1f", toon: "#4b4b4b", color: "#7a5532" };

// ghost: 부품 모션을 보여 주는 동안 주인공이 아닌 판을 반투명하게 흐린다.
// 투시(see)면 판을 반투명하게 그리고 깊이를 쓰지 않아, 판 안쪽의 나무못·볼트가 비쳐 보인다.
export function Material({ style, color, wood, ghost, see = 0 }: { style: RenderStyle; color: string; wood?: boolean; ghost?: boolean; see?: number }) {
  // 둘 다 켜지면 더 옅은 쪽을 쓴다.
  const opacity = ghost ? Math.min(GHOST_OPACITY, see || 1) : see;
  const glass = opacity ? { transparent: true, opacity, depthWrite: false } : {};
  // 텍스처·투명 여부가 바뀌면 셰이더를 다시 만들어야 해서 key로 재질을 새로 만든다.
  const key = `${style}-${wood ? "wood" : "plain"}-${opacity}`;
  if (style === "technical") return <meshBasicMaterial key={key} color={color} {...glass} />;
  if (style === "toon") return <meshToonMaterial key={key} color={color} {...glass} />;
  if (wood) return <meshStandardMaterial key={key} color={color} {...oakMaps()} normalScale={[0.6, 0.6]} roughness={1} metalness={0} {...glass} />;
  return <meshStandardMaterial key={key} color={color} roughness={0.8} metalness={0} {...glass} />;
}
const GHOST_OPACITY = 0.35;
const SMALL_TRAVEL = 8;
const SCREW_TURNS = 4;
const MAGNIFY = 1.8; // 지금 단계의 작은 부품은 이만큼 크게 그렸다가 자리에 들어가면 원래 크기로 돌아온다
const HAMMER_TAPS = 3;
const GHOST_LAG = 0.014; // 렌치 잔상 사이 간격(공구 동작 진행 몫)
const FLASH_WHITE = new THREE.Color("#fff4cc");
const UP = new THREE.Vector3();
const Q = new THREE.Quaternion();
const DROP_AT = 0.7; // 걸고 내리는 부품이 내려앉기 시작하는 진행률
const ARROW_GAP = 1.5;

// 단계 시간표(초). 판이 먼저 들어오고 철물이 하나씩 이어진다.
// 나무못은 먼저 박고 그 위에 판을 끼우므로 순서가 반대다.
const LEAD = 0.3;
const PANEL_TIME = 1.2;
const TOOL_TIME = 1.1; // 공구로 조이거나 두드리는 부품 하나
const PLAIN_TIME = 0.6; // 손으로 붙이는 부품 하나
const PLAIN_STAGGER = 0.3;
const DRILL_TIME = 2.0; // 드릴로 벽에 구멍 하나 뚫기

type Slot = { start: number; dur: number };
type Schedule = { panels: Slot | null; parts: Slot[]; total: number };

export function schedule(step: Step): Schedule {
  const hasPanels = step.adds.length > 0 || (step.reseat?.length ?? 0) > 0;
  const dowelsFirst = step.small.some((s) => s.model === "dowel");
  let cursor = LEAD;
  let panels: Slot | null = null;
  const placePanels = () => {
    if (!hasPanels) return;
    panels = { start: cursor, dur: PANEL_TIME };
    cursor += PANEL_TIME;
  };
  if (!dowelsFirst) placePanels();
  let end = cursor;
  const parts = step.small.map((s) => {
    // 걸고 내리는 부품은 두 동작이라 공구 쓰는 부품만큼 시간을 준다.
    // 벽 나사는 손으로 돌려 박아도 하나씩 차례로 박는다(카메라가 자리마다 따라간다).
    const oneByOne = !!s.tool || s.model === "wall_screw";
    const dur = s.model === "wall_hole" ? DRILL_TIME : oneByOne || s.drop ? TOOL_TIME : PLAIN_TIME;
    const slot = { start: cursor, dur };
    cursor += oneByOne ? dur : PLAIN_STAGGER;
    end = Math.max(end, slot.start + dur);
    return slot;
  });
  cursor = end;
  if (dowelsFirst) placePanels();
  return { panels, parts, total: Math.max(cursor, LEAD + PANEL_TIME) };
}

export function stepDuration(step: Step) {
  return schedule(step).total;
}

// 부품 모션의 시간표(실제 초). 카메라가 다가갈 동안(delay) 멈춰 있다가, 주인공 부품이 들어가는 구간만 느리게(rate) 틀고
// 나머지는 원래 빠르기로 잇는다. focusEnd는 주인공 동작이 끝나 카메라가 단계 전체로 물러날 때, total은 애니메이션이 끝나는 때.
const MOTION_DELAY = 1.1;
const MOTION_RATE = { hardware: 0.35, panel: 0.7 };
const MOTION_SLOW_MAX = 4; // 느린 구간이 이보다 길어지지 않게(같은 철물 여러 개를 한꺼번에 보일 때)
export type MotionTiming = { delay: number; from: number; to: number; rate: number; focusEnd: number; total: number };
export function motionTiming(step: Step, target: MotionTarget): MotionTiming {
  const plan = schedule(step);
  const spot = spotlightOf(step, { target, label: "" })!;
  const slots = target.kind === "panel" ? (plan.panels ? [plan.panels] : [])
    : step.small.flatMap((s, i) => (spot.smalls.has(s.id) ? [plan.parts[i]] : []));
  if (!slots.length) return { delay: MOTION_DELAY, from: 0, to: 0, rate: 1, focusEnd: MOTION_DELAY, total: MOTION_DELAY + plan.total };
  const from = Math.min(...slots.map((s) => s.start));
  const to = Math.max(...slots.map((s) => s.start + s.dur));
  const rate = Math.max(MOTION_RATE[target.kind], (to - from) / MOTION_SLOW_MAX);
  const slowEnd = MOTION_DELAY + from + (to - from) / rate;
  return { delay: MOTION_DELAY, from, to, rate, focusEnd: slowEnd + 0.4, total: slowEnd + plan.total - to };
}

// 단계 시작부터 지난 시간(초). GSAP이 값을 올리고 메쉬는 매 프레임 읽는다.
type Clock = { current: { time: number } };

function local(slot: Slot | null, time: number) {
  if (!slot) return 1;
  return Math.min(1, Math.max(0, (time - slot.start) / slot.dur));
}
const ease = (u: number) => (u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2);

function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
const add = (a: Vec3, b: Vec3, k = 1): Vec3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const norm = (v: Vec3) => Math.hypot(...v);

// 3D 부품을 누르면 채팅에 태그한다. 가장 가까운 것 하나만 받고, 화면을 돌리려던 드래그는 무시한다.
export function pickHandlers(onPick?: () => void) {
  if (!onPick) return {};
  return {
    onClick: (e: ThreeEvent<MouseEvent>) => {
      e.stopPropagation();
      if (e.delta > 4) return;
      onPick();
    },
    onPointerOver: (e: ThreeEvent<PointerEvent>) => { e.stopPropagation(); document.body.style.cursor = "pointer"; },
    onPointerOut: (e: ThreeEvent<PointerEvent>) => { e.stopPropagation(); document.body.style.cursor = ""; },
  };
}

// 태그된 부품 위에 뜨는 이름표. 부모(움직이는 부품 그룹)의 원점을 매 프레임 화면 좌표로 옮겨 따라간다.
// drei Html은 React 19에서 언마운트할 때 removeChild 오류를 내서, 캔버스 옆에 DOM을 직접 붙인다.
// motion: 부품 모션의 주인공 이름표라 깜빡이며 눈에 띄게 한다.
// elRef: 부품 쪽에서 이름표를 톡 튀게 할 때(fx.popBadge) 쓰는 DOM.
export function TagBadge({ label, motion, elRef }: { label: string; motion?: boolean; elRef?: React.RefObject<HTMLDivElement | null> }) {
  const anchor = useRef<THREE.Group>(null);
  const gl = useThree((s) => s.gl);
  const el = useMemo(() => {
    const d = document.createElement("div");
    d.className = "tag-badge";
    return d;
  }, []);
  useEffect(() => {
    if (!elRef) return;
    elRef.current = el;
    return () => { elRef.current = null; };
  }, [el, elRef]);
  useEffect(() => { el.textContent = `@${label}`; }, [el, label]);
  useEffect(() => { el.classList.toggle("motion", !!motion); }, [el, motion]);
  useEffect(() => {
    const host = gl.domElement.parentElement;
    host?.appendChild(el);
    return () => el.remove();
  }, [gl, el]);
  const v = useMemo(() => new THREE.Vector3(), []);
  useFrame(({ camera, size }) => {
    if (!anchor.current) return;
    anchor.current.getWorldPosition(v).project(camera);
    el.style.transform = `translate(${((v.x + 1) / 2) * size.width}px, ${((1 - v.y) / 2) * size.height}px) translate(-50%, calc(-100% - 10px))`;
    el.style.visibility = v.z < 1 ? "visible" : "hidden";
  });
  return <group ref={anchor} />;
}

// 입력창의 태그를 판재 id·철물 하나(small id)·철물 종류(part_id)별로 나눈다.
type Tagged = { panels: Map<string, string>; instances: Map<string, string>; kinds: Set<string> };
function splitTags(tags: PartTag[]): Tagged {
  const t: Tagged = { panels: new Map(), instances: new Map(), kinds: new Set() };
  for (const tag of tags) {
    if (tag.kind === "panel") t.panels.set(tag.id, tag.label);
    else if (tag.instance) t.instances.set(tag.instance, tag.label);
    else t.kinds.add(tag.id);
  }
  return t;
}

// 부품 모션의 주인공. 철물 종류면 이름표는 그 단계의 첫 번째 것 위에만 띄운다.
export type Spotlight = { target: MotionTarget; label: string };
function spotlightOf(step: Step, spot: Spotlight | null | undefined) {
  if (!spot) return null;
  const { target, label } = spot;
  if (target.kind === "panel") return { panel: target.id, label, smalls: new Set<string>(), badgeAt: null };
  const smalls = new Set(step.small
    .filter((s) => (target.instance ? s.id === target.instance : s.part_id === target.id))
    .map((s) => s.id));
  // 그 하나가 이 단계에 없으면(채팅이 고친 경우 등) 같은 종류 전체로 넓힌다.
  if (!smalls.size) step.small.filter((s) => s.part_id === target.id).forEach((s) => smalls.add(s.id));
  return { panel: null, label, smalls, badgeAt: smalls.values().next().value ?? null };
}

// 단계가 바뀌어 누를 수 있던 부품이 사라져도 손가락 커서가 남지 않게 한다.
export function useResetCursor() {
  useEffect(() => () => { document.body.style.cursor = ""; }, []);
}

function Board({ id, size, pos, from, mode, slot, clock, reseatRatio, style, xray, tag, motion, ghost, onPick }: {
  id: string; size: Vec3; pos: Vec3; from: Vec3; mode: "add" | "reseat" | "placed"; slot: Slot | null;
  clock: Clock; reseatRatio: number; style: RenderStyle; xray: boolean; tag?: string; motion?: boolean; ghost?: boolean; onPick?: () => void;
}) {
  const ref = useRef<THREE.Mesh>(null);
  const arrow = useRef<THREE.Group>(null);
  const geometry = useMemo(() => woodBox(size, id), [size, id]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  const active = mode !== "placed";
  const offset: Vec3 = mode === "reseat" ? [from[0] * reseatRatio, from[1] * reseatRatio, from[2] * reseatRatio] : from;
  const start = add(pos, offset);
  // 화살표는 판이 들어오는 길 위에서 도착 지점을 가리킨다.
  const out = norm(from) > 0 ? (from.map((c) => c / norm(from)) as Vec3) : ([0, 1, 0] as Vec3);
  const reach = Math.max(norm(offset), 20);
  useFrame(() => {
    const u = active ? ease(local(slot, clock.current.time)) : 1;
    ref.current?.position.set(...lerp(start, pos, u));
    const raw = active ? local(slot, clock.current.time) : 1;
    if (arrow.current) arrow.current.visible = active && raw < 1;
  });
  return (
    <>
      <mesh ref={ref} geometry={geometry} position={active ? start : pos} castShadow={!xray} receiveShadow={!xray}
        {...pickHandlers(onPick)}>
        {/* 태그된 판은 지금 단계 강조보다 먼저 파랗게 칠한다. 투시 중에는 강조된 판을 조금 덜 비치게 한다. */}
        <Material style={style} color={tag ? TAGGED : active ? HIGHLIGHT : BOARD[style]} wood={!active && !tag} ghost={ghost}
          see={xray ? (active || tag ? 0.45 : 0.2) : 0} />
        <Edges color={tag ? "#1e3a8a" : active ? "#7a2e00" : EDGE[style]} lineWidth={style === "technical" ? 2 : 1} />
        {(active || tag) && <Outlines thickness={motion ? 5 : 3} color={tag ? TAGGED : HIGHLIGHT} />}
        {tag && <TagBadge label={tag} motion={motion} />}
      </mesh>
      {active && <StraightArrow ref={arrow} tail={add(pos, out, reach + 12)} head={add(pos, out, reach * 0.35)} width={5} />}
    </>
  );
}

function hardwareMaterial(style: RenderStyle, color: string, metal: boolean, active: boolean, embed = false) {
  // 현재 단계 부품은 판에 가려져도 보이도록 깊이 테스트를 끄고 맨 위에 그린다.
  // 벽에 박히는 것(벽 나사, 드릴 날)은 깊이 테스트를 켜 두어 벽 속으로 들어간 만큼 가려지게 한다.
  const common = { color, depthTest: !active || embed, transparent: active, side: THREE.DoubleSide };
  if (style === "technical") return new THREE.MeshBasicMaterial(common);
  if (style === "toon") return new THREE.MeshToonMaterial(common);
  return new THREE.MeshStandardMaterial({ ...common, metalness: metal ? 0.7 : 0, roughness: metal ? 0.35 : 0.8 });
}

// 드릴 동작(a: 0→1): 날 끝을 벽에 대고(~APPROACH), 밀어 넣으며 뚫은 뒤(~RETRACT) 빼낸다.
const DRILL_APPROACH = 0.15;
const DRILL_RETRACT = 0.8;
const DRILL_STANDOFF = 5; // 드릴이 다가오기 시작하는 벽과의 거리
const DRILL_TURNS = 30;
const DUST = Array.from({ length: 10 }, (_, i) => ({ phase: i / 10, x: Math.sin(i * 12.9898) * 0.5, drift: 0.6 + (i % 3) * 0.3 }));
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
function drillMotion(a: number, depth: number) {
  const bore = clamp01((a - DRILL_APPROACH) / (DRILL_RETRACT - DRILL_APPROACH));
  const y = a < DRILL_APPROACH ? -DRILL_STANDOFF * (1 - ease(a / DRILL_APPROACH))
    : a < DRILL_RETRACT ? bore * depth
    : depth - (depth + DRILL_STANDOFF) * ease((a - DRILL_RETRACT) / (1 - DRILL_RETRACT));
  return { bore, y, cutting: a > DRILL_APPROACH && a < DRILL_RETRACT };
}

// 공구가 닿는 곳(부품 로컬 Y). 나사·볼트는 머리 윗면, 나무못은 뒤쪽 끝, 벽 나사는 벽에서 나온 머리.
function contactY(part: SmallPart) {
  const d = part.dims;
  if (part.model === "dowel") return -d.length / 2;
  if (part.model === "wall_screw") return -(d.protrude ?? 0.8) - d.head_h;
  return 0;
}

// 연필로 십자 긋기(a: 0→1). 내려와서 가로 획, 살짝 들어 옮긴 뒤 세로 획, 다 그으면 들어 올린다.
// strokes는 획별 진행(0→1), tip은 표시 크기 1 기준 심 끝 위치(x, z), lift는 벽에서 뗀 거리(cm).
function markStroke(a: number) {
  const k = (from: number, to: number) => Math.min(1, Math.max(0, (a - from) / (to - from)));
  const p1 = k(0.15, 0.5), hop = k(0.5, 0.58), p2 = k(0.58, 0.9);
  const tip: [number, number] = a < 0.5 ? [-0.5 + p1, 0] : a < 0.58 ? [0.5 - 0.5 * hop, 0.5 * hop] : [0, 0.5 - p2];
  const lift = 4 * (1 - k(0, 0.15)) + 0.8 * Math.sin(Math.PI * hop) + 4 * k(0.9, 1);
  return { strokes: [p1, p2], tip, lift };
}

// 공구를 부품 로컬 좌표(접점이 원점, +Y가 박히는 방향)에 맞춰 놓는다.
function ToolPose({ tool, children }: { tool: HardwareSpec; children: React.ReactNode }) {
  if (tool.model === "hex_key") {
    // 짧은 팔을 육각 홈에 꽂고 긴 팔은 옆으로 뻗는다.
    return <group position={[0, -(tool.dims.short - 0.3), 0]} rotation={[0, 0, Math.PI / 2]}>{children}</group>;
  }
  if (tool.model === "pencil") {
    // 설명서 그림처럼 손에 쥔 듯 비스듬히 눕혀 심 끝만 벽에 닿게 한다.
    return <group rotation={[-0.35, 0, 0.6]}>{children}</group>;
  }
  return <>{children}</>;
}

// tagged: 태그된 철물이라 파랗게 칠한다. badge: 이 하나만 태그됐을 때 위에 띄울 이름.
function Small({ part, slot, active, clock, style, tool, tagged, badge, motion, onPick }: {
  part: SmallPart; slot: Slot | null; active: boolean; clock: Clock; style: RenderStyle; tool?: HardwareSpec;
  tagged?: boolean; badge?: string; motion?: boolean; onPick?: () => void;
}) {
  const ref = useRef<THREE.Group>(null);
  const scaler = useRef<THREE.Group>(null);
  const spinner = useRef<THREE.Group>(null);
  const toolRef = useRef<THREE.Group>(null);
  const toolSpin = useRef<THREE.Group>(null);
  const toolSwing = useRef<THREE.Group>(null);
  const ghosts = useRef<(THREE.Group | null)[]>([]);
  const pathArrow = useRef<THREE.Group>(null);
  const dust = useRef<THREE.Group>(null);
  const turnArrow = useRef<THREE.Group>(null);
  const fx = useRef<FxHandle>(null);
  const badgeEl = useRef<HTMLDivElement | null>(null);
  // 지난 프레임의 타격 횟수·딸깍·자리 잡음. 이번 프레임에 새로 넘어선 순간에만 효과를 터뜨린다(u < 0: 첫 프레임).
  const fired = useRef({ u: -1, impacts: 0, clicked: false, seated: false });
  const quaternion = useMemo(() => orientation(part.axis, part.up), [part.axis, part.up]);
  const metal = METAL.includes(part.model);
  const spins = SPINS.includes(part.model);
  const color = tagged ? TAGGED : active ? HIGHLIGHT : style === "technical" ? (metal ? "#b5b5b5" : "#e2e2e2") : part.color;
  // 태그된 철물은 판 속에 박혀 있어도 보이게 지금 단계 부품처럼 맨 위에 그린다.
  const front = active || !!tagged;
  // 벽 나사는 벽 속으로, 드릴 날은 뚫는 구멍 속으로 들어가며 가려진다.
  const embed = part.model === "wall_screw";
  const drilling = part.model === "wall_hole";
  const material = useMemo(() => hardwareMaterial(style, color, metal, front, embed), [style, color, metal, front, embed]);
  const accent = useMemo(() => hardwareMaterial(style, "#2b2b2b", false, front, embed), [style, front, embed]);
  // 공구는 금속 반사 없이 제 색으로 칠해 화살표·판과 구분되게 한다.
  const toolMaterial = useMemo(() => hardwareMaterial(style, tool?.color ?? "#666", false, true, drilling), [style, tool, drilling]);
  const toolAccent = useMemo(() => hardwareMaterial(style, "#3a3a3a", false, true, drilling), [style, drilling]);
  useEffect(() => () => { material.dispose(); accent.dispose(); toolMaterial.dispose(); toolAccent.dispose(); },
    [material, accent, toolMaterial, toolAccent]);
  const baseColor = useMemo(() => new THREE.Color(color), [color]);

  // 연출: 공구로 넣는 지금 단계 부품에만. 부품 모션의 주인공(motion)이면 크고 느리게, 평소 재생은 작고 짧게.
  const hammering = part.model === "dowel" && !!tool;
  // 드릴로 구멍 뚫기는 자체 연출(떨림·가루)이 있어 타격·딸깍 효과를 붙이지 않는다.
  const fxOn = active && !!tool && part.model !== "wall_mark" && part.model !== "wall_hole";
  const loud = !!motion;
  const power = loud ? 1 : 0.5;
  // 망치는 자루 끝(손목)을 축으로 젖혔다 내려친다.
  const wrist: Vec3 = tool?.model === "hammer" ? [tool.dims.handle, -tool.dims.head * 0.45, 0] : [0, 0, 0];
  // 육각 렌치가 빠르게 돌 때 뒤따르는 잔상(뒤로 갈수록 옅다).
  const ghostCount = fxOn && tool?.model === "hex_key" ? (loud ? 4 : 2) : 0;
  const ghostMaterials = useMemo(() => Array.from({ length: ghostCount }, () => new THREE.MeshBasicMaterial({
    color: tool?.color ?? "#666", transparent: true, opacity: 0, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
  })), [ghostCount, tool]);
  useEffect(() => () => ghostMaterials.forEach((m) => m.dispose()), [ghostMaterials]);

  const mark = part.model === "wall_mark";
  const hole = part.model === "wall_hole";
  // 공구(수평계)는 원래 커서 키우지 않는다. 구멍은 벽에 뚫리는 크기 그대로 보여 준다.
  const magnify = !TOOLS.includes(part.model) && !hole;
  const length = part.dims.length ?? 2;
  const travel = mark || hole ? 0 : part.travel ?? Math.max(SMALL_TRAVEL, length + 2);
  const dir = part.approach ?? part.axis;
  // drop이 있으면 그만큼 위(hang)로 들어온 뒤 제자리로 내려앉는다.
  const hang = add(part.at, [0, part.drop ?? 0, 0]);
  const start = add(hang, dir, -travel);
  // 공구를 쓰면 손으로 반쯤 넣은 다음(pre) 공구로 끝까지 넣는다.
  const pre = tool ? add(part.at, dir, -Math.min(travel, length * 0.5)) : part.at;
  const handEnd = tool ? (travel > 1 ? 0.35 : 0.1) : 1;
  // 다가오는 방향을 부품 로컬로 옮긴 것(화살표용). 옆으로 비켜서 부품을 가리지 않게 한다.
  const localDir = useMemo(() => {
    const v = new THREE.Vector3(...dir).applyQuaternion(quaternion.clone().invert());
    return v.toArray() as Vec3;
  }, [dir, quaternion]);
  const side = Math.max(part.dims.head_d ?? part.dims.d ?? part.dims.r ?? part.dims.width ?? 1, 1) * MAGNIFY / 2 + ARROW_GAP;
  const sideAxis: Vec3 = Math.abs(localDir[0]) > 0.9 ? [0, 0, 1] : [1, 0, 0];
  const arrowLen = Math.min(Math.max(travel, 4), 10);
  const arrowWidth = Math.max(arrowLen * 0.22, 1.2);
  const arrowTail = add(add([0, 0, 0], sideAxis, side), localDir, -arrowLen - 1);
  const arrowHead = add(add([0, 0, 0], sideAxis, side), localDir, -1);
  const contact = contactY(part);
  // 육각 렌치는 부품처럼 크게 그린다. 망치·드라이버·연필은 원래 커서 그대로 둔다.
  const toolScale = tool?.model === "hex_key" ? MAGNIFY : 1;
  // 회전 화살표는 공구 손잡이를 감싸도록 반지름과 위치를 잡는다.
  const turn = tool?.model === "hex_key"
    ? { radius: tool.dims.long * toolScale * 0.55, y: contact - tool.dims.short * toolScale - 1 }
    : { radius: Math.max(2.5, (tool?.dims.grip_d ?? 2) * toolScale * 0.5 + 1), y: contact - 2 };

  useFrame(() => {
    if (!ref.current) return;
    const u = active ? local(slot, clock.current.time) : 1;
    // a: 공구 동작의 진행(0→1)
    const a = tool ? Math.max(0, (u - handEnd) / (1 - handEnd)) : 0;
    // 망치: 젖혔다 내려칠 때마다 한 번에 쑥 들어가고(처음이 가장 많이), 맞은 나무못은 눌렸다 튕긴다.
    // 렌치·드라이버: 빠르게 감다가 끝에서 느려지며 '딸깍' 하고 멈춘다.
    const hp = hammering ? hammerPose(a, HAMMER_TAPS, loud ? 0.2 : 0.1) : null;
    const sp = spins && tool ? spinPose(a) : null;
    const depth = hp ? hp.depth : sp ? sp.turns : a;
    const pos = part.drop
      ? (u < DROP_AT ? lerp(start, hang, ease(u / DROP_AT)) : lerp(hang, part.at, ease((u - DROP_AT) / (1 - DROP_AT))))
      : u < handEnd ? lerp(start, pre, ease(u / handEnd)) : lerp(pre, part.at, depth);
    ref.current.position.set(...pos);
    // 벽 나사는 차례가 오기 전에는 숨긴다(앞 구멍을 뚫는 드릴과 같은 자리에 떠 있지 않게).
    if (embed) ref.current.visible = !active || u > 0;
    const scale = !active || !magnify ? 1 : u < 0.85 ? MAGNIFY : MAGNIFY + (1 - MAGNIFY) * ease((u - 0.85) / 0.15);
    // 찌그러짐: 박히는 축(Y)으로 눌리면 옆으로 퍼진다. 부피가 대충 유지되게 옆은 절반만.
    const squash = hp ? hp.squash * (loud ? 0.3 : 0.16) : 0;
    scaler.current?.scale.set(scale * (1 + squash * 0.45), scale * (1 - squash), scale * (1 + squash * 0.45));
    if (fxOn) {
      // 맞은 순간·딸깍한 순간 부품이 하얗게 번쩍였다 돌아온다.
      const since = hp ? hp.since : sp && sp.clicked && a < 1 ? (a - 0.95) / 0.05 : -1;
      const flash = since >= 0 ? Math.exp(-(hp ? 9 : 4) * since) * (loud ? 0.85 : 0.55) : 0;
      (material as THREE.MeshBasicMaterial).color.lerpColors(baseColor, FLASH_WHITE, flash);
    }
    // 연필 표시는 심 끝이 지나간 만큼만 획이 그려진다.
    const draw = mark ? markStroke(active ? a : 1) : null;
    if (draw && spinner.current) {
      draw.strokes.forEach((p, i) => spinner.current!.children[i]?.scale.set(Math.max(p, 0.0001), 1, 1));
    }
    const drill = hole && active ? drillMotion(a, part.dims.depth ?? 3) : null;
    // 구멍은 날이 들어가는 만큼 벌어지고 가루가 둘레에 묻는다.
    if (drill) scaler.current?.scale.setScalar(drill.bore > 0 ? Math.min(1, 0.3 + drill.bore * 1.4) : 0.0001);
    if (dust.current) {
      dust.current.visible = !!drill?.cutting;
      // 뚫는 동안 구멍에서 가루가 나와 벽을 타고 떨어진다(로컬 -Y 앞, -Z 아래).
      dust.current.children.forEach((m, i) => {
        const { phase, x, drift } = DUST[i];
        const p = (a * 8 + phase) % 1;
        m.position.set(x * (0.4 + p), -0.3 - p * drift, -p * p * 4);
      });
    }
    // 나사류는 머리 쪽에서 볼 때 시계 방향(조이는 방향)으로 돈다.
    const turn = spins ? (sp ? sp.turns * SCREW_TURNS * Math.PI * 2 + sp.kick : ease(u) * SCREW_TURNS * Math.PI * 2) : 0;
    if (spinner.current) spinner.current.rotation.y = turn;
    const working = active && !!tool && u > handEnd * 0.5 && u < 1;
    if (toolRef.current) {
      toolRef.current.visible = working;
      if (draw) {
        // 심 끝을 획을 따라 옮긴다. 표시가 크게 그려져 있으면 그만큼 넓게 움직인다.
        const s = part.dims.size * scale;
        toolRef.current.position.set(draw.tip[0] * s, -draw.lift, draw.tip[1] * s);
      } else {
        toolRef.current.position.y = contact * scale;
      }
      if (drill) {
        // 드릴은 뚫는 동안 살짝 떨리고 날만 빠르게 돈다.
        toolRef.current.position.y = drill.y;
        toolRef.current.position.x = drill.cutting ? 0.06 * Math.sin(a * 400) : 0;
        const bit = toolRef.current.getObjectByName("drill-bit");
        if (bit) bit.rotation.y = drill.bore * DRILL_TURNS * Math.PI * 2;
      }
    }
    if (toolSpin.current) toolSpin.current.rotation.y = spins ? turn : 0;
    // 망치는 박는 축을 중심으로 돌려 자루가 위(월드 +Y)를 보게 한다. 바닥을 뚫고 내려가지 않고 손에 쥔 모습이 된다.
    if (tool?.model === "hammer" && working && toolRef.current && toolSpin.current) {
      const up = UP.set(0, 1, 0).applyQuaternion(toolRef.current.getWorldQuaternion(Q).invert());
      if (Math.hypot(up.x, up.z) > 0.2) toolSpin.current.rotation.y = Math.atan2(-up.z, up.x);
    }
    if (toolSwing.current) toolSwing.current.rotation.z = hp && working ? hp.angle : 0;
    // 잔상은 조금 앞선 시점의 각도에 놓는다. 빨리 돌수록 벌어지고, 느려지면 열쇠와 겹치므로 흐리게 지운다.
    ghosts.current.forEach((g, k) => {
      if (!g) return;
      const lagged = spinPose(a - (k + 1) * GHOST_LAG).turns * SCREW_TURNS * Math.PI * 2;
      const lead = turn - lagged;
      g.visible = working && a > 0 && a < 1 && lead > 0.05;
      g.rotation.y = lagged;
      ghostMaterials[k].opacity = (0.42 * (1 - k / (ghostCount + 0.5))) * Math.min(1, lead / (0.3 * (k + 1)));
    });
    if (pathArrow.current) pathArrow.current.visible = active && travel > 1 && u > 0 && u < Math.max(handEnd, 0.6);
    if (turnArrow.current) turnArrow.current.visible = working && spins && u > handEnd;

    // 넘어선 순간에만 터뜨린다. 처음 그린 프레임(이전 단계의 시계가 남아 있을 수 있다)과 다시 재생해 되감긴 경우는 건너뛴다.
    const was = fired.current;
    const impacts = hp?.impacts ?? 0, clicked = !!sp?.clicked, seated = u >= 1;
    if (fxOn && was.u >= 0 && u >= was.u) {
      if (impacts > was.impacts) {
        // 뒤로 갈수록 세게: 마지막 한 방이 가장 크다.
        const s = power * (0.75 + 0.35 * (impacts - 1) / Math.max(1, HAMMER_TAPS - 1));
        fx.current?.burst(s);
        if (loud) {
          fxBus.emit("impact", 0.35 + 0.25 * (impacts - 1) / Math.max(1, HAMMER_TAPS - 1));
          popBadge(badgeEl.current, false);
        }
      }
      if (clicked && !was.clicked) {
        fx.current?.click(power);
        if (loud) {
          fxBus.emit("impact", 0.3);
          popBadge(badgeEl.current, false);
        }
      }
      if (seated && !was.seated) {
        fx.current?.seat(power);
        if (loud) popBadge(badgeEl.current, true);
      }
    }
    fired.current = { u, impacts, clicked, seated };
  });
  const fxRadius = ((part.dims.head_d ?? part.dims.d ?? 1) / 2) * MAGNIFY;

  return (
    <>
      {/* 화살표는 도착 지점 기준으로 고정한다. */}
      {active && (
        <group position={part.at} quaternion={quaternion}>
          {travel > 1 && <StraightArrow ref={pathArrow} tail={arrowTail} head={arrowHead} width={arrowWidth} />}
          {spins && tool && (
            <TurnArrow ref={turnArrow} radius={turn.radius} y={turn.y} width={2} />
          )}
          {fxOn && <ImpactFx ref={fx} radius={fxRadius} color={tagged ? TAGGED : HIGHLIGHT} timeScale={loud ? 0.6 : 1} />}
        </group>
      )}
      {fxOn && loud && <CameraShake />}
      {/* 들고 있는 공구를 눌러도 그 공구가 다루는 철물이 태그된다. */}
      <group ref={ref} position={active ? start : part.at} quaternion={quaternion} {...pickHandlers(onPick)}>
        <group ref={scaler}>
          <group ref={spinner}>
            <HardwareMesh part={part} material={material} accent={accent} renderOrder={front ? 10 : 0} />
          </group>
        </group>
        {/* 이름표는 scaler 밖에 두어 크게 그렸다 줄어드는 동안에도 크기가 그대로이고 부품을 따라 움직인다. */}
        {badge && <TagBadge label={badge} motion={motion} elRef={badgeEl} />}
        {active && hole && (
          <group ref={dust} visible={false}>
            {DUST.map((_, i) => (
              <mesh key={i} renderOrder={11}>
                <boxGeometry args={[0.18, 0.18, 0.18]} />
                <meshBasicMaterial color="#d8d2c8" depthTest={false} transparent />
              </mesh>
            ))}
          </group>
        )}
        {active && tool && (
          <group ref={toolRef} visible={false}>
            <group ref={toolSpin} scale={toolScale}>
              {/* 손목(wrist)을 축으로 젖히고 내려친다. 망치가 아니면 축이 원점이라 그대로다. */}
              <group ref={toolSwing} position={wrist}>
                <group position={[-wrist[0], -wrist[1], -wrist[2]]}>
                  <ToolPose tool={tool}>
                    <HardwareMesh part={tool} material={toolMaterial} accent={toolAccent} renderOrder={12} />
                  </ToolPose>
                </group>
              </group>
            </group>
            {ghostMaterials.map((m, k) => (
              <group key={k} ref={(g) => { ghosts.current[k] = g; }} scale={toolScale} visible={false}>
                <ToolPose tool={tool}>
                  <HardwareMesh part={tool} material={m} accent={m} renderOrder={11} />
                </ToolPose>
              </group>
            ))}
          </group>
        )}
      </group>
    </>
  );
}

// 벽 그늘(WallShade)은 Room.tsx로 옮겼다. 분해도(Explode) 등이 여기서 가져다 쓰므로 다시 내보낸다.
export { WallShade };

// 벽에 붙는 것(연필 표시, 구멍, 벽 나사)은 가구를 옮겨도 제자리에 남는다.
export const ON_WALL: SmallPart["model"][] = ["wall_mark", "wall_hole", "wall_screw"];

type Pose = { rot: number; pos: Vec3 };
export function poses(scene: Scene): Record<Step["pose"], Pose> {
  const [, h, d] = scene.size;
  // 누운 자세: 뒷면이 바닥에 닿고 앞면(칸 입구)이 위를 본다.
  return {
    lying: { rot: -Math.PI / 2, pos: [0, d / 2, h / 2] },
    upright: { rot: 0, pos: [0, scene.floor_offset ?? 0, 0] },
  };
}

// 가구 좌표 → 그 단계 자세(눕힘·세움, 앞으로 뺀 거리)를 적용한 월드 좌표.
export function stepWorld(scene: Scene, step: Step) {
  const pose = poses(scene)[step.pose];
  const offset = step.unit_offset ?? [0, 0, 0];
  return (p: Vec3, onWall: boolean): Vec3 => {
    const rotated = new THREE.Vector3(...p).applyAxisAngle(new THREE.Vector3(1, 0, 0), pose.rot);
    return add(add(rotated.toArray() as Vec3, pose.pos), onWall ? [0, 0, 0] : offset);
  };
}

function sphereOf(points: Vec3[]) {
  const box = new THREE.Box3().setFromPoints(points.map((p) => new THREE.Vector3(...p)));
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  return { center: sphere.center.toArray() as Vec3, radius: sphere.radius };
}

// 카메라가 다가갈 곳: 이번 단계에서 움직이는 부품들을 감싸는 구(월드 좌표).
export function stepFocus(scene: Scene, index: number): { center: Vec3; radius: number } | null {
  const step = scene.steps[index];
  const world = stepWorld(scene, step);
  const points = [
    ...step.small.map((s) => world(s.at, ON_WALL.includes(s.model))),
    ...scene.panels.filter((p) => step.adds.includes(p.id)).map((p) => world(p.pos, false)),
  ];
  if (!points.length) return null;
  const sphere = sphereOf(points);
  // 판이 들어오면 판 크기만큼은 보여야 한다.
  const panelRadius = step.adds.length ? Math.max(...scene.size) * 0.6 : 0;
  return { center: sphere.center, radius: Math.max(sphere.radius, panelRadius) };
}

// 부품 모션의 카메라 목표: 단계 전체가 아니라 그 부품 하나(또는 그 단계의 같은 철물들)만 감싸는 구.
// 철물은 들어오는 길(시작 위치)까지 넣어서 다가오는 동작이 화면 밖으로 나가지 않게 한다.
export function partFocus(scene: Scene, index: number, target: MotionTarget): { center: Vec3; radius: number; axis?: Vec3 } | null {
  const step = scene.steps[index];
  if (!step) return null;
  const world = stepWorld(scene, step);
  if (target.kind === "panel") {
    const p = scene.panels.find((x) => x.id === target.id);
    return p ? { center: world(p.pos, false), radius: norm(p.size) / 2 } : null;
  }
  const spot = spotlightOf(step, { target, label: "" });
  const parts = step.small.filter((s) => spot?.smalls.has(s.id));
  if (!parts.length) return null;
  const points = parts.flatMap((s) => {
    const travel = s.travel ?? Math.max(SMALL_TRAVEL, (s.dims.length ?? 2) + 2);
    const start = add(add(s.at, [0, s.drop ?? 0, 0]), s.approach ?? s.axis, -travel);
    const onWall = ON_WALL.includes(s.model);
    const at = world(s.at, onWall);
    const pts = [at, world(start, onWall)];
    // 망치는 머리(박는 축 뒤쪽)와 위로 세운 자루 아래쪽 절반까지 화면에 들어오게 한다.
    const tool = s.tool ? scene.hardware?.[s.tool] : undefined;
    if (tool?.model === "hammer") {
      const back = world(add(s.at, s.axis, -(tool.dims.head + (s.dims.length ?? 0) / 2)), onWall);
      pts.push(back, add(back, [0, tool.dims.handle * 0.75, 0]));
    }
    return pts;
  });
  const sphere = sphereOf(points);
  // 크게 그린 부품과 공구가 들어갈 여유를 둔다.
  const size = Math.max(...parts.map((s) => (s.dims.length ?? s.dims.width ?? 2) * MAGNIFY));
  // 박는 방향(월드). 카메라가 이 축에 비스듬히 서야 망치질이 옆에서 또렷이 보인다.
  const s0 = parts[0];
  const o = world(s0.at, false);
  const axis = add(world(add(s0.at, s0.axis), false), o, -1);
  return { center: sphere.center, radius: Math.max(sphere.radius, size, 4), axis };
}

// 벽에만 손대는 단계(구멍 뚫기·벽 나사)는 부품이 작고 서로 멀어서, 카메라가 지금 작업하는 자리를 차례로 따라간다.
// 자리(벽 좌표 → 월드)와 그 부품 동작이 시작하는 시각(초)을 돌려준다.
export function wallShots(scene: Scene, index: number): { at: Vec3; start: number }[] | null {
  const step = scene.steps[index];
  if (!step.small.length || !step.small.every((s) => ON_WALL.includes(s.model))) return null;
  const base = poses(scene).upright.pos;
  const plan = schedule(step);
  return step.small.map((s, i) => ({ at: add(s.at, base), start: plan.parts[i].start }));
}

// spotlight: 채팅이 고른 부품 모션의 주인공(이 단계를 보여 주는 동안만 App이 넘긴다).
// hideUnit: 분해도(Explode)가 같은 자리에 복사본을 그리는 동안 가구 묶음을 숨긴다(벽·벽 철물은 그대로).
// hidden: 수정안 비교(ChangeScene)가 따로 그리는 판·철물 id. still: 단계 동작 없이 그 단계가 끝난 모습만 보여 준다.
// xray: 판을 반투명하게 그려 판 속 철물을 보여 준다.
export default function Assembly({ scene, stepIndex, playKey, renderStyle, spotlight, hideUnit, hidden, still, xray = false }: {
  scene: Scene; stepIndex: number; playKey: number; renderStyle: RenderStyle; spotlight?: Spotlight | null; hideUnit?: boolean;
  hidden?: Set<string>; still?: boolean; xray?: boolean;
}) {
  const [, , d] = scene.size;
  const step = scene.steps[stepIndex];
  const clock = useRef({ time: 0 });
  const group = useRef<THREE.Group>(null);
  const plan = useMemo(() => schedule(step), [step]);

  const addedBefore = useMemo(
    () => new Set(scene.steps.slice(0, stepIndex).flatMap((s) => s.adds)),
    [scene, stepIndex],
  );
  // 이번 단계에서 다시 조이는 부품은 이전 단계 목록에서 빼고 지금 단계 쪽에서 그린다.
  const smallBefore = useMemo(() => {
    const again = new Set(step.small.map((s) => s.id));
    // 같은 철물이 여러 단계에 다시 나오면(13·14단계 벽 나사 등) 마지막 것 하나만 그려서 key가 겹치지 않게 한다.
    const latest = new Map(scene.steps.slice(0, stepIndex).flatMap((s) => s.small).map((s) => [s.id, s]));
    return [...latest.values()].filter((s) => !again.has(s.id) && !s.transient);
  }, [scene, stepIndex, step]);
  const toolOf = (s: SmallPart) => (s.tool ? scene.hardware?.[s.tool] : undefined);
  const pose = poses(scene);
  const tagged = splitTags(useTaggedParts());
  const spot = spotlightOf(step, spotlight);
  // 주인공 철물이 박히는 판(이미 끼워 둔 판)은 흐리지 않아서 나무에 들어가는 모습이 또렷하게 보이게 한다.
  const spotAt = step.small.filter((s) => spot?.smalls.has(s.id)).map((s) => s.at);
  const hosts = new Set(scene.panels.filter((p) => addedBefore.has(p.id) && spotAt.some((at) =>
    at.every((c, k) => Math.abs(c - p.pos[k]) <= p.size[k] / 2 + 0.6))).map((p) => p.id));
  useResetCursor();

  useEffect(() => {
    clock.current.time = 0;
    const tl = gsap.timeline();
    if (spotlight) {
      // 부품 모션: 카메라가 다가간 뒤 시작해서 주인공 구간만 느리게 튼다.
      const m = motionTiming(step, spotlight.target);
      tl.to(clock.current, { time: m.from, duration: m.from, ease: "none" }, m.delay);
      tl.to(clock.current, { time: m.to, duration: (m.to - m.from) / m.rate, ease: "none" }, ">");
      tl.to(clock.current, { time: plan.total, duration: plan.total - m.to, ease: "none" }, ">");
    } else {
      tl.to(clock.current, { time: plan.total, duration: plan.total, ease: "none" }, 0);
    }
    const g = group.current;
    if (g) {
      const target = pose[step.pose];
      const pos = add(target.pos, step.unit_offset ?? [0, 0, 0]);
      tl.to(g.rotation, { x: target.rot, duration: 1.2, ease: "power2.inOut" }, 0);
      tl.to(g.position, { x: pos[0], y: pos[1], z: pos[2], duration: 1.2, ease: "power2.inOut" }, 0);
    }
    if (still) tl.progress(1);
    return () => { tl.kill(); };
  }, [stepIndex, playKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const render = (s: SmallPart, i: number | null) => hidden?.has(s.id) ? null : (
    <Small key={s.id} part={s} slot={i === null ? null : plan.parts[i]} active={i !== null} clock={clock}
      style={renderStyle} tool={i === null ? undefined : toolOf(s)}
      tagged={tagged.instances.has(s.id) || tagged.kinds.has(s.part_id) || !!spot?.smalls.has(s.id)}
      badge={spot?.badgeAt === s.id ? spot.label : tagged.instances.get(s.id)} motion={spot?.badgeAt === s.id}
      onPick={() => mentionPart(smallTag(scene, s.id))} />
  );
  const current = step.small.map((s, i) => ({ s, i: still ? null : i }));
  const wallZ = scene.wall_z ?? -d / 2 - 1.5;
  const initial = pose[scene.steps[0].pose];
  return (
    <>
      <group ref={group} rotation={[initial.rot, 0, 0]} position={initial.pos} visible={!hideUnit}>
        {scene.panels
          .filter((p) => (addedBefore.has(p.id) || step.adds.includes(p.id)) && !hidden?.has(p.id))
          .map((p) => (
            <Board key={p.id} {...p} style={renderStyle} xray={xray} clock={clock} slot={plan.panels}
              tag={spot?.panel === p.id ? spot.label : tagged.panels.get(p.id)} motion={spot?.panel === p.id}
              ghost={!!spot && spot.panel !== p.id && !hosts.has(p.id)}
              reseatRatio={scene.reseat_ratio ?? 0.15} onPick={() => mentionPart(partTag(scene, p.id))}
              mode={still ? "placed" : step.adds.includes(p.id) ? "add" : step.reseat?.includes(p.id) ? "reseat" : "placed"} />
          ))}
        {smallBefore.filter((s) => !ON_WALL.includes(s.model)).map((s) => render(s, null))}
        {current.filter(({ s }) => !ON_WALL.includes(s.model)).map(({ s, i }) => render(s, i))}
        {step.wall && <WallShade size={scene.size} z={wallZ} />}
        {step.room && <ShelfDecor scene={scene} style={renderStyle} />}
      </group>
      {step.wall && (
        <>
          {/* 벽은 세운 자세 기준 좌표를 쓰고, 가구를 앞으로 빼도 움직이지 않는다. */}
          <group position={pose.upright.pos}>
            {smallBefore.filter((s) => ON_WALL.includes(s.model)).map((s) => render(s, null))}
            {current.filter(({ s }) => ON_WALL.includes(s.model)).map(({ s, i }) => render(s, i))}
          </group>
          <RoomShell wallZ={wallZ} style={renderStyle} />
          {step.room && <RoomDecor scene={scene} wallZ={wallZ} style={renderStyle} />}
        </>
      )}
    </>
  );
}
