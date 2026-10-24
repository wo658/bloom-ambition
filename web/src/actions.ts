// 채팅의 "액션": 작업자가 도면을 직접 고치거나 보는 정해진 작업들. 채팅에는 값이 미리 정해진 예시 문장(PRESETS)으로 보이고 누르면 바로 실행된다.
// 정해진 대로 바로 바꿀 수 있는 것(local)은 브라우저에서 바꾸고, 맞닿는 판·철물 배치처럼 따라 바뀌어야 할 게 많은 것(ai)은
// 정확한 지시문(actionInstruction)을 붙여 AI에게 patch_scene으로 맡긴다. 부품 조립 모션(motion)은 도면을 바꾸지 않고 뷰어에서 틀기만 한다.
// 예시 문장은 실제 채팅처럼 "@나무못(2단계 1번)" 부품 태그를 담는다(actionTags). 누르면 말풍선에 같은 칩이 보이고 서버가 그 부품 context를 덧붙인다.
// 서버(api/chat.ts)도 이 파일을 쓰므로 브라우저 전용 모듈(bridge·lang)은 가져오지 않는다.
import type { Panel, Scene, Step } from "./types";
// Vercel Function은 ESM으로 따로 컴파일되므로 상대 경로에 .js를 붙인다(api/chat.ts와 같다).
import { partTag, smallTag, type PartTag } from "./partTags.js";

export type ActionId = "part_motion" | "explode_view" | "panel_thickness" | "panel_move" | "hardware_qty" | "merge_steps" | "add_warning" | "simplify_caption";

// 메시지 metadata.action에 실려 서버로 간다.
export interface ActionMeta { id: ActionId; label: string; params: Record<string, unknown> }

// 부품 조립 모션 대상(bridge.ts의 MotionTarget과 같은 모양. 서버도 쓰는 파일이라 여기서 따로 적는다).
export type MotionTarget = { kind: "panel" | "hardware"; id: string; instance?: string };

// 예시 문장에 들어가는 태그. parts는 보통 부품 태그(PartTag), product는 가구 전체를 가리키는 태그(늘 "ALL" → "@ALL")다.
// 둘 다 사용자 메시지 metadata(parts·product)로 실려 말풍선에서 칩으로 보이고, 서버가 context를 덧붙인다.
export interface ActionTags { parts: PartTag[]; product?: string }

// 실행 종류: local(브라우저가 바로 고침), motion(부품 조립 모션), explode(분해도), ai(지시문을 붙여 AI에게).
export type ActionRun = { meta: ActionMeta; text: string; tags: ActionTags } & (
  | { kind: "local"; next: Scene; summary: string }
  | { kind: "motion"; target: MotionTarget; part: string; hammer: boolean }
  | { kind: "explode" }
  | { kind: "ai" });

// 화면 문구를 바꿔 줄 함수(lang.ts의 t). 없으면 한국어 그대로 {변수}만 채운다.
export type Tr = (ko: string, vars?: Record<string, string | number>) => string;
const fill: Tr = (ko, vars) => Object.entries(vars ?? {}).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), ko);

export const ACTIONS: { id: ActionId; label: string }[] = [
  { id: "part_motion", label: "조립 모션 보기" },
  { id: "explode_view", label: "분해도 보기" },
  { id: "panel_thickness", label: "판 두께 바꾸기" },
  { id: "panel_move", label: "판 옮기기" },
  { id: "hardware_qty", label: "철물 개수 바꾸기" },
  { id: "merge_steps", label: "다음 단계와 합치기" },
  { id: "add_warning", label: "주의 문구 넣기" },
  { id: "simplify_caption", label: "설명 쉽게 고치기" },
];
export const actionLabel = (id: ActionId) => ACTIONS.find((a) => a.id === id)?.label ?? id;
const preset = (id: ActionId, params: Record<string, unknown>): ActionMeta => ({ id, label: actionLabel(id), params });

// 채팅에 늘 보이는 대표 예시. 모두 도면을 바꾸는 작업이라 누르면 바로 수정안(Before/After)이 뜬다. 문장은 지금 scene으로 만들고(actionText),
// 수정 뒤 더는 맞지 않으면(invalidParams) 흐리게 둔다(까닭은 툴팁). 조립 모션·분해도는 자유 대화의 AI 도구로만 남겨 둔다.
export const PRESETS: ActionMeta[] = [
  preset("hardware_qty", { step: 6, part_id: "101339", qty: 4 }),
  preset("panel_thickness", { panel: "outer_top", thickness: 2.5 }),
  preset("merge_steps", { step: 4 }),
  preset("panel_move", { panel: "shelf_left", axis: 1, delta: 5 }),
];

// 버튼 옆 작은 꼬리표: 바로 바뀌는지, AI가 고치는지, 모션(조립 모션·분해도)인지.
export const actionKind = (meta: ActionMeta): "local" | "ai" | "motion" =>
  meta.id === "part_motion" || meta.id === "explode_view" ? "motion"
    : meta.id === "merge_steps" || (meta.id === "add_warning" && String(meta.params.text ?? "").trim()) ? "local" : "ai";

// "벽용 나사 (미포함, …)" → "벽용 나사"
export const bareName = (name: string) => name.replace(/\s*\([^)]*\)\s*$/, "");
const round = (n: number) => Math.round(n * 100) / 100;

// 목적격 조사: 마지막 글자가 한글이면 받침에 따라 을/를을 붙인다. 번역돼 한글이 아니면 그대로 둔다.
export function withObj(word: string): string {
  const c = word.charCodeAt(word.length - 1);
  if (!(c >= 0xac00 && c <= 0xd7a3)) return word;
  return word + ((c - 0xac00) % 28 ? "을" : "를");
}

const TOOL_MODELS = new Set(["hex_key", "hammer", "screwdriver", "pencil", "wall_mark", "spirit_level"]);
// 공구(망치·렌치 등)가 아닌 철물인지. 부품 목록의 kind를 먼저 보고, 없으면 모양 사양으로 판단한다.
export function isHardware(scene: Scene, partId: string): boolean {
  const entry = scene.parts?.find((p) => p.id === partId);
  if (entry) return entry.kind !== "tool" && entry.kind !== "panel";
  const model = scene.hardware?.[partId]?.model;
  return !!model && !TOOL_MODELS.has(model);
}

export const stepIndex = (scene: Scene, n: unknown) => scene.steps.findIndex((s) => s.number === Number(n));
const stepAt = (scene: Scene, n: unknown): Step | undefined => scene.steps[stepIndex(scene, n)];

// 판 두께 = 세 치수 중 가장 얇은 것. axis는 그 축(0=x, 1=y, 2=z).
export function panelThickness(p: Panel) {
  const axis = p.size.indexOf(Math.min(...p.size));
  return { axis, value: round(p.size[axis]) };
}

// 모션 대상과 그 부품이 처음 들어가는 단계·이름. 없으면 null.
function motionInfo(scene: Scene, p: Record<string, unknown>): { target: MotionTarget; step: Step; name: string; hammer: boolean } | null {
  const id = String(p.id ?? "");
  const instance = p.instance ? String(p.instance) : undefined;
  if (p.kind === "panel") {
    const panel = scene.panels.find((x) => x.id === id);
    const step = scene.steps.find((s) => s.adds.includes(id));
    return panel && step ? { target: { kind: "panel", id }, step, name: bareName(panel.name_ko), hammer: false } : null;
  }
  const step = instance
    ? scene.steps.find((s) => s.small.some((x) => x.id === instance && x.part_id === id))
    : scene.steps.find((s) => s.uses.some((u) => u.part_id === id) || s.small.some((x) => x.part_id === id));
  if (!step) return null;
  const name = scene.parts?.find((x) => x.id === id)?.name_ko ?? scene.steps.flatMap((s) => s.uses).find((u) => u.part_id === id)?.name_ko ?? id;
  // 나무못처럼 망치로 박는 철물은 "박는", 나머지는 "조립하는".
  const hammer = scene.hardware?.[id]?.model === "dowel" || scene.parts?.find((x) => x.id === id)?.kind === "dowel";
  return { target: { kind: "hardware", id, ...(instance ? { instance } : {}) }, step, name: bareName(name), hammer };
}

// 값이 실행할 수 있는지. 안 되면 까닭(한국어).
export function invalidParams(scene: Scene, meta: ActionMeta): string | null {
  const p = meta.params;
  switch (meta.id) {
    case "part_motion": return motionInfo(scene, p) ? null : "그 부품이 들어가는 단계가 없어요.";
    case "explode_view": return scene.panels.length > 1 ? null : "펼칠 판이 없어요.";
    case "panel_thickness": {
      const panel = scene.panels.find((x) => x.id === p.panel);
      const v = Number(p.thickness);
      if (!panel) return "그 판이 없어요.";
      if (!(v > 0 && v <= 20)) return "두께는 0보다 크고 20cm 이하로 넣으세요.";
      return v === panelThickness(panel).value ? "이미 그 두께예요." : null;
    }
    case "panel_move": {
      const plan = movePlan(scene, meta);
      if (!plan) return "그 판이 없어요.";
      if (!(Math.abs(plan.delta) > 0 && Math.abs(plan.delta) <= 50)) return "옮길 거리는 0보다 크고 50cm 이하로 넣으세요.";
      return plan.hits.length ? "옮기면 다른 판과 겹쳐요." : null;
    }
    case "hardware_qty": {
      const step = stepAt(scene, p.step);
      const use = step?.uses.find((u) => u.part_id === p.part_id);
      const v = Number(p.qty);
      if (!use) return "그 단계에 그 철물이 없어요.";
      if (!(Number.isInteger(v) && v >= 1 && v <= 99)) return "개수는 1~99 사이 정수로 넣으세요.";
      return v === use.qty ? "이미 그 개수예요." : null;
    }
    case "merge_steps": {
      const i = stepIndex(scene, p.step);
      // 합친 단계를 또 누르면 엉뚱한 뒤 단계까지 붙으니 막는다(되돌리기 ↶로 풀린다).
      if ((scene.steps[i] as MergedStep | undefined)?.merged_from) return "이미 합쳤어요.";
      return i >= 0 && i < scene.steps.length - 1 ? null : "합칠 다음 단계가 없어요.";
    }
    default: return stepAt(scene, p.step) ? null : "그 단계가 없어요.";
  }
}

// 합쳐서 만든 단계에는 원래 단계 번호를 남긴다(다시 합치기를 막고, AI도 scene에서 알 수 있다).
type MergedStep = Step & { merged_from?: number[] };

// 앞 단계 문장 중 다음 단계를 미리 알리기만 하는 줄("오른쪽 선반이 끼워질 자리예요.").
// 합치면 바로 뒤 문장이 그 동작이라 겹치므로 뺀다.
const FORESHADOW = /(자리|곳)(예요|이에요)\.?$|끼워져요\.?$/;

// N단계와 N+1단계를 한 단계로 합친다. 뒤 단계들 번호는 하나씩 당기고, 설명·주의 문구의 "M단계" 언급도 새 번호로 고친다.
export function mergeSteps(scene: Scene, n: number): { next: Scene; summary: string } {
  const i = stepIndex(scene, n);
  if (i < 0 || i >= scene.steps.length - 1) throw new Error(`${n}단계는 합칠 다음 단계가 없어요.`);
  const next = structuredClone(scene);
  const [a, b] = next.steps.slice(i, i + 2) as MergedStep[];
  const lines = (s: string | null) => (s ?? "").split("\n").map((x) => x.trim()).filter(Boolean);
  const joinLines = (xs: string[]) => [...new Set(xs)].join("\n");
  const aLines = b.adds.length || b.reseat?.length ? lines(a.caption_ko).filter((x) => !FORESHADOW.test(x)) : lines(a.caption_ko);
  const uses: Step["uses"] = [];
  for (const u of [...a.uses, ...b.uses]) {
    const same = uses.find((x) => x.part_id === u.part_id);
    if (!same) uses.push({ ...u });
    // 철물은 더하고, 망치 같은 공구는 하나면 된다.
    else same.qty = isHardware(scene, u.part_id) ? same.qty + u.qty : Math.max(same.qty, u.qty);
  }
  const small = [...a.small, ...b.small].filter((x, k, all) => all.findIndex((y) => y.id === x.id) === k);
  const reseat = [...new Set([...(a.reseat ?? []), ...(b.reseat ?? [])])];
  const merged: MergedStep = {
    ...b,
    number: a.number,
    page: Math.min(a.page, b.page),
    caption_ko: joinLines([...aLines, ...lines(b.caption_ko)]),
    warning_ko: joinLines([...lines(a.warning_ko), ...lines(b.warning_ko)]) || null,
    confidence: Math.min(a.confidence, b.confidence),
    adds: [...new Set([...a.adds, ...b.adds])],
    uses,
    small,
    pose: b.pose,
    wall: b.wall,
    merged_from: [...(a.merged_from ?? [a.number]), ...(b.merged_from ?? [b.number])],
  };
  if (reseat.length || a.reseat || b.reseat) merged.reseat = reseat;
  const offset = b.unit_offset ?? a.unit_offset;
  if (offset) merged.unit_offset = offset; else delete merged.unit_offset;
  next.steps.splice(i, 2, merged);
  for (let k = i + 1; k < next.steps.length; k++) next.steps[k].number = next.steps[k - 1].number + 1;
  // 옛 번호 → 새 번호. 합친 두 단계는 앞 번호, 그 뒤는 하나씩 당겨진 번호.
  const renumber = new Map(scene.steps.map((s, k) => [s.number, next.steps[k <= i ? k : k - 1].number]));
  // "7단계: 5단계와 같은 동작이에요" 같은 언급이 옛 번호를 가리키지 않게 한다.
  const fix = (text: string) => text.replace(/(\d+)(\s*)단계/g, (all, m: string, sp: string) => renumber.has(Number(m)) ? `${renumber.get(Number(m))}${sp}단계` : all);
  for (const s of next.steps) {
    s.caption_ko = fix(s.caption_ko);
    if (s.warning_ko) s.warning_ko = fix(s.warning_ko);
  }
  return { next, summary: `${a.number}단계와 ${b.number}단계를 합쳤어요 · 이제 ${next.steps.length}단계예요` };
}

// 주의 문구를 넣는다. 이미 있으면 새 줄로 덧붙인다.
export function addWarning(scene: Scene, n: number, text: string): { next: Scene; summary: string } {
  const i = stepIndex(scene, n);
  if (i < 0) throw new Error(`${n}단계가 없어요.`);
  const next = structuredClone(scene);
  const s = next.steps[i];
  s.warning_ko = s.warning_ko ? `${s.warning_ko}\n${text.trim()}` : text.trim();
  return { next, summary: `${s.number}단계에 주의 문구를 넣었어요.` };
}

// 가구 전체를 가리키는 태그 이름. 언어와 제품에 상관없이 늘 "@ALL"이고, 사용자가 입력창에 직접 써도 같은 태그로 읽는다.
export const ALL_TAG = "ALL";

// 가구 전체 태그(@ALL)에 붙일 AI context: 전체 크기와 판 목록. 서버(withPartContext)가 지금 scene으로 만든다.
export function productContext(scene: Scene, label: string): string {
  return [
    `@${label}`,
    `- 가구 전체(${scene.product}) 하나를 통째로 가리킨다. 전체 크기 ${scene.size.join("×")}cm(가로×높이×깊이), 모두 ${scene.steps.length}단계`,
    `- 판재 ${scene.panels.length}개: ${scene.panels.map((x) => `${x.name_ko}(${x.id}, ${x.size.map(round).join("×")}cm)`).join(", ")}`,
  ].join("\n");
}

// 태그 이름을 화면 언어로. "나무못(2단계 1번)"은 이름과 "(2단계 1번)"을 따로 옮긴다(한국어면 그대로다).
function trTag(tag: PartTag, tr: Tr): PartTag {
  const m = /^(.+)\((\d+)단계 (\d+)번\)$/.exec(tag.label);
  return { ...tag, label: m ? tr(m[1]) + tr("({n}단계 {k}번)", { n: m[2], k: m[3] }) : tr(tag.label) };
}

// 예시 문장에 들어갈 태그. 화면에서 그 부품을 눌렀을 때와 같은 태그(partTag·smallTag)를 지금 scene으로 만든다.
export function actionTags(scene: Scene, meta: ActionMeta, tr: Tr = fill): ActionTags {
  const p = meta.params;
  const one = (tag: PartTag | null): ActionTags => ({ parts: tag ? [trTag(tag, tr)] : [] });
  switch (meta.id) {
    case "part_motion": return one(p.instance ? smallTag(scene, String(p.instance)) : partTag(scene, String(p.id ?? "")));
    case "explode_view": return { parts: [], product: ALL_TAG };
    case "panel_thickness":
    case "panel_move": return one(partTag(scene, String(p.panel ?? "")));
    case "hardware_qty": return one(partTag(scene, String(p.part_id ?? "")));
    // 합칠 뒤 단계에 새로 붙는 판(예: 5단계의 오른쪽 짧은 선반). 없으면 태그 없이 쓴다.
    case "merge_steps": {
      const id = stepAt(scene, Number(p.step) + 1)?.adds[0];
      return one(id ? partTag(scene, id) : null);
    }
    default: return { parts: [] };
  }
}

// 사용자 말풍선(과 예시 버튼)에 보일 문장. 지금 scene으로 만든다. 태그는 actionTags와 같은 "@이름"으로 넣는다.
export function actionText(scene: Scene, meta: ActionMeta, tr: Tr = fill, tags = actionTags(scene, meta, tr)): string {
  const p = meta.params;
  const at = (k = 0) => (tags.parts[k] ? `@${tags.parts[k].label}` : "");
  switch (meta.id) {
    case "part_motion": {
      const m = motionInfo(scene, p);
      if (!m) return tr("{name} 조립하는 모습 보여 줘", { name: at() || String(p.id) });
      // 철물 하나(instance)면 태그 이름에 단계가 들어 있다("@나무못(2단계 1번)").
      if (p.instance) return m.hammer ? tr("{tag} 박는 모습 보여 줘", { tag: at() }) : tr("{tag} 조립하는 모습 보여 줘", { tag: at() });
      return m.hammer
        ? tr("{n}단계 {name} 박는 모습 보여 줘", { n: m.step.number, name: at() })
        : tr("{n}단계 {name} 조립하는 모습 보여 줘", { n: m.step.number, name: at() });
    }
    case "explode_view": return tr("{tag} 분해도로 펼쳐 보여 줘", { tag: `@${ALL_TAG}` });
    case "panel_thickness": {
      const panel = scene.panels.find((x) => x.id === p.panel);
      return tr("{name} 두께를 {v}cm로 바꿔 줘", { name: at() || tr(bareName(panel?.name_ko ?? String(p.panel))), v: Number(p.thickness) });
    }
    case "panel_move": {
      const panel = scene.panels.find((x) => x.id === p.panel);
      // 조사는 이름 쪽에 붙인다("@왼쪽 짧은 선반을"). 번역된 이름이면 붙지 않는다.
      const name = withObj(at() || tr(bareName(panel?.name_ko ?? String(p.panel))));
      const d = Number(p.delta), vars = { name, v: round(Math.abs(d)) };
      const axis = Number(p.axis ?? 1);
      if (axis === 1) return d > 0 ? tr("{name} {v}cm 위로 올려 줘", vars) : tr("{name} {v}cm 아래로 내려 줘", vars);
      if (axis === 0) return d > 0 ? tr("{name} {v}cm 오른쪽으로 옮겨 줘", vars) : tr("{name} {v}cm 왼쪽으로 옮겨 줘", vars);
      return d > 0 ? tr("{name} {v}cm 앞으로 옮겨 줘", vars) : tr("{name} {v}cm 뒤로 옮겨 줘", vars);
    }
    case "hardware_qty": {
      const use = stepAt(scene, p.step)?.uses.find((u) => u.part_id === p.part_id);
      const to = Number(p.qty);
      // 조사는 이름 쪽에 붙여(번역되면 붙지 않는다) 문장 틀은 언어마다 깔끔하게 둔다.
      const name = at() || tr(bareName(use?.name_ko ?? scene.parts?.find((x) => x.id === p.part_id)?.name_ko ?? String(p.part_id)));
      const vars = { n: Number(p.step), name, from: use?.qty ?? 0, to };
      // 수정 뒤 그 단계에 그 철물이 없어졌거나 이미 그 개수면(버튼은 흐리게 보인다) 지금 개수 없이 쓴다.
      if (!use || use.qty === to) return tr("{n}단계 {name} {to}개로 바꿔 줘", vars);
      return to > use.qty
        ? tr("{n}단계 {name} {from}개를 {to}개로 늘려 줘", vars)
        : tr("{n}단계 {name} {from}개를 {to}개로 줄여 줘", vars);
    }
    case "merge_steps": {
      const vars = { n: Number(p.step), m: Number(p.step) + 1, tag: at() };
      return vars.tag ? tr("{tag} 끼우는 {m}단계를 {n}단계에 합쳐 줘", vars) : tr("{n}단계와 {m}단계를 한 단계로 합쳐 줘", vars);
    }
    case "add_warning": return String(p.text ?? "").trim()
      ? tr("{n}단계에 주의 문구를 넣어 줘: {text}", { n: Number(p.step), text: String(p.text).trim() })
      : tr("{n}단계에 알맞은 주의 문구를 넣어 줘", { n: Number(p.step) });
    case "simplify_caption": return tr("{n}단계 설명을 쉽게 고쳐 줘", { n: Number(p.step) });
  }
}

// 실행: 정해진 대로 바꿀 수 있으면 local(다음 scene), 모션이면 motion(뷰어 대상), 아니면 ai(말풍선 문장). 값이 틀리면 예외.
export function runAction(scene: Scene, meta: ActionMeta, tr: Tr = fill): ActionRun {
  const bad = invalidParams(scene, meta);
  if (bad) throw new Error(bad);
  const tags = actionTags(scene, meta, tr);
  const base = { meta, tags, text: actionText(scene, meta, tr, tags) };
  const n = Number(meta.params.step);
  if (meta.id === "part_motion") {
    const m = motionInfo(scene, meta.params)!;
    return { ...base, kind: "motion", target: m.target, part: tr(m.name), hammer: m.hammer };
  }
  if (meta.id === "explode_view") return { ...base, kind: "explode" };
  if (meta.id === "merge_steps") {
    const { next } = mergeSteps(scene, n);
    return { ...base, kind: "local", next, summary: tr("{n}단계와 {m}단계를 한 단계로 합치기 · 총 {total}단계가 돼요", { n, m: n + 1, total: next.steps.length }) };
  }
  const warning = String(meta.params.text ?? "").trim();
  if (meta.id === "add_warning" && warning) {
    const { next } = addWarning(scene, n, warning);
    return { ...base, kind: "local", next, summary: tr("{n}단계에 주의 문구 넣기", { n }) };
  }
  return { ...base, kind: "ai" };
}

const AXES = ["x(가로)", "y(높이)", "z(깊이)"];
const box = (p: Panel) => p.size.map((s, k) => [p.pos[k] - s / 2, p.pos[k] + s / 2]);

// 판 두께 바꾸기 계획: 바꿀 JSON Patch를 미리 다 계산한다(서버 지시문이 모델에 그대로 넘긴다).
// 두께 축에서 다른 판과 면으로 맞닿는 쪽(예: 윗판의 아랫면 = 옆판·칸막이 끝)은 그대로 두고 반대쪽 바깥 면만 옮긴다.
// 양쪽 다 닿거나 둘 다 안 닿으면 가운데를 둔다. 바깥 면이 가구 끝이면 가구 전체 크기(/size)도,
// 그 면에 박히는 철물(steps[].small[].at)도 새 면으로 옮긴다. 다른 판·단계 설명은 건드리지 않는다.
export type ThicknessPlan = {
  axis: number; from: number; to: number; keep: "lo" | "hi" | "center";
  extent: [number, number] | null; moved: number; movedNames: string[];
  ops: { op: "replace"; path: string; value: unknown }[];
};
export function thicknessPlan(scene: Scene, meta: ActionMeta): ThicknessPlan | null {
  const i = scene.panels.findIndex((x) => x.id === meta.params.panel);
  const panel = scene.panels[i];
  if (!panel) return null;
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  const TOL = 0.05;
  const { axis, value: from } = panelThickness(panel);
  const to = Number(meta.params.thickness);
  const [lo, hi] = box(panel)[axis];
  const others = [0, 1, 2].filter((k) => k !== axis);
  const me = box(panel);
  // 두께 축 면(lo/hi)에 다른 판이 면으로(나머지 두 축에서 넓이가 겹치게) 닿는지.
  const touches = (face: number, side: 0 | 1) => scene.panels.some((o) => {
    if (o === panel) return false;
    const b = box(o);
    return Math.abs(b[axis][side] - face) < TOL && others.every((k) => Math.min(b[k][1], me[k][1]) - Math.max(b[k][0], me[k][0]) > TOL);
  });
  const atLo = touches(lo, 1), atHi = touches(hi, 0);
  const keep = atLo && !atHi ? "lo" : atHi && !atLo ? "hi" : "center";
  const nLo = r3(keep === "lo" ? lo : keep === "hi" ? hi - to : panel.pos[axis] - to / 2);
  const nHi = r3(nLo + to);
  const pos = panel.pos.map((v, k) => (k === axis ? r3((nLo + nHi) / 2) : v));
  const size = panel.size.map((v, k) => (k === axis ? to : v));
  const ops: ThicknessPlan["ops"] = [
    { op: "replace", path: `/panels/${i}/size`, value: size },
    { op: "replace", path: `/panels/${i}/pos`, value: pos },
  ];
  // 가구 전체 크기: 판들이 차지하는 범위가 바뀌면 그만큼.
  const span = (ps: Panel[]) => {
    const bs = ps.map((q) => box(q)[axis]);
    return r3(Math.max(...bs.map((b) => b[1])) - Math.min(...bs.map((b) => b[0])));
  };
  const before = span(scene.panels);
  const after = span(scene.panels.map((q) => (q === panel ? { ...q, pos: pos as Panel["pos"], size: size as Panel["size"] } : q)));
  let extent: ThicknessPlan["extent"] = null;
  if (after !== before && Math.abs(scene.size[axis] - before) < TOL) {
    extent = [r3(scene.size[axis]), after];
    ops.push({ op: "replace", path: "/size", value: scene.size.map((v, k) => (k === axis ? after : v)) });
  }
  // 옮긴 면 위의 철물(판 넓이 안에 있고 at이 옛 면에 놓인 것)을 새 면으로.
  const movedIds = new Set<string>(), names = new Set<string>();
  scene.steps.forEach((s, si) => s.small.forEach((x, k) => {
    if (!others.every((ax) => x.at[ax] >= me[ax][0] - TOL && x.at[ax] <= me[ax][1] + TOL)) return;
    const face = Math.abs(x.at[axis] - lo) < TOL ? nLo : Math.abs(x.at[axis] - hi) < TOL ? nHi : null;
    if (face == null || Math.abs(face - x.at[axis]) < 1e-6) return;
    movedIds.add(x.id);
    names.add(bareName(scene.parts?.find((q) => q.id === x.part_id)?.name_ko ?? s.uses.find((u) => u.part_id === x.part_id)?.name_ko ?? x.part_id));
    ops.push({ op: "replace", path: `/steps/${si}/small/${k}/at`, value: x.at.map((v, ax) => (ax === axis ? face : v)) });
  }));
  return { axis, from, to, keep, extent, moved: movedIds.size, movedNames: [...names], ops };
}

// 판 옮기기 계획: 판 하나를 한 축으로 delta만큼 옮기는 JSON Patch를 미리 다 계산한다(thicknessPlan과 같은 방식).
// 그 판에 박혀 함께 따라가야 하는 철물(steps[].small[])도 같이 옮긴다: 판의 어느 면 위에 놓이고(그 면 넓이 안) 그 면에 수직으로 박히는 것.
// 예: 왼쪽 짧은 선반을 올리면 선반 끝과 왼쪽 옆판 사이 나무못 2개도 같은 높이로 올라간다. 다른 판(맞은편 칸막이의 나무못 등)과 설명 글은 그대로.
// hits는 옮긴 뒤 넓이가 겹치는 판 이름(있으면 실행하지 않는다).
export type MovePlan = {
  axis: number; delta: number; from: number; to: number;
  moved: number; movedNames: string[]; hits: string[];
  ops: { op: "replace"; path: string; value: unknown }[];
};
export function movePlan(scene: Scene, meta: ActionMeta): MovePlan | null {
  const i = scene.panels.findIndex((x) => x.id === meta.params.panel);
  const panel = scene.panels[i];
  if (!panel) return null;
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  const TOL = 0.05;
  const axis = [0, 1, 2].includes(Number(meta.params.axis)) ? Number(meta.params.axis) : 1;
  const delta = Number(meta.params.delta) || 0;
  const pos = panel.pos.map((v, k) => (k === axis ? r3(v + delta) : v)) as Panel["pos"];
  const ops: MovePlan["ops"] = [{ op: "replace", path: `/panels/${i}/pos`, value: pos }];
  const me = box(panel);
  const movedIds = new Set<string>(), names = new Set<string>();
  scene.steps.forEach((s, si) => s.small.forEach((x, k) => {
    // 박히는 방향 축(a)의 면(lo/hi) 위에 있고, 나머지 두 축은 판 넓이 안.
    const a = x.axis.findIndex((v) => v !== 0);
    if (a < 0 || x.axis.filter((v) => v !== 0).length !== 1) return;
    const onFace = me[a].some((f) => Math.abs(x.at[a] - f) < TOL);
    const inside = [0, 1, 2].every((b) => b === a || (x.at[b] >= me[b][0] - TOL && x.at[b] <= me[b][1] + TOL));
    if (!onFace || !inside) return;
    movedIds.add(x.id);
    names.add(bareName(scene.parts?.find((q) => q.id === x.part_id)?.name_ko ?? s.uses.find((u) => u.part_id === x.part_id)?.name_ko ?? x.part_id));
    ops.push({ op: "replace", path: `/steps/${si}/small/${k}/at`, value: x.at.map((v, b) => (b === axis ? r3(v + delta) : v)) });
  }));
  const moved = box({ ...panel, pos });
  const hits = scene.panels.filter((o) => o !== panel && box(o).every(([lo, hi], b) => Math.min(hi, moved[b][1]) - Math.max(lo, moved[b][0]) > TOL)).map((o) => o.name_ko);
  return { axis, delta, from: r3(panel.pos[axis]), to: pos[axis], moved: movedIds.size, movedNames: [...names], hits, ops };
}

// 모델에게 줄 정확한 지시문(서버가 사용자 메시지 끝에 [액션 지시]로 붙인다). 항상 지금 scene으로 만든다.
export function actionInstruction(scene: Scene, meta: ActionMeta): string {
  const p = meta.params;
  const si = stepIndex(scene, p.step);
  const step = scene.steps[si];
  switch (meta.id) {
    case "part_motion":
      return `부품 조립 모션: 브라우저가 이미 뷰어에서 ${String(p.id)}${p.instance ? `(${String(p.instance)})` : ""} 조립 모션을 틀었다. 도면은 바꾸지 않는다.`;
    case "explode_view":
      return `분해도: 브라우저가 이미 뷰어에서 가구 전체를 판마다 펼쳤다가 다시 조립하는 분해도를 틀었다. 도면은 바꾸지 않는다.`;
    case "panel_thickness": {
      const i = scene.panels.findIndex((x) => x.id === p.panel);
      const panel = scene.panels[i];
      if (!panel) return `판 두께 바꾸기: scene에 없는 판(${String(p.panel)})이다. 바꾸지 말고 그렇다고 알려라.`;
      // 수정안은 사용자가 [적용]을 눌러야 scene에 들어간다. 그 뒤 대화에서 지시문이 지금 scene으로 다시 만들어지면 이미 그 두께이니 다시 보내지 않게 한다.
      if (panelThickness(panel).value === Number(p.thickness))
        return `판 두께 바꾸기: ${panel.name_ko}는 이미 ${Number(p.thickness)}cm다(사용자가 수정안을 적용해 scene에 반영됨). patch_scene을 다시 보내지 않는다.`;
      // 바꿀 값은 브라우저와 같은 계산(thicknessPlan)으로 미리 다 구해 준다. 모델은 그대로 보내기만 하면 되니 빠르고 늘 같다.
      const plan = thicknessPlan(scene, meta)!;
      const FACES = [["왼쪽 면", "오른쪽 면"], ["아랫면", "윗면"], ["뒷면", "앞면"]];
      const kept = plan.keep === "center" ? "가운데" : FACES[plan.axis][plan.keep === "lo" ? 0 : 1];
      return [
        `판 두께 바꾸기: ${panel.name_ko}(id=${panel.id})의 두께를 ${plan.from}cm에서 ${plan.to}cm로 바꾼다. 아래 계산이 이미 끝났다.`,
        `- 두께 축 ${AXES[plan.axis]}. 다른 판과 맞닿는 ${kept}은 그대로 두고 반대쪽 면만 옮겨 맞닿는 판과 틈·겹침이 없다. 다른 판은 그대로다.`,
        plan.extent ? `- 그래서 가구 전체 ${AXES[plan.axis]} 크기가 ${plan.extent[0]}cm에서 ${plan.extent[1]}cm로 바뀐다.` : "",
        plan.moved ? `- 이 판 바깥 면에 박히는 철물 ${plan.moved}개(${plan.movedNames.join(", ")})도 새 면으로 옮긴다. 단계 설명 글은 고치지 않는다.` : "",
        `- patch_scene의 ops는 아래 JSON 배열을 한 글자도 바꾸지 말고 그대로 보낸다. summary는 한 줄로 쓴다.`,
        JSON.stringify(plan.ops),
        `- 수정안을 보낸 뒤 답은 한두 줄: 두께 ${plan.from}→${plan.to}cm${plan.extent ? `, 전체 ${["가로", "높이", "깊이"][plan.axis]} ${plan.extent[0]}→${plan.extent[1]}cm` : ""}, 함께 옮기는 철물 수, 맞닿는 판과 틈 없이 맞춘다는 것. 아직 적용된 게 아니니 "바꿨어요"가 아니라 "바뀌어요"로 쓴다.`,
      ].filter(Boolean).join("\n");
    }
    case "panel_move": {
      const plan = movePlan(scene, meta);
      if (!plan) return `판 옮기기: scene에 없는 판(${String(p.panel)})이다. 바꾸지 말고 그렇다고 알려라.`;
      const i = scene.panels.findIndex((x) => x.id === p.panel);
      const panel = scene.panels[i];
      if (plan.hits.length) return `판 옮기기: ${panel.name_ko}(id=${panel.id})를 ${AXES[plan.axis]} 방향으로 ${plan.delta}cm 옮기면 다른 판(${plan.hits.join(", ")})과 겹친다. 바꾸지 말고 그렇다고 알려라.`;
      const DIRS = [["왼쪽", "오른쪽"], ["아래", "위"], ["뒤", "앞"]];
      const dir = DIRS[plan.axis][plan.delta > 0 ? 1 : 0];
      return [
        `판 옮기기: 대상은 ${panel.name_ko}(id=${panel.id}, /panels/${i}). ${dir}로 ${Math.abs(plan.delta)}cm 옮긴다(${AXES[plan.axis]} ${plan.from} → ${plan.to}). 아래 계산이 이미 끝났다.`,
        `- 크기는 그대로, pos만 바뀐다. 옮긴 뒤 다른 판과 겹치지 않는다(확인함). 다른 판은 그대로다.`,
        plan.moved ? `- 이 판 끝에 박혀 판을 잡는 철물 ${plan.moved}개(${plan.movedNames.join(", ")})도 같은 거리만큼 옮겨 판과 같은 높이에 둔다. 맞은편 판에만 박히는 철물은 그대로다.` : "",
        `- 단계 설명 글(caption_ko·warning_ko)과 개수는 바뀌지 않는다.`,
        `- patch_scene의 ops는 아래 JSON 배열을 한 글자도 바꾸지 말고 그대로 보낸다. summary는 한 줄로 쓴다.`,
        JSON.stringify(plan.ops),
        `- 수정안을 보낸 뒤 답은 한두 줄: ${dir}로 ${Math.abs(plan.delta)}cm(중심 ${plan.from}→${plan.to}cm), 함께 옮기는 철물 수. 아직 적용된 게 아니니 "옮겼어요"가 아니라 "옮겨져요"로 쓴다.`,
      ].filter(Boolean).join("\n");
    }
    case "hardware_qty": {
      if (!step) return `철물 개수 바꾸기: ${String(p.step)}단계가 없다. 바꾸지 말고 그렇다고 알려라.`;
      const ui = step.uses.findIndex((u) => u.part_id === p.part_id);
      const use = step.uses[ui];
      if (!use) return `철물 개수 바꾸기: ${step.number}단계에 ${String(p.part_id)} 철물이 없다. 바꾸지 말고 그렇다고 알려라.`;
      const smalls = step.small.flatMap((x, k) => x.part_id === use.part_id ? [`  - /steps/${si}/small/${k}: id=${x.id}, at=[${x.at.join(", ")}], axis=[${x.axis.join(", ")}]`] : []);
      const pi = scene.parts?.findIndex((x) => x.id === use.part_id) ?? -1;
      const total = scene.steps.reduce((n, s) => n + (s.uses.find((u) => u.part_id === use.part_id)?.qty ?? 0), 0);
      const v = Number(p.qty);
      const newTotal = total - use.qty + v;
      // 박히는 자리별로 묶는다: 박히는 방향(axis)과 그 축의 좌표가 같으면 같은 판의 같은 면이다.
      type Mine = { x: Step["small"][number]; k: number };
      const mine: Mine[] = step.small.flatMap((x, k) => (x.part_id === use.part_id ? [{ x, k }] : []));
      const places = new Map<string, Mine[]>();
      for (const m of mine) {
        const ax = Math.max(0, m.x.axis.findIndex((a) => a !== 0));
        const key = `${m.x.axis.join(",")}@${m.x.at[ax]}`;
        places.set(key, [...(places.get(key) ?? []), m]);
      }
      // 그 자리에서 맞닿는 두 판: 박히는 방향 앞뒤로 조금 들어간 점을 품은 판(아직 안 붙은 판일 수도 있다).
      const host = (m: Mine, dir: 1 | -1) => {
        const q = m.x.at.map((c, a) => c + m.x.axis[a] * 0.5 * dir);
        return scene.panels.find((o) => box(o).every(([lo, hi], a) => q[a] >= lo - 0.01 && q[a] <= hi + 0.01));
      };
      // 앞(z>0)·뒤(z<0) 나눔. 깊이 방향으로 박히면 나누지 않는다.
      const split = (g: Mine[]) => {
        if (g[0].x.axis[2] !== 0) return "";
        const f = g.filter((m) => m.x.at[2] > 0).length, b = g.filter((m) => m.x.at[2] < 0).length;
        return f && b ? (f === b ? `앞뒤 ${f}개씩` : `앞 ${f}개, 뒤 ${b}개`) : "";
      };
      const place = (g: Mine[]) => {
        const [a, b] = [host(g[0], 1), host(g[0], -1)];
        const name = (o: Panel) => `${o.name_ko}(${o.id})`;
        return a && b ? `${name(a)}·${name(b)} 사이` : a || b ? `${name((a ?? b)!)} 면` : `at=[${g[0].x.at.join(", ")}] 자리`;
      };
      // 수정안이 적용된 뒤 대화에서는 지시도 바뀐 scene으로 다시 만들어지므로, 이미 그 개수면 다시 고치지 말고 알리기만 하게 한다.
      if (use.qty === v) {
        return [
          `철물 개수 바꾸기: ${step.number}단계 ${use.name_ko}는 이미 ${v}개다(네가 보낸 수정안을 사용자가 적용해 아래 scene에 반영됨. 계산된 지시대로 한 정상 결과다). 더 고칠 것은 없으니 patch_scene을 다시 부르지 않는다.`,
          `- 지금 자리별 개수:`,
          ...[...places.values()].map((g) => `  - ${place(g)}: ${g.length}개${split(g) ? `(${split(g)})` : ""}`),
          `- 답은 한 줄로, 어디에 몇 개씩 남았는지만 알린다(판 id·내부 번호는 쓰지 않는다).`,
        ].join("\n");
      }
      const head = [
        `철물 개수 바꾸기: ${step.number}단계(/steps/${si})의 ${use.name_ko}(part_id=${use.part_id}) 개수를 ${use.qty}개에서 ${v}개로 바꾼다.`,
        `- 이 단계의 해당 철물 배치 small[] 항목(지금 ${smalls.length}개):`,
        ...(smalls.length ? smalls : ["  - 없음"]),
      ];
      // 줄일 때는 지울 항목을 여기서 정해 준다: 가장 많이 박힌 자리부터, 그 자리 가운데에 가장 가까운 것을 뺀다.
      // 바깥쪽(앞뒤 끝)이 남아 판을 고르게 잡고, 판마다 최소 한 쌍은 남는다(예: 칸막이 끝 4개 → 앞뒤 1개씩).
      if (v < use.qty && mine.length === use.qty && pi >= 0 && scene.parts) {
        const drop = new Set<number>();
        for (let n = mine.length - v; n > 0; n--) {
          const left = [...places.values()].map((g) => g.filter((m) => !drop.has(m.k))).filter((g) => g.length);
          const g = left.reduce((a, b) => (b.length >= a.length ? b : a));
          const c = [0, 1, 2].map((a) => g.reduce((s, m) => s + m.x.at[a], 0) / g.length);
          const dist = (m: Mine) => Math.hypot(...m.x.at.map((t, a) => t - c[a]));
          drop.add(g.reduce((a, b) => (dist(b) < dist(a) ? b : a)).k);
        }
        const rows = [...places.values()].map((g) => {
          const kept = g.filter((m) => !drop.has(m.k));
          const sb = split(g), sa = kept.length ? split(kept) : "";
          return `  - ${place(g)}: ${g.length}개${sb ? `(${sb})` : ""} → ${kept.length}개${sa ? `(${sa})` : ""}`;
        });
        const ops = [
          ...[...drop].sort((a, b) => b - a).map((k) => ({ op: "remove", path: `/steps/${si}/small/${k}` })),
          { op: "replace", path: `/steps/${si}/uses/${ui}/qty`, value: v },
          { op: "replace", path: `/parts/${pi}/qty`, value: newTotal },
        ];
        return [
          ...head,
          `- 지울 항목과 개수는 이미 계산해 두었다. 아래 ops를 순서 그대로(뒤 번호부터 지운다) 넣는다:`,
          ...ops.map((o) => `  ${JSON.stringify(o)}`),
          `- 자리별 개수(바뀐 뒤):`,
          ...rows,
          `- 마지막 op로 /steps/${si}/caption_ko를 replace한다. 지금: ${JSON.stringify(step.caption_ko)}`,
          `  위 자리별 개수에 맞게 ${use.name_ko} 개수와 괄호 속 나눔(앞뒤 몇 개씩)만 고치고, 나머지 문장·줄바꿈은 그대로 둔다. 개수 합이 ${v}개가 되게 한다.`,
          step.warning_ko ? `- warning_ko(${JSON.stringify(step.warning_ko)})에 이 철물 개수가 나오면 같이 고친다.` : "",
          `- 부품 목록 합계는 ${total}개에서 ${newTotal}개가 된다. 다른 단계와 다른 필드는 건드리지 않는다.`,
          `- patch_scene의 summary는 "${step.number}단계 ${bareName(use.name_ko)} ${use.qty}개 → ${v}개" 꼴로 짧게 쓴다(화면 언어가 따로 있으면 그 언어로). 수정안을 보낸 뒤 답은 한 줄로: 어디에 몇 개씩 남게 되는지만(아직 적용 전이다).`,
        ].filter(Boolean).join("\n");
      }
      return [
        ...head,
        `- /steps/${si}/uses/${ui}/qty를 ${v}로 바꾼다.`,
        `- small[]의 해당 철물이 정확히 ${v}개가 되게 지우거나 더한다. 더할 때는 같은 판 면 위에 고르게(대칭으로) 배치하고 id는 기존 형식을 따라 겹치지 않게, 나머지 필드(model·dims·color·axis·tool 등)는 기존 항목을 따른다. 줄일 때는 남는 것들이 고르게 퍼지게 고른다. 여러 개를 remove할 때는 배열 번호가 당겨지므로 뒤 번호부터 지운다.`,
        `- caption_ko(지금: ${JSON.stringify(step.caption_ko)})와 warning_ko에 이 철물 개수가 나오면 새 개수에 맞게 고친다(여러 곳에 나뉘어 적힌 개수도 합이 맞게).`,
        pi >= 0 && scene.parts ? `- 부품 목록 /parts/${pi}/qty(지금 ${scene.parts[pi].qty}개, 모든 단계 합계 ${total}개)도 새 합계 ${newTotal}개에 맞춘다.` : "",
      ].filter(Boolean).join("\n");
    }
    case "merge_steps": {
      // 브라우저가 합치기 수정안을 띄우고, 사용자가 [적용]을 눌렀을 때만 scene이 바뀐다. 적용됐는지는 지금 scene(merged_from)으로 알린다.
      const n = Number(p.step);
      const done = (scene.steps[stepIndex(scene, n)] as MergedStep | undefined)?.merged_from;
      if (!done) return `단계 합치기: 브라우저가 원래 ${n}단계와 ${n + 1}단계를 합치는 수정안을 화면에 띄웠지만 지금 scene에는 적용되지 않았다(검토 중이거나 취소). patch_scene은 부르지 않고, 단계 번호는 지금 scene 그대로 읽는다.`;
      return [
        `단계 합치기: 사용자가 원래 ${n}단계와 ${n + 1}단계를 ${n}단계 하나로 합치는 수정안을 적용했다(그 단계의 merged_from에 원래 번호가 있다). patch_scene은 부르지 않는다.`,
        `- 그 뒤 단계 번호는 하나씩 당겨져 지금 모두 ${scene.steps.length}단계다(원래 ${n + 2}단계가 지금 ${n + 1}단계). 설명 속 "N단계" 언급도 새 번호로 고쳐져 있다.`,
        `- 이후 사용자가 말하는 단계 번호는 지금 scene의 번호로 읽는다.`,
      ].join("\n");
    }
    case "add_warning": {
      if (!step) return `주의 문구 넣기: ${String(p.step)}단계가 없다. 바꾸지 말고 그렇다고 알려라.`;
      const text = String(p.text ?? "").trim();
      return [
        `주의 문구 넣기: ${step.number}단계(/steps/${si})의 warning_ko에 ${text ? `다음 문구를 넣는다: ${JSON.stringify(text)}` : "이 단계 작업에 알맞은 주의 문구를 직접 써서 넣는다(다칠 위험·자주 하는 실수·부품 방향 등, 한두 문장, 문장마다 줄바꿈)"}.`,
        `- 이 단계 설명: ${JSON.stringify(step.caption_ko)}, 쓰는 부품: ${step.uses.map((u) => `${u.name_ko} ${u.qty}개`).join(", ") || "없음"}, 붙는 판: ${step.adds.join(", ") || "없음"}.`,
        step.warning_ko
          ? `- 이미 warning_ko가 있다(${JSON.stringify(step.warning_ko)}). 지우지 말고 새 줄로 덧붙여 /steps/${si}/warning_ko를 replace한다.`
          : `- 지금 warning_ko는 비어 있다. /steps/${si}/warning_ko를 replace한다.`,
      ].join("\n");
    }
    case "simplify_caption": {
      if (!step) return `설명 쉽게 고치기: ${String(p.step)}단계가 없다. 바꾸지 말고 그렇다고 알려라.`;
      return [
        `설명 쉽게 고치기: ${step.number}단계(/steps/${si}/caption_ko)의 설명을 처음 조립하는 사람도 바로 따라 할 수 있게 쉬운 말로 고쳐 쓴다.`,
        `- 지금 설명: ${JSON.stringify(step.caption_ko)}`,
        `- 부품 이름·개수·방향 같은 사실은 그대로 두고, 짧은 문장으로, 문장마다 줄바꿈한다. 어려운 말(체결·삽입 등)은 쉬운 말로 바꾼다.`,
      ].join("\n");
    }
  }
}
