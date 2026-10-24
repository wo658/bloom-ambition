import { useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { useFrame } from "@react-three/fiber";
import { Edges } from "@react-three/drei";
import gsap from "gsap";
import * as THREE from "three";
import { EDGE, HIGHLIGHT, Material, type RenderStyle } from "./Assembly";
import { HardwareMesh, METAL } from "./Hardware";
import { HardwareThumb, PanelThumb } from "./PartThumb";
import { inventory, panelDims } from "./PartsInventory";
import { t } from "./lang";
import type { HardwareModel, HardwareSpec, Panel, Scene, Vec3 } from "./types";
import { woodBox } from "./wood";

// 1단계 전 "부품 확인": 상자에서 꺼낸 부품을 바닥에 펼쳐 놓고 개수를 세어 체크한다.
// 설명서 부품 페이지(scene.parts)를 기준으로 하고, 없으면 단계에서 쓰는 부품을 모아 센다.

export interface CheckItem {
  key: string;
  name: string;
  note?: string; // 이름 괄호 속 안내(예: 벽 재질에 맞게 별도 구매)
  code: string;
  qty: number;
  panel?: Panel;
  spec?: HardwareSpec;
  included: boolean;
}

// "벽용 나사 (미포함, 벽 재질에 맞게 별도 구매)" → 이름 "벽용 나사", 안내 "벽 재질에 맞게 별도 구매"
function splitName(raw: string) {
  const m = raw.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
  if (!m) return { name: raw, note: undefined };
  const note = m[2].split(",").map((s) => s.trim()).filter((s) => s && s !== "미포함").join(", ");
  return { name: m[1], note: note || undefined };
}

export function checkItems(scene: Scene): CheckItem[] {
  if (scene.parts?.length) {
    return scene.parts.map((p) => {
      const panel = p.kind === "panel" ? scene.panels.find((x) => x.id === p.id) : undefined;
      return {
        key: p.id, ...splitName(p.name_ko), qty: p.qty, panel, included: p.included,
        spec: panel ? undefined : scene.hardware?.[p.id], code: panel ? panelDims(panel) : p.id,
      };
    });
  }
  return inventory(scene, -1).map((it) => ({
    key: it.key, ...splitName(it.name), qty: it.total, panel: it.panel, spec: it.spec,
    included: !it.name.includes("미포함"), code: it.panel ? panelDims(it.panel) : it.code,
  }));
}

// 원본 설명서에서 부품 목록이 있는 쪽.
export function partsPage(scene: Scene) {
  const pages = (scene.parts ?? []).filter((p) => p.included).map((p) => p.page);
  return pages.length ? Math.min(...pages) : scene.steps[0].page;
}

// 바닥 배치(cm): 판재는 실제 크기로 눕혀서 뒤쪽에 줄지어, 철물은 종류별 칸에 개수만큼 앞쪽에 모은다.
// 철물은 실제 크기로는 판재 옆에서 안 보여서 모두 같은 배율(HW_SCALE)로 키운다. 같은 배율이라 철물끼리 상대 크기가 맞다.
const GAP = 8;
const ROW_MAX = 240;
export const HW_SCALE = 3;

// 축이 긴 부품은 바닥에 눕힌다(부품 로컬 +Y가 축).
const LIE: HardwareModel[] = ["connector_screw", "euro_screw", "wall_screw", "dowel", "screwdriver", "pencil", "hammer"];

// 철물 치수(cm)에서 가장 긴 길이와, 눕혔을 때의 굵기를 어림한다.
function hardwareSize(spec: HardwareSpec) {
  const d = spec.dims;
  const long = Math.max(d.length ?? 0, d.height ?? 0, d.long ?? 0, d.width ?? 0, d.wall ?? 0, (d.r ?? 0) * 2, (d.body ?? 0) + (d.bit ?? 0), 1);
  const thick = Math.max(d.head_d ?? 0, d.d ?? 0, d.across ?? 0, d.thread_d ?? 0, d.shank_d ?? 0, 0.5);
  return { long, thick };
}

type PlacedPanel = { item: CheckItem; copy: number; size: Vec3; pos: Vec3 };
// cols×rows 격자, px·pz는 한 개가 차지하는 간격(배율 적용 cm), w·d는 칸 전체 크기.
type PlacedCell = { item: CheckItem; pos: Vec3; cols: number; rows: number; px: number; pz: number; w: number; d: number };
type Anchor = { item: CheckItem; pos: Vec3 };
// 좌표는 배치 전체의 가운데가 원점이 되도록 옮겨 둔다.
export type Layout = { panels: PlacedPanel[]; cells: PlacedCell[]; labels: Anchor[]; radius: number };

export function layoutParts(items: CheckItem[]): Layout {
  const boards = items.filter((it) => it.included && it.panel)
    .flatMap((item) => Array.from({ length: item.qty }, (_, copy) => {
      const [l, m, t] = [...item.panel!.size].sort((a, b) => b - a);
      return { item, copy, size: [l, t, m] as Vec3 };
    }))
    .sort((a, b) => b.size[0] - a.size[0]);
  const rows: (typeof boards)[] = [];
  for (const b of boards) {
    const row = rows[rows.length - 1];
    const width = row ? row.reduce((w, r) => w + r.size[0] + GAP, 0) : Infinity;
    if (row && width + b.size[0] <= ROW_MAX) row.push(b);
    else rows.push([b]);
  }
  const panels: PlacedPanel[] = [];
  let z = 0;
  for (const row of rows) {
    const depth = Math.max(...row.map((r) => r.size[2]));
    let x = -(row.reduce((w, r) => w + r.size[0], 0) + GAP * (row.length - 1)) / 2;
    for (const r of row) {
      panels.push({ ...r, pos: [x + r.size[0] / 2, r.size[1] / 2, z - depth / 2] });
      x += r.size[0] + GAP;
    }
    z -= depth + GAP;
  }
  const back = z + GAP;
  const panelWidth = Math.max(0, ...rows.map((row) => row.reduce((w, r) => w + r.size[0] + GAP, -GAP)));
  // 철물 칸: 크기는 부품 실제 크기 × HW_SCALE와 개수로 정하고, 왼쪽부터 채우다 넘치면 다음 줄로.
  const sized = items.filter((it) => it.included && it.spec).map((item) => {
    const { long, thick } = hardwareSize(item.spec!);
    const lie = LIE.includes(item.spec!.model);
    const rows = lie ? Math.ceil(item.qty / Math.ceil(item.qty / 6)) : Math.ceil(item.qty / Math.ceil(Math.sqrt(item.qty)));
    const cols = Math.ceil(item.qty / rows);
    const px = long * HW_SCALE * 1.15 + 1;
    const pz = (lie ? thick * 1.8 : long) * HW_SCALE * 1.15 + 1;
    // 칸이 너무 좁으면 아래 이름표가 옆 칸과 겹쳐서 최소 폭을 둔다.
    return { item, cols, rows, px, pz, w: Math.max(cols * px, 30), d: rows * pz };
  });
  const lineMax = Math.max(panelWidth, 160);
  const lines: (typeof sized)[] = [];
  for (const c of sized) {
    const line = lines[lines.length - 1];
    if (line && line.reduce((w, x) => w + x.w + GAP * 2, 0) + c.w <= lineMax) line.push(c);
    else lines.push([c]);
  }
  const cells: PlacedCell[] = [];
  let cz0 = GAP * 1.5;
  for (const line of lines) {
    const depth = Math.max(...line.map((c) => c.d));
    let x = -(line.reduce((w, c) => w + c.w, 0) + GAP * 2 * (line.length - 1)) / 2;
    for (const c of line) {
      cells.push({ ...c, pos: [x + c.w / 2, 0, cz0 + depth / 2] });
      x += c.w + GAP * 2;
    }
    cz0 += depth + GAP * 2.5;
  }
  const front = cells.length ? cz0 - GAP * 2.5 : 0;
  const width = Math.max(panelWidth, ...lines.map((line) => line.reduce((w, c) => w + c.w + GAP * 2, -GAP * 2)));
  const cz = (back + front) / 2;
  const shift = (p: Vec3): Vec3 => [p[0], p[1], p[2] - cz];
  const placedPanels = panels.map((p) => ({ ...p, pos: shift(p.pos) }));
  const placedCells = cells.map((c) => ({ ...c, pos: shift(c.pos) }));
  return {
    panels: placedPanels,
    cells: placedCells,
    labels: [
      ...placedPanels.filter((p) => p.copy === 0).map((p) => ({ item: p.item, pos: [p.pos[0], p.size[1], p.pos[2]] as Vec3 })),
      ...placedCells.map((c) => ({ item: c.item, pos: [c.pos[0], 0, c.pos[2] + c.d / 2 + 2] as Vec3 })),
    ],
    radius: Math.hypot(width / 2, (front - back) / 2),
  };
}

// 내용물을 scale배로 키우고, 바닥(y=0) 위 가운데에 올려 둔다.
function Fitted({ scale, children }: { scale: number; children: ReactNode }) {
  const outer = useRef<THREE.Group>(null);
  const inner = useRef<THREE.Group>(null);
  useLayoutEffect(() => {
    const o = outer.current, i = inner.current;
    if (!o || !i) return;
    i.position.set(0, 0, 0);
    o.scale.setScalar(1);
    o.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(i).applyMatrix4(o.matrixWorld.clone().invert());
    const c = box.getCenter(new THREE.Vector3());
    i.position.set(-c.x, -box.min.y, -c.z);
    o.scale.setScalar(scale);
  }, [scale]);
  return <group ref={outer}><group ref={inner}>{children}</group></group>;
}

// 상자에서 떨어지듯 위에서 내려앉는다. playKey가 바뀌면 다시.
function useDrop(ref: React.RefObject<THREE.Group | null>, delay: number, playKey: number) {
  useEffect(() => {
    const g = ref.current;
    if (!g) return;
    const tween = gsap.fromTo(g.position, { y: 45 }, { y: 0, duration: 0.7, delay, ease: "power3.out" });
    return () => { tween.kill(); g.position.y = 0; };
  }, [ref, delay, playKey]);
}

function LaidPanel({ placed, style, lit, delay, playKey }: {
  placed: PlacedPanel; style: RenderStyle; lit: boolean; delay: number; playKey: number;
}) {
  const ref = useRef<THREE.Group>(null);
  const geometry = useMemo(() => woodBox(placed.size, placed.item.key), [placed.size, placed.item.key]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  useDrop(ref, delay, playKey);
  return (
    <group ref={ref}>
      <mesh geometry={geometry} position={placed.pos} castShadow receiveShadow>
        <Material style={style} color={lit ? HIGHLIGHT : "#ffffff"} wood={!lit} />
        <Edges color={lit ? "#7a2e00" : EDGE[style]} lineWidth={style === "technical" ? 2 : 1} />
      </mesh>
    </group>
  );
}

function hardwareMaterial(style: RenderStyle, color: string, metal: boolean) {
  if (style === "technical") return new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide });
  if (style === "toon") return new THREE.MeshToonMaterial({ color, side: THREE.DoubleSide });
  return new THREE.MeshStandardMaterial({ color, metalness: metal ? 0.7 : 0, roughness: metal ? 0.35 : 0.8, side: THREE.DoubleSide });
}

// 철물 한 종류: 칸 안에 개수만큼 격자로 늘어놓는다. 모든 철물을 같은 배율(HW_SCALE)로 키운다.
function HardwareCell({ placed, style, lit, delay, playKey }: {
  placed: PlacedCell; style: RenderStyle; lit: boolean; delay: number; playKey: number;
}) {
  const ref = useRef<THREE.Group>(null);
  const { item } = placed;
  const spec = item.spec!;
  const color = lit ? HIGHLIGHT : style === "technical" ? "#d9d9d9" : spec.color;
  const material = useMemo(() => hardwareMaterial(style, color, METAL.includes(spec.model)), [style, color, spec.model]);
  const accent = useMemo(() => hardwareMaterial(style, "#2b2b2b", false), [style]);
  useEffect(() => () => { material.dispose(); accent.dispose(); }, [material, accent]);
  useDrop(ref, delay, playKey);
  const { cols, rows, px, pz } = placed;
  const lie = LIE.includes(spec.model);
  return (
    <group ref={ref}>
      <group position={placed.pos}>
        {Array.from({ length: item.qty }, (_, i) => (
          <group key={i} position={[((i % cols) - (cols - 1) / 2) * px, 0, (Math.floor(i / cols) - (rows - 1) / 2) * pz]}>
            <Fitted scale={HW_SCALE}>
              <group rotation={lie ? [0, 0, -Math.PI / 2] : [0, 0, 0]}>
                <HardwareMesh part={spec} material={material} accent={accent} renderOrder={0} />
              </group>
            </Fitted>
          </group>
        ))}
      </group>
    </group>
  );
}

export function PartsLayout({ layout, style, hover, playKey }: {
  layout: Layout; style: RenderStyle; hover: string | null; playKey: number;
}) {
  return (
    <>
      {layout.panels.map((p, i) => (
        <LaidPanel key={`${p.item.key}:${p.copy}`} placed={p} style={style} lit={hover === p.item.key}
          delay={i * 0.05} playKey={playKey} />
      ))}
      {layout.cells.map((c, i) => (
        <HardwareCell key={c.item.key} placed={c} style={style} lit={hover === c.item.key}
          delay={(layout.panels.length + i) * 0.05} playKey={playKey} />
      ))}
    </>
  );
}

// 수량 라벨은 캔버스 밖 DOM에 두고(다른 카드 아래에 깔리도록) 매 프레임 화면 좌표로 옮긴다.
// drei Html은 React 19에서 언마운트할 때 removeChild 오류를 내서 쓰지 않는다.
export type LabelEls = React.RefObject<Map<string, HTMLElement>>;

export function LabelTracker({ layout, els }: { layout: Layout; els: LabelEls }) {
  const v = useMemo(() => new THREE.Vector3(), []);
  useFrame(({ camera, size }) => {
    for (const a of layout.labels) {
      const el = els.current.get(a.item.key);
      if (!el) continue;
      v.set(...a.pos).project(camera);
      el.style.transform = `translate(${((v.x + 1) / 2) * size.width}px, ${((1 - v.y) / 2) * size.height}px) translate(-50%, -50%)`;
      el.style.visibility = v.z < 1 ? "visible" : "hidden";
    }
  });
  return null;
}

export function PartsLabels({ layout, checked, els, onToggle }: {
  layout: Layout; checked: Set<string>; els: LabelEls; onToggle: (key: string) => void;
}) {
  return (
    <div className="lay-labels">
      {layout.labels.map(({ item }) => (
        <button key={item.key} className={`lay-label ${checked.has(item.key) ? "done" : ""}`} onClick={() => onToggle(item.key)}
          ref={(el) => { if (el) els.current.set(item.key, el); else els.current.delete(item.key); }}>
          <b>{item.qty}x</b> {t(item.name)}{checked.has(item.key) && " ✓"}
        </button>
      ))}
    </div>
  );
}

function Thumb({ item }: { item: CheckItem }) {
  if (item.panel) return <PanelThumb size={item.panel.size} still={`check:${item.key}`} />;
  if (item.spec) return <HardwareThumb spec={item.spec} still={`check:hw:${item.key}`} />;
  return <>⚙</>;
}

export function PartsChecklist({ items, checked, page, onToggle, onHover, onAll, onStart, onPage }: {
  items: CheckItem[]; checked: Set<string>; page: number; onToggle: (key: string) => void;
  onHover: (key: string | null) => void; onAll: () => void; onStart: () => void; onPage: () => void;
}) {
  const inBox = items.filter((it) => it.included);
  const extra = items.filter((it) => !it.included);
  const done = inBox.filter((it) => checked.has(it.key)).length;
  const all = done === inBox.length;
  return (
    <section className="overlay card parts checklist" onMouseLeave={() => onHover(null)}>
      <div className="parts-head">
        <h2>{t("상자 속 부품")}</h2>
        <span className="ck-count">{t("{done} / {total}종 확인", { done, total: inBox.length })}</span>
      </div>
      <button className="ck-page" onClick={onPage}>{t("설명서 {n}쪽 부품 그림 보기", { n: page })}</button>
      <p className="ck-scale">{t("바닥의 철물은 실제의 {n}배 크기예요(판재는 실제 크기)", { n: HW_SCALE })}</p>
      <div className="inv-bar" style={{ marginTop: 6 }}><span style={{ width: `${(done / Math.max(inBox.length, 1)) * 100}%` }} /></div>
      <ul className="ck-list">
        {inBox.map((it) => (
          <li key={it.key}>
            <button className={`ck-row ${checked.has(it.key) ? "done" : ""}`} onClick={() => onToggle(it.key)}
              onMouseEnter={() => onHover(it.key)} aria-pressed={checked.has(it.key)}>
              <span className="thumb"><Thumb item={it} /></span>
              <span className="name">{t(it.name)}<code>{it.code}</code></span>
              <b className="qty">{it.qty}x</b>
              <span className="ck-box" aria-hidden>{checked.has(it.key) ? "✓" : ""}</span>
            </button>
          </li>
        ))}
      </ul>
      {extra.length > 0 && (
        <>
          <h2 className="ck-sub">{t("따로 준비할 것")} <small>{t("상자에 없어요")}</small></h2>
          <ul className="ck-extra">
            {extra.map((it) => (
              <li key={it.key}>
                <span className="thumb small"><Thumb item={it} /></span>
                <span className="name">{t(it.name)}{it.qty > 1 && ` ${t("{n}개", { n: it.qty })}`}{it.note && <small>{t(it.note)}</small>}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="ck-actions">
        {!all && <button onClick={onAll}>{t("모두 확인")}</button>}
        <button className="primary" onClick={onStart}>{all ? t("1단계 시작 ›") : t("건너뛰고 시작 ›")}</button>
      </div>
    </section>
  );
}
