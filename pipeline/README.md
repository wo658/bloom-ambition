# 설명서 → 조립 시연 파이프라인

설명서 종류에 따라 두 가지 모드가 있다.

| 모드 | 대상 | 3단계 | 뷰어 |
|---|---|---|---|
| `furniture` | 판재 가구 (KALLAX) | `layout.py`: 판 역할 → 3D 위치 | 3D 조립 애니메이션 (`/`) |
| `kit` | 프라모델 비행기 (Eduard 82212 제로센) | `kit_layout.py`: 부품 자리 → 3D 형상·위치 | 3D 조립 애니메이션 (`/?demo=<이름>`) |

```
PDF/사진 ─render.py─▶ 페이지 PNG ─extract.py(Claude 비전)─▶ manual.json ─┬ layout.py ─────▶ scene.json (가구 3D)
                                                                          └ kit_layout.py ─▶ scene.json (키트 3D)
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

cd web && npm run dev   # ←/→ 단계 이동, 스페이스 다시 보기
```

`kit` 모드도 가구와 같은 흐름이다. 추출 단계에서 부품마다 완성된 기체에서의 자리(`role`: 왼쪽 동체, 아래 주날개, 카울링 왼쪽 등)를 고르면,
`kit_layout.py`가 1/48 실측에 맞춘 근사 형상과 최종 위치·삽입 방향을 정한다. 주날개·꼬리날개·엔진·카울링·착륙장치·프로펠러·캐노피 같은
서브조립은 기체 옆에서 따로 만들다가, 설명서에서 그 서브조립을 끼우는 단계에 제자리로 들어간다. 작은 부품(에칭 등)은 자리 주변에 나눠 놓는다.

`data/out/`, `web/public/demo/`에는 원본 페이지 이미지가 들어가므로 커밋하지 않는다.
