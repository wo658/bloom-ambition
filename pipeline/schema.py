"""VLM 추출 결과 스키마. 설명서 그림에서 읽을 수 있는 사실만 담는다."""
from typing import Literal, Optional

from pydantic import BaseModel, Field

PartKind = Literal["panel", "dowel", "cam_screw", "screw", "bracket", "cover", "pad", "tool"]
PanelRole = Literal[
    "outer_top", "outer_bottom", "outer_left", "outer_right",
    "divider_vertical", "shelf_left", "shelf_right",
]


class Part(BaseModel):
    id: str = Field(description="IKEA 부품 번호(예: 101339). 판재처럼 번호가 없으면 역할 이름")
    kind: PartKind
    name_ko: str
    qty: int
    role: Optional[PanelRole] = Field(None, description="판재일 때 완성품에서의 위치")
    page: int


class PartUse(BaseModel):
    part_id: str
    qty: int


class Step(BaseModel):
    number: int
    page: int
    caption_ko: str = Field(description="그림만 보고 쓴 한국어 설명. 한 문장에 동작 하나씩, 문장마다 줄바꿈")
    adds: list[str] = Field(description="이 단계에서 새로 붙는 판재 id")
    uses: list[PartUse] = Field(description="이 단계에서 쓰는 소형 부품·공구와 수량")
    warning_ko: Optional[str] = None
    confidence: float = Field(ge=0, le=1, description="그림 해석 확신도")


class Manual(BaseModel):
    product: str
    grid: tuple[int, int] = Field(description="(가로 칸 수, 세로 칸 수)")
    outer_size_cm: tuple[float, float, float] = Field(description="폭, 높이, 깊이")
    parts: list[Part]
    steps: list[Step]
    safety_ko: list[str]
    extracted_by: str = ""
