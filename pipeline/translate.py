"""5단계(선택): 한국어 문구 → i18n.json {언어: {한국어 원문: 번역}}. 뷰어(web/src/lang.ts)가 읽는다.
원본이 scene.json이면 설명서 문구(*_ko), 폴더(web/src)면 ./lang를 쓰는 화면 코드의 한국어 문자열 상수를 번역한다.
이미 번역한 문구는 건너뛰므로, 고친 뒤 다시 돌리면 바뀐 문구만 번역한다. 언어는 BCP 47 코드(lang.ts의 LANGS id)다.
사용법: python translate.py ../web/public/demo/scene.json ../web/public/demo/i18n.json en ja zh-CN
        python translate.py ../web/src ../web/public/i18n-ui.json en ja zh-CN
"""
import json
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import anthropic
from pydantic import BaseModel

MODEL = "claude-opus-5-5"
BATCH = 60

PROMPT = """Translate each Korean string below into the language with BCP 47 tag "{lang}" for an assembly-guide app.
The text is shown on screen and read aloud by text-to-speech, so write short, natural, imperative sentences.
Keep every line break ("\\n") in the same place: one output line per input line.
Keep part numbers (B12, PE45, 104321), marking letters, numbers, units, emoji, arrows and {{placeholders}} exactly as they are.
For Japanese people, ships and units, use their usual written names in the target language.
Return one item per input id.

{items}"""


class Item(BaseModel):
    id: int
    text: str


class Batch(BaseModel):
    items: list[Item]


def korean_strings(node, out: set[str]) -> set[str]:
    """키 이름이 _ko로 끝나는 값(문자열·문자열 목록)을 모은다."""
    if isinstance(node, dict):
        for k, v in node.items():
            if k.endswith("_ko"):
                for s in v if isinstance(v, list) else [v]:
                    if isinstance(s, str) and s.strip():
                        out.add(s)
            else:
                korean_strings(v, out)
    elif isinstance(node, list):
        for v in node:
            korean_strings(v, out)
    return out


def ui_strings(src: Path) -> set[str]:
    """./lang를 쓰는 화면 코드에서 한국어가 든 문자열 상수를 모은다(t()에 넘기는 문구가 여기 있다)."""
    out: set[str] = set()
    for f in sorted(src.glob("*.ts*")):
        code = f.read_text()
        if '"./lang"' in code:
            out |= set(re.findall(r'"([^"\\\n]*[가-힣][^"\\\n]*)"', code))
    return out


def translate(client: anthropic.Anthropic, texts: list[str], lang: str) -> dict[str, str]:
    items = "\n".join(json.dumps({"id": i, "ko": s}, ensure_ascii=False) for i, s in enumerate(texts))
    response = client.messages.parse(
        model=MODEL,
        max_tokens=16000,
        output_config={"effort": "low"},
        messages=[{"role": "user", "content": PROMPT.format(lang=lang, items=items)}],
        output_format=Batch,
    )
    if response.stop_reason in ("refusal", "max_tokens"):
        print(f"  {lang}: {response.stop_reason} — 이 묶음은 한국어로 둔다", file=sys.stderr)
        return {}
    got = {it.id: it.text for it in response.parsed_output.items}
    # ponytail: 줄 수가 안 맞는 번역은 버리고 한국어로 둔다(자막과 음성의 줄 단위가 어긋나지 않게).
    return {s: got[i] for i, s in enumerate(texts) if i in got and got[i].count("\n") == s.count("\n")}


if __name__ == "__main__":
    src, out_path, langs = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3:]
    texts = sorted(ui_strings(src) if src.is_dir() else korean_strings(json.loads(src.read_text()), set()))
    result = json.loads(out_path.read_text()) if out_path.exists() else {}
    client = anthropic.Anthropic()

    def run(lang: str) -> None:
        done = result.setdefault(lang, {})
        todo = [s for s in texts if s not in done]
        for i in range(0, len(todo), BATCH):
            try:
                done.update(translate(client, todo[i:i + BATCH], lang))
            except Exception as e:  # 한 묶음이 실패해도 나머지 번역은 저장한다
                print(f"  {lang}: 묶음 실패 {type(e).__name__}: {str(e)[:120]}", file=sys.stderr)
        missing = sum(s not in done for s in texts)
        print(f"{lang}: 새로 번역 {len(todo)}개" + (f", 못 한 문구 {missing}개(한국어로 표시)" if missing else ""))

    # ponytail: 언어마다 한 줄기로 8개씩 동시에 돈다. 429가 나면 SDK가 다시 시도한다.
    with ThreadPoolExecutor(8) as pool:
        list(pool.map(run, langs))
    out_path.write_text(json.dumps(result, ensure_ascii=False, indent=1))
    print(out_path)
