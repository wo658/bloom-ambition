// 오프닝의 시간표와 공용 시계. 3D 장면과 화면 글자는 모두 clock.t(초)만 보고 자기 상태를 정한다.
// 그래서 시간만 바꿔 넣으면 어느 순간이든 그대로 다시 그릴 수 있다(?intro&at=9.5 로 그 장면에 멈춰 보기).
import { useSyncExternalStore } from "react";
import gsap from "gsap";
import * as THREE from "three";
import type { Vec3 } from "../types";

// ── 시간표(초, PDF를 넣은 순간이 0) ─────────────────────────────
export const T = {
  bookIn: [0, 0.6] as const, // 표지가 떠오른다(첫 화면이 걷히며 드러난다)
  flips: [0.9, 1.2, 1.5], // 페이지 세 장을 넘긴다
  flipDur: 0.75,
  scan: [2.5, 3.7] as const, // 스캔 빛이 펼친 면을 위에서 아래로 훑는다
  cards: 4.2, // 테두리 친 부품이 카드로 떨어져 나온다
  cardStagger: 0.16,
  cardDur: 0.65,
  darken: [7.0, 7.45] as const, // 배경이 어두워진다(SF 구간 시작). 회색으로 머물지 않게 짧게
  lie: [7.0, 7.9] as const, // 10쪽이 그 자리에서 뒤로 눕는다
  glide: [7.9, 8.7] as const, // 누운 10쪽이 바닥으로 내려와 커진다
  blueprint: [8.6, 9.7] as const, // 종이가 청사진으로 바뀐다
  focus: [9.3, 9.8] as const, // (i) 그림 바깥이 어두워진다
  trace: 9.4, // (i) 그림 자리에 판 자리가 선으로 그려진다
  extrude: 10.2, // 선이 위로 일어나 판이 선다
  lift: 10.9, // 판이 공중으로 떠올라 분해된 자리로 간다
  reveal: [11.9, 13.0] as const, // 아래에서 위로 원목이 입혀진다
  lighten: [12.3, 12.8] as const, // 배경이 다시 밝아진다
  spin: [11.6, 13.8] as const, // 분해된 채로 한 바퀴
  snap: 13.7, // 제자리로 착 조립(마지막 판이 약 14.75초에 붙는다)
  ready: 14.9, // 완성품을 잠시 멈춰 보여 준다
  final: [15.9, 17.3] as const, // 완성품이 흩어져 부품 확인 배치로 내려앉고, 카메라가 App의 부품 확인 시점으로 간다
  checklist: 16.5, // 오른쪽 목록이 App의 '상자 속 부품' 체크리스트로 바뀐다
  hardware: 16.9, // 철물이 종류별 칸에 떨어진다(App 부품 확인과 같은 동작)
  labels: 17.6, // 부품 위 수량 이름표
  handoff: 18.3, // 오프닝을 걷어 내고 실제 App(부품 확인)을 보여 준다
  fade: 0.4,
};
export const END = T.handoff + T.fade;

export const STATUS: { at: number; text: string }[] = [
  { at: 0, text: "설명서 읽는 중 (1/3)" },
  { at: T.cards - 0.1, text: "부품 찾는 중 (2/3)" },
  { at: T.darken[0], text: "조립 단계 만드는 중 (3/3)" },
  { at: T.ready, text: "준비 완료" },
];

// ── 시계 ─────────────────────────────────────────────────────
export const clock = { t: -1 }; // -1: 아직 시작 전
// 개발 서버에서만: 브라우저 콘솔에서 __opening.clock.t로 지금 시각을 볼 수 있다.
if (import.meta.env.DEV) Object.assign(window, { __opening: { clock, calls: [] as string[] } });
const trace = (name: string) => {
  if (import.meta.env.DEV) (window as unknown as { __opening: { calls: string[] } }).__opening.calls.push(`${name}@${performance.now().toFixed(0)}`);
};
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => { listeners.delete(l); };
};
let tween: gsap.core.Tween | null = null;

export function play(from = 0, freeze = false) {
  trace(`play(${from}${freeze ? ",freeze" : ""})`);
  tween?.kill();
  clock.t = from;
  emit();
  if (freeze) return;
  tween = gsap.to(clock, { t: END, duration: END - from, ease: "none", onUpdate: emit });
}

export function stop(at = END) {
  trace(`stop(${at})`);
  tween?.kill();
  tween = null;
  clock.t = at;
  emit();
}

// 시간에서 뽑은 값이 바뀔 때만 다시 그린다(숫자·글자·불리언처럼 비교 가능한 값만).
export function useClock<V>(select: (t: number) => V): V {
  return useSyncExternalStore(subscribe, () => select(clock.t));
}

// ── 보간 도구 ───────────────────────────────────────────────
export const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
export const seg = (t: number, a: number, b: number) => clamp01((t - a) / (b - a));
export const inOut = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2);
export const outCubic = (u: number) => 1 - (1 - u) ** 3;
export const inCubic = (u: number) => u * u * u;
export const mix = (a: number, b: number, u: number) => a + (b - a) * u;
export const mixV = (a: Vec3, b: Vec3, u: number): Vec3 => [mix(a[0], b[0], u), mix(a[1], b[1], u), mix(a[2], b[2], u)];

// ── 설명서 페이지 ──────────────────────────────────────────
export const PAGE_PX = { w: 641, h: 910 };
export const pageUrl = (n: number) => `/demo/pages/page-${String(n).padStart(2, "0")}.png`;

// 3D에서 페이지 한 장의 크기(cm처럼 쓰는 단위)와 펼친 책의 가운데(책등)
export const PAGE_W = 64.1;
export const PAGE_H = 91;
export const BOOK: Vec3 = [0, 120, 0];

// 넘기는 종이: 앞면 → 뒷면. 펼친 면이 2|3 → 4|5 → 9|10 순서로 보인다(마지막 장 뒷면이 9쪽).
export const SHEETS = [
  { front: 1, back: 2 },
  { front: 3, back: 4 },
  { front: 5, back: 9 },
];
export const RIGHT_PAGE = 10;

// 9·10쪽에서 읽어 낼 자리(페이지 픽셀 좌표 x1,y1,x2,y2). AI가 테두리를 치는 곳.
export type Find = {
  page: 9 | 10; box: [number, number, number, number]; label: string;
  name: string; code?: string; qty: string; partId?: string;
};
export const FINDS: Find[] = [
  { page: 9, box: [70, 88, 168, 432], label: "104321 · 8x", name: "긴 연결 볼트", code: "104321", qty: "8x", partId: "104321" },
  { page: 9, box: [222, 152, 302, 432], label: "101339 · 14x", name: "나무못", code: "101339", qty: "14x", partId: "101339" },
  { page: 9, box: [344, 292, 418, 428], label: "100372 · 4x", name: "짧은 나사", code: "100372", qty: "4x", partId: "100372" },
  { page: 9, box: [476, 226, 588, 428], label: "103693 · 2x", name: "벽걸이 고리 브래킷", code: "103693", qty: "2x", partId: "103693" },
  { page: 9, box: [36, 524, 178, 772], label: "100001 · 1x", name: "육각 렌치", code: "100001", qty: "1x", partId: "100001" },
  { page: 9, box: [198, 568, 612, 772], label: "10002300 · 4x (1장)", name: "펠트 패드", code: "10002300", qty: "4x", partId: "10002300" },
  { page: 10, box: [36, 36, 296, 292], label: "115753 · 2x", name: "벽 고정 브래킷", code: "115753", qty: "2x", partId: "115753" },
  { page: 10, box: [300, 250, 578, 566], label: "115754 · 2x", name: "브래킷 커버", code: "115754", qty: "2x", partId: "115754" },
  { page: 10, box: [42, 588, 604, 834], label: "판재 · 7장", name: "판재", code: "바닥·윗·옆판·칸막이·선반", qty: "7장" },
];
export const cardStart = (i: number) => T.cards + i * T.cardStagger;
export const cardLand = (i: number) => cardStart(i) + T.cardDur;

// 스캔 빛이 박스 윗변을 지나는 순간에 테두리를 그린다.
export function findAppear(f: Find) {
  const v = f.box[1] / PAGE_PX.h;
  return mix(T.scan[0], T.scan[1], v) - 0.05;
}

// 페이지 픽셀 → 펼친 책 기준 3D 좌표(책 그룹 안)
export function pageToBook(page: 9 | 10, x: number, y: number): Vec3 {
  const left = page === 9 ? -PAGE_W : 0;
  return [left + (x / PAGE_PX.w) * PAGE_W, PAGE_H / 2 - (y / PAGE_PX.h) * PAGE_H, 0.3];
}

// ── 판재 배치 ──────────────────────────────────────────────
// 판 순서(조립되는 순서이기도 하다)
export const ORDER = ["outer_bottom", "outer_left", "outer_right", "outer_top", "divider_vertical", "shelf_left", "shelf_right"];

export const PAPER_SCALE = 3.6; // 바닥에 누운 10쪽이 커지는 배율

// 누운 10쪽의 페이지 픽셀 → 바닥 위 좌표(x, z). 종이 아랫변이 앞(+z)이다.
export function floorPoint(px: number, py: number): [number, number] {
  const x = (px / PAGE_PX.w - 0.5) * PAGE_W * PAPER_SCALE;
  const v = (1 - py / PAGE_PX.h) * PAGE_H;
  return [x, (PAGE_H / 2 - v) * PAPER_SCALE];
}
// 10쪽 아래 (i) 그림 상자(판 7장 배치도). 판은 이 상자 안에서 솟는다.
export const PLAN_BOX = FINDS[FINDS.length - 1].box;
const [planX, planZ] = floorPoint((PLAN_BOX[0] + PLAN_BOX[2]) / 2, (PLAN_BOX[1] + PLAN_BOX[3]) / 2);
export const PLAN_CENTER: Vec3 = [planX, 0, planZ];

// (i) 그림 상자 안에 세워 둘 자리(그림처럼 판을 둘러 세운 모양). 높이는 판 깊이(39)가 된다.
const ring: Record<string, [number, number]> = {
  outer_left: [-62, 0], outer_right: [62, 0], outer_top: [0, -40], outer_bottom: [0, 40],
  divider_vertical: [0, 0], shelf_left: [-28, -18], shelf_right: [28, 18],
};
export const STAND: Record<string, Vec3> = Object.fromEntries(
  Object.entries(ring).map(([id, [x, z]]) => [id, [planX + x, 0, planZ + z] as Vec3]),
);
// 공중에서 분해된 자리: 조립 위치 + 이만큼(+ 전체를 띄우는 높이).
// 선반·칸막이는 앞뒤로만 벌려서, 먼저 끼운 옆판을 뚫고 지나가지 않게 한다.
export const EXPLODE: Record<string, Vec3> = {
  outer_bottom: [0, -26, 0], outer_top: [0, 26, 0],
  outer_left: [-30, 0, 0], outer_right: [30, 0, 0],
  divider_vertical: [0, 0, 36], shelf_left: [0, 0, -36], shelf_right: [0, 0, -36],
};
export const FLOAT = 30;

// ── 카메라 ────────────────────────────────────────────────
export const APP_FOV = 40; // App.tsx 캔버스와 같은 화각
// App.tsx CameraRig의 부품 확인 시점과 같은 계산(PREP_DIRECTION, radius * 0.42 / 0.1 / 2.8).
// App이 처음 뜨는 화면이 부품 확인이라, 오프닝이 여기서 끝나야 이음새가 안 보인다.
const PREP_DIRECTION = new THREE.Vector3(0.15, 1.25, 1).normalize();
export function appPrepCamera(radius: number) {
  const target = new THREE.Vector3(radius * 0.42, 0, radius * 0.1);
  return { pos: target.clone().addScaledVector(PREP_DIRECTION, radius * 2.8).toArray() as Vec3, target: target.toArray() as Vec3 };
}

export const HIGHLIGHT = "#ff7a1a"; // App의 강조 주황
