// 예시(액션) 수정안을 [적용]한 뒤 화면에서 이어서 보여 줄 연출. 액션마다 자기 case만 고친다.
// Before → After 변화는 이미 검토 화면(ChangeScene·ChangeHud)이 보여 줬으므로 같은 걸 다시 틀지 않는다.
// 여기서는 검토 화면이 닫힌 뒤 실제 뷰어를 바뀐 자리(단계)로 옮기고, 검토 화면이 못 보여 주는 것(합친 단계의 이어진 동작)만 튼다.
// ChatPanel이 적용 → 검토 화면을 닫은 다음에 부른다(before = 적용 전 scene, after = 적용 뒤 scene).
// 브라우저 전용(bridge 사용)이라 서버(api/chat.ts)는 이 파일을 가져오지 않는다.
import type { Scene } from "./types";
import type { ActionMeta } from "./actions";
import { goToStep, replayStep } from "./bridge";

export interface EffectContext { before: Scene; after: Scene }

// 판이 처음 붙는 단계.
const addStep = (scene: Scene, id: string) => scene.steps.find((s) => s.adds.includes(id))?.number;

// 처리했으면 true(아니면 ChatPanel이 차이의 focusStep으로 옮긴다).
export function afterAction(meta: ActionMeta, ctx: EffectContext): boolean {
  switch (meta.id) {
    case "panel_thickness":
    case "panel_move": {
      // 두께를 바꾸거나 옮긴 판이 붙는 단계로 간다.
      const n = addStep(ctx.after, String(meta.params.panel));
      if (n == null) return false;
      goToStep(n);
      return true;
    }
    case "hardware_qty": {
      // 개수를 바꾼 단계로 간다(그 단계 애니메이션이 남은 철물로 다시 돈다).
      const n = Number(meta.params.step);
      if (!ctx.after.steps.some((s) => s.number === n)) return false;
      goToStep(n);
      return true;
    }
    case "merge_steps": {
      // 합친 단계로 가서 처음부터 다시 튼다: 나무못을 박고 → 선반이 밀려 들어오는 동작이 한 단계에서 이어져 보인다.
      // 바뀐 scene이 그려진 다음 프레임에 부른다(지금 부르면 뷰어는 합치기 전 단계를 튼다).
      const n = Number(meta.params.step);
      if (!ctx.after.steps.some((s) => s.number === n)) return false;
      requestAnimationFrame(() => replayStep(n));
      return true;
    }
    default: return false;
  }
}
