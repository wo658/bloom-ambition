#!/usr/bin/env bash
# 설명서 PDF/사진 → 시연 데이터.
# 사용법: pipeline/run.sh <입력파일> <이름> [furniture|kit] [fixture.json]
#   furniture: 판재 가구 → 3D 조립 애니메이션
#   kit: 프라모델(비행기) → 부품 자리별 3D 조립 애니메이션
set -euo pipefail
cd "$(dirname "$0")/.."

src=$1
name=$2
mode=${3:-furniture}
fixture=${4:-}
out=data/out/$name
py=.venv/bin/python
dpi=110

echo "[1/4] 페이지 렌더링"
$py pipeline/render.py "$src" "$out/pages" $dpi >/dev/null

echo "[2/4] 부품·단계 추출"
if [[ -n "$fixture" ]]; then
  echo "      fixture 사용: $fixture"
  cp "$fixture" "$out/manual.json"
elif [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
  (cd pipeline && ../$py extract.py "../$out/pages" "../$out/manual.json" "$mode")
else
  echo "ANTHROPIC_API_KEY가 없고 fixture도 지정하지 않았어요." >&2
  exit 1
fi

echo "[3/4] 3D 배치 계산"
if [[ $mode == kit ]]; then
  (cd pipeline && ../$py kit_layout.py "../$out/manual.json" "../$out/scene.json")
else
  $py pipeline/layout.py "$out/manual.json" "$out/scene.json"
fi

echo "[4/4] 뷰어로 복사"
if [[ $mode == kit ]]; then
  dest=web/public/demo/$name   # 키트 3D 조립: /?demo=<이름>
else
  dest=web/public/demo         # 가구 뷰어(App.tsx)는 /demo/scene.json을 읽는다
fi
rm -rf "$dest/pages" "$dest/scene.json"
mkdir -p "$dest"
cp -R "$out/pages" "$out/scene.json" "$dest/"
if [[ $mode == kit ]]; then
  echo "완료: cd web && npm run dev → /?demo=$name"
else
  echo "완료: cd web && npm run dev"
fi
