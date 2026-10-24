import { useMemo } from "react";
import * as THREE from "three";
import type { RenderStyle } from "./Assembly";
import type { Scene, Vec3 } from "./types";

// 벽 고정 단계부터 보이는 방: 회반죽 벽, 걸레받이, 마루 바닥. 마지막 단계에는 물건을 채워 방 안 모습을 보여 준다.
// 단위는 cm, 원점은 바닥 중앙(세운 가구 기준), +z 앞.

const WALL_W = 500;
const WALL_H = 260;
const FLOOR_D = 260; // 벽에서 앞으로 펼친 바닥 깊이
const SKIRT_H = 7;
const SKIRT_T = 0.4; // 가구 뒷모서리와 벽 사이(0.5cm)보다 얇아야 바닥판과 겹치지 않는다

// 완성 단계 카메라: 선반·액자·화분이 한 화면에 들어오도록 조금 위 오른쪽 앞에서 본다.
export const ROOM_VIEW = { target: [16, 66, 10] as Vec3, direction: [0.38, 0.14, 1] as Vec3, distance: 340 };

function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  draw(c.getContext("2d")!);
  return new THREE.CanvasTexture(c);
}

// 가장자리를 배경으로 흐리는 alphaMap. fx·fz는 0~1 좌표에서 불투명도를 돌려준다(canvas 위쪽이 v=1).
function fadeMap(f: (u: number, v: number) => number) {
  return canvasTexture(256, 256, (g) => {
    const img = g.createImageData(256, 256);
    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 256; x++) {
        const k = Math.round(255 * f(x / 255, 1 - y / 255));
        const i = (y * 256 + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = k;
        img.data[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
  });
}
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const sideFade = (u: number) => smooth(0, 0.15, u) * smooth(1, 0.85, u);

// 고정된 난수(장면을 다시 그려도 소품 배치가 같게).
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// 스타일별 재질. 도면은 흰 바탕에 묻히지 않도록 색을 옅게만 남긴다.
function Paint({ style, color, roughness = 0.8, emissive, ...rest }: {
  style: RenderStyle; color: string; roughness?: number; emissive?: string;
} & Partial<THREE.MeshStandardMaterialParameters>) {
  if (style === "technical") {
    const c = new THREE.Color(color).lerp(new THREE.Color("#ffffff"), 0.55);
    return <meshBasicMaterial color={c} {...(rest as object)} />;
  }
  if (style === "toon") return <meshToonMaterial color={color} {...(rest as object)} />;
  return <meshStandardMaterial color={color} roughness={roughness} metalness={0}
    emissive={emissive ?? "#000000"} emissiveIntensity={emissive ? 1 : 0} {...(rest as object)} />;
}

// ── 벽 ──────────────────────────────────────────────────────────────

type WallMaps = { map: THREE.CanvasTexture; bumpMap: THREE.CanvasTexture; alphaMap: THREE.CanvasTexture };
let wallMaps: WallMaps | null = null;
function plasterMaps(): WallMaps {
  if (wallMaps) return wallMaps;
  // 회반죽 요철: 잔 알갱이(롤러 자국) 위에 큰 얼룩을 몇 겹 얹는다(1px ≈ 0.25cm).
  const random = rng(7);
  const bump = canvasTexture(2048, 1024, (g) => {
    const img = g.createImageData(2048, 1024);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = 205 + random() * 35;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    for (let i = 0; i < 2600; i++) {
      g.fillStyle = `rgba(${random() < 0.5 ? "0,0,0" : "255,255,255"},0.05)`;
      g.beginPath();
      g.ellipse(random() * 2048, random() * 1024, 6 + random() * 26, 4 + random() * 14, random() * Math.PI, 0, Math.PI * 2);
      g.fill();
    }
  });
  // 색: 칠한 벽처럼 아주 큰 얼룩으로 톤을 살짝 흔들고, 바닥 쪽 20cm 정도에 모서리 그늘을 넣는다.
  const map = canvasTexture(2048, 1024, (g) => {
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, 2048, 1024);
    g.globalAlpha = 0.16;
    g.drawImage(bump.image as HTMLCanvasElement, 0, 0);
    g.globalAlpha = 1;
    g.filter = "blur(60px)";
    for (let i = 0; i < 40; i++) {
      g.fillStyle = `rgba(${random() < 0.5 ? "120,105,90" : "255,255,255"},0.05)`;
      g.beginPath();
      g.arc(random() * 2048, random() * 1024, 80 + random() * 220, 0, Math.PI * 2);
      g.fill();
    }
    g.filter = "none";
    const shade = g.createLinearGradient(0, 1024, 0, 1024 - 80);
    shade.addColorStop(0, "rgba(60,50,40,0.22)");
    shade.addColorStop(1, "rgba(60,50,40,0)");
    g.fillStyle = shade;
    g.fillRect(0, 0, 2048, 1024);
  });
  map.colorSpace = THREE.SRGBColorSpace;
  wallMaps = { map, bumpMap: bump, alphaMap: fadeMap((u) => sideFade(u)) };
  return wallMaps;
}

const WALL_COLOR: Record<RenderStyle, string> = { technical: "#ebe9e4", toon: "#e3dccf", color: "#cfc6b7" };

function Wall({ z, style }: { z: number; style: RenderStyle }) {
  const { map, bumpMap, alphaMap } = plasterMaps();
  const common = { map, alphaMap, transparent: true, color: WALL_COLOR[style] };
  return (
    // 앞면만 그려서 뒤로 돌아가 보면 벽이 가구를 가리지 않는다. 깊이는 써서 벽에 박힌 나사·드릴 날이 가려진다.
    <mesh position={[0, WALL_H / 2, z]} receiveShadow renderOrder={-2}>
      <planeGeometry args={[WALL_W, WALL_H]} />
      {style === "technical" ? <meshBasicMaterial key="t" {...common} />
        : style === "toon" ? <meshToonMaterial key="o" {...common} />
        : <meshStandardMaterial key="c" {...common} bumpMap={bumpMap} bumpScale={0.5} roughness={0.95} metalness={0} />}
    </mesh>
  );
}

function Skirting({ z, style }: { z: number; style: RenderStyle }) {
  const { alphaMap } = plasterMaps();
  return (
    <mesh position={[0, SKIRT_H / 2, z + SKIRT_T / 2]} castShadow receiveShadow renderOrder={-1}>
      <boxGeometry args={[WALL_W, SKIRT_H, SKIRT_T]} />
      <Paint style={style} color="#f4f1ea" roughness={0.45} alphaMap={alphaMap} transparent />
    </mesh>
  );
}

// ── 바닥 ────────────────────────────────────────────────────────────

const FLOOR_PX = 4; // 1cm당 픽셀
const PLANK_W = 14;
type FloorMaps = { map: THREE.CanvasTexture; alphaMap: THREE.CanvasTexture };
let floorMaps: FloorMaps | null = null;
// 오크 사진을 판마다 다른 자리에서 잘라 깐 마루. 판 길이는 엇갈리고, 판마다 색을 조금씩 다르게 태운다.
function planksMaps(): FloorMaps {
  if (floorMaps) return floorMaps;
  const W = WALL_W * FLOOR_PX, H = FLOOR_D * FLOOR_PX;
  const map = canvasTexture(W, H, (g) => {
    g.fillStyle = "#9a7350";
    g.fillRect(0, 0, W, H);
  });
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;
  const img = new Image();
  img.onload = () => {
    // 오크 텍스처 한 장이 120×60cm라서 같은 축척으로 줄인 무늬를 판마다 옮겨 찍는다.
    const tile = document.createElement("canvas");
    tile.width = 120 * FLOOR_PX;
    tile.height = 60 * FLOOR_PX;
    tile.getContext("2d")!.drawImage(img, 0, 0, tile.width, tile.height);
    const g = (map.image as HTMLCanvasElement).getContext("2d")!;
    const pattern = g.createPattern(tile, "repeat")!;
    const random = rng(42);
    for (let y = 0; y < H; y += PLANK_W * FLOOR_PX) {
      let x = -random() * 120 * FLOOR_PX;
      while (x < W) {
        const len = (90 + random() * 90) * FLOOR_PX;
        const h = PLANK_W * FLOOR_PX;
        pattern.setTransform(new DOMMatrix().translate(random() * tile.width, random() * tile.height));
        g.fillStyle = pattern;
        g.fillRect(x, y, len, h);
        g.fillStyle = `rgba(70,38,16,${0.18 + random() * 0.2})`;
        g.fillRect(x, y, len, h);
        g.strokeStyle = "rgba(35,20,8,0.55)";
        g.lineWidth = 1.2;
        g.strokeRect(x + 0.5, y + 0.5, len - 1, h - 1);
        x += len;
      }
    }
    map.needsUpdate = true;
  };
  img.src = "/textures/oak/base.jpg";
  // 벽 쪽(v=1)은 진하게 두고 앞쪽과 양옆으로 흐린다.
  floorMaps = { map, alphaMap: fadeMap((u, v) => sideFade(u) * smooth(0, 0.45, v)) };
  return floorMaps;
}

function Floor({ z, style }: { z: number; style: RenderStyle }) {
  const { map, alphaMap } = planksMaps();
  return (
    <mesh position={[0, -0.02, z + FLOOR_D / 2]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow renderOrder={-3}>
      <planeGeometry args={[WALL_W, FLOOR_D]} />
      {style === "technical"
        ? <meshBasicMaterial key="t" color="#f1f0ec" alphaMap={alphaMap} transparent />
        : style === "toon"
          ? <meshToonMaterial key="o" map={map} color="#f0e2cf" alphaMap={alphaMap} transparent />
          : <meshStandardMaterial key="c" map={map} roughness={0.55} metalness={0} alphaMap={alphaMap} transparent />}
    </mesh>
  );
}

// 벽에 붙은 가구 뒤의 그늘: 가구 외곽보다 조금 큰 둥근 사각형을 흐리게 그린 텍스처.
const WALL_SHADE_PAD = 10;
let wallShade: THREE.CanvasTexture | null = null;
function wallShadeMap() {
  if (wallShade) return wallShade;
  const pad = 256 * 0.12;
  // alphaMap은 밝기(G 채널)를 불투명도로 쓴다: 검은 바탕에 흰 사각형.
  wallShade = canvasTexture(256, 256, (g) => {
    g.fillStyle = "#000";
    g.fillRect(0, 0, 256, 256);
    g.filter = "blur(14px)";
    g.fillStyle = "#fff";
    g.beginPath();
    g.roundRect(pad, pad, 256 - pad * 2, 256 - pad * 2, 10);
    g.fill();
  });
  return wallShade;
}

// 가구 묶음 안에 넣어서, 가구를 옆으로 비키면 그늘도 같이 움직인다.
export function WallShade({ size, z }: { size: Vec3; z: number }) {
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

// 벽·걸레받이·바닥. 가구를 옮겨도 움직이지 않는다.
export function RoomShell({ wallZ, style }: { wallZ: number; style: RenderStyle }) {
  return (
    <>
      <Wall z={wallZ} style={style} />
      <Skirting z={wallZ} style={style} />
      <Floor z={wallZ} style={style} />
    </>
  );
}

// ── 완성 단계 소품: 방 ─────────────────────────────────────────────

// 액자 그림: 따뜻한 색 덩어리 몇 개를 얹은 추상화.
function artMap(seed: number) {
  const random = rng(seed);
  const t = canvasTexture(300, 400, (g) => {
    g.fillStyle = "#f3eee4";
    g.fillRect(0, 0, 300, 400);
    const colors = ["#c4673f", "#8f9d7a", "#e0b56a", "#3f4a5a", "#d9a38a"];
    for (let i = 0; i < 4; i++) {
      g.fillStyle = colors[(seed + i) % colors.length];
      g.beginPath();
      if (i % 2 === 0) g.arc(60 + random() * 180, 80 + random() * 240, 40 + random() * 60, 0, Math.PI * 2);
      else g.roundRect(30 + random() * 120, 60 + random() * 200, 80 + random() * 100, 60 + random() * 120, 60);
      g.fill();
    }
    g.strokeStyle = "#2b2b2b";
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(40, 300 + random() * 60);
    g.bezierCurveTo(120, 200, 180, 380, 260, 260 + random() * 60);
    g.stroke();
  });
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function Frame({ at, size, seed, style }: { at: Vec3; size: [number, number]; seed: number; style: RenderStyle }) {
  const [w, h] = size;
  const art = useMemo(() => artMap(seed), [seed]);
  return (
    <group position={at}>
      <mesh position={[0, 0, 1]} castShadow>
        <boxGeometry args={[w, h, 2]} />
        <Paint style={style} color="#2a2522" roughness={0.6} />
      </mesh>
      {/* 흰 매트와 그림 */}
      <mesh position={[0, 0, 2.02]}>
        <planeGeometry args={[w - 2.4, h - 2.4]} />
        <Paint style={style} color="#fbfaf6" roughness={0.9} />
      </mesh>
      <mesh position={[0, 0, 2.04]}>
        <planeGeometry args={[w * 0.62, h * 0.62]} />
        <Paint style={style} color="#ffffff" map={art} roughness={0.9} />
      </mesh>
    </group>
  );
}

// 잎: 납작하게 누른 구. 줄기 끝에서 바깥으로 비스듬히 뻗는다.
function Leaves({ count, seed, height, spread, leaf, color, style }: {
  count: number; seed: number; height: [number, number]; spread: number; leaf: Vec3; color: string; style: RenderStyle;
}) {
  const leaves = useMemo(() => {
    const random = rng(seed);
    return Array.from({ length: count }, (_, i) => {
      const a = i * 2.39996 + random() * 0.4;
      const y = height[0] + (height[1] - height[0]) * (i / Math.max(1, count - 1)) + random() * 4;
      const r = spread * (0.5 + random() * 0.5);
      const pos: Vec3 = [Math.cos(a) * r, y, Math.sin(a) * r];
      const base = new THREE.Vector3(pos[0] * 0.35, y - spread * 0.7, pos[2] * 0.35);
      const dir = new THREE.Vector3(...pos).sub(base);
      const stem = {
        mid: base.clone().addScaledVector(dir, 0.5).toArray() as Vec3,
        len: dir.length(),
        q: new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize()),
      };
      return { pos, rot: [0.5 + random() * 0.5, -a + Math.PI / 2, 0] as Vec3, stem };
    });
  }, [count, seed, height, spread]);
  return (
    <>
      {leaves.map((l, i) => (
        <group key={i}>
          {/* 잎 아래로 짧게 이어지는 잎자루. 잎에서 화분 가운데 쪽 아래로 뻗는다. */}
          <mesh position={l.stem.mid} quaternion={l.stem.q}>
            <cylinderGeometry args={[0.18, 0.28, l.stem.len, 5]} />
            <Paint style={style} color="#5d6b3a" />
          </mesh>
          <mesh position={l.pos} rotation={l.rot} scale={leaf} castShadow>
            <sphereGeometry args={[1, 12, 8]} />
            <Paint style={style} color={i % 3 === 0 ? color : new THREE.Color(color).offsetHSL(0, 0, 0.06).getStyle()} roughness={0.6} />
          </mesh>
        </group>
      ))}
    </>
  );
}

function Pot({ r, h, color, style }: { r: number; h: number; color: string; style: RenderStyle }) {
  return (
    <>
      <mesh position={[0, h / 2, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[r, r * 0.78, h, 32]} />
        <Paint style={style} color={color} roughness={0.7} />
      </mesh>
      <mesh position={[0, h - 1, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[r * 0.94, 32]} />
        <Paint style={style} color="#3b2d22" roughness={1} />
      </mesh>
    </>
  );
}

let rugTexture: THREE.CanvasTexture | null = null;
function rugMap() {
  if (rugTexture) return rugTexture;
  const random = rng(11);
  rugTexture = canvasTexture(512, 320, (g) => {
    g.fillStyle = "#e9e1d3";
    g.fillRect(0, 0, 512, 320);
    // 짠 결: 가는 가로줄을 촘촘히
    for (let y = 0; y < 320; y += 2) {
      g.fillStyle = `rgba(120,100,80,${0.04 + random() * 0.05})`;
      g.fillRect(0, y, 512, 1);
    }
    g.strokeStyle = "#b8836a";
    g.lineWidth = 10;
    g.strokeRect(22, 22, 468, 276);
    g.strokeStyle = "#5d6b6a";
    g.lineWidth = 3;
    g.strokeRect(42, 42, 428, 236);
    g.fillStyle = "#b8836a";
    for (let i = 0; i < 5; i++) {
      g.beginPath();
      g.moveTo(106 + i * 75, 160);
      g.lineTo(136 + i * 75, 120);
      g.lineTo(166 + i * 75, 160);
      g.lineTo(136 + i * 75, 200);
      g.closePath();
      g.fill();
    }
  });
  rugTexture.colorSpace = THREE.SRGBColorSpace;
  return rugTexture;
}

// 완성 단계의 방: 벽에 건 액자, 옆의 큰 화분, 앞의 러그. 가구 좌표가 아니라 방(바닥 중앙) 좌표.
export function RoomDecor({ scene, wallZ, style }: { scene: Scene; wallZ: number; style: RenderStyle }) {
  const [w, h, d] = scene.size;
  return (
    <>
      <Frame at={[-12, h + 66, wallZ]} size={[44, 58]} seed={3} style={style} />
      <Frame at={[28, h + 60, wallZ]} size={[28, 36]} seed={8} style={style} />
      <group position={[w / 2 + 52, 0, wallZ + 24]}>
        <Pot r={12} h={26} color="#e7e1d6" style={style} />
        <Leaves count={18} seed={5} height={[38, 92]} spread={20} leaf={[5, 0.5, 9]} color="#24461f" style={style} />
      </group>
      <mesh position={[4, 0.3, wallZ + d + 48]} receiveShadow>
        <boxGeometry args={[170, 0.6, 106]} />
        <Paint style={style} color="#ffffff" map={rugMap()} roughness={1} />
      </mesh>
    </>
  );
}

// ── 완성 단계 소품: 선반 안 ─────────────────────────────────────────

const BOOK_COLORS = ["#7b3b2e", "#d8cbb0", "#2f4858", "#c9a24a", "#556b4a", "#e6e1d6", "#8a5a44", "#3d3d3d", "#a7b7b5"];

function Books({ count, seed, origin, style, lying = false }: {
  count: number; seed: number; origin: Vec3; style: RenderStyle; lying?: boolean;
}) {
  const books = useMemo(() => {
    const random = rng(seed);
    let x = 0;
    return Array.from({ length: count }, (_, i) => {
      const t = 1.6 + random() * 2.4, h = 21 + random() * 8, depth = 15 + random() * 6;
      const b = { t, h, depth, x: x + t / 2, color: BOOK_COLORS[(seed + i * 4) % BOOK_COLORS.length], lean: 0 };
      x += t + 0.05;
      return b;
    });
  }, [count, seed]);
  return (
    <group position={origin}>
      {books.map((b, i) => lying ? (
        // 눕힌 책: 아래에서부터 쌓는다.
        <mesh key={i} position={[0, books.slice(0, i).reduce((s, q) => s + q.t, 0) + b.t / 2, 0]}
          rotation={[0, (i % 2 ? 0.08 : -0.05), 0]} castShadow receiveShadow>
          <boxGeometry args={[b.h, b.t, b.depth]} />
          <Paint style={style} color={b.color} roughness={0.7} />
        </mesh>
      ) : (
        <mesh key={i} position={[b.x, b.h / 2, 0]} castShadow receiveShadow>
          <boxGeometry args={[b.t, b.h, b.depth]} />
          <Paint style={style} color={b.color} roughness={0.7} />
        </mesh>
      ))}
    </group>
  );
}

// 천 수납함: 칸에 꼭 맞는 상자, 앞면에 손잡이 구멍.
function FabricBox({ size, color, style }: { size: Vec3; color: string; style: RenderStyle }) {
  const [w, h, d] = size;
  return (
    <group>
      <mesh position={[0, h / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[w, h, d]} />
        <Paint style={style} color={color} roughness={1} />
      </mesh>
      <mesh position={[0, h * 0.78, d / 2 + 0.02]}>
        <planeGeometry args={[w * 0.32, h * 0.1]} />
        <Paint style={style} color="#2a2522" roughness={1} />
      </mesh>
    </group>
  );
}

function Lamp({ style }: { style: RenderStyle }) {
  return (
    <group>
      <mesh position={[0, 1, 0]} castShadow>
        <cylinderGeometry args={[5, 5.5, 2, 24]} />
        <Paint style={style} color="#d8d3c9" roughness={0.4} />
      </mesh>
      <mesh position={[0, 14, 0]}>
        <cylinderGeometry args={[0.5, 0.5, 26, 8]} />
        <Paint style={style} color="#b49a6a" roughness={0.3} />
      </mesh>
      <mesh position={[0, 29, 0]} castShadow>
        <cylinderGeometry args={[7, 11, 15, 32, 1, true]} />
        <Paint style={style} color="#f4ead6" emissive={style === "color" ? "#6e5a36" : undefined}
          roughness={1} side={THREE.DoubleSide} />
      </mesh>
      {style === "color" && <pointLight position={[0, 26, 0]} color="#ffd29a" intensity={0.8} distance={140} decay={0} />}
    </group>
  );
}

// 선반 칸에 꽂은 책, 수납함, 작은 화분과 위에 올린 스탠드·꽃병. 가구 묶음 안(가구 좌표)에 넣는다.
export function ShelfDecor({ scene, style }: { scene: Scene; style: RenderStyle }) {
  const [w, h, d] = scene.size;
  // 2×2 칸: 바깥 판(가장 두꺼운 판)과 칸막이(가장 얇은 판) 두께로 칸 크기를 잡는다.
  const thick = scene.panels.map((p) => Math.min(...p.size));
  const T = Math.max(...thick), t = Math.min(...thick);
  const cw = (w - 2 * T - t) / 2, ch = (h - 2 * T - t) / 2;
  const cx = t / 2 + cw / 2;
  const low = T, high = T + ch + t;
  const back = -d / 2 + 2;
  return (
    <>
      {/* 왼쪽 위: 세운 책 한 줄 + 눕힌 책 */}
      <Books count={9} seed={1} origin={[-cx - cw / 2 + 1, high, back + 10]} style={style} />
      <Books count={3} seed={4} origin={[-cx + cw / 2 - 12, high, back + 12]} style={style} lying />
      {/* 오른쪽 위: 작은 화분과 기대 세운 액자 */}
      <group position={[cx + 5, high, back + 16]}>
        <Pot r={5.5} h={10} color="#c7764f" style={style} />
        <Leaves count={10} seed={9} height={[12, 22]} spread={6} leaf={[2.6, 0.3, 4.5]} color="#35602c" style={style} />
      </group>
      <group position={[cx - 8, high, back + 8]} rotation={[-0.12, 0.15, 0]}>
        <mesh position={[0, 10, 0]} castShadow>
          <boxGeometry args={[14, 18, 1.2]} />
          <Paint style={style} color="#e8e2d6" roughness={0.6} />
        </mesh>
      </group>
      {/* 아래 왼쪽: 천 수납함, 아래 오른쪽: 눕힌 책과 그릇 */}
      <group position={[-cx, low, 1.5]}>
        <FabricBox size={[cw - 1.5, ch - 1.5, d - 4]} color="#a9a59c" style={style} />
      </group>
      <Books count={4} seed={6} origin={[cx - 4, low, back + 12]} style={style} lying />
      <mesh position={[cx + 10, low + 3, back + 22]} castShadow>
        <sphereGeometry args={[6, 24, 12, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2]} />
        <Paint style={style} color="#2f4858" roughness={0.3} side={THREE.DoubleSide} />
      </mesh>
      {/* 윗판: 스탠드와 꽃병 */}
      <group position={[w / 2 - 14, h, -2]}>
        <Lamp style={style} />
      </group>
      <group position={[-w / 2 + 14, h, 0]}>
        <mesh position={[0, 9, 0]} castShadow>
          <cylinderGeometry args={[3, 4.2, 18, 24]} />
          <Paint style={style} color="#ece6da" roughness={0.35} />
        </mesh>
        {[-0.25, 0.05, 0.3].map((a, i) => (
          <mesh key={i} position={[Math.sin(a) * 12, 18 + 13, 0]} rotation={[0, 0, -a]}>
            <cylinderGeometry args={[0.18, 0.25, 28, 5]} />
            <Paint style={style} color="#7a5a3a" />
          </mesh>
        ))}
      </group>
    </>
  );
}
