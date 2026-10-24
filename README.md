# Stepcast

**Stepcast turns paper and PDF assembly manuals into step-by-step 3D guides.**

브랜드가 가진 종이·PDF 조립 설명서를 올리면, AI가 부품과 조립 순서를 읽어 고객이 따라 하는 3D 조립 안내로 바꿔 줍니다.

- 데모: https://bloom-ambition.vercel.app/ (심사위원용 오프닝 → 끝나면 기능 소개 재생이 이어집니다. ← → 로 장면 이동, Esc나 화면을 만지면 멈춤)
- 오프닝 없이 바로 재생: https://bloom-ambition.vercel.app/?intro=0
- 오프닝·재생 없이 보기: https://bloom-ambition.vercel.app/?intro=0&tour=0

## 무엇을 하나

- 설명서 PDF에서 부품표·조립 단계·주의 문구를 Claude 비전으로 추출합니다.
- 단계마다 필요한 부품이 제자리로 들어가는 3D 애니메이션을 보여 줍니다.
- 원본 설명서 페이지를 나란히 띄워 대조할 수 있습니다.
- 10개 언어 안내와 음성 읽기를 지원합니다.

## 구조

| 폴더 | 내용 |
|---|---|
| `pipeline/` | PDF → 페이지 이미지 → 구조화 추출(`manual.json`) → 3D 배치(`scene.json`). 자세한 내용은 [pipeline/README.md](pipeline/README.md) |
| `web/` | Vite + React Three Fiber 3D 뷰어, Vercel 배포 |

## 실행

```bash
cd web && npm install && npm run dev
```

샘플 설명서 원본과 추출 결과는 저작권 때문에 커밋하지 않습니다(`pipeline/README.md` 참고). 데모의 KALLAX는 예시 설명서이며 IKEA와 관계가 없습니다.
