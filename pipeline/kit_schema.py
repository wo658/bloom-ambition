"""프라모델처럼 부품이 많고 곡면이라 3D 근사가 어려운 설명서용 스키마.
3D 대신 원본 페이지 위에 단계 영역과 부품 번호 위치를 표시한다."""
from typing import Optional

from pydantic import BaseModel, Field


class Marking(BaseModel):
    id: str = Field(description="설명서의 마킹(도색 사양) 기호, 예: A")
    title_ko: str
    page: int


class PartRef(BaseModel):
    id: str = Field(description="사출 틀 부품(B12) 또는 에칭 부품(PE45) 번호")
    markings: Optional[list[str]] = Field(None, description="특정 마킹에서만 쓰면 그 기호들")
    optional: bool = False


class KitStep(BaseModel):
    id: str = Field(description="서브조립 기호(A~S)가 있으면 그 기호, 없으면 p<쪽>-<이름>")
    label: Optional[str] = Field(None, description="설명서에 찍힌 서브조립 기호")
    page: int
    region: tuple[float, float, float, float] = Field(description="페이지 기준 0~1 좌표 (x0, y0, x1, y1)")
    title_ko: str
    caption_ko: str
    parts: list[PartRef]
    uses_steps: list[str] = Field(default_factory=list, description="이 단계에 들어가는 앞 단계 id")
    markings: Optional[list[str]] = Field(None, description="특정 마킹에서만 하는 단계면 그 기호들")
    paints_ko: list[str] = Field(default_factory=list)
    warning_ko: Optional[str] = None
    confidence: float = Field(ge=0, le=1)


class KitManual(BaseModel):
    kind: str = "kit"
    product: str
    markings: list[Marking]
    steps: list[KitStep]
    notes_ko: list[str]
    extracted_by: str = ""
