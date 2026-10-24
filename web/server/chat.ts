// 개발 서버에 붙는 채팅 API(/api/chat). 브라우저가 지금 scene.json을 같이 보내고,
// 모델은 patch_scene 도구로 수정안을 돌려준다. 실제 적용은 브라우저(ChatPanel)가 한다.
import type { IncomingMessage } from "node:http";
import { createAnthropic } from "@ai-sdk/anthropic";
import { convertToModelMessages, pipeUIMessageStreamToResponse, streamText, toUIMessageStream, type UIMessage } from "ai";
import type { Plugin } from "vite";
import { z } from "zod";

const SYSTEM = `너는 가구 조립 설명서 3D 뷰어의 편집 도우미다. 화면의 도면은 아래 scene JSON 하나로 그려진다.
사용자가 바꿔 달라고 하면 patch_scene 도구로 JSON Patch(RFC 6902: replace/add/remove, JSON Pointer 경로)를 보내라.

scene 구조(단위 cm, 좌표는 가구 기준 x=좌우, y=위, z=앞뒤):
- panels[]: 판재. id, name_ko, size[가로,높이,깊이], pos(조립 후 중심 위치), from(등장할 때 pos에서 떨어져 있는 거리)
- steps[]: 단계. number, page(원본 쪽), caption_ko(설명, 문장마다 줄바꿈), warning_ko, confidence(0~1),
  adds[](이 단계에 붙는 panel id), uses[](필요한 철물 part_id·qty·name_ko), small[](철물 배치), pose("lying"|"upright"), wall
- hardware: 철물 모양 사양, safety_ko[]: 안전 문구

규칙:
- 바꿀 것은 한 번의 patch_scene 호출에 모두 담는다. 경로의 배열 번호는 0부터다(steps[0]이 1단계).
- 판 치수를 바꾸면 맞닿는 판의 pos도 같이 맞춰 겹치거나 뜨지 않게 한다.
- 특정 단계를 보여 주는 게 도움이 되면 go_to_step을 쓴다.
- 질문에는 scene을 근거로 짧게 한국어로 답한다. 수정 뒤에는 무엇을 바꿨는지 한두 줄로 알린다.`;

const tools = {
  patch_scene: {
    description: "scene JSON에 JSON Patch를 적용해 화면의 도면을 바꾼다.",
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
};

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => { try { resolve(JSON.parse(raw)); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

export default function chatApi(env: Record<string, string>): Plugin {
  return {
    name: "chat-api",
    configureServer(server) {
      server.middlewares.use("/api/chat", async (req, res) => {
        if (req.method !== "POST") { res.statusCode = 405; res.end(); return; }
        if (!env.ANTHROPIC_API_KEY) {
          res.statusCode = 500;
          res.end("web/.env.local에 ANTHROPIC_API_KEY가 없어요.");
          return;
        }
        try {
          const { messages, scene, step } = await readJson(req) as { messages: UIMessage[]; scene: unknown; step?: number };
          const anthropic = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY });
          const result = streamText({
            model: anthropic(env.CHAT_MODEL || "claude-sonnet-5-5"),
            system: `${SYSTEM}\n\n지금 사용자가 보고 있는 단계: ${step ?? "?"}단계\n\nscene:\n${JSON.stringify(scene)}`,
            messages: await convertToModelMessages(messages),
            tools,
          });
          await pipeUIMessageStreamToResponse({
            response: res,
            stream: toUIMessageStream({ stream: result.stream, onError: (e) => String((e as Error)?.message ?? e) }),
          });
        } catch (e) {
          res.statusCode = 500;
          res.end(String((e as Error)?.message ?? e));
        }
      });
    },
  };
}
