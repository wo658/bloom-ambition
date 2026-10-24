import { useEffect, useRef, useState } from "react";
import gsap from "gsap";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import type { RenderStyle } from "./Assembly";
import { chatCommand, chatState } from "./bridge";
import { getLang, isVoiceOn, setLang, t, toggleVoice } from "./lang";

// 발표용 데모. 회전·확대·단계 진행·투시·보기 방식·부품 현황·언어와 음성·음성으로 묻는 어시스턴트를 장면 10개로 보여 준다.
// 자동은 장면이 끝나면 다음으로 넘어가고, 반자동은 → 를 눌러야 넘어간다. 둘 다 ← → 로 장면을 오가고 Esc·✕로 멈춘다.
// 장면마다 시작할 때 기본 상태로 되돌린 뒤 자기 장면을 만들므로, 어느 장면으로 건너뛰어도 화면이 맞는다.
export type TourApi = {
  orbit: () => OrbitControlsImpl | null;
  goStep: (index: number) => void;
  setXray: (on: boolean) => void;
  setStyle: (style: RenderStyle) => void;
  setInventory: (on: boolean) => void;
  xrayStep: number;
  prepStep: number;
  lastStep: number;
};

// ponytail: 장면 안의 기다림을 한 숫자로 줄인다. 더 빠르게/느리게는 이 값만 바꾼다(어시스턴트 답 기다림은 제외).
const PACE = 0.65;

type Ctx = {
  api: TourApi;
  wait: (ms: number) => Promise<void>;
  until: (ok: () => boolean, max: number) => Promise<void>;
  spin: (on: boolean, speed?: number) => void;
  zoom: (factor: number, seconds: number) => Promise<void>;
  setVoice: (on: boolean) => void;
  startLang: string;
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

const SCENES: { text: string; run: (c: Ctx) => Promise<void> }[] = [
  { text: "설명서 PDF 한 권이 움직이는 3D 조립 가이드가 됩니다",
    run: async (c) => { c.api.goStep(0); await c.wait(900); c.spin(true, 9); await c.wait(4200); c.spin(false); } },
  { text: "돌려 보고, 확대해서 자세히 봐요",
    run: async (c) => { c.api.goStep(0); await c.wait(500); await c.zoom(0.55, 1.1); await c.wait(900); await c.zoom(1 / 0.55, 1); } },
  { text: "부품부터 확인하고, 단계마다 순서대로 제자리에 넣어요",
    run: async (c) => { c.api.goStep(c.api.prepStep); await c.wait(3600); c.api.goStep(0); await c.wait(3600); c.api.goStep(1); await c.wait(3600); } },
  { text: "투시 모드: 판 속 나무못과 볼트까지 들여다봐요",
    run: async (c) => { c.api.goStep(c.api.xrayStep); await c.wait(2400); c.api.setXray(true); c.spin(true, 6); await c.wait(5000); c.spin(false); } },
  { text: "도면 · 툰 · 원목, 보는 방식도 바로 바꿔요",
    run: async (c) => { c.api.goStep(c.api.xrayStep); c.api.setStyle("technical"); await c.wait(1700); c.api.setStyle("toon"); await c.wait(1700); c.api.setStyle("color"); await c.wait(900); } },
  { text: "지금까지 쓴 부품과 남은 부품을 한눈에",
    run: async (c) => { c.api.goStep(c.api.xrayStep); c.api.setInventory(true); await c.wait(3600); c.api.setInventory(false); } },
  { text: "10개 언어로 바꾸고, 음성으로 읽어 줘요",
    run: async (c) => {
      c.api.goStep(1);
      setLang("en"); c.setVoice(true); await c.wait(900); await c.until(() => !speechSynthesis.speaking, 9000);
      setLang("ja"); await c.wait(900); await c.until(() => !speechSynthesis.speaking, 9000);
    } },
  { text: "도면 어시스턴트에게 말로 물어보세요 (음성 입력 재현)",
    run: async (c) => {
      chatCommand({ type: "reset" });
      chatCommand({ type: "voice", text: t("3단계로 가서 설명을 더 쉽게 바꿔 줘") });
      await chatDone(c); await c.wait(3000);
    } },
  { text: "바꾼 내용은 되돌리기 한 번이면 원래대로",
    run: async (c) => { chatCommand({ type: "open" }); await c.wait(600); chatCommand({ type: "undo" }); await c.wait(2400); } },
  { text: "설명서 한 권, 어느 나라에서든 끝까지 따라 만들 수 있게",
    run: async (c) => { c.api.goStep(c.api.lastStep); await c.wait(2500); c.spin(true, 4); await c.wait(5000); } },
];
const TOTAL = SCENES.length;

export default function DemoTour({ api }: { api: TourApi }) {
  // 기본은 반자동(발표자가 → 로 넘김). 데모 중 자막의 '자동 재생'으로 언제든 바꾼다. ?tour=auto로 열면 자동.
  const [semi, setSemiState] = useState(() => new URLSearchParams(location.search).get("tour") !== "auto");
  const semiRef = useRef(semi);
  const setSemi = (v: boolean) => {
    semiRef.current = v;
    setSemiState(v);
    // → 를 기다리던 중에 자동으로 바꾸면 바로 다음 장면으로 간다.
    if (!v && readyRef.current) control.current?.scene.abort("next");
  };
  const readyRef = useRef(false);
  const [view, setView] = useState<{ n: number; text: string; ready: boolean } | null>(null);
  const control = useRef<{ scene: AbortController; stopped: boolean } | null>(null);

  // 데모 중에는 ← → 가 단계 대신 장면을 넘긴다(캡처 단계에서 가로채 뷰어 단축키로 안 가게 한다).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const c = control.current;
      if (!c || (e.target as HTMLElement)?.closest?.("textarea, input, select")) return;
      const move = e.key === "ArrowRight" ? "next" : e.key === "ArrowLeft" ? "prev" : e.key === "Escape" ? "stop" : null;
      if (!move) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (move === "stop") c.stopped = true;
      c.scene.abort(move);
    };
    window.addEventListener("keydown", onKey, true);
    return () => { window.removeEventListener("keydown", onKey, true); control.current?.scene.abort("stop"); };
  }, []);

  const stop = () => { const c = control.current; if (c) { c.stopped = true; c.scene.abort("stop"); } };

  const run = async () => {
    if (control.current) { stop(); return; }
    const startLang = getLang();
    const voiceWas = isVoiceOn();
    const orbit = api.orbit();
    const tweens: gsap.core.Tween[] = [];
    const state = { scene: new AbortController(), stopped: false };
    control.current = state;

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
    // 확대·축소는 카메라를 목표점 쪽으로 밀고 당긴다. 끝은 애니메이션 콜백 대신 시간으로 기다린다(장면을 넘겨도 바로 반응).
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
    const ctx: Ctx = { api, wait, until, spin, zoom, setVoice, startLang };
    // 장면 사이 기본 상태. 어시스턴트 장면(8·9) 사이에서는 채팅을 열어 둔다.
    const base = (i: number) => {
      tweens.splice(0).forEach((tw) => tw.kill());
      spin(false); api.setXray(false); api.setStyle("color"); api.setInventory(false);
      speechSynthesis.cancel(); setVoice(voiceWas); setLang(startLang);
      if (i < 7) chatCommand({ type: "close" });
    };

    let i = 0;
    while (i < TOTAL && !state.stopped) {
      state.scene = new AbortController();
      base(i);
      readyRef.current = false;
      setView({ n: i + 1, text: SCENES[i].text, ready: false });
      let move = "next";
      try {
        await SCENES[i].run(ctx);
        readyRef.current = true;
        setView({ n: i + 1, text: SCENES[i].text, ready: true });
        // 반자동은 → 를 기다리고(마지막 장면 포함), 자동은 잠깐 숨을 고른 뒤 넘어간다.
        await (semiRef.current ? new Promise<void>((_, reject) => state.scene.signal.addEventListener("abort", () => reject(state.scene.signal.reason), { once: true })) : wait(500));
      } catch (e) {
        move = String(e);
      }
      i = move === "prev" ? Math.max(0, i - 1) : i + 1;
    }
    base(0);
    chatCommand({ type: "close" });
    control.current = null;
    setView(null);
  };

  // ?tour=1(반자동)·?tour=auto(자동)면 열자마자 시작한다. 음성은 클릭 전이면 브라우저가 막을 수 있다.
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    const mode = new URLSearchParams(location.search).get("tour");
    if (!mode) return;
    const id = setTimeout(() => runRef.current(), 1500);
    return () => clearTimeout(id);
  }, []);

  return (
    <>
      <button className={`demo-btn ${view ? "on" : ""}`} onClick={run}
        title={t(view ? "데모 멈추기 (Esc)" : "모든 기능을 차례로 보여 주는 데모 (→ 로 넘기기)")}>
        {view ? "■" : "▶"} {t(view ? "데모 멈추기" : "데모")}
      </button>
      {view && (
        <div className="tour-caption" role="status" aria-live="polite" key={view.n}>
          <span className="tour-count">{view.n} / {TOTAL}</span>
          <p>{t(view.text)}</p>
          <span className={`tour-keys ${semi && view.ready ? "ready" : ""}`}>{semi && view.ready ? "→" : "← →"}</span>
          <button className={`tour-auto ${semi ? "" : "on"}`} onClick={() => setSemi(!semi)} aria-pressed={!semi}
            title={t(semi ? "자동 재생 켜기: 장면이 끝나면 저절로 넘어가요" : "자동 재생 끄기: → 를 눌러 넘겨요")}>
            {semi ? "▶▶" : "❚❚"} {t("자동 재생")}
          </button>
          <button onClick={stop} aria-label={t("데모 멈추기")}>✕</button>
          <i className="tour-bar" style={{ width: `${(view.n / TOTAL) * 100}%` }} />
        </div>
      )}
    </>
  );
}
