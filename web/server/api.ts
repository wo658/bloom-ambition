// 개발 서버에 붙는 API: 원본 PDF 제공(/api/pdf/<demo>). 배포본은 vercel.json rewrite로 제조사 원본을 가져온다.
import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

const DEMO_NAME = /^[\w-]+$/;

// data/out/<demo>/source.pdf가 있으면 그걸, 없으면 data/samples에서 이름이 맞는 PDF를 찾는다.
function findPdf(repo: string, demo: string): string | null {
  const direct = path.join(repo, "data", "out", demo, "source.pdf");
  if (fs.existsSync(direct)) return direct;
  const samples = path.join(repo, "data", "samples");
  if (!fs.existsSync(samples)) return null;
  const key = demo.toLowerCase();
  const stack = [samples];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.endsWith(".pdf") && path.relative(samples, full).toLowerCase().includes(key)) return full;
    }
  }
  return null;
}

export default function manualApi(): Plugin {
  return {
    name: "manual-api",
    configureServer(server) {
      const webRoot = server.config.root;
      const repo = path.dirname(webRoot);

      server.middlewares.use("/api/pdf", (req, res) => {
        const demo = decodeURIComponent((req.url ?? "").replace(/^\//, "").split("?")[0]);
        const file = DEMO_NAME.test(demo) ? findPdf(repo, demo) : null;
        if (!file) {
          res.statusCode = 404;
          res.end("원본 PDF를 찾지 못했어요.");
          return;
        }
        res.setHeader("Content-Type", "application/pdf");
        fs.createReadStream(file).pipe(res);
      });
    },
  };
}
