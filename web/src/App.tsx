import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { ContactShadows, OrbitControls } from "@react-three/drei";
import gsap from "gsap";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import Assembly, { motionTiming, partFocus, stepDuration, stepFocus, wallShots, type RenderStyle, type Spotlight } from "./Assembly";
import { HardwareThumb, PanelThumb } from "./PartThumb";
import PartsInventory from "./PartsInventory";
import type { Scene } from "./types";
import { ROOM_VIEW } from "./Room";
import { onGoToStep, onPlayExplode, onPlayPartMotion, onReplayStep, playExplode, playPartMotion, setCurrentStep, type MotionTarget } from "./bridge";
import Explode from "./Explode";
import { mentionPart, partTag, smallTag } from "./partTags";
import DemoSwitcher from "./DemoSwitcher";
import ChatPanel from "./ChatPanel";
import ChangeScene, { useCompareView } from "./ChangeScene";
import ChangeHud, { CompareBadge, CompareCard, CompareTimeline } from "./ChangeHud";
import LangBar from "./LangBar";
import { GuideCaption, beatAt, playStep, type GuideApi } from "./Guide";
import { t, useLang, useSpeak } from "./lang";
import { LabelTracker, PartsChecklist, PartsLabels, PartsLayout, checkItems, layoutParts, partsPage, type Layout } from "./PartsCheck";

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
const PART_MIN = 45; // 부품 모션으로 나무못 하나에 다가갈 때 가장 가까운 거리
const PART_FILL = 0.5; // 부품 모션 클로즈업에서 주인공(과 공구)이 화면 짧은 쪽을 차지하는 비율
const UP = new THREE.Vector3(0, 1, 0);
const SPOTLIGHT_HOLD_MS = 3000; // 부품 모션이 끝나고 강조를 남겨 두는 시간
// 부품 확인은 바닥에 펼친 부품을 비스듬히 내려다본다.
const PREP_DIRECTION = new THREE.Vector3(0.15, 1.25, 1).normalize();
const PREP = -1; // 1단계 앞의 부품 확인 단계
const PREP_AUTOPLAY_MS = 4000;
const PREP_CAPTION = "부품을 모두 꺼내 바닥에 펼치세요.\n목록과 개수를 하나씩 맞춰 보며 체크하세요.\n모자라면 조립을 시작하기 전에 매장에 문의하세요.";
const WALL_SHOT = 48; // 벽에 구멍을 뚫고 나사를 박는 자리를 따라갈 때의 거리
// 벽 작업은 옆에서 비스듬히 봐야 드릴·나사가 벽 속으로 들어가는 깊이가 보이고, 드릴이 화면을 가리지 않는다.
const WALL_SHOT_DIRECTION = new THREE.Vector3(1, 0.3, 0.75).normalize();

// 채팅이 고른 부품 모션. key는 같은 부품을 다시 눌러도 카메라·애니메이션이 다시 돌게 한다.
type Motion = { target: MotionTarget; stepIndex: number; label: string; key: number };

// 보여 줄 단계: 판은 처음 끼우는 단계(없으면 다시 끼우는 단계), 철물 하나는 그것이 처음 나오는 단계,
// 철물 종류는 처음 박는 단계(3D가 없으면 목록에 처음 나오는 단계).
function motionStep(scene: Scene, t: MotionTarget) {
  const find = (f: (s: Scene["steps"][number]) => boolean) => scene.steps.findIndex(f);
  if (t.kind === "panel") {
    const i = find((s) => s.adds.includes(t.id));
    return i >= 0 ? i : find((s) => !!s.reseat?.includes(t.id));
  }
  const i = t.instance ? find((s) => s.small.some((x) => x.id === t.instance)) : -1;
  if (i >= 0) return i;
  const j = find((s) => s.small.some((x) => x.part_id === t.id));
  return j >= 0 ? j : find((s) => s.uses.some((u) => u.part_id === t.id));
}

// 단계가 바뀌면 그 단계에서 움직이는 부품 쪽으로 다가가고, 시점 초기화 버튼을 누르면 기본 위치로 돌아간다.
// 부품 모션이 오면(motionKey가 바뀌면) 단계 전체 대신 그 부품 하나에 바짝 다가간다.
// 분해도(exploding)·수정안 비교(comparing)가 카메라를 쥐고 있는 동안에는 단계 비행을 하지 않고, 비교가 끝나면 단계 시점으로 돌아온다.
function CameraRig({ resetKey, scene, stepIndex, prep, playKey, motion, motionKey, exploding, comparing }: {
  resetKey: number; scene: Scene; stepIndex: number; prep: Layout; playKey: number; motion: Motion | null; motionKey: number;
  exploding: boolean; comparing: boolean;
}) {
  const { camera, controls } = useThree();
  const fly = (position: THREE.Vector3, target: THREE.Vector3, duration = 0.9) => {
    const orbit = controls as unknown as OrbitControlsImpl | null;
    const tl = gsap.timeline({ onUpdate: () => orbit?.update() });
    tl.to(camera.position, { x: position.x, y: position.y, z: position.z, duration, ease: "power2.inOut" }, 0);
    if (orbit) tl.to(orbit.target, { x: target.x, y: target.y, z: target.z, duration, ease: "power2.inOut" }, 0);
    return () => { tl.kill(); };
  };
  const home = () => fly(new THREE.Vector3(...HOME_CAMERA), new THREE.Vector3(...HOME_TARGET));
  // 단계 전체(움직이는 부품들)를 담는 시점.
  const stepView = (duration?: number) => {
    if (scene.steps[stepIndex].room) {
      // 완성: 방 안에 걸린 모습을 한 화면에 담는다.
      const target = new THREE.Vector3(...ROOM_VIEW.target);
      const direction = new THREE.Vector3(...ROOM_VIEW.direction).normalize();
      return fly(target.clone().addScaledVector(direction, ROOM_VIEW.distance), target, duration);
    }
    const focus = stepFocus(scene, stepIndex);
    if (!focus) return home();
    const shots = wallShots(scene, stepIndex);
    if (shots) {
      // 단계 애니메이션과 같은 시계로: 부품마다 그 동작이 시작하기 조금 전에 그 자리로 옮겨 가고, 끝나면 전체를 본다.
      const orbit = controls as unknown as OrbitControlsImpl | null;
      const tl = gsap.timeline({ onUpdate: () => orbit?.update() });
      const move = (target: THREE.Vector3, distance: number, direction: THREE.Vector3, at: number) => {
        const position = target.clone().addScaledVector(direction, distance);
        tl.to(camera.position, { x: position.x, y: position.y, z: position.z, duration: 0.8, ease: "power2.inOut" }, at);
        if (orbit) tl.to(orbit.target, { x: target.x, y: target.y, z: target.z, duration: 0.8, ease: "power2.inOut" }, at);
      };
      let last = "";
      shots.forEach(({ at, start }) => {
        if (at.join() === last) return;
        last = at.join();
        move(new THREE.Vector3(...at), WALL_SHOT, WALL_SHOT_DIRECTION, Math.max(0, start - 0.8));
      });
      const end = stepDuration(scene.steps[stepIndex]);
      move(new THREE.Vector3(...focus.center), Math.max(FOCUS_MIN, focus.radius * 3), FRONT_DIRECTION, end + 0.2);
      return () => { tl.kill(); };
    }
    const target = new THREE.Vector3(...focus.center);
    const distance = Math.min(HOME_DISTANCE, Math.max(FOCUS_MIN, focus.radius * 4.5));
    const direction = scene.steps[stepIndex].pose === "upright" ? FRONT_DIRECTION : HOME_DIRECTION.clone().normalize();
    return fly(target.clone().addScaledVector(direction, distance), target, duration);
  };
  useEffect(() => {
    if (resetKey === 0) return;
    return home();
  }, [resetKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (exploding || comparing) return;
    if (stepIndex === PREP) {
      // 오른쪽 체크리스트에 가리지 않도록 중심을 조금 오른쪽에 두어 부품이 화면 왼쪽으로 오게 한다.
      const target = new THREE.Vector3(prep.radius * 0.42, 0, prep.radius * 0.1);
      return fly(target.clone().addScaledVector(PREP_DIRECTION, prep.radius * 2.8), target);
    }
    // 강조가 시간이 지나 꺼져도(motion=null) 카메라는 그대로 두고, 단계·motionKey가 바뀔 때만 다시 난다.
    const part = motion?.stepIndex === stepIndex ? partFocus(scene, stepIndex, motion.target) : null;
    if (!motion || !part) return stepView();
    // 부품 모션: 주인공에 바짝 다가가 느린 동작을 보여 주고, 끝나면 천천히 물러나 단계 전체를 보여 준다.
    const step = scene.steps[stepIndex];
    const target = new THREE.Vector3(...part.center);
    let direction = step.pose === "upright" ? FRONT_DIRECTION.clone() : HOME_DIRECTION.clone().normalize();
    if (part.axis && step.pose !== "upright") {
      // 누운 가구는 위가 칸 입구라 위에서 내려다보면 판에 가리지 않는다. 박는 축과는 비스듬히 서서 망치질을 옆에서 본다.
      const axis = new THREE.Vector3(...part.axis).normalize();
      direction.addScaledVector(axis, -direction.dot(axis)).normalize()
        .addScaledVector(UP, 0.8).addScaledVector(axis, -0.25).normalize();
    }
    // 채팅을 열어 화면이 좁아져도 잘리지 않게 좁은 쪽 시야각으로 거리를 잡는다.
    const cam = camera as THREE.PerspectiveCamera;
    const half = THREE.MathUtils.degToRad(cam.fov / 2);
    const narrow = Math.min(half, Math.atan(Math.tan(half) * cam.aspect));
    const distance = Math.min(HOME_DISTANCE, Math.max(PART_MIN, part.radius / PART_FILL / Math.tan(narrow)));
    const back = fly(target.clone().addScaledVector(direction, distance), target, 1.1);
    let pull: (() => void) | null = null;
    const timer = gsap.delayedCall(motionTiming(step, motion.target).focusEnd, () => { pull = stepView(1.6); });
    return () => { back(); timer.kill(); pull?.(); };
    // 첫 렌더에는 OrbitControls가 아직 없어서, ?step=으로 바로 열면 controls가 생긴 뒤에 다시 겨눈다.
    // playKey: 다시 보기 때 벽 작업 클로즈업을 단계 애니메이션과 같은 시계로 처음부터 다시 따라간다.
  }, [scene, stepIndex, prep, controls, playKey, motionKey, comparing]); // eslint-disable-line react-hooks/exhaustive-deps
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
  // ?step=13 처럼 단계 번호를 주면 그 단계부터 연다. 없으면 부품 확인부터.
  const [stepIndex, setStepIndex] = useState(() => {
    const n = Number(new URLSearchParams(location.search).get("step"));
    return n >= 1 ? n - 1 : PREP;
  });
  const [playKey, setPlayKey] = useState(0);
  const [autoplay, setAutoplay] = useState(() => new URLSearchParams(location.search).has("tour")); // ?tour=1이면 열자마자 기능 소개와 함께 재생
  const [renderStyle, setRenderStyle] = useState<RenderStyle>("color");
  const [xray, setXray] = useState(() => new URLSearchParams(location.search).has("xray")); // ?xray=1로 투시 켠 채 열기
  const [resetKey, setResetKey] = useState(0);
  const [showList, setShowList] = useState(false);
  const [showPage, setShowPage] = useState(true);
  const [pageZoom, setPageZoom] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [showInventory, setShowInventory] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const [hoverPart, setHoverPart] = useState<string | null>(null);
  const [motion, setMotion] = useState<Motion | null>(null);
  const motionKey = useRef(0);
  // 분해도 연출. key가 바뀌면 처음부터 다시 튼다. step은 시작한 단계(마지막 단계)라, 다른 단계로 가면 바로 끝난다.
  const [explode, setExplode] = useState<{ key: number; step: number } | null>(null);
  const explodeKey = useRef(0);
  const labelEls = useRef(new Map<string, HTMLElement>());
  const appRef = useRef<HTMLDivElement>(null);
  const orbitRef = useRef<OrbitControlsImpl>(null);
  const { lang, voiceOn, translating } = useLang(DEMO, scene);
  const now = scene?.steps[Math.min(stepIndex, scene.steps.length - 1)];
  const spoken = stepIndex === PREP ? [PREP_CAPTION] : now ? [now.caption_ko, now.warning_ko] : [];
  useSpeak(spoken.filter((x): x is string => !!x).map((x) => t(x)).join("\n"));

  useEffect(() => {
    fetch(`${DEMO}/scene.json`).then((r) => r.json()).then(setScene);
  }, []);

  const go = useCallback(
    (delta: number) => {
      if (!scene) return;
      setStepIndex((i) => Math.min(scene.steps.length - 1, Math.max(PREP, i + delta)));
    },
    [scene],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") go(1);
      if (e.key === "ArrowLeft") go(-1);
      if (e.key === " ") { e.preventDefault(); setMotion(null); setExplode(null); setPlayKey((k) => k + 1); }
      if (e.key === "Escape") { setPageZoom(false); setShowList(false); setAutoplay(false); }
      if (e.key === "x" || e.key === "X") setXray((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go]);

  // 자동 재생: 단계 애니메이션이 끝나고 잠깐 쉰 뒤 넘긴다. 기능 소개가 붙은 단계(Guide)에서는 자막과 함께 기능을 보여 준 뒤 넘긴다.
  // ← → 로 단계를 옮기거나 멈추면 하던 기능을 멈추고 되돌린다.
  const guideApi = useRef<GuideApi>({ orbit: () => orbitRef.current, setXray, setStyle: setRenderStyle, setInventory: setShowInventory });
  useEffect(() => {
    if (!autoplay || !scene) return;
    const total = scene.steps.length;
    const ms = stepIndex === PREP ? PREP_AUTOPLAY_MS : (stepDuration(scene.steps[stepIndex]) + 1.5) * 1000;
    const ac = new AbortController();
    playStep(beatAt(stepIndex, total, PREP), ms, guideApi.current, ac.signal)
      .then(() => (stepIndex === total - 1 ? setAutoplay(false) : go(1)))
      .catch(() => {});
    return () => ac.abort("move");
  }, [autoplay, stepIndex, scene, go]);

  // 채팅·원본 PDF 위젯에 지금 단계를 알리고, 채팅의 "N단계" 링크로 이동한다.
  useEffect(() => {
    if (scene && stepIndex === PREP) {
      setCurrentStep({ index: PREP, number: 0, page: partsPage(scene), title: "부품 확인" });
      return;
    }
    const s = scene?.steps[stepIndex];
    if (s) setCurrentStep({ index: stepIndex, number: s.number, page: s.page, title: s.caption_ko });
  }, [scene, stepIndex]);

  useEffect(() => onGoToStep((n) => {
    if (n === 0) return setStepIndex(PREP);
    const i = scene?.steps.findIndex((s) => s.number === n) ?? -1;
    if (i >= 0) setStepIndex(i);
  }), [scene]);

  // 채팅이 고친 단계를 처음부터 다시 튼다(단계 합치기·철물 개수 바꾸기 뒤). 부품 모션 강조는 끈다.
  useEffect(() => onReplayStep((n) => {
    const i = scene?.steps.findIndex((s) => s.number === n) ?? -1;
    if (i < 0) return;
    setMotion(null);
    setExplode(null);
    setAutoplay(false);
    setStepIndex(i);
    setPlayKey((k) => k + 1);
  }), [scene]);

  // 채팅(액션·AI 도구)이 고른 부품의 조립 모션: 그 단계로 가서 애니메이션을 처음부터 다시 틀고,
  // 카메라는 그 부품에 다가가며 부품을 파랗게 강조하고 이름표를 띄운다.
  useEffect(() => onPlayPartMotion((target) => {
    if (!scene) return null;
    const i = motionStep(scene, target);
    if (i < 0) return null;
    const tag = target.kind === "panel" ? partTag(scene, target.id)
      : (target.instance && smallTag(scene, target.instance)) || partTag(scene, target.id);
    motionKey.current += 1;
    setMotion({ target, stepIndex: i, label: tag?.label ?? target.id, key: motionKey.current });
    setExplode(null);
    setAutoplay(false);
    setStepIndex(i);
    setPlayKey((k) => k + 1);
    return scene.steps[i].number;
  }), [scene]);

  // 사용자가 다른 단계로 가면 강조를 끄고, 그대로 있으면 애니메이션이 끝나고 잠깐 뒤에 끈다.
  useEffect(() => {
    if (!motion) return;
    if (motion.stepIndex !== stepIndex || !scene?.steps[stepIndex]) return setMotion(null);
    const id = setTimeout(() => setMotion(null), motionTiming(scene.steps[stepIndex], motion.target).total * 1000 + SPOTLIGHT_HOLD_MS);
    return () => clearTimeout(id);
  }, [motion, stepIndex, scene]);

  // 분해도(채팅 예시 버튼·AI 도구): 마지막 단계(완성품)로 건너뛰고 자동 재생·부품 강조를 끈 뒤 펼쳤다 다시 조립한다.
  // 다시 부르면 처음부터 다시 튼다.
  useEffect(() => onPlayExplode(() => {
    if (!scene) return false;
    const last = scene.steps.length - 1;
    explodeKey.current += 1;
    setMotion(null);
    setAutoplay(false);
    setShowInventory(false);
    setStepIndex(last);
    setExplode({ key: explodeKey.current, step: last });
    return true;
  }), [scene]);

  // 다른 단계로 가면 분해도를 끝낸다(그 렌더에서 바로 꺼지도록 아래에서 단계로도 거른다).
  useEffect(() => {
    if (explode && explode.step !== stepIndex) setExplode(null);
  }, [explode, stepIndex]);

  // 개발 중에는 콘솔·Playwright에서 부품 모션·분해도를 바로 불러 볼 수 있게 열어 둔다.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    // __gsap은 Playwright가 시간을 늦춰(timeScale) 연출을 프레임별로 찍을 때 쓴다.
    const w = window as unknown as { __playPartMotion?: typeof playPartMotion; __playExplode?: typeof playExplode; __gsap?: typeof gsap };
    w.__playPartMotion = playPartMotion;
    w.__playExplode = playExplode;
    w.__gsap = gsap;
    return () => { delete w.__playPartMotion; delete w.__playExplode; delete w.__gsap; };
  }, []);
  const endExplode = useCallback(() => setExplode(null), []);
  // 수정안 비교 중에는 뷰어가 지금 scene 대신 proposal.before / after 의 바뀐 단계를 그린다(ChangeScene.tsx).
  const compareView = useCompareView(scene, stepIndex);

  const items = useMemo(() => (scene ? checkItems(scene) : []), [scene]);
  const layout = useMemo(() => layoutParts(items), [items]);
  const toggleChecked = useCallback((key: string) => setChecked((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  }), []);

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
  const prep = stepIndex === PREP;
  const exploding = explode && explode.step === stepIndex ? explode : null;
  const step = scene.steps[Math.min(Math.max(stepIndex, 0), scene.steps.length - 1)];
  const total = scene.steps.length;
  const lowConfidence = !prep && step.confidence < 0.5;
  const page = prep ? partsPage(scene) : step.page;
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
    <div ref={appRef} className={`viewer ${dragging ? "dragging" : ""} ${exploding ? "explode-on" : ""}`}>
      <Canvas shadows gl={{ alpha: true }} camera={{ position: HOME_CAMERA, fov: 40, near: 1, far: 2000 }}>
        <ambientLight intensity={renderStyle === "technical" ? 1.1 : renderStyle === "color" ? 0.25 : 0.6} />
        <StudioEnvironment on={renderStyle === "color"} />
        <directionalLight position={[80, 160, 100]} intensity={renderStyle === "technical" ? 0.8 : 1.6} castShadow
          shadow-mapSize={[2048, 2048]} shadow-camera-left={-120} shadow-camera-right={120}
          shadow-camera-top={120} shadow-camera-bottom={-120} />
        {compareView
          ? <Assembly key={compareView.key} scene={compareView.scene} stepIndex={compareView.stepIndex} playKey={0}
              renderStyle={renderStyle} xray={xray} hidden={compareView.hidden} still />
          : prep
          ? <>
              <PartsLayout layout={layout} style={renderStyle} hover={hoverPart} playKey={playKey}
                onPick={(key) => mentionPart(partTag(scene, key))} />
              <LabelTracker layout={layout} els={labelEls} />
            </>
          : <Assembly scene={scene} stepIndex={stepIndex} playKey={playKey} renderStyle={renderStyle} xray={xray}
              spotlight={motion?.stepIndex === stepIndex ? motion as Spotlight : null} hideUnit={!!exploding} />}
        <ContactShadows position={[0, 0.1, 0]} scale={220} blur={2.4} opacity={0.3} />
        <OrbitControls ref={orbitRef} target={HOME_TARGET} makeDefault
          onStart={() => setDragging(true)} onEnd={() => setDragging(false)} />
        <CameraRig resetKey={resetKey} scene={scene} stepIndex={stepIndex} prep={layout} playKey={playKey}
          motion={motion} motionKey={motionKey.current} exploding={!!exploding} comparing={!!compareView} />
        {/* 카메라 비행보다 뒤에 두어, 같은 렌더에서 시작한 단계 비행을 분해도가 멈추고 카메라를 넘겨받는다. */}
        {exploding && !compareView && <Explode key={exploding.key} scene={scene} style={renderStyle} onDone={endExplode} />}
        {/* 수정안: 도면이 Before → After 로 바뀌는 과정 */}
        <ChangeScene scene={scene} style={renderStyle} view={compareView} />
      </Canvas>
      <ChangeHud />
      {prep && !compareView && <PartsLabels layout={layout} checked={checked} els={labelEls} onToggle={toggleChecked} />}

      {/* 상단: 제품명 */}
      <header className="overlay topbar">
        <button className="icon" title={t("전체 단계")} onClick={() => setShowList((v) => !v)}>☰</button>
        <div className="title">
          <span className="product">{scene.product}</span>
        </div>
        <CompareBadge />
        <LangBar lang={lang} voiceOn={voiceOn} translating={translating} />
      </header>

      {/* 왼쪽 위: 현재 단계 설명 카드(수정안을 보는 동안에는 그 단계 설명이 바뀌는 모습) */}
      <CompareCard>
      <section className="overlay card instruction" key={stepIndex}>
        <div className="step-badge">{prep ? "✓" : step.number}</div>
        <div className="body">
          <p className="text">{t(prep ? PREP_CAPTION : step.caption_ko)}</p>
          {!prep && step.warning_ko && <p className="warn">⚠ {t(step.warning_ko)}</p>}
          {lowConfidence && <span className="conf low">{t("확인 필요 · 원본 그림과 비교해 보세요")}</span>}
        </div>
      </section>
      </CompareCard>

      {/* 오른쪽 위: 이 단계에 필요한 부품(부품 확인 단계에서는 상자 속 전체 목록). 부품 확인 중 수정안을 볼 때는 체크리스트를 숨긴다. */}
      {prep && compareView ? null : prep ? (
        <PartsChecklist items={items} checked={checked} page={page} onPage={() => setPageZoom(true)}
          onToggle={toggleChecked} onHover={setHoverPart}
          onAll={() => setChecked(new Set(items.filter((it) => it.included).map((it) => it.key)))}
          onStart={() => setStepIndex(0)} />
      ) : (
        <section className="overlay card parts">
          <div className="parts-head">
            <h2>{t("이 단계에 필요한 부품")}</h2>
            <button className="mini" title={t("지금까지 쓴 부품과 남은 부품을 크게 보기")}
              onClick={() => setShowInventory(true)}>{t("📦 현황")}</button>
          </div>
          {parts.length === 0 && <p className="muted">{t("새 부품 없음")}</p>}
          <ul>
            {parts.map((p) => (
              // 줄을 누르면 그 부품을 AI 채팅 입력창에 태그한다.
              <li key={p.key} className="pick" role="button" tabIndex={0} title={t("AI 채팅에 태그하기")}
                onClick={() => mentionPart(partTag(scene, p.key))}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); mentionPart(partTag(scene, p.key)); } }}>
                <span className="thumb">
                  {p.panel ? <PanelThumb size={p.panel.size} active still={`card:${p.key}`} />
                    : p.spec ? <HardwareThumb spec={p.spec} still={`card:hw:${p.key}`} /> : "⚙"}
                </span>
                <span className="name">
                  {t(p.name)}
                  {p.id && <code>{p.id}</code>}
                </span>
                <b className="qty">{p.qty}x</b>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* 오른쪽 가운데: 보기 도구 */}
      <div className="overlay toolbar">
        <button className="icon" title={t("시점 초기화")} onClick={() => { setExplode(null); setResetKey((k) => k + 1); }}>⌂</button>
        <div className="style-switch">
          {STYLES.map((s) => (
            <button key={s.id} className={renderStyle === s.id ? "on" : ""} onClick={() => setRenderStyle(s.id)}>
              {t(s.label)}
            </button>
          ))}
        </div>
        <button className={`icon xray ${xray ? "on" : ""}`} title={t("투시 (X)")} aria-pressed={xray} onClick={() => setXray((v) => !v)}>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
            <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z" /><circle cx="12" cy="12" r="3" />
          </svg>
        </button>
        <button className={`icon ${showPage ? "on" : ""}`} title={t("원본 페이지")} onClick={() => setShowPage((v) => !v)}>📄</button>
        <button className="icon" title={t("전체 화면")} onClick={toggleFullscreen}>⛶</button>
      </div>

      {/* 오른쪽 아래: 원본 설명서 페이지 */}
      {showPage && !prep && (
        <button className="overlay card source" onClick={() => setPageZoom(true)} title={t("크게 보기")}>
          <span className="source-label">{t("원본 {n}쪽", { n: page })}</span>
          <img src={pageUrl(page)} alt={t("설명서 {n}쪽", { n: page })} />
        </button>
      )}

      <GuideCaption onStop={() => setAutoplay(false)} />

      {/* 아래: 단계 타임라인과 재생 컨트롤 */}
      <footer className="overlay dock">
        <button className="nav" onClick={() => go(-1)} disabled={prep} aria-label={t("이전 단계")}>‹</button>
        <div className="middle">
          {/* 수정안을 보는 동안에는 수정안의 단계 칸(합쳐지는 칸이 모이는 모습) */}
          <CompareTimeline>
          <div className="timeline">
            <button title={t("부품 확인")} className={`seg prep ${prep ? "on" : "done"}`} onClick={() => setStepIndex(PREP)}>
              <span>✓</span>
            </button>
            {scene.steps.map((s, i) => (
              <button key={s.number} title={`${s.number}. ${t(s.caption_ko)}`}
                className={`seg ${i < stepIndex ? "done" : ""} ${i === stepIndex ? "on" : ""} ${s.confidence < 0.5 ? "flag" : ""}`}
                onClick={() => setStepIndex(i)}>
                <span>{s.number}</span>
              </button>
            ))}
          </div>
          </CompareTimeline>
          <div className="playback">
            <button onClick={() => { setMotion(null); setExplode(null); setPlayKey((k) => k + 1); }}>{t("↻ 다시 보기")}</button>
            <button className={autoplay ? "on" : ""} onClick={() => setAutoplay((a) => !a)}
              title={t("단계를 넘기며 기능도 함께 보여 줘요 (← → 로 넘기기, Esc로 멈춤)")}>
              {t(autoplay ? "⏸ 멈춤" : "▶ 자동 재생")}
            </button>
            <span className="hint">{t("← → 단계 이동 · Space 다시 보기")}</span>
          </div>
        </div>
        <button className="nav primary" onClick={() => go(1)} disabled={stepIndex === total - 1} aria-label={t("다음 단계")}>›</button>
      </footer>

      {/* 전체 단계 목록 서랍 */}
      {showList && (
        <aside className="drawer">
          <DemoSwitcher current={null} />
          <div className="drawer-head">
            <b>{t("전체 단계")}</b>
            <button className="icon" onClick={() => setShowList(false)} aria-label={t("닫기")}>✕</button>
          </div>
          <nav>
            <button className={prep ? "on" : ""} onClick={() => { setStepIndex(PREP); setShowList(false); }}>
              <span className="num">✓</span>
              <span className="cap">{t("부품 확인")}</span>
            </button>
            {scene.steps.map((s, i) => (
              <button key={s.number} className={i === stepIndex ? "on" : ""}
                onClick={() => { setStepIndex(i); setShowList(false); }}>
                <span className="num">{s.number}</span>
                <span className="cap">{t(s.caption_ko)}</span>
                {s.confidence < 0.5 && <span className="flag">{t("확인 필요")}</span>}
              </button>
            ))}
          </nav>
          <div className="drawer-foot">
            {scene.issues.length > 0 && (
              <div className="issues">
                <b>{t("수량 검증 경고")}</b>
                {scene.issues.map((issue) => <p key={issue}>{issue}</p>)}
              </div>
            )}
            <p className="meta">{t("추출")}: {scene.extracted_by}</p>
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
          <img src={pageUrl(page)} alt={t("설명서 {n}쪽", { n: page })} />
        </div>
      )}
    </div>
  );
}
