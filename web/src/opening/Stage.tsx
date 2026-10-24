// 오프닝 3D 장면. 모든 움직임은 clock.t(초)로 계산한다. 화면 위 글자·목록은 Opening.tsx가 맡는다.
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { ContactShadows, Grid, Html, Line, useTexture } from "@react-three/drei";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import type { Line2, LineSegments2 } from "three-stdlib";
import { LabelTracker, PartsLayout, type LabelEls, type Layout } from "../PartsCheck";
import { woodBox } from "../wood";
import type { Panel, Scene, Vec3 } from "../types";
import {
  APP_FOV, BOOK, EXPLODE, FINDS, FLOAT, HIGHLIGHT, ORDER, PAGE_H, PAGE_PX, PAGE_W, PAPER_SCALE, PLAN_BOX, PLAN_CENTER,
  RIGHT_PAGE, SHEETS, STAND, T, appPrepCamera, cardStart, clock, findAppear, inCubic, inOut, mix, mixV,
  outCubic, pageToBook, pageUrl, play, seg, stop, useClock,
} from "./timeline";
import { CYAN, appBackground, flipSheet, lieSheet, paperMaterial, stripGeometry, woodMaterial, type WoodUniforms } from "./materials";

// 9쪽 부품 카드가 날아갈 출발점(화면 픽셀). Opening.tsx가 읽는다.
export const findRects: { x: number; y: number; w: number; h: number }[] = FINDS.map(() => ({ x: 0, y: 0, w: 0, h: 0 }));

const NAVY = "#07111f";
const EDGE_WOOD = new THREE.Color("#7a5532"); // App 원목 모드의 판 외곽선
const CYAN_HDR = CYAN.clone().multiplyScalar(2.4);
const ORANGE = new THREE.Color(HIGHLIGHT);

// 어두운 구간(청사진 ~ 원목 입히기 전)의 정도 0~1. 발광·격자·배경이 함께 따른다.
const darkness = (t: number) => seg(t, ...T.darken) * (1 - seg(t, ...T.lighten));

// ── 카메라 ────────────────────────────────────────────────
type Shot = { pos: Vec3; target: Vec3 };
function useShots(layout: Layout): (t: number) => Shot {
  const { size } = useThree();
  return useMemo(() => {
    const aspect = size.width / size.height;
    const tan = Math.tan(THREE.MathUtils.degToRad(APP_FOV / 2));
    // ①~④: 펼친 책이 오른쪽 부품 목록을 피해 왼쪽에 오도록
    const wide = aspect >= 1.1;
    const usable = wide ? 1 - 420 / size.width : 0.94;
    const dist = Math.max((PAGE_H * 1.42) / (2 * tan), (PAGE_W * 2 * 1.08) / (2 * tan * aspect * usable));
    const visW = 2 * dist * tan * aspect;
    const shift = wide ? (0.5 - usable / 2) * visW : 0;
    // 아래 진행 문구 자리를 비우려고 책을 화면 위쪽으로 조금 올린다.
    const book: Shot = { pos: [BOOK[0] + shift, BOOK[1] - 9, dist], target: [BOOK[0] + shift, BOOK[1] - 9, 0] };
    const far = Math.max(1, 1.5 / aspect);
    const home = new THREE.Vector3(150, 118, 200).normalize();
    const around = (target: Vec3, d: number): Shot => ({
      target, pos: new THREE.Vector3(...target).addScaledVector(home, d * far).toArray() as Vec3,
    });
    // 10쪽이 제자리에서 누울 때 위에서 내려다보는 자리 → 바닥에 깔린 (i) 그림 쪽
    const hinge: Vec3 = [BOOK[0] + PAGE_W / 2, BOOK[1] - PAGE_H / 2, BOOK[2] - PAGE_H / 2];
    const lying: Shot = { target: hinge, pos: [hinge[0] + 40 * far, hinge[1] + 150 * far, hinge[2] + 150 * far] };
    const planTarget: Vec3 = [PLAN_CENTER[0], 0, PLAN_CENTER[2] - 10];
    const floor: Shot = { target: planTarget, pos: [planTarget[0] + 45 * far, 205 * far, planTarget[2] + 185 * far] };
    const exploded = around([0, 64, 0], 345);
    const assembled = around([0, 36, 0], 290);
    const prep = appPrepCamera(layout.radius);
    const keys: [number, Shot][] = [
      [T.lie[0], book], [T.lie[1], lying], [T.glide[1], floor], [T.lift - 0.2, floor], [12.4, exploded], [T.snap, exploded],
      [T.ready + 0.3, assembled], [T.final[0], assembled], [T.final[1], prep],
    ];
    return (t: number) => {
      if (t <= keys[0][0]) return book;
      for (let i = 1; i < keys.length; i++) {
        const [t1, b] = keys[i];
        if (t <= t1) {
          const [t0, a] = keys[i - 1];
          const u = inOut(seg(t, t0, t1));
          return { pos: mixV(a.pos, b.pos, u), target: mixV(a.target, b.target, u) };
        }
      }
      return prep;
    };
  }, [layout, size]);
}

function CameraPath({ layout }: { layout: Layout }) {
  const shot = useShots(layout);
  const { camera } = useThree();
  useFrame(() => {
    const s = shot(Math.max(0, clock.t));
    camera.position.set(...s.pos);
    camera.lookAt(...s.target);
  });
  return null;
}

// ── 발광 효과(three 기본 포함 기능, 새 설치 없음) ─────────────────
function Effects({ bloomOn }: { bloomOn: boolean }) {
  const { gl, scene, camera, size } = useThree();
  const [composer, bloom] = useMemo(() => {
    const c = new EffectComposer(gl);
    c.addPass(new RenderPass(scene, camera));
    const b = new UnrealBloomPass(new THREE.Vector2(256, 256), 0, 0.55, 1.05);
    c.addPass(b);
    c.addPass(new OutputPass());
    return [c, b] as const;
  }, [gl, scene, camera]);
  useEffect(() => {
    composer.setPixelRatio(gl.getPixelRatio());
    composer.setSize(size.width, size.height);
  }, [composer, gl, size]);
  useEffect(() => () => composer.dispose(), [composer]);
  useFrame(() => {
    const strength = bloomOn ? 1.0 * darkness(clock.t) : 0;
    bloom.enabled = strength > 0.01;
    bloom.strength = strength;
    composer.render();
  }, 1);
  return null;
}

// ── 배경: App과 같은 밝은 그라데이션 + SF 구간의 남색 막 ───────────
function Backdrop() {
  const { scene } = useThree();
  const dim = useRef<THREE.MeshBasicMaterial>(null);
  useEffect(() => {
    const tex = appBackground();
    scene.background = tex;
    return () => { scene.background = null; tex.dispose(); };
  }, [scene]);
  useFrame(() => {
    if (dim.current) dim.current.opacity = darkness(clock.t);
  });
  return (
    <mesh renderOrder={-10}>
      <sphereGeometry args={[1500, 24, 12]} />
      <meshBasicMaterial ref={dim} color={NAVY} side={THREE.BackSide} transparent opacity={0} depthWrite={false} />
    </mesh>
  );
}

// App의 원목 모드와 같은 조명
function Lights() {
  const { gl, scene } = useThree();
  useEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = env;
    scene.environmentIntensity = 0.9;
    return () => { scene.environment = null; env.dispose(); pmrem.dispose(); };
  }, [gl, scene]);
  return (
    <>
      <ambientLight intensity={0.25} />
      <directionalLight position={[80, 160, 100]} intensity={1.6} castShadow
        shadow-mapSize={[2048, 2048]} shadow-camera-left={-120} shadow-camera-right={120}
        shadow-camera-top={120} shadow-camera-bottom={-120} />
    </>
  );
}

// ── ③ 책: 표지가 나타나고 세 장 넘겨 9·10쪽에서 멈춘다 ─────────────
function usePages() {
  const pages = [...new Set([...SHEETS.flatMap((s) => [s.front, s.back]), RIGHT_PAGE])];
  const textures = useTexture(pages.map(pageUrl));
  const map = useMemo(() => {
    const m: Record<number, THREE.Texture> = {};
    pages.forEach((p, i) => {
      const t = textures[i];
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 8;
      m[p] = t;
    });
    return m;
  }, [textures]); // eslint-disable-line react-hooks/exhaustive-deps
  return map;
}

// 마지막 장(왼쪽에 남는 9쪽)만 사라질 때 투명해진다. 나머지는 불투명해서 뒷장이 비치지 않는다.
const LAST = SHEETS.length - 1;
const covered = (index: number, t: number) => index < LAST && t >= T.flips[LAST] + T.flipDur;

function Sheet({ index, front, back }: { index: number; front: THREE.Texture; back: THREE.Texture }) {
  const { geo, rest } = useMemo(() => stripGeometry(PAGE_W, PAGE_H, 36, 1, "left"), []);
  const fades = index === LAST;
  const meshes = useRef<(THREE.Mesh | null)[]>([]);
  const frontMat = useMemo(() => {
    const m = paperMaterial(front, fades);
    m.side = THREE.FrontSide;
    return m;
  }, [front]);
  const backMat = useMemo(() => {
    const m = paperMaterial(back, fades);
    m.side = THREE.BackSide;
    m.uniforms.uFlip.value = 1;
    return m;
  }, [back]);
  const last = useRef(-1);
  useFrame(() => {
    const t = clock.t;
    const start = T.flips[index];
    const theta = Math.PI * inOut(seg(t, start, start + T.flipDur));
    // 오른쪽에서는 먼저 넘길 장이 위, 왼쪽에 내려앉으면 나중 장이 위
    const lift = theta < Math.PI / 2 ? (SHEETS.length - index) * 0.08 : (index + 1) * 0.08;
    if (theta !== last.current) {
      flipSheet(geo, rest, PAGE_W, theta, lift);
      last.current = theta;
    }
    const o = fades ? bookOpacity(t) : 1;
    frontMat.uniforms.uOpacity.value = o;
    backMat.uniforms.uOpacity.value = o;
    meshes.current.forEach((m) => { if (m) m.visible = !covered(index, t); });
  });
  useEffect(() => () => { geo.dispose(); frontMat.dispose(); backMat.dispose(); }, [geo, frontMat, backMat]);
  return (
    <>
      <mesh ref={(m) => { meshes.current[0] = m; }} geometry={geo} material={frontMat} renderOrder={1} />
      <mesh ref={(m) => { meshes.current[1] = m; }} geometry={geo} material={backMat} renderOrder={1} />
    </>
  );
}

const bookOpacity = (t: number) => 1 - seg(t, T.lie[0], T.lie[0] + 0.45);

function ScanBar() {
  const ref = useRef<THREE.Mesh>(null);
  const mat = useMemo(() => new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { uColor: { value: ORANGE.clone() }, uOpacity: { value: 0 } },
    vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
    // 아래로 내려가며 훑으므로 빛줄기 위쪽에 옅은 꼬리를 남긴다.
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uOpacity; varying vec2 vUv;
      void main(){
        float core = exp(-pow((vUv.y - 0.06) / 0.035, 2.0));
        float trail = smoothstep(0.06, 1.0, vUv.y) * (1.0 - vUv.y) * 0.55;
        gl_FragColor = vec4(uColor, (core + trail) * uOpacity);
        #include <colorspace_fragment>
      }`,
  }), []);
  useFrame(() => {
    const t = clock.t;
    const u = seg(t, ...T.scan);
    if (ref.current) ref.current.position.y = mix(PAGE_H / 2 + 6, -PAGE_H / 2 - 2, u) + 8;
    mat.uniforms.uOpacity.value = Math.min(seg(t, T.scan[0], T.scan[0] + 0.15), 1 - seg(t, T.scan[1] - 0.15, T.scan[1]));
  });
  return (
    <mesh ref={ref} material={mat} position={[0, 0, 0.7]} renderOrder={3}>
      <planeGeometry args={[PAGE_W * 2 + 6, 16]} />
    </mesh>
  );
}

// ③ 인식 테두리 + 꼬리표. ④에서 카드가 떠날 출발점(화면 좌표)도 여기서 잰다.
function Finds({ book }: { book: React.RefObject<THREE.Group | null> }) {
  const lines = useRef<(Line2 | null)[]>([]);
  const fills = useRef<(THREE.Mesh | null)[]>([]);
  const tags = useRef<(HTMLDivElement | null)[]>([]);
  const { camera, size } = useThree();
  const shapes = useMemo(() => FINDS.map((f) => {
    const [x1, y1, x2, y2] = f.box;
    const a = pageToBook(f.page, x1, y1), b = pageToBook(f.page, x2, y2);
    const pts: Vec3[] = [[a[0], a[1], a[2]], [b[0], a[1], a[2]], [b[0], b[1], a[2]], [a[0], b[1], a[2]], [a[0], a[1], a[2]]];
    const w = b[0] - a[0], h = a[1] - b[1];
    return { pts, perimeter: 2 * (w + h), center: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, a[2] - 0.05] as Vec3, w, h, a, b };
  }), []);
  const v = useMemo(() => new THREE.Vector3(), []);
  useFrame(() => {
    const t = clock.t;
    const away = seg(t, T.lie[0], T.lie[0] + 0.5);
    FINDS.forEach((f, i) => {
      const s = shapes[i];
      const p = inOut(seg(t, findAppear(f), findAppear(f) + 0.35));
      const left = seg(t, cardStart(i), cardStart(i) + 0.2); // 카드가 떨어져 나간 뒤에는 흐리게
      const line = lines.current[i];
      if (line) {
        const m = line.material;
        m.dashSize = p * s.perimeter + 0.001;
        m.gapSize = s.perimeter * 2;
        m.opacity = (1 - 0.55 * left) * (1 - away);
      }
      const fill = fills.current[i];
      if (fill) (fill.material as THREE.MeshBasicMaterial).opacity = 0.1 * p * (1 - left) * (1 - away);
      const tag = tags.current[i];
      if (tag) {
        tag.style.opacity = String(seg(t, findAppear(f) + 0.15, findAppear(f) + 0.4) * (1 - 0.6 * left) * (1 - away));
        tag.style.visibility = t < findAppear(f) || away >= 1 ? "hidden" : "visible";
      }
    });
    // ④ 직전·도중에 카드 출발점을 잰다(카메라는 이때 멈춰 있다).
    const g = book.current;
    if (g && t > T.cards - 1 && t < T.cards + 2) {
      shapes.forEach((s, i) => {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const x of [s.a[0], s.b[0]]) for (const y of [s.a[1], s.b[1]]) {
          v.set(x, y, 0.3);
          g.localToWorld(v).project(camera);
          const px = ((v.x + 1) / 2) * size.width, py = ((1 - v.y) / 2) * size.height;
          minX = Math.min(minX, px); maxX = Math.max(maxX, px); minY = Math.min(minY, py); maxY = Math.max(maxY, py);
        }
        findRects[i] = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
      });
    }
  });
  return (
    <>
      {FINDS.map((f, i) => (
        <group key={i}>
          <Line ref={(l) => { lines.current[i] = l as unknown as Line2; }} points={shapes[i].pts} color={HIGHLIGHT}
            lineWidth={2} dashed dashSize={0.001} gapSize={1000} transparent toneMapped={false} renderOrder={4} />
          <mesh ref={(m) => { fills.current[i] = m; }} position={shapes[i].center} renderOrder={2}>
            <planeGeometry args={[shapes[i].w, shapes[i].h]} />
            <meshBasicMaterial color={HIGHLIGHT} transparent opacity={0} depthWrite={false} />
          </mesh>
          <Html position={[shapes[i].a[0], shapes[i].a[1], 0.4]} zIndexRange={[6, 0]} style={{ pointerEvents: "none" }}>
            <div ref={(d) => { tags.current[i] = d; }} className="op-tag" style={{ opacity: 0, visibility: "hidden" }}>{f.label}</div>
          </Html>
        </group>
      ))}
    </>
  );
}

function Book({ pages }: { pages: Record<number, THREE.Texture> }) {
  const group = useRef<THREE.Group>(null);
  const rightMat = useMemo(() => paperMaterial(pages[RIGHT_PAGE], false), [pages]);
  const rightMesh = useRef<THREE.Mesh>(null);
  useFrame(() => {
    const t = clock.t;
    const g = group.current;
    if (!g) return;
    // 덮인 책(표지만)일 때는 표지가 가운데, 첫 장을 넘기면 펼친 면이 가운데로
    const open = inOut(seg(t, T.flips[0], T.flips[0] + T.flipDur));
    const appear = outCubic(seg(t, ...T.bookIn));
    g.position.set(BOOK[0] - PAGE_W / 2 * (1 - open), BOOK[1] - 6 * (1 - appear), BOOK[2]);
    g.scale.setScalar(0.94 + 0.06 * appear);
    g.visible = t < T.lie[0] + 0.5;
    // 10쪽은 ⑤에서 바닥 종이(FloorPaper)로 넘겨준다.
    if (rightMesh.current) rightMesh.current.visible = t < T.lie[0];
  });
  return (
    <group ref={group} position={BOOK}>
      <mesh ref={rightMesh} position={[PAGE_W / 2, 0, 0]} material={rightMat}>
        <planeGeometry args={[PAGE_W, PAGE_H]} />
      </mesh>
      {SHEETS.map((s, i) => <Sheet key={i} index={i} front={pages[s.front]} back={pages[s.back]} />)}
      <ScanBar />
      <Finds book={group} />
    </group>
  );
}

// ── ⑤ 10쪽이 바닥에 누워 청사진이 된다 ──────────────────────────
function FloorPaper({ page }: { page: THREE.Texture }) {
  const group = useRef<THREE.Group>(null);
  const { geo, rest } = useMemo(() => stripGeometry(PAGE_W, PAGE_H, 1, 40, "bottom"), []);
  const mat = useMemo(() => {
    const m = paperMaterial(page);
    const [x1, y1, x2, y2] = PLAN_BOX;
    m.uniforms.uFocus.value.set(x1 / PAGE_PX.w, 1 - y2 / PAGE_PX.h, x2 / PAGE_PX.w, 1 - y1 / PAGE_PX.h);
    return m;
  }, [page]);
  const last = useRef(-1);
  useFrame(() => {
    const t = clock.t;
    const g = group.current;
    if (!g) return;
    g.visible = t >= T.lie[0] && t < T.lift + 1;
    if (!g.visible) return;
    // 1) 책 자리에서 아랫변을 경첩 삼아 뒤로 눕고 2) 누운 채 바닥으로 내려오며 커진다.
    const u = inOut(seg(t, ...T.glide));
    const start: Vec3 = [BOOK[0] + PAGE_W / 2, BOOK[1] - PAGE_H / 2, BOOK[2]];
    const end: Vec3 = [0, 0.15, PAGE_SCALE_H / 2];
    g.position.set(...mixV(start, end, u));
    g.scale.setScalar(mix(1, PAPER_SCALE, u));
    const theta = (Math.PI / 2) * inOut(seg(t, ...T.lie));
    if (theta !== last.current) {
      lieSheet(geo, rest, PAGE_H, theta);
      last.current = theta;
    }
    mat.uniforms.uSweep.value = mix(-0.05, 1.05, seg(t, ...T.blueprint));
    mat.uniforms.uFocusAmt.value = seg(t, ...T.focus);
    mat.uniforms.uOpacity.value = 1 - seg(t, T.lift, T.lift + 0.9);
  });
  useEffect(() => () => { geo.dispose(); mat.dispose(); }, [geo, mat]);
  return (
    <group ref={group} visible={false}>
      <mesh geometry={geo} material={mat} />
    </group>
  );
}
const PAGE_SCALE_H = PAGE_H * PAPER_SCALE;

function FloorGrid() {
  const ref = useRef<THREE.Mesh>(null);
  useFrame(() => {
    const m = ref.current;
    if (!m) return;
    const t = clock.t;
    const on = seg(t, T.darken[0] + 0.2, T.glide[1]) * (1 - seg(t, T.lighten[0], T.lighten[1]));
    m.visible = on > 0.01;
    (m.material as THREE.ShaderMaterial).uniforms.fadeDistance.value = 30 + 420 * on;
  });
  return (
    <Grid ref={ref} position={[0, 0.02, 0]} infiniteGrid cellSize={10} sectionSize={50} cellThickness={0.6} sectionThickness={1}
      cellColor="#1d4f73" sectionColor="#3aa9da" fadeDistance={30} fadeStrength={1.6} />
  );
}

// ── ⑤ 판 7장: 선으로 그려짐 → 일어섬 → 떠오름 → 원목 → 한 바퀴 → 착 조립 → ⑥ 1단계 자리로 ──
const STAND_Q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
const ID_Q = new THREE.Quaternion();

// 부품 확인 배치(App의 layoutParts)에서 이 판이 눕는 자세: 가장 긴 변 → x, 가장 얇은 변 → y, 나머지 → z.
function laidQuaternion(size: Vec3) {
  const order = [0, 1, 2].sort((a, b) => size[b] - size[a]); // [가장 긴, 중간, 가장 얇은] 로컬 축
  const world = [0, 0, 0];
  world[order[0]] = 0; world[order[2]] = 1; world[order[1]] = 2;
  const cols = [0, 1, 2].map((local) => new THREE.Vector3().setComponent(world[local], 1));
  const m = new THREE.Matrix4().makeBasis(cols[0], cols[1], cols[2]);
  if (m.determinant() < 0) m.makeBasis(cols[0].negate(), cols[1], cols[2]); // 상자는 대칭이라 축 하나를 뒤집어도 같다
  return new THREE.Quaternion().setFromRotationMatrix(m);
}

function Board({ panel, k, wood, laid, lift0 }: {
  panel: Panel; k: number; wood: WoodUniforms & { mat: THREE.MeshStandardMaterial }; laid: Vec3; lift0: number;
}) {
  const outer = useRef<THREE.Group>(null);
  const inner = useRef<THREE.Group>(null);
  const line = useRef<LineSegments2>(null);
  const holo = useRef<THREE.MeshBasicMaterial>(null);
  const woodMesh = useRef<THREE.Mesh>(null);
  const geometry = useMemo(() => woodBox(panel.size, panel.id), [panel]);
  const edges = useMemo(() => {
    const e = new THREE.EdgesGeometry(new THREE.BoxGeometry(...panel.size));
    const a = e.attributes.position.array as Float32Array;
    const pts: Vec3[] = [];
    for (let i = 0; i < a.length; i += 3) pts.push([a[i], a[i + 1], a[i + 2]]);
    e.dispose();
    return pts;
  }, [panel]);
  const perimeter = 4 * (panel.size[0] + panel.size[1] + panel.size[2]);
  const laidQ = useMemo(() => laidQuaternion(panel.size), [panel]);
  const q = useMemo(() => new THREE.Quaternion(), []);
  const color = useMemo(() => new THREE.Color(), []);
  useEffect(() => () => geometry.dispose(), [geometry]);

  useFrame(() => {
    const t = clock.t;
    const o = outer.current, i = inner.current;
    if (!o || !i) return;
    const tTrace = T.trace + k * 0.12, tExt = T.extrude + k * 0.06, tLift = T.lift + k * 0.08, tSnap = T.snap + k * 0.1;
    o.visible = t >= tTrace;
    if (!o.visible) return;
    const half = panel.size[2] / 2;
    const stand: Vec3 = [STAND[panel.id][0], 0, STAND[panel.id][2]];
    const air: Vec3 = [panel.pos[0] + EXPLODE[panel.id][0], panel.pos[1] + EXPLODE[panel.id][1] + FLOAT, panel.pos[2] + EXPLODE[panel.id][2]];

    // 일어서기: 바닥에 납작한 선(판 자리) → 판 깊이만큼 솟는다
    const rise = Math.max(0.002, outCubic(seg(t, tExt, tExt + 0.6)));
    const lift = inOut(seg(t, tLift, tLift + 1.0));
    const snap = inCubic(seg(t, tSnap, tSnap + 0.45));
    let pos: Vec3 = [stand[0], half * rise + 0.2, stand[2]];
    if (lift > 0) {
      pos = mixV([stand[0], half + 0.2, stand[2]], air, lift);
      pos[1] += Math.sin(Math.PI * lift) * 12;
    }
    if (snap > 0) pos = mixV(air, panel.pos, snap);
    q.slerpQuaternions(STAND_Q, ID_Q, lift);

    // ⑥ 완성품이 다시 흩어지며, 판마다 App 부품 확인 화면의 바닥 자리로 날아가 눕는다.
    const f0 = T.final[0] + k * 0.07;
    const out = inOut(seg(t, f0, f0 + 1.0));
    if (out > 0) {
      pos = mixV(panel.pos, [laid[0], laid[1] - lift0, laid[2]], out);
      pos[1] += Math.sin(Math.PI * out) * 28;
      q.slerp(laidQ, out);
    }
    const scale = 1;
    o.position.set(...pos);
    o.quaternion.copy(q);
    o.scale.setScalar(scale);
    i.scale.set(1, 1, 1);
    // 선 상태일 때만 판 깊이 축(로컬 z, 세운 자세에서 위)을 눌러 납작하게
    if (lift === 0) i.scale.set(1, 1, rise);

    // 선: 하늘색 발광 → 원목이 입혀지면 App과 같은 갈색 외곽선 → 1단계 판은 진한 주황
    const l = line.current;
    if (l) {
      const m = l.material;
      m.dashSize = inOut(seg(t, tTrace, tTrace + 0.7)) * perimeter + 0.001;
      m.gapSize = perimeter * 2;
      const toWood = seg(t, T.reveal[0] + 0.2, T.reveal[1]);
      color.copy(CYAN_HDR).lerp(EDGE_WOOD, toWood);
      m.color.copy(color);
      m.linewidth = mix(1.6, 1, toWood);
    }
    if (holo.current) holo.current.opacity = 0.09 * seg(t, tExt, tExt + 0.4) * (1 - seg(t, T.reveal[0], T.reveal[1]));
    if (woodMesh.current) woodMesh.current.visible = t >= T.reveal[0];
  });

  return (
    <group ref={outer} visible={false}>
      <group ref={inner}>
        <Line ref={line as never} points={edges} segments color={CYAN_HDR} lineWidth={1.6} dashed dashSize={0.001}
          gapSize={1000} toneMapped={false} />
        <mesh renderOrder={2}>
          <boxGeometry args={panel.size} />
          <meshBasicMaterial ref={holo} color={CYAN} transparent opacity={0} depthWrite={false} blending={THREE.AdditiveBlending} />
        </mesh>
        <mesh ref={woodMesh} geometry={geometry} material={wood.mat} castShadow receiveShadow visible={false} />
      </group>
    </group>
  );
}

function Furniture({ scene, layout }: { scene: Scene; layout: Layout }) {
  const group = useRef<THREE.Group>(null);
  const panels = useMemo(() => ORDER.map((id) => scene.panels.find((p) => p.id === id)!).filter(Boolean), [scene]);
  const woods = useMemo(() => panels.map(() => {
    const { mat, uniforms } = woodMaterial();
    return { mat, ...uniforms };
  }), [panels]);
  useEffect(() => () => woods.forEach((w) => w.mat.dispose()), [woods]);
  const lift0 = scene.floor_offset ?? 0; // 가구 전체를 이만큼 띄워 둔다(App의 세운 자세와 같다)
  const laid = useMemo(() => Object.fromEntries(
    layout.panels.filter((p) => p.copy === 0).map((p) => [p.item.key, p.pos]),
  ) as Record<string, Vec3>, [layout]);
  useFrame(() => {
    const t = clock.t;
    const g = group.current;
    if (!g) return;
    // 아래에서 위로 원목을 입힌다(월드 높이 기준)
    const r = seg(t, ...T.reveal);
    const level = r <= 0 ? -1000 : r >= 1 ? 10000 : mix(-8, 145, r);
    woods.forEach((w) => { w.uReveal.value = level; });
    const spin = inOut(seg(t, ...T.spin));
    g.rotation.set(0, spin < 1 ? Math.PI * 2 * spin : 0, 0);
    g.position.set(0, lift0, 0);
    // 마지막 판이 붙는 순간 살짝 튄다("착")
    const land = T.snap + (ORDER.length - 1) * 0.1 + 0.45;
    g.scale.setScalar(1 + 0.018 * Math.sin(Math.PI * seg(t, land, land + 0.35)));
  });
  return (
    <group ref={group}>
      {panels.map((p, k) => <Board key={p.id} panel={p} k={k} wood={woods[k]} laid={laid[p.id] ?? p.pos} lift0={lift0} />)}
    </group>
  );
}

// ⑥ 철물: App 부품 확인과 같은 컴포넌트로 종류별 칸에 떨어뜨린다(판은 위의 Board가 맡으므로 뺀다).
function Hardware({ layout }: { layout: Layout }) {
  const on = useClock((t) => t >= T.hardware);
  const cellsOnly = useMemo(() => ({ ...layout, panels: [] }), [layout]);
  return on ? <PartsLayout layout={cellsOnly} style="color" hover={null} playKey={0} /> : null;
}

function Shadows() {
  const on = useClock((t) => t >= T.snap + 0.3);
  return on ? <ContactShadows position={[0, 0.1, 0]} scale={220} blur={2.4} opacity={0.3} /> : null;
}

// 첫 화면에 머무는 동안(화면 뒤에서) 모든 재질의 셰이더를 한 번에 준비하고(안 보이는 것까지),
// 그림자가 나오는 장면을 한 번 그린 뒤, 가장 무거운 청사진 장면의 속도를 재서 느린 기기면 발광을 끈다.
// 그래서 재생 중에 처음 보이는 순간 멈칫하거나 화질이 바뀌어 튀는 일이 없다.
function Warmup({ onDone }: { onDone: (slow: boolean) => void }) {
  const { gl, scene, camera } = useThree();
  const s = useRef({ frames: 0, sum: 0, n: 0, since: 0, done: false });
  useFrame((_, dt) => {
    const w = s.current;
    if (w.done) return;
    w.frames++;
    if (w.frames === 1) {
      play(14.3, true); // 완성품 + 그림자
      // 오프닝은 발광 효과 때문에 화면이 아닌 중간 버퍼에 그리므로, 그 버퍼용 셰이더로 준비한다.
      const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
      gl.setRenderTarget(target);
      gl.compile(scene, camera);
      gl.setRenderTarget(null);
      target.dispose();
      return;
    }
    if (w.frames === 3) { play(9.9, true); return; } // 청사진 + 발광
    if (w.frames === 5) w.since = performance.now();
    if (w.frames > 5) { w.sum += dt; w.n++; }
    // 12장을 재거나 1.2초가 지나면 판단한다(느린 기기에서 오래 기다리지 않게).
    if (w.n >= 12 || (w.n > 0 && performance.now() - w.since > 1200)) {
      w.done = true;
      stop(-1);
      onDone(w.sum / w.n > 1 / 26);
    }
  });
  return null;
}

function Content({ scene, layout, bloomOn, onLoaded }: {
  scene: Scene; layout: Layout; bloomOn: boolean; onLoaded: () => void;
}) {
  const pages = usePages();
  useEffect(() => { onLoaded(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <Book pages={pages} />
      <FloorPaper page={pages[RIGHT_PAGE]} />
      <Furniture scene={scene} layout={layout} />
      <Hardware layout={layout} />
      <Effects bloomOn={bloomOn} />
    </>
  );
}

export default function Stage({ scene, layout, labelEls, running, warm, onReady }: {
  scene: Scene; layout: Layout; labelEls: LabelEls; running: boolean; warm: boolean; onReady: () => void;
}) {
  const fx = new URLSearchParams(location.search).get("fx");
  const [slow, setSlow] = useState(fx === "off");
  const [phase, setPhase] = useState<"load" | "warm" | "idle">("load");
  const loaded = () => {
    if (warm) setPhase("warm");
    else { setPhase("idle"); onReady(); }
  };
  const warmed = (isSlow: boolean) => {
    if (fx !== "on" && isSlow) setSlow(true);
    setPhase("idle");
    onReady();
  };
  const live = running || phase === "warm";
  return (
    <Canvas flat shadows dpr={slow ? 1 : [1, 1.5]} frameloop={live ? "always" : "demand"}
      camera={{ position: [0, 120, 200], fov: APP_FOV, near: 1, far: 4000 }} className="op-canvas">
      <Backdrop />
      <Lights />
      <CameraPath layout={layout} />
      <LabelTracker layout={layout} els={labelEls} />
      <FloorGrid />
      <Suspense fallback={null}>
        <Content scene={scene} layout={layout} bloomOn={!slow} onLoaded={loaded} />
      </Suspense>
      <Shadows />
      {phase === "warm" && <Warmup onDone={warmed} />}
    </Canvas>
  );
}
