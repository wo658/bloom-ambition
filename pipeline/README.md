# 설명서 → 조립 시연 파이프라인

설명서 종류에 따라 두 가지 모드가 있다.

| 모드 | 대상 | 3단계 | 뷰어 |
|---|---|---|---|
| `furniture` | 판재 가구 (KALLAX) | `layout.py`: 판 역할 → 3D 위치 | 3D 조립 애니메이션 (`/`) |
| `kit` | 부품이 많고 곡면인 프라모델 (Eduard 82212) | `kit_locate.py`: OCR로 부품 번호 위치 | 원본 페이지 위 2D 단계 가이드 (`/?demo=<이름>`) |

```
PDF/사진 ─render.py─▶ 페이지 PNG ─extract.py(Claude 비전)─▶ manual.json ─┬ layout.py ─▶ scene.json (3D)
                                                                          └ kit_locate.py(ocrmac) ─▶ scene.json (2D)
```

| 단계 | 파일 | 하는 일 |
|---|---|---|
| 1 | `render.py` | PyMuPDF로 페이지를 PNG로 렌더링. 사진 입력은 그대로 사용 |
| 2 | `extract.py`, `schema.py` | Claude(`claude-opus-5-5`) 구조화 출력으로 부품표·단계·한국어 자막·안전 경고 추출 |
| 3 | `layout.py` | 판재 역할 + 외곽 치수 → 판 크기·최종 위치·삽입 방향. 부품 번호별 철물 형상·치수(`HARDWARE`)와 실제 구멍 좌표(모서리 연결 볼트, 나무못 결합면, 벽 고정 브래킷)에 소형 부품 배정. 부품표 수량과 단계 합계 검증 |
| 4 | `../web` | 단계별 조립 애니메이션, 현재 부품 하이라이트, 원본 페이지 나란히 보기 |

## 실행

```bash
uv venv .venv --python 3.12 && uv pip install --python .venv/bin/python -r pipeline/requirements.txt
(cd web && npm install)

# Claude API로 추출
ANTHROPIC_API_KEY=... pipeline/run.sh data/samples/ikea-kallax-2x2-assembly.pdf kallax furniture
# API 키 없이 저장된 추출 결과로
pipeline/run.sh data/samples/ikea-kallax-2x2-assembly.pdf kallax furniture pipeline/fixtures/kallax-2x2.manual.json
pipeline/run.sh data/samples/eduard-82212/82212.pdf eduard-82212 kit pipeline/fixtures/eduard-82212.manual.json

cd web && npm run dev   # ←/→ 단계 이동, 스페이스 다시 보기
```

`kit` 모드의 PDF는 글자가 곡선으로 바뀌어 있어 텍스트 추출이 안 된다. macOS Vision OCR(`ocrmac`)로 읽고,
추출된 단계별 부품 목록에 있는 번호만 받아들여 오탐을 막는다. Eduard 82212 기준 부품 위치 검출률 97%.

`data/out/`, `web/public/demo/`에는 원본 페이지 이미지가 들어가므로 커밋하지 않는다.
