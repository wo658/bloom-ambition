import { useEffect, useMemo } from "react";
import { HardwareThumb, PanelThumb } from "./PartThumb";
import { TOOLS } from "./Hardware";
import type { HardwareSpec, Panel, Scene } from "./types";
import { t } from "./lang";

// 부품 현황 팝업: 지금 단계까지 쓴 부품과 아직 남은 부품을 좌우로 나눠, IKEA 설명서 부품 페이지처럼
// 그림 · 수량(N x) · 이름 · 부품 번호를 카드로 보여 준다.
// 공구(육각 렌치)는 소모되지 않으므로 합산하지 않고 한 번만 센다.

interface Item {
  key: string;
  name: string;
  code: string;
  panel?: Panel;
  spec?: HardwareSpec;
  total: number;
  used: number;
  now: number; // 지금 단계에서 쓰는 수량
  nextStep: number | null; // 남은 부품이 다음에 쓰이는 단계 번호
  nextIndex: number | null;
}

function inventory(scene: Scene, stepIndex: number): Item[] {
  const items = new Map<string, Item>();
  const add = (key: string, base: Pick<Item, "name" | "code" | "panel" | "spec">, qty: number, i: number, tool: boolean) => {
    const item = items.get(key) ?? { key, ...base, total: 0, used: 0, now: 0, nextStep: null, nextIndex: null };
    item.total = tool ? Math.max(item.total, qty) : item.total + qty;
    if (i === stepIndex) item.now = tool ? Math.max(item.now, qty) : item.now + qty;
    if (i <= stepIndex) item.used = tool ? Math.max(item.used, qty) : item.used + qty;
    else if (item.nextIndex === null && (!tool || item.used === 0)) {
      item.nextIndex = i;
      item.nextStep = scene.steps[i].number;
    }
    items.set(key, item);
  };
  scene.steps.forEach((step, i) => {
    step.adds.forEach((id) => {
      const panel = scene.panels.find((p) => p.id === id);
      add(id, { name: panel?.name_ko ?? id, code: "", panel }, 1, i, false);
    });
    step.uses.forEach((u) => {
      const spec = scene.hardware?.[u.part_id];
      add(u.part_id, { name: u.name_ko, code: u.part_id, spec }, u.qty, i, !!spec && TOOLS.includes(spec.model));
    });
  });
  return [...items.values()];
}

function dims(panel: Panel) {
  return [...panel.size].sort((a, b) => b - a).map((v) => +v.toFixed(1)).join(" × ") + " cm";
}

function PartCard({ item, count, kind, onJump }: {
  item: Item; count: number; kind: "used" | "left"; onJump: (index: number) => void;
}) {
  const sub = item.code || (item.panel ? dims(item.panel) : "");
  return (
    <li className={`pcard ${kind} ${kind === "used" && item.now > 0 ? "now" : ""}`}>
      <div className="pcard-img">
        {item.panel ? <PanelThumb size={item.panel.size} still={`panel:${item.key}`} />
          : item.spec ? <HardwareThumb spec={item.spec} still={`hw:${item.key}`} /> : <span className="none">⚙</span>}
        {kind === "used" && item.now > 0 && <span className="tag">{t("이 단계")}</span>}
        {kind === "used" && item.used >= item.total && <span className="done" aria-label={t("모두 사용")}>✓</span>}
      </div>
      <b className="pcard-qty">{count}x</b>
      <span className="pcard-name">{t(item.name)}</span>
      {sub && <code className="pcard-code">{sub}</code>}
      {kind === "used" && item.total > item.used && <small className="pcard-note">{t("{n}개 남음", { n: item.total - item.used })}</small>}
      {kind === "left" && item.nextIndex !== null && (
        <button className="pcard-next" onClick={() => onJump(item.nextIndex!)}>{t("{n}단계에서 사용", { n: item.nextStep ?? "" })} ›</button>
      )}
    </li>
  );
}

export default function PartsInventory({ scene, stepIndex, onJump, onClose }: {
  scene: Scene; stepIndex: number; onJump: (index: number) => void; onClose: () => void;
}) {
  const items = useMemo(() => inventory(scene, stepIndex), [scene, stepIndex]);
  const totalQty = items.reduce((n, it) => n + it.total, 0);
  const usedQty = items.reduce((n, it) => n + it.used, 0);
  // 이 단계에서 쓴 부품을 맨 앞에, 남은 부품은 먼저 쓰이는 순서대로.
  const used = items.filter((it) => it.used > 0).sort((a, b) => b.now - a.now);
  const left = items.filter((it) => it.total > it.used).sort((a, b) => (a.nextIndex ?? 1e9) - (b.nextIndex ?? 1e9));
  const pct = Math.round((usedQty / Math.max(totalQty, 1)) * 100);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="inv-backdrop" onClick={onClose}>
      <div className="inv-modal" role="dialog" aria-label={t("부품 현황")} onClick={(e) => e.stopPropagation()}>
        <header className="inv-head">
          <div>
            <h2>{t("부품 현황")}</h2>
            <small>{t("{n}단계까지 · {used} / {total}개 사용 ({pct}%)", { n: scene.steps[stepIndex].number, used: usedQty, total: totalQty, pct })}</small>
          </div>
          <button className="icon" onClick={onClose} aria-label={t("닫기")}>✕</button>
        </header>
        <div className="inv-bar"><span style={{ width: `${pct}%` }} /></div>
        <div className="inv-cols">
          <section className="inv-col used">
            <h3>{t("사용한 부품")} <span>{t("{k}종 · {n}개", { k: used.length, n: used.reduce((n, it) => n + it.used, 0) })}</span></h3>
            {used.length === 0 ? <p className="muted">{t("아직 쓴 부품이 없어요.")}</p> : (
              <ul className="pgrid">
                {used.map((it) => <PartCard key={it.key} item={it} count={it.used} kind="used" onJump={onJump} />)}
              </ul>
            )}
          </section>
          <section className="inv-col left">
            <h3>{t("남은 부품")} <span>{t("{k}종 · {n}개", { k: left.length, n: left.reduce((n, it) => n + it.total - it.used, 0) })}</span></h3>
            {left.length === 0 ? <p className="muted">{t("남은 부품이 없어요. 다 썼어요!")}</p> : (
              <ul className="pgrid">
                {left.map((it) => <PartCard key={it.key} item={it} count={it.total - it.used} kind="left" onJump={onJump} />)}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
