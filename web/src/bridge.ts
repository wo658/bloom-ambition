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
