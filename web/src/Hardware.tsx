import { useMemo } from "react";
import * as THREE from "three";
import type { HardwareModel, SmallPart } from "./types";

// 철물 형상. 모두 부품 로컬 좌표(cm)로 그리고, +Y가 박히는 방향이다.
// 나사·볼트는 원점이 머리 윗면, 나무못은 중심, 브래킷류는 판 면과 뒷모서리가 만나는 점.

type Dims = Record<string, number>;
type Props = { dims: Dims; material: THREE.Material; accent: THREE.Material; renderOrder: number };

export const METAL: HardwareModel[] = ["connector_screw", "euro_screw", "wall_screw", "hook_plate", "hex_key"];
export const SPINS: HardwareModel[] = ["connector_screw", "euro_screw", "wall_screw"];

const v2 = (x: number, y: number) => new THREE.Vector2(x, y);

// 회전체 나사산: 골과 마루를 번갈아 찍은 톱니 단면.
function thread(from: number, to: number, core: number, outer: number, pitch: number) {
  const pts: THREE.Vector2[] = [];
  for (let y = from; y + pitch <= to; y += pitch) {
    pts.push(v2(core, y), v2(outer, y + pitch * 0.45), v2(core, y + pitch * 0.9));
  }
  return pts;
}

function lathe(pts: THREE.Vector2[]) {
  return new THREE.LatheGeometry(pts, 24);
}

// 십자 홈(+)과 육각 홈은 머리 윗면(-Y 쪽)에 얹은 어두운 면으로 표시한다.
function Cross({ size, y, accent, renderOrder }: { size: number; y: number; accent: THREE.Material; renderOrder: number }) {
  return (
    <>
      {[0, Math.PI / 2].map((r) => (
        <mesh key={r} position={[0, y, 0]} rotation={[0, r, 0]} material={accent} renderOrder={renderOrder + 1}>
          <boxGeometry args={[size, 0.01, size * 0.18]} />
        </mesh>
      ))}
    </>
  );
}

// 104321 연결 볼트: 접시머리 + 육각 홈, 민무늬 목, 굵은 나사산, 뭉툭한 끝.
function ConnectorScrew({ dims: d, material, accent, renderOrder }: Props) {
  const geometry = useMemo(() => {
    const r = d.head_d / 2, s = d.shank_d / 2, top = d.head_h + d.smooth;
    return lathe([
      v2(0, 0), v2(r, 0), v2(r, 0.06), v2(s, d.head_h), v2(s, top),
      ...thread(top, d.length - 0.2, s * 0.85, d.thread_d / 2, d.pitch),
      v2(s * 0.7, d.length), v2(0, d.length),
    ]);
  }, [d]);
  return (
    <>
      <mesh geometry={geometry} material={material} renderOrder={renderOrder} castShadow />
      <mesh position={[0, -0.005, 0]} rotation={[Math.PI / 2, 0, 0]} material={accent} renderOrder={renderOrder + 1}>
        <circleGeometry args={[d.socket / 2, 6]} />
      </mesh>
    </>
  );
}

// 100372 짧은 나사: 납작 접시머리 + 십자 홈.
function EuroScrew({ dims: d, material, accent, renderOrder }: Props) {
  const geometry = useMemo(() => {
    const r = d.head_d / 2, s = d.shank_d / 2;
    return lathe([
      v2(0, 0), v2(r, 0), v2(r, 0.04), v2(s, d.head_h), v2(s, d.head_h + 0.1),
      ...thread(d.head_h + 0.1, d.length - 0.15, s, d.thread_d / 2, d.pitch),
      v2(0, d.length),
    ]);
  }, [d]);
  return (
    <>
      <mesh geometry={geometry} material={material} renderOrder={renderOrder} castShadow />
      <Cross size={d.head_d * 0.6} y={-0.005} accent={accent} renderOrder={renderOrder} />
    </>
  );
}

// 벽용 나사: 원점이 벽 면. 둥근 머리가 벽에서 protrude만큼 나와 고리 판에 걸린다.
function WallScrew({ dims: d, material, accent, renderOrder }: Props) {
  const p = d.protrude ?? 0.8;
  const geometry = useMemo(() => {
    const r = d.head_d / 2, s = d.shank_d / 2;
    const dome = Array.from({ length: 7 }, (_, i) => {
      const a = (i / 6) * (Math.PI / 2);
      return v2(r * Math.sin(a), -p - d.head_h * Math.cos(a));
    });
    return lathe([
      ...dome, v2(s, -p),
      ...thread(0.2, d.length - p - 0.4, s, d.thread_d / 2, d.pitch),
      v2(0, d.length - p),
    ]);
  }, [d, p]);
  return (
    <>
      <mesh geometry={geometry} material={material} renderOrder={renderOrder} castShadow />
      <Cross size={d.head_d * 0.55} y={-p - d.head_h - 0.005} accent={accent} renderOrder={renderOrder} />
    </>
  );
}

// 101339 나무못: 세로 홈이 파인 원기둥, 양 끝 모따기.
function Dowel({ dims: d, material, renderOrder }: Props) {
  const geometry = useMemo(() => {
    const bevel = 0.08, r = d.d / 2 - bevel, n = 192;
    const shape = new THREE.Shape();
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      const groove = Math.max(0, Math.cos(a * d.flutes)) ** 6;
      const rr = r * (1 - 0.18 * groove);
      if (i === 0) shape.moveTo(rr * Math.cos(a), rr * Math.sin(a));
      else shape.lineTo(rr * Math.cos(a), rr * Math.sin(a));
    }
    const g = new THREE.ExtrudeGeometry(shape, {
      depth: d.length - 2 * bevel, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2,
    });
    g.center();
    g.rotateX(-Math.PI / 2);
    return g;
  }, [d]);
  return <mesh geometry={geometry} material={material} renderOrder={renderOrder} castShadow />;
}

function circle(x: number, y: number, r: number) {
  const path = new THREE.Path();
  path.absarc(x, y, r, 0, Math.PI * 2, false);
  return path;
}

// 2D 판(가로 0~w, 세로 ±h/2)을 구멍째 두께 t로 밀어내고 m으로 부품 로컬에 옮긴다.
function plate(w: number, h: number, t: number, holes: THREE.Path[], m: THREE.Matrix4, x0 = 0) {
  const shape = new THREE.Shape();
  shape.moveTo(x0, -h / 2).lineTo(x0 + w, -h / 2).lineTo(x0 + w, h / 2).lineTo(x0, h / 2).closePath();
  shape.holes = holes;
  const g = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false, curveSegments: 16 });
  g.applyMatrix4(m);
  return g;
}

// 115753 벽 고정 브래킷: ㄱ자. 옆 날개는 판 면에(나사 구멍 4개), 벽 날개는 뒤쪽(큰 구멍 + 보강 리브).
// 로컬 +X 위, +Y 판 쪽, +Z 앞.
function CornerBracket({ dims: d, material, renderOrder }: Props) {
  const geometries = useMemo(() => {
    const { t, height: H } = d;
    const holes = [d.screw_z, d.side - d.screw_z].flatMap((u) => [circle(u, d.screw_x, 0.22), circle(u, -d.screw_x, 0.22)]);
    // (x, y, z) → (X=y, Y=z−t, Z=x): 판 면에 붙은 날개
    const side = plate(d.side, H, t, holes, new THREE.Matrix4().set(0, 1, 0, 0, 0, 0, 1, -t, 1, 0, 0, 0, 0, 0, 0, 1));
    // (x, y, z) → (X=y, Y=−x, Z=z−t): 벽을 보는 날개
    const wall = plate(d.wall, H, t, [circle(d.wall / 2, 0, d.hole_d / 2)],
      new THREE.Matrix4().set(0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, -t, 0, 0, 0, 1));
    return { side, wall };
  }, [d]);
  const ribs = [-1, 1].flatMap((s) => [0, 1, 2].map((k) => s * (d.hole_d / 2 + 0.35 + k * 0.4)));
  return (
    <>
      <mesh geometry={geometries.side} material={material} renderOrder={renderOrder} castShadow />
      <mesh geometry={geometries.wall} material={material} renderOrder={renderOrder} castShadow />
      {ribs.map((x) => (
        <mesh key={x} position={[x, -d.wall / 2, 0.04]} material={material} renderOrder={renderOrder}>
          <boxGeometry args={[0.1, d.wall * 0.75, 0.08]} />
        </mesh>
      ))}
    </>
  );
}

// 103693 벽걸이 고리 판: 열쇠 구멍(나사 머리가 들어가는 원 + 위로 좁은 홈)과 양옆 조절 홈.
function HookPlate({ dims: d, material, renderOrder }: Props) {
  const geometry = useMemo(() => {
    const r = d.key_d / 2, s = d.slot_w / 2, a = Math.acos(s / r);
    const key = new THREE.Path();
    key.moveTo(-s, d.slot_top);
    key.lineTo(-s, d.key_y + r * Math.sin(a));
    key.absarc(0, d.key_y, r, Math.PI - a, Math.PI * 2 + a, false);
    key.lineTo(s, d.slot_top);
    key.closePath();
    const slots = [-1, 1].map((side) => {
      const cx = side * d.width * 0.36, w = 0.13, y0 = -d.height * 0.3, y1 = d.height * 0.3;
      const path = new THREE.Path();
      path.moveTo(cx - w, y0).lineTo(cx - w, y1);
      path.absarc(cx, y1, w, Math.PI, 0, true);
      path.lineTo(cx + w, y0);
      path.absarc(cx, y0, w, 0, -Math.PI, true);
      return path;
    });
    // (x, y, z) → (X=y, Y=−x, Z=z): 폭은 판에서 멀어지는 쪽, 높이는 위
    return plate(d.width, d.height, d.t, [key, ...slots],
      new THREE.Matrix4().set(0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1), -d.width / 2);
  }, [d]);
  return <mesh geometry={geometry} material={material} renderOrder={renderOrder} castShadow />;
}

// 115754 브래킷 커버: 판 쪽과 벽 쪽이 열린 ㄱ자 덮개. 판 방향으로 밀어 끼운다.
function BracketCover({ dims: d, material, renderOrder }: Props) {
  const { height: H, side: S, wall: W, t, back } = d;
  const depth = S + back, zc = (S - back) / 2;
  const boxes: { size: [number, number, number]; pos: [number, number, number] }[] = [
    { size: [H, W, t], pos: [0, -W / 2, S - t / 2] },
    { size: [H, t, depth], pos: [0, -W + t / 2, zc] },
    { size: [t, W, depth], pos: [H / 2 - t / 2, -W / 2, zc] },
    { size: [t, W, depth], pos: [-H / 2 + t / 2, -W / 2, zc] },
  ];
  return (
    <>
      {boxes.map((b, i) => (
        <mesh key={i} position={b.pos} material={material} renderOrder={renderOrder} castShadow>
          <boxGeometry args={b.size} />
        </mesh>
      ))}
    </>
  );
}

// 10002300 펠트 패드: 육각형, 윗면이 원점(가구 바닥면).
function FeltPad({ dims: d, material, renderOrder }: Props) {
  return (
    <mesh position={[0, -d.t / 2, 0]} material={material} renderOrder={renderOrder} castShadow>
      <cylinderGeometry args={[d.r, d.r, d.t, 6]} />
    </mesh>
  );
}

// 100001 육각 렌치: ㄱ자로 꺾인 육각 막대. 원점이 꺾인 곳, 긴 팔 +Y, 짧은 팔 +X.
function HexKey({ dims: d, material, renderOrder }: Props) {
  const r = d.across / Math.sqrt(3);
  return (
    <>
      <mesh position={[0, d.long / 2, 0]} material={material} renderOrder={renderOrder} castShadow>
        <cylinderGeometry args={[r, r, d.long, 6]} />
      </mesh>
      <mesh position={[d.short / 2, 0, 0]} rotation={[0, 0, Math.PI / 2]} material={material} renderOrder={renderOrder} castShadow>
        <cylinderGeometry args={[r, r, d.short, 6]} />
      </mesh>
      <mesh material={material} renderOrder={renderOrder}>
        <sphereGeometry args={[r, 12, 8]} />
      </mesh>
    </>
  );
}

const MODELS: Record<HardwareModel, (p: Props) => React.JSX.Element> = {
  connector_screw: ConnectorScrew,
  euro_screw: EuroScrew,
  wall_screw: WallScrew,
  dowel: Dowel,
  corner_bracket: CornerBracket,
  hook_plate: HookPlate,
  bracket_cover: BracketCover,
  felt_pad: FeltPad,
  hex_key: HexKey,
};

export function HardwareMesh({ part, ...props }: Omit<Props, "dims"> & { part: Pick<SmallPart, "model" | "dims"> }) {
  const Model = MODELS[part.model];
  return <Model dims={part.dims} {...props} />;
}

// axis를 로컬 +Y, up을 로컬 +Z로 보내는 회전. up이 없으면 axis에 수직인 아무 방향.
export function orientation(axis: [number, number, number], up?: [number, number, number]) {
  const y = new THREE.Vector3(...axis).normalize();
  const z = up ? new THREE.Vector3(...up) : new THREE.Vector3(0, Math.abs(y.y) < 0.9 ? 1 : 0, Math.abs(y.y) < 0.9 ? 0 : 1);
  z.sub(y.clone().multiplyScalar(z.dot(y))).normalize();
  const x = new THREE.Vector3().crossVectors(y, z);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}
