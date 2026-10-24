import { useMemo, useState } from "react";
import type { Scene } from "./types";

// 가구 뷰어 부품 카드의 '현황' 보기: 지금 단계까지 쓴 부품과 남은 부품을 수량으로 보여 준다.
// 공구(육각 렌치)는 소모되지 않으므로 합산하지 않고 한 번만 센다.

interface Item {
  key: string;
  name: string;
  code: string;
  color: string;
  total: number;
  used: number;
  nextStep: number | null; // 남은 부품이 다음에 쓰이는 단계 번호
  nextIndex: number | null;
}

const PANEL_COLOR = "#e9dcc6";

function inventory(scene: Scene, stepIndex: number): Item[] {
  const items = new Map<string, Item>();
  const add = (key: string, name: string, code: string, color: string, qty: number, i: number, tool: boolean) => {
    const item = items.get(key) ?? { key, name, code, color, total: 0, used: 0, nextStep: null, nextIndex: null };
    item.total = tool ? Math.max(item.total, qty) : item.total + qty;
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
      add(id, panel?.name_ko ?? id, "", PANEL_COLOR, 1, i, false);
    });
    step.uses.forEach((u) => {
      const spec = scene.hardware?.[u.part_id];
      add(u.part_id, u.name_ko, u.part_id, spec?.color ?? "#9ca3af", u.qty, i, spec?.model === "hex_key");
    });
  });
  return [...items.values()];
}

export default function PartsInventory({ scene, stepIndex, onJump }: {
  scene: Scene; stepIndex: number; onJump: (index: number) => void;
}) {
  const [tab, setTab] = useState<"used" | "left">("used");
  const items = useMemo(() => inventory(scene, stepIndex), [scene, stepIndex]);
  const totalQty = items.reduce((n, it) => n + it.total, 0);
  const usedQty = items.reduce((n, it) => n + it.used, 0);
  const used = items.filter((it) => it.used > 0);
  const left = items.filter((it) => it.total > it.used);
  const list = tab === "used" ? used : left;

  return (
    <div className="inventory">
      <div className="inv-progress">
        <div className="bar"><span style={{ width: `${(usedQty / Math.max(totalQty, 1)) * 100}%` }} /></div>
        <small>{usedQty} / {totalQty}개 사용 · {stepIndex + 1}단계까지</small>
      </div>
      <div className="inv-tabs">
        <button className={tab === "used" ? "on" : ""} onClick={() => setTab("used")}>사용함 {used.length}종</button>
        <button className={tab === "left" ? "on" : ""} onClick={() => setTab("left")}>남음 {left.length}종</button>
      </div>
      <ul>
        {list.map((it) => {
          const count = tab === "used" ? it.used : it.total - it.used;
          return (
            <li key={it.key}>
              <span className="swatch" style={{ background: it.color }} />
              <span className="name">
                {it.name}
                {it.code && <code>{it.code}</code>}
              </span>
              <span className="count">
                <b>{count}개</b>
                {tab === "used" && it.total > it.used && <small>{it.total - it.used}개 남음</small>}
                {tab === "left" && it.nextIndex !== null && (
                  <button className="next" onClick={() => onJump(it.nextIndex!)}>{it.nextStep}단계 ›</button>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      {list.length === 0 && <p className="muted">{tab === "used" ? "아직 쓴 부품이 없어요." : "남은 부품이 없어요. 다 썼어요!"}</p>}
    </div>
  );
}
