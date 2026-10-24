// 두 scene의 차이를 사람이 읽을 줄(DiffEntry)로 만든다. 계약은 compare.ts.
// 브라우저 전용 모듈을 가져오지 않는다(서버·테스트에서도 쓴다).
// 순서: 1) before→after 단계 짝 맞추기(merged_from 먼저, 나머지는 내용 닮음으로 순서를 지키는 정렬)
//       2) 판·철물(형상) 3) 철물 개수 4) 단계 구조 5) 글자 6) 전체 크기. 같은 입력이면 늘 같은 순서로 나온다.
import type { Scene, Step, SmallPart, Vec3 } from "./types";
import type { DiffEntry, SceneDiff, StepRef, TextSeg } from "./compare";

type MStep = Step & { merged_from?: number[] };

const EPS_SIZE = 1e-3;
const EPS_AT = 0.01;
const differs = (a: Vec3, b: Vec3, eps: number) => a.some((v, k) => Math.abs(v - b[k]) > eps);
const changedAxes = (a: Vec3, b: Vec3, eps: number) => [0, 1, 2].filter((k) => Math.abs(a[k] - b[k]) > eps);

// ---------- 단계 짝 ----------

// 짝 하나: before 단계 여러 개(합치기면 2개 이상) → after 단계 하나. 한쪽이 비면 추가/삭제.
interface Group { b: number[]; a: number | null } // 둘 다 steps 배열의 index

// 단계 내용의 열쇠 묶음: 붙이는 판·철물 id·쓰는 부품. 설명 글은 따로 본다.
function stepKeys(s: Step): Set<string> {
  return new Set([...s.adds.map((x) => `a:${x}`), ...s.small.map((x) => `s:${x.id}`), ...s.uses.map((x) => `u:${x.part_id}`)]);
}
const jaccard = (x: Set<string>, y: Set<string>) => {
  if (!x.size && !y.size) return 1;
  let n = 0;
  for (const v of x) if (y.has(v)) n++;
  return n / (x.size + y.size - n);
};
const wordSet = (s: string | null) => new Set((s ?? "").split(/[\s.,()!?·]+/).filter(Boolean));

// 0~1. 구조(판·철물)가 같으면 높고, 구조가 비어 있는 단계(밀어 끼우기·완성)는 설명 글로 가른다.
function similarity(x: Step, y: Step): number {
  const kx = stepKeys(x), ky = stepKeys(y);
  const text = jaccard(wordSet(x.caption_ko), wordSet(y.caption_ko));
  const struct = kx.size || ky.size ? jaccard(kx, ky) : text;
  return 0.6 * struct + 0.4 * text + (x.number === y.number ? 0.02 : 0);
}
const MIN_SIM = 0.3;

// 단계가 가리키는 "처음 번호"들. 이미 합친 단계면 merged_from, 아니면 제 번호 하나.
const origin = (s: MStep) => s.merged_from ?? [s.number];
const sameList = (x: number[], y: number[]) => x.length === y.length && x.every((v, k) => v === y[k]);

function mapSteps(B: MStep[], A: MStep[]): Group[] {
  const bTo = new Array<number | null>(B.length).fill(null); // before index → after index
  const aUsed = new Array<boolean>(A.length).fill(false);

  // 1) 새로 합친 단계: after.merged_from 이 before 의 연속된 단계들(각자의 origin)을 이어 붙인 것과 같다.
  //    before 에도 같은 merged_from 이 있으면 새 합치기가 아니다(아래 정렬에 맡긴다).
  A.forEach((s, ai) => {
    const mf = s.merged_from;
    if (!mf?.length || B.some((b) => b.merged_from && sameList(b.merged_from, mf))) return;
    let best: [number, number] | null = null; // [시작, 끝(포함)]
    for (let i = 0; i < B.length; i++) {
      const acc: number[] = [];
      for (let j = i; j < B.length && acc.length < mf.length; j++) {
        acc.push(...origin(B[j]));
        if (j > i && sameList(acc, mf) && bTo.slice(i, j + 1).every((x) => x === null)) {
          // 여러 후보면 after 번호와 시작 번호가 가까운 쪽.
          if (!best || Math.abs(B[i].number - s.number) < Math.abs(B[best[0]].number - s.number)) best = [i, j];
        }
      }
    }
    if (!best) return;
    for (let k = best[0]; k <= best[1]; k++) bTo[k] = ai;
    aUsed[ai] = true;
  });

  // 2) 나머지: 고정된 짝 사이 구간마다 순서를 지키며 닮음 합이 가장 큰 정렬(가중 LCS).
  const anchors: [number, number][] = []; // [before index 끝, after index]
  B.forEach((_, bi) => { if (bTo[bi] !== null && (bi === B.length - 1 || bTo[bi + 1] !== bTo[bi])) anchors.push([bi, bTo[bi]!]); });
  anchors.sort((x, y) => x[1] - y[1]);
  let bStart = 0, aStart = 0;
  const segments: [number, number, number, number][] = [];
  for (const [bEnd, ai] of anchors) {
    let bFirst = bEnd;
    while (bFirst > 0 && bTo[bFirst - 1] === ai) bFirst--;
    segments.push([bStart, bFirst, aStart, ai]);
    bStart = bEnd + 1; aStart = ai + 1;
  }
  segments.push([bStart, B.length, aStart, A.length]);
  for (const [b0, b1, a0, a1] of segments) {
    const n = Math.max(0, b1 - b0), m = Math.max(0, a1 - a0);
    if (!n || !m) continue;
    const sim = (i: number, j: number) => similarity(B[b0 + i], A[a0 + j]);
    const dp = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
      const s = sim(i, j);
      dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1], s >= MIN_SIM ? s + dp[i + 1][j + 1] : -1);
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      const s = sim(i, j);
      if (s >= MIN_SIM && Math.abs(dp[i][j] - (s + dp[i + 1][j + 1])) < 1e-9) { bTo[b0 + i] = a0 + j; aUsed[a0 + j] = true; i++; j++; }
      else if (dp[i][j] === dp[i + 1][j]) i++;
      else j++;
    }
  }

  // 3) merged_from 없이 합쳐진 단계: 짝 없는 before 단계의 판·철물이 모두 옆 단계의 짝(after)에 들어가 있으면 합친 것으로 본다.
  B.forEach((s, bi) => {
    if (bTo[bi] !== null) return;
    const own = [...s.adds.map((x) => `a:${x}`), ...s.small.map((x) => `s:${x.id}`)];
    if (!own.length) return;
    for (const nb of [bi - 1, bi + 1]) {
      const ai = bTo[nb];
      if (ai === null || ai === undefined) continue;
      const keys = stepKeys(A[ai]);
      if (own.every((k) => keys.has(k))) { bTo[bi] = ai; return; }
    }
  });

  // 묶음으로: after 순서대로, 짝 없는 before 는 앞 단계 뒤에 끼운다.
  const groups: Group[] = [];
  const byA = new Map<number, number[]>();
  bTo.forEach((ai, bi) => { if (ai !== null) byA.set(ai, [...(byA.get(ai) ?? []), bi]); });
  let bi = 0;
  for (let ai = 0; ai < A.length; ai++) {
    const bs = byA.get(ai);
    const firstB = bs ? Math.min(...bs) : null;
    while (bi < B.length && bTo[bi] === null && (firstB === null || bi < firstB)) groups.push({ b: [bi++], a: null });
    if (bs) { groups.push({ b: bs, a: ai }); bi = Math.max(bi, Math.max(...bs) + 1); }
    else groups.push({ b: [], a: ai });
  }
  for (; bi < B.length; bi++) if (bTo[bi] === null) groups.push({ b: [bi], a: null });
  return groups;
}

// ---------- 글자 차이 ----------

// 낱말·공백·줄바꿈·문장부호를 각각 하나의 조각으로(붙여 쓰면 원문 그대로).
const tokenize = (s: string) => s.match(/\n|[^\S\n]+|[\p{L}\p{N}\p{M}]+|[^\s\p{L}\p{N}\p{M}]/gu) ?? [];

// 조각 배열 두 개의 LCS 차이(뒤에서부터 길이표 → 앞에서부터 따라가며). 너무 길면 통째로 지우고 넣는다.
function lcsSegs(x: string[], y: string[]): TextSeg[] {
  const n = x.length, m = y.length;
  if (n * m > 4_000_000) return [{ kind: "del", text: x.join("") }, { kind: "ins", text: y.join("") }];
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const raw: TextSeg[] = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) raw.push({ kind: "same", text: x[i++] }), j++;
    else if (j >= m || (i < n && L[i + 1][j] >= L[i][j + 1])) raw.push({ kind: "del", text: x[i++] });
    else raw.push({ kind: "ins", text: y[j++] });
  }
  return raw;
}

// 줄 단위로 먼저 맞추고(통째로 빠진 줄은 줄째 지운다), 바뀐 줄 덩어리 안에서만 낱말 단위로 다시 비교한다.
export function diffText(before: string, after: string): TextSeg[] {
  const lines = (s: string) => s.match(/[^\n]*\n|[^\n]+/g) ?? [];
  const raw: TextSeg[] = [];
  const byLine = lcsSegs(lines(before), lines(after));
  for (let k = 0; k < byLine.length;) {
    if (byLine[k].kind === "same") { raw.push(byLine[k++]); continue; }
    let del = "", ins = "";
    for (; k < byLine.length && byLine[k].kind !== "same"; k++) byLine[k].kind === "del" ? (del += byLine[k].text) : (ins += byLine[k].text);
    if (del && ins) raw.push(...lcsSegs(tokenize(del), tokenize(ins)));
    else raw.push({ kind: del ? "del" : "ins", text: del || ins });
  }
  // 바뀐 덩어리 사이에 낀 공백 하나(same)는 덩어리에 넣는다: "4개 → 2개 / 씩"처럼 잘게 끊기지 않게.
  for (let k = 1; k < raw.length - 1; k++) {
    const s = raw[k];
    if (s.kind === "same" && /^[^\S\n]+$/.test(s.text) && raw[k - 1].kind !== "same" && raw[k + 1].kind !== "same") {
      raw.splice(k, 1, { kind: "del", text: s.text }, { kind: "ins", text: s.text });
      k++;
    }
  }
  // 바뀐 덩어리 안에서는 지운 것 먼저, 넣은 것 뒤. 같은 종류는 이어 붙인다.
  const out: TextSeg[] = [];
  const push = (seg: TextSeg) => {
    const last = out[out.length - 1];
    if (last && last.kind === seg.kind) last.text += seg.text;
    else if (seg.text) out.push({ ...seg });
  };
  for (let k = 0; k < raw.length;) {
    if (raw[k].kind === "same") { push(raw[k++]); continue; }
    let del = "", ins = "";
    for (; k < raw.length && raw[k].kind !== "same"; k++) raw[k].kind === "del" ? (del += raw[k].text) : (ins += raw[k].text);
    push({ kind: "del", text: del });
    push({ kind: "ins", text: ins });
  }
  return out;
}

// ---------- 본체 ----------

export function diffScenes(before: Scene, after: Scene): SceneDiff {
  const B = before.steps as MStep[], A = after.steps as MStep[];
  const groups = mapSteps(B, A);
  const bToA = new Map<number, number>(); // before index → after index
  for (const g of groups) if (g.a !== null) for (const b of g.b) bToA.set(b, g.a);
  const aToB = new Map<number, number[]>();
  for (const g of groups) if (g.a !== null) aToB.set(g.a, g.b);

  // before 단계 / after 단계 index 로 StepRef 를 만든다(짝이 있으면 반대쪽 번호도 채운다).
  const refB = (bi: number): StepRef => { const ai = bToA.get(bi); return ai === undefined ? { before: B[bi].number } : { before: B[bi].number, after: A[ai].number }; };
  const refA = (ai: number): StepRef => { const bs = aToB.get(ai); return bs?.length ? { before: B[bs[0]].number, after: A[ai].number } : { after: A[ai].number }; };

  const partName = (id: string) =>
    after.parts?.find((p) => p.id === id)?.name_ko ?? before.parts?.find((p) => p.id === id)?.name_ko
    ?? [...A, ...B].flatMap((s) => s.uses).find((u) => u.part_id === id)?.name_ko ?? id;

  const geo: DiffEntry[] = [];
  const small: DiffEntry[] = [];

  // --- 판재 ---
  const addStep = (steps: Step[], id: string) => steps.findIndex((s) => s.adds.includes(id));
  const panelRef = (id: string): StepRef | undefined => {
    const bi = addStep(B, id), ai = addStep(A, id);
    if (bi < 0 && ai < 0) return undefined;
    const r: StepRef = {};
    if (bi >= 0) { r.before = B[bi].number; const m = bToA.get(bi); if (m !== undefined) r.after = A[m].number; }
    if (ai >= 0) { r.after = A[ai].number; if (r.before === undefined) { const bs = aToB.get(ai); if (bs?.length) r.before = B[bs[0]].number; } }
    return r;
  };
  const withStep = <T extends object>(e: T, step: StepRef | undefined) => (step ? { ...e, step } : e);
  const bPanels = new Map(before.panels.map((p) => [p.id, p]));
  const aPanels = new Map(after.panels.map((p) => [p.id, p]));
  for (const p of before.panels) if (!aPanels.has(p.id))
    geo.push(withStep({ type: "panel_removed" as const, id: p.id, name: p.name_ko, size: p.size, pos: p.pos }, panelRef(p.id)));
  for (const p of after.panels) {
    const o = bPanels.get(p.id);
    const step = panelRef(p.id);
    if (!o) geo.push(withStep({ type: "panel_added" as const, id: p.id, name: p.name_ko, size: p.size, pos: p.pos }, step));
    else if (differs(o.size, p.size, EPS_SIZE))
      geo.push(withStep({ type: "panel_resized" as const, id: p.id, name: p.name_ko, from: o.size, to: p.size, posFrom: o.pos, posTo: p.pos, axis: changedAxes(o.size, p.size, EPS_SIZE) }, step));
    else if (differs(o.pos, p.pos, EPS_AT))
      geo.push(withStep({ type: "panel_moved" as const, id: p.id, name: p.name_ko, from: o.pos, to: p.pos }, step));
  }

  // --- 철물 하나하나 ---
  // 같은 id가 여러 단계에 나올 수 있다(벽 나사: 13단계에 박고 14단계에 다시 보임). 단계 짝끼리 맞춘 뒤, id·종류마다 첫 줄만 남긴다.
  type Occ = { si: number; p: SmallPart };
  const occs = (steps: Step[]) => {
    const m = new Map<string, Occ[]>();
    steps.forEach((s, si) => s.small.forEach((p) => m.set(p.id, [...(m.get(p.id) ?? []), { si, p }])));
    return m;
  };
  const bOcc = occs(B), aOcc = occs(A);
  const ids = [...new Set([...bOcc.keys(), ...aOcc.keys()])];
  for (const id of ids) {
    const bs = [...(bOcc.get(id) ?? [])], as = [...(aOcc.get(id) ?? [])];
    const pairs: [Occ, Occ][] = [];
    // 대응 단계끼리 먼저, 남으면 단계가 달라도 id로(철물이 다른 단계로 옮겨 간 경우).
    for (const o of [...bs]) {
      const k = as.findIndex((x) => x.si === bToA.get(o.si));
      if (k >= 0) { pairs.push([o, as[k]]); as.splice(k, 1); bs.splice(bs.indexOf(o), 1); }
    }
    while (bs.length && as.length) pairs.push([bs.shift()!, as.shift()!]);
    const out: DiffEntry[] = [];
    for (const o of bs) out.push({ type: "small_removed", id, part_id: o.p.part_id, name: partName(o.p.part_id), at: o.p.at, step: refB(o.si) });
    for (const o of as) out.push({ type: "small_added", id, part_id: o.p.part_id, name: partName(o.p.part_id), at: o.p.at, step: refA(o.si) });
    for (const [x, y] of pairs) {
      const step: StepRef = { before: B[x.si].number, after: A[y.si].number };
      if (x.p.part_id !== y.p.part_id)
        out.push({ type: "small_swapped", id, fromPart: x.p.part_id, toPart: y.p.part_id, fromName: partName(x.p.part_id), toName: partName(y.p.part_id), at: y.p.at, step });
      if (differs(x.p.at, y.p.at, EPS_AT))
        out.push({ type: "small_moved", id, part_id: y.p.part_id, name: partName(y.p.part_id), from: x.p.at, to: y.p.at, step });
    }
    const seen = new Set<string>();
    out.sort((x, y) => stepNo(x) - stepNo(y));
    for (const e of out) if (!seen.has(e.type)) { seen.add(e.type); small.push(e); }
  }

  // --- 단계별 철물 개수 ---
  const isTool = (scene: Scene, id: string) => {
    const kind = scene.parts?.find((p) => p.id === id)?.kind;
    return kind ? kind === "tool" : false;
  };
  const counts: DiffEntry[] = [];
  for (const g of groups) {
    if (g.a === null || !g.b.length) continue; // 추가·삭제된 단계는 단계 구조 줄과 부품 목록 개수로 보인다
    const was = new Map<string, number>();
    for (const bi of g.b) for (const u of B[bi].uses)
      was.set(u.part_id, was.has(u.part_id) ? (isTool(before, u.part_id) ? Math.max(was.get(u.part_id)!, u.qty) : was.get(u.part_id)! + u.qty) : u.qty);
    const now = new Map<string, number>();
    for (const u of A[g.a].uses) now.set(u.part_id, (now.get(u.part_id) ?? 0) + u.qty);
    const step = refA(g.a);
    for (const id of [...new Set([...was.keys(), ...now.keys()])]) {
      const from = was.get(id) ?? 0, to = now.get(id) ?? 0;
      if (from !== to) counts.push({ type: "uses_qty", part_id: id, name: partName(id), from, to, step });
    }
  }
  const bParts = new Map((before.parts ?? []).map((p) => [p.id, p]));
  const aParts = new Map((after.parts ?? []).map((p) => [p.id, p]));
  for (const id of [...new Set([...bParts.keys(), ...aParts.keys()])]) {
    const from = bParts.get(id)?.qty ?? 0, to = aParts.get(id)?.qty ?? 0;
    if (from !== to) counts.push({ type: "parts_qty", part_id: id, name: (aParts.get(id) ?? bParts.get(id))!.name_ko, from, to });
  }

  // --- 단계 구조 ---
  const struct: DiffEntry[] = [];
  let renumbered = 0;
  for (const g of groups) {
    if (g.a === null) struct.push({ type: "step_removed", step: B[g.b[0]].number });
    else if (!g.b.length) struct.push({ type: "step_added", step: A[g.a].number });
    else if (g.b.length > 1) struct.push({ type: "steps_merged", from: g.b.map((bi) => B[bi].number), into: A[g.a].number });
    else if (B[g.b[0]].number !== A[g.a].number) renumbered++;
  }
  if (renumbered) struct.push({ type: "steps_renumbered", count: renumbered });

  // --- 글자 ---
  // 합친 단계는 before 설명들을 줄바꿈으로 이어 붙여 after 설명과 비교한다.
  const text: DiffEntry[] = [];
  for (const g of groups) {
    if (g.a === null || !g.b.length) continue;
    for (const field of ["caption_ko", "warning_ko"] as const) {
      const was = g.b.map((bi) => B[bi][field]).filter((x): x is string => !!x).join("\n");
      const now = A[g.a][field] ?? "";
      if (was !== now) text.push({ type: "text", field, step: refA(g.a), before: was, after: now, segs: diffText(was, now) });
    }
  }

  // --- 전체 크기 ---
  const size: DiffEntry[] = differs(before.size, after.size, EPS_SIZE) ? [{ type: "product_size", from: before.size, to: after.size }] : [];

  const byStep = (x: DiffEntry, y: DiffEntry) => stepNo(x) - stepNo(y);
  const PANEL_ORDER = ["panel_resized", "panel_moved", "panel_added", "panel_removed"];
  geo.sort((x, y) => byStep(x, y) || PANEL_ORDER.indexOf(x.type) - PANEL_ORDER.indexOf(y.type));
  small.sort((x, y) => byStep(x, y) || (x as { id: string }).id.localeCompare((y as { id: string }).id, "en"));
  counts.sort((x, y) => (x.type === y.type ? 0 : x.type === "uses_qty" ? -1 : 1) || byStep(x, y));
  const entries = [...geo, ...small, ...counts, ...struct, ...text, ...size];

  // --- 먼저 보여 줄 단계: 판 > 철물 > 단계 구조 > 글자·개수 ---
  const rank = (e: DiffEntry) => e.type.startsWith("panel_") ? 4 : e.type.startsWith("small_") ? 3 : e.type === "steps_merged" || e.type === "step_added" ? 2 : e.type === "text" || e.type === "uses_qty" ? 1 : 0;
  const afterNo = (e: DiffEntry): number | undefined =>
    e.type === "steps_merged" ? e.into : e.type === "step_added" ? e.step : "step" in e && typeof e.step === "object" ? e.step?.after : undefined;
  let focusStep: number | null = null, best = 0;
  for (const e of entries) {
    const n = afterNo(e), r = rank(e);
    if (n !== undefined && r > best) { best = r; focusStep = n; }
  }

  const changed = { added: new Set<string>(), removed: new Set<string>(), modified: new Set<string>() };
  for (const e of entries) {
    if (e.type === "panel_added" || e.type === "small_added") changed.added.add(e.id);
    else if (e.type === "panel_removed" || e.type === "small_removed") changed.removed.add(e.id);
    else if (e.type === "panel_resized" || e.type === "panel_moved" || e.type === "small_moved" || e.type === "small_swapped") changed.modified.add(e.id);
  }
  return {
    entries,
    focusStep,
    changed: { added: [...changed.added], removed: [...changed.removed], modified: [...changed.modified] },
  };
}

// 정렬용 단계 번호(after 우선, 없으면 before). 단계가 없는 줄은 맨 뒤.
function stepNo(e: DiffEntry): number {
  if (!("step" in e) || typeof e.step !== "object" || !e.step) return 1e9;
  return e.step.after ?? e.step.before ?? 1e9;
}
