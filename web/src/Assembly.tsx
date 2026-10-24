import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Edges, Outlines } from "@react-three/drei";
import gsap from "gsap";
import * as THREE from "three";
import { StraightArrow, TurnArrow } from "./Arrows";
import { HardwareMesh, METAL, SPINS, TOOLS, orientation } from "./Hardware";
import type { HardwareSpec, Scene, SmallPart, Step, Vec3 } from "./types";
import { oakMaps, woodBox } from "./wood";
import { RoomDecor, RoomShell, ShelfDecor, WallShade } from "./Room";

export const HIGHLIGHT = "#ff7a1a";

// 도면: IKEA 설명서처럼 흰 면 + 굵은 외곽선, 툰: 흰 면에 계단식 음영, 컬러: 오일 마감 원목.
export type RenderStyle = "technical" | "toon" | "color";
const BOARD: Record<RenderStyle, string> = { technical: "#ffffff", toon: "#ffffff", color: "#ffffff" };
export const EDGE: Record<RenderStyle, string> = { technical: "#1f1f1f", toon: "#4b4b4b", color: "#7a5532" };

export function Material({ style, color, wood }: { style: RenderStyle; color: string; wood?: boolean }) {
  if (style === "technical") return <meshBasicMaterial color={color} />;
  if (style === "toon") return <meshToonMaterial color={color} />;
  // 텍스처 유무가 바뀌면 셰이더를 다시 만들어야 해서 key로 재질을 새로 만든다.
  if (wood) return <meshStandardMaterial key="wood" color={color} {...oakMaps()} normalScale={[0.6, 0.6]} roughness={1} metalness={0} />;
  return <meshStandardMaterial key="plain" color={color} roughness={0.8} metalness={0} />;
}
const SMALL_TRAVEL = 8;
const SCREW_TURNS = 4;
const MAGNIFY = 1.8; // 지금 단계의 작은 부품은 이만큼 크게 그렸다가 자리에 들어가면 원래 크기로 돌아온다
const HAMMER_TAPS = 3;
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

function Board({ id, size, pos, from, mode, slot, clock, reseatRatio, style }: {
  id: string; size: Vec3; pos: Vec3; from: Vec3; mode: "add" | "reseat" | "placed"; slot: Slot | null;
  clock: Clock; reseatRatio: number; style: RenderStyle;
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
      <mesh ref={ref} geometry={geometry} position={active ? start : pos} castShadow receiveShadow>
        <Material style={style} color={active ? HIGHLIGHT : BOARD[style]} wood={!active} />
        <Edges color={active ? "#7a2e00" : EDGE[style]} lineWidth={style === "technical" ? 2 : 1} />
        {active && <Outlines thickness={3} color={HIGHLIGHT} />}
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

// 공구를 부품 로컬 좌표(접점이 원점, +Y가 박히는 방향)에 맞춰 놓는다.
function ToolPose({ tool, children }: { tool: HardwareSpec; children: React.ReactNode }) {
  if (tool.model === "hex_key") {
    // 짧은 팔을 육각 홈에 꽂고 긴 팔은 옆으로 뻗는다.
    return <group position={[0, -(tool.dims.short - 0.3), 0]} rotation={[0, 0, Math.PI / 2]}>{children}</group>;
  }
  return <>{children}</>;
}

function Small({ part, slot, active, clock, style, tool }: {
  part: SmallPart; slot: Slot | null; active: boolean; clock: Clock; style: RenderStyle; tool?: HardwareSpec;
}) {
  const ref = useRef<THREE.Group>(null);
  const scaler = useRef<THREE.Group>(null);
  const spinner = useRef<THREE.Group>(null);
  const toolRef = useRef<THREE.Group>(null);
  const toolSpin = useRef<THREE.Group>(null);
  const pathArrow = useRef<THREE.Group>(null);
  const dust = useRef<THREE.Group>(null);
  const turnArrow = useRef<THREE.Group>(null);
  const quaternion = useMemo(() => orientation(part.axis, part.up), [part.axis, part.up]);
  const metal = METAL.includes(part.model);
  const spins = SPINS.includes(part.model);
  const color = active ? HIGHLIGHT : style === "technical" ? (metal ? "#b5b5b5" : "#e2e2e2") : part.color;
  // 벽 나사는 벽 속으로, 드릴 날은 뚫는 구멍 속으로 들어가며 가려진다.
  const embed = part.model === "wall_screw";
  const drilling = part.model === "wall_hole";
  const material = useMemo(() => hardwareMaterial(style, color, metal, active, embed), [style, color, metal, active, embed]);
  const accent = useMemo(() => hardwareMaterial(style, "#2b2b2b", false, active, embed), [style, active, embed]);
  // 공구는 금속 반사 없이 제 색으로 칠해 화살표·판과 구분되게 한다.
  const toolMaterial = useMemo(() => hardwareMaterial(style, tool?.color ?? "#666", false, true, drilling), [style, tool, drilling]);
  const toolAccent = useMemo(() => hardwareMaterial(style, "#3a3a3a", false, true, drilling), [style, drilling]);
  useEffect(() => () => { material.dispose(); accent.dispose(); toolMaterial.dispose(); toolAccent.dispose(); },
    [material, accent, toolMaterial, toolAccent]);

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
    let depth = 0;
    let gap = 0;
    if (part.model === "dowel" && tool) {
      // 망치를 들었다 내려칠 때마다 조금씩 들어간다.
      const k = a * HAMMER_TAPS, n = Math.min(Math.floor(k), HAMMER_TAPS - 1), phase = k - n;
      gap = a >= 1 ? 3 : 3 * Math.sin(Math.PI * phase);
      depth = Math.min(1, (n + Math.max(0, (phase - 0.75) / 0.25)) / HAMMER_TAPS);
    } else {
      depth = a;
    }
    const pos = part.drop
      ? (u < DROP_AT ? lerp(start, hang, ease(u / DROP_AT)) : lerp(hang, part.at, ease((u - DROP_AT) / (1 - DROP_AT))))
      : u < handEnd ? lerp(start, pre, ease(u / handEnd)) : lerp(pre, part.at, depth);
    ref.current.position.set(...pos);
    // 벽 나사는 차례가 오기 전에는 숨긴다(앞 구멍을 뚫는 드릴과 같은 자리에 떠 있지 않게).
    if (embed) ref.current.visible = !active || u > 0;
    const scale = !active || !magnify ? 1 : u < 0.85 ? MAGNIFY : MAGNIFY + (1 - MAGNIFY) * ease((u - 0.85) / 0.15);
    scaler.current?.scale.setScalar(scale);
    if (mark) scaler.current?.scale.setScalar(active ? (a > 0.5 ? scale : 0.0001) : 1);
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
    const turn = spins ? (tool ? a : ease(u)) * SCREW_TURNS * Math.PI * 2 : 0;
    if (spinner.current) spinner.current.rotation.y = turn;
    const working = active && !!tool && u > handEnd * 0.5 && u < 1;
    if (toolRef.current) {
      toolRef.current.visible = working;
      const pencilLift = mark ? Math.max(0, 4 * (1 - 2 * a)) : 0;
      toolRef.current.position.y = contact * scale - gap - pencilLift;
      // 연필은 십자를 긋듯이 살짝 흔든다.
      toolRef.current.rotation.z = mark && a > 0.5 ? 0.25 * Math.sin(a * 40) : 0;
      if (drill) {
        // 드릴은 뚫는 동안 살짝 떨리고 날만 빠르게 돈다.
        toolRef.current.position.y = drill.y;
        toolRef.current.position.x = drill.cutting ? 0.06 * Math.sin(a * 400) : 0;
        const bit = toolRef.current.getObjectByName("drill-bit");
        if (bit) bit.rotation.y = drill.bore * DRILL_TURNS * Math.PI * 2;
      }
    }
    if (toolSpin.current) toolSpin.current.rotation.y = spins ? turn : 0;
    if (pathArrow.current) pathArrow.current.visible = active && travel > 1 && u > 0 && u < Math.max(handEnd, 0.6);
    if (turnArrow.current) turnArrow.current.visible = working && spins && u > handEnd;
  });

  return (
    <>
      {/* 화살표는 도착 지점 기준으로 고정한다. */}
      {active && (
        <group position={part.at} quaternion={quaternion}>
          {travel > 1 && <StraightArrow ref={pathArrow} tail={arrowTail} head={arrowHead} width={arrowWidth} />}
          {spins && tool && (
            <TurnArrow ref={turnArrow} radius={turn.radius} y={turn.y} width={2} />
          )}
        </group>
      )}
      <group ref={ref} position={active ? start : part.at} quaternion={quaternion}>
        <group ref={scaler}>
          <group ref={spinner}>
            <HardwareMesh part={part} material={material} accent={accent} renderOrder={active ? 10 : 0} />
          </group>
        </group>
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
              <ToolPose tool={tool}>
                <HardwareMesh part={tool} material={toolMaterial} accent={toolAccent} renderOrder={12} />
              </ToolPose>
            </group>
          </group>
        )}
      </group>
    </>
  );
}

// 벽에 붙는 것(연필 표시, 구멍, 벽 나사)은 가구를 옮겨도 제자리에 남는다.
const ON_WALL: SmallPart["model"][] = ["wall_mark", "wall_hole", "wall_screw"];

type Pose = { rot: number; pos: Vec3 };
function poses(scene: Scene): Record<Step["pose"], Pose> {
  const [, h, d] = scene.size;
  // 누운 자세: 뒷면이 바닥에 닿고 앞면(칸 입구)이 위를 본다.
  return {
    lying: { rot: -Math.PI / 2, pos: [0, d / 2, h / 2] },
    upright: { rot: 0, pos: [0, scene.floor_offset ?? 0, 0] },
  };
}

// 카메라가 다가갈 곳: 이번 단계에서 움직이는 부품들을 감싸는 구(월드 좌표).
export function stepFocus(scene: Scene, index: number): { center: Vec3; radius: number } | null {
  const step = scene.steps[index];
  const pose = poses(scene)[step.pose];
  const offset = step.unit_offset ?? [0, 0, 0];
  const world = (p: Vec3, onWall: boolean): Vec3 => {
    const rotated = new THREE.Vector3(...p).applyAxisAngle(new THREE.Vector3(1, 0, 0), pose.rot);
    return add(add(rotated.toArray() as Vec3, pose.pos), onWall ? [0, 0, 0] : offset);
  };
  const points = [
    ...step.small.map((s) => world(s.at, ON_WALL.includes(s.model))),
    ...scene.panels.filter((p) => step.adds.includes(p.id)).map((p) => world(p.pos, false)),
  ];
  if (!points.length) return null;
  const box = new THREE.Box3().setFromPoints(points.map((p) => new THREE.Vector3(...p)));
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  // 판이 들어오면 판 크기만큼은 보여야 한다.
  const panelRadius = step.adds.length ? Math.max(...scene.size) * 0.6 : 0;
  return { center: sphere.center.toArray() as Vec3, radius: Math.max(sphere.radius, panelRadius) };
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

export default function Assembly({ scene, stepIndex, playKey, renderStyle }: {
  scene: Scene; stepIndex: number; playKey: number; renderStyle: RenderStyle;
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
    // 나중 단계에서 다시 조인 부품은 같은 id로 또 나오므로 마지막 것만 남긴다.
    const before = new Map(scene.steps.slice(0, stepIndex).flatMap((s) => s.small).map((s) => [s.id, s]));
    return [...before.values()].filter((s) => !again.has(s.id) && !s.transient);
  }, [scene, stepIndex, step]);
  const toolOf = (s: SmallPart) => (s.tool ? scene.hardware?.[s.tool] : undefined);
  const pose = poses(scene);

  useEffect(() => {
    clock.current.time = 0;
    const tl = gsap.timeline();
    tl.to(clock.current, { time: plan.total, duration: plan.total, ease: "none" }, 0);
    const g = group.current;
    if (g) {
      const target = pose[step.pose];
      const pos = add(target.pos, step.unit_offset ?? [0, 0, 0]);
      tl.to(g.rotation, { x: target.rot, duration: 1.2, ease: "power2.inOut" }, 0);
      tl.to(g.position, { x: pos[0], y: pos[1], z: pos[2], duration: 1.2, ease: "power2.inOut" }, 0);
    }
    return () => { tl.kill(); };
  }, [stepIndex, playKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const render = (s: SmallPart, i: number | null) => (
    <Small key={s.id} part={s} slot={i === null ? null : plan.parts[i]} active={i !== null} clock={clock}
      style={renderStyle} tool={i === null ? undefined : toolOf(s)} />
  );
  const current = step.small.map((s, i) => ({ s, i }));
  const wallZ = scene.wall_z ?? -d / 2 - 1.5;
  const initial = pose[scene.steps[0].pose];
  return (
    <>
      <group ref={group} rotation={[initial.rot, 0, 0]} position={initial.pos}>
        {scene.panels
          .filter((p) => addedBefore.has(p.id) || step.adds.includes(p.id))
          .map((p) => (
            <Board key={p.id} {...p} style={renderStyle} clock={clock} slot={plan.panels}
              reseatRatio={scene.reseat_ratio ?? 0.15}
              mode={step.adds.includes(p.id) ? "add" : step.reseat?.includes(p.id) ? "reseat" : "placed"} />
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
