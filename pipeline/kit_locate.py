"""키트 설명서: 단계별 부품 번호를 OCR로 페이지에서 찾아 하이라이트 좌표를 만든다.

PDF 글자가 곡선으로 바뀌어 텍스트 추출이 안 되므로 macOS Vision OCR(ocrmac)을 쓴다.
OCR은 아이콘을 숫자로 읽기도 해서("PE29" + 접기 아이콘 → "PE291"),
VLM이 뽑은 단계별 부품 목록에 있는 번호만 받아들인다.
"""
import json
import re
import sys
from pathlib import Path

import pymupdf
from ocrmac import ocrmac

from kit_schema import KitManual

OCR_DPI = 220
CROP_DPI = 360
PART_RE = re.compile(r"(PE|[A-EG8])\s?(\d{1,3})([AB]?)")
# OCR이 자주 헷갈리는 첫 글자. 단계 부품 목록과 대조하므로 넓게 잡아도 오탐이 적다.
LOOKALIKE = {"G": ["C"], "8": ["B"], "C": ["G"], "B": ["8"]}
REGION_MARGIN = 0.02


def ocr_page(pdf: pymupdf.Document, page_no: int, tmp: Path, region=(0.0, 0.0, 1.0, 1.0), dpi=OCR_DPI):
    """(텍스트, 페이지 기준 0~1 좌표 상자) 목록. 상자 원점은 왼쪽 위.
    region을 주면 그 부분만 잘라 더 높은 해상도로 읽는다(작은 라벨을 덜 놓친다)."""
    page = pdf[page_no - 1]
    rx0, ry0, rx1, ry1 = region
    clip = pymupdf.Rect(rx0 * page.rect.width, ry0 * page.rect.height, rx1 * page.rect.width, ry1 * page.rect.height)
    image = tmp / f"ocr-{page_no:02d}-{rx0:.2f}-{ry0:.2f}.png"
    page.get_pixmap(dpi=dpi, clip=clip).save(image)
    lines = []
    for text, _conf, (x, y, w, h) in ocrmac.OCR(str(image), recognition_level="accurate").recognize():
        bx0, by0, bx1, by1 = x, 1 - y - h, x + w, 1 - y
        sx, sy = rx1 - rx0, ry1 - ry0
        lines.append((text, (rx0 + bx0 * sx, ry0 + by0 * sy, rx0 + bx1 * sx, ry0 + by1 * sy)))
    return lines


def candidates(prefix: str, digits: str, suffix: str) -> list[str]:
    """OCR이 뒤에 붙인 아이콘 숫자를 떼어 본 후보들. 긴 것부터."""
    out = []
    for letter in [prefix] + LOOKALIKE.get(prefix, []):
        for n in range(len(digits), 0, -1):
            base = f"{letter}{digits[:n]}"
            out += [base + suffix, base] if suffix else [base]
    return out


def tokens(lines):
    """줄 단위 OCR 결과를 부품 번호 단위로 쪼개고, 글자 위치 비율로 가로 좌표를 나눈다."""
    for text, (x0, y0, x1, y1) in lines:
        width = (x1 - x0) / max(len(text), 1)
        for m in PART_RE.finditer(text):
            box = (x0 + m.start() * width, y0, x0 + m.end() * width, y1)
            yield candidates(m.group(1), m.group(2), m.group(3)), box


def inside(box, region) -> bool:
    cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
    rx0, ry0, rx1, ry1 = region
    return rx0 - REGION_MARGIN <= cx <= rx1 + REGION_MARGIN and ry0 - REGION_MARGIN <= cy <= ry1 + REGION_MARGIN


def overlaps(a, b) -> bool:
    """같은 라벨을 전체 페이지 OCR과 영역 OCR이 둘 다 찾았을 때 중복 제거용."""
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


def locate(manual: KitManual, pdf_path: Path, tmp: Path) -> dict:
    pdf = pymupdf.open(pdf_path)
    tmp.mkdir(parents=True, exist_ok=True)
    pages = {s.page: ocr_page(pdf, s.page, tmp) for s in manual.steps}
    crops = {s.id: ocr_page(pdf, s.page, tmp, s.region, CROP_DPI) for s in manual.steps}
    steps, found_total, wanted_total = [], 0, 0
    for number, step in enumerate(manual.steps, 1):
        wanted = {p.id for p in step.parts}
        hits = []
        for cands, box in tokens(pages[step.page] + crops[step.id]):
            if not inside(box, step.region):
                continue
            match = next((c for c in cands if c in wanted), None)
            if match and not any(h["id"] == match and overlaps(h["box"], box) for h in hits):
                hits.append({"id": match, "box": [round(v, 4) for v in box]})
        found = {h["id"] for h in hits}
        found_total += len(found)
        wanted_total += len(wanted)
        # 서브조립 기호(A, B…)와 쪽 번호가 겹치므로, 화면·채팅 링크용 순번을 따로 붙인다.
        steps.append({"number": number, **step.model_dump(), "hits": hits, "missing": sorted(wanted - found)})
    return {
        **manual.model_dump(exclude={"steps"}),
        "steps": steps,
        "page_aspect": round(pdf[0].rect.height / pdf[0].rect.width, 4),
        "ocr_recall": round(found_total / max(wanted_total, 1), 3),
    }


if __name__ == "__main__":
    manual = KitManual.model_validate_json(Path(sys.argv[1]).read_text())
    guide = locate(manual, Path(sys.argv[2]), Path(sys.argv[3]).parent / "ocr")
    Path(sys.argv[3]).write_text(json.dumps(guide, ensure_ascii=False, indent=2))
    print(f"OCR로 위치를 찾은 부품 비율: {guide['ocr_recall']:.0%}")
    for s in guide["steps"]:
        if s["missing"]:
            print(f"  {s['id']}: 못 찾음 {', '.join(s['missing'])}", file=sys.stderr)
    print(sys.argv[3])
