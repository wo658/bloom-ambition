import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Edges, Outlines } from "@react-three/drei";
import gsap from "gsap";
import * as THREE from "three";
import { HardwareMesh, METAL, SPINS, orientation } from "./Hardware";
import type { Scene, SmallPart, Vec3 } from "./types";
import { oakMaps, woodBox } from "./wood";

const HIGHLIGHT = "#ff7a1a";

// 도면: IKEA 설명서처럼 흰 면 + 굵은 외곽선, 툰: 흰 면에 계단식 음영, 컬러: 오일 마감 원목.
export type RenderStyle = "technical" | "toon" | "color";
const BOARD: Record<RenderStyle, string> = { technical: "#ffffff", toon: "#ffffff", color: "#ffffff" };
const EDGE: Record<RenderStyle, string> = { technical: "#1f1f1f", toon: "#4b4b4b", color: "#7a5532" };

function Material({ style, color, wood }: { style: RenderStyle; color: string; wood?: boolean }) {
  if (style === "technical") return <meshBasicMaterial color={color} />;
  if (style === "toon") return <meshToonMaterial color={color} />;
  // 텍스처 유무가 바뀌면 셰이더를 다시 만들어야 해서 key로 재질을 새로 만든다.
  if (wood) return <meshStandardMaterial key="wood" color={color} {...oakMaps()} normalScale={[0.6, 0.6]} roughness={1} metalness={0} />;
  return <meshStandardMaterial key="plain" color={color} roughness={0.8} metalness={0} />;
}
const SMALL_TRAVEL = 8;
const SCREW_TURNS = 4;

// 단계 하나가 진행되는 정도(0→1). GSAP이 값을 올리고 메쉬는 매 프레임 읽는다.
type Progress = { current: { t: number } };

function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function Board({ id, size, pos, from, active, progress, style }: {
  id: string; size: Vec3; pos: Vec3; from: Vec3; active: boolean; progress: Progress; style: RenderStyle;
}) {
  const ref = useRef<THREE.Mesh>(null);
  const geometry = useMemo(() => woodBox(size, id), [size, id]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  const start: Vec3 = [pos[0] + from[0], pos[1] + from[1], pos[2] + from[2]];
  useFrame(() => {
    if (!ref.current) return;
    ref.current.position.set(...(active ? lerp(start, pos, progress.current.t) : pos));
  });
  return (
    <mesh ref={ref} geometry={geometry} position={active ? start : pos} castShadow receiveShadow>
      <Material style={style} color={active ? HIGHLIGHT : BOARD[style]} wood={!active} />
      <Edges color={active ? "#7a2e00" : EDGE[style]} lineWidth={style === "technical" ? 2 : 1} />
      {active && <Outlines thickness={3} color={HIGHLIGHT} />}
    </mesh>
  );
}

function hardwareMaterial(style: RenderStyle, color: string, metal: boolean, active: boolean) {
  // 현재 단계 부품은 판에 가려져도 보이도록 깊이 테스트를 끄고 맨 위에 그린다.
  const common = { color, depthTest: !active, transparent: active, side: THREE.DoubleSide };
  if (style === "technical") return new THREE.MeshBasicMaterial(common);
  if (style === "toon") return new THREE.MeshToonMaterial(common);
  return new THREE.MeshStandardMaterial({ ...common, metalness: metal ? 0.7 : 0, roughness: metal ? 0.35 : 0.8 });
}

function Small({ part, active, progress, style }: {
  part: SmallPart; active: boolean; progress: Progress; style: RenderStyle;
}) {
  const ref = useRef<THREE.Group>(null);
  const spinner = useRef<THREE.Group>(null);
  const quaternion = useMemo(() => orientation(part.axis, part.up), [part.axis, part.up]);
  const metal = METAL.includes(part.model);
  const spins = SPINS.includes(part.model);
  const color = active ? HIGHLIGHT : style === "technical" ? (metal ? "#b5b5b5" : "#e2e2e2") : part.color;
  const material = useMemo(() => hardwareMaterial(style, color, metal, active), [style, color, metal, active]);
  const accent = useMemo(() => hardwareMaterial(style, "#2b2b2b", false, active), [style, active]);
  useEffect(() => () => { material.dispose(); accent.dispose(); }, [material, accent]);

  const travel = Math.max(SMALL_TRAVEL, (part.dims.length ?? 0) + 2);
  const start: Vec3 = [
    part.at[0] - part.axis[0] * travel,
    part.at[1] - part.axis[1] * travel,
    part.at[2] - part.axis[2] * travel,
  ];
  useFrame(() => {
    if (!ref.current) return;
    const t = active ? progress.current.t : 1;
    ref.current.position.set(...lerp(start, part.at, t));
    // 나사류는 들어가는 동안 축을 따라 돈다.
    if (spinner.current && spins) spinner.current.rotation.y = (1 - t) * SCREW_TURNS * Math.PI * 2;
  });
  return (
    <group ref={ref} position={active ? start : part.at} quaternion={quaternion}>
      <group ref={spinner}>
        <HardwareMesh part={part} material={material} accent={accent} renderOrder={active ? 10 : 0} />
      </group>
    </group>
  );
}

export default function Assembly({ scene, stepIndex, playKey, renderStyle }: {
  scene: Scene; stepIndex: number; playKey: number; renderStyle: RenderStyle;
}) {
  const [, h, d] = scene.size;
  const step = scene.steps[stepIndex];
  const progress = useRef({ t: 0 });
  const group = useRef<THREE.Group>(null);

  const addedBefore = useMemo(
    () => new Set(scene.steps.slice(0, stepIndex).flatMap((s) => s.adds)),
    [scene, stepIndex],
  );
  const smallBefore = useMemo(() => scene.steps.slice(0, stepIndex).flatMap((s) => s.small), [scene, stepIndex]);

  // 누운 자세: 뒷면이 바닥에 닿고 앞면(칸 입구)이 위를 본다.
  const poses = {
    lying: { rot: -Math.PI / 2, pos: [0, d / 2, h / 2] as Vec3 },
    upright: { rot: 0, pos: [0, scene.floor_offset ?? 0, 0] as Vec3 },
  };

  useEffect(() => {
    progress.current.t = 0;
    const tl = gsap.timeline();
    tl.to(progress.current, { t: 1, duration: 1.4, ease: "power2.inOut", delay: 0.3 });
    const g = group.current;
    if (g) {
      const target = poses[step.pose];
      tl.to(g.rotation, { x: target.rot, duration: 1.2, ease: "power2.inOut" }, 0);
      tl.to(g.position, { x: target.pos[0], y: target.pos[1], z: target.pos[2], duration: 1.2, ease: "power2.inOut" }, 0);
    }
    return () => { tl.kill(); };
  }, [stepIndex, playKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const initial = poses[scene.steps[0].pose];
  return (
    <>
      <group ref={group} rotation={[initial.rot, 0, 0]} position={initial.pos}>
        {scene.panels
          .filter((p) => addedBefore.has(p.id) || step.adds.includes(p.id))
          .map((p) => (
            <Board key={p.id} {...p} active={step.adds.includes(p.id)} progress={progress} style={renderStyle} />
          ))}
        {smallBefore.map((s) => <Small key={s.id} part={s} active={false} progress={progress} style={renderStyle} />)}
        {step.small.map((s) => <Small key={s.id} part={s} active progress={progress} style={renderStyle} />)}
      </group>
      {step.wall && (
        <mesh position={[0, 100, scene.wall_z ?? -d / 2 - 1.5]} receiveShadow>
          <planeGeometry args={[400, 200]} />
          <meshBasicMaterial color="#e9edf2" transparent opacity={0.7} />
        </mesh>
      )}
    </>
  );
}
