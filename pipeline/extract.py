"""2단계: 페이지 이미지 → Manual JSON (Claude 비전 + 구조화 출력)."""
import base64
import json
import sys
from pathlib import Path

import anthropic

from kit_schema import KitManual
from schema import Manual

MODEL = "claude-opus-5-5"

PROMPT = """첨부한 이미지는 가구 조립설명서의 페이지들이다(순서대로 1쪽부터).
글자 없이 그림, 부품 번호, 수량 콜아웃(예: 8x)만 있다.

다음을 추출해라.
1. 부품표 페이지의 소형 부품: 번호, 종류, 수량. 판재는 번호가 없으니 완성품 기준 위치(role)로 id를 정한다.
2. 바닥에 세우는 기본 경로의 조립 단계: 단계 번호, 쪽, 새로 붙는 판재(adds), 쓰는 부품과 수량(uses).
   벽에 거는 대체 경로(뒤쪽에 같은 번호로 다시 시작하는 단계)는 제외한다.
3. 단계마다 그림만 보고 한국어 설명(caption_ko)을 쓴다. 한 문장에 동작 하나씩, 하는 순서대로 짧게 쓴다.
   문장마다 줄바꿈(\\n)으로 나눈다. warning_ko도 같다.
   확실하지 않은 해석은 confidence를 낮춘다.
4. 넘어짐 방지 같은 안전 경고를 한국어로 정리한다.
판재 치수는 제품명으로 알 수 있으면 실제 외곽 치수(cm)를 쓴다."""


KIT_PROMPT = """첨부한 이미지는 프라모델 조립설명서의 페이지들이다(순서대로 1쪽부터).
부품 번호(사출 틀 A~E + 숫자, 에칭 PE + 숫자), 서브조립 기호(네모 안 글자), 마킹 전용 표시(MARKINGS A B ONLY),
선택 표시(?), 도색 코드가 그림 옆에 있다.

다음을 추출해라.
1. 마킹(도색 사양) 목록: 기호, 한국어 제목(조종사, 부대, 시기, 기체 번호), 쪽.
2. 조립 단계: 서브조립 기호가 있으면 그 기호를 id로, 없으면 p<쪽>-<짧은 영문 이름>을 id로 쓴다.
   region은 그 단계 그림이 차지하는 페이지 영역(0~1, 왼쪽 위 원점)이다.
   parts에는 그 영역에 적힌 부품 번호를 빠짐없이 넣고, 마킹 전용이면 markings를, ?가 붙은 선택 부품이면 optional을 채운다.
   uses_steps에는 그 단계에 끼워 넣는 앞 단계 id를 넣는다.
3. title_ko는 서브조립 기호를 빼고 쓴다(화면이 기호를 따로 붙인다).
   caption_ko는 그림만 보고 쓴 한국어 설명이다. 한 문장에 동작 하나씩, 붙이는 순서대로 짧게 쓴다.
   문장마다 줄바꿈(\\n)으로 나눈다. warning_ko도 같다.
   마킹별로 다른 부품은 "마킹 A·B는 PE1을 써요.\\n마킹 C·D·E는 PE56을 써요."처럼 마킹마다 한 줄로 나눈다.
   부품 번호는 줄이지 말고 PE14·PE15처럼 모두 쓴다.
   paints_ko는 도색 지시를 한국어로 옮긴 것이다. 확실하지 않은 해석은 confidence를 낮춘다.
4. 빨간 표시(잘라냄), 파란 표시(접착 금지) 같은 기호 설명과 안전 경고를 notes_ko에 정리한다."""


def image_block(path: Path) -> dict:
    data = base64.standard_b64encode(path.read_bytes()).decode()
    media = "image/png" if path.suffix == ".png" else "image/jpeg"
    return {"type": "image", "source": {"type": "base64", "media_type": media, "data": data}}


def extract(pages: list[Path], kit: bool = False) -> Manual | KitManual:
    client = anthropic.Anthropic()
    content = [image_block(p) for p in pages] + [{"type": "text", "text": KIT_PROMPT if kit else PROMPT}]
    response = client.messages.parse(
        model=MODEL,
        max_tokens=16000,
        output_config={"effort": "high"},
        messages=[{"role": "user", "content": content}],
        output_format=KitManual if kit else Manual,
    )
    if response.stop_reason == "refusal":
        raise RuntimeError(f"모델이 응답을 거절함: {response.stop_details}")
    manual = response.parsed_output
    manual.extracted_by = MODEL
    return manual


if __name__ == "__main__":
    pages_dir, out = Path(sys.argv[1]), Path(sys.argv[2])
    kit = len(sys.argv) > 3 and sys.argv[3] == "kit"
    manual = extract(sorted(pages_dir.glob("page-*.*")), kit)
    out.write_text(json.dumps(manual.model_dump(), ensure_ascii=False, indent=2))
    print(out)
