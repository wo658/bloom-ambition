"""프라모델(비행기) 설명서 VLM 추출 결과 스키마. 가구(schema.py)처럼 그림에서 읽을 수 있는 사실만 담는다.
부품마다 완성품에서의 자리(role)를 고르면 kit_layout.py가 3D 형상·위치·삽입 방향을 정한다."""
from typing import Literal, Optional

from pydantic import BaseModel, Field

PartKind = Literal["plastic", "photo_etch", "clear", "jig"]

# 완성된 기체에서의 자리. 왼쪽/오른쪽은 조종사 기준(왼쪽 = 좌현).
PartRole = Literal[
    # 동체
    "fuselage_left", "fuselage_right", "nose_deck", "rudder", "tail_inner_frame",
    "sidewall_left_detail", "sidewall_right_detail", "fuselage_detail", "tail_hook",
    # 조종석
    "cockpit_floor", "cockpit_floor_detail", "rudder_pedals", "pedal_detail",
    "seat", "seat_belts", "bulkhead", "bulkhead_detail", "headrest",
    "instrument_panel", "instrument_panel_detail", "console_left", "console_left_detail",
    "radio_box", "radio_detail", "gun_mount", "fuselage_gun", "oxygen_bottles", "gunsight",
    # 주날개
    "wing_lower", "wing_upper_left", "wing_upper_right", "wing_insert",
    "wing_spar", "wheel_well_left", "wheel_well_right", "wheel_well_roof", "wing_center_detail",
    "aileron_left", "aileron_right", "wingtip_light_left", "wingtip_light_right",
    "wing_light", "wing_cannon", "wing_detail", "pitot",
    # 꼬리날개
    "stabilizer_left_top", "stabilizer_left_bottom", "elevator_left",
    "stabilizer_right_top", "stabilizer_right_bottom", "elevator_right", "elevator_hinge", "tail_light",
    # 엔진·카울링·프로펠러
    "engine_mount_plate", "engine_rear_row", "engine_front_row", "engine_ignition_ring",
    "engine_front_case", "cowl_front_ring", "cowl_top", "cowl_left", "cowl_right",
    "exhaust_left", "exhaust_right", "cowl_jig", "intake_mesh", "cowl_detail",
    "prop_blades", "spinner", "spinner_back",
    # 착륙장치
    "gear_leg_left", "gear_leg_right", "gear_door_left", "gear_door_right", "gear_detail_left", "gear_detail_right",
    "wheel_left", "wheel_right", "hub_left", "hub_right", "inner_gear_door", "small_gear_door",
    "tail_wheel_fork", "tail_wheel",
    # 캐노피·외부 장착물
    "windscreen", "canopy_slider", "canopy_rear", "canopy_detail", "antenna_mast", "fuel_cap",
    "drop_tank_left", "drop_tank_right", "drop_tank_strut", "center_bomb", "center_bomb_detail",
    "bomb_rack_center", "wing_bomb", "wing_bomb_detail", "wing_bomb_rack", "wing_mast",
]


class Marking(BaseModel):
    id: str = Field(description="설명서의 마킹(도색 사양) 기호, 예: A")
    title_ko: str
    page: int


class Part(BaseModel):
    id: str = Field(description="사출 틀 부품(B12) 또는 에칭 부품(PE45) 번호")
    kind: PartKind = Field(description="에칭은 photo_etch, 투명 틀은 clear, 조립을 돕고 빼내는 지그(DO NOT GLUE)는 jig")
    name_ko: str


class PartUse(BaseModel):
    id: str
    role: PartRole = Field(description="완성품에서 이 부품이 가는 자리")
    markings: Optional[list[str]] = Field(None, description="특정 마킹에서만 쓰면 그 기호들")
    optional: bool = Field(False, description="?로 고르는 대체 부품 중 기본이 아닌 쪽")


class KitStep(BaseModel):
    number: int
    id: str = Field(description="서브조립 기호(A~S)가 있으면 그 기호, 없으면 p<쪽>-<이름>")
    label: Optional[str] = Field(None, description="설명서에 찍힌 서브조립 기호")
    page: int
    title_ko: str
    caption_ko: str = Field(description="그림만 보고 쓴 한국어 설명. 한 문장에 동작 하나씩, 문장마다 줄바꿈")
    adds: list[PartUse] = Field(description="이 단계에서 새로 붙는 부품")
    uses_steps: list[str] = Field(default_factory=list, description="이 단계에 끼워 넣는 앞 단계 id")
    markings: Optional[list[str]] = Field(None, description="특정 마킹에서만 하는 단계면 그 기호들")
    paints_ko: list[str] = Field(default_factory=list)
    warning_ko: Optional[str] = None
    confidence: float = Field(ge=0, le=1, description="그림 해석 확신도")


class KitManual(BaseModel):
    kind: str = "kit"
    product: str
    scale: int = Field(description="축척 분모, 예: 48")
    markings: list[Marking]
    parts: list[Part]
    steps: list[KitStep]
    notes_ko: list[str]
    extracted_by: str = ""
