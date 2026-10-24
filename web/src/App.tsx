import { useCallback, useEffect, useRef, useState } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { ContactShadows, OrbitControls } from "@react-three/drei";
import gsap from "gsap";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import Assembly, { stepDuration, stepFocus, type RenderStyle } from "./Assembly";
import { HardwareThumb, PanelThumb } from "./PartThumb";
import PartsInventory from "./PartsInventory";
import type { Scene } from "./types";
import { onGoToStep, setCurrentStep } from "./bridge";
import DemoSwitcher from "./DemoSwitcher";
import ChatPanel from "./ChatPanel";

const DEMO = "/demo";
const HOME_CAMERA: [number, number, number] = [150, 140, 200];
const HOME_TARGET: [number, number, number] = [0, 22, 0];
const STYLES: { id: RenderStyle; label: string }[] = [
  { id: "technical", label: "도면" },
  { id: "toon", label: "툰" },
  { id: "color", label: "원목" },
];

function pageUrl(page: number) {
  return `${DEMO}/pages/page-${String(page).padStart(2, "0")}.png`;
}

const HOME_DIRECTION = new THREE.Vector3(...HOME_CAMERA).sub(new THREE.Vector3(...HOME_TARGET));
const HOME_DISTANCE = HOME_DIRECTION.length();
// 세운 뒤에는 칸 안쪽(브래킷)과 벽이 보이도록 앞에서 윗판보다 낮게 들여다본다.
const FRONT_DIRECTION = new THREE.Vector3(0.4, -0.06, 1).normalize();
const FOCUS_MIN = 70; // 작은 부품에 다가갈 때 가장 가까운 거리

// 단계가 바뀌면 그 단계에서 움직이는 부품 쪽으로 다가가고, 시점 초기화 버튼을 누르면 기본 위치로 돌아간다.
function CameraRig({ resetKey, scene, stepIndex }: { resetKey: number; scene: Scene; stepIndex: number }) {
  const { camera, controls } = useThree();
  const fly = (position: THREE.Vector3, target: THREE.Vector3) => {
    const orbit = controls as unknown as OrbitControlsImpl | null;
    const tl = gsap.timeline({ onUpdate: () => orbit?.update() });
    tl.to(camera.position, { x: position.x, y: position.y, z: position.z, duration: 0.9, ease: "power2.inOut" }, 0);
    if (orbit) tl.to(orbit.target, { x: target.x, y: target.y, z: target.z, duration: 0.9, ease: "power2.inOut" }, 0);
    return () => { tl.kill(); };
  };
  const home = () => fly(new THREE.Vector3(...HOME_CAMERA), new THREE.Vector3(...HOME_TARGET));
  useEffect(() => {
    if (resetKey === 0) return;
    return home();
  }, [resetKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const focus = stepFocus(scene, stepIndex);
    if (!focus) return home();
    const target = new THREE.Vector3(...focus.center);
    const distance = Math.min(HOME_DISTANCE, Math.max(FOCUS_MIN, focus.radius * 4.5));
    const direction = scene.steps[stepIndex].pose === "upright" ? FRONT_DIRECTION : HOME_DIRECTION.clone().normalize();
    return fly(target.clone().addScaledVector(direction, distance), target);
  }, [scene, stepIndex]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

// 원목 모드: 스튜디오처럼 부드러운 반사광을 깔아 오크의 따뜻한 색이 살아나게 한다(TORNVIKEN 재질 뷰어와 같은 조명).
function StudioEnvironment({ on }: { on: boolean }) {
  const { gl, scene } = useThree();
  useEffect(() => {
    if (!on) return;
    const pmrem = new THREE.PMREMGenerator(gl);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = env;
    scene.environmentIntensity = 0.9;
    return () => { scene.environment = null; env.dispose(); pmrem.dispose(); };
  }, [on, gl, scene]);
  return null;
}

export default function App() {
  const [scene, setScene] = useState<Scene | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [playKey, setPlayKey] = useState(0);
  const [autoplay, setAutoplay] = useState(false);
  const [renderStyle, setRenderStyle] = useState<RenderStyle>("color");
  const [resetKey, setResetKey] = useState(0);
  const [showList, setShowList] = useState(false);
  const [showPage, setShowPage] = useState(true);
  const [pageZoom, setPageZoom] = useState(false);
  const [showSafety, setShowSafety] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [showInventory, setShowInventory] = useState(false);
  const appRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch(`${DEMO}/scene.json`).then((r) => r.json()).then(setScene);
  }, []);

  const go = useCallback(
    (delta: number) => {
      if (!scene) return;
      setStepIndex((i) => Math.min(scene.steps.length - 1, Math.max(0, i + delta)));
    },
    [scene],
  );

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
    if (!autoplay || !scene) return;
    if (stepIndex === scene.steps.length - 1) {
      setAutoplay(false);
      return;
    }
    // 단계마다 부품을 하나씩 조이는 시간이 달라서, 애니메이션이 끝나고 잠깐 쉰 뒤 넘긴다.
    const timer = setTimeout(() => go(1), (stepDuration(scene.steps[stepIndex]) + 1.5) * 1000);
    return () => clearTimeout(timer);
  }, [autoplay, stepIndex, scene, go]);

  // 채팅·원본 PDF 위젯에 지금 단계를 알리고, 채팅의 "N단계" 링크로 이동한다.
  useEffect(() => {
    const s = scene?.steps[stepIndex];
    if (s) setCurrentStep({ index: stepIndex, number: s.number, page: s.page, title: s.caption_ko });
  }, [scene, stepIndex]);

  useEffect(() => onGoToStep((n) => {
    const i = scene?.steps.findIndex((s) => s.number === n) ?? -1;
    if (i >= 0) setStepIndex(i);
  }), [scene]);

  const closeInventory = useCallback(() => setShowInventory(false), []);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else appRef.current?.requestFullscreen();
  };

  // 채팅으로 단계가 줄어들면 지금 단계 번호를 범위 안으로 당긴다.
  useEffect(() => {
    if (scene && stepIndex > scene.steps.length - 1) setStepIndex(scene.steps.length - 1);
  }, [scene, stepIndex]);

  if (!scene) return <div className="loading">scene.json 불러오는 중…</div>;
  const step = scene.steps[Math.min(stepIndex, scene.steps.length - 1)];
  const total = scene.steps.length;
  const lowConfidence = step.confidence < 0.5;
  const parts = [
    ...step.adds.map((id) => {
      const panel = scene.panels.find((p) => p.id === id);
      // 판재는 번호 대신 실제 치수(cm)를 보여 준다.
      const dims = panel ? [...panel.size].sort((a, b) => b - a).map((v) => +v.toFixed(1)).join(" × ") + " cm" : "";
      return { key: id, panel, spec: undefined, id: dims, name: panel?.name_ko ?? id, qty: 1 };
    }),
    ...step.uses.map((u) => ({
      key: u.part_id, panel: undefined, spec: scene.hardware?.[u.part_id], id: u.part_id, name: u.name_ko, qty: u.qty,
    })),
  ];

  return (
    // 카메라를 돌리는 동안에는 2D 오버레이를 흐리게 해서 모델을 가리지 않게 한다(Cadasio의 autohide).
    <div ref={appRef} className={`viewer ${dragging ? "dragging" : ""}`}>
      <Canvas shadows gl={{ alpha: true }} camera={{ position: HOME_CAMERA, fov: 40, near: 1, far: 2000 }}>
        <ambientLight intensity={renderStyle === "technical" ? 1.1 : renderStyle === "color" ? 0.25 : 0.6} />
        <StudioEnvironment on={renderStyle === "color"} />
        <directionalLight position={[80, 160, 100]} intensity={renderStyle === "technical" ? 0.8 : 1.6} castShadow
          shadow-mapSize={[2048, 2048]} shadow-camera-left={-120} shadow-camera-right={120}
          shadow-camera-top={120} shadow-camera-bottom={-120} />
        <Assembly scene={scene} stepIndex={stepIndex} playKey={playKey} renderStyle={renderStyle} />
        <ContactShadows position={[0, 0.1, 0]} scale={220} blur={2.4} opacity={0.3} />
        <OrbitControls target={HOME_TARGET} makeDefault
          onStart={() => setDragging(true)} onEnd={() => setDragging(false)} />
        <CameraRig resetKey={resetKey} scene={scene} stepIndex={stepIndex} />
      </Canvas>

      {/* 상단: 제품명과 진행 상황 */}
      <header className="overlay topbar">
        <button className="icon" title="전체 단계" onClick={() => setShowList((v) => !v)}>☰</button>
        <div className="title">
          <span className="product">{scene.product}</span>
          <span className="progress-text">{step.number} / {total} 단계</span>
        </div>
      </header>

      {showSafety && (
        <div className="overlay safety">
          <span>⚠ {scene.safety_ko[0]}</span>
          <button onClick={() => setShowSafety(false)} aria-label="닫기">✕</button>
        </div>
      )}

      {/* 왼쪽 위: 현재 단계 설명 카드 */}
      <section className="overlay card instruction" key={stepIndex}>
        <div className="step-badge">{step.number}</div>
        <div className="body">
          <p className="text">{step.caption_ko}</p>
          {step.warning_ko && <p className="warn">⚠ {step.warning_ko}</p>}
          {lowConfidence && <span className="conf low">확인 필요 · 원본 그림과 비교해 보세요</span>}
        </div>
      </section>

      {/* 오른쪽 위: 이 단계에 필요한 부품 */}
      <section className="overlay card parts">
        <div className="parts-head">
          <h2>이 단계에 필요한 부품</h2>
          <button className="mini" title="지금까지 쓴 부품과 남은 부품을 크게 보기"
            onClick={() => setShowInventory(true)}>📦 현황</button>
        </div>
        {parts.length === 0 && <p className="muted">새 부품 없음</p>}
        <ul>
          {parts.map((p) => (
            <li key={p.key}>
              <span className="thumb">
                {p.panel ? <PanelThumb size={p.panel.size} active still={`card:${p.key}`} />
                  : p.spec ? <HardwareThumb spec={p.spec} still={`card:hw:${p.key}`} /> : "⚙"}
              </span>
              <span className="name">
                {p.name}
                {p.id && <code>{p.id}</code>}
              </span>
              <b className="qty">{p.qty}x</b>
            </li>
          ))}
        </ul>
      </section>

      {/* 오른쪽 가운데: 보기 도구 */}
      <div className="overlay toolbar">
        <button className="icon" title="시점 초기화" onClick={() => setResetKey((k) => k + 1)}>⌂</button>
        <div className="style-switch">
          {STYLES.map((s) => (
            <button key={s.id} className={renderStyle === s.id ? "on" : ""} onClick={() => setRenderStyle(s.id)}>
              {s.label}
            </button>
          ))}
        </div>
        <button className={`icon ${showPage ? "on" : ""}`} title="원본 페이지" onClick={() => setShowPage((v) => !v)}>📄</button>
        <button className="icon" title="전체 화면" onClick={toggleFullscreen}>⛶</button>
      </div>

      {/* 오른쪽 아래: 원본 설명서 페이지 */}
      {showPage && (
        <button className="overlay card source" onClick={() => setPageZoom(true)} title="크게 보기">
          <span className="source-label">원본 {step.page}쪽</span>
          <img src={pageUrl(step.page)} alt={`설명서 ${step.page}쪽`} />
        </button>
      )}

      {/* 아래: 단계 타임라인과 재생 컨트롤 */}
      <footer className="overlay dock">
        <button className="nav" onClick={() => go(-1)} disabled={stepIndex === 0} aria-label="이전 단계">‹</button>
        <div className="middle">
          <div className="timeline">
            {scene.steps.map((s, i) => (
              <button key={s.number} title={`${s.number}. ${s.caption_ko}`}
                className={`seg ${i < stepIndex ? "done" : ""} ${i === stepIndex ? "on" : ""} ${s.confidence < 0.5 ? "flag" : ""}`}
                onClick={() => setStepIndex(i)}>
                <span>{s.number}</span>
              </button>
            ))}
          </div>
          <div className="playback">
            <button onClick={() => setPlayKey((k) => k + 1)}>↻ 다시 보기</button>
            <button className={autoplay ? "on" : ""} onClick={() => setAutoplay((a) => !a)}>
              {autoplay ? "⏸ 멈춤" : "▶ 자동 재생"}
            </button>
            <span className="hint">← → 단계 이동 · Space 다시 보기</span>
          </div>
        </div>
        <button className="nav primary" onClick={() => go(1)} disabled={stepIndex === total - 1} aria-label="다음 단계">›</button>
      </footer>

      {/* 전체 단계 목록 서랍 */}
      {showList && (
        <aside className="drawer">
          <DemoSwitcher current={null} />
          <div className="drawer-head">
            <b>전체 단계</b>
            <button className="icon" onClick={() => setShowList(false)} aria-label="닫기">✕</button>
          </div>
          <nav>
            {scene.steps.map((s, i) => (
              <button key={s.number} className={i === stepIndex ? "on" : ""}
                onClick={() => { setStepIndex(i); setShowList(false); }}>
                <span className="num">{s.number}</span>
                <span className="cap">{s.caption_ko}</span>
                {s.confidence < 0.5 && <span className="flag">확인 필요</span>}
              </button>
            ))}
          </nav>
          <div className="drawer-foot">
            {scene.issues.length > 0 && (
              <div className="issues">
                <b>수량 검증 경고</b>
                {scene.issues.map((issue) => <p key={issue}>{issue}</p>)}
              </div>
            )}
            <p className="meta">추출: {scene.extracted_by}</p>
          </div>
        </aside>
      )}

      {showInventory && (
        <PartsInventory scene={scene} stepIndex={stepIndex} onClose={closeInventory}
          onJump={(i) => { setStepIndex(i); setShowInventory(false); }} />
      )}

      <ChatPanel scene={scene} setScene={setScene} />

      {pageZoom && (
        <div className="lightbox" onClick={() => setPageZoom(false)}>
          <img src={pageUrl(step.page)} alt={`설명서 ${step.page}쪽`} />
        </div>
      )}
    </div>
  );
}
