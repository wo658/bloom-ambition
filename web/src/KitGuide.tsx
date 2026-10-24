import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { ContactShadows, OrbitControls } from "@react-three/drei";
import gsap from "gsap";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import type { RenderStyle } from "./Assembly";
import KitAssembly, { appliesTo } from "./KitAssembly";
import type { KitPartKind, KitScene, KitStep } from "./kitTypes";
import { onGoToStep, setCurrentStep } from "./bridge";
import DemoSwitcher from "./DemoSwitcher";
import LangBar from "./LangBar";
import { afterSpeech, t, useLang, useSpeak } from "./lang";
import "./kit.css";

const ALL = "전체";
const AUTOPLAY_MS = 4500;
const HOME_DIR = new THREE.Vector3(1.15, 0.8, 1.3).normalize();
const FOV = 40;
const STYLES: { id: RenderStyle; label: string }[] = [
  { id: "technical", label: "도면" },
  { id: "toon", label: "툰" },
  { id: "color", label: "컬러" },
];
const KIND_LABEL: Record<KitPartKind, string> = { plastic: "사출", photo_etch: "에칭", clear: "투명", jig: "지그" };

// 단계가 바뀌면 부품이 날아오는 쪽에서 그 단계 부품이 화면에 들어오도록 카메라를 옮긴다.
function FocusRig({ scene, step, resetKey }: { scene: KitScene; step: KitStep; resetKey: number }) {
  const { camera, controls } = useThree();
  const lastReset = useRef(resetKey);
  useEffect(() => {
    const orbit = controls as unknown as OrbitControlsImpl | null;
    if (!orbit) return;
    const pose = scene.poses[step.pose];
    const [x, y, z, r] = step.focus;
    const tilt = new THREE.Euler(-pose.pitch, 0, 0);
    const target = new THREE.Vector3(x, y, z).applyEuler(tilt).add(new THREE.Vector3(0, pose.height, 0));
    const reset = lastReset.current !== resetKey;
    lastReset.current = resetKey;
    const dir = reset ? HOME_DIR.clone() : new THREE.Vector3(...step.view).applyEuler(tilt);
    const dist = Math.max(8, (r / Math.sin((FOV / 2) * (Math.PI / 180))) * 1.35);
    const eye = target.clone().add(dir.multiplyScalar(dist));
    const tl = gsap.timeline({ onUpdate: () => orbit.update() });
    tl.to(orbit.target, { x: target.x, y: target.y, z: target.z, duration: 1.1, ease: "power2.inOut" }, 0);
    tl.to(camera.position, { x: eye.x, y: eye.y, z: eye.z, duration: 1.1, ease: "power2.inOut" }, 0);
    return () => { tl.kill(); };
  }, [step, resetKey, controls]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

export default function KitGuide({ demo, scene, pageUrl }: { demo: string; scene: KitScene; pageUrl: (page: number) => string }) {
  const [marking, setMarking] = useState(ALL);
  const [index, setIndex] = useState(0);
  const [playKey, setPlayKey] = useState(0);
  const [autoplay, setAutoplay] = useState(false);
  const [renderStyle, setRenderStyle] = useState<RenderStyle>("technical");
  const [resetKey, setResetKey] = useState(0);
  const [showList, setShowList] = useState(false);
  const [showPage, setShowPage] = useState(true);
  const [pageZoom, setPageZoom] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [hoverPart, setHoverPart] = useState<string | null>(null);
  const appRef = useRef<HTMLDivElement>(null);
  const { lang, voiceOn, translating } = useLang(`/demo/${demo}`, scene);

  const mk = marking === ALL ? null : marking;
  // 선택한 마킹에 해당하는 단계만 이어서 본다. 원본 단계 인덱스(cur)로 3D 장면을 그린다.
  const order = useMemo(() => scene.steps.map((s, i) => ({ s, i })).filter(({ s }) => appliesTo(s.markings, mk)), [scene, mk]);
  const { s: step, i: cur } = order[Math.min(index, order.length - 1)];
  const total = order.length;
  useSpeak([step.title_ko, step.caption_ko, step.warning_ko].filter((x): x is string => !!x).map((x) => t(x)).join("\n"));

  const go = useCallback((delta: number) => setIndex((i) => Math.min(order.length - 1, Math.max(0, i + delta))), [order]);
  const jump = (id: string) => {
    const i = order.findIndex(({ s }) => s.id === id);
    if (i >= 0) setIndex(i);
  };

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
    return afterSpeech(AUTOPLAY_MS, () => go(1));
  }, [autoplay, index, total, go]);

  // 채팅·원본 PDF 위젯에 지금 단계를 알리고, 채팅의 "N단계" 링크로 이동한다.
  useEffect(() => {
    setCurrentStep({ index, number: step.number, page: step.page, title: step.title_ko });
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => onGoToStep((n) => {
    const i = order.findIndex(({ s }) => s.number === n);
    if (i >= 0) return setIndex(i);
    // 선택한 마킹에서 빠진 단계면 필터를 풀고 이동한다.
    const j = scene.steps.findIndex((s) => s.number === n);
    if (j >= 0) { setMarking(ALL); setIndex(j); }
  }), [order, scene]);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else appRef.current?.requestFullscreen();
  };

  const parts = step.adds.filter((p) => appliesTo(p.markings, mk));
  const byId = new Map(scene.steps.map((s) => [s.id, s]));
  const lowConfidence = step.confidence < 0.5;
  const markingTitle = scene.markings.find((m) => m.id === marking)?.title_ko;

  return (
    // 카메라를 돌리는 동안에는 2D 오버레이를 흐리게 해서 모델을 가리지 않게 한다(가구 뷰어와 같은 autohide).
    <div ref={appRef} className={`viewer ${dragging ? "dragging" : ""}`}>
      <Canvas shadows gl={{ alpha: true }} camera={{ position: HOME_DIR.clone().multiplyScalar(40).toArray(), fov: FOV, near: 0.2, far: 400 }}>
        <ambientLight intensity={renderStyle === "technical" ? 1.1 : 0.65} />
        <directionalLight position={[20, 40, 25]} intensity={renderStyle === "technical" ? 0.8 : 1.6} castShadow
          shadow-mapSize={[2048, 2048]} shadow-camera-left={-20} shadow-camera-right={20}
          shadow-camera-top={20} shadow-camera-bottom={-20} />
        <KitAssembly scene={scene} cur={cur} playKey={playKey} renderStyle={renderStyle} marking={mk} hoverPart={hoverPart} />
        <ContactShadows position={[0, 0.02, 0]} scale={60} blur={2.4} opacity={0.3} />
        <OrbitControls makeDefault onStart={() => setDragging(true)} onEnd={() => setDragging(false)} />
        <FocusRig scene={scene} step={step} resetKey={resetKey} />
      </Canvas>

      {/* 상단: 제품명과 진행 상황 */}
      <header className="overlay topbar">
        <button className="icon" title={t("전체 단계")} onClick={() => setShowList((v) => !v)}>☰</button>
        <div className="title">
          <span className="brand">Stepcast</span>
          <span className="product">{scene.product}</span>
          <span className="progress-text">{t("{n} / {total} 단계", { n: index + 1, total })}{mk ? ` · ${t("마킹")} ${mk}` : ""}</span>
        </div>
        <LangBar lang={lang} voiceOn={voiceOn} translating={translating} />
      </header>

      {/* 상단 가운데: 마킹(도색 사양) 선택 — 가구의 안전 안내 자리 */}
      <div className="overlay marking-pill" title={markingTitle && t(markingTitle)}>
        <span className="label">{t("마킹")}</span>
        {[ALL, ...scene.markings.map((m) => m.id)].map((id) => (
          <button key={id} className={marking === id ? "on" : ""} title={scene.markings.find((m) => m.id === id)?.title_ko}
            onClick={() => { setMarking(id); setIndex(0); setAutoplay(false); }}>{id === ALL ? t(ALL) : id}</button>
        ))}
        {markingTitle && <em>{t(markingTitle)}</em>}
      </div>

      {/* 왼쪽 위: 현재 단계 설명 카드 */}
      <section className="overlay card instruction kit-instruction" key={`${marking}-${step.id}`}>
        <div className="step-badge">{step.number}</div>
        <div className="body">
          <p className="step-title">
            {step.label && <i className="sub-badge" title={t("이 단계에서 만든 조립품 기호")}>{step.label}</i>}
            {t(step.title_ko)}
          </p>
          <p className="text">{t(step.caption_ko)}</p>
          {step.warning_ko && <p className="warn">⚠ {t(step.warning_ko)}</p>}
          {step.paints_ko.length > 0 && <p className="paint">🎨 {step.paints_ko.map((x) => t(x)).join("\n")}</p>}
          {step.uses_steps.length > 0 && (
            <p className="uses-steps">
              <span>{t("끼우는 조립품")}</span>
              {step.uses_steps.map((id) => (
                <button key={id} onClick={() => jump(id)}>
                  {byId.get(id)?.label && <i className="sub-badge">{byId.get(id)?.label}</i>}
                  {byId.get(id)?.number}. {t(byId.get(id)?.title_ko ?? "")}
                </button>
              ))}
            </p>
          )}
          {step.markings && <span className="conf mk">{t("마킹 {m}만 해당", { m: step.markings.join("·") })}</span>}
          {lowConfidence && <span className="conf low">{t("확인 필요 · 원본 그림과 비교해 보세요")}</span>}
        </div>
      </section>

      {/* 오른쪽 위: 이 단계에 붙는 부품 */}
      <section className="overlay card parts kit-parts">
        <div className="parts-head">
          <h2>{t("이 단계에 붙는 부품")}{parts.length > 0 ? ` ${parts.length}` : ""}</h2>
        </div>
        {parts.length === 0 && <p className="muted">{t("새 부품 없이 앞에서 만든 조립품을 끼워요.")}</p>}
        <ul>
          {parts.map((p) => (
            <li key={p.id} className={p.optional ? "alt" : ""} onMouseEnter={() => setHoverPart(p.id)} onMouseLeave={() => setHoverPart(null)}>
              <span className={`kind-dot ${p.kind}`} title={t(KIND_LABEL[p.kind])} />
              <span className="name">
                {t(p.name_ko)}
                <code>{p.id} · {t(KIND_LABEL[p.kind])}</code>
              </span>
              {p.markings && <span className="tag mk">{p.markings.join("·")}</span>}
              {p.optional && <span className="tag">{t("다른 선택")}</span>}
            </li>
          ))}
        </ul>
      </section>

      {/* 오른쪽 가운데: 보기 도구 */}
      <div className="overlay toolbar">
        <button className="icon" title={t("시점 초기화")} onClick={() => setResetKey((k) => k + 1)}>⌂</button>
        <div className="style-switch">
          {STYLES.map((s) => (
            <button key={s.id} className={renderStyle === s.id ? "on" : ""} onClick={() => setRenderStyle(s.id)}>{t(s.label)}</button>
          ))}
        </div>
        <button className={`icon ${showPage ? "on" : ""}`} title={t("원본 페이지")} onClick={() => setShowPage((v) => !v)}>📄</button>
        <button className="icon" title={t("전체 화면")} onClick={toggleFullscreen}>⛶</button>
      </div>

      {/* 오른쪽 아래: 원본 설명서 페이지 */}
      {showPage && (
        <button className="overlay card source" onClick={() => setPageZoom(true)} title={t("크게 보기")}>
          <span className="source-label">{t("원본 {n}쪽", { n: step.page })}</span>
          <img src={pageUrl(step.page)} alt={t("설명서 {n}쪽", { n: step.page })} />
        </button>
      )}

      {/* 아래: 단계 타임라인과 재생 컨트롤 */}
      <footer className="overlay dock">
        <button className="nav" onClick={() => go(-1)} disabled={index === 0} aria-label={t("이전 단계")}>‹</button>
        <div className="middle">
          <div className="timeline">
            {order.map(({ s }, i) => (
              <button key={s.id} title={`${s.number}. ${t(s.title_ko)}`}
                className={`seg ${i < index ? "done" : ""} ${i === index ? "on" : ""} ${s.confidence < 0.5 ? "flag" : ""}`}
                onClick={() => setIndex(i)}>
                <span>{s.number}</span>
              </button>
            ))}
          </div>
          <div className="playback">
            <button onClick={() => setPlayKey((k) => k + 1)}>{t("↻ 다시 보기")}</button>
            <button className={autoplay ? "on" : ""} onClick={() => setAutoplay((a) => !a)}>
              {t(autoplay ? "⏸ 멈춤" : "▶ 자동 재생")}
            </button>
            <span className="hint">{t("← → 단계 이동 · Space 다시 보기")}</span>
          </div>
        </div>
        <button className="nav primary" onClick={() => go(1)} disabled={index === total - 1} aria-label={t("다음 단계")}>›</button>
      </footer>

      {/* 전체 단계 목록 서랍 */}
      {showList && (
        <aside className="drawer">
          <DemoSwitcher current={demo} />
          <div className="drawer-head">
            <b>{t("전체 단계")} <small className="count">{total}</small></b>
            <button className="icon" onClick={() => setShowList(false)} aria-label={t("닫기")}>✕</button>
          </div>
          <nav>
            {order.map(({ s }, i) => (
              <button key={s.id} className={i === index ? "on" : ""} onClick={() => { setIndex(i); setShowList(false); }}>
                <span className="num">{s.number}</span>
                <span className="cap">
                  {s.label && <i className="sub-badge">{s.label}</i>}
                  {t(s.title_ko)}
                </span>
                {(s.markings || s.confidence < 0.5) && (
                  <span className="tags">
                    {s.markings && <span className="flag mk">{t("마킹 {m}만 해당", { m: s.markings.join("·") })}</span>}
                    {s.confidence < 0.5 && <span className="flag">{t("확인 필요")}</span>}
                  </span>
                )}
              </button>
            ))}
          </nav>
          <div className="drawer-foot">
            {scene.issues.length > 0 && (
              <div className="issues">
                <b>{t("검증 경고")}</b>
                {scene.issues.map((issue) => <p key={issue}>{issue}</p>)}
              </div>
            )}
            <div className="notes">
              <b>{t("기호 안내")}</b>
              <ul>{scene.notes_ko.map((n) => <li key={n}>{t(n)}</li>)}</ul>
            </div>
            <p className="meta">{t("추출")}: {scene.extracted_by}</p>
          </div>
        </aside>
      )}

      {pageZoom && (
        <div className="lightbox" onClick={() => setPageZoom(false)}>
          <img src={pageUrl(step.page)} alt={t("설명서 {n}쪽", { n: step.page })} />
        </div>
      )}
    </div>
  );
}
