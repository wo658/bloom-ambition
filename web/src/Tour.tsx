import { useEffect, useSyncExternalStore } from "react";
import gsap from "gsap";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import type { RenderStyle } from "./Assembly";
import { chatCommand, chatState, playExplode, playPartMotion } from "./bridge";
import { decideProposal, getCompare } from "./compare";
import { getLang, isVoiceOn, setLang, t, toggleVoice } from "./lang";

// ▶ 재생 = 데모 시나리오. 부품 확인부터 완성까지 단계를 넘기며 기능을 차례로 보여 주고, 진행 막대 위 자막이 늘 따라간다.
// 시나리오가 단계 이동을 직접 맡으므로(뷰어의 자동 재생은 쓰지 않는다) 채팅·분해도가 단계를 옮겨도 끊기지 않는다.
// ← → 로 장면을 오가고, Esc·✕·⏸ 로 멈춘다. 장면마다 기본 상태로 되돌린 뒤 시작해 어느 장면으로 건너뛰어도 화면이 맞는다.
export type TourApi = {
  orbit: () => OrbitControlsImpl | null;
  goStep: (index: number) => void;
  setXray: (on: boolean) => void;
  setStyle: (style: RenderStyle) => void;
  setInventory: (on: boolean) => void;
  stepMs: (index: number) => number; // 그 단계 조립 애니메이션 길이
  addStep: (panelId: string) => number; // 그 판이 처음 붙는 단계(없으면 -1)
  prepStep: number;
  xrayStep: number;
  lastStep: number;
};

// ponytail: 장면 안의 쉬는 시간을 한 숫자로 줄인다. 조립 애니메이션·어시스턴트 답 기다림은 그대로 둔다.
const PACE = 0.7;

type Ctx = {
  api: TourApi;
  wait: (ms: number, scale?: number) => Promise<void>;
  until: (ok: () => boolean, max: number) => Promise<void>;
  spin: (on: boolean, speed?: number) => void;
  zoom: (factor: number, seconds: number) => Promise<void>;
  setVoice: (on: boolean) => void;
};

// 어시스턴트 답이 끝날 때까지: 바빠졌다가, 도구 호출 사이 잠깐 쉬는 것까지 넘겨 1.5초 조용하면 끝으로 본다.
async function chatDone(c: Ctx) {
  await c.until(() => chatState.busy, 10000);
  let quiet = 0;
  await c.until(() => {
    if (chatState.busy) { quiet = 0; return false; }
    quiet ||= performance.now();
    return performance.now() - quiet > 1500;
  }, 45000);
}

// 데모가 띄운·적용한 수정안과 데모가 연 채팅. 정리할 때는 이것만 되돌린다(사용자가 만든 수정안·연 채팅은 건드리지 않는다).
let ownId: string | null = null;
let appliedId: string | null = null;
let chatOpened = false;

// 띄워 둔 수정안을 검수 화면에서 보여 준 뒤 적용하고, 잠시 보여 준 다음 되돌린다(데모가 도면을 바꿔 놓지 않게).
async function reviewProposal(c: Ctx, look: number) {
  await c.until(() => getCompare()?.proposal.status === "pending", 6000);
  const id = getCompare()?.proposal.id;
  if (!id) return;
  ownId = id;
  await c.wait(look);
  decideProposal(id, "apply");
  appliedId = id;
  await c.wait(3600, 1);
  decideProposal(id, "undo");
  appliedId = null;
  await c.wait(1200, 1);
}

const SCENES: { text: string; chat?: boolean; run: (c: Ctx) => Promise<void> }[] = [
  { text: "설명서 PDF 한 권이 3D 조립 가이드가 됐어요. 먼저 상자 속 부품부터 확인해요",
    run: async (c) => { c.api.goStep(c.api.prepStep); await c.wait(5200); } },
  { text: "손으로 돌려 보고, 확대해서 자세히 봐요",
    run: async (c) => {
      c.api.goStep(0); await c.wait(c.api.stepMs(0), 1);
      c.spin(true, 9); await c.wait(3600); c.spin(false);
      await c.zoom(0.55, 1.1); await c.wait(900); await c.zoom(1 / 0.55, 1);
    } },
  { text: "단계를 넘기면 부품이 순서대로 제자리에 들어가요",
    run: async (c) => { c.api.goStep(1); await c.wait(c.api.stepMs(1) + 700, 1); } }, // 다음 장면(부품 모션)이 같은 2단계라 여기서 멈춘다
  { text: "부품 하나를 골라, 들어가는 모습을 천천히 다시 봐요",
    run: async (c) => { playPartMotion({ kind: "hardware", id: "101339" }); await c.wait(6500, 1); } },
  { text: "10개 언어로 바꾸고, 음성으로 읽어 줘요",
    run: async (c) => {
      c.api.goStep(2); // 부품 모션(2단계) 다음 3단계에서 읽어 준다
      // 언어마다 끝까지 읽지 않고 2.5초쯤 보여 주고 넘긴다(바꾸면 읽던 음성도 새 언어로 바뀐다).
      setLang("en"); c.setVoice(true); await c.wait(2600, 1);
      setLang("ja"); await c.wait(2400, 1);
      setLang("zh-CN"); await c.wait(2000, 1);
    } },
  { text: "투시 모드: 판 속 나무못과 볼트까지 들여다봐요",
    run: async (c) => { c.api.goStep(c.api.xrayStep); await c.wait(1800); c.api.setXray(true); c.spin(true, 6); await c.wait(5200); } },
  { text: "도면 · 툰 · 원목, 보는 방식도 바로 바꿔요",
    run: async (c) => { c.api.goStep(c.api.xrayStep); c.api.setStyle("technical"); await c.wait(1800); c.api.setStyle("toon"); await c.wait(1800); c.api.setStyle("color"); await c.wait(800); } },
  { text: "지금까지 쓴 부품과 남은 부품을 한눈에",
    run: async (c) => { c.api.goStep(c.api.xrayStep); c.api.setInventory(true); await c.wait(3800); } },
  { text: "부품을 @태그로 짚어 말하면 AI가 수정안을 만들어 줘요", chat: true,
    run: async (c) => {
      c.api.goStep(c.api.xrayStep); // 6단계 나무못 수정이라 그 단계에서 시작(적용 뒤에도 6단계)
      chatCommand({ type: "reset" }); chatOpened = true; await c.wait(400, 1);
      chatCommand({ type: "preset", id: "hardware_qty" });
      await chatDone(c);
      await reviewProposal(c, 3200);
    } },
  { text: "판 두께처럼 맞물린 곳까지 바뀌는 수정도 AI가: 전/후를 비교해 검수하고, 적용하고, 되돌려요", chat: true,
    run: async (c) => {
      c.api.goStep(Math.max(0, c.api.addStep("outer_top"))); // 적용하면 윗판이 붙는 단계로 가므로 처음부터 거기서 시작
      chatCommand({ type: "reset" }); chatOpened = true; await c.wait(400, 1);
      chatCommand({ type: "preset", id: "panel_thickness" });
      await chatDone(c);
      await reviewProposal(c, 3800);
    } },
  { text: "분해도: 판을 펼쳤다가 다시 맞물려요",
    run: async (c) => { playExplode(); await c.wait(7000, 1); } },
  { text: "완성. 설명서 한 권, 어느 나라에서든 끝까지 따라 만들 수 있게",
    run: async (c) => { c.api.goStep(c.api.lastStep); await c.wait(1500); c.spin(true, 4); await c.wait(6000); } },
];
const TOTAL = SCENES.length;

// ── 상태(자막·진행) ───────────────────────────────────────
type View = { n: number; text: string } | null;
let view: View = null;
let control: { scene: AbortController; stopped: boolean } | null = null;
// 사용자가 조작해 멈춘 장면. 다시 ▶ 를 누르면 그 장면부터 이어서 튼다(끝까지 보면 0으로 돌아가 처음부터).
let resumeFrom = 0;
let lastApi: TourApi | null = null; // 멈춘 데모를 ← → 로 다시 틀 때 쓴다
const listeners = new Set<() => void>();
const setView = (v: View) => { view = v; listeners.forEach((l) => l()); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export const useTourView = () => useSyncExternalStore(subscribe, () => view);
export const useTourResume = () => useSyncExternalStore(subscribe, () => resumeFrom);
export const tourRunning = () => control !== null;

export function stopTour() {
  if (!control) return;
  control.stopped = true;
  control.scene.abort("stop");
}

// from을 주면 그 장면부터, 없으면 멈췄던 장면(처음이면 0)부터 튼다.
export async function startTour(api: TourApi, from?: number) {
  if (control) return;
  lastApi = api;
  const startLang = getLang();
  const voiceWas = isVoiceOn();
  const orbit = api.orbit();
  const tweens: gsap.core.Tween[] = [];
  const state = { scene: new AbortController(), stopped: false };
  control = state;

  const wait = (ms: number, scale = PACE) => new Promise<void>((resolve, reject) => {
    const signal = state.scene.signal;
    if (signal.aborted) return reject(signal.reason);
    const id = setTimeout(resolve, ms * scale);
    signal.addEventListener("abort", () => { clearTimeout(id); reject(signal.reason); }, { once: true });
  });
  const until = async (ok: () => boolean, max: number) => {
    const t0 = performance.now();
    while (!ok() && performance.now() - t0 < max) await wait(200, 1);
  };
  const spin = (on: boolean, speed = 5) => { if (orbit) { orbit.autoRotate = on; orbit.autoRotateSpeed = speed; } };
  // 확대·축소는 카메라를 목표점 쪽으로 밀고 당긴다. 끝은 애니메이션 콜백 대신 시간으로 기다린다.
  const zoom = async (factor: number, seconds: number) => {
    if (!orbit) return;
    const cam = orbit.object;
    const dir = cam.position.clone().sub(orbit.target);
    const d = { v: dir.length() };
    dir.normalize();
    tweens.push(gsap.to(d, {
      v: d.v * factor, duration: seconds, ease: "power2.inOut",
      onUpdate: () => { cam.position.copy(orbit.target).addScaledVector(dir, d.v); orbit.update(); },
    }));
    await wait(seconds * 1000 + 100, 1);
  };
  const setVoice = (on: boolean) => { if (isVoiceOn() !== on) toggleVoice(); };
  const ctx: Ctx = { api, wait, until, spin, zoom, setVoice };
  // 장면 사이 기본 상태. 띄워 둔 수정안이 있으면 취소해 도면을 바꿔 두지 않는다.
  const base = (keepChat: boolean) => {
    tweens.splice(0).forEach((tw) => tw.kill());
    spin(false); api.setXray(false); api.setStyle("color"); api.setInventory(false);
    speechSynthesis.cancel(); setVoice(voiceWas); setLang(startLang);
    const open = getCompare()?.proposal;
    if (open?.status === "pending" && open.id === ownId) decideProposal(open.id, "reject");
    if (appliedId) { decideProposal(appliedId, "undo"); appliedId = null; }
    ownId = null;
    if (!keepChat && chatOpened) { chatCommand({ type: "close" }); chatOpened = false; }
  };

  // 사용자가 화면을 만지면(클릭·드래그·휠·키) 데모는 바로 멈추고 손을 뗀다. 자막과 재생 버튼은 예외다.
  const handsOn = (e: Event) => {
    if (e instanceof KeyboardEvent) {
      // 키는 초점이 재생 버튼에 남아 있어도 조작으로 본다(장면 이동·멈춤 키만 뺀다).
      if (["ArrowLeft", "ArrowRight", "Escape"].includes(e.key)) return;
    } else if ((e.target as HTMLElement | null)?.closest?.(".tour-caption, .playback")) return;
    stopTour();
  };
  const INPUTS = ["pointerdown", "wheel", "touchstart", "keydown"] as const;
  INPUTS.forEach((type) => window.addEventListener(type, handsOn, { capture: true, passive: true }));

  let i = from ?? resumeFrom;
  while (i < TOTAL && !state.stopped) {
    state.scene = new AbortController();
    base(!!SCENES[i].chat);
    setView({ n: i + 1, text: SCENES[i].text });
    let move = "next";
    try {
      await SCENES[i].run(ctx);
      await wait(500, 1);
    } catch (e) {
      move = String(e);
    }
    i = move === "prev" ? Math.max(0, i - 1) : move === "stop" ? i : i + 1; // 멈춘 장면은 이어서 틀 때 처음부터 다시
  }
  INPUTS.forEach((type) => window.removeEventListener(type, handsOn, { capture: true }));
  resumeFrom = state.stopped && i < TOTAL ? i : 0;
  base(false);
  control = null;
  setView(null);
}

// 재생 중 ← → 는 단계 대신 장면을 넘기고 Esc는 멈춘다(캡처 단계에서 가로채 뷰어 단축키로 안 가게 한다).
export function useTourKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.("textarea, input, select")) return;
      // 사용자가 조작해 멈춘 데모는 → 면 다음 장면, ← 면 이전 장면부터 다시 튼다(뷰어 단계 이동 대신).
      if (!control) {
        const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
        if (!step || resumeFrom === 0 || !lastApi) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        startTour(lastApi, Math.min(TOTAL - 1, Math.max(0, resumeFrom + step)));
        return;
      }
      const move = e.key === "ArrowRight" ? "next" : e.key === "ArrowLeft" ? "prev" : e.key === "Escape" ? "stop" : null;
      if (!move) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (move === "stop") control.stopped = true;
      control.scene.abort(move);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}

export function TourCaption() {
  const v = useTourView();
  if (!v) return null;
  return (
    <div className="tour-caption" role="status" aria-live="polite" key={v.n}>
      <span className="tour-count">{v.n} / {TOTAL}</span>
      <p>{t(v.text)}</p>
      <button onClick={stopTour} aria-label={t("재생 멈추기")}>✕</button>
      <i className="tour-bar" style={{ width: `${(v.n / TOTAL) * 100}%` }} />
    </div>
  );
}
