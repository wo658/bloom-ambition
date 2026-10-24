import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Edges } from "@react-three/drei";
import gsap from "gsap";
import * as THREE from "three";
import type { RenderStyle } from "./Assembly";
import { buildGeometry } from "./kitShapes";
import type { KitPiece, KitScene } from "./kitTypes";
import type { Vec3 } from "./types";

const HIGHLIGHT = "#ff7a1a";
const HOVER = "#ffb000";
const ZERO: Vec3 = [0, 0, 0];

type Progress = { current: { t: number } };

export function appliesTo(markings: string[] | null, marking: string | null) {
  return !marking || !markings || markings.includes(marking);
}

const smooth = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

function material(style: RenderStyle, piece: KitPiece, state: "active" | "hover" | "idle") {
  const see = piece.kind === "clear" || piece.kind === "jig";
  // 지그는 붙이지 않고 빼내는 부품이라 이 단계에서도 원래의 반투명 파랑으로 둔다.
  const color = piece.kind === "jig" ? piece.color : state === "active" ? HIGHLIGHT : state === "hover" ? HOVER
    : see ? piece.color : style === "technical" ? "#ffffff" : style === "toon" ? "#f4f4f2" : piece.color;
  const common = { color, side: THREE.DoubleSide, transparent: see, opacity: see ? 0.45 : 1, depthWrite: !see };
  if (style === "technical") return new THREE.MeshBasicMaterial(common);
  if (style === "toon") return new THREE.MeshToonMaterial(common);
  const metal = ["#a7abb2", "#3a3a3a"].includes(piece.color);
  return new THREE.MeshStandardMaterial({ ...common, roughness: metal ? 0.4 : 0.75, metalness: metal ? 0.5 : 0 });
}

function Piece({ piece, start, end, window: [w0, w1], progress, state, style }: {
  piece: KitPiece; start: Vec3; end: Vec3; window: [number, number]; progress: Progress;
  state: "active" | "hover" | "idle"; style: RenderStyle;
}) {
  const ref = useRef<THREE.Mesh>(null);
  const geometry = useMemo(() => buildGeometry(piece), [piece]);
  const mat = useMemo(() => material(style, piece, state), [style, piece, state]);
  useEffect(() => () => mat.dispose(), [mat]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  const rotation = useMemo(() => new THREE.Euler(...piece.rot.map((d) => (d * Math.PI) / 180) as Vec3), [piece.rot]);
  const moves = start.some((v, i) => v !== end[i]);

  useFrame(() => {
    if (!ref.current) return;
    const t = moves ? smooth((progress.current.t - w0) / Math.max(w1 - w0, 1e-3)) : 1;
    ref.current.position.set(
      piece.pos[0] + start[0] + (end[0] - start[0]) * t,
      piece.pos[1] + start[1] + (end[1] - start[1]) * t,
      piece.pos[2] + start[2] + (end[2] - start[2]) * t,
    );
  });

  const edge = state === "active" ? "#7a2e00" : style === "color" ? "#00000055" : "#262626";
  return (
    <mesh ref={ref} geometry={geometry} material={mat} rotation={rotation} castShadow receiveShadow
      position={[piece.pos[0] + start[0], piece.pos[1] + start[1], piece.pos[2] + start[2]]}
      renderOrder={state === "active" ? 2 : piece.kind === "clear" ? 1 : 0}>
      {piece.kind !== "clear" && <Edges threshold={32} color={edge} lineWidth={style === "technical" ? 1.4 : 1} />}
    </mesh>
  );
}

export default function KitAssembly({ scene, cur, playKey, renderStyle, marking, hoverPart }: {
  scene: KitScene; cur: number; playKey: number; renderStyle: RenderStyle; marking: string | null; hoverPart: string | null;
}) {
  const step = scene.steps[cur];
  const progress = useRef({ t: 0 });
  const group = useRef<THREE.Group>(null);
  const joining = step.joins.length > 0;

  const visible = useMemo(() => scene.pieces.filter((p) =>
    appliesTo(p.markings, marking) && (p.step === cur || (p.step < cur && !p.temp))), [scene, cur, marking]);
  const active = visible.filter((p) => p.step === cur);

  // 서브조립을 끼우기 전에는 기체 옆(offset)에 놓아 둔다.
  const parked = (p: KitPiece, at: number): Vec3 => {
    const m = scene.modules[p.module];
    return m && at < m.join ? m.offset : ZERO;
  };

  // 끼우는 동작이 먼저, 그다음 이 단계의 새 부품이 하나씩 날아 들어온다.
  const a0 = joining ? 0.42 : 0;
  const span = 1 - a0;
  const n = active.length;
  const slot = n > 1 ? span * 0.5 : span;
  const windowOf = (k: number): [number, number] => {
    const s = a0 + (n > 1 ? ((span - slot) * k) / (n - 1) : 0);
    return [s, s + slot];
  };

  const pose = scene.poses[step.pose];
  useEffect(() => {
    progress.current.t = 0;
    const tl = gsap.timeline();
    const duration = Math.min(6, 1.1 + 0.28 * n + (joining ? 1.2 : 0));
    tl.to(progress.current, { t: 1, duration, ease: "none", delay: 0.45 });
    const g = group.current;
    if (g) {
      tl.to(g.rotation, { x: -pose.pitch, duration: 1.1, ease: "power2.inOut" }, 0);
      tl.to(g.position, { y: pose.height, duration: 1.1, ease: "power2.inOut" }, 0);
    }
    return () => { tl.kill(); };
  }, [cur, playKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const initial = scene.poses[scene.steps[0].pose];
  return (
    <group ref={group} rotation={[-initial.pitch, 0, 0]} position={[0, initial.height, 0]}>
      {visible.map((p) => {
        const isActive = p.step === cur;
        const k = isActive ? active.indexOf(p) : -1;
        const before = parked(p, cur - 1);
        const after = parked(p, cur);
        const start: Vec3 = isActive ? [after[0] + p.from[0], after[1] + p.from[1], after[2] + p.from[2]] : before;
        const win: [number, number] = isActive ? windowOf(k) : [0, a0 || 1];
        const state = hoverPart === p.part_id ? "hover" : isActive ? "active" : "idle";
        return <Piece key={p.key} piece={p} start={start} end={after} window={win} progress={progress} state={state} style={renderStyle} />;
      })}
    </group>
  );
}
