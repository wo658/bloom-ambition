"""1단계: PDF/사진 → 페이지 PNG. 사진이면 그대로 복사한다."""
import shutil
import sys
from pathlib import Path

import pymupdf


def render(src: Path, out_dir: Path, dpi: int = 110) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    if src.suffix.lower() in {".png", ".jpg", ".jpeg"}:
        dst = out_dir / f"page-01{src.suffix.lower()}"
        shutil.copy(src, dst)
        return [dst]
    pages = []
    with pymupdf.open(src) as doc:
        for i, page in enumerate(doc, 1):
            dst = out_dir / f"page-{i:02d}.png"
            page.get_pixmap(dpi=dpi).save(dst)
            pages.append(dst)
    return pages


if __name__ == "__main__":
    dpi = int(sys.argv[3]) if len(sys.argv) > 3 else 110
    for p in render(Path(sys.argv[1]), Path(sys.argv[2]), dpi):
        print(p)
