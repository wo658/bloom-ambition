import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Edges, Outlines } from "@react-three/drei";
import gsap from "gsap";
import * as THREE from "three";
import { StraightArrow, TurnArrow } from "./Arrows";
import { HardwareMesh, METAL, SPINS, TOOLS, orientation } from "./Hardware";
import type { HardwareSpec, Scene, SmallPart, Step, Vec3 } from "./types";
import { oakMaps, woodBox } from "./wood";

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
    const dur = s.tool || s.drop ? TOOL_TIME : PLAIN_TIME;
    const slot = { start: cursor, dur };
    cursor += s.tool ? dur : PLAIN_STAGGER;
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

function hardwareMaterial(style: RenderStyle, color: string, metal: boolean, active: boolean) {
  // 현재 단계 부품은 판에 가려져도 보이도록 깊이 테스트를 끄고 맨 위에 그린다.
  const common = { color, depthTest: !active, transparent: active, side: THREE.DoubleSide };
  if (style === "technical") return new THREE.MeshBasicMaterial(common);
  if (style === "toon") return new THREE.MeshToonMaterial(common);
  return new THREE.MeshStandardMaterial({ ...common, metalness: metal ? 0.7 : 0, roughness: metal ? 0.35 : 0.8 });
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

function Small({ part, slot, active, clock, style, tool }: {
  part: SmallPart; slot: Slot | null; active: boolean; clock: Clock; style: RenderStyle; tool?: HardwareSpec;
}) {
  const ref = useRef<THREE.Group>(null);
  const scaler = useRef<THREE.Group>(null);
  const spinner = useRef<THREE.Group>(null);
  const toolRef = useRef<THREE.Group>(null);
  const toolSpin = useRef<THREE.Group>(null);
  const pathArrow = useRef<THREE.Group>(null);
  const turnArrow = useRef<THREE.Group>(null);
  const quaternion = useMemo(() => orientation(part.axis, part.up), [part.axis, part.up]);
  const metal = METAL.includes(part.model);
  const spins = SPINS.includes(part.model);
  const color = active ? HIGHLIGHT : style === "technical" ? (metal ? "#b5b5b5" : "#e2e2e2") : part.color;
  const material = useMemo(() => hardwareMaterial(style, color, metal, active), [style, color, metal, active]);
  const accent = useMemo(() => hardwareMaterial(style, "#2b2b2b", false, active), [style, active]);
  // 공구는 금속 반사 없이 제 색으로 칠해 화살표·판과 구분되게 한다.
  const toolMaterial = useMemo(() => hardwareMaterial(style, tool?.color ?? "#666", false, true), [style, tool]);
  const toolAccent = useMemo(() => hardwareMaterial(style, "#3a3a3a", false, true), [style]);
  useEffect(() => () => { material.dispose(); accent.dispose(); toolMaterial.dispose(); toolAccent.dispose(); },
    [material, accent, toolMaterial, toolAccent]);

  const mark = part.model === "wall_mark";
  // 공구(수평계)는 원래 커서 키우지 않는다.
  const magnify = !TOOLS.includes(part.model);
  const length = part.dims.length ?? 2;
  const travel = mark ? 0 : part.travel ?? Math.max(SMALL_TRAVEL, length + 2);
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
    const scale = !active || !magnify ? 1 : u < 0.85 ? MAGNIFY : MAGNIFY + (1 - MAGNIFY) * ease((u - 0.85) / 0.15);
    scaler.current?.scale.setScalar(scale);
    // 연필 표시는 심 끝이 지나간 만큼만 획이 그려진다.
    const draw = mark ? markStroke(active ? a : 1) : null;
    if (draw && spinner.current) {
      draw.strokes.forEach((p, i) => spinner.current!.children[i]?.scale.set(Math.max(p, 0.0001), 1, 1));
    }
    // 나사류는 머리 쪽에서 볼 때 시계 방향(조이는 방향)으로 돈다.
    const turn = spins ? (tool ? a : ease(u)) * SCREW_TURNS * Math.PI * 2 : 0;
    if (spinner.current) spinner.current.rotation.y = turn;
    const working = active && !!tool && u > handEnd * 0.5 && u < 1;
    if (toolRef.current) {
      toolRef.current.visible = working;
      if (draw) {
        // 심 끝을 획을 따라 옮긴다. 표시가 크게 그려져 있으면 그만큼 넓게 움직인다.
        const s = part.dims.size * scale;
        toolRef.current.position.set(draw.tip[0] * s, -draw.lift, draw.tip[1] * s);
      } else {
        toolRef.current.position.y = contact * scale - gap;
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

// 벽: 바닥(y=0)에서 올라가는 불투명한 회반죽 벽. 바닥과 만나는 곳은 살짝 어둡고, 양 끝은 배경으로 흐려진다.
const WALL_W = 500;
const WALL_H = 260;
type WallMaps = { map: THREE.CanvasTexture; bumpMap: THREE.CanvasTexture; alphaMap: THREE.CanvasTexture };
let wallMaps: WallMaps | null = null;
function plasterMaps(): WallMaps {
  if (wallMaps) return wallMaps;
  const canvas = (w: number, h: number, draw: (g: CanvasRenderingContext2D) => void) => {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    draw(c.getContext("2d")!);
    return new THREE.CanvasTexture(c);
  };
  // 회반죽 요철: 잔 알갱이 위에 큰 얼룩을 몇 겹 얹는다(1px ≈ 0.5cm).
  const bump = canvas(1024, 512, (g) => {
    const img = g.createImageData(1024, 512);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = 200 + Math.random() * 40;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    for (let i = 0; i < 900; i++) {
      g.fillStyle = `rgba(${Math.random() < 0.5 ? "0,0,0" : "255,255,255"},0.05)`;
      g.beginPath();
      g.ellipse(Math.random() * 1024, Math.random() * 512, 4 + Math.random() * 14, 3 + Math.random() * 8, Math.random() * Math.PI, 0, Math.PI * 2);
      g.fill();
    }
  });
  // 색: 요철을 아주 옅게 비치게 하고, 바닥 쪽 20cm 정도에 모서리 그늘을 넣는다.
  const map = canvas(1024, 512, (g) => {
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, 1024, 512);
    g.globalAlpha = 0.18;
    g.drawImage(bump.image as HTMLCanvasElement, 0, 0);
    g.globalAlpha = 1;
    const shade = g.createLinearGradient(0, 512, 0, 512 - 40);
    shade.addColorStop(0, "rgba(60,50,40,0.22)");
    shade.addColorStop(1, "rgba(60,50,40,0)");
    g.fillStyle = shade;
    g.fillRect(0, 0, 1024, 512);
  });
  map.colorSpace = THREE.SRGBColorSpace;
  const alphaMap = canvas(256, 1, (g) => {
    const fade = g.createLinearGradient(0, 0, 256, 0);
    fade.addColorStop(0, "#000");
    fade.addColorStop(0.15, "#fff");
    fade.addColorStop(0.85, "#fff");
    fade.addColorStop(1, "#000");
    g.fillStyle = fade;
    g.fillRect(0, 0, 256, 1);
  });
  wallMaps = { map, bumpMap: bump, alphaMap };
  return wallMaps;
}

function Wall({ z, style }: { z: number; style: RenderStyle }) {
  const { map, bumpMap, alphaMap } = plasterMaps();
  // 원목 보기는 환경광이 강해서 바탕색을 더 어둡게 둬야 흰 배경과 구분된다.
  const color = style === "technical" ? "#ebe9e4" : style === "toon" ? "#e3dccf" : "#c9bfae";
  const common = { map, alphaMap, transparent: true, color };
  return (
    // 앞면만 그려서 뒤로 돌아가 보면 벽이 가구를 가리지 않는다.
    <mesh position={[0, WALL_H / 2, z]} receiveShadow renderOrder={-2}>
      <planeGeometry args={[WALL_W, WALL_H]} />
      {style === "technical" ? <meshBasicMaterial key="t" {...common} />
        : style === "toon" ? <meshToonMaterial key="o" {...common} />
        : <meshStandardMaterial key="c" {...common} bumpMap={bumpMap} bumpScale={0.4} roughness={0.95} metalness={0} />}
    </mesh>
  );
}

// 벽에 붙은 가구 뒤의 그늘: 가구 외곽보다 조금 큰 둥근 사각형을 흐리게 그린 텍스처.
const WALL_SHADE_PAD = 10;
let wallShade: THREE.CanvasTexture | null = null;
function wallShadeMap() {
  if (wallShade) return wallShade;
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d")!;
  const pad = 256 * 0.12;
  // alphaMap은 밝기(G 채널)를 불투명도로 쓴다: 검은 바탕에 흰 사각형.
  g.fillStyle = "#000";
  g.fillRect(0, 0, 256, 256);
  g.filter = "blur(14px)";
  g.fillStyle = "#fff";
  g.beginPath();
  g.roundRect(pad, pad, 256 - pad * 2, 256 - pad * 2, 10);
  g.fill();
  wallShade = new THREE.CanvasTexture(c);
  return wallShade;
}

// 가구 묶음 안에 넣어서, 가구를 옆으로 비키면 그늘도 같이 움직인다.
function WallShade({ size, z }: { size: Vec3; z: number }) {
  const [w, h] = size;
  // 텍스처 가장자리 여백(12%)이 흐려지는 자리라, 그만큼 크게 펴서 그늘 테두리가 가구 바깥으로 나오게 한다.
  const scale = 1 / 0.76;
  return (
    <mesh position={[0, h / 2, z + 0.05]} renderOrder={-1}>
      <planeGeometry args={[(w + WALL_SHADE_PAD) * scale, (h + WALL_SHADE_PAD) * scale]} />
      <meshBasicMaterial alphaMap={wallShadeMap()} color="#2b2118" transparent opacity={0.45} depthWrite={false} />
    </mesh>
  );
}

// 벽에 붙는 것(연필 표시, 벽 나사)은 가구를 옮겨도 제자리에 남는다.
const ON_WALL: SmallPart["model"][] = ["wall_mark", "wall_screw"];

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
    return scene.steps.slice(0, stepIndex).flatMap((s) => s.small).filter((s) => !again.has(s.id) && !s.transient);
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
      </group>
      {step.wall && (
        <>
          {/* 벽은 세운 자세 기준 좌표를 쓰고, 가구를 앞으로 빼도 움직이지 않는다. */}
          <group position={pose.upright.pos}>
            {smallBefore.filter((s) => ON_WALL.includes(s.model)).map((s) => render(s, null))}
            {current.filter(({ s }) => ON_WALL.includes(s.model)).map(({ s, i }) => render(s, i))}
          </group>
          <Wall z={wallZ} style={renderStyle} />
        </>
      )}
    </>
  );
}
