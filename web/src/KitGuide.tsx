import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Box, KitGuideData, KitPartRef, KitStep } from "./kitTypes";
import "./kit.css";
import { onGoToStep, setCurrentStep } from "./bridge";
import DemoSwitcher from "./DemoSwitcher";

const ALL = "전체";
const PAD = 0.04;

function appliesTo(markings: string[] | null, marking: string) {
  return marking === ALL || !markings || markings.includes(marking);
}

function sprue(id: string) {
  return id.startsWith("PE") ? "PE 에칭" : `${id[0]} 틀`;
}

// 단계 영역이 화면 가운데 꽉 차도록 페이지 이미지를 확대·이동하는 값.
function useFit(region: Box, aspect: number, whole: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  useLayoutEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver(([entry]) =>
      setSize({ w: entry.contentRect.width, h: entry.contentRect.height }));
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  const [x0, y0, x1, y1] = whole ? [0, 0, 1, 1] : region;
  const rw = x1 - x0 + PAD * 2;
  const rh = (y1 - y0 + PAD * 2) * aspect;
  const pageW = Math.min(size.w / rw, size.h / rh);
  const pageH = pageW * aspect;
  const cx = ((x0 + x1) / 2) * pageW;
  const cy = ((y0 + y1) / 2) * pageH;
  return { ref, pageW, pageH, left: size.w / 2 - cx, top: size.h / 2 - cy };
}

export default function KitGuide({ demo, guide, pageUrl }: { demo: string; guide: KitGuideData; pageUrl: (page: number) => string }) {
  const [marking, setMarking] = useState(ALL);
  const [index, setIndex] = useState(0);
  const [whole, setWhole] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const [done, setDone] = useState<Record<string, boolean>>({});
  const [playKey, setPlayKey] = useState(0);
  const [inventory, setInventory] = useState<null | "used" | "left">(null);

  const steps = useMemo(() => guide.steps.filter((s) => appliesTo(s.markings, marking)), [guide, marking]);
  const step: KitStep = steps[Math.min(index, steps.length - 1)];
  const byId = useMemo(() => new Map(guide.steps.map((s) => [s.id, s])), [guide]);
  const fit = useFit(step.region, guide.page_aspect, whole);

  const go = useCallback((delta: number) => setIndex((i) => Math.min(steps.length - 1, Math.max(0, i + delta))), [steps]);
  const jump = (id: string) => {
    const i = steps.findIndex((s) => s.id === id);
    if (i >= 0) setIndex(i);
  };

  // 채팅 위젯이 지금 보는 단계를 알고, 답변 속 "N단계" 링크로 이동할 수 있게 한다.
  useEffect(() => {
    setCurrentStep({ index, number: step.number, page: step.page, title: step.title_ko });
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => onGoToStep((n) => {
    let i = steps.findIndex((s) => s.number === n);
    if (i < 0) {
      // 선택한 마킹에서 빠진 단계면 필터를 풀고 이동한다.
      const j = guide.steps.findIndex((s) => s.number === n);
      if (j < 0) return;
      setMarking(ALL);
      i = j;
    }
    setWhole(false);
    setIndex(i);
  }), [steps, guide]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") go(1);
      if (e.key === "ArrowLeft") go(-1);
      if (e.key === " ") { e.preventDefault(); setPlayKey((k) => k + 1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go]);

  const parts = step.parts.filter((p) => appliesTo(p.markings, marking));
  const groups = Object.entries(
    parts.reduce<Record<string, KitPartRef[]>>((acc, p) => ((acc[sprue(p.id)] ??= []).push(p), acc), {}),
  ).sort(([a], [b]) => a.localeCompare(b));
  const hitOrder = new Map(parts.map((p, i) => [p.id, i]));
  // 부품 번호별로 처음 쓰이는 단계. 선택한 마킹에 해당하는 단계·부품만 센다.
  const firstUse = useMemo(() => {
    const map = new Map<string, { part: KitPartRef; at: number; step: KitStep }>();
    steps.forEach((s, i) => s.parts.forEach((part) => {
      if (appliesTo(part.markings, marking) && !map.has(part.id)) map.set(part.id, { part, at: i, step: s });
    }));
    return map;
  }, [steps, marking]);
  const usedParts = [...firstUse.values()].filter((u) => u.at <= index);
  const leftParts = [...firstUse.values()].filter((u) => u.at > index);
  const bySprue = <T extends { part: KitPartRef }>(list: T[]) => Object.entries(
    list.reduce<Record<string, T[]>>((acc, u) => ((acc[sprue(u.part.id)] ??= []).push(u), acc), {}),
  ).sort(([a], [b]) => a.localeCompare(b));

  const stepDone = (s: KitStep) => s.parts.length > 0 && s.parts.every((p) => done[`${s.id}/${p.id}`]);

  return (
    <div className="kit">
      <header>
        <h1>{guide.product}</h1>
        <div className="markings">
          <span>마킹</span>
          {[ALL, ...guide.markings.map((m) => m.id)].map((id) => (
            <button key={id} className={marking === id ? "on" : ""} title={guide.markings.find((m) => m.id === id)?.title_ko}
              onClick={() => { setMarking(id); setIndex(0); }}>{id}</button>
          ))}
          {marking !== ALL && <em>{guide.markings.find((m) => m.id === marking)?.title_ko}</em>}
        </div>
      </header>

      <nav className="steps">
        <div className="steps-head">
          <DemoSwitcher current={demo} />
          <b>전체 단계 <small>{steps.length}</small></b>
        </div>
        {steps.map((s, i) => (
          <button key={s.id} className={s.id === step.id ? "on" : ""} onClick={() => setIndex(i)}>
            <span className="num">{s.number}</span>
            <span className="cap">{stepDone(s) ? "✓ " : ""}{s.label && <i className="badge">{s.label}</i>}{s.title_ko}</span>
            <span className="tags">
              {s.markings && <span className="flag mk">마킹 {s.markings.join("·")}만</span>}
              {s.confidence < 0.5 && <span className="flag">확인 필요</span>}
            </span>
          </button>
        ))}
      </nav>

      <main>
        <div className="viewport" ref={fit.ref}>
          <div className="page" key={`${step.page}`} style={{ width: fit.pageW, height: fit.pageH, left: fit.left, top: fit.top }}>
            <img src={pageUrl(step.page)} alt={`설명서 ${step.page}쪽`} />
            <svg viewBox="0 0 1 1" preserveAspectRatio="none" key={`${step.id}-${playKey}`}>
              {whole && <rect className="region" x={step.region[0]} y={step.region[1]}
                width={step.region[2] - step.region[0]} height={step.region[3] - step.region[1]} />}
              {step.hits.filter((h) => hitOrder.has(h.id)).map((h, i) => (
                <rect key={`${h.id}-${i}`} className={`hit ${hover === h.id ? "hover" : ""}`}
                  style={{ animationDelay: `${0.25 + (hitOrder.get(h.id) ?? 0) * 0.12}s` }}
                  x={h.box[0] - 0.004} y={h.box[1] - 0.003} width={h.box[2] - h.box[0] + 0.008} height={h.box[3] - h.box[1] + 0.006} />
              ))}
            </svg>
          </div>
        </div>

        <div className="caption">
          <div className="caption-head">
            <b>{step.number}단계 · {step.title_ko}</b>
            <span className={`conf ${step.confidence < 0.5 ? "low" : ""}`}>
              {step.page}쪽{step.confidence < 0.5 ? " · 확인 필요" : ""}
            </span>
          </div>
          <p>{step.caption_ko}</p>
          {step.warning_ko && <p className="warn">⚠ {step.warning_ko}</p>}
          {step.paints_ko.length > 0 && <p className="paint">🎨 {step.paints_ko.join(" / ")}</p>}
          {step.uses_steps.length > 0 && (
            <p className="uses-steps">들어가는 조립품:{" "}
              {step.uses_steps.map((id) => (
                <button key={id} onClick={() => jump(id)}>{byId.get(id)?.label ?? ""} {byId.get(id)?.title_ko}</button>
              ))}
            </p>
          )}
          <div className="controls">
            <button onClick={() => go(-1)} disabled={index === 0}>◀ 이전</button>
            <button onClick={() => setPlayKey((k) => k + 1)}>↻ 다시 보기</button>
            <button onClick={() => setWhole((w) => !w)}>{whole ? "🔍 단계 확대" : "📄 페이지 전체"}</button>
            <button onClick={() => go(1)} disabled={index === steps.length - 1}>다음 ▶</button>
          </div>
        </div>
      </main>

      <aside>
        <div className="aside-head">
          <h2>{inventory ? "부품 현황" : `이 단계 부품 ${parts.length}개`}</h2>
          <button className={`mini ${inventory ? "on" : ""}`} title="지금까지 쓴 부품과 남은 부품"
            onClick={() => setInventory((v) => (v ? null : "used"))}>
            {inventory ? "이 단계" : "📦 현황"}
          </button>
        </div>
        {inventory && (
          <div className="inventory">
            <div className="progress">
              <div className="bar"><span style={{ width: `${(usedParts.length / Math.max(firstUse.size, 1)) * 100}%` }} /></div>
              <small>{usedParts.length} / {firstUse.size}개 사용{marking !== ALL ? ` · 마킹 ${marking}` : ""}</small>
            </div>
            <div className="tabs">
              <button className={inventory === "used" ? "on" : ""} onClick={() => setInventory("used")}>사용함 {usedParts.length}</button>
              <button className={inventory === "left" ? "on" : ""} onClick={() => setInventory("left")}>남음 {leftParts.length}</button>
            </div>
            {bySprue(inventory === "used" ? usedParts : leftParts).map(([group, list]) => (
              <div key={group} className="sprue">
                <h3>{group} · {list.length}개</h3>
                <div className="chips">
                  {list.map((u) => (
                    <button key={u.part.id} className={`chip ${u.at === index ? "now" : ""}`}
                      title={`${u.step.number}단계 · ${u.step.title_ko}`} onClick={() => setIndex(u.at)}>
                      {u.part.id}<small>{u.step.number}</small>
                    </button>
                  ))}
                </div>
              </div>
            ))}
            {(inventory === "used" ? usedParts : leftParts).length === 0 && (
              <p className="muted">{inventory === "used" ? "아직 쓴 부품이 없어요." : "남은 부품이 없어요. 다 썼어요!"}</p>
            )}
            <p className="muted">작은 숫자는 그 부품을 처음 쓰는 단계예요. 누르면 그 단계로 이동해요.</p>
          </div>
        )}
        {!inventory && groups.map(([group, list]) => (
          <div key={group} className="sprue">
            <h3>{group}</h3>
            <ul className="uses">
              {list.map((p) => {
                const key = `${step.id}/${p.id}`;
                return (
                  <li key={p.id} onMouseEnter={() => setHover(p.id)} onMouseLeave={() => setHover(null)}>
                    <label>
                      <input type="checkbox" checked={!!done[key]} onChange={(e) => setDone((d) => ({ ...d, [key]: e.target.checked }))} />
                      <code>{p.id}</code>
                    </label>
                    {p.optional && <span className="tag">선택</span>}
                    {p.markings && <span className="tag mk">{p.markings.join("·")}</span>}
                    {step.missing.includes(p.id) && <span className="tag miss">위치 못 찾음</span>}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
        {!inventory && parts.length === 0 && <p className="muted">새 부품 없이 앞 조립품을 결합하는 단계예요.</p>}
        <h2>기호 안내</h2>
        <ul className="notes">{guide.notes_ko.map((n) => <li key={n}>{n}</li>)}</ul>
        <p className="meta">추출: {guide.extracted_by}<br />OCR 위치 검출률 {Math.round(guide.ocr_recall * 100)}%</p>
      </aside>
    </div>
  );
}
