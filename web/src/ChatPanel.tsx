import { useEffect, useReducer, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithToolCalls, type UIMessage } from "ai";
import type { Scene } from "./types";
import { chatBus, chatState, goToStep, playExplode, playPartMotion, useCurrentStep, type ChatCommand, type MotionTarget } from "./bridge";
import { hasMention, mentionRe, onMentionPart, partTag, setTaggedParts, type PartTag } from "./partTags";
import { useT, voiceCode } from "./lang";
import ChatActions, { TagText } from "./ChatActions";
import { afterAction } from "./actionEffects";
import { ALL_TAG, PRESETS, runAction as buildRun, withObj, type ActionMeta, type ActionRun } from "./actions";
import { getCompare, setCompare, setProposalDecider, updateCompare, type Decision, type Proposal, type ProposalStatus, type SceneDiff } from "./compare";
import { diffScenes } from "./sceneDiff";
import "./chat.css";

type Op = { op: "replace" | "add" | "remove"; path: string; value?: unknown };
// 액션 바에서 고른 동작. 사용자 메시지 metadata.action으로 붙어 말풍선 위에 "⚡ 이름"으로 보인다.
export type ChatActionMeta = { id: string; label: string; params: Record<string, unknown> };
// 액션 실행 결과. 어시스턴트 메시지의 data-action 파트로 붙어 결과 카드로 보인다.
export type ChatActionResult = { label: string; summary: string; ok: boolean };
// 예시(local) 수정안. 어시스턴트 메시지의 data-proposal 파트로 붙어 수정안 카드로 보인다(AI 수정안은 patch_scene 도구 파트가 카드다).
export type ChatProposalRef = { id: string };
// 메시지 타입(AI SDK 문서 방식): 1) metadata 2) 커스텀 data 파트 3) 도구 입출력.
// metadata.parts는 사용자 메시지에 붙여 보내는 부품 태그. 대화 기록에도 남아 서버가 매번 그 부품 context를 다시 만든다.
// metadata.product는 가구 전체를 가리키는 태그 이름(늘 "ALL": 예시 "@ALL 분해도로…"나 사용자가 직접 쓴 "@ALL"). 칩으로 보이고 서버가 전체 크기·판 목록을 붙인다.
type ChatTools = {
  patch_scene: { input: { summary: string; ops: Op[] }; output: string };
  go_to_step: { input: { number: number }; output: string };
  play_part_motion: { input: MotionTarget; output: string };
  play_explode: { input: Record<string, never>; output: string };
};
type UserMeta = { parts?: PartTag[]; product?: string; action?: ChatActionMeta };
export type ChatMessage = UIMessage<UserMeta, { action: ChatActionResult; proposal: ChatProposalRef }, ChatTools>;
type Part = ChatMessage["parts"][number];

const sameTag = (a: PartTag, b: PartTag) => a.label === b.label && a.instance === b.instance;
// 같은 부품(같은 철물 하나)인지. 예시 태그는 화면 언어로 옮겨진 이름이라 이름 대신 id로 견준다.
const samePart = (a: PartTag, b: PartTag) => a.kind === b.kind && a.id === b.id && a.instance === b.instance;

// 사용자 말풍선에서 "@바닥판"처럼 태그된 부품(과 가구 전체 태그) 이름을 칩으로 보여 준다.
const withTags = (text: string, meta?: UserMeta) =>
  <TagText text={text} labels={[...(meta?.parts ?? []).map((g) => g.label), meta?.product ?? ""]} />;

// JSON Patch(replace/add/remove)를 복사본에 적용한다. 경로가 틀리면 예외를 던진다.
function applyPatch(scene: Scene, ops: Op[]): Scene {
  const next = structuredClone(scene) as any;
  for (const { op, path, value } of ops) {
    const keys = path.split("/").slice(1).map((k) => k.replace(/~1/g, "/").replace(/~0/g, "~"));
    const last = keys.pop();
    if (last === undefined) throw new Error(`잘못된 경로: ${path}`);
    const parent = keys.reduce((o, k) => {
      if (o == null || !(k in o)) throw new Error(`경로 없음: ${path}`);
      return o[k];
    }, next);
    if (Array.isArray(parent)) {
      const i = last === "-" ? parent.length : Number(last);
      if (!Number.isInteger(i) || i < 0 || i > parent.length) throw new Error(`배열 범위 밖: ${path}`);
      if (op === "add") parent.splice(i, 0, value);
      else if (i >= parent.length) throw new Error(`배열 범위 밖: ${path}`);
      else if (op === "remove") parent.splice(i, 1);
      else parent[i] = value;
    } else {
      if (op !== "add" && !(last in parent)) throw new Error(`경로 없음: ${path}`);
      if (op === "remove") delete parent[last];
      else parent[last] = value;
    }
  }
  if (!Array.isArray(next.steps) || next.steps.length === 0) throw new Error("단계가 하나도 남지 않아요.");
  return next;
}

// 수정안 카드의 상태 칩 문구.
const STATUS_LABEL: Record<ProposalStatus, string> = { pending: "검토 중", applied: "적용됨", rejected: "취소됨", undone: "되돌림" };
// 적용 뒤 검토 화면을 닫기까지의 짧은 틈(바뀐 모습을 잠깐 더 보여 준다).
const CLOSE_AFTER_APPLY_MS = 700;
const EMPTY_DIFF: SceneDiff = { entries: [], focusStep: null, changed: { added: [], removed: [], modified: [] } };

// 모델에게 돌려줄 patch_scene 결과. 수정안은 아직 적용 전이라 scene은 그대로다.
const PROPOSED = "수정안을 화면에 띄움(사용자가 적용/취소를 고른다). 함께 보내는 scene은 아직 그대로다. 적용됐다고 단정하지 말고, 무엇이 어떻게 바뀌는지 한두 줄로 알려라.";

// ElevenLabs 에이전트 사이드바처럼 오른쪽에 붙는 채팅. 열리면 3D 뷰어가 왼쪽으로 줄어든다.
export default function ChatPanel({ scene, setScene }: { scene: Scene; setScene: (s: Scene) => void }) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [tags, setTags] = useState<PartTag[]>([]);
  // 되돌리기 기록: 적용한 수정안마다 적용 전 scene. id는 그 수정안(카드 상태를 "되돌림"으로 바꾼다).
  const historyRef = useRef<{ before: Scene; id: string }[]>([]);
  // 수정안(toolCallId 또는 예시 실행 id → 수정안과 그걸 낳은 예시). 카드가 상태를 읽는다. 바뀌면 rerender로 다시 그린다.
  const proposalsRef = useRef(new Map<string, { proposal: Proposal; action: ActionMeta | null }>());
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const playKeyRef = useRef(0);
  const [listening, setListening] = useState(false);
  const step = useCurrentStep();
  const { t, lang } = useT();
  const langRef = useRef(lang);
  langRef.current = lang;
  const sceneRef = useRef(scene);
  const stepRef = useRef(step);
  sceneRef.current = scene;
  stepRef.current = step;
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const caretRef = useRef<number | null>(null);
  // 마지막으로 보낸 AI 예시. 그 대답 안의 patch_scene 수정안에 묶어 두고, [적용]하면 afterAction으로 연출을 잇는다.
  const lastActionRef = useRef<ActionRun["meta"] | null>(null);
  const [mentioned, setMentioned] = useState(0);

  const { messages, sendMessage, addToolOutput, status, stop, error, setMessages, regenerate, clearError } = useChat<ChatMessage>({
    // 글자 단위로 들어오는 스트림마다 다시 그리지 않게 50ms씩 묶는다(문서의 throttle 옵션).
    throttle: 50,
    // 서버 오류 원문은 화면에 내지 않고 콘솔에만 남긴다.
    onError: (e) => console.error("[chat]", e),
    transport: new DefaultChatTransport({
      api: "/api/chat",
      body: () => ({ scene: sceneRef.current, step: stepRef.current?.number, lang: langRef.current }),
    }),
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
    onToolCall({ toolCall }) {
      if (toolCall.dynamic) return;
      if (toolCall.toolName === "patch_scene") {
        const { ops, summary } = toolCall.input as { ops: Op[]; summary?: string };
        try {
          // 바로 적용하지 않고 수정안으로 띄운다. scene은 사용자가 [적용]을 눌러야 바뀐다.
          // 예시(AI 액션)에서 나온 수정이면 적용 뒤 그 액션의 연출을 잇도록 같이 둔다.
          const before = sceneRef.current;
          flowRef.current.propose(toolCall.toolCallId, summary?.trim() || t("도면 수정안"), "ai", before, applyPatch(before, ops), lastActionRef.current);
          addToolOutput({ tool: "patch_scene", toolCallId: toolCall.toolCallId, output: PROPOSED });
        } catch (e) {
          addToolOutput({ tool: "patch_scene", toolCallId: toolCall.toolCallId, output: `적용 실패: ${(e as Error).message}` });
        }
      }
      if (toolCall.toolName === "go_to_step") {
        const { number } = toolCall.input as { number: number };
        goToStep(number);
        addToolOutput({ tool: "go_to_step", toolCallId: toolCall.toolCallId, output: `${number}단계로 이동` });
      }
      if (toolCall.toolName === "play_part_motion") {
        const shown = playPartMotion(toolCall.input as MotionTarget);
        addToolOutput({ tool: "play_part_motion", toolCallId: toolCall.toolCallId,
          output: shown == null ? "모션 재생 실패: 그 부품이 들어가는 단계를 찾지 못함" : `${shown}단계 모션 재생` });
      }
      if (toolCall.toolName === "play_explode") {
        addToolOutput({ tool: "play_explode", toolCallId: toolCall.toolCallId,
          output: playExplode() ? "분해도 재생" : "분해도 재생 실패: 뷰어가 분해도를 틀 수 없음" });
      }
    },
  });

  const busy = status === "submitted" || status === "streaming";

  // ---------- 수정안(Proposal): 띄우기 → 적용 / 취소 / 되돌리기. 계약은 compare.ts ----------
  // 카드 상태를 바꾸고, 뷰어가 그 수정안을 보고 있으면 뷰어 쪽 사본도 바꾼다.
  const setStatus = (id: string, next: ProposalStatus) => {
    const e = proposalsRef.current.get(id);
    if (!e || e.proposal.status === next) return;
    e.proposal = { ...e.proposal, status: next };
    if (getCompare()?.proposal.id === id) updateCompare({ proposal: e.proposal });
    rerender();
  };
  const closeCompare = (id: string) => {
    if (getCompare()?.proposal.id === id) setCompare(null);
  };

  // 수정안 하나를 띄운다. 검토 중인 수정안은 하나뿐이라 앞의 것은 취소된다. 뷰어는 After 쪽으로 열고 변화를 처음부터 튼다.
  const propose = (id: string, summary: string, source: Proposal["source"], before: Scene, after: Scene, action: ActionMeta | null) => {
    for (const e of proposalsRef.current.values()) if (e.proposal.status === "pending") setStatus(e.proposal.id, "rejected");
    let diff = EMPTY_DIFF;
    try { diff = diffScenes(before, after); } catch (err) { console.warn("[diff]", err); }
    const proposal: Proposal = { id, summary, source, before, after, diff, status: "pending" };
    proposalsRef.current.set(id, { proposal, action });
    setCompare({ proposal, mode: "after", playKey: ++playKeyRef.current });
    rerender();
  };

  // 적용된 수정안을 다시 비교해 본다(상태는 그대로 "적용됨").
  const review = (id: string) => {
    const e = proposalsRef.current.get(id);
    if (e) setCompare({ proposal: e.proposal, mode: "after", playKey: ++playKeyRef.current });
  };

  // 되돌리기는 마지막으로 적용한 수정안만 된다(그 뒤에 다른 수정이 쌓였으면 그 위를 덮어 버리므로).
  const canUndo = (id: string) => {
    const e = proposalsRef.current.get(id);
    return !!e && e.proposal.status === "applied" && sceneRef.current === e.proposal.after && historyRef.current.at(-1)?.id === id;
  };

  const decide = (id: string, decision: Decision) => {
    const e = proposalsRef.current.get(id);
    if (!e) return;
    const { proposal } = e;
    if (decision === "apply") {
      if (proposal.status !== "pending") return closeCompare(id);
      // 띄운 뒤 scene이 바뀌었으면(되돌리기 등) 그 위에 덮지 않고 취소한다.
      if (sceneRef.current !== proposal.before) {
        console.warn("[proposal] scene이 바뀌어 적용하지 않음", id);
        setStatus(id, "rejected");
        return closeCompare(id);
      }
      historyRef.current = [...historyRef.current, { before: proposal.before, id }];
      sceneRef.current = proposal.after;
      setScene(proposal.after);
      setStatus(id, "applied");
      // 바뀐 모습을 잠깐 더 보여 준 뒤 검토 화면을 닫고, 실제 뷰어를 바뀐 자리로 옮긴다(예시면 그 연출).
      window.setTimeout(() => {
        if (getCompare()?.proposal.id !== id) return;
        setCompare(null);
        const handled = e.action ? afterAction(e.action, { before: proposal.before, after: proposal.after }) : false;
        if (!handled && proposal.diff.focusStep != null) goToStep(proposal.diff.focusStep);
      }, CLOSE_AFTER_APPLY_MS);
    } else if (decision === "reject") {
      // 적용된 수정안을 다시 보다가 닫는 경우도 여기로 온다. 그때는 닫기만 한다.
      if (proposal.status === "pending") setStatus(id, "rejected");
      closeCompare(id);
    } else {
      if (!canUndo(id)) return;
      historyRef.current = historyRef.current.slice(0, -1);
      sceneRef.current = proposal.before;
      setScene(proposal.before);
      setStatus(id, "undone");
      closeCompare(id);
    }
  };

  // onToolCall과 뷰어의 검토 막대는 처음 만든 함수를 들고 있으므로, 늘 이번 그리기의 함수를 부르게 ref로 잇는다.
  const flowRef = useRef({ propose, decide });
  flowRef.current = { propose, decide };
  useEffect(() => {
    setProposalDecider((id, d) => flowRef.current.decide(id, d));
    return () => setProposalDecider(null);
  }, []);

  // 화면에서 부품을 누르면 입력창 커서 자리에 "@이름 "을 넣는다. 닫혀 있어도 받아야 하니 아래 early return보다 위에 둔다.
  useEffect(() => onMentionPart((tag) => {
    setOpen(true);
    setTags((ts) => ts.some((x) => sameTag(x, tag)) ? ts : [...ts, tag]);
    setInput((text) => {
      const mention = `@${tag.label}`;
      if (hasMention(text, tag.label)) return text;
      const el = inputRef.current;
      const at = Math.min(el?.selectionStart ?? text.length, text.length);
      const before = text.slice(0, at);
      const ins = `${before && !/\s$/.test(before) ? " " : ""}${mention} `;
      const after = text.slice(at).replace(/^ /, "");
      caretRef.current = before.length + ins.length;
      return before + ins + after;
    });
    setMentioned((n) => n + 1);
  }), []);

  // 닫혀 있었으면 입력창이 이번 그리기에서 생기므로, 그린 뒤에 포커스와 커서를 놓는다.
  useEffect(() => {
    const el = inputRef.current;
    if (!mentioned || !el) return;
    el.focus();
    if (caretRef.current != null) el.setSelectionRange(caretRef.current, caretRef.current);
    caretRef.current = null;
  }, [mentioned]);

  // 3D 뷰어가 태그된 부품을 강조하고 이름표를 띄우도록 알린다.
  useEffect(() => setTaggedParts(tags), [tags]);

  useEffect(() => {
    document.body.classList.toggle("chat-open", open);
    if (open) inputRef.current?.focus();
  }, [open]);

  // 사용자가 맨 아래 근처에 있을 때만 따라 내려간다. 위로 올려 기록을 읽는 중이면 끌어내리지 않는다.
  const stickRef = useRef(true);
  const onListScroll = () => {
    const el = listRef.current;
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  useEffect(() => {
    const el = listRef.current;
    // smooth로 굴리면 굴러가는 도중의 scroll 이벤트가 "위에 있음"으로 읽혀 따라가기가 풀린다. 그래서 바로 붙인다.
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, status, error, busy]);

  const send = (text: string) => {
    if (!text.trim() || busy) return;
    if (error) clearError();
    stickRef.current = true;
    lastActionRef.current = null;
    // 사용자가 "@이름"을 지웠으면 그 태그는 빼고 보낸다.
    const parts = tags.filter((g) => hasMention(text, g.label));
    // 사용자가 "@ALL"을 직접 쓰면 가구 전체 태그로 실어 보낸다.
    const all = hasMention(text, ALL_TAG);
    sendMessage({ text: text.trim(), metadata: parts.length || all ? { ...(parts.length ? { parts } : {}), ...(all ? { product: ALL_TAG } : {}) } : undefined });
    setInput("");
    setTags([]);
  };

  // 액션 실행. 바로 바뀌는 것(local)은 여기서 scene을 고치고 대화에 결과 카드만 남기고,
  // 모션은 뷰어에서 틀기만 하고(되돌리기 기록 없음), AI 액션은 metadata.action을 붙여 보내 서버가 정해진 지시로 patch_scene을 부르게 한다.
  const runAction = (run: ActionRun) => {
    if (busy) return;
    if (error) clearError();
    stickRef.current = true;
    lastActionRef.current = run.kind === "ai" ? run.meta : null;
    // 예시 문장 속 "@부품"·"@KALLAX" 태그. 말풍선에서 칩으로 보이고 서버가 그 context를 덧붙인다.
    const tagMeta = { ...(run.tags.parts.length ? { parts: run.tags.parts } : {}), ...(run.tags.product ? { product: run.tags.product } : {}) };
    if (run.kind === "ai") {
      // 입력창에 붙여 둔 부품 태그가 있으면 예시에도 같이 실어 보낸다(같은 부품은 한 번만).
      const live = tags.filter((g) => hasMention(input, g.label) && !run.tags.parts.some((x) => samePart(x, g)));
      const parts = [...run.tags.parts, ...live];
      sendMessage({ text: run.text, metadata: { ...tagMeta, action: run.meta, ...(parts.length ? { parts } : {}) } });
      return;
    }
    let result: ChatActionResult;
    if (run.kind === "explode") {
      result = playExplode()
        ? { label: t(run.meta.label), ok: true, summary: `💥 ${t("분해도를 펼쳤다가 다시 조립해요")}` }
        : { label: t(run.meta.label), ok: false, summary: t("분해도를 틀지 못했어요.") };
    } else if (run.kind === "motion") {
      const shown = playPartMotion(run.target);
      result = shown == null
        ? { label: t(run.meta.label), summary: t("{part} 모션을 틀지 못했어요.", { part: run.part }), ok: false }
        : { label: t(run.meta.label), ok: true, summary: `▶ ${run.hammer
          ? t("{n}단계 · {part} 망치로 박는 모습을 천천히 보여 줘요", { n: shown, part: withObj(run.part) })
          : t("{n}단계에서 {part} 조립 모션을 보여 줘요", { n: shown, part: run.part })}` };
    } else {
      // 바로 고칠 수 있는 예시도 바로 적용하지 않고 수정안으로 띄운다. 대화에는 수정안 카드가 남는다.
      const id = crypto.randomUUID();
      propose(id, run.summary, "action", sceneRef.current, run.next, run.meta);
      setMessages((ms) => [...ms,
        { id: `${id}-u`, role: "user", metadata: { ...tagMeta, action: run.meta }, parts: [{ type: "text", text: run.text }] },
        { id: `${id}-a`, role: "assistant", parts: [{ type: "data-proposal", data: { id } }] },
      ]);
      return;
    }
    const id = crypto.randomUUID();
    setMessages((ms) => [...ms,
      { id: `${id}-u`, role: "user", metadata: { ...tagMeta, action: run.meta }, parts: [{ type: "text", text: run.text }] },
      { id: `${id}-a`, role: "assistant", parts: [{ type: "data-action", data: result }] },
    ]);
  };

  // 칩의 ✕: 태그를 빼고, 같은 이름의 태그가 더 없으면 입력창의 "@이름"도 지운다.
  const removeTag = (tag: PartTag) => {
    const rest = tags.filter((g) => !sameTag(g, tag));
    setTags(rest);
    if (!rest.some((g) => g.label === tag.label)) {
      setInput((text) => text.replace(new RegExp(`${mentionRe(tag.label).source} ?`, "gu"), ""));
    }
    inputRef.current?.focus();
  };

  // 머리의 ↶: 마지막으로 적용한 수정안을 되돌린다. 검토 중인 수정안은 옛 scene 기준이라 먼저 취소한다.
  const undo = () => {
    const last = historyRef.current.at(-1);
    if (!last) return;
    for (const e of proposalsRef.current.values()) if (e.proposal.status === "pending") decide(e.proposal.id, "reject");
    historyRef.current = historyRef.current.slice(0, -1);
    sceneRef.current = last.before;
    setScene(last.before);
    setStatus(last.id, "undone");
    closeCompare(last.id);
    rerender();
  };

  // 새 대화: 카드가 사라지므로 검토 중인 수정안도 취소한다(적용한 것과 되돌리기 기록은 남는다).
  const newChat = () => {
    stop();
    for (const e of proposalsRef.current.values()) if (e.proposal.status === "pending") decide(e.proposal.id, "reject");
    setMessages([]);
  };

  // 음성 입력(STT): 브라우저 내장 음성 인식으로 받아 적고, 말이 끝나면 보낸다. 지원 안 하는 브라우저는 버튼을 숨긴다.
  const Recognition = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
  const recRef = useRef<any>(null);
  const listen = () => {
    if (listening) { recRef.current?.stop(); return; }
    const rec = new Recognition();
    rec.lang = voiceCode();
    rec.interimResults = true;
    let heard = "";
    rec.onresult = (e: any) => {
      heard = Array.from(e.results as ArrayLike<any>).map((r) => r[0].transcript).join("");
      setInput(heard);
    };
    rec.onend = () => { setListening(false); if (heard.trim()) sendRef.current(heard); };
    rec.onerror = () => setListening(false);
    recRef.current = rec;
    rec.start();
    setListening(true);
  };

  // 데모 투어가 보내는 명령. voice는 음성 입력 장면을 재현한다(마이크가 켜진 채 문장이 받아 적히고 보내진다).
  chatState.busy = busy;
  const sendRef = useRef(send);
  const undoRef = useRef(undo);
  const newChatRef = useRef(newChat);
  sendRef.current = send;
  undoRef.current = undo;
  const runActionRef = useRef(runAction);
  runActionRef.current = runAction;
  newChatRef.current = newChat;
  useEffect(() => {
    let alive = true;
    const onCmd = async (e: Event) => {
      const cmd = (e as CustomEvent<ChatCommand>).detail;
      if (cmd.type === "open") setOpen(true);
      if (cmd.type === "close") setOpen(false);
      if (cmd.type === "reset") newChatRef.current();
      if (cmd.type === "undo") undoRef.current();
      if (cmd.type === "preset") {
        const meta = PRESETS.find((m) => m.id === cmd.id);
        setOpen(true);
        if (meta) { try { runActionRef.current(buildRun(sceneRef.current, meta, t)); } catch (err) { console.warn("[preset]", err); } }
      }
      if (cmd.type === "voice") {
        setOpen(true);
        setListening(true);
        for (let i = 1; i <= cmd.text.length && alive; i++) {
          setInput(cmd.text.slice(0, i));
          await new Promise((r) => setTimeout(r, 55));
        }
        setListening(false);
        if (alive) sendRef.current(cmd.text);
      }
    };
    chatBus.addEventListener("cmd", onCmd);
    return () => { alive = false; chatBus.removeEventListener("cmd", onCmd); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 왼쪽 가장자리를 끌어 채팅 폭(--chat-w)을 바꾼다. 320~720px.
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const move = (ev: PointerEvent) =>
      document.documentElement.style.setProperty("--chat-w", `${Math.min(720, Math.max(320, window.innerWidth - ev.clientX))}px`);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("chat-resizing");
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    document.body.classList.add("chat-resizing");
  };

  // 오류 뒤 "다시 시도": 오류 상태를 지우고 마지막 사용자 메시지로 답을 다시 받는다.
  const retry = () => {
    clearError();
    stickRef.current = true;
    regenerate();
  };

  // 요청을 보냈는데 아직 아무것도 안 왔을 때(submitted), 또는 도구 실행 뒤 다음 단계를 기다릴 때 스피너를 띄운다.
  const last = messages[messages.length - 1];
  const lastPart = last?.role === "assistant" ? last.parts[last.parts.length - 1] : undefined;
  const pending = status === "submitted" || (status === "streaming" && (!lastPart || lastPart.type === "step-start"));

  // 도구 파트 상태(input-streaming → input-available → output-available | output-error)마다 카드를 그린다.
  const toolCard = (key: number, icon: React.ReactNode, title: React.ReactNode, note?: React.ReactNode, cls = "") => (
    <div key={key} className={`chat-tool ${cls}`}>
      <span className="chat-tool-icon">{icon}</span>
      <div><b>{title}</b>{note && <small>{note}</small>}</div>
    </div>
  );
  // 멈춤(stop)으로 끊긴 도구 호출은 결과가 영영 안 오므로, 바쁘지 않으면 스피너 대신 "중단됨"으로 둔다.
  const spinOr = () => busy ? <span className="chat-spin" /> : "–";

  // 수정안 카드: 한 줄 요약 + 상태 칩. 검토 중이면 [취소] [적용], 적용됐으면 [다시 보기] [되돌리기]. 바뀐 줄 목록은 두지 않는다(도면 자체가 바뀌는 걸 본다).
  const proposalCard = (key: number, id: string, fallback?: string) => {
    const e = proposalsRef.current.get(id);
    if (!e) return toolCard(key, "✎", fallback || t("도면 수정안"));
    const pr = e.proposal;
    return (
      <div key={key} className={`chat-proposal ${pr.status}`} data-proposal={pr.id} data-status={pr.status}>
        <div className="chat-proposal-head">
          <span className="chat-tool-icon">✎</span>
          <b>{pr.summary}</b>
          <span className={`chat-proposal-chip ${pr.status}`}>{t(STATUS_LABEL[pr.status])}</span>
        </div>
        {pr.status === "pending" && (
          <div className="chat-proposal-btns">
            <button type="button" className="ghost" onClick={() => decide(pr.id, "reject")}>{t("취소")}</button>
            <button type="button" className="primary" onClick={() => decide(pr.id, "apply")}>{t("적용")}</button>
          </div>
        )}
        {pr.status === "applied" && (
          <div className="chat-proposal-btns">
            <button type="button" className="ghost" onClick={() => review(pr.id)}>{t("다시 보기")}</button>
            <button type="button" className="ghost" onClick={() => decide(pr.id, "undo")} disabled={!canUndo(pr.id)}
              title={canUndo(pr.id) ? undefined : t("이 뒤에 적용한 수정을 먼저 되돌려야 해요.")}>{t("되돌리기")}</button>
          </div>
        )}
      </div>
    );
  };

  const renderPart = (p: Part, i: number, m: ChatMessage) => {
    switch (p.type) {
      case "text":
        return (
          <p key={i} className={p.state === "streaming" ? "streaming" : undefined}>
            {m.role === "user" ? withTags(p.text, m.metadata) : p.text}
          </p>
        );
      case "reasoning":
        return (
          // 생각하는 동안에는 펼쳐 실시간으로 보여 주고, 끝나면 접는다.
          <details key={i} className="chat-reason" open={p.state === "streaming"}>
            <summary>{p.state === "streaming" ? t("생각하는 중…") : t("생각 과정")}</summary>
            <pre>{p.text}</pre>
          </details>
        );
      case "tool-patch_scene": {
        // 입력이 흘러들어오는 중에도 summary가 오는 대로 보여 준다.
        const summary = p.input?.summary;
        switch (p.state) {
          case "input-streaming":
            return toolCard(i, spinOr(), summary || t("도면 수정안 작성 중…"), summary ? t("도면 수정안 작성 중…") : busy ? undefined : t("중단됨"), "pending");
          case "input-available":
            return toolCard(i, spinOr(), summary || t("도면 수정 중"), busy ? t("수정안 만드는 중…") : t("중단됨"), "pending");
          case "output-available": {
            const failed = String(p.output).startsWith("적용 실패");
            return failed
              ? toolCard(i, "✕", summary || t("도면 수정 중"), `${t("적용 실패")}: ${String(p.output).replace(/^적용 실패: /, "")}`, "fail")
              : proposalCard(i, p.toolCallId, summary);
          }
          case "output-error":
            return toolCard(i, "✕", summary || t("도면 수정 중"), `${t("적용 실패")}: ${p.errorText}`, "fail");
          default:
            return toolCard(i, "…", summary || t("도면 수정 중"));
        }
      }
      case "tool-go_to_step": {
        // 번호가 아직 안 들어왔으면 "{n}단계로 이동" 대신 빈칸 없는 문구를 쓴다.
        const n = p.input?.number;
        const title = n == null ? t("단계 이동") : t("{n}단계로 이동", { n });
        switch (p.state) {
          case "input-streaming":
          case "input-available":
            return toolCard(i, spinOr(), title, undefined, "pending");
          case "output-error":
            return toolCard(i, "✕", title, `${t("이동 실패")}: ${p.errorText}`, "fail");
          default:
            return toolCard(i, "→", title);
        }
      }
      case "tool-play_part_motion": {
        // 부품 이름은 지금 scene에서 찾는다(입력이 아직 흘러드는 중이면 일반 문구).
        const tag = p.input?.id ? partTag(scene, p.input.id) : null;
        const title = tag ? t("{name} 모션 재생", { name: t(tag.label) }) : t("조립 모션");
        switch (p.state) {
          case "input-streaming":
          case "input-available":
            return toolCard(i, spinOr(), title, busy ? undefined : t("중단됨"), "pending");
          case "output-available": {
            const m = /^(\d+)단계 모션 재생/.exec(String(p.output));
            return m ? toolCard(i, "▶", title, t("{n}단계", { n: m[1] }))
              : toolCard(i, "✕", title, t("모션을 틀지 못했어요."), "fail");
          }
          case "output-error":
            return toolCard(i, "✕", title, `${t("모션을 틀지 못했어요.")} ${p.errorText}`, "fail");
          default:
            return toolCard(i, "▶", title);
        }
      }
      case "tool-play_explode": {
        const title = t("분해도 보기");
        switch (p.state) {
          case "input-streaming":
          case "input-available":
            return toolCard(i, spinOr(), title, busy ? undefined : t("중단됨"), "pending");
          case "output-available":
            return String(p.output).startsWith("분해도 재생 실패")
              ? toolCard(i, "✕", title, t("분해도를 틀지 못했어요."), "fail")
              : toolCard(i, "💥", title, t("분해도를 펼쳤다가 다시 조립해요"));
          case "output-error":
            return toolCard(i, "✕", title, `${t("분해도를 틀지 못했어요.")} ${p.errorText}`, "fail");
          default:
            return toolCard(i, "💥", title);
        }
      }
      case "data-action":
        return toolCard(i, "⚡", p.data.label, p.data.summary, `action ${p.data.ok ? "" : "fail"}`);
      case "data-proposal":
        return proposalCard(i, p.data.id);
      default:
        // step-start(단계 경계)는 도구 호출마다 생겨 시끄러우므로 따로 그리지 않는다.
        return null;
    }
  };

  if (!open) {
    return (
      <button className="chat-launcher" onClick={() => setOpen(true)}>
        <span className="chat-orb small" />
        {t("도면 AI에게 묻기")}
      </button>
    );
  }

  return (
    <aside className="chat-sidebar" aria-label={t("도면 AI 채팅")}
      // 입력 중 ←→·Space가 뷰어 단축키로 새지 않게 막는다.
      onKeyDown={(e) => e.stopPropagation()}>
      <div className="chat-resize" onPointerDown={startResize} title={t("끌어서 폭 바꾸기")} />
      <header className="chat-head">
        <span className="chat-orb" />
        <div className="chat-title">
          <b>{t("도면 어시스턴트")}</b>
          <span>{scene.product}{step ? ` · ${step.number === 0 ? t("부품 확인") : t("{n}단계 보는 중", { n: step.number })}` : ""}</span>
        </div>
        <button className="chat-btn" onClick={undo} disabled={!historyRef.current.length} title={t("마지막 수정 되돌리기")}>↶</button>
        <button className="chat-btn" onClick={newChat} title={t("새 대화")}>⟲</button>
        <button className="chat-btn" onClick={() => setOpen(false)} aria-label={t("닫기")}>✕</button>
      </header>

      <div className="chat-list" ref={listRef} onScroll={onListScroll} aria-busy={busy}>
        {messages.length === 0 && (
          <div className="chat-empty">
            <span className="chat-orb large" />
            <p>{t("설명서 내용을 묻거나, 바꾸고 싶은 걸 말해 보세요.")}<br />{t("바꿀 내용은 먼저 도면에 Before/After로 보여 드려요. 적용을 눌러야 반영돼요.")}</p>
            <p className="chat-hint">{t("화면에서 부품을 누르면 @태그로 넣을 수 있어요.")}</p>
            <ChatActions scene={scene} busy={busy} onRun={runAction} />
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`chat-msg ${m.role}`}>
            {m.role === "user" && m.metadata?.action && <span className="chat-action-tag">⚡ {t(m.metadata.action.label)}</span>}
            {m.parts.map((p, i) => renderPart(p, i, m))}
          </div>
        ))}
        {pending && (
          <div className="chat-msg assistant chat-pending" role="status">
            <span className="chat-spin" /><span>{t("답을 준비하는 중…")}</span>
          </div>
        )}
        {error && (
          <div className="chat-error" role="alert">
            <span>{t("오류")}: {t("답을 받지 못했어요. 잠시 뒤 다시 시도해 주세요.")}</span>
            <button type="button" onClick={retry}>{t("다시 시도")}</button>
          </div>
        )}
      </div>

      {messages.length > 0 && <ChatActions scene={scene} busy={busy} compact onRun={runAction} />}
      {tags.length > 0 && (
        <div className="chat-tags" aria-label={t("붙인 부품")}>
          {tags.map((g) => (
            <span key={`${g.label}|${g.instance ?? ""}`} className="chat-tag" title={g.instance ?? g.id}>
              @{g.label}
              <button type="button" onClick={() => removeTag(g)} aria-label={t("태그 빼기")}>✕</button>
            </span>
          ))}
        </div>
      )}
      <form className="chat-input" onSubmit={(e) => { e.preventDefault(); send(input); }}>
        <textarea ref={inputRef} rows={1} value={input} placeholder={t("메시지를 입력하세요…")}
          onChange={(e) => {
            const text = e.target.value;
            setInput(text);
            // "@이름"을 글에서 지우면 칩과 3D 강조도 같이 뺀다.
            setTags((ts) => ts.every((g) => hasMention(text, g.label)) ? ts : ts.filter((g) => hasMention(text, g.label)));
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(input); }
          }} />
        {Recognition && (
          <button type="button" className={`chat-mic ${listening ? "on" : ""}`} onClick={listen} disabled={busy}
            aria-pressed={listening} title={t(listening ? "듣는 중… 누르면 멈춰요" : "말로 묻기")}>
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden>
              <rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
            </svg>
          </button>
        )}
        {busy
          ? <button type="button" className="chat-send" onClick={stop} aria-label={t("멈춤")}>■</button>
          : <button type="submit" className="chat-send" disabled={!input.trim()} aria-label={t("보내기")}>↑</button>}
      </form>
    </aside>
  );
}
