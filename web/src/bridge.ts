// 뷰어(가구·프라모델)와 떠 있는 원본 PDF 위젯을 잇는 작은 공용 상태.
// 뷰어는 단계가 바뀔 때 setCurrentStep을 부르고, goToStep 요청을 onGoToStep으로 받는다.
import { useSyncExternalStore } from "react";

export type CurrentStep = { index: number; number: number | string; page: number; title?: string };

let current: CurrentStep | null = null;
let pdfPage: number | null = null;
const listeners = new Set<() => void>();
const goToHandlers = new Set<(stepNumber: number) => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => { listeners.delete(l); };
};

// ?demo가 없으면 가구 뷰어(KALLAX)다. 서버(server/api.ts)의 DEFAULT_DEMO와 맞춘다.
export const demoName = new URLSearchParams(location.search).get("demo") ?? "kallax";

export function setCurrentStep(step: CurrentStep) {
  current = step;
  emit();
}

export function useCurrentStep() {
  return useSyncExternalStore(subscribe, () => current);
}

export function openPdf(page?: number) {
  pdfPage = page ?? current?.page ?? 1;
  emit();
}

export function closePdf() {
  pdfPage = null;
  emit();
}

export function usePdfPage() {
  return useSyncExternalStore(subscribe, () => pdfPage);
}

// 단계 이동 요청은 화면에 보이는 단계 번호(N)로 한다.
export function onGoToStep(handler: (stepNumber: number) => void) {
  goToHandlers.add(handler);
  return () => { goToHandlers.delete(handler); };
}

export function goToStep(stepNumber: number) {
  goToHandlers.forEach((h) => h(stepNumber));
}

export function canGoToStep() {
  return goToHandlers.size > 0;
}

// 부품 조립 모션: 채팅(액션·AI 도구)이 부품 하나를 고르면 뷰어가 그 부품이 들어가는 단계로 가서
// 카메라를 그 부품에 맞추고 강조한 채로 조립 애니메이션을 다시 튼다.
export type MotionTarget = { kind: "panel" | "hardware"; id: string; instance?: string };
const motionHandlers = new Set<(target: MotionTarget) => number | null>();

export function onPlayPartMotion(handler: (target: MotionTarget) => number | null) {
  motionHandlers.add(handler);
  return () => { motionHandlers.delete(handler); };
}

// 보여 줄 단계 번호를 돌려준다. 뷰어가 없거나 그 부품이 쓰이는 단계가 없으면 null.
export function playPartMotion(target: MotionTarget): number | null {
  let shown: number | null = null;
  motionHandlers.forEach((h) => { shown = h(target) ?? shown; });
  return shown;
}

// 단계 다시 보기: n단계로 가서 조립 애니메이션을 처음부터 다시 튼다(예: 단계를 합친 직후 합친 동작 보여 주기).
// 뷰어가 onReplayStep으로 받으면 그것을 쓰고, 아직 받지 않으면 옆 단계에 한 프레임 들렀다 돌아와 같은 효과를 낸다.
const replayHandlers = new Set<(stepNumber: number) => void>();

export function onReplayStep(handler: (stepNumber: number) => void) {
  replayHandlers.add(handler);
  return () => { replayHandlers.delete(handler); };
}

export function replayStep(stepNumber: number) {
  if (replayHandlers.size) return replayHandlers.forEach((h) => h(stepNumber));
  goToStep(stepNumber > 1 ? stepNumber - 1 : stepNumber + 1);
  requestAnimationFrame(() => goToStep(stepNumber));
}

// 분해도: 완성된 가구를 판마다 바깥쪽으로 펼쳤다가 다시 맞물리게 조립하는 연출. 뷰어가 없으면 false.
const explodeHandlers = new Set<() => boolean>();

export function onPlayExplode(handler: () => boolean) {
  explodeHandlers.add(handler);
  return () => { explodeHandlers.delete(handler); };
}

export function playExplode(): boolean {
  let ok = false;
  explodeHandlers.forEach((h) => { ok = h() || ok; });
  return ok;
}

// 데모 재생(Tour)이 채팅을 조종하는 통로. ChatPanel이 듣고, 지금 바쁜지(chatState.busy)를 알려 준다.
// preset은 채팅의 대표 예시(actions.ts PRESETS) 하나를 id로 골라 누른 것처럼 실행한다(수정안이 뜬다).
export type ChatCommand = { type: "open" | "close" | "reset" | "undo" } | { type: "voice"; text: string } | { type: "preset"; id: string };
export const chatBus = new EventTarget();
export const chatState = { busy: false };
export function chatCommand(cmd: ChatCommand) {
  chatBus.dispatchEvent(new CustomEvent("cmd", { detail: cmd }));
}

// 오프닝(심사위원용 첫 화면)을 보여 줄지: 기본으로 보여 주고, ?intro=0·특정 단계 링크(?step=N)·키트(?demo=…)면 건너뛴다.
export function introEnabled() {
  const q = new URLSearchParams(location.search);
  return !q.get("demo") && !q.has("step") && q.get("intro") !== "0";
}

// 오프닝이 끝나 실제 뷰어로 넘어갔다는 신호(건너뛰기 포함). 뷰어는 이걸 받아 데모 재생을 이어 튼다.
const introDoneHandlers = new Set<() => void>();
export function onIntroDone(handler: () => void) {
  introDoneHandlers.add(handler);
  return () => { introDoneHandlers.delete(handler); };
}
export function introDone() {
  introDoneHandlers.forEach((h) => h());
}
