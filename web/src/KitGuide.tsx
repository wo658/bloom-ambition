import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Box, KitGuideData, KitStep } from "./kitTypes";
import "./kit.css";
import { onGoToStep, setCurrentStep } from "./bridge";
import DemoSwitcher from "./DemoSwitcher";

const ALL = "전체";
const PAD = 0.03;
const AUTOPLAY_MS = 5000;

function appliesTo(markings: string[] | null, marking: string) {
  return marking === ALL || !markings || markings.includes(marking);
}

// 가구 뷰어처럼 카드가 화면 위에 떠 있으므로, 카드에 가리지 않는 가운데 영역에 단계를 맞춘다.
function safeArea(w: number, h: number) {
  const side = w > 1100;
  const left = side ? Math.min(452, w * 0.34 + 32) : 16;
  const right = side ? 80 : 16;
  return { left, right, top: 76, bottom: Math.min(140, h * 0.2) };
}

// 단계 영역이 안전 영역에 꽉 차도록 페이지 이미지를 확대·이동하는 값.
function useFit(region: Box, aspect: number, whole: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 1200, h: 800 });
  useLayoutEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver(([entry]) =>
      setSize({ w: entry.contentRect.width, h: entry.contentRect.height }));
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  const safe = safeArea(size.w, size.h);
  const aw = size.w - safe.left - safe.right;
  const ah = size.h - safe.top - safe.bottom;
  const [x0, y0, x1, y1] = whole ? [0, 0, 1, 1] : region;
  const rw = x1 - x0 + PAD * 2;
  const rh = (y1 - y0 + PAD * 2) * aspect;
  const pageW = Math.min(aw / rw, ah / rh);
  const pageH = pageW * aspect;
  const cx = ((x0 + x1) / 2) * pageW;
  const cy = ((y0 + y1) / 2) * pageH;
  return { ref, pageW, pageH, left: safe.left + aw / 2 - cx, top: safe.top + ah / 2 - cy };
}

export default function KitGuide({ demo, guide, pageUrl }: { demo: string; guide: KitGuideData; pageUrl: (page: number) => string }) {
  const [marking, setMarking] = useState(ALL);
  const [index, setIndex] = useState(0);
  const [whole, setWhole] = useState(false);
  const [playKey, setPlayKey] = useState(0);
  const [autoplay, setAutoplay] = useState(false);
  const [showList, setShowList] = useState(false);
  const [showPage, setShowPage] = useState(true);
  const [pageZoom, setPageZoom] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  // 다시 보기: 페이지 전체에서 단계 영역으로 다시 확대해 들어간다.
  const [intro, setIntro] = useState(false);
  // 가구 뷰어의 카메라 조작처럼 페이지를 끌어 옮기고 휠로 확대한다. T(p) = k·p + (x, y)
  const [view, setView] = useState({ k: 1, x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ px: number; py: number } | null>(null);
  const appRef = useRef<HTMLDivElement>(null);

  const steps = useMemo(() => guide.steps.filter((s) => appliesTo(s.markings, marking)), [guide, marking]);
  const step: KitStep = steps[Math.min(index, steps.length - 1)];
  const total = steps.length;
  const byId = useMemo(() => new Map(guide.steps.map((s) => [s.id, s])), [guide]);
  const fit = useFit(step.region, guide.page_aspect, whole || intro);

  useEffect(() => setView({ k: 1, x: 0, y: 0 }), [step.id, whole, resetKey, playKey]);

  useEffect(() => {
    if (playKey === 0 || whole) return;
    setIntro(true);
    const timer = setTimeout(() => setIntro(false), 120);
    return () => clearTimeout(timer);
  }, [playKey]); // eslint-disable-line react-hooks/exhaustive-deps

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
      if (e.key === "Escape") { setPageZoom(false); setShowList(false); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go]);

  useEffect(() => {
    if (!autoplay) return;
    if (index >= total - 1) {
      setAutoplay(false);
      return;
    }
    const timer = setTimeout(() => go(1), AUTOPLAY_MS);
    return () => clearTimeout(timer);
  }, [autoplay, index, total, go]);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else appRef.current?.requestFullscreen();
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    drag.current = { px: e.clientX, py: e.clientY };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.px;
    const dy = e.clientY - d.py;
    if (!dragging && Math.hypot(dx, dy) < 3) return;
    setDragging(true);
    drag.current = { px: e.clientX, py: e.clientY };
    setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
  };
  const onPointerUp = () => {
    drag.current = null;
    setDragging(false);
  };
  const onWheel = (e: React.WheelEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    setView((v) => {
      const k = Math.min(6, Math.max(0.3, v.k * Math.exp(-e.deltaY * 0.0015)));
      const f = k / v.k;
      return { k, x: f * (v.x - cx) + cx, y: f * (v.y - cy) + cy };
    });
  };

  const lowConfidence = step.confidence < 0.5;
  const markingTitle = guide.markings.find((m) => m.id === marking)?.title_ko;
  const page = {
    width: fit.pageW * view.k, height: fit.pageH * view.k,
    left: fit.left * view.k + view.x, top: fit.top * view.k + view.y,
  };

  return (
    // 페이지를 끄는 동안에는 오버레이를 흐리게 해서 그림을 가리지 않게 한다(가구 뷰어와 같은 autohide).
    <div ref={appRef} className={`viewer kit-viewer ${dragging ? "dragging" : ""}`}>
      <div className="kit-stage" ref={fit.ref} onPointerDown={onPointerDown} onPointerMove={onPointerMove}
        onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onWheel={onWheel}>
        <div className={`kit-page ${dragging || intro ? "no-anim" : ""}`} style={page}>
          <img src={pageUrl(step.page)} alt={`설명서 ${step.page}쪽`} draggable={false} />
          {whole && <svg viewBox="0 0 1 1" preserveAspectRatio="none">
            <rect className="region" x={step.region[0]} y={step.region[1]}
              width={step.region[2] - step.region[0]} height={step.region[3] - step.region[1]} />
          </svg>}
        </div>
      </div>

      {/* 상단: 제품명과 진행 상황 */}
      <header className="overlay topbar">
        <button className="icon" title="전체 단계" onClick={() => setShowList((v) => !v)}>☰</button>
        <div className="title">
          <span className="product">{guide.product}</span>
          <span className="progress-text">{index + 1} / {total} 단계{marking !== ALL ? ` · 마킹 ${marking}` : ""}</span>
        </div>
      </header>

      {/* 상단 가운데: 마킹(도색 사양) 선택 */}
      <div className="overlay marking-pill" title={markingTitle}>
        <span className="label">마킹</span>
        {[ALL, ...guide.markings.map((m) => m.id)].map((id) => (
          <button key={id} className={marking === id ? "on" : ""} title={guide.markings.find((m) => m.id === id)?.title_ko}
            onClick={() => { setMarking(id); setIndex(0); setAutoplay(false); }}>{id}</button>
        ))}
        {markingTitle && <em>{markingTitle}</em>}
      </div>

      {/* 왼쪽 위: 현재 단계 설명 카드 */}
      <section className="overlay card instruction kit-instruction" key={`${marking}-${step.id}`}>
        <div className="step-badge">{step.number}</div>
        <div className="body">
          <p className="step-title">
            {step.label && <i className="sub-badge" title="이 단계에서 만든 조립품 기호">{step.label}</i>}
            {step.title_ko}
            <small>원본 {step.page}쪽</small>
          </p>
          <p className="text">{step.caption_ko}</p>
          {step.warning_ko && <p className="warn">⚠ {step.warning_ko}</p>}
          {step.paints_ko.length > 0 && <p className="paint">🎨 {step.paints_ko.join("\n")}</p>}
          {step.uses_steps.length > 0 && (
            <p className="uses-steps">
              <span>들어가는 조립품</span>
              {step.uses_steps.map((id) => (
                <button key={id} onClick={() => jump(id)}>
                  {byId.get(id)?.label && <i className="sub-badge">{byId.get(id)?.label}</i>}
                  {byId.get(id)?.number}단계 {byId.get(id)?.title_ko}
                </button>
              ))}
            </p>
          )}
          {step.markings && <span className="conf mk">마킹 {step.markings.join("·")}만 해당</span>}
          {lowConfidence && <span className="conf low">확인 필요 · 원본 그림과 비교해 보세요</span>}
        </div>
      </section>

      {/* 오른쪽 가운데: 보기 도구 */}
      <div className="overlay toolbar">
        <button className="icon" title="시점 초기화" onClick={() => setResetKey((k) => k + 1)}>⌂</button>
        <div className="style-switch">
          <button className={!whole ? "on" : ""} onClick={() => setWhole(false)}>단계</button>
          <button className={whole ? "on" : ""} onClick={() => setWhole(true)}>페이지</button>
        </div>
        <button className={`icon ${showPage ? "on" : ""}`} title="원본 페이지" onClick={() => setShowPage((v) => !v)}>📄</button>
        <button className="icon" title="전체 화면" onClick={toggleFullscreen}>⛶</button>
      </div>

      {/* 오른쪽 아래: 원본 페이지와 이 단계 위치 */}
      {showPage && (
        <button className="overlay card source" onClick={() => setPageZoom(true)} title="크게 보기">
          <span className="source-label">원본 {step.page}쪽</span>
          <span className="source-frame">
            <img src={pageUrl(step.page)} alt={`설명서 ${step.page}쪽`} />
            <span className="source-region" style={{
              left: `${step.region[0] * 100}%`, top: `${step.region[1] * 100}%`,
              width: `${(step.region[2] - step.region[0]) * 100}%`, height: `${(step.region[3] - step.region[1]) * 100}%`,
            }} />
          </span>
        </button>
      )}

      {/* 아래: 단계 타임라인과 재생 컨트롤 */}
      <footer className="overlay dock">
        <button className="nav" onClick={() => go(-1)} disabled={index === 0} aria-label="이전 단계">‹</button>
        <div className="middle">
          <div className="timeline">
            {steps.map((s, i) => (
              <button key={s.id} title={`${s.number}. ${s.title_ko}`}
                className={`seg ${i < index ? "done" : ""} ${i === index ? "on" : ""} ${s.confidence < 0.5 ? "flag" : ""}`}
                onClick={() => setIndex(i)}>
                <span>{s.number}</span>
              </button>
            ))}
          </div>
          <div className="playback">
            <button onClick={() => setPlayKey((k) => k + 1)}>↻ 다시 보기</button>
            <button className={autoplay ? "on" : ""} onClick={() => setAutoplay((a) => !a)}>
              {autoplay ? "⏸ 멈춤" : "▶ 자동 재생"}
            </button>
            <span className="hint">← → 단계 이동 · Space 다시 보기 · 끌어서 이동 · 휠로 확대</span>
          </div>
        </div>
        <button className="nav primary" onClick={() => go(1)} disabled={index === total - 1} aria-label="다음 단계">›</button>
      </footer>

      {/* 전체 단계 목록 서랍 */}
      {showList && (
        <aside className="drawer">
          <DemoSwitcher current={demo} />
          <div className="drawer-head">
            <b>전체 단계 <small className="count">{total}</small></b>
            <button className="icon" onClick={() => setShowList(false)} aria-label="닫기">✕</button>
          </div>
          <nav>
            {steps.map((s, i) => (
              <button key={s.id} className={i === index ? "on" : ""}
                onClick={() => { setIndex(i); setShowList(false); }}>
                <span className="num">{s.number}</span>
                <span className="cap">
                  {s.label && <i className="sub-badge">{s.label}</i>}
                  {s.title_ko}
                </span>
                {(s.markings || s.confidence < 0.5) && (
                  <span className="tags">
                    {s.markings && <span className="flag mk">마킹 {s.markings.join("·")}만</span>}
                    {s.confidence < 0.5 && <span className="flag">확인 필요</span>}
                  </span>
                )}
              </button>
            ))}
          </nav>
          <div className="drawer-foot">
            <div className="notes">
              <b>기호 안내</b>
              <ul>{guide.notes_ko.map((n) => <li key={n}>{n}</li>)}</ul>
            </div>
            <p className="meta">추출: {guide.extracted_by}</p>
          </div>
        </aside>
      )}

      {pageZoom && (
        <div className="lightbox" onClick={() => setPageZoom(false)}>
          <img src={pageUrl(step.page)} alt={`설명서 ${step.page}쪽`} />
        </div>
      )}
    </div>
  );
}
