// 채팅의 예시 문장 버튼. 값이 미리 정해진 대표 액션(PRESETS)을 실제로 부품을 태그해 지시한 말처럼 보여 주고, 누르면 바로 실행한다
// (바로 고치는 것은 그 자리에서 수정안을 띄우고, AI가 고치는 것은 보내서 AI가 수정안을 띄운다).
// 빈 대화에서는 세로 프롬프트 카드(full), 대화 중에는 입력창 위 가로 칩(compact)으로 보인다.
import type { Scene } from "./types";
import { useT } from "./lang";
import { PRESETS, actionKind, actionTags, actionText, invalidParams, runAction, type ActionId, type ActionRun } from "./actions";
import "./actions.css";

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// 글 속 "@이름"(labels에 있는 것만)을 태그 칩으로 그린다. 사용자 말풍선과 예시 버튼이 같이 쓴다.
// 긴 이름부터 맞춰 "@나무못(2단계 1번)"이 "@나무못"으로 잘리지 않게 한다.
export function TagText({ text, labels }: { text: string; labels: string[] }) {
  const ls = [...new Set(labels.filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!ls.length) return <>{text}</>;
  return <>{text.split(new RegExp(`(@(?:${ls.map(escapeRe).join("|")}))`)).map((s, i) =>
    i % 2 ? <span key={i} className="chat-tag">{s}</span> : s)}</>;
}

// 액션마다 작은 선 아이콘.
const ICONS: Record<ActionId, React.JSX.Element> = {
  part_motion: <><circle cx="12" cy="12" r="9" /><path d="m10 8.5 5 3.5-5 3.5z" /></>,
  explode_view: <><rect x="2.5" y="2.5" width="7" height="7" rx="1" /><rect x="14.5" y="2.5" width="7" height="7" rx="1" /><rect x="2.5" y="14.5" width="7" height="7" rx="1" /><rect x="14.5" y="14.5" width="7" height="7" rx="1" /></>,
  panel_thickness: <><rect x="3" y="9" width="18" height="6" rx="1" /><path d="M12 3v4M10 5l2 2 2-2M12 21v-4M10 19l2-2 2 2" /></>,
  panel_move: <><rect x="3" y="13" width="18" height="5" rx="1" /><path d="M12 10V3M9 6l3-3 3 3" /></>,
  hardware_qty: <><circle cx="8" cy="8" r="3" /><path d="M8 11v9M17 13v6M14 16h6" /></>,
  merge_steps: <><rect x="3" y="4" width="7" height="7" rx="1" /><rect x="3" y="13" width="7" height="7" rx="1" /><path d="M10 7.5h4l3 4.5-3 4.5h-4M17 12h4" /></>,
  add_warning: <><path d="M12 3 2 20h20L12 3z" /><path d="M12 10v4M12 17v.5" /></>,
  simplify_caption: <><path d="M4 6h16M4 11h10M4 16h7" /><path d="m15 18 2 2 4-5" /></>,
};
const Icon = ({ id }: { id: ActionId }) => (
  <svg className="act-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {ICONS[id]}
  </svg>
);

export default function ChatActions({ scene, busy, compact, onRun }: { scene: Scene; busy: boolean; compact?: boolean; onRun: (run: ActionRun) => void }) {
  const { t } = useT();
  return (
    <div className={`act-wrap ${compact ? "compact" : "full"}`}>
      {!compact && <div className="act-head">{t("이렇게 말해 보세요")}</div>}
      <div className={compact ? "act-row" : "act-list"} role="toolbar" aria-label={t("예시 문장")}>
        {PRESETS.map((meta) => {
          // 문장과 태그는 지금 scene으로 만들고, 수정 뒤 더는 맞지 않으면 흐리게 두고 까닭은 툴팁으로만 띄운다.
          const why = invalidParams(scene, meta);
          const tags = actionTags(scene, meta, t);
          const text = actionText(scene, meta, t, tags);
          // 종류(local·ai·motion)는 아이콘 색으로만 구분한다.
          const kind = actionKind(meta);
          const labels = [...tags.parts.map((g) => g.label), tags.product ?? ""];
          return (
            <button key={meta.id} type="button" className={`${compact ? "act-chip" : "act-card"} ${kind}`}
              disabled={busy || !!why} title={why ? t(why) : text}
              onClick={() => { try { onRun(runAction(scene, meta, t)); } catch (e) { console.warn("[action]", e); } }}>
              <span className="act-badge"><Icon id={meta.id} /></span>
              {compact
                ? <span className="act-label"><TagText text={text} labels={labels} /></span>
                : <span className="act-body"><span className="act-label"><TagText text={text} labels={labels} /></span></span>}
              {!compact && <span className="act-go" aria-hidden>↑</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
