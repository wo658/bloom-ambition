// 개발 서버에 붙는 채팅 API(/api/chat). 본체는 api/chat.ts(배포 시 Vercel Function)와 같다.
import type { IncomingMessage } from "node:http";
import { pipeUIMessageStreamToResponse } from "ai";
import type { Plugin } from "vite";
import { chatStream, type ChatBody } from "../api/chat";

export function readJson(req: IncomingMessage): Promise<any> {
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
          const body = await readJson(req) as ChatBody;
          await pipeUIMessageStreamToResponse({
            response: res,
            stream: await chatStream(body, { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY, CHAT_MODEL: env.CHAT_MODEL }),
          });
        } catch (e) {
          res.statusCode = 500;
          res.end(String((e as Error)?.message ?? e));
        }
      });
    },
  };
}
