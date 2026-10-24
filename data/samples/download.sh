#!/usr/bin/env bash
# 샘플 설명서 PDF 다운로드 (저작권 문제로 레포에는 원본 미포함)
set -euo pipefail
cd "$(dirname "$0")"

curl -fL -o ikea-kallax-2x2-assembly.pdf \
  "https://www.ikea.com/gb/en/assembly_instructions/kallax-shelving-unit-white__AA-1009450-15-100.pdf"
curl -fL -o coway-airmega-150-manual.pdf \
  "https://www.sylvane.com/cdn/shop/files/owners-manual-coway-airmega-150-bedroom-hepa-air-purifier.pdf"

echo "done: $(ls *.pdf)"
