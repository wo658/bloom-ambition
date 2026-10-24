import { useSyncExternalStore } from "react";
import gsap from "gsap";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import type { RenderStyle } from "./Assembly";
import { chatCommand, chatState } from "./bridge";
import { getLang, isVoiceOn, setLang, t, toggleVoice } from "./lang";

// 자동 재생에 얹는 기능 소개. 단계가 넘어가다 정해 둔 단계에 오면 자막과 함께 기능을 보여 준다
// (회전·확대, 보기 방식, 투시, 부품 현황, 언어와 음성, 음성으로 묻는 어시스턴트, 완성).
// 단계를 넘기거나 멈추면 하던 기능을 멈추고 원래 상태로 되돌린다.
export type GuideApi = {
  orbit: () => OrbitControlsImpl | null;
  setXray: (on: boolean) => void;
  setStyle: (style: RenderStyle) => void;
  setInventory: (on: boolean) => void;
};

// ponytail: 기능 장면 안의 기다림을 한 숫자로 줄인다(어시스턴트 답 기다림은 제외).
const PACE = 0.65;

type Ctx = {
  api: GuideApi;
  wait: (ms: number, scale?: number) => Promise<void>;
  until: (ok: () => boolean, max: number) => Promise<void>;
  spin: (on: boolean, speed?: number) => void;
  zoom: (factor: number, seconds: number) => Promise<void>;
  setVoice: (on: boolean) => void;
};

type Beat = { text: string; chat?: boolean; run: (c: Ctx) => Promise<void> };

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

const PREP_BEAT: Beat = { text: "부품부터 확인해요. 상자 속 부품을 바닥에 펼쳐 개수를 맞춰요", run: async (c) => { await c.wait(1500); } };
const FINAL_BEAT: Beat = { text: "완성. 설명서 한 권, 어느 나라에서든 끝까지 따라 만들 수 있게",
  run: async (c) => { c.spin(true, 4); await c.wait(6000); } };
// 앞에서 몇 번째 단계(0부터)에서 어떤 기능을 보여 줄지.
const BEATS: [number, Beat][] = [
  [0, { text: "돌려 보고, 확대해서 자세히 봐요",
    run: async (c) => { c.spin(true, 9); await c.wait(3200); c.spin(false); await c.zoom(0.55, 1.1); await c.wait(900); await c.zoom(1 / 0.55, 1); } }],
  [2, { text: "도면 · 툰 · 원목, 보는 방식도 바로 바꿔요",
    run: async (c) => { c.api.setStyle("technical"); await c.wait(1700); c.api.setStyle("toon"); await c.wait(1700); c.api.setStyle("color"); await c.wait(700); } }],
  [5, { text: "투시 모드: 판 속 나무못과 볼트까지 들여다봐요",
    run: async (c) => { c.api.setXray(true); c.spin(true, 6); await c.wait(5200); c.spin(false); c.api.setXray(false); } }],
  [7, { text: "지금까지 쓴 부품과 남은 부품을 한눈에",
    run: async (c) => { c.api.setInventory(true); await c.wait(3600); c.api.setInventory(false); } }],
  [9, { text: "10개 언어로 바꾸고, 음성으로 읽어 줘요",
    run: async (c) => {
      setLang("en"); c.setVoice(true); await c.wait(900); await c.until(() => !speechSynthesis.speaking, 9000);
      setLang("ja"); await c.wait(900); await c.until(() => !speechSynthesis.speaking, 9000);
    } }],
  [11, { text: "도면 어시스턴트에게 말로 물어보세요 (음성 입력 재현)", chat: true,
    run: async (c) => {
      chatCommand({ type: "reset" });
      chatCommand({ type: "voice", text: t("지금 단계 설명을 더 쉽게 바꿔 줘") });
      await chatDone(c); await c.wait(3000);
      chatCommand({ type: "undo" }); await c.wait(1500, 1);
    } }],
];

// 자동 재생 중인 단계(index, PREP이면 부품 확인)에 붙은 기능. 마지막 단계는 완성 장면이다.
export function beatAt(index: number, total: number, prep: number): Beat | null {
  if (index === prep) return PREP_BEAT;
  if (index === total - 1) return FINAL_BEAT;
  return BEATS.find(([at]) => at === index && at < total - 1)?.[1] ?? null;
}

// ── 자막 상태 ─────────────────────────────────────────────
let caption: string | null = null;
const listeners = new Set<() => void>();
const setCaption = (text: string | null) => { caption = text; listeners.forEach((l) => l()); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export function GuideCaption({ onStop }: { onStop: () => void }) {
  const text = useSyncExternalStore(subscribe, () => caption);
  if (!text) return null;
  return (
    <div className="tour-caption" role="status" aria-live="polite" key={text}>
      <p>{t(text)}</p>
      <span className="tour-keys">← →</span>
      <button onClick={onStop} aria-label={t("재생 멈추기")}>✕</button>
    </div>
  );
}

// 한 단계의 재생: 단계 애니메이션(ms)과 읽던 음성을 기다리고, 붙은 기능이 있으면 자막과 함께 보여 준다.
// signal이 끊기면(단계 이동·멈춤) 바로 멈추고, 바꿔 놓은 것을 되돌린다.
export async function playStep(beat: Beat | null, ms: number, api: GuideApi, signal: AbortSignal) {
  const orbit = api.orbit();
  const tweens: gsap.core.Tween[] = [];
  const startLang = getLang();
  const voiceWas = isVoiceOn();
  const wait = (n: number, scale = PACE) => new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const id = setTimeout(resolve, n * scale);
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
  try {
    if (beat) setCaption(beat.text);
    await wait(ms, 1);
    await until(() => !speechSynthesis.speaking && !speechSynthesis.pending, 15000);
    if (beat) await beat.run({ api, wait, until, spin, zoom, setVoice });
  } finally {
    tweens.forEach((tw) => tw.kill());
    spin(false);
    if (beat) {
      api.setXray(false); api.setStyle("color"); api.setInventory(false);
      if (getLang() !== startLang || isVoiceOn() !== voiceWas) { speechSynthesis.cancel(); setVoice(voiceWas); setLang(startLang); }
      if (beat.chat) chatCommand({ type: "close" });
    }
    setCaption(null);
  }
}
