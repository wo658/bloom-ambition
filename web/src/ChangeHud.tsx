// 수정안 검토 막대(Before | After · 다시 보기 · 취소 · 적용)와, 수정안이 떠 있는 동안 설명 카드·타임라인·상단 배지가 그리는 모습.
// 계약은 compare.ts. 막대는 뷰어의 2D 오버레이로 놓이고, 나머지는 App이 원래 카드·타임라인을 감싸 두면 비교 중에만 바꿔 그린다.
// 글자 차이는 지워지는 글자에 빨간 줄이 그어진 뒤 접히고, 새 글자가 초록으로 타이핑된다(한국어). 다른 언어는 번역문끼리 겹쳐 바꾼다.
// 타임라인은 합쳐지는 칸이 하나로 모이고 뒤 번호가 굴러 바뀐다. 연출은 gsap이라 개발 중 __gsap.globalTimeline.timeScale로 늦춰 볼 수 있다.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import gsap from "gsap";
import { decideProposal, setCompare, updateCompare, useCompare, type CompareState, type DiffEntry, type Proposal, type TextSeg } from "./compare";
import { t, useT } from "./lang";
import type { Scene } from "./types";
import "./changeHud.css";

const PLAY_DELAY = 0.5; // 3D가 Before 모습을 잠깐 보여 주는 동안 글자도 기다렸다가 바뀐다
const APPLIED_MS = 1300; // [적용] 뒤 "적용됨"을 보여 두는 시간
const EXIT_MS = 260;

type TextEntry = Extract<DiffEntry, { type: "text" }>;
type Step = Scene["steps"][number];

// ---------- 글자 차이 ----------

// sceneDiff가 글자 조각을 주지 않았을 때 쓰는 낱말 차이. 숫자·괄호를 따로 떼어 "4개" → "2개"에서 숫자만 바뀌게 한다.
function wordDiff(a: string, b: string): TextSeg[] {
  const tok = (s: string) => s.match(/\s+|\d+|[^\s\d()（）,.·]+|[^\s]/g) ?? [];
  const x = tok(a), y = tok(b);
  const lcs = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--)
    for (let j = y.length - 1; j >= 0; j--)
      lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: TextSeg[] = [];
  const push = (kind: TextSeg["kind"], text: string) => {
    const last = out[out.length - 1];
    if (last?.kind === kind) last.text += text; else out.push({ kind, text });
  };
  let i = 0, j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) { push("same", x[i]); i++; j++; }
    else if (j < y.length && (i >= x.length || lcs[i][j + 1] >= lcs[i + 1][j])) push("ins", y[j++]);
    else push("del", x[i++]);
  }
  // 바뀐 곳 사이의 빈칸까지 바뀐 덩어리로 묶고, 덩어리마다 지울 글자 → 새 글자 순으로 모아 한 번에 지우고 한 번에 쓴다.
  const merged: TextSeg[] = [];
  for (let k = 0; k < out.length;) {
    if (out[k].kind === "same") { merged.push(out[k++]); continue; }
    let del = "", ins = "";
    while (k < out.length && (out[k].kind !== "same" || (/^\s+$/.test(out[k].text) && out[k + 1] && out[k + 1].kind !== "same"))) {
      const sg = out[k++];
      if (sg.kind !== "ins") del += sg.text;
      if (sg.kind !== "del") ins += sg.text;
    }
    if (del) merged.push({ kind: "del", text: del });
    if (ins) merged.push({ kind: "ins", text: ins });
  }
  return merged;
}

// gsap 시계로 0→1 진행값들을 돌려 React 상태로 내린다. key가 바뀌면 처음부터 다시 돈다.
function usePlayback<T extends Record<string, number>>(build: (tl: gsap.core.Timeline, v: T) => void, start: T, done: T, play: boolean, key: unknown) {
  const [v, setV] = useState<T>(play ? start : done);
  useLayoutEffect(() => {
    if (!play) { setV(done); return; }
    const state = { ...start };
    setV({ ...state });
    const tl = gsap.timeline({ onUpdate: () => setV({ ...state }) });
    build(tl, state);
    return () => { tl.kill(); };
  }, [play, key]); // eslint-disable-line react-hooks/exhaustive-deps
  return v;
}

// 설명·주의 한 칸. mode before는 지워질 글자를 옅게 표시하고, after는 재생 때 차이를 움직여 보여 준다.
function DiffText({ before, after, segs, mode, playKey, ko }: {
  before: string; after: string; segs: TextSeg[] | null; mode: CompareState["mode"]; playKey: number; ko: boolean;
}) {
  const changed = before !== after;
  const insLen = segs?.reduce((n, s) => n + (s.kind === "ins" ? s.text.length : 0), 0) ?? 0;
  const play = mode === "after" && changed;
  const p = usePlayback((tl, v) => {
    if (!ko) { tl.to(v, { fade: 1, duration: 0.6, ease: "power1.inOut" }, PLAY_DELAY); return; }
    tl.to(v, { strike: 1, duration: 0.45, ease: "power2.out" }, PLAY_DELAY)
      .to(v, { erase: 1, duration: 0.45, ease: "power1.in" }, ">0.35")
      .to(v, { type: 1, duration: Math.min(1.6, 0.25 + insLen * 0.045), ease: "none" }, ">0.05")
      .to(v, { glow: 1, duration: 0.01 });
  }, { strike: 0, erase: 0, type: 0, fade: 0, glow: 0 }, { strike: 1, erase: 1, type: 1, fade: 1, glow: 1 }, play, playKey);

  if (!changed) return <>{t(after)}</>;
  if (!ko) {
    // 번역문은 낱말이 맞지 않아 옛 문장과 새 문장을 겹쳐 바꾼다.
    if (mode === "before") return <span className="dt-pre">{t(before)}</span>;
    return (
      <span className="dt-fade">
        <span style={{ opacity: 1 - p.fade }} aria-hidden>{t(before)}</span>
        <span style={{ opacity: p.fade }} className={p.fade >= 1 ? "dt-fresh" : ""}>{t(after)}</span>
      </span>
    );
  }
  const list = segs?.length ? segs : wordDiff(before, after);
  if (mode === "before") {
    return <>{list.map((s, i) => s.kind === "ins" ? null
      : <span key={i} className={s.kind === "del" ? "dt-pre-del" : undefined}>{s.text}</span>)}</>;
  }
  const typing = p.type > 0 && p.type < 1;
  return (
    <>
      {list.map((s, i) => {
        if (s.kind === "same") return <span key={i}>{s.text}</span>;
        if (s.kind === "del") {
          // 빨간 줄이 그어진 뒤 끝에서부터 지워진다(여러 곳이 함께).
          const keep = Math.ceil(s.text.length * (1 - p.erase));
          if (!keep) return null;
          return <span key={i} className="dt-del" style={{ ["--strike" as string]: p.strike }}>{s.text.slice(0, keep)}</span>;
        }
        const shown = Math.floor(s.text.length * p.type);
        if (!shown && !typing) return null;
        return (
          <span key={i} className={`dt-ins ${p.glow ? "done" : ""}`}>
            {s.text.slice(0, shown)}{typing && <i className="dt-caret" />}
          </span>
        );
      })}
    </>
  );
}

// ---------- 단계 번호 대응 ----------

// 타임라인 칸 하나. b/a: before·after 단계 번호(없으면 그쪽에 없는 칸).
type Item = { key: string; b: number | null; a: number | null; kind: "keep" | "into" | "absorbed" | "removed" | "added"; from?: number[] };

// before 단계들을 after 번호에 맞춘다. 합쳐진 칸·빠진 칸·생긴 칸을 표시하고, 개수가 맞지 않으면 null(움직임 없이 그린다).
function timelineItems(p: Proposal): Item[] | null {
  const merges = p.diff.entries.filter((e): e is Extract<DiffEntry, { type: "steps_merged" }> => e.type === "steps_merged");
  const removed = new Set(p.diff.entries.flatMap((e) => (e.type === "step_removed" ? [e.step] : [])));
  const added = new Set(p.diff.entries.flatMap((e) => (e.type === "step_added" ? [e.step] : [])));
  const head = new Map<number, number[]>(); // 합쳐진 무리의 첫 칸 → 무리
  const absorbed = new Map<number, number>(); // 흡수된 칸 → 무리의 첫 칸
  for (const m of merges) {
    const from = [...m.from].sort((x, y) => x - y);
    head.set(from[0], from);
    from.slice(1).forEach((n) => absorbed.set(n, from[0]));
  }
  const survivors = p.before.steps.map((s) => s.number).filter((n) => !absorbed.has(n) && !removed.has(n));
  const kept = p.after.steps.map((s) => s.number).filter((n) => !added.has(n));
  if (survivors.length !== kept.length) return null;
  const map = new Map(survivors.map((n, i) => [n, kept[i]]));
  const items: Item[] = p.before.steps.map((s) => {
    const n = s.number;
    if (absorbed.has(n)) return { key: `b${n}`, b: n, a: map.get(absorbed.get(n)!) ?? null, kind: "absorbed" };
    if (removed.has(n)) return { key: `b${n}`, b: n, a: null, kind: "removed" };
    return { key: `b${n}`, b: n, a: map.get(n) ?? null, kind: head.has(n) ? "into" : "keep", from: head.get(n) };
  });
  for (const x of [...added].sort((u, v) => u - v)) {
    const at = items.findIndex((it) => it.kind !== "absorbed" && it.kind !== "removed" && it.a !== null && it.a > x);
    items.splice(at < 0 ? items.length : at, 0, { key: `a${x}`, b: null, a: x, kind: "added" });
  }
  return items;
}

// 카드에 보여 줄 단계: sceneDiff가 고른 단계(없으면 글자가 바뀐 단계·합쳐진 단계). before 번호는 타임라인 대응으로 찾는다.
function focusSteps(p: Proposal, items: Item[] | null) {
  const texts = p.diff.entries.filter((e): e is TextEntry => e.type === "text");
  const merged = p.diff.entries.find((e) => e.type === "steps_merged");
  const a = p.diff.focusStep ?? texts.find((e) => e.step.after != null)?.step.after
    ?? (merged?.type === "steps_merged" ? merged.into : undefined) ?? p.after.steps[0]?.number ?? 1;
  const it = items?.find((x) => x.a === a && (x.kind === "keep" || x.kind === "into"));
  const b = it?.b ?? texts.find((e) => e.step.after === a)?.step.before ?? a;
  const pick = (field: TextEntry["field"]) =>
    texts.find((e) => e.field === field && e.step.after === a) ?? texts.find((e) => e.field === field && e.step.after == null && e.step.before === b);
  return {
    a, b, from: it?.from,
    afterStep: p.after.steps.find((s) => s.number === a) as Step | undefined,
    beforeStep: p.before.steps.find((s) => s.number === b) as Step | undefined,
    caption: pick("caption_ko"), warning: pick("warning_ko"),
  };
}

// ---------- 설명 카드 ----------

// 비교 중이면 설명 카드가 수정안의 단계 설명을 보여 주고, 아니면 App의 원래 카드(children)를 그대로 둔다.
export function CompareCard({ children }: { children: ReactNode }) {
  const cmp = useCompare();
  const { lang } = useT();
  const items = useMemo(() => (cmp ? timelineItems(cmp.proposal) : null), [cmp?.proposal]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!cmp) return <>{children}</>;
  const { mode, playKey, proposal } = cmp;
  const f = focusSteps(proposal, items);
  const shown = (mode === "after" ? f.afterStep : f.beforeStep) ?? f.afterStep ?? f.beforeStep;
  const text = (field: TextEntry["field"], entry?: TextEntry) => {
    const before = entry?.before ?? f.beforeStep?.[field] ?? f.afterStep?.[field] ?? "";
    const after = entry?.after ?? f.afterStep?.[field] ?? before;
    return { before, after, segs: entry?.segs ?? null };
  };
  const cap = text("caption_ko", f.caption);
  const warn = text("warning_ko", f.warning);
  const ko = lang === "ko";
  const merge = mode === "after" && f.from && f.from.length > 1 ? f.from.join("+") : null;
  return (
    <section className={`overlay card instruction cmp-card ${mode}`} key={`cmp-${proposal.id}`}>
      <div className="step-badge cmp-badge">
        <span key={`${mode}-${shown?.number}`} className="cmp-num">{shown?.number ?? "–"}</span>
        {merge && <small key={`m-${playKey}`} className="cmp-merge">{merge}</small>}
      </div>
      <div className="body">
        <span className={`cmp-chip ${mode}`}>{t(mode === "after" ? "수정 후" : "수정 전")}</span>
        <p className="text">
          <DiffText {...cap} mode={mode} playKey={playKey} ko={ko} />
        </p>
        {(warn.before || warn.after) && (
          <p className={`warn ${!warn.after ? "gone" : ""} ${!warn.before ? "new" : ""}`}>
            ⚠ <DiffText {...warn} mode={mode} playKey={playKey} ko={ko} />
          </p>
        )}
      </div>
    </section>
  );
}

// ---------- 타임라인 ----------

// 비교 중이면 수정안의 단계 칸을 그린다. after 재생 때 합쳐지는 칸이 하나로 모이고, 뒤 번호가 굴러 바뀐다.
export function CompareTimeline({ children }: { children: ReactNode }) {
  const cmp = useCompare();
  const items = useMemo(() => (cmp ? timelineItems(cmp.proposal) : null), [cmp?.proposal]); // eslint-disable-line react-hooks/exhaustive-deps
  const moves = !!items?.some((it) => it.kind !== "keep" || it.a !== it.b);
  const play = !!cmp && cmp.mode === "after" && moves;
  const p = usePlayback((tl, v) => {
    tl.to(v, { slide: 1, duration: 0.7, ease: "power3.inOut" }, PLAY_DELAY + 0.2)
      .to(v, { roll: 1, duration: 0.5, ease: "back.out(1.6)" }, "-=0.25");
  }, { slide: 0, roll: 0 }, { slide: 1, roll: 1 }, play, `${cmp?.playKey}-${cmp?.proposal.id}`);
  if (!cmp) return <>{children}</>;
  const { proposal, mode } = cmp;
  const f = focusSteps(proposal, items);
  const slide = mode === "after" ? p.slide : 0;
  const roll = mode === "after" ? p.roll : 0;
  const caption = (scene: Scene, n: number | null) => scene.steps.find((s) => s.number === n)?.caption_ko ?? "";
  const prep = <button className="seg prep done" tabIndex={-1}><span>✓</span></button>;

  // 대응을 못 찾으면 고른 쪽 scene의 칸을 움직임 없이 그린다.
  if (!items) {
    const scene = mode === "after" ? proposal.after : proposal.before;
    const on = mode === "after" ? f.a : f.b;
    return (
      <div className="timeline cmp">
        {prep}
        {scene.steps.map((s) => (
          <button key={s.number} tabIndex={-1} title={`${s.number}. ${t(s.caption_ko)}`} className={`seg ${s.number === on ? "on" : ""}`}>
            <span>{s.number}</span>
          </button>
        ))}
      </div>
    );
  }
  return (
    <div className={`timeline cmp ${mode}`}>
      {prep}
      {items.map((it) => {
        // 다 접힌 칸은 빼서 틈이 남지 않게 한다.
        if ((it.kind === "absorbed" || it.kind === "removed") && slide >= 1) return null;
        const gone = it.kind === "absorbed" || it.kind === "removed";
        const grow = gone ? 1 - slide : it.kind === "added" ? slide : 1;
        const on = mode === "after" ? it.a === f.a && !gone : it.b === f.b;
        const rolls = it.b !== null && it.a !== null && it.a !== it.b && !gone;
        const n = mode === "after" ? it.a : it.b;
        const merging = it.kind === "into" || it.kind === "absorbed";
        return (
          <button key={it.key} tabIndex={-1}
            title={`${n ?? it.b}. ${t(caption(mode === "after" && n !== null ? proposal.after : proposal.before, n ?? it.b))}`}
            className={`seg ${on ? "on" : ""} ${merging ? "merging" : ""} ${it.kind}`}
            style={{
              flexGrow: grow,
              // 접히는 칸은 옆 칸과의 틈(4px)까지 먹어 들어가 두 칸이 맞붙는다.
              marginLeft: gone ? -4 * slide : it.kind === "added" ? -4 * (1 - slide) : 0,
              paddingInline: gone ? 6 * (1 - slide) : it.kind === "added" ? 6 * slide : undefined,
              opacity: gone ? Math.min(1, (1 - slide) * 2) : it.kind === "added" ? Math.min(1, slide * 2) : 1,
            }}>
            {rolls ? (
              <span className="roll">
                <span style={{ transform: `translateY(${-roll * 100}%)` }}>{it.b}</span>
                <span style={{ transform: `translateY(${(1 - roll) * 100}%)` }}>{it.a}</span>
              </span>
            ) : <span>{gone ? it.b : (n ?? it.b)}</span>}
            {it.kind === "into" && it.from && (
              <small className="seg-tag" style={{ opacity: mode === "after" ? slide : 0, transform: `translate(-50%, ${(1 - slide) * 6}px)` }}>
                {it.from.join("+")}
              </small>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ---------- 상단 배지 ----------

export function CompareBadge() {
  const cmp = useCompare();
  if (!cmp || cmp.proposal.status !== "pending") return null;
  return <span className="cmp-top-badge"><i />{t("수정안 미리보기")}</span>;
}

// ---------- 검토 막대 ----------

type Bar = { proposal: Proposal; mode: CompareState["mode"]; phase: "open" | "applied" | "out" };

export default function ChangeHud() {
  const cmp = useCompare();
  useT();
  const [bar, setBar] = useState<Bar | null>(null);
  const applying = useRef<string | null>(null); // [적용]을 누른 수정안 id
  const dismissed = useRef<string | null>(null); // "적용됨"을 보여 주고 닫은 수정안(비교가 그대로 열려 있어도 다시 띄우지 않는다)

  // 비교 상태를 막대 상태로 옮긴다. 비교가 닫히면 적용 중이었으면 "적용됨"을 잠깐 보여 주고, 아니면 바로 물러난다.
  useEffect(() => {
    if (!cmp) {
      dismissed.current = null;
      setBar((b) => (!b || b.phase === "out" ? b : { ...b, phase: applying.current === b.proposal.id || b.phase === "applied" ? "applied" : "out" }));
      return;
    }
    if (dismissed.current === cmp.proposal.id) return;
    // [적용]을 누른 뒤 채팅 쪽이 비교를 바로 닫지 않고 상태만 바꿔도 "적용됨"을 이어서 보여 준다.
    setBar({ proposal: cmp.proposal, mode: cmp.mode, phase: applying.current === cmp.proposal.id ? "applied" : "open" });
  }, [cmp]);

  useEffect(() => {
    if (bar?.phase === "applied") {
      const id = setTimeout(() => {
        dismissed.current = bar.proposal.id;
        applying.current = null;
        setBar((b) => (b ? { ...b, phase: "out" } : b));
      }, APPLIED_MS);
      return () => clearTimeout(id);
    }
    if (bar?.phase === "out") {
      const id = setTimeout(() => setBar(null), EXIT_MS);
      return () => clearTimeout(id);
    }
  }, [bar?.phase, bar?.proposal.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const pending = bar?.phase === "open" && bar.proposal.status === "pending";
  const setMode = (mode: CompareState["mode"]) => {
    const c = cmp;
    if (!c) return;
    // After로 넘어갈 때마다 변하는 과정을 처음부터 다시 재생한다.
    if (mode === "after") updateCompare({ mode, playKey: c.playKey + 1 });
    else if (c.mode !== mode) updateCompare({ mode });
  };
  const replay = () => cmp && updateCompare({ mode: "after", playKey: cmp.playKey + 1 });
  const decide = (d: "apply" | "reject") => {
    if (!bar || !pending) return;
    if (d === "apply") { applying.current = bar.proposal.id; setBar({ ...bar, phase: "applied" }); }
    decideProposal(bar.proposal.id, d);
  };

  // B/A 전환, Enter 적용, Esc 취소. 뷰어의 ←→·Space와 겹치지 않고, 입력창에 쓰는 중이면 건드리지 않는다.
  // 캡처 단계에서 먼저 받아 처리한 키는 App의 키 처리(Esc로 서랍 닫기 등)로 넘기지 않는다.
  useEffect(() => {
    if (!bar || bar.phase !== "open") return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
      if (el?.closest?.("input, textarea, select, [contenteditable=''], [contenteditable='true']")) return;
      const k = e.key.toLowerCase();
      let done = true;
      if (k === "b") setMode("before");
      else if (k === "a") setMode("after");
      else if (k === "enter" && pending) decide("apply");
      else if (k === "escape") { if (pending) decide("reject"); else setCompare(null); }
      else done = false;
      if (done) { e.preventDefault(); e.stopPropagation(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  if (!bar) return null;
  const status = bar.proposal.status;
  return (
    <div className={`overlay change-hud ${bar.phase}`} role="toolbar" aria-label={t("수정안")}>
      <div className="hud-main" aria-hidden={bar.phase === "applied"}>
        <div className="hud-title">
          <span className="hud-kicker"><i />{t("수정안")}</span>
          <span className="hud-summary" title={t(bar.proposal.summary)}>{t(bar.proposal.summary)}</span>
        </div>
        <div className={`hud-seg ${bar.mode}`} role="radiogroup">
          <span className="hud-thumb" />
          <button role="radio" aria-checked={bar.mode === "before"} title={t("수정 전 (B)")} onClick={() => setMode("before")}>Before</button>
          <button role="radio" aria-checked={bar.mode === "after"} title={t("수정 후 (A)")} onClick={() => setMode("after")}>After</button>
        </div>
        <button className="hud-btn ghost" title={t("변하는 과정을 다시 보기")} onClick={replay}>{t("↻ 다시 보기")}</button>
        <span className="hud-div" />
        {status === "pending" ? (
          <>
            <button className="hud-btn" title={t("취소 (Esc)")} onClick={() => decide("reject")}>{t("취소")}</button>
            <button className="hud-btn primary" title={t("적용 (Enter)")} onClick={() => decide("apply")}>
              {t("적용")}<kbd>↵</kbd>
            </button>
          </>
        ) : (
          <>
            <span className="hud-state">{t(status === "applied" ? "적용됨" : status === "undone" ? "되돌림" : "취소됨")}</span>
            <button className="hud-btn ghost icon-x" title={t("닫기")} aria-label={t("닫기")} onClick={() => setCompare(null)}>✕</button>
          </>
        )}
      </div>
      <div className="hud-applied" aria-live="polite">
        {bar.phase === "applied" && <><span className="hud-check">✓</span>{t("적용됨")}</>}
      </div>
    </div>
  );
}
