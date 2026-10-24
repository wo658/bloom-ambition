// 부품 태그: 화면(3D·부품 카드)에서 부품을 누르면 채팅 입력창에 "@바닥판"처럼 태그가 들어가고,
// 보낼 때 그 부품의 context(scene 속 위치·JSON 경로·쓰이는 단계)를 같이 실어 AI가 어느 부품 얘기인지 알게 한다.
import { useSyncExternalStore } from "react";
import type { Scene } from "./types";

export interface PartTag {
  kind: "panel" | "hardware";
  id: string; // 판재 id 또는 철물 part_id
  instance?: string; // 3D에서 특정 철물 하나를 눌렀을 때 그 small[].id(예: s1-104321-0)
  label: string; // 입력창에 들어가는 이름(@ 뒤). 철물 하나면 "나무못(2단계 1번)"처럼 단계·번호까지 붙여 서로 구분한다.
}

// "벽용 나사 (미포함, 벽 재질에 맞게 별도 구매)" → "벽용 나사"
const bare = (name: string) => name.replace(/\s*\([^)]*\)\s*$/, "");

export function partTag(scene: Scene, id: string, instance?: string): PartTag | null {
  const panel = scene.panels.find((p) => p.id === id);
  if (panel) return { kind: "panel", id, label: bare(panel.name_ko) };
  const name = scene.parts?.find((p) => p.id === id)?.name_ko
    ?? scene.steps.flatMap((s) => s.uses).find((u) => u.part_id === id)?.name_ko;
  if (!name && !scene.hardware?.[id]) return null;
  return { kind: "hardware", id, instance, label: bare(name ?? id) };
}

// 3D에서 누른 철물 하나(small[].id)의 태그. 나무못처럼 같은 철물이 여럿이면
// 처음 나오는 단계와 그 단계에서 같은 철물 가운데 몇 번째인지로 이름을 붙인다.
export function smallTag(scene: Scene, smallId: string): PartTag | null {
  for (const s of scene.steps) {
    const part = s.small.find((x) => x.id === smallId);
    if (!part) continue;
    const tag = partTag(scene, part.part_id, smallId);
    if (!tag) return null;
    const same = s.small.filter((x) => x.part_id === part.part_id);
    return same.length > 1 || scene.steps.some((o) => o !== s && o.small.some((x) => x.part_id === part.part_id))
      ? { ...tag, label: `${tag.label}(${s.number}단계 ${same.indexOf(part) + 1}번)` }
      : tag;
  }
  return null;
}

// 글에 "@이름"이 태그로 들어 있는지. "@나무못"은 "@나무못(2단계 1번)" 안에 있어도 따로 센다.
export function mentionRe(label: string, flags = "") {
  return new RegExp(`@${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![(\\p{L}\\p{N}])`, `u${flags}`);
}

export const hasMention = (text: string, label: string) => mentionRe(label).test(text);

// AI에게 넘길 부품 context. scene이 바뀌어도 항상 지금 scene에서 다시 만든다.
export function partContext(scene: Scene, tag: PartTag): string {
  const lines = [`@${tag.label}`];
  if (tag.kind === "panel") {
    const i = scene.panels.findIndex((p) => p.id === tag.id);
    const p = scene.panels[i];
    if (!p) return `${lines[0]}: scene에 없는 부품(${tag.id})`;
    const steps = scene.steps.filter((s) => s.adds.includes(p.id) || s.reseat?.includes(p.id)).map((s) => `${s.number}단계`);
    lines.push(`- 판재 id=${p.id}, 경로 /panels/${i}, 크기 ${p.size.join("×")}cm, 위치 pos=[${p.pos.join(", ")}]`);
    if (steps.length) lines.push(`- 쓰이는 단계: ${steps.join(", ")}`);
  } else {
    const entry = scene.parts?.find((p) => p.id === tag.id);
    const spec = scene.hardware?.[tag.id];
    lines.push(`- 철물 part_id=${tag.id}${entry ? `, 상자 속 ${entry.qty}개${entry.included ? "" : "(상자에 없음, 따로 준비)"}` : ""}${spec ? `, 모양 ${spec.model}` : ""}`);
    if (spec) lines.push(`- 모양 사양 경로 /hardware/${tag.id}`);
    const uses = scene.steps.flatMap((s, si) => {
      const ui = s.uses.findIndex((u) => u.part_id === tag.id);
      return ui < 0 ? [] : [`${s.number}단계 ${s.uses[ui].qty}개(/steps/${si}/uses/${ui})`];
    });
    if (uses.length) lines.push(`- 쓰이는 단계: ${uses.join(", ")}`);
    if (tag.instance) {
      scene.steps.forEach((s, si) => {
        const k = s.small.findIndex((x) => x.id === tag.instance);
        if (k >= 0) lines.push(`- 사용자가 화면에서 누른 것: ${s.number}단계의 ${tag.instance}(/steps/${si}/small/${k}), 위치 at=[${s.small[k].at.join(", ")}]`);
      });
    }
  }
  return lines.join("\n");
}

// 뷰어 → 채팅으로 태그를 보내는 작은 통로(bridge.ts의 goToStep과 같은 방식).
const handlers = new Set<(tag: PartTag) => void>();

export function mentionPart(tag: PartTag | null) {
  if (tag) handlers.forEach((h) => h(tag));
}

export function onMentionPart(handler: (tag: PartTag) => void) {
  handlers.add(handler);
  return () => { handlers.delete(handler); };
}

// 지금 입력창에 붙어 있는 태그. 뷰어가 이걸 보고 3D에서 해당 부품을 강조하고 이름표를 띄운다.
let tagged: PartTag[] = [];
const taggedListeners = new Set<() => void>();

export function setTaggedParts(tags: PartTag[]) {
  tagged = tags;
  taggedListeners.forEach((l) => l());
}

export function useTaggedParts() {
  return useSyncExternalStore((l) => {
    taggedListeners.add(l);
    return () => { taggedListeners.delete(l); };
  }, () => tagged);
}
