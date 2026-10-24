// 채팅 API(/api/chat). 배포(Vercel Function)에서는 이 파일이 그대로 /api/chat이 되고,
// 개발 서버(server/chat.ts)도 같은 chatStream을 쓴다.
// 브라우저가 지금 scene.json을 같이 보내고, 모델은 patch_scene 도구로 수정안을 돌려준다. 브라우저(ChatPanel)는 그걸 바로 적용하지 않고
// Before/After 수정안으로 띄우며, 사용자가 [적용]을 눌러야 scene이 바뀐다.
import { createAnthropic } from "@ai-sdk/anthropic";
import { convertToModelMessages, createUIMessageStreamResponse, smoothStream, streamText, toUIMessageStream, type ToolCallRepairFunction, type UIMessage } from "ai";
import { z } from "zod";
// Vercel Function은 ESM으로 따로 컴파일되므로 상대 경로에 .js를 붙인다(타입 검사·Vite는 .ts로 찾아 준다).
import { partContext, type PartTag } from "../src/partTags.js";
import { actionInstruction, productContext, type ActionMeta } from "../src/actions.js";
import type { Scene } from "../src/types";

const SYSTEM = `너는 가구 조립 설명서 3D 뷰어의 편집 도우미다. 화면의 도면은 아래 scene JSON 하나로 그려진다.
사용자가 바꿔 달라고 하면 patch_scene 도구로 JSON Patch(RFC 6902: replace/add/remove, JSON Pointer 경로)를 보내라.
patch_scene은 바로 적용되지 않는다. 화면에 수정안(도면이 Before → After로 바뀌는 모습)으로 뜨고, 사용자가 [적용]이나 [취소]를 고른다.

scene 구조(단위 cm, 좌표는 가구 기준 x=좌우, y=위, z=앞뒤):
- panels[]: 판재. id, name_ko, size[가로,높이,깊이], pos(조립 후 중심 위치), from(등장할 때 pos에서 떨어져 있는 거리)
- steps[]: 단계. number, page(원본 쪽), caption_ko(설명, 문장마다 줄바꿈), warning_ko, confidence(0~1),
  adds[](이 단계에 붙는 panel id), uses[](필요한 철물 part_id·qty·name_ko), small[](철물 배치), pose("lying"|"upright"), wall
- hardware: 철물 모양 사양, safety_ko[]: 안전 문구

규칙:
- 바꿀 것은 한 번의 patch_scene 호출에 모두 담는다. 경로의 배열 번호는 0부터다(steps[0]이 1단계).
- 판 치수를 바꾸면 맞닿는 판의 pos도 같이 맞춰 겹치거나 뜨지 않게 한다.
- 특정 단계를 보여 주는 게 도움이 되면 go_to_step을 쓴다.
- "~ 조립하는 모습 보여 줘", "~ 박는 모션", "어떻게 끼워?"처럼 부품 하나가 들어가는 모습을 보고 싶어 하면 play_part_motion을 쓴다(도면은 바꾸지 않는다). 판재는 kind "panel"과 panel id, 철물은 kind "hardware"와 part_id를 넣고, [이 메시지가 가리키는 부품]에 화면에서 누른 철물 하나(small id)가 있으면 instance에 그 id를 넣는다. 결과가 "N단계 모션 재생"이면 N단계에서 보여 주고 있다고 짧게 알린다.
- "분해도 보여 줘", "펼쳐 보여 줘", "전체가 어떻게 맞물려?"처럼 가구 전체가 어떻게 나뉘고 맞물리는지 보고 싶어 하면 play_explode를 쓴다(도면은 바꾸지 않는다). 결과가 "분해도 재생"이면 판을 펼쳤다가 다시 조립하는 모습을 보여 주고 있다고 짧게 알린다.
- 아래 scene은 항상 실제(적용된) 상태다. 검토 중이거나 취소된 수정안은 들어 있지 않다. 예전 수정안이 적용됐는지는 scene으로 판단한다.
- patch_scene 결과가 "수정안을 화면에 띄움"이면 다시 보내지 않는다. 적용됐다고 단정하지 말고("바꿨어요" 대신 "바뀌어요"), 무엇이 어떻게 바뀌는지 한두 줄로 알린다. 수정안 하나에는 요청한 것을 모두 담는다(새로 보내면 앞의 수정안은 취소된다).
- 사용자 메시지에는 "@바닥판"처럼 화면에서 누른 부품 태그가 들어 있을 수 있다. 그 메시지 끝의 [이 메시지가 가리키는 부품]에 태그마다 id와 JSON 경로가 있으니, "이거", "여기" 같은 말도 그 부품을 가리킨다고 보고 정확히 그 부품에만 적용한다. 철물 하나를 눌렀다고(사용자가 화면에서 누른 것) 나오면 같은 철물 전체가 아니라 그 하나(small 항목)에 적용한다.
- 사용자 메시지 끝에 [액션 지시]가 있으면 화면의 액션 버튼으로 고른 정해진 작업이다. 지시에 적힌 값 그대로, 한 번의 patch_scene 수정안에 빠짐없이 담는다. 따라 바뀌어야 할 값(맞닿는 판의 pos·size, small[] 철물 배치, caption_ko·warning_ko 속 개수, 부품 목록 개수)도 계산해 함께 맞춘다. 지시 밖의 다른 것은 바꾸지 않는다.
- [액션 지시 — 수정안 보냄]이 붙은 지시는 이미 patch_scene 수정안을 보낸 것이다. 다시 보내지 않는다.
- 질문에는 scene을 근거로 짧게 한국어 평문으로 답한다(마크다운 기호 없이). 수정안을 보낸 뒤에는 무엇이 어떻게 바뀌는지 한두 줄로 알린다.`;

const tools = {
  patch_scene: {
    description: "scene JSON에 적용할 JSON Patch를 수정안으로 보낸다. 화면에 Before/After로 뜨고, 사용자가 [적용]을 눌러야 도면이 바뀐다.",
    inputSchema: z.object({
      summary: z.string().describe("사용자에게 보여 줄 한 줄 요약"),
      ops: z.array(z.object({
        op: z.enum(["replace", "add", "remove"]),
        path: z.string().describe("JSON Pointer, 예: /steps/2/caption_ko"),
        value: z.any().optional(),
      })),
    }),
  },
  go_to_step: {
    description: "뷰어를 해당 단계(화면에 보이는 단계 번호)로 옮긴다.",
    inputSchema: z.object({ number: z.number().int() }),
  },
  play_part_motion: {
    description: "부품 하나가 조립되는 모습(조립 모션)을 뷰어에서 보여 준다. 그 부품이 들어가는 단계로 옮겨 카메라를 맞추고 조립 애니메이션을 다시 튼다. \"~ 조립하는 모습/모션 보여 줘\", \"~ 박는 모습 보여 줘\" 같은 요청에 쓴다. 도면(scene)은 바꾸지 않는다.",
    inputSchema: z.object({
      kind: z.enum(["panel", "hardware"]).describe("판재면 panel, 철물이면 hardware"),
      id: z.string().describe("판재 id(panels[].id) 또는 철물 part_id(steps[].uses[].part_id)"),
      instance: z.string().optional().describe("사용자가 화면에서 누른 철물 하나의 steps[].small[].id(예: s2-101339-0). 없으면 생략"),
    }),
  },
  play_explode: {
    description: "완성된 가구 전체의 분해도를 뷰어에서 보여 준다. 판마다 바깥쪽으로 펼쳤다가 다시 맞물리게 조립하는 애니메이션이다. \"분해도 보여 줘\", \"펼쳐 보여 줘\" 같은 요청에 쓴다. 도면(scene)은 바꾸지 않는다.",
    inputSchema: z.object({}),
  },
};

export type ChatBody = { messages: UIMessage[]; scene: unknown; step?: number; lang?: string };

// 사용자 메시지 metadata(ChatPanel의 ChatMessage와 같은 모양).
type Meta = { parts?: PartTag[]; product?: string; action?: ActionMeta } | undefined;

// 부품 태그(metadata.parts)가 붙은 사용자 메시지에는 그 부품 context를 글로 덧붙인다. 가구 전체 태그(metadata.product, 예: @KALLAX)는
// 전체 크기와 판 목록을 붙인다. 예전 메시지도 지금 scene으로 다시 만들어 경로·치수가 항상 최신이다.
function withPartContext(messages: UIMessage[], scene: unknown): UIMessage[] {
  return messages.map((m) => {
    const meta = m.metadata as Meta;
    const tags = Array.isArray(meta?.parts) ? meta.parts : [];
    const product = typeof meta?.product === "string" ? meta.product : "";
    if (m.role !== "user" || (!tags.length && !product)) return m;
    let text: string;
    try {
      text = [...(product ? [productContext(scene as Scene, product)] : []), ...tags.map((g) => partContext(scene as Scene, g))].join("\n");
    } catch {
      text = [...(product ? [`@${product}: 가구 전체`] : []), ...tags.map((g) => `@${g.label}: ${g.kind} id=${g.id}${g.instance ? `, 누른 것 ${g.instance}` : ""}`)].join("\n");
    }
    return { ...m, parts: [...m.parts, { type: "text", text: `[이 메시지가 가리키는 부품]\n${text}` }] };
  });
}

// 액션(metadata.action)이 붙은 사용자 메시지에는 정확한 작업 지시를 글로 덧붙인다. 지시도 지금 scene으로 다시 만든다.
const actionOf = (m: UIMessage) => (m.role === "user" ? (m.metadata as Meta)?.action : undefined);
// 그 메시지 바로 뒤 답에서 patch_scene 수정안을 이미 보냈는지.
const answered = (messages: UIMessage[], i: number) =>
  messages[i + 1]?.role === "assistant" && messages[i + 1].parts.some((p) => p.type === "tool-patch_scene");

function withActionInstruction(messages: UIMessage[], scene: unknown): UIMessage[] {
  const lastUser = messages.map((m) => m.role).lastIndexOf("user");
  return messages.map((m, i) => {
    const action = actionOf(m);
    if (!action?.id) return m;
    // 지나간 AI 액션(이미 수정안을 보냄)은 지금 scene으로 지시를 다시 만들면 같은 작업을 또 하라는 말이 되므로 짧게 적는다.
    // 마지막 사용자 메시지(도구 결과 뒤 이어지는 답)는 답에 쓸 숫자가 필요해 지시를 그대로 두고 표시만 붙인다.
    if (!LOCAL_DONE(action) && answered(messages, i) && i !== lastUser)
      return { ...m, parts: [...m.parts, { type: "text", text: `[액션 지시 — 수정안 보냄]\n${action.label}: 이 지시의 patch_scene 수정안은 이미 보냈다. 적용됐는지는 scene으로 판단한다.` }] };
    let text: string;
    try {
      text = actionInstruction(scene as Scene, action);
    } catch {
      text = `${action.label}: ${JSON.stringify(action.params)}`;
    }
    // 브라우저가 처리한 액션(local 수정안·모션)은 지나간 기록일 뿐이니, 뒤 대화에서 다시 알리지 않게 한다.
    const note = LOCAL_DONE(action) ? `[화면에서 처리한 액션 — 이후 답에서 다시 언급하지 않는다]\n${text}`
      : answered(messages, i) ? `[액션 지시 — 수정안 보냄]\n${text}` : `[액션 지시]\n${text}`;
    return { ...m, parts: [...m.parts, { type: "text", text: note }] };
  });
}

// 브라우저가 바로 수정안을 띄우는(local) 액션과 조립 모션·분해도는 브라우저가 처리했으므로 도구를 강제하지 않는다.
const LOCAL_DONE = (a: ActionMeta) => a.id === "merge_steps" || a.id === "part_motion" || a.id === "explode_view" || (a.id === "add_warning" && !!String(a.params?.text ?? "").trim());

// 모델이 도구 입력 JSON 끝에 괄호를 하나 더 붙이는 일이 가끔 있다. 끝에서 몇 글자까지 잘라 보며 파싱되는 앞부분을 쓴다.
const trimToolJson: ToolCallRepairFunction<typeof tools> = async ({ toolCall }) => {
  const raw = toolCall.input.trimEnd();
  for (let cut = raw.length; cut > 0 && raw.length - cut <= 8; cut--) {
    try { JSON.parse(raw.slice(0, cut)); return { ...toolCall, input: raw.slice(0, cut) }; } catch { /* 계속 */ }
  }
  return null;
};

// 화면 언어가 한국어가 아니면 답은 그 언어로 하되, scene의 *_ko 값은 한국어로 쓴다(화면이 번역해 보여 준다).
function replyIn(lang?: string) {
  if (!lang || lang === "ko" || !/^[a-z]{2,3}(-[A-Z]{2})?$/.test(lang)) return "";
  return `\n- 사용자 화면 언어는 BCP 47 "${lang}"이다. 답과 patch_scene의 summary는 이 언어로 쓴다. 단, scene의 *_ko 값을 바꿀 때는 한국어로 쓴다(화면이 번역해 보여 준다).`;
}

export async function chatStream({ messages, scene, step, lang }: ChatBody, env: { ANTHROPIC_API_KEY: string; CHAT_MODEL?: string }) {
  const anthropic = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY });
  // 마지막 메시지가 AI 액션이면 patch_scene을 꼭 부르게 한다. 도구 결과 뒤 이어지는 요청은 마지막이 assistant라 강제하지 않는다(안 그러면 끝없이 돈다).
  const last = messages[messages.length - 1];
  const action = last ? actionOf(last) : undefined;
  const force = !!action?.id && !LOCAL_DONE(action);
  // 이번 사용자 요청에 대해 이미 수정안(patch_scene)을 보냈으면, 이어지는 답에서는 patch_scene을 아예 빼서 같은 수정안이 두 번 뜨지 않게 한다.
  const lastUser = messages.map((m) => m.role).lastIndexOf("user");
  const proposed = messages.slice(lastUser + 1).some((m) => m.parts.some((p) => p.type === "tool-patch_scene"));
  const activeTools = proposed ? (Object.keys(tools) as (keyof typeof tools)[]).filter((k) => k !== "patch_scene") : undefined;
  const result = streamText({
    model: anthropic(env.CHAT_MODEL || "claude-opus-5-5"),
    system: `${SYSTEM}${replyIn(lang)}\n\n지금 사용자가 보고 있는 단계: ${step ?? "?"}단계\n\nscene:\n${JSON.stringify(scene)}`,
    messages: await convertToModelMessages(withActionInstruction(withPartContext(messages, scene), scene)),
    tools,
    repairToolCall: trimToolJson,
    // 글자가 덩어리로 튀지 않고 단어 단위로 흘러나오게 한다(AI SDK smoothStream).
    experimental_transform: smoothStream({ chunking: "word" }),
    // 이 모델은 기본으로 생각 내용을 빼고(omitted) 서명만 보낸다. 화면의 "생각 과정"에 보이도록 요약본을 받는다.
    providerOptions: { anthropic: { thinking: { type: "adaptive", display: "summarized" } } },
    ...(activeTools ? { activeTools } : {}),
    ...(force ? { toolChoice: { type: "tool" as const, toolName: "patch_scene" as const } } : {}),
  });
  // 서버 오류 원문은 로그에만 남기고 화면에는 보내지 않는다(화면은 "다시 시도"를 보여 준다).
  return toUIMessageStream({ stream: result.stream, onError: (e) => { console.error(e); return "error"; } });
}

export async function POST(req: Request): Promise<Response> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return new Response("ANTHROPIC_API_KEY 환경 변수가 없어요.", { status: 500 });
  try {
    const body = await req.json() as ChatBody;
    const stream = await chatStream(body, { ANTHROPIC_API_KEY: apiKey, CHAT_MODEL: process.env.CHAT_MODEL });
    return createUIMessageStreamResponse({ stream });
  } catch (e) {
    return new Response(String((e as Error)?.message ?? e), { status: 500 });
  }
}
