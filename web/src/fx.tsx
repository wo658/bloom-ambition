import { useEffect, useImperativeHandle, useMemo, type Ref } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";

// 공구로 박고 조이는 동작에 덧붙이는 연출(모션 디자인). 망치질의 타격감, 렌치의 잔상, 자리 잡을 때의 빛.
// 동작 곡선(언제 들고, 언제 치고, 얼마나 들어가는지)은 시계(단계 시간)로 계산해 늘 같은 모습이 되고,
// 터지는 효과(충격파·먼지·섬광)는 실제 시간으로 흘러 프레임마다 React 상태를 바꾸지 않는다.

// ── 효과 신호 ─────────────────────────────────────────────
// 화면 밖(카메라 등)에서 타격 순간을 받을 때 쓴다. fxBus.emit("impact", 0~1 세기)
type FxEvent = "impact";
const listeners = new Map<FxEvent, Set<(strength: number) => void>>();
export const fxBus = {
  on(type: FxEvent, fn: (strength: number) => void) {
    const set = listeners.get(type) ?? new Set();
    listeners.set(type, set);
    set.add(fn);
    return () => { set.delete(fn); };
  },
  emit(type: FxEvent, strength: number) {
    listeners.get(type)?.forEach((fn) => fn(strength));
  },
};

// ── 동작 곡선 ─────────────────────────────────────────────
const easeOut3 = (x: number) => 1 - (1 - x) ** 3;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

// 한 번 두드리는 동안(p 0→1): 들어 올리며 뒤로 젖히고(예비 동작) → 꼭대기에서 잠깐 버티고 → 가속하며 내려쳐
// IMPACT에 닿고 → 살짝 튕겼다 멈춘다.
const WIND_END = 0.5;
const HOLD_END = 0.62;
const IMPACT = 0.75;
const RECOIL = 0.18; // 튕겨 오르는 각도(젖힌 각도 대비)
// 한 번 칠 때마다 들어가는 몫. 처음이 가장 많이 들어가고 마지막은 자리를 잡는다.
function tapShares(taps: number) {
  const w = Array.from({ length: taps }, (_, i) => 0.6 ** i);
  const sum = w.reduce((s, x) => s + x, 0);
  return w.map((x) => x / sum);
}
// a: 망치질 진행(0→1). angle: 손목을 축으로 젖힌 각(라디안, 0이 닿은 상태), depth: 들어간 정도(0→1),
// squash: 맞은 뒤 눌렸다 늘어나는 양(-1~1), impacts: 지금까지 친 횟수, since: 마지막으로 맞은 뒤 지난 몫(0→1, 아직이면 -1).
export function hammerPose(a: number, taps: number, amp: number) {
  const shares = tapShares(taps);
  if (a >= 1) return { angle: 0, depth: 1, squash: 0, impacts: taps, since: -1 };
  if (a <= 0) return { angle: 0, depth: 0, squash: 0, impacts: 0, since: -1 };
  const k = a * taps, n = Math.min(Math.floor(k), taps - 1), p = k - n;
  const before = shares.slice(0, n).reduce((s, x) => s + x, 0);
  // 마지막 한 방은 더 크게 젖혀 세게 친다.
  const big = amp * (n === taps - 1 ? 1.25 : 1);
  if (p < WIND_END) return { angle: big * easeOut3(p / WIND_END), depth: before, squash: 0, impacts: n, since: -1 };
  if (p < HOLD_END) {
    const h = (p - WIND_END) / (HOLD_END - WIND_END);
    return { angle: big * (1 + 0.06 * Math.sin(Math.PI * h)), depth: before, squash: 0, impacts: n, since: -1 };
  }
  if (p < IMPACT) {
    const s = (p - HOLD_END) / (IMPACT - HOLD_END);
    return { angle: big * (1 - s ** 3), depth: before, squash: 0, impacts: n, since: -1 };
  }
  const r = (p - IMPACT) / (1 - IMPACT);
  // 마지막 한 방 뒤에는 튕긴 다음 그대로 들어 올려 치운다.
  const lift = n === taps - 1 && r >= 0.5 ? big * 0.6 * easeOut3((r - 0.5) / 0.5) : 0;
  return {
    angle: r < 0.5 ? big * RECOIL * Math.sin(Math.PI * r * 2) : lift,
    depth: before + shares[n] * easeOut3(clamp01(r / 0.25)),
    squash: Math.exp(-5 * r) * Math.cos(2.5 * Math.PI * r),
    impacts: n + 1,
    since: r,
  };
}

// 렌치로 조이기(a 0→1): 빠르게 감기 시작해서 고르게 돌다가, 끝에서 저항을 받으며 느려지고 CLICK에서 '딸깍' 하고 멈춘다.
// turns: 돌린 몫(0→1, 들어간 정도와 같다), kick: 딸깍할 때 튀는 각(라디안).
const SPIN_SEAT = 0.82;
const CLICK = 0.95;
const accel = (x: number) => (x < 0.15 ? (x * x) / 0.3 : x - 0.075) / 0.925;
export function spinTurns(a: number) {
  const x = clamp01(a);
  return x < SPIN_SEAT ? 0.94 * accel(x / SPIN_SEAT) : 0.94 + 0.06 * easeOut3((x - SPIN_SEAT) / (1 - SPIN_SEAT));
}
export function spinPose(a: number) {
  const r = (a - CLICK) / (1 - CLICK);
  return { turns: spinTurns(a), kick: r > 0 ? 0.22 * Math.exp(-4 * r) * Math.sin(3 * Math.PI * Math.min(r, 1)) : 0, clicked: a >= CLICK };
}

// ── 공유 형상·무늬 ─────────────────────────────────────────
// 작은 형상과 무늬는 모듈에 하나씩 두고 모든 부품이 같이 쓴다(지우지 않는다).
let shared: {
  ring: THREE.RingGeometry; plane: THREE.PlaneGeometry; chip: THREE.BoxGeometry;
  disc: THREE.CanvasTexture; halo: THREE.CanvasTexture; star: THREE.CanvasTexture;
} | null = null;
function radial(stops: [number, string][]) {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  for (const [o, col] of stops) grad.addColorStop(o, col);
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
// 만화의 '쾅' 같은 충격 별: 길이가 번갈아 다른 가시 12개. 카메라를 보는 스프라이트에 붙여 어느 방향에서 봐도 보인다.
function starburst() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  g.translate(64, 64);
  g.fillStyle = "#fff";
  g.beginPath();
  const n = 12;
  for (let i = 0; i < n * 2; i++) {
    const a = (i / (n * 2)) * Math.PI * 2, r = i % 2 ? 22 : i % 4 ? 52 : 63;
    g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  g.closePath();
  g.fill();
  // 가운데는 비워 부품이 가려지지 않게 한다.
  g.globalCompositeOperation = "destination-out";
  g.beginPath();
  g.arc(0, 0, 26, 0, Math.PI * 2);
  g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function assets() {
  if (shared) return shared;
  // 고리·가시·판은 부품 로컬 XZ 면(박히는 축 +Y에 수직)에 눕힌다.
  const ring = new THREE.RingGeometry(0.62, 1, 48);
  ring.rotateX(-Math.PI / 2);
  const plane = new THREE.PlaneGeometry(2, 2);
  plane.rotateX(-Math.PI / 2);
  shared = {
    ring, plane, chip: new THREE.BoxGeometry(1, 1, 1),
    disc: radial([[0, "rgba(255,255,255,1)"], [0.25, "rgba(255,255,255,0.9)"], [0.6, "rgba(255,255,255,0.25)"], [1, "rgba(255,255,255,0)"]]),
    star: starburst(),
    halo: radial([[0, "rgba(255,255,255,0)"], [0.55, "rgba(255,255,255,0.15)"], [0.78, "rgba(255,255,255,0.95)"], [0.9, "rgba(255,255,255,0.3)"], [1, "rgba(255,255,255,0)"]]),
  };
  return shared;
}

// ── 터지는 효과 ───────────────────────────────────────────
export type FxHandle = {
  burst: (strength: number) => void; // 망치가 닿은 순간: 섬광 + 충격파 + 가시 + 나무 가루
  click: (strength: number) => void; // 볼트가 다 조여진 '딸깍': 작은 충격파 + 불꽃
  seat: (strength: number) => void; // 자리에 다 들어감: 은은하게 퍼지며 사라지는 빛 고리
};
type Pulse = { obj: THREE.Mesh | THREE.Sprite; mat: THREE.Material & { opacity: number }; t0: number; life: number; from: number; to: number; peak: number };
const MAX_CHIPS = 48;
const WOOD = new THREE.Color("#8a5a24");
const SPARK = new THREE.Color("#ffc94d");
const FLASH = "#ffb020";
const SPIKE = "#ff7a00";
const G = 60; // 가루가 떨어지는 가속도(cm/s²). 실제보다 약하게 해서 느리게 흩날린다.

// 부품이 도착하는 곳(부품 로컬, 원점이 구멍 입구, +Y가 박히는 방향)에 둔다.
// radius: 효과 크기의 기준(부품 반지름), color: 강조 색, timeScale: 1보다 작으면 느린 화면처럼 흐른다.
export function ImpactFx({ ref, radius, color, timeScale = 1 }: {
  ref?: Ref<FxHandle>; radius: number; color: string; timeScale?: number;
}) {
  const a = assets();
  const fx = useMemo(() => {
    const root = new THREE.Group();
    const basic = (o: THREE.MeshBasicMaterialParameters) =>
      new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide, opacity: 0, ...o });
    const pulse = (obj: THREE.Mesh | THREE.Sprite, order: number) => {
      obj.visible = false;
      obj.renderOrder = order;
      root.add(obj);
      return { obj, mat: obj.material as Pulse["mat"], t0: 0, life: 0, from: 0, to: 0, peak: 0 } as Pulse;
    };
    const rings = [0, 1, 2, 3].map(() => pulse(new THREE.Mesh(a.ring, basic({ color })), 15));
    const sprite = (map: THREE.Texture, c: string, order: number) => pulse(new THREE.Sprite(new THREE.SpriteMaterial({
      map, color: c, transparent: true, depthTest: false, depthWrite: false, opacity: 0,
    })), order);
    const spikes = [0, 1].map(() => sprite(a.star, SPIKE, 16));
    // 박히는 축과 상관없이 화면에 동그랗게 퍼지는 충격파(바닥에 눕힌 고리는 옆에서 보면 납작해진다).
    const waves = [0, 1, 2].map(() => sprite(a.halo, color, 15));
    // 충격파 안쪽에 흰 고리를 하나 더 겹쳐 밝은 나무·흰 판 어디서든 테두리가 보이게 한다.
    const cores = [0, 1].map(() => pulse(new THREE.Mesh(a.ring, basic({ color: "#ffffff" })), 16));
    const flash = sprite(a.disc, FLASH, 17);
    const glow = pulse(new THREE.Mesh(a.plane, basic({ map: a.halo, color })), 14);
    const chips = new THREE.InstancedMesh(a.chip, new THREE.MeshBasicMaterial({ depthTest: false, depthWrite: false, transparent: true }), MAX_CHIPS);
    chips.renderOrder = 18;
    chips.frustumCulled = false;
    chips.count = 0;
    for (let i = 0; i < MAX_CHIPS; i++) chips.setColorAt(i, WOOD);
    root.add(chips);
    const p = {
      pos: new Float32Array(MAX_CHIPS * 3), vel: new Float32Array(MAX_CHIPS * 3), age: new Float32Array(MAX_CHIPS).fill(1),
      life: new Float32Array(MAX_CHIPS).fill(1), size: new Float32Array(MAX_CHIPS), spin: new Float32Array(MAX_CHIPS), next: 0, alive: 0,
    };
    return { root, rings, cores, spikes, waves, flash, glow, chips, p, now: 0 };
  }, [a, color]);
  useEffect(() => () => {
    for (const x of [...fx.rings, ...fx.cores, ...fx.spikes, ...fx.waves, fx.flash, fx.glow]) x.mat.dispose();
    (fx.chips.material as THREE.Material).dispose();
    fx.chips.dispose();
  }, [fx]);

  const tmp = useMemo(() => ({ m: new THREE.Matrix4(), q: new THREE.Quaternion(), e: new THREE.Euler(), s: new THREE.Vector3(), v: new THREE.Vector3(), g: new THREE.Vector3() }), []);

  useImperativeHandle(ref, () => {
    const start = (x: Pulse, life: number, from: number, to: number, peak: number, delay = 0) => {
      Object.assign(x, { t0: fx.now + delay, life, from: from * radius, to: to * radius, peak });
      x.obj.rotation.y = Math.random() * Math.PI;
      if (x.mat instanceof THREE.SpriteMaterial) x.mat.rotation = Math.random() * Math.PI;
    };
    const free = () => fx.rings.reduce((best, r) => (r.t0 + r.life < best.t0 + best.life ? r : best));
    const spray = (n: number, kind: "wood" | "spark", s: number) => {
      const p = fx.p;
      for (let k = 0; k < n; k++) {
        const i = p.next;
        p.next = (p.next + 1) % MAX_CHIPS;
        const phi = Math.random() * Math.PI * 2, c = Math.cos(phi), sn = Math.sin(phi);
        const spark = kind === "spark";
        // 구멍 가장자리에서 바깥으로, 그리고 구멍 밖(-Y, 망치 쪽)으로 튄다.
        const out = (spark ? 10 : 5) + Math.random() * (spark ? 14 : 8) * s, back = 3 + Math.random() * 7 * s;
        p.pos.set([c * radius * 0.9, -0.1, sn * radius * 0.9], i * 3);
        p.vel.set([c * out, -back, sn * out], i * 3);
        p.age[i] = 0;
        p.life[i] = spark ? 0.25 + Math.random() * 0.2 : 0.55 + Math.random() * 0.45;
        p.size[i] = radius * (spark ? 0.14 + Math.random() * 0.1 : 0.22 + Math.random() * 0.3);
        p.spin[i] = Math.random() * 20 - 10;
        fx.chips.setColorAt(i, spark ? SPARK : WOOD);
      }
      if (fx.chips.instanceColor) fx.chips.instanceColor.needsUpdate = true;
    };
    return {
      burst(s) {
        start(fx.flash, 0.2 + 0.08 * s, 2, 7 + 4 * s, 1);
        start(free(), 0.4, 1, 4 + 4 * s, 1);
        start(fx.cores[0], 0.3, 0.7, 3 + 3 * s, 0.9);
        start(fx.waves[0], 0.45, 2, 9 + 6 * s, 0.9);
        if (s > 0.6) start(free(), 0.55, 1, 4.5 + 3 * s, 0.55, 0.06);
        start(fx.spikes[0], 0.22, 2.5, 7 + 5 * s, 1);
        spray(Math.round(4 + 12 * s), "wood", s);
      },
      click(s) {
        start(fx.flash, 0.16, 1.5, 5 + 3 * s, 0.9);
        start(fx.waves[1], 0.35, 1.5, 6 + 4 * s, 0.8);
        start(free(), 0.32, 1, 2.6 + 1.6 * s, 1);
        start(fx.cores[1], 0.25, 0.7, 2 + 1.2 * s, 0.9);
        start(fx.spikes[1], 0.16, 2, 5 + 3 * s, 0.9);
        spray(Math.round(2 + 5 * s), "spark", s);
      },
      seat(s) {
        start(fx.glow, 0.6 + 0.5 * s, 1.5, 4 + 2 * s, 0.85);
        start(free(), 0.7 + 0.4 * s, 1, 4 + 2 * s, 0.5, 0.05);
        // 화면을 보는 빛 고리: 천천히 크게 번지며 사라진다.
        start(fx.waves[2], 0.8 + 0.5 * s, 2.5, 8 + 4 * s, 0.75);
        start(fx.flash, 0.5, 2, 5 + 2 * s, 0.6);
      },
    };
  }, [fx, radius]);

  useFrame((_, delta) => {
    // 소프트웨어 렌더링처럼 프레임이 띄엄띄엄해도 효과가 한 프레임에 지나가 버리지 않게 한 번에 흐르는 시간을 묶는다.
    const dt = Math.min(delta, 1 / 20) * timeScale;
    fx.now += dt;
    for (const x of [...fx.rings, ...fx.cores, ...fx.spikes, ...fx.waves, fx.flash, fx.glow]) {
      const t = (fx.now - x.t0) / x.life;
      x.obj.visible = t >= 0 && t < 1;
      if (!x.obj.visible) continue;
      const e = easeOut3(t);
      x.obj.scale.setScalar(x.from + (x.to - x.from) * e);
      // 섬광은 처음 몇 프레임만 꽉 차게, 고리는 퍼지면서 옅어진다.
      x.mat.opacity = x.peak * (1 - t) ** (x === fx.flash ? 2 : 1.4);
    }
    const p = fx.p;
    if (!p.age.some((ag, i) => ag < p.life[i])) {
      fx.chips.count = 0;
      return;
    }
    // 중력은 월드 아래 방향을 부품 로컬로 옮겨서 건다.
    fx.root.getWorldQuaternion(tmp.q).invert();
    tmp.g.set(0, -G, 0).applyQuaternion(tmp.q);
    const drag = Math.max(0, 1 - 2.5 * dt);
    for (let i = 0; i < MAX_CHIPS; i++) {
      const t = p.age[i] / p.life[i];
      if (t >= 1) {
        tmp.m.makeScale(0, 0, 0);
        fx.chips.setMatrixAt(i, tmp.m);
        continue;
      }
      p.age[i] += dt;
      const j = i * 3;
      p.vel[j] = p.vel[j] * drag + tmp.g.x * dt;
      p.vel[j + 1] = p.vel[j + 1] * drag + tmp.g.y * dt;
      p.vel[j + 2] = p.vel[j + 2] * drag + tmp.g.z * dt;
      p.pos[j] += p.vel[j] * dt;
      p.pos[j + 1] += p.vel[j + 1] * dt;
      p.pos[j + 2] += p.vel[j + 2] * dt;
      const r = p.spin[i] * p.age[i];
      tmp.e.set(r, r * 0.7, r * 0.3);
      tmp.s.setScalar(p.size[i] * (1 - t * t));
      tmp.m.compose(tmp.v.set(p.pos[j], p.pos[j + 1], p.pos[j + 2]), tmp.q.setFromEuler(tmp.e), tmp.s);
      fx.chips.setMatrixAt(i, tmp.m);
    }
    fx.chips.count = MAX_CHIPS;
    fx.chips.instanceMatrix.needsUpdate = true;
  });

  return <primitive object={fx.root} />;
}

// ── 카메라 흔들림 ─────────────────────────────────────────
// fxBus "impact"를 받아 카메라를 아주 조금 비튼다. 궤도 조작기가 위치를 다시 잡기 전에(-2) 지난 프레임의 흔들림을 되돌리고,
// 조작기가 시점을 잡은 뒤(0)에 새 흔들림을 얹어서 시점이 조금씩 밀려나지 않는다.
export function CameraShake({ max = 0.014 }: { max?: number }) {
  const camera = useThree((s) => s.camera);
  const st = useMemo(() => ({ trauma: 0, t: 0, applied: new THREE.Quaternion(), on: false, e: new THREE.Euler() }), []);
  useEffect(() => fxBus.on("impact", (s) => { st.trauma = Math.min(1, st.trauma + s); }), [st]);
  const undo = () => {
    if (!st.on) return;
    camera.quaternion.multiply(st.applied.invert());
    st.on = false;
  };
  useEffect(() => undo, [camera]); // eslint-disable-line react-hooks/exhaustive-deps
  useFrame(undo, -2);
  useFrame((_, delta) => {
    const dt = Math.min(delta, 1 / 20);
    st.t += dt;
    if (st.trauma <= 0.001) return;
    st.trauma = Math.max(0, st.trauma - dt * 2.4);
    const k = max * st.trauma ** 1.5, t = st.t;
    st.e.set(
      k * (Math.sin(t * 47) * 0.6 + Math.sin(t * 83 + 1.3) * 0.4),
      k * (Math.sin(t * 53 + 2.1) * 0.6 + Math.sin(t * 91 + 0.4) * 0.4),
      k * 0.5 * Math.sin(t * 61 + 0.7),
    );
    st.applied.setFromEuler(st.e);
    camera.quaternion.multiply(st.applied);
    st.on = true;
  });
  return null;
}

// 이름표를 톡 튀게 한다. 이름표의 위치는 transform이 매 프레임 잡으므로 따로 노는 scale 속성만 움직인다.
export function popBadge(el: HTMLElement | null | undefined, big: boolean) {
  el?.animate(
    big ? [{ scale: 1 }, { scale: 1.3, offset: 0.3 }, { scale: 0.94, offset: 0.65 }, { scale: 1 }] : [{ scale: 1 }, { scale: 1.1, offset: 0.35 }, { scale: 1 }],
    { duration: big ? 520 : 220, easing: "ease-out" },
  );
}
