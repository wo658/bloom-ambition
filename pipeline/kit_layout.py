"""3단계(kit): KitManual JSON → scene JSON.

가구(layout.py)처럼 부품 자리(role)마다 형상·최종 위치·삽입 방향을 규칙으로 정하고,
단계 순서대로 조각을 배치한다. 단위는 cm(1/48 축척 모형 실제 크기), 원점은 동체 축 위 날개 앞전 부근,
+x 왼쪽(좌현), +y 위, +z 앞(기수).

서브조립(주날개, 꼬리날개, 엔진, 카울링, 착륙장치, 프로펠러, 캐노피, 외부 장착물)은
설명서처럼 기체 옆에서 따로 만들다가, 그 서브조립을 끼우는 단계에서 제자리로 들어간다.
"""
import json
import math
import sys
from collections import Counter, defaultdict
from pathlib import Path

from typing import get_args

from kit_schema import KitManual, PartRole

# 동체 단면(z, 반폭, 반높이, 중심 높이). A6M2 실기 9.06m를 1/48로 줄인 값에 맞춘 근사.
FUSELAGE = [
    [6.3, 1.22, 1.24, 0.0], [5.0, 1.25, 1.32, 0.05], [3.5, 1.25, 1.40, 0.1], [1.5, 1.18, 1.42, 0.12],
    [-0.5, 1.08, 1.32, 0.15], [-3.0, 0.90, 1.10, 0.25], [-5.5, 0.64, 0.84, 0.35], [-7.5, 0.42, 0.62, 0.45],
    [-9.2, 0.20, 0.40, 0.55], [-9.9, 0.05, 0.16, 0.6],
]
# 윗면이 열린 구간(z0, z1, 위에서부터 잘린 각도): 기수 윗덮개 자리, 조종석.
FUSELAGE_CUTS = [[4.2, 6.3, 42], [-0.4, 3.6, 40]]
FIN = [[-5.6, 0.95], [-8.3, 3.15], [-8.9, 3.45], [-9.35, 3.45], [-9.35, 0.55]]

# 주날개: |x|에 대한 1차식 [뿌리 값, 기울기]. 끝은 tip부터 span까지 둥글게 줄어든다.
WING = {"span": 12.5, "tip": 11.0, "le": [3.1, -0.06], "te": [-2.6, 0.12], "y": [-1.15, 0.105], "t": [0.6, -0.032]}
STAB = {"span": 5.0, "tip": 4.2, "le": [-7.3, -0.17], "te": [-9.4, 0.05], "y": [0.45, 0.0], "t": [0.22, -0.024]}

COLORS = {
    "exterior": "#c9c7b2",  # 아메이로(회녹색)
    "interior": "#7f9160",  # 조종석·바퀴 격납고 인테리어 그린
    "cowl": "#2b2f36",
    "engine": "#3a3a3a",
    "metal": "#a7abb2",
    "tire": "#262626",
    "clear": "#cfe6ff",
    "pe": "#b8b39e",
    "jig": "#8ec9f0",
    "red": "#e24b4b",
    "blue": "#4b8fe2",
}


def wing(side: int, x0: float, x1: float, surface: str, v=(0.0, 1.0), cut=None, base=WING) -> dict:
    return {"model": "wing", "dims": {**base, "side": side, "x0": x0, "x1": x1, "surface": surface,
                                       "v0": v[0], "v1": v[1], **({"cut": cut} if cut else {})}}


def at(base: dict, x: float) -> float:
    return base[0] + base[1] * abs(x)


def wing_y(x: float, top: bool) -> float:
    return at(WING["y"], x) + (0.5 if top else -0.5) * at(WING["t"], x)


def prim(model: str, dims: dict, pos, frm, module: str, color: str, rot=(0, 0, 0), **extra) -> dict:
    return {"model": model, "dims": dims, "pos": list(pos), "rot": list(rot), "from": list(frm),
            "module": module, "color": color, **extra}


def detail(pos, spread, frm, module: str, **extra) -> dict:
    return {"model": "detail", "pos": list(pos), "spread": list(spread), "from": list(frm), "module": module, **extra}


AILERON_CUT = {"x": [6.6, 11.2], "v": 0.78}
TIP_LIGHT = (12.2, wing_y(12.2, False) + 0.15, 1.3)

# role → 형상·위치. mirror: 좌우 한 쌍으로 그린다. sided: 같은 단계에서 두 번째 부품은 반대편(x 반전).
# 절대 좌표 형상(동체 반쪽, 날개 등)은 pos가 원점이고 c·r로 카메라 초점을 잡는다.
ROLES: dict[str, dict] = {
    # 동체
    "fuselage_left": {"model": "fuselage_half", "dims": {"side": 1, "profile": FUSELAGE, "cuts": FUSELAGE_CUTS, "fin": FIN, "fin_t": 0.12},
                      "pos": [0, 0, 0], "from": [4, 0, 0], "module": "fuse_left", "color": "exterior", "c": [0.6, 0.6, -1.5], "r": 9},
    "fuselage_right": {"model": "fuselage_half", "dims": {"side": -1, "profile": FUSELAGE, "cuts": FUSELAGE_CUTS, "fin": FIN, "fin_t": 0.12},
                       "pos": [0, 0, 0], "from": [-4, 0, 0], "module": "fuse_right", "color": "exterior", "c": [-0.6, 0.6, -1.5], "r": 9},
    "nose_deck": prim("shell", {"z0": 4.2, "z1": 6.3, "r0": 1.33, "r1": 1.28, "cy": 0.05, "a0": -42, "a1": 42}, (0, 0, 0), (0, 3, 0),
                      "airframe", "exterior", c=[0, 1.2, 5.2], r=2),
    "rudder": prim("polygon", {"pts": [[-9.35, 3.42], [-9.75, 3.2], [-10.3, 1.7], [-10.25, 0.5], [-9.35, 0.5]], "t": 0.18},
                   (0, 0, 0), (0, 0, -3), "airframe", "exterior", c=[0, 2, -9.8], r=2),
    "tail_inner_frame": prim("box", {"size": [0.3, 0.2, 3.0]}, (0, -0.05, -6.0), (0, 2.5, 0), "airframe", "interior"),
    "sidewall_left_detail": detail((0.95, -0.1, 1.6), (0.05, 0.9, 3.2), (-2.5, 0, 0), "fuse_left"),
    "sidewall_right_detail": detail((-0.95, -0.1, 1.6), (0.05, 0.9, 3.2), (2.5, 0, 0), "fuse_right"),
    "fuselage_detail": detail((1.0, 0.6, -2.0), (0.02, 0.2, 0.3), (2, 0, 0), "airframe"),
    "tail_hook": prim("cyl", {"r": 0.05, "len": 2.6, "axis": "z"}, (0, -0.75, -6.6), (0, -2, 0), "airframe", "metal"),
    # 조종석
    "cockpit_floor": prim("box", {"size": [1.9, 0.08, 3.6]}, (0, -0.82, 1.6), (0, -2.5, 0), "cockpit", "interior"),
    "cockpit_floor_detail": detail((0, -0.7, 1.8), (1.4, 0.1, 2.8), (0, 2.5, 0), "cockpit"),
    "rudder_pedals": prim("box", {"size": [1.1, 0.35, 0.25]}, (0, -0.55, 3.1), (0, 0, 2.5), "cockpit", "interior"),
    "pedal_detail": detail((0, -0.45, 3.2), (0.9, 0.1, 0.05), (0, 2, 0), "cockpit"),
    "seat": prim("seat", {"w": 0.9, "h": 0.9, "d": 0.75}, (0, -0.3, 1.0), (0, 3, 0), "cockpit", "interior"),
    "seat_belts": detail((0, 0.05, 1.2), (0.6, 0.6, 0.1), (0, 0, 2), "cockpit"),
    "bulkhead": prim("box", {"size": [2.0, 2.2, 0.08]}, (0, 0.05, 0.5), (0, 0, -2.5), "cockpit", "interior"),
    "bulkhead_detail": detail((0, -0.3, 0.62), (1.4, 1.2, 0.05), (0, 0, 2), "cockpit"),
    "headrest": prim("box", {"size": [0.6, 0.5, 0.15]}, (0, 1.25, 0.45), (0, 2.5, 0), "cockpit", "interior"),
    "instrument_panel": prim("box", {"size": [1.9, 1.0, 0.08]}, (0, 0.35, 3.35), (0, 0, 2.5), "cockpit", "interior"),
    "instrument_panel_detail": detail((0, 0.35, 3.29), (1.4, 0.7, 0.01), (0, 0, -2), "cockpit"),
    "console_left": prim("box", {"size": [0.3, 0.5, 2.0]}, (0.75, -0.5, 2.0), (2.5, 0, 0), "cockpit", "interior"),
    "console_left_detail": detail((0.72, -0.22, 2.0), (0.2, 0.02, 1.6), (0, 2, 0), "cockpit"),
    "radio_box": prim("box", {"size": [0.55, 0.6, 0.9]}, (-0.6, -0.45, 2.6), (-2.5, 0, 0), "cockpit", "interior"),
    "radio_detail": detail((-0.6, -0.2, 2.6), (0.4, 0.5, 0.6), (-2, 0, 0), "cockpit"),
    "gun_mount": prim("box", {"size": [1.4, 0.7, 0.6]}, (0, 0.6, 4.4), (0, 2.5, 0), "cockpit", "interior"),
    "fuselage_gun": prim("cyl", {"r": 0.07, "len": 3.6, "axis": "z"}, (0.35, 0.95, 5.4), (0, 2.5, 0), "cockpit", "engine", sided=True),
    "oxygen_bottles": prim("cyl", {"r": 0.12, "len": 1.2, "axis": "y"}, (0.55, -0.15, 3.8), (0, 2.5, 0), "cockpit", "interior", sided=True),
    "gunsight": prim("box", {"size": [0.25, 0.35, 0.3]}, (0, 0.98, 3.3), (0, 2.5, 0), "cockpit", "engine"),
    # 주날개
    "wing_lower": {**wing(0, 0, WING["span"], "lower", cut=AILERON_CUT), "pos": [0, 0, 0], "from": [0, -3, 0],
                   "module": "wing", "color": "exterior", "c": [0, -1, 0.3], "r": 12},
    "wing_upper_left": {**wing(1, 1.0, WING["span"], "upper", cut=AILERON_CUT), "pos": [0, 0, 0], "from": [0, 3, 0],
                        "module": "wing", "color": "exterior", "c": [6.5, -0.4, 0.3], "r": 7},
    "wing_upper_right": {**wing(-1, 1.0, WING["span"], "upper", cut=AILERON_CUT), "pos": [0, 0, 0], "from": [0, 3, 0],
                         "module": "wing", "color": "exterior", "c": [-6.5, -0.4, 0.3], "r": 7},
    "wing_insert": prim("box", {"size": [1.3, 0.04, 1.1]}, (4.2, -1.3, 0.4), (0, -2, 0), "wing", "exterior", sided=True),
    "wing_spar": prim("box", {"size": [7.0, 0.45, 0.12]}, (0, -1.05, -0.9), (0, 2.5, 0), "wing", "interior"),
    "wheel_well_left": prim("box", {"size": [3.0, 0.4, 0.1]}, (3.2, -1.05, 1.9), (0, 2, 0), "wing", "interior"),
    "wheel_well_right": prim("box", {"size": [3.0, 0.4, 0.1]}, (-3.2, -1.05, 1.9), (0, 2, 0), "wing", "interior"),
    "wheel_well_roof": prim("box", {"size": [1.6, 0.05, 1.3]}, (3.0, -0.85, 1.2), (0, 2.5, 0), "wing", "interior", sided=True),
    "wing_center_detail": detail((0, -0.95, -0.2), (1.6, 0.3, 1.2), (0, 2.5, 0), "wing"),
    "aileron_left": {**wing(1, *AILERON_CUT["x"], "both", v=(AILERON_CUT["v"], 1)), "pos": [0, 0, 0], "from": [0, 0, -2.5],
                     "module": "wing", "color": "exterior", "c": [8.9, -0.3, -0.4], "r": 3},
    "aileron_right": {**wing(-1, *AILERON_CUT["x"], "both", v=(AILERON_CUT["v"], 1)), "pos": [0, 0, 0], "from": [0, 0, -2.5],
                      "module": "wing", "color": "exterior", "c": [-8.9, -0.3, -0.4], "r": 3},
    "wingtip_light_left": prim("dome", {"r": 0.16}, TIP_LIGHT, (2, 0, 0), "wing", "red"),
    "wingtip_light_right": prim("dome", {"r": 0.16}, (-TIP_LIGHT[0], *TIP_LIGHT[1:]), (-2, 0, 0), "wing", "blue"),
    "wing_light": prim("dome", {"r": 0.1}, (8.0, wing_y(8, True), 0.5), (0, 2, 0), "airframe", "clear", mirror=True),
    "wing_cannon": prim("cyl", {"r": 0.06, "len": 1.2, "axis": "z"}, (3.6, -1.0, 3.3), (0, 0, 2.5), "airframe", "engine", mirror=True),
    "wing_detail": detail((5.5, wing_y(5.5, True), -0.3), (0.3, 0.02, 0.3), (0, 2, 0), "airframe", mirror=True),
    "pitot": prim("cyl", {"r": 0.04, "len": 1.8, "axis": "z"}, (9.0, wing_y(9, False) - 0.12, 2.6), (0, 0, 3), "airframe", "metal"),
    # 꼬리날개
    "stabilizer_left_top": {**wing(1, 0.45, STAB["span"], "upper", v=(0, 0.62), base=STAB), "pos": [0, 0, 0], "from": [0, 2, 0],
                            "module": "tail_left", "color": "exterior", "c": [2.7, 0.45, -8.4], "r": 3},
    "stabilizer_left_bottom": {**wing(1, 0.45, STAB["span"], "lower", v=(0, 0.62), base=STAB), "pos": [0, 0, 0], "from": [0, -2, 0],
                               "module": "tail_left", "color": "exterior", "c": [2.7, 0.45, -8.4], "r": 3},
    "elevator_left": {**wing(1, 0.45, STAB["span"], "both", v=(0.62, 1), base=STAB), "pos": [0, 0, 0], "from": [0, 0, -2],
                      "module": "tail_left", "color": "exterior", "c": [2.7, 0.45, -9.1], "r": 3},
    "stabilizer_right_top": {**wing(-1, 0.45, STAB["span"], "upper", v=(0, 0.62), base=STAB), "pos": [0, 0, 0], "from": [0, 2, 0],
                             "module": "tail_right", "color": "exterior", "c": [-2.7, 0.45, -8.4], "r": 3},
    "stabilizer_right_bottom": {**wing(-1, 0.45, STAB["span"], "lower", v=(0, 0.62), base=STAB), "pos": [0, 0, 0], "from": [0, -2, 0],
                                "module": "tail_right", "color": "exterior", "c": [-2.7, 0.45, -8.4], "r": 3},
    "elevator_right": {**wing(-1, 0.45, STAB["span"], "both", v=(0.62, 1), base=STAB), "pos": [0, 0, 0], "from": [0, 0, -2],
                       "module": "tail_right", "color": "exterior", "c": [-2.7, 0.45, -9.1], "r": 3},
    "elevator_hinge": detail((2.5, 0.5, -8.7), (0.05, 0.02, 0.05), (0, 1.5, 0), "airframe", mirror=True),
    "tail_light": prim("dome", {"r": 0.1}, (0, 1.0, -10.25), (0, 0, -1.5), "airframe", "clear"),
    # 엔진·카울링·프로펠러
    "engine_mount_plate": prim("disc", {"r": 1.15, "t": 0.1}, (0, 0, 6.7), (0, 0, 3), "airframe", "engine"),
    "engine_rear_row": prim("radial", {"n": 7, "r_in": 0.4, "r_out": 1.12, "cyl_r": 0.2, "t": 0.4, "phase": 0}, (0, 0, 7.35), (0, 0, 2), "engine", "engine"),
    "engine_front_row": prim("radial", {"n": 7, "r_in": 0.4, "r_out": 1.1, "cyl_r": 0.2, "t": 0.4, "phase": 0.5}, (0, 0, 7.85), (0, 0, 2), "engine", "engine"),
    "engine_ignition_ring": prim("ring", {"r": 0.6, "tube": 0.06}, (0, 0, 8.2), (0, 0, 2), "engine", "metal"),
    "engine_front_case": prim("cyl", {"r": 0.55, "r2": 0.3, "len": 0.6, "axis": "z"}, (0, 0, 8.5), (0, 0, 2), "engine", "metal"),
    "cowl_front_ring": prim("shell", {"z0": 8.75, "z1": 9.15, "r0": 1.37, "r1": 1.2, "cy": 0, "a0": -180, "a1": 180}, (0, 0, 0), (0, 0, 2),
                            "cowling", "cowl", c=[0, 0, 8.9], r=1.6),
    "cowl_top": prim("shell", {"z0": 6.25, "z1": 8.75, "r0": 1.33, "r1": 1.37, "cy": 0, "a0": -50, "a1": 50}, (0, 0, 0), (0, 2.5, 0),
                     "cowling", "cowl", c=[0, 1, 7.5], r=1.8),
    "cowl_left": prim("shell", {"z0": 6.25, "z1": 8.75, "r0": 1.33, "r1": 1.37, "cy": 0, "a0": 50, "a1": 180}, (0, 0, 0), (2.5, 0, 0),
                      "cowling", "cowl", c=[1, -0.4, 7.5], r=1.8),
    "cowl_right": prim("shell", {"z0": 6.25, "z1": 8.75, "r0": 1.33, "r1": 1.37, "cy": 0, "a0": -180, "a1": -50}, (0, 0, 0), (-2.5, 0, 0),
                       "cowling", "cowl", c=[-1, -0.4, 7.5], r=1.8),
    "exhaust_left": prim("box", {"size": [0.25, 0.2, 0.6]}, (1.15, -0.8, 6.1), (1.5, 0, 0), "cowling", "engine"),
    "exhaust_right": prim("box", {"size": [0.25, 0.2, 0.6]}, (-1.15, -0.8, 6.1), (-1.5, 0, 0), "cowling", "engine"),
    "cowl_jig": prim("cyl", {"r": 1.18, "len": 2.4, "axis": "z", "open": True}, (0, 0, 7.6), (0, 0, -2.5), "cowling", "jig"),
    "cowl_detail": detail((0, 1.38, 7.6), (0.4, 0.02, 1.4), (0, 2, 0), "cowling"),
    "intake_mesh": prim("box", {"size": [0.9, 0.04, 0.5]}, (0, -1.47, 3.4), (0, -2, 0), "airframe", "pe"),
    "prop_blades": prim("blades", {"n": 3, "radius": 2.9, "chord": 0.45}, (0, 0, 9.75), (0, 0, 2), "prop", "metal", r=3),
    "spinner": prim("cyl", {"r": 0.5, "r2": 0.06, "len": 1.0, "axis": "z"}, (0, 0, 10.25), (0, 0, 2), "prop", "metal"),
    "spinner_back": prim("disc", {"r": 0.5, "t": 0.12}, (0, 0, 9.65), (0, 0, 2), "prop", "metal"),
    # 착륙장치
    "gear_leg_left": prim("cyl", {"r": 0.11, "len": 2.8, "axis": "y"}, (3.25, -2.8, 1.35), (0, -2.5, 0), "gear_left", "metal"),
    "gear_leg_right": prim("cyl", {"r": 0.11, "len": 2.8, "axis": "y"}, (-3.25, -2.8, 1.35), (0, -2.5, 0), "gear_right", "metal"),
    "gear_door_left": prim("box", {"size": [0.05, 2.3, 1.0]}, (3.45, -2.7, 1.35), (2, 0, 0), "gear_left", "exterior"),
    "gear_door_right": prim("box", {"size": [0.05, 2.3, 1.0]}, (-3.45, -2.7, 1.35), (-2, 0, 0), "gear_right", "exterior"),
    "gear_detail_left": detail((3.25, -2.4, 1.48), (0.05, 1.5, 0.05), (1.5, 0, 0), "gear_left"),
    "gear_detail_right": detail((-3.25, -2.4, 1.48), (0.05, 1.5, 0.05), (-1.5, 0, 0), "gear_right"),
    "wheel_left": prim("wheel", {"r": 0.66, "w": 0.32}, (2.95, -4.25, 1.35), (0, 0, 2), "gear_left", "tire"),
    "wheel_right": prim("wheel", {"r": 0.66, "w": 0.32}, (-2.95, -4.25, 1.35), (0, 0, 2), "gear_right", "tire"),
    "hub_left": prim("hub", {"r": 0.36, "w": 0.36}, (2.95, -4.25, 1.35), (1.5, 0, 0), "gear_left", "metal"),
    "hub_right": prim("hub", {"r": 0.36, "w": 0.36}, (-2.95, -4.25, 1.35), (-1.5, 0, 0), "gear_right", "metal"),
    "inner_gear_door": prim("box", {"size": [0.9, 0.05, 1.3]}, (1.0, -1.55, 1.4), (0, -2, 0), "airframe", "exterior", sided=True),
    "small_gear_door": prim("box", {"size": [0.04, 0.6, 0.5]}, (3.65, -1.55, 1.0), (0, -1.5, 0), "airframe", "exterior", sided=True),
    "tail_wheel_fork": prim("box", {"size": [0.12, 1.7, 0.35]}, (0, -1.35, -8.55), (0, -2, 0), "tailwheel", "exterior"),
    "tail_wheel": prim("wheel", {"r": 0.28, "w": 0.15}, (0, -2.3, -8.65), (0, -1.5, 0), "tailwheel", "tire"),
    # 캐노피·외부 장착물
    "windscreen": prim("canopy", {"z0": 2.8, "z1": 3.55, "w0": 0.62, "w1": 0.45, "h0": 0.95, "h1": 0.5, "y": 1.18},
                       (0, 0, 0), (0, 2.5, 0), "airframe", "clear", c=[0, 1.6, 3.2], r=1.2),
    "canopy_slider": prim("canopy", {"z0": 0.9, "z1": 2.8, "w0": 0.62, "w1": 0.62, "h0": 0.95, "h1": 0.95, "y": 1.2},
                          (0, 0, 0), (0, 2.5, 0), "canopy", "clear", c=[0, 1.7, 1.85], r=1.4),
    "canopy_rear": prim("canopy", {"z0": -1.1, "z1": 0.9, "w0": 0.25, "w1": 0.62, "h0": 0.25, "h1": 0.95, "y": 1.18},
                        (0, 0, 0), (0, 2.5, 0), "airframe", "clear", c=[0, 1.6, -0.1], r=1.4),
    "canopy_detail": detail((0, 1.8, 1.8), (0.8, 0.3, 1.2), (0, 1.5, 0), "canopy"),
    "antenna_mast": prim("cyl", {"r": 0.05, "len": 2.6, "axis": "y"}, (0, 2.6, -1.6), (0, 2.5, 0), "airframe", "exterior", rot=(-10, 0, 0)),
    "fuel_cap": prim("dome", {"r": 0.15}, (0, 1.36, 4.6), (0, 2, 0), "airframe", "metal"),
    "drop_tank_left": prim("capsule", {"r": 0.62, "len": 6.2, "half": 1}, (0, -2.45, 0.3), (2, 0, 0), "stores", "exterior"),
    "drop_tank_right": prim("capsule", {"r": 0.62, "len": 6.2, "half": -1}, (0, -2.45, 0.3), (-2, 0, 0), "stores", "exterior"),
    "drop_tank_strut": prim("box", {"size": [0.12, 0.45, 1.2]}, (0, -1.62, 0.3), (0, -1.5, 0), "stores", "exterior"),
    "center_bomb": prim("capsule", {"r": 0.38, "len": 3.6, "half": 1, "fins": 1}, (0, -2.15, 0.6), (2, 0, 0), "stores", "engine", sided=True),
    "center_bomb_detail": detail((0, -2.15, 0.6), (0.5, 0.5, 3.0), (0, -1.5, 0), "stores"),
    "bomb_rack_center": prim("box", {"size": [0.2, 0.25, 2.6]}, (0, -1.65, 0.6), (0, -1.5, 0), "stores", "metal"),
    "wing_bomb": prim("capsule", {"r": 0.22, "len": 2.0, "half": 0, "fins": 1}, (5.6, -1.3, 0.7), (0, -1.5, 0), "stores", "engine", mirror=True),
    "wing_bomb_detail": detail((5.6, -1.3, -0.2), (0.3, 0.3, 0.2), (0, -1.5, 0), "stores", mirror=True),
    "wing_bomb_rack": prim("box", {"size": [0.15, 0.2, 1.3]}, (5.6, -0.95, 0.7), (0, -1.5, 0), "airframe", "metal", mirror=True),
    "wing_mast": prim("cyl", {"r": 0.04, "len": 0.5, "axis": "y"}, (9.5, wing_y(9.5, True) + 0.25, 0.6), (0, 1.5, 0), "airframe", "metal", mirror=True),
}

assert set(ROLES) == set(get_args(PartRole)), set(ROLES) ^ set(get_args(PartRole))

# 서브조립을 따로 만드는 동안 놓아 둘 자리(최종 위치에서 얼마나 떨어뜨릴지).
MODULE_OFFSET = {
    "fuse_left": [4.5, 0, 0], "fuse_right": [-4.5, 0, 0], "wing": [0, -5, 0],
    "tail_left": [4, 0, -3], "tail_right": [-4, 0, -3], "engine": [0, 0, 6], "cowling": [0, 0, 11],
    "gear_left": [4, -1.5, 0], "gear_right": [-4, -1.5, 0], "tailwheel": [0, -1.5, -3],
    "stores": [0, -3, 0], "prop": [0, 0, 9], "canopy": [0, 3.5, 0],
}
BENCH_HEIGHT = 7.5  # 착륙장치를 달기 전에는 작업대 위에 수평으로 띄워 둔다.
DETAIL_SIZE = {"plastic": 0.28, "photo_etch": 0.32, "clear": 0.2, "jig": 0.3}
GOLDEN = (math.sqrt(5) - 1) / 2


def mirrored(v):
    return [-v[0], *v[1:]]


def size_of(piece: dict) -> float:
    d = piece["dims"]
    if "size" in d:
        return max(d["size"]) / 2
    return max(d.get("len", 0) / 2, d.get("r", 0), d.get("radius", 0), d.get("r_out", 0), 0.3)


class Layout:
    def __init__(self, manual: KitManual):
        self.manual = manual
        self.kinds = {p.id: p for p in manual.parts}
        self.detail_total = Counter(u.role for s in manual.steps for u in s.adds if "spread" in ROLES[u.role])
        self.detail_used = Counter()

    def detail_pos(self, role: str) -> list[float]:
        spec = ROLES[role]
        k = self.detail_used[role]
        self.detail_used[role] += 1
        n = max(self.detail_total[role], 1)
        f = [(k * GOLDEN) % 1, (k * GOLDEN * GOLDEN + 0.5) % 1, (k + 0.5) / n]
        return [p + (fi - 0.5) * s for p, fi, s in zip(spec["pos"], f, spec["spread"])]

    def pieces(self, step_index: int, step) -> list[dict]:
        out = []
        seen: dict[str, list] = defaultdict(list)  # role → 앞서 이 단계에서 같은 자리에 쓴 부품의 마킹
        for use in step.adds:
            spec = ROLES[use.role]
            part = self.kinds[use.id]
            side = 1
            if spec.get("sided") and seen[use.role]:
                side = -1
            overlap = any(m is None or use.markings is None or set(m) & set(use.markings) for m in seen[use.role])
            seen[use.role].append(use.markings)
            as_detail = "spread" in spec or (overlap and not spec.get("sided"))
            base = {"step": step_index, "part_id": use.id, "kind": part.kind, "markings": use.markings,
                    "module": spec["module"], "temp": part.kind == "jig"}
            if use.optional:
                continue  # 고르지 않은 대체 부품은 부품 목록에만 남긴다.
            if as_detail:
                pos = self.detail_pos(use.role) if "spread" in spec else [
                    p + (0.25 * (len(seen[use.role]) - 1)) for p in spec["pos"]]
                kind = part.kind if part.kind != "jig" else "plastic"
                piece = {**base, "model": "detail", "dims": {"kind": kind, "size": DETAIL_SIZE[kind]},
                         "pos": pos, "rot": [0, 0, 0], "from": list(spec["from"]),
                         "color": COLORS["pe" if kind == "photo_etch" else "clear" if kind == "clear" else "interior"
                                         if spec["module"] in ("cockpit", "fuse_left", "fuse_right") else "exterior"]}
            else:
                piece = {**base, "model": spec["model"], "dims": spec["dims"], "pos": list(spec["pos"]),
                         "rot": list(spec.get("rot", [0, 0, 0])), "from": list(spec["from"]), "color": COLORS[spec["color"]]}
                if "c" in spec:
                    piece["focus"] = [*spec["c"], spec["r"]]
            if side < 0:
                piece = self.flip(piece)
            out.append(piece)
            if spec.get("mirror"):
                out.append(self.flip(piece))
        for n, piece in enumerate(out):
            piece["key"] = f"{step.id}/{piece['part_id']}/{n}"
        return out

    @staticmethod
    def flip(piece: dict) -> dict:
        flipped = {**piece, "pos": mirrored(piece["pos"]), "from": mirrored(piece["from"]),
                   "rot": [piece["rot"][0], -piece["rot"][1], -piece["rot"][2]]}
        if "focus" in piece:
            flipped["focus"] = [*mirrored(piece["focus"][:3]), piece["focus"][3]]
        dims = piece["dims"]
        if "side" in dims or "half" in dims:
            flipped["dims"] = {**dims, **({"side": -dims["side"]} if "side" in dims else {}),
                               **({"half": -dims["half"]} if "half" in dims else {})}
        return flipped


def step_module(pieces: list[dict], uses: list[str]) -> str | None:
    counts = Counter(p["module"] for p in pieces)
    return counts.most_common(1)[0][0] if counts else None


def joins(manual: KitManual, step_modules: list[str | None]) -> dict[str, int]:
    """서브조립 → 그것을 기체에 끼우는 단계 번호(인덱스). 다른 모듈 단계가 그 서브조립 단계를 처음 쓰는 곳."""
    index = {s.id: i for i, s in enumerate(manual.steps)}
    out = {}
    for i, step in enumerate(manual.steps):
        for used in step.uses_steps:
            m = step_modules[index[used]] if used in index else None
            if m in MODULE_OFFSET and m != step_modules[i] and m not in out:
                out[m] = i
    return out


def focus(pieces: list[dict], offset_of) -> list[float]:
    pts = []
    for p in pieces:
        off = offset_of(p)
        if "focus" in p:
            c, r = p["focus"][:3], p["focus"][3]
        else:
            c, r = p["pos"], size_of(p) if p["model"] != "detail" else 0.3
        pts.append(([c[i] + off[i] for i in range(3)], r))
    if not pts:
        return [0, 0, 0, 11]
    lo = [min(c[i] for c, _ in pts) for i in range(3)]
    hi = [max(c[i] for c, _ in pts) for i in range(3)]
    center = [(a + b) / 2 for a, b in zip(lo, hi)]
    radius = max(max(math.dist(center, c) + r for c, r in pts), 1.6)
    return [round(v, 3) for v in center] + [round(radius, 3)]


HOME_VIEW = [0.6, 0.42, 0.68]  # 가구 뷰어와 같은 앞·왼쪽·위 시점


def norm(v):
    n = math.hypot(*v)
    return [c / n for c in v] if n > 1e-6 else [0.0, 0.0, 0.0]


def view_dir(vectors: list[list[float]]) -> list[float]:
    """부품이 날아오는 쪽에서 바라보도록 카메라 방향을 정한다(부품이 보는 사람 쪽에서 들어와 붙는다)."""
    v = norm([sum(c) for c in zip(*map(norm, vectors))]) if vectors else [0, 0, 0]
    d = norm([0.9 * a + 0.75 * h + u for a, h, u in zip(v, HOME_VIEW, [0, 0.35, 0])])
    return [round(c, 3) for c in d]


def check(manual: KitManual) -> list[str]:
    issues = []
    ids = {p.id for p in manual.parts}
    step_ids = {s.id for s in manual.steps}
    for s in manual.steps:
        for u in s.adds:
            if u.id not in ids:
                issues.append(f"{s.number}단계 {u.id}: 부품표에 없음")
        for used in s.uses_steps:
            if used not in step_ids:
                issues.append(f"{s.number}단계: 없는 서브조립 {used}")
    used = {u.id for s in manual.steps for u in s.adds}
    for p in manual.parts:
        if p.id not in used:
            issues.append(f"{p.id}({p.name_ko}): 어느 단계에서도 쓰지 않음")
    return issues


def pitch_on_gear() -> tuple[float, float]:
    """주바퀴와 꼬리바퀴 바닥이 모두 땅에 닿는 기수 들림 각도와 그때의 높이."""
    main, tail = ROLES["wheel_left"], ROLES["tail_wheel"]
    my, mz = main["pos"][1] - main["dims"]["r"], main["pos"][2]
    ty, tz = tail["pos"][1] - tail["dims"]["r"], tail["pos"][2]
    a = math.atan2(ty - my, mz - tz)  # 기수를 드는 각도
    height = -(my * math.cos(a) + mz * math.sin(a))
    return a, height


def build_scene(manual: KitManual) -> dict:
    layout = Layout(manual)
    per_step = [layout.pieces(i, s) for i, s in enumerate(manual.steps)]
    modules = [step_module(p, s.uses_steps) for p, s in zip(per_step, manual.steps)]
    join_at = joins(manual, modules)
    gear_at = join_at.get("gear_left", len(manual.steps))
    pitch, height = pitch_on_gear()

    index = {s.id: i for i, s in enumerate(manual.steps)}

    def subtree(i: int) -> list[int]:
        out = [i]
        for used in manual.steps[i].uses_steps:
            if used in index:
                out += subtree(index[used])
        return out

    steps = []
    for i, (step, pieces) in enumerate(zip(manual.steps, per_step)):
        def offset_of(p, i=i):
            m = p["module"]
            return MODULE_OFFSET[m] if m in join_at and i < join_at[m] else [0, 0, 0]
        joined = [m for m, at_ in join_at.items() if at_ == i]
        # 새 부품이 없는 결합 단계는 끼우는 서브조립 전체를 본다.
        targets = list(pieces) or ([] if joined else [p for j in subtree(i) for p in per_step[j] if not p["temp"]])
        targets += [p for ps in per_step[:i] for p in ps if p["module"] in joined and not p["temp"]]
        steps.append({
            **step.model_dump(include={"number", "id", "label", "page", "title_ko", "caption_ko", "uses_steps",
                                       "markings", "paints_ko", "warning_ko", "confidence"}),
            "adds": [{"id": u.id, "name_ko": layout.kinds[u.id].name_ko, "kind": layout.kinds[u.id].kind,
                      "markings": u.markings, "optional": u.optional} for u in step.adds],
            "joins": joined,
            "pose": "on_gear" if i >= gear_at else "bench",
            "focus": focus(targets, offset_of),
            "view": view_dir([p["from"] for p in pieces] or [MODULE_OFFSET[m] for m in joined]),
        })
    return {
        "kind": "kit3d",
        "product": manual.product,
        "scale": manual.scale,
        "markings": [m.model_dump() for m in manual.markings],
        "modules": {m: {"offset": MODULE_OFFSET[m], "join": at_} for m, at_ in join_at.items()},
        "poses": {"bench": {"pitch": 0, "height": BENCH_HEIGHT}, "on_gear": {"pitch": round(pitch, 4), "height": round(height, 3)}},
        "pieces": [p for ps in per_step for p in ps],
        "steps": steps,
        "notes_ko": manual.notes_ko,
        "extracted_by": manual.extracted_by,
        "issues": check(manual),
    }


if __name__ == "__main__":
    manual = KitManual.model_validate_json(Path(sys.argv[1]).read_text())
    scene = build_scene(manual)
    Path(sys.argv[2]).write_text(json.dumps(scene, ensure_ascii=False, indent=1))
    for issue in scene["issues"]:
        print("확인 필요:", issue, file=sys.stderr)
    missing = sorted(set(MODULE_OFFSET) - set(scene["modules"]))
    if missing:
        print("끼우는 단계를 찾지 못한 서브조립:", ", ".join(missing), file=sys.stderr)
    print(sys.argv[2])
