import { useEffect, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithToolCalls } from "ai";
import type { Scene } from "./types";
import { goToStep, useCurrentStep } from "./bridge";
import { useT } from "./lang";
import "./chat.css";

type Op = { op: "replace" | "add" | "remove"; path: string; value?: unknown };

const SUGGESTIONS = [
  "지금 단계 설명을 더 쉽게 바꿔 줘",
  "선반 판을 2cm 더 두껍게 해 줘",
  "전체 조립 순서를 요약해 줘",
  "이 단계에 주의 문구를 넣어 줘",
];

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

// ElevenLabs 에이전트 사이드바처럼 오른쪽에 붙는 채팅. 열리면 3D 뷰어가 왼쪽으로 줄어든다.
export default function ChatPanel({ scene, setScene }: { scene: Scene; setScene: (s: Scene) => void }) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<Scene[]>([]);
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

  const { messages, sendMessage, addToolOutput, status, stop, error, setMessages } = useChat({
    transport: new DefaultChatTransport({
      api: "/api/chat",
      body: () => ({ scene: sceneRef.current, step: stepRef.current?.number, lang: langRef.current }),
    }),
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
    onToolCall({ toolCall }) {
      if (toolCall.dynamic) return;
      if (toolCall.toolName === "patch_scene") {
        const { ops } = toolCall.input as { ops: Op[] };
        try {
          const next = applyPatch(sceneRef.current, ops);
          setHistory((h) => [...h, sceneRef.current]);
          sceneRef.current = next;
          setScene(next);
          addToolOutput({ tool: "patch_scene", toolCallId: toolCall.toolCallId, output: `적용 완료(${ops.length}건). 함께 보내는 scene에 이미 반영됨.` });
        } catch (e) {
          addToolOutput({ tool: "patch_scene", toolCallId: toolCall.toolCallId, output: `적용 실패: ${(e as Error).message}` });
        }
      }
      if (toolCall.toolName === "go_to_step") {
        const { number } = toolCall.input as { number: number };
        goToStep(number);
        addToolOutput({ tool: "go_to_step", toolCallId: toolCall.toolCallId, output: `${number}단계로 이동` });
      }
    },
  });

  const busy = status === "submitted" || status === "streaming";

  useEffect(() => {
    document.body.classList.toggle("chat-open", open);
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const send = (text: string) => {
    if (!text.trim() || busy) return;
    sendMessage({ text: text.trim() });
    setInput("");
  };

  const undo = () => {
    const prev = history[history.length - 1];
    if (!prev) return;
    setHistory((h) => h.slice(0, -1));
    setScene(prev);
  };

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
          <span>{scene.product}{step ? ` · ${t("{n}단계 보는 중", { n: step.number })}` : ""}</span>
        </div>
        <button className="chat-btn" onClick={undo} disabled={!history.length || busy} title={t("마지막 수정 되돌리기")}>↶</button>
        <button className="chat-btn" onClick={() => { stop(); setMessages([]); }} title={t("새 대화")}>⟲</button>
        <button className="chat-btn" onClick={() => setOpen(false)} aria-label={t("닫기")}>✕</button>
      </header>

      <div className="chat-list" ref={listRef}>
        {messages.length === 0 && (
          <div className="chat-empty">
            <span className="chat-orb large" />
            <p>{t("설명서 내용을 묻거나, 바꾸고 싶은 걸 말해 보세요.")}<br />{t("바꾼 내용은 도면에 바로 반영돼요.")}</p>
            <div className="chat-suggest">
              {SUGGESTIONS.map((s) => <button key={s} onClick={() => send(t(s))}>{t(s)}</button>)}
            </div>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`chat-msg ${m.role}`}>
            {m.parts.map((p, i) => {
              if (p.type === "text") return <p key={i}>{p.text}</p>;
              if (p.type === "tool-patch_scene") {
                const input = p.input as { summary?: string; ops?: Op[] } | undefined;
                const failed = p.state === "output-available" && String(p.output).startsWith("적용 실패");
                return (
                  <div key={i} className={`chat-tool ${failed ? "fail" : ""}`}>
                    <span>{p.state === "output-available" ? (failed ? "✕" : "✓") : "…"}</span>
                    <div>
                      <b>{input?.summary ?? t("도면 수정 중")}</b>
                      {p.state === "output-available" && <small>{failed ? `${t("적용 실패")}: ${String(p.output).replace(/^적용 실패: /, "")}` : t("적용 완료")}</small>}
                    </div>
                  </div>
                );
              }
              if (p.type === "tool-go_to_step") {
                const input = p.input as { number?: number } | undefined;
                return <div key={i} className="chat-tool"><span>→</span><b>{t("{n}단계로 이동", { n: input?.number ?? "" })}</b></div>;
              }
              return null;
            })}
          </div>
        ))}
        {status === "submitted" && <div className="chat-msg assistant"><span className="chat-typing"><i /><i /><i /></span></div>}
        {error && <div className="chat-error">{t("오류")}: {error.message}</div>}
      </div>

      <form className="chat-input" onSubmit={(e) => { e.preventDefault(); send(input); }}>
        <textarea ref={inputRef} rows={1} value={input} placeholder={t("메시지를 입력하세요…")}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(input); }
          }} />
        {busy
          ? <button type="button" className="chat-send" onClick={stop} aria-label={t("멈춤")}>■</button>
          : <button type="submit" className="chat-send" disabled={!input.trim()} aria-label={t("보내기")}>↑</button>}
      </form>
    </aside>
  );
}
