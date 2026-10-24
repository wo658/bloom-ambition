// 번역 API(/api/translate). 화면에서 처음 고른 언어에 번역이 없는 문구만 받아 Claude로 번역한다.
// 배포(Vercel Function)에서는 결과를 돌려주기만 하고(브라우저가 저장), 개발 서버(server/translate.ts)는 i18n.json에도 저장한다.
import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText, Output } from "ai";
import { z } from "zod";

const PROMPT = `Translate each Korean string below into the language with BCP 47 tag "{lang}" for an assembly-guide app.
The text is shown on screen and read aloud by text-to-speech, so write short, natural, imperative sentences.
Keep every line break ("\\n") in the same place: one output line per input line.
Keep part numbers (B12, PE45, 104321), marking letters, numbers, units, emoji, arrows and {placeholders} exactly as they are.
For Japanese people, ships and units, use their usual written names in the target language.
Return one item per input id.`;

export type TranslateBody = { lang: string; texts: string[] };

// 공개 API라서 언어 코드 모양·문구 수·전체 길이를 막아 크레딧이 새지 않게 한다.
export function checkBody(body: any): TranslateBody | string {
  const { lang, texts } = body ?? {};
  if (typeof lang !== "string" || !/^[a-z]{2,3}(-[A-Z]{2})?$/.test(lang)) return "lang이 올바르지 않아요.";
  if (!Array.isArray(texts) || texts.length === 0 || texts.length > 400 || !texts.every((s) => typeof s === "string")) return "texts가 올바르지 않아요.";
  if (texts.join("").length > 30000) return "문구가 너무 길어요.";
  return { lang, texts };
}

export async function translateTexts({ lang, texts }: TranslateBody, apiKey: string): Promise<Record<string, string>> {
  const anthropic = createAnthropic({ apiKey });
  const { output } = await generateText({
    model: anthropic("claude-opus-5-5"),
    output: Output.object({ schema: z.object({ items: z.array(z.object({ id: z.number().int(), text: z.string() })) }) }),
    prompt: `${PROMPT.replace("{lang}", lang)}\n\n${texts.map((ko, id) => JSON.stringify({ id, ko })).join("\n")}`,
    maxOutputTokens: 16000,
    maxRetries: 1,
    providerOptions: { anthropic: { effort: "low" } },
  });
  const got = new Map(output.items.map((it) => [it.id, it.text]));
  // 줄 수가 안 맞는 번역은 버리고 한국어로 둔다(자막과 음성의 줄 단위가 어긋나지 않게).
  return Object.fromEntries(texts.flatMap((ko, i) => {
    const tr = got.get(i);
    return tr !== undefined && tr.split("\n").length === ko.split("\n").length ? [[ko, tr]] : [];
  }));
}

export async function POST(req: Request): Promise<Response> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return new Response("ANTHROPIC_API_KEY 환경 변수가 없어요.", { status: 503 });
  const body = checkBody(await req.json().catch(() => null));
  if (typeof body === "string") return new Response(body, { status: 400 });
  try {
    return Response.json(await translateTexts(body, apiKey));
  } catch (e) {
    return new Response(String((e as Error)?.message ?? e), { status: 500 });
  }
}
