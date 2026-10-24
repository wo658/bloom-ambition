// 도면 수정의 Before / After. 작업자는 "줄로 된 차이"가 아니라 도면 자체가 바뀌는 모습을 본다.
// 모든 수정(AI patch_scene, 예시 액션)은 바로 적용하지 않고 "수정안(Proposal)"으로 먼저 띄운다.
// 1) 3D: 뷰어가 바뀐 곳으로 카메라를 옮기고 Before 모습을 잠깐 보여 준 뒤, 도면이 After 로 변하는 과정을 재생한다.
//    빠지는 부품은 빨갛게 물들며 들려 사라지고, 생기는 부품은 초록으로 내려앉고, 크기가 바뀌는 판은 그 축으로 늘고 줄며
//    치수 말풍선이 "3.8 → 2.5 cm"로 바뀌고, 옮겨지는 판·철물은 이전 자리에 옅은 윤곽을 남기고 미끄러져 간다.
// 2) 설명 카드: 지워지는 글자는 빨간 취소선 뒤 접히고, 새 글자는 초록으로 타이핑되듯 들어온다.
//    타임라인: 합쳐지는 단계 칸이 하나로 모이고 뒤 번호가 굴러 바뀐다.
// 3) 검토 막대(뷰어 아래 가운데): [Before | After] 전환(전환할 때마다 변하는 과정을 다시 재생), [↻ 다시 보기], [취소] [적용].
//    채팅에는 줄 목록 없이 한 줄 요약 카드와 같은 [적용] [취소] 버튼만 둔다. 적용 뒤에는 [되돌리기]·[다시 보기].
// 대기 중(pending)에는 실제 scene은 그대로이고, 뷰어는 proposal.before / after 를 그려 보여 준다. [적용]을 눌러야 scene이 바뀐다.
// 이 파일은 계약(타입·공용 상태)만 둔다. 차이 계산은 sceneDiff.ts(재생을 이끄는 내부 데이터), 3D 재생은 ChangeScene.tsx,
// 설명 카드·타임라인·검토 막대는 ChangeHud.tsx, 수정안 만들기와 적용·취소는 ChatPanel.tsx.
import { useSyncExternalStore } from "react";
import type { Scene, Vec3 } from "./types";

// ---------- 차이(diff) ----------

// 글자 차이 조각. 지운 것(del)은 취소선, 넣은 것(ins)은 강조.
export type TextSeg = { kind: "same" | "del" | "ins"; text: string };

// 단계는 번호가 밀릴 수 있어 before/after 번호를 따로 든다(합치기·삭제·추가).
export type StepRef = { before?: number; after?: number };

export type DiffEntry =
  // 판재: 생김/빠짐/크기/위치
  | { type: "panel_added"; id: string; name: string; size: Vec3; pos: Vec3; step?: StepRef }
  | { type: "panel_removed"; id: string; name: string; size: Vec3; pos: Vec3; step?: StepRef }
  | { type: "panel_resized"; id: string; name: string; from: Vec3; to: Vec3; posFrom: Vec3; posTo: Vec3; axis: number[]; step?: StepRef } // axis: 바뀐 축 번호(0=x,1=y,2=z)
  | { type: "panel_moved"; id: string; name: string; from: Vec3; to: Vec3; step?: StepRef }
  // 철물 하나(steps[].small[]): 생김/빠짐/위치
  | { type: "small_added"; id: string; part_id: string; name: string; at: Vec3; step: StepRef }
  | { type: "small_removed"; id: string; part_id: string; name: string; at: Vec3; step: StepRef }
  | { type: "small_moved"; id: string; part_id: string; name: string; from: Vec3; to: Vec3; step: StepRef }
  | { type: "small_swapped"; id: string; fromPart: string; toPart: string; fromName: string; toName: string; at: Vec3; step: StepRef }
  // 단계에서 쓰는 철물 개수(steps[].uses[])
  | { type: "uses_qty"; part_id: string; name: string; from: number; to: number; step: StepRef }
  // 부품 목록(scene.parts[]) 개수
  | { type: "parts_qty"; part_id: string; name: string; from: number; to: number }
  // 단계 구조
  | { type: "steps_merged"; from: number[]; into: number } // before 번호들 → after 번호
  | { type: "step_added"; step: number }
  | { type: "step_removed"; step: number }
  | { type: "steps_renumbered"; count: number } // 뒤 단계 번호가 몇 개 밀렸는지(줄 하나로 요약)
  // 글자(설명·주의)
  | { type: "text"; field: "caption_ko" | "warning_ko"; step: StepRef; before: string; after: string; segs: TextSeg[] }
  // 전체 크기
  | { type: "product_size"; from: Vec3; to: Vec3 };

export interface SceneDiff {
  entries: DiffEntry[];
  // 3D에서 먼저 보여 줄 단계(after 번호). 가장 눈에 띄는 형상 변화가 있는 단계.
  focusStep: number | null;
  // 바뀐 부품 id 묶음(뷰어 강조용). small은 small[].id, panel은 panel id.
  changed: { added: string[]; removed: string[]; modified: string[] };
}

// ---------- 수정안(Proposal) ----------

export type ProposalStatus = "pending" | "applied" | "rejected" | "undone";

export interface Proposal {
  id: string;
  summary: string; // 카드 제목(한 줄)
  source: "ai" | "action";
  before: Scene;
  after: Scene;
  diff: SceneDiff;
  status: ProposalStatus;
}

// ---------- 뷰어 비교 상태(공용) ----------
// 수정안이 떠 있거나(pending) 사용자가 적용된 카드에서 비교를 다시 열면 뷰어가 이 상태를 읽어 Before / After 를 그린다.
// mode: 지금 3D에 그리는 쪽. focus: 카드의 줄을 눌렀을 때 그 항목으로 카메라를 옮긴다.
export interface CompareState {
  proposal: Proposal;
  mode: "before" | "after";
  playKey: number; // 바뀔 때마다 Before → After 변화를 처음부터 다시 재생한다
  focus?: { entry: number; key: number };
}

let compare: CompareState | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function setCompare(next: CompareState | null) {
  compare = next;
  emit();
}

export function updateCompare(patch: Partial<CompareState>) {
  if (!compare) return;
  compare = { ...compare, ...patch };
  emit();
}

export function getCompare() {
  return compare;
}

export function useCompare() {
  return useSyncExternalStore((l) => {
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, () => compare);
}

// [적용]·[취소]·[되돌리기]는 scene과 되돌리기 기록을 가진 ChatPanel이 처리한다. 뷰어의 검토 막대도 이걸 부른다.
export type Decision = "apply" | "reject" | "undo";
let decider: ((id: string, decision: Decision) => void) | null = null;

export function setProposalDecider(fn: ((id: string, decision: Decision) => void) | null) {
  decider = fn;
}

export function decideProposal(id: string, decision: Decision) {
  decider?.(id, decision);
}
