// 심사위원용 오프닝(?intro). PDF 하나를 넣으면 읽기 → 필요한 부품 → 3D 생성 → 준비 완료가 자동으로 흐르고
// 실제 뷰어(App)의 첫 화면인 '부품 확인'에 도착한다. App 코드는 고치지 않고, App이 내보내는 부품 확인 조각을 가져다 쓴다.
// App은 처음부터 오프닝 뒤에 띄워 준비(셰이더·썸네일)를 끝내 두고, 오프닝 동안은 그리기만 멈춰 둔다.
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { _roots } from "@react-three/fiber";
import gsap from "gsap";
import App from "../App";
import { PartsChecklist, PartsLabels, checkItems, layoutParts, partsPage, type Layout } from "../PartsCheck";
import type { Scene } from "../types";
import Stage, { findRects } from "./Stage";
import { LogoMark } from "../Logo";
import {
  END, FINDS, KINDS, PAGE_PX, STATUS, T, cardLand, cardStart, clock, kindsOf, pageUrl, play, stop, useClock, type Find,
} from "./timeline";
import "./opening.css";

const FILE_NAME = "KALLAX_조립설명서.pdf";
const params = new URLSearchParams(location.search);
// 확인용: ?intro&at=9.5 → 그 순간에 멈춰서 보기, ?intro&at=9.5&go → 그 순간부터 재생
const AT = params.has("at") ? Number(params.get("at")) : null;
const GO = params.has("go");

// 설명서 페이지에서 테두리 친 부분만 잘라 보여 준다(퍼센트라 상자 크기가 바뀌어도 맞는다).
function cropStyle(f: Find): CSSProperties {
  const [x1, y1, x2, y2] = f.box;
  const bw = x2 - x1, bh = y2 - y1;
  return {
    backgroundImage: `url(${pageUrl(f.page)})`,
    backgroundSize: `${(PAGE_PX.w / bw) * 100}% ${(PAGE_PX.h / bh) * 100}%`,
    backgroundPosition: `${(x1 / (PAGE_PX.w - bw)) * 100}% ${(y1 / (PAGE_PX.h - bh)) * 100}%`,
  };
}
const aspect = (f: Find) => (f.box[2] - f.box[0]) / (f.box[3] - f.box[1]);
function fitInSquare(f: Find): CSSProperties {
  const a = aspect(f);
  return a > 1 ? { width: "100%", height: `${100 / a}%` } : { width: `${a * 100}%`, height: "100%" };
}

// App의 3D 캔버스(부품 썸네일 캔버스 말고 큰 화면)의 그리기를 멈추거나 다시 켠다.
function setAppFrameloop(mode: "always" | "never") {
  for (const [canvas, root] of _roots) {
    if (!(canvas instanceof HTMLCanvasElement)) continue;
    if (canvas.closest(".viewer") && !canvas.closest(".thumb")) root.store.getState().setFrameloop(mode);
  }
}

// ── ①② 첫 화면: 카피 + 드롭존 + 설명서 PDF 한 개 ─────────────────
function Hero({ onDropped, leaving }: { onDropped: () => void; leaving: boolean }) {
  const card = useRef<HTMLButtonElement>(null);
  const zone = useRef<HTMLDivElement>(null);
  const ghost = useRef<HTMLDivElement>(null);
  const drag = useRef({ on: false, x: 0, y: 0, moved: false });
  const [over, setOver] = useState(false);
  const [taken, setTaken] = useState(false);
  const [touched, setTouched] = useState(false);
  const [layoutKey, setLayoutKey] = useState(0);

  const inZone = (x: number, y: number) => {
    const r = zone.current?.getBoundingClientRect();
    return !!r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  };

  // 카드를 드롭존 안(글자 위쪽)으로 날려 넣고 시작한다. 카드를 눌러도, 끌어다 놓아도, 상자·버튼을 눌러도 같다.
  const accept = () => {
    if (taken || !card.current || !zone.current) return;
    setTaken(true);
    setTouched(true);
    setOver(true);
    const c = card.current.getBoundingClientRect(), z = zone.current.getBoundingClientRect();
    const dx = z.left + z.width / 2 - (c.left + c.width / 2) + Number(gsap.getProperty(card.current, "x"));
    const dy = z.top + z.height * 0.36 - (c.top + c.height / 2) + Number(gsap.getProperty(card.current, "y"));
    gsap.timeline({ onComplete: onDropped })
      .to(card.current, { x: dx, y: dy, rotate: 0, scale: 0.42, duration: 0.5, ease: "power3.inOut" })
      .to(card.current, { opacity: 0, scale: 0.36, duration: 0.18 }, "+=0.04");
  };

  // 시범 동작: 가만히 있으면 반투명한 카드가 손가락과 함께 상자로 미끄러져 들어가는 모습을 되풀이한다.
  useEffect(() => {
    const g = ghost.current, c = card.current, z = zone.current;
    if (touched || taken || !g || !c || !z) return;
    const cr = c.getBoundingClientRect(), zr = z.getBoundingClientRect();
    const sx = cr.left, sy = cr.top;
    const ex = zr.left + zr.width / 2 - cr.width * 0.21, ey = zr.top + zr.height * 0.36 - cr.height * 0.21;
    const mx = (sx + ex) / 2, my = Math.min(sy, ey) - 50;
    gsap.set(g, { left: 0, top: 0, width: cr.width, height: cr.height, x: sx, y: sy, scale: 1, opacity: 0 });
    const tl = gsap.timeline({ repeat: -1, repeatDelay: 2.4, delay: 1.5 })
      // 진짜 카드에서 살짝 들려 나오듯 시작해야 두 장이 겹쳐 보이지 않는다.
      .set(g, { x: sx, y: sy, scale: 1, rotate: -3 })
      .to(g, { opacity: 0.85, x: sx - 26, y: sy - 18, rotate: -6, duration: 0.3, ease: "power2.out" })
      .to(g, { keyframes: [{ x: mx, y: my, scale: 0.75, rotate: 0 }, { x: ex, y: ey, scale: 0.42 }], duration: 1.15, ease: "power2.inOut" })
      .call(() => z.classList.add("hint"))
      .to(g, { opacity: 0, duration: 0.3 }, "+=0.1")
      .call(() => z.classList.remove("hint"), [], "+=0.35");
    return () => { tl.kill(); z.classList.remove("hint"); gsap.set(g, { opacity: 0 }); };
  }, [touched, taken, layoutKey]);

  useEffect(() => {
    const onResize = () => setLayoutKey((k) => k + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // 컴퓨터에 있는 진짜 파일을 끌어다 놓아도 브라우저가 그 파일을 열지 않게 막고, 같은 데모로 이어 간다.
  useEffect(() => {
    if (leaving) return;
    const onOver = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      setTouched(true);
      setOver(inZone(e.clientX, e.clientY));
    };
    const onLeave = (e: DragEvent) => { if (!e.relatedTarget) setOver(false); };
    const onDrop = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      accept();
    };
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
  }); // accept가 taken을 보므로 매번 다시 건다

  const onDown = (e: React.PointerEvent) => {
    if (taken) return;
    setTouched(true);
    (e.target as Element).setPointerCapture(e.pointerId);
    drag.current = { on: true, x: e.clientX, y: e.clientY, moved: false };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d.on || !card.current) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (Math.hypot(dx, dy) > 6) d.moved = true;
    gsap.set(card.current, { x: dx, y: dy, rotate: dx * 0.02 });
    setOver(inZone(e.clientX, e.clientY));
  };
  const onUp = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d.on) return;
    d.on = false;
    if (!d.moved || inZone(e.clientX, e.clientY)) accept();
    else {
      setOver(false);
      gsap.to(card.current, { x: 0, y: 0, rotate: 0, duration: 0.5, ease: "back.out(1.6)" });
    }
  };

  return (
    <section className={`op-hero ${leaving ? "leaving" : ""}`}>
      <div className="op-wall" aria-hidden>
        {Array.from({ length: 24 }, (_, i) => <img key={i} src={pageUrl(i + 1)} alt="" />)}
      </div>
      <div className="op-hero-body">
        <p className="op-brand"><LogoMark size={28} />Stepcast</p>
        <h1>브랜드의 PDF 설명서를,<br />고객이 따라 하는 3D 안내로.</h1>
        <div className="op-stage-row">
          <div ref={zone} className={`op-drop ${over ? "over" : ""} ${taken ? "taken" : ""}`} onClick={accept}
            onPointerEnter={() => setTouched(true)}>
            {taken ? (
              <b className="op-drop-done">{FILE_NAME} 받았어요</b>
            ) : (
              <>
                <span className="op-drop-icon" aria-hidden>⤓</span>
                <b>설명서 PDF를 여기에 끌어다 놓으세요</b>
                <button className="op-sample" onClick={(e) => { e.stopPropagation(); accept(); }}>샘플 설명서로 체험하기 →</button>
              </>
            )}
          </div>
          <div className="op-desk">
            <button ref={card} className="op-file" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}
              onPointerEnter={() => setTouched(true)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); accept(); } }}
              aria-label={`${FILE_NAME} 넣기`}>
              <span className="op-paper">
                <span className="op-doc">
                  <img src={pageUrl(1)} alt="" draggable={false} />
                  <i className="op-pdf-badge">PDF</i>
                </span>
              </span>
              <span className="op-file-name">{FILE_NAME}</span>
              <span className="op-file-meta">24쪽 · 조립 설명서</span>
            </button>
            {!taken && <span className="op-hint">끌어다 놓거나 눌러 보세요</span>}
          </div>
        </div>
      </div>
      <div ref={ghost} className="op-ghost" aria-hidden>
        <span className="op-paper"><span className="op-doc"><img src={pageUrl(1)} alt="" /><i className="op-pdf-badge">PDF</i></span></span>
        <svg className="op-hand" viewBox="0 0 24 24" width="34" height="34">
          <path d="M9 11V4.5a1.5 1.5 0 0 1 3 0V10l.5-.1V8.5a1.5 1.5 0 0 1 3 0V10.3l.4-.1a1.5 1.5 0 0 1 2.6 1v4.3c0 3.4-2.6 6.5-6.4 6.5h-.6c-2 0-3.6-.9-4.7-2.5L4.4 15a1.5 1.5 0 0 1 2.3-1.9L9 15V11Z"
            fill="#fff" stroke="#1d2433" strokeWidth="1.4" strokeLinejoin="round" />
        </svg>
      </div>
    </section>
  );
}

// ── ④ 오른쪽 부품 목록. 테두리 친 그림이 카드로 날아와 한 줄씩 채운다 ─────────
// ⑥에서는 같은 자리에서 App의 '상자 속 부품' 체크리스트로 바뀐다.
function FoundParts({ live }: { live: boolean }) {
  const shown = useClock((t) => t >= T.cards - 0.4);
  const landed = useClock((t) => FINDS.filter((_, i) => t >= cardLand(i)).length);
  const landedKinds = useClock((t) => FINDS.reduce((n, f, i) => n + (t >= cardLand(i) ? kindsOf(f) : 0), 0));
  const flying = useClock((t) => t >= T.cards);
  const gone = useClock((t) => t >= T.checklist);
  const thumbs = useRef<(HTMLSpanElement | null)[]>([]);
  const layer = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!flying || !live || !layer.current) return;
    const tweens = FINDS.map((f, i) => {
      const from = findRects[i];
      const slot = thumbs.current[i]?.getBoundingClientRect();
      if (!slot || from.w === 0) return null;
      const a = aspect(f);
      const w = a > 1 ? slot.width : slot.height * a, h = a > 1 ? slot.width / a : slot.height;
      const el = document.createElement("div");
      el.className = "op-fly";
      Object.assign(el.style, cropStyle(f));
      layer.current!.appendChild(el);
      return gsap.timeline({ delay: cardStart(i) - clock.t, onComplete: () => el.remove() })
        .set(el, { left: from.x, top: from.y, width: from.w, height: from.h, opacity: 1 })
        .to(el, { y: -10, scale: 1.04, duration: 0.14, ease: "power2.out" })
        .to(el, {
          left: slot.left + (slot.width - w) / 2, top: slot.top + (slot.height - h) / 2, width: w, height: h,
          y: 0, scale: 1, duration: T.cardDur - 0.14, ease: "power3.inOut",
        });
    });
    return () => { tweens.forEach((t) => t?.kill()); layer.current?.replaceChildren(); };
  }, [flying, live]);

  if (!shown) return null;
  return (
    <>
      <section className={`card op-list ${gone ? "gone" : ""}`}>
        <div className="op-list-head">
          <h2>필요한 부품</h2>
          <span className="op-count">{landedKinds} / {KINDS}종</span>
        </div>
        <ul>
          {FINDS.map((f, i) => (
            <li key={i} className={i < landed ? "in" : ""}>
              <span className="op-thumb" ref={(el) => { thumbs.current[i] = el; }}>
                <span style={{ ...cropStyle(f), ...fitInSquare(f) }} />
              </span>
              <span className="op-name">
                {f.name}
                {f.code && <code>{f.code}</code>}
              </span>
              <b className="op-qty">{f.qty}</b>
            </li>
          ))}
        </ul>
      </section>
      <div ref={layer} className="op-fly-layer" aria-hidden />
    </>
  );
}

// ⑥ App 부품 확인 화면의 체크리스트와 수량 이름표를 그대로 띄워 둔다(App이 내보내는 컴포넌트 그대로).
// 화면 폭에 따라 배치가 바뀌는 App의 규칙(.viewer 컨테이너 쿼리)도 똑같이 먹도록 같은 틀로 감싼다.
function Arrival({ scene, layout, labelEls }: { scene: Scene; layout: Layout; labelEls: React.RefObject<Map<string, HTMLElement>> }) {
  const list = useClock((t) => t >= T.checklist);
  const labels = useClock((t) => t >= T.labels);
  const items = useMemo(() => checkItems(scene), [scene]);
  const none = useMemo(() => new Set<string>(), []);
  const noop = () => {};
  return (
    <div className={`viewer op-arrive-frame ${labels ? "labels-on" : ""}`}>
      <PartsLabels layout={layout} checked={none} els={labelEls} onToggle={noop} />
      {list && (
        <div className="op-arrive">
          <PartsChecklist items={items} checked={none} page={partsPage(scene)} onToggle={noop} onHover={noop}
            onAll={noop} onStart={noop} onPage={noop} />
        </div>
      )}
    </div>
  );
}

function Status({ steps }: { steps: number }) {
  const text = useClock((t) => [...STATUS].reverse().find((s) => t >= s.at)?.text ?? STATUS[0].text);
  const pct = useClock((t) => Math.round(Math.min(1, Math.max(0, t) / T.ready) * 50) * 2);
  const facts = useClock((t) => (t >= T.ready ? 3 : t >= cardLand(FINDS.length - 1) ? 2 : t >= T.scan[1] ? 1 : 0));
  const done = text === STATUS[STATUS.length - 1].text;
  return (
    <div className={`op-status ${done ? "done" : ""}`}>
      <div className="op-status-row">
        <span className="op-dot" />
        <b>{text}</b>
      </div>
      <div className="op-bar"><span style={{ width: `${pct}%` }} /></div>
      <div className="op-facts">
        <span className={facts >= 1 ? "on" : ""}>24쪽 읽음</span>
        <span className={facts >= 2 ? "on" : ""}>부품 {KINDS}종</span>
        <span className={facts >= 3 ? "on" : ""}>조립 {steps}단계</span>
      </div>
    </div>
  );
}

function Journey() {
  return (
    <nav className="op-journey" aria-label="체험 순서">
      <span className="on">생성</span><i>→</i><span>검수</span><i>→</i><span>고객 체험</span>
    </nav>
  );
}

export default function Opening() {
  const [scene, setScene] = useState<Scene | null>(null);
  const [started, setStarted] = useState(AT !== null);
  const [ready, setReady] = useState(false);
  const [dropped, setDropped] = useState(false);
  const [skipped, setSkipped] = useState(false);
  const [toast, setToast] = useState(false);
  const layout = useMemo(() => (scene ? layoutParts(checkItems(scene)) : null), [scene]);
  const labelEls = useRef(new Map<string, HTMLElement>());
  const live = AT === null || (GO && AT < T.cards);
  // App 카메라·부품은 이미 제자리에 있으니, 걷히기 직전에만 다시 그린다(두 화면을 같이 그리는 시간을 짧게).
  const appLive = useClock((t) => t >= T.handoff - 0.3) || skipped;
  const handoff = useClock((t) => t >= T.handoff);
  const finished = useClock((t) => t >= END) || skipped;

  useEffect(() => {
    fetch("/demo/scene.json").then((r) => r.json()).then(setScene);
  }, []);

  useEffect(() => {
    if (AT !== null) play(AT, !GO);
    else clock.t = -1;
    return () => stop(-1);
  }, []);

  // App은 처음 3초 동안 그려서 준비를 끝내고, 넘어가기 직전까지 그리기를 멈춰 둔다(오프닝이 가벼워진다).
  // App이 다시 그려질 때 r3f가 설정을 되돌릴 수 있어 1초마다 다시 멈춘다.
  useEffect(() => {
    if (appLive) {
      setAppFrameloop("always");
      return;
    }
    let id = 0;
    const warm = setTimeout(() => {
      setAppFrameloop("never");
      id = window.setInterval(() => setAppFrameloop("never"), 1000);
    }, 3000);
    return () => { clearTimeout(warm); clearInterval(id); };
  }, [appLive]);

  // 카드가 상자에 들어갔고 장면 준비도 끝났으면 시작한다(준비가 늦으면 끝날 때까지 기다린다).
  useEffect(() => {
    if (dropped && ready && !started) {
      setStarted(true);
      play(0);
    }
  }, [dropped, ready, started]);

  // 오프닝을 걷어 내면 App의 부품 확인 화면이 그대로 이어진다. 한 줄 안내만 띄운다.
  useEffect(() => {
    if (!handoff || skipped) return;
    setToast(true);
    const id = setTimeout(() => setToast(false), 4500);
    return () => clearTimeout(id);
  }, [handoff, skipped]);

  const skip = () => {
    stop(END);
    setSkipped(true);
  };

  return (
    <>
      <App />
      {!finished && scene && layout && (
        <div className={`op-root ${handoff ? "leaving" : ""} ${started ? "running" : ""}`}>
          <Stage scene={scene} layout={layout} labelEls={labelEls} running={started} warm={AT === null}
            onReady={() => setReady(true)} />
          {started && (
            <>
              <FoundParts live={live} />
              <Arrival scene={scene} layout={layout} labelEls={labelEls} />
              <Status steps={scene.steps.length} />
            </>
          )}
          <Hero onDropped={() => setDropped(true)} leaving={started} />
          {dropped && !started && <div className="op-wait">설명서 여는 중…</div>}
          <Journey />
          <button className="op-skip" onClick={skip}>오프닝 건너뛰기 ↦</button>
        </div>
      )}
      {toast && <div className="op-toast">✓ 3D 조립 안내 초안이 만들어졌어요 · 부품 확인부터 시작해요</div>}
    </>
  );
}
