// 개발 서버에 붙는 번역 API(/api/translate). 번역은 api/translate.ts와 같고,
// 받은 번역을 public/<save> (예: /demo/i18n.json)에 합쳐 저장해 다음부터는 정적 파일로 바로 뜨게 한다.
import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";
import { checkBody, translateTexts } from "../api/translate";
import { readJson } from "./chat";

const SAVE = /^\/demo(\/[\w-]+)?\/i18n\.json$/;

export default function translateApi(env: Record<string, string>): Plugin {
  return {
    name: "translate-api",
    configureServer(server) {
      server.middlewares.use("/api/translate", async (req, res) => {
        if (req.method !== "POST") { res.statusCode = 405; res.end(); return; }
        if (!env.ANTHROPIC_API_KEY) { res.statusCode = 503; res.end("web/.env.local에 ANTHROPIC_API_KEY가 없어요."); return; }
        try {
          const raw = await readJson(req);
          const body = checkBody(raw);
          if (typeof body === "string") { res.statusCode = 400; res.end(body); return; }
          const got = await translateTexts(body, env.ANTHROPIC_API_KEY);
          if (typeof raw.save === "string" && SAVE.test(raw.save)) {
            const file = path.join(server.config.root, "public", raw.save);
            const all = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
            all[body.lang] = { ...all[body.lang], ...got };
            fs.writeFileSync(file, JSON.stringify(all, null, 1));
          }
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(got));
        } catch (e) {
          res.statusCode = 500;
          res.end(String((e as Error)?.message ?? e));
        }
      });
    },
  };
}
