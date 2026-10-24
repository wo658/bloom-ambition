import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Edges } from "@react-three/drei";
import gsap from "gsap";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { EDGE, HIGHLIGHT, Material, WallShade, type RenderStyle } from "./Assembly";
import { HardwareMesh, METAL, SPINS, orientation } from "./Hardware";
import { t } from "./lang";
import type { Panel, Scene, SmallPart, Vec3 } from "./types";
import { woodBox } from "./wood";

// 분해도: 완성된 가구를 판마다 바깥으로 펼쳐 이름을 보여 준 뒤, 조립 순서대로 다시 맞물리게 하는 연출.
// Assembly의 가구 묶음은 숨기고 같은 자리에 가벼운 복사본을 그려서 판·철물을 자유롭게 움직인다.
// 값은 모두 gsap이 state 객체에 쓰고, useFrame이 매 프레임 메쉬·카메라·DOM 이름표에 옮긴다(React 상태 없음).

const ON_WALL: SmallPart["model"][] = ["wall_mark", "wall_screw"];
const OUT = 32; // 바깥 판이 펼쳐지는 거리(cm)
const IN_MIN = 30; // 안쪽 판(칸막이·선반)이 앞으로 빠지는 거리. 가운데일수록 더 멀리(IN_MIN+IN_EXTRA).
const IN_EXTRA = 16;
const FLOAT = 6; // 펼친 동안 바닥판이 바닥에서 떠 있는 높이
const HW_MAGNIFY = 1.7; // 펼친 동안 작은 철물을 이만큼 키워서 멀리서도 보이게 한다
const HW_BACKOUT = 5; // 나사는 축을 따라 이만큼 더 풀려 나온다
const WOBBLE = 0.1; // 날아가며 기우는 각도(rad)
const OUTLINE_PAD = 0.7; // 맞물릴 때 번쩍이는 테두리 두께(cm)

// 시간표(초). 전체 약 7.5초.
const T = {
  approach: 0.9, // 카메라가 가구 앞으로 다가가는 시간
  squash: 0.45, // 웅크리기 시작
  explode: 0.85, // 펼치기 시작(웅크림을 놓는 순간)
  panelStagger: 0.075,
  hwStagger: 0.016,
  labels: 1.75,
  labelStagger: 0.06,
  reassemble: 3.85, // 다시 조립 시작(그 전까지가 멈춰 보여 주는 구간)
  landStagger: 0.27,
  travel: 0.7, // 판 하나가 제자리로 돌아오는 시간
  settle: 1.25, // 마지막 판이 닿은 뒤 영웅 구도로 물러나는 시간
};

type PanelPlan = {
  panel: Panel; disp: Vec3; dir: Vec3; interior: boolean; wobble: Vec3;
  explodeAt: number; assembleOrder: number; face: { pos: Vec3; rot: Vec3; w: number; h: number };
};
type SmallPlan = { part: SmallPart; disp: Vec3; returnOrder: number; moves: boolean };

const add = (a: Vec3, b: Vec3, k = 1): Vec3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const len = (a: Vec3) => Math.hypot(...a);
const X_AXIS = new THREE.Vector3(1, 0, 0);

// 가구 좌표의 판·철물 배치와 펼친 위치를 미리 계산한다. 마지막 단계(완성품)의 자세를 쓴다.
function plan(scene: Scene) {
  const last = scene.steps[scene.steps.length - 1];
  const [, h, d] = scene.size;
  const rot = last.pose === "lying" ? -Math.PI / 2 : 0;
  const base: Vec3 = last.pose === "lying" ? [0, d / 2, h / 2] : [0, scene.floor_offset ?? 0, 0];
  const rootPos = add(base, last.unit_offset ?? [0, 0, 0]);
  const toWorldDir = (v: Vec3) => new THREE.Vector3(...v).applyAxisAngle(X_AXIS, rot);

  // 조립 순서: 단계마다 끼우는 판(adds) 순서.
  const order = scene.steps.flatMap((s) => s.adds).filter((id, i, a) => a.indexOf(id) === i);
  const panels = scene.panels.filter((p) => order.includes(p.id));
  const box = new THREE.Box3();
  panels.forEach((p) => {
    box.expandByPoint(new THREE.Vector3(...add(p.pos, scale(p.size, -0.5))));
    box.expandByPoint(new THREE.Vector3(...add(p.pos, scale(p.size, 0.5))));
  });
  const center = box.getCenter(new THREE.Vector3()).toArray() as Vec3;
  const half = scale(box.getSize(new THREE.Vector3()).toArray() as Vec3, 0.5);

  // 바깥 판은 두께 방향으로 바깥을 향해, 안쪽 판은 칸 입구(+Z) 쪽으로 빼고 옆으로 조금 벌린다.
  let sink = 0;
  const raw = panels.map((p, idx) => {
    const off = add(p.pos, center, -1);
    const thin = p.size.indexOf(Math.min(...p.size));
    const interior = Math.abs(off[thin]) < 0.6 * half[thin];
    let disp: Vec3;
    if (!interior) {
      disp = [0, 0, 0];
      disp[thin] = Math.sign(off[thin]) * OUT;
    } else {
      const side: Vec3 = [...off];
      side[thin] = 0;
      side[2] = 0;
      const r = Math.min(1, len(side) / Math.max(...half));
      disp = add([0, 0, IN_MIN + IN_EXTRA * (1 - r)], side, 0.6);
    }
    // 바닥을 뚫고 내려가는 판은 반만 내리고, 그만큼 전체를 띄운다.
    const w = toWorldDir(disp);
    if (w.y < -0.5 * len(disp)) {
      disp = scale(disp, 0.5);
      sink = Math.max(sink, -w.y * 0.5);
    }
    // 판마다 다른 축으로 살짝 기울어지게(같은 값이 나오도록 순번으로 정한다).
    const s = idx % 2 ? -1 : 1;
    const wobble = new THREE.Vector3(Math.sin(idx * 2.3 + 1), Math.cos(idx * 1.7), Math.sin(idx * 3.1 + 2))
      .normalize().multiplyScalar(WOBBLE * s).toArray() as Vec3;
    return { p, disp, interior, wobble, thin };
  });
  // 전체를 띄우는 높이(월드 위쪽)를 가구 좌표로 돌려 둔다.
  const liftLocal = new THREE.Vector3(0, sink + FLOAT, 0).applyAxisAngle(X_AXIS, -rot).toArray() as Vec3;

  // 펼치는 순서: 바깥 판을 조립의 역순으로(윗판부터), 그다음 안쪽 판.
  const explodeSeq = [...raw].sort((a, b) =>
    (a.interior ? 1 : 0) - (b.interior ? 1 : 0) || order.indexOf(b.p.id) - order.indexOf(a.p.id));
  const panelPlans: PanelPlan[] = raw.map((r) => {
    const disp = add(r.disp, liftLocal);
    const dir = scale(r.disp, 1 / (len(r.disp) || 1));
    // 맞물릴 때 퍼지는 사각 테두리: 움직이는 방향에 수직인 면, 바깥 판은 안쪽 면, 안쪽 판은 앞면에 둔다.
    const k = dir.map(Math.abs).indexOf(Math.max(...dir.map(Math.abs)));
    const [sx, sy, sz] = r.p.size;
    const face = k === 0 ? { w: sz, h: sy, rot: [0, Math.PI / 2, 0] as Vec3 }
      : k === 1 ? { w: sx, h: sz, rot: [-Math.PI / 2, 0, 0] as Vec3 }
      : { w: sx, h: sy, rot: [0, 0, 0] as Vec3 };
    const shift: Vec3 = [0, 0, 0];
    shift[k] = (r.interior ? 1 : -1) * Math.sign(dir[k] || 1) * r.p.size[k] / 2;
    return {
      panel: r.p, disp, dir, interior: r.interior, wobble: r.wobble,
      explodeAt: explodeSeq.indexOf(r), assembleOrder: order.indexOf(r.p.id),
      face: { ...face, pos: shift },
    };
  });

  // 완성품에 남아 있는 철물(한 번만 쓰는 공구·벽에 붙는 것 제외, 다시 조인 것은 마지막 것).
  const byId = new Map<string, SmallPart>();
  scene.steps.forEach((s) => s.small.forEach((x) => { if (!x.transient && !ON_WALL.includes(x.model)) byId.set(x.id, x); }));
  const inside = (p: Panel, q: Vec3) => q.every((c, i) => Math.abs(c - p.pos[i]) <= p.size[i] / 2 + 0.3);
  const smalls: SmallPlan[] = [...byId.values()].map((part) => {
    const L = part.dims.length ?? 2;
    const probes = [0, 0.5, 1].map((f) => add(part.at, part.axis, L * f));
    const hosts = panelPlans.filter((pp) => probes.some((q) => inside(pp.panel, q)));
    // 판에 박히지 않은 것(벽 나사에 거는 고리 판)은 벽과 함께 제자리에 남는다.
    if (!hosts.length) return { part, disp: [0, 0, 0], returnOrder: -1, moves: false };
    // 두 판을 잇는 철물은 두 판 사이 틈에, 한 판에만 붙은 것은 판보다 조금 더 멀리 나온다.
    const own = hosts.reduce<Vec3>((acc, hp) => add(acc, add(hp.disp, liftLocal, -1), 1 / hosts.length), [0, 0, 0]);
    let disp = add(scale(own, hosts.length > 1 ? 1.15 : 1.3), liftLocal);
    if (SPINS.includes(part.model)) disp = add(disp, part.axis, -HW_BACKOUT);
    return { part, disp, returnOrder: Math.max(...hosts.map((hp) => hp.assembleOrder)), moves: true };
  });

  // 카메라 구도: 완성품을 감싸는 구와 펼친 상태를 감싸는 구(월드 좌표).
  const toWorld = (v: Vec3) => new THREE.Vector3(...v).applyAxisAngle(X_AXIS, rot).add(new THREE.Vector3(...rootPos));
  const sphereOf = (shift: (pp: PanelPlan) => Vec3) => {
    const b = new THREE.Box3();
    panelPlans.forEach((pp) => {
      const c = add(pp.panel.pos, shift(pp));
      b.expandByPoint(toWorld(add(c, scale(pp.panel.size, -0.5))));
      b.expandByPoint(toWorld(add(c, scale(pp.panel.size, 0.5))));
    });
    return b.getBoundingSphere(new THREE.Sphere());
  };
  return {
    rot, rootPos, center, panels: panelPlans, smalls, wall: last.wall,
    rest: sphereOf(() => [0, 0, 0]), open: sphereOf((pp) => pp.disp),
  };
}
type Plan = ReturnType<typeof plan>;

// 판 하나: 원목 판 + 맞물릴 때 번쩍이는 테두리(뒷면만 그린 조금 큰 상자) + 퍼지는 사각 파동.
function ExplodeBoard({ pp, style, groupRef, flashRef, ringRef }: {
  pp: PanelPlan; style: RenderStyle;
  groupRef: (g: THREE.Group | null) => void; flashRef: (m: THREE.Mesh | null) => void; ringRef: (m: THREE.Mesh | null) => void;
}) {
  const { panel, face } = pp;
  const geometry = useMemo(() => woodBox(panel.size, panel.id), [panel]);
  const hull = useMemo(() => new THREE.BoxGeometry(...(panel.size.map((s) => s + OUTLINE_PAD * 2) as Vec3)), [panel]);
  const frame = useMemo(() => {
    const W = 1.2;
    const s = new THREE.Shape();
    const w = face.w / 2 + W, h = face.h / 2 + W;
    s.moveTo(-w, -h); s.lineTo(w, -h); s.lineTo(w, h); s.lineTo(-w, h); s.lineTo(-w, -h);
    const hole = new THREE.Path();
    hole.moveTo(-face.w / 2, -face.h / 2); hole.lineTo(-face.w / 2, face.h / 2);
    hole.lineTo(face.w / 2, face.h / 2); hole.lineTo(face.w / 2, -face.h / 2); hole.lineTo(-face.w / 2, -face.h / 2);
    s.holes.push(hole);
    return new THREE.ShapeGeometry(s);
  }, [face]);
  useEffect(() => () => { geometry.dispose(); hull.dispose(); frame.dispose(); }, [geometry, hull, frame]);
  return (
    <group ref={groupRef} position={panel.pos}>
      <mesh geometry={geometry} castShadow receiveShadow>
        <Material style={style} color="#ffffff" wood />
        <Edges color={EDGE[style]} lineWidth={style === "technical" ? 2 : 1} />
      </mesh>
      <mesh ref={flashRef} geometry={hull} visible={false} renderOrder={5}>
        <meshBasicMaterial color={HIGHLIGHT} side={THREE.BackSide} transparent opacity={0} depthWrite={false} toneMapped={false} />
      </mesh>
      <group position={face.pos} rotation={face.rot}>
        <mesh ref={ringRef} geometry={frame} visible={false} renderOrder={6}>
          <meshBasicMaterial color={HIGHLIGHT} side={THREE.DoubleSide} transparent opacity={0} depthWrite={false} toneMapped={false} />
        </mesh>
      </group>
    </group>
  );
}

// 철물 하나: Assembly의 Small과 같은 모양·재질을 쓰되, 움직임은 분해도 상태값을 따른다.
function ExplodeSmall({ sp, materials, groupRef, scalerRef }: {
  sp: SmallPlan; materials: (part: SmallPart) => [THREE.Material, THREE.Material];
  groupRef: (g: THREE.Group | null) => void; scalerRef: (g: THREE.Group | null) => void;
}) {
  const q = useMemo(() => orientation(sp.part.axis, sp.part.up), [sp.part]);
  const [material, accent] = materials(sp.part);
  return (
    <group ref={groupRef} position={sp.part.at} quaternion={q}>
      <group ref={scalerRef}>
        <HardwareMesh part={sp.part} material={material} accent={accent} renderOrder={0} />
      </group>
    </group>
  );
}

// 펼친 동안 판 옆에 뜨는 이름표와 가는 지시선. drei Html 대신 캔버스 옆에 DOM을 직접 붙인다(TagBadge와 같은 방식).
type LabelDom = { root: HTMLDivElement; chip: HTMLDivElement; line: SVGLineElement; dot: SVGCircleElement };
function buildLabels(host: HTMLElement, p: Plan, smallCount: number) {
  const layer = document.createElement("div");
  layer.className = "explode-layer";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "explode-leaders");
  layer.appendChild(svg);
  const title = document.createElement("div");
  title.className = "explode-title";
  title.innerHTML = `<b></b><span></span>`;
  title.querySelector("b")!.textContent = t("분해도");
  title.querySelector("span")!.textContent = t("판 {p}장 · 철물 {h}개", { p: p.panels.length, h: smallCount });
  layer.appendChild(title);
  const labels: LabelDom[] = p.panels.map((pp) => {
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("pathLength", "1");
    const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    dot.setAttribute("r", "3");
    svg.append(line, dot);
    const root = document.createElement("div");
    root.className = "explode-label";
    const chip = document.createElement("div");
    chip.className = "explode-chip";
    const num = document.createElement("span");
    num.className = "explode-num";
    num.textContent = String(pp.assembleOrder + 1);
    const name = document.createElement("span");
    name.className = "explode-name";
    name.textContent = t(pp.panel.name_ko);
    const dims = document.createElement("span");
    dims.className = "explode-dims";
    dims.textContent = [...pp.panel.size].sort((a, b) => b - a).map((v) => +v.toFixed(1)).join(" × ");
    chip.append(num, name, dims);
    root.appendChild(chip);
    layer.appendChild(root);
    return { root, chip, line, dot };
  });
  host.appendChild(layer);
  return { layer, title, labels };
}

const LEADER = 64; // 판 중심에서 이름표까지(px)

export default function Explode({ scene, style, onDone }: { scene: Scene; style: RenderStyle; onDone: () => void }) {
  const { camera, controls, gl } = useThree();
  const p = useMemo(() => plan(scene), [scene]);
  const moving = p.smalls.filter((s) => s.moves).length;

  const root = useRef<THREE.Group>(null);
  const shade = useRef<THREE.Group>(null);
  const groups = useRef<(THREE.Group | null)[]>([]);
  const flashes = useRef<(THREE.Mesh | null)[]>([]);
  const rings = useRef<(THREE.Mesh | null)[]>([]);
  const smallGroups = useRef<(THREE.Group | null)[]>([]);
  const scalers = useRef<(THREE.Group | null)[]>([]);
  const dom = useRef<ReturnType<typeof buildLabels> | null>(null);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  // gsap이 값을 쓰는 상태. k: 펼친 정도(1=다 펼침, 음수=조인 쪽으로 살짝 지나침), w: 기울기, flash·ring: 맞물림 효과.
  const st = useMemo(() => ({
    panels: p.panels.map(() => ({ k: 0, w: 0, flash: 0, ring: 0 })),
    smalls: p.smalls.map(() => ({ k: 0, s: 1 })),
    unit: { sx: 1, sy: 1 },
    shade: { o: 0.45 },
    cam: { az: 0, el: 0, fit: 1, tx: 0, ty: 0, tz: 0, shake: 0, on: false },
  }), [p]);

  // 재질은 색·금속 여부별로 하나씩만 만들어 나눠 쓴다(제자리 철물과 같은 규칙).
  const materials = useMemo(() => {
    const cache = new Map<string, [THREE.Material, THREE.Material]>();
    const make = (color: string, metal: boolean): THREE.Material => {
      const common = { color, side: THREE.DoubleSide };
      if (style === "technical") return new THREE.MeshBasicMaterial(common);
      if (style === "toon") return new THREE.MeshToonMaterial(common);
      return new THREE.MeshStandardMaterial({ ...common, metalness: metal ? 0.7 : 0, roughness: metal ? 0.35 : 0.8 });
    };
    const get = (part: SmallPart) => {
      const metal = METAL.includes(part.model);
      const color = style === "technical" ? (metal ? "#b5b5b5" : "#e2e2e2") : part.color;
      const key = `${color}|${metal}`;
      if (!cache.has(key)) cache.set(key, [make(color, metal), make("#2b2b2b", false)]);
      return cache.get(key)!;
    };
    return { get, cache };
  }, [style]);
  useEffect(() => () => materials.cache.forEach(([a, b]) => { a.dispose(); b.dispose(); }), [materials]);

  useEffect(() => {
    const orbit = controls as unknown as OrbitControlsImpl | null;
    const cam = camera as THREE.PerspectiveCamera;
    // 다른 카메라 이동(단계 이동 비행)을 멈추고, 연출 동안에는 사용자가 돌리지 못하게 한다.
    gsap.killTweensOf(camera.position);
    if (orbit) { gsap.killTweensOf(orbit.target); orbit.enabled = false; }
    const host = gl.domElement.parentElement;
    if (host) dom.current = buildLabels(host, p, moving);

    // 지금 카메라 위치를 구면 좌표로 바꿔 거기서부터 이어서 움직인다.
    const target0 = orbit?.target.clone() ?? new THREE.Vector3(0, 22, 0);
    const rel = camera.position.clone().sub(target0);
    const dist0 = Math.max(rel.length(), 1);
    const narrow0 = narrowHalf(cam);
    const c = st.cam;
    const AZ_FROM = -0.45, AZ_TO = 0.38;
    c.az = Math.atan2(rel.x, rel.z);
    if (c.az - AZ_FROM > Math.PI) c.az -= Math.PI * 2;
    if (AZ_FROM - c.az > Math.PI) c.az += Math.PI * 2;
    c.el = Math.asin(THREE.MathUtils.clamp(rel.y / dist0, -1, 1));
    c.fit = dist0 * Math.sin(narrow0);
    c.tx = target0.x; c.ty = target0.y; c.tz = target0.z;
    c.shake = 0;
    c.on = true;
    const rest = p.rest, open = p.open;
    // 오른쪽 위 카드·아래 재생 막대에 가리지 않게 여유를 둔다.
    const fitRest = rest.radius * 1.2, fitOpen = open.radius * 1.0;

    const tl = gsap.timeline({ onComplete: () => onDoneRef.current() });
    const at = (pos: Vec3 | THREE.Vector3) => (Array.isArray(pos) ? { tx: pos[0], ty: pos[1], tz: pos[2] } : { tx: pos.x, ty: pos.y, tz: pos.z });

    // 1. 준비: 카메라가 가구 앞 왼쪽으로 다가가고, 가구가 살짝 웅크렸다가 튕기듯 펴진다.
    tl.to(c, { el: 0.2, fit: fitRest, ...at(rest.center), duration: T.approach, ease: "power2.inOut" }, 0);
    tl.to(c, { az: AZ_FROM, duration: T.approach, ease: "power2.inOut" }, 0);
    tl.to(st.unit, { sx: 1.012, sy: 0.978, duration: T.explode - T.squash, ease: "power2.in" }, T.squash);
    tl.to(st.unit, { sx: 1, sy: 1, duration: 0.45, ease: "back.out(3)" }, T.explode);
    // 처음부터 끝까지 한 방향으로 천천히 돌아서 깊이가 읽히게 한다.
    tl.to(c, { az: AZ_TO, duration: 6.6 - T.approach, ease: "sine.inOut" }, T.approach);

    // 2. 펼치기: 판은 바깥 판(윗판부터) → 안쪽 판 순서로 날아가며 살짝 기울고, 철물은 뒤따라 튀어나오며 커진다.
    p.panels.forEach((pp, i) => {
      const s = st.panels[i];
      const t0 = T.explode + pp.explodeAt * T.panelStagger;
      tl.to(s, { k: 1, duration: 1.15, ease: "expo.out" }, t0);
      tl.to(s, { w: 1, duration: 0.75, ease: "back.out(2.5)" }, t0);
      // 멈춰 있는 동안 숨 쉬듯 조금 더 벌어지고 기울기는 풀린다.
      tl.to(s, { k: 1.045, w: 0.4, duration: 1.5, ease: "sine.inOut" }, t0 + 1.0);
    });
    p.smalls.forEach((sp, i) => {
      if (!sp.moves) return;
      const s = st.smalls[i];
      const t0 = T.explode + 0.18 + i * T.hwStagger;
      tl.to(s, { k: 1, duration: 0.95, ease: "back.out(1.6)" }, t0);
      tl.to(s, { s: HW_MAGNIFY, duration: 0.6, ease: "back.out(2.5)" }, t0);
    });
    tl.to(st.shade, { o: 0, duration: 0.5, ease: "power1.out" }, T.explode);
    // 판이 화면 밖으로 나가지 않게 펼치기 직전부터 물러나기 시작한다.
    tl.to(c, { fit: fitOpen, duration: 1.3, ease: "power2.out" }, T.explode - 0.3);
    tl.to(c, { el: 0.3, ...at(open.center), duration: 1.6, ease: "sine.inOut" }, T.explode);

    // 3. 이름표: 지시선이 그어지고 이름표가 톡 튀어나온다.
    const d = dom.current;
    if (d) {
      tl.fromTo(d.title, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.5, ease: "power2.out" }, T.explode + 0.4);
      p.panels.forEach((pp, i) => {
        const l = d.labels[i];
        const t0 = T.labels + pp.explodeAt * T.labelStagger;
        tl.fromTo(l.line, { strokeDashoffset: 1 }, { strokeDashoffset: 0, duration: 0.35, ease: "power2.out" }, t0 - 0.05);
        tl.fromTo(l.dot, { opacity: 0 }, { opacity: 1, duration: 0.2 }, t0 - 0.05);
        tl.fromTo(l.chip, { opacity: 0, scale: 0.6 }, { opacity: 1, scale: 1, duration: 0.45, ease: "back.out(2.2)" }, t0);
      });
    }

    // 4. 다시 조립: 설명서 순서대로 하나씩, 제자리를 살짝 지나쳤다가 되돌아오며 맞물린다.
    const ordered = [...p.panels].sort((a, b) => a.assembleOrder - b.assembleOrder);
    let lastLand = T.reassemble;
    ordered.forEach((pp, n) => {
      const i = p.panels.indexOf(pp);
      const s = st.panels[i];
      const t0 = T.reassemble + n * T.landStagger;
      const land = t0 + T.travel;
      lastLand = land;
      tl.to(s, { k: -0.025, w: 0, duration: T.travel, ease: "power3.inOut" }, t0);
      tl.to(s, { k: 0, duration: 0.25, ease: "power2.out" }, land);
      tl.fromTo(s, { flash: 0.9 }, { flash: 0, duration: 0.5, ease: "power2.out", immediateRender: false }, land);
      tl.fromTo(s, { ring: 0 }, { ring: 1, duration: 0.55, ease: "power2.out", immediateRender: false }, land);
      // 이 판에 박히는 철물은 판보다 조금 먼저 자리를 찾아 들어간다.
      p.smalls.forEach((sp, j) => {
        if (!sp.moves || sp.returnOrder !== pp.assembleOrder) return;
        tl.to(st.smalls[j], { k: 0, s: 1, duration: 0.55, ease: "power3.inOut" }, t0 + 0.05 + (j % 6) * 0.012);
      });
      if (d) {
        const l = d.labels[i];
        tl.to(l.chip, { opacity: 0, scale: 0.85, duration: 0.25, ease: "power2.in" }, t0);
        tl.to(l.line, { strokeDashoffset: 1, duration: 0.25, ease: "power2.in" }, t0);
        tl.to(l.dot, { opacity: 0, duration: 0.2 }, t0 + 0.1);
      }
    });
    if (d) tl.to(d.title, { opacity: 0, y: 8, duration: 0.4, ease: "power2.in" }, lastLand - 0.6);
    // 마지막 판(윗판)이 날아오기 시작할 때까지는 펼친 구도를 지켜서 화면 밖으로 잘리지 않게 하고, 그 판을 따라 다가간다.
    const closeIn = lastLand - T.travel * 0.6;
    tl.to(c, { el: 0.16, duration: lastLand - T.reassemble, ease: "sine.inOut" }, T.reassemble);
    tl.to(c, { fit: fitRest, ...at(rest.center), duration: lastLand - closeIn, ease: "power2.inOut" }, closeIn);
    tl.to(st.shade, { o: 0.45, duration: 0.6, ease: "power1.inOut" }, lastLand - 0.3);
    // 마지막 판이 닿는 순간: 가구 전체가 쿵 하고 눌렸다 펴지고 카메라가 짧게 흔들린다.
    tl.fromTo(st.unit, { sx: 1.006, sy: 0.988 }, { sx: 1, sy: 1, duration: 0.45, ease: "back.out(3)", immediateRender: false }, lastLand);
    tl.fromTo(c, { shake: 1 }, { shake: 0, duration: 0.5, ease: "power2.out", immediateRender: false }, lastLand);

    // 5. 마무리: 오른쪽 앞 영웅 구도로 천천히 물러난다.
    tl.to(c, { fit: fitRest * 1.1, el: 0.14, duration: T.settle, ease: "power2.inOut" }, lastLand + 0.05);

    return () => {
      tl.kill();
      c.on = false;
      if (orbit) { orbit.enabled = true; orbit.update(); }
      dom.current?.layer.remove();
      dom.current = null;
    };
  }, [p, st]); // eslint-disable-line react-hooks/exhaustive-deps

  const v = useMemo(() => new THREE.Vector3(), []);
  const w = useMemo(() => new THREE.Vector3(), []);
  const q = useMemo(() => new THREE.Quaternion(), []);
  const right = useMemo(() => new THREE.Vector3(), []);
  const up = useMemo(() => new THREE.Vector3(), []);
  const unitCenter = useMemo(() => new THREE.Vector3(), []);
  useFrame(({ clock, size }) => {
    // 판·철물
    p.panels.forEach((pp, i) => {
      const g = groups.current[i];
      const s = st.panels[i];
      if (!g) return;
      g.position.set(...add(pp.panel.pos, pp.disp, s.k));
      g.rotation.set(pp.wobble[0] * s.w, pp.wobble[1] * s.w, pp.wobble[2] * s.w);
      const f = flashes.current[i];
      if (f) {
        f.visible = s.flash > 0.01;
        (f.material as THREE.MeshBasicMaterial).opacity = s.flash;
      }
      const r = rings.current[i];
      if (r) {
        r.visible = s.ring > 0 && s.ring < 1;
        r.scale.setScalar(1 + s.ring * 0.3);
        (r.material as THREE.MeshBasicMaterial).opacity = 0.75 * (1 - s.ring);
      }
    });
    p.smalls.forEach((sp, i) => {
      const g = smallGroups.current[i];
      const s = st.smalls[i];
      if (!g) return;
      g.position.set(...add(sp.part.at, sp.disp, s.k));
      const sc = scalers.current[i];
      if (sc) {
        sc.scale.setScalar(s.s);
        // 나사는 풀려 나오듯 돌면서 빠진다.
        sc.rotation.y = SPINS.includes(sp.part.model) ? -s.k * Math.PI * 4 : 0;
      }
    });
    root.current?.scale.set(st.unit.sx, st.unit.sy, st.unit.sx);
    shade.current?.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
      if (m) m.opacity = st.shade.o;
    });

    // 카메라: 구면 좌표(방위각·고도) + 화면 좁은 쪽에 맞춘 거리. 채팅을 열어 화면이 좁아져도 잘리지 않는다.
    const c = st.cam;
    if (c.on) {
      const cam = camera as THREE.PerspectiveCamera;
      const dist = c.fit / Math.sin(narrowHalf(cam));
      w.set(c.tx, c.ty, c.tz);
      camera.position.set(
        c.tx + dist * Math.cos(c.el) * Math.sin(c.az),
        c.ty + dist * Math.sin(c.el),
        c.tz + dist * Math.cos(c.el) * Math.cos(c.az),
      );
      camera.lookAt(w);
      if (c.shake > 0) {
        const time = clock.elapsedTime;
        right.setFromMatrixColumn(camera.matrix, 0);
        up.setFromMatrixColumn(camera.matrix, 1);
        const amp = 1.4 * c.shake;
        camera.position.addScaledVector(right, Math.sin(time * 61) * amp).addScaledVector(up, Math.cos(time * 47) * amp * 0.7);
      }
      camera.updateMatrixWorld();
      const orbit = controls as unknown as OrbitControlsImpl | null;
      orbit?.target.copy(w);
    }

    // 이름표: 판 중심을 화면에 투영하고, 판이 펼쳐진 방향(화면)으로 지시선을 뻗어 그 끝에 단다.
    const d = dom.current;
    if (!d || !root.current) return;
    root.current.localToWorld(unitCenter.set(...p.center)).project(camera);
    const ux = ((unitCenter.x + 1) / 2) * size.width, uy = ((1 - unitCenter.y) / 2) * size.height;
    root.current.getWorldQuaternion(q);
    p.panels.forEach((pp, i) => {
      const g = groups.current[i];
      const l = d.labels[i];
      if (!g) return;
      g.getWorldPosition(v);
      w.set(...pp.dir).applyQuaternion(q).multiplyScalar(10).add(v);
      v.project(camera);
      w.project(camera);
      const x = ((v.x + 1) / 2) * size.width, y = ((1 - v.y) / 2) * size.height;
      let dx = ((w.x + 1) / 2) * size.width - x, dy = ((1 - w.y) / 2) * size.height - y;
      // 카메라 쪽으로 빠지는 판(칸막이)은 화면에서 거의 안 움직이므로 가구 중심에서 바깥쪽을 쓴다.
      if (Math.hypot(dx, dy) < 12) { dx = x - ux; dy = y - uy; }
      if (Math.hypot(dx, dy) < 4) { dx = 0; dy = -1; }
      const n = Math.hypot(dx, dy);
      dx /= n; dy /= n;
      const lx = x + dx * LEADER, ly = y + dy * LEADER;
      l.line.setAttribute("x1", x.toFixed(1)); l.line.setAttribute("y1", y.toFixed(1));
      l.line.setAttribute("x2", lx.toFixed(1)); l.line.setAttribute("y2", ly.toFixed(1));
      l.dot.setAttribute("cx", x.toFixed(1)); l.dot.setAttribute("cy", y.toFixed(1));
      // 이름표의 가까운 가장자리가 지시선 끝에 닿게 한다.
      l.root.style.transform = `translate(${lx}px, ${ly}px) translate(${-50 + dx * 50}%, ${-50 + dy * 50}%)`;
      l.root.style.visibility = v.z < 1 ? "visible" : "hidden";
    });
  });

  return (
    <group ref={root} rotation={[p.rot, 0, 0]} position={p.rootPos}>
      {p.panels.map((pp, i) => (
        <ExplodeBoard key={pp.panel.id} pp={pp} style={style}
          groupRef={(g) => { groups.current[i] = g; }}
          flashRef={(m) => { flashes.current[i] = m; }}
          ringRef={(m) => { rings.current[i] = m; }} />
      ))}
      {p.smalls.map((sp, i) => (
        <ExplodeSmall key={sp.part.id} sp={sp} materials={materials.get}
          groupRef={(g) => { smallGroups.current[i] = g; }}
          scalerRef={(g) => { scalers.current[i] = g; }} />
      ))}
      {p.wall && (
        <group ref={shade}>
          <WallShade size={scene.size} z={scene.wall_z ?? -scene.size[2] / 2 - 1.5} />
        </group>
      )}
    </group>
  );
}

// 세로·가로 시야각 중 좁은 쪽의 절반(rad).
function narrowHalf(cam: THREE.PerspectiveCamera) {
  const half = THREE.MathUtils.degToRad(cam.fov / 2);
  return Math.min(half, Math.atan(Math.tan(half) * cam.aspect));
}
