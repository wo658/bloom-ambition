"""3·4단계: Manual JSON → scene JSON.

판재 역할과 외곽 치수로 각 판재의 크기·최종 위치를 규칙으로 계산하고,
단계마다 소형 부품을 결합 지점에 배치한다. 단위는 cm, 원점은 바닥 중앙, +y 위, +z 앞.
"""
import json
import sys
from collections import Counter
from pathlib import Path

from schema import Manual

OUTER_T = 3.8  # 바깥 판 두께
INNER_T = 1.6  # 칸막이 두께
INSERT_DISTANCE = 30  # 판재가 날아 들어오는 거리


def panel_boxes(w: float, h: float, d: float) -> dict[str, dict]:
    iw, ih = w - 2 * OUTER_T, h - 2 * OUTER_T
    cell = (iw - INNER_T) / 2
    side_x = w / 2 - OUTER_T / 2
    shelf_x = INNER_T / 2 + cell / 2
    return {
        "outer_bottom": {"size": [w, OUTER_T, d], "pos": [0, OUTER_T / 2, 0], "from": [0, -1, 0]},
        "outer_top": {"size": [w, OUTER_T, d], "pos": [0, h - OUTER_T / 2, 0], "from": [0, 1, 0]},
        "outer_left": {"size": [OUTER_T, ih, d], "pos": [-side_x, h / 2, 0], "from": [-1, 0, 0]},
        "outer_right": {"size": [OUTER_T, ih, d], "pos": [side_x, h / 2, 0], "from": [1, 0, 0]},
        "divider_vertical": {"size": [INNER_T, ih, d], "pos": [0, h / 2, 0], "from": [0, 0, 1]},
        "shelf_left": {"size": [cell, INNER_T, d], "pos": [-shelf_x, h / 2, 0], "from": [0, 0, 1]},
        "shelf_right": {"size": [cell, INNER_T, d], "pos": [shelf_x, h / 2, 0], "from": [0, 0, 1]},
    }


DOWEL_INSET = 7.0  # 앞뒤 모서리에서 나무못 구멍까지
SCREW_INSET = 5.0  # 앞뒤 모서리에서 연결 볼트 구멍까지
PAD_INSET = 2.0  # 바닥 모서리에서 펠트 패드 중심까지
WALL_GAP = 0.5  # 뒷모서리와 벽 사이

# 부품 번호별 형상과 치수(cm). 설명서 9·10·18~20쪽 그림 비율을 판 두께에 맞춰 잡은 근사값.
HARDWARE = {
    "104321": {"model": "connector_screw", "color": "#a9aeb5", "dims": {
        "length": 7.0, "head_d": 1.0, "head_h": 0.35, "shank_d": 0.5, "smooth": 1.4,
        "thread_d": 0.7, "pitch": 0.28, "socket": 0.4}},
    "101339": {"model": "dowel", "color": "#c8a46e", "dims": {"length": 3.0, "d": 0.8, "flutes": 12}},
    "100372": {"model": "euro_screw", "color": "#9ca3af", "dims": {
        "length": 1.4, "head_d": 0.8, "head_h": 0.2, "shank_d": 0.3, "thread_d": 0.45, "pitch": 0.16}},
    "wall_screw": {"model": "wall_screw", "color": "#6b7280", "dims": {
        "length": 4.0, "head_d": 1.0, "head_h": 0.35, "shank_d": 0.3, "thread_d": 0.5, "pitch": 0.2}},
    "115753": {"model": "corner_bracket", "color": "#e5e4df", "dims": {
        "height": 5.5, "side": 3.2, "wall": 4.4, "t": 0.25, "hole_d": 1.6, "screw_z": 2.2, "screw_x": 1.55}},
    "103693": {"model": "hook_plate", "color": "#b8bcc2", "dims": {
        "width": 2.6, "height": 4.0, "t": 0.12, "key_d": 1.1, "key_y": -0.35, "slot_w": 0.45, "slot_top": 0.9}},
    "115754": {"model": "bracket_cover", "color": "#f5f5f2", "dims": {
        "height": 5.9, "side": 3.6, "wall": 4.8, "t": 0.2, "back": 0.25}},
    "10002300": {"model": "felt_pad", "color": "#9a8a73", "dims": {"r": 1.2, "t": 0.4}},
    "100001": {"model": "hex_key", "color": "#4b5563", "dims": {"long": 7.5, "short": 2.5, "across": 0.4}},
}
# 부품 번호를 모르면 종류별 대표 부품으로 그린다.
KIND_FALLBACK = {"dowel": "101339", "cam_screw": "104321", "screw": "100372",
                 "bracket": "115753", "cover": "115754", "pad": "10002300", "tool": "100001"}


def hardware(part_id: str, kind: str) -> dict:
    spec = HARDWARE.get(part_id) or HARDWARE[KIND_FALLBACK[kind]]
    return {"model": spec["model"], "color": spec["color"], "dims": dict(spec["dims"])}


def dowel_joints(w: float, h: float) -> list[tuple[str, list[float], list[int]]]:
    """(나무못이 맞물릴 판 역할, 결합면 위 점 [x, y], 박는 방향).
    나무못은 먼저 놓인 판에 박혀 결합면에서 반만 나오고, 뒤에 오는 판이 거기에 끼워진다."""
    mid = h / 2
    return [
        ("shelf_left", [-w / 2 + OUTER_T, mid], [-1, 0, 0]),  # 왼쪽 옆판 안쪽 면
        ("divider_vertical", [0, OUTER_T], [0, -1, 0]),  # 바닥판 윗면 가운데
        ("divider_vertical", [-INNER_T / 2, mid], [-1, 0, 0]),  # 왼쪽 선반 오른쪽 끝
        ("shelf_right", [INNER_T / 2, mid], [-1, 0, 0]),  # 칸막이 오른쪽 면
        ("outer_right", [w / 2 - OUTER_T, mid], [-1, 0, 0]),  # 오른쪽 선반 끝
        ("outer_right", [w / 2 - OUTER_T / 2, OUTER_T], [0, -1, 0]),  # 바닥판 오른쪽 끝
        ("outer_top", [0, h - OUTER_T], [0, -1, 0]),  # 칸막이 윗끝
    ]


def corner_joints(w: float, h: float) -> list[tuple[tuple[str, str], list[float], list[int]]]:
    """연결 볼트가 들어가는 네 모서리. 윗·바닥판 바깥 면에서 옆판 끝으로 박는다."""
    xl, xr = -w / 2 + OUTER_T / 2, w / 2 - OUTER_T / 2
    return [
        (("outer_bottom", "outer_left"), [xl, 0], [0, 1, 0]),
        (("outer_bottom", "outer_right"), [xr, 0], [0, 1, 0]),
        (("outer_top", "outer_left"), [xl, h], [0, -1, 0]),
        (("outer_top", "outer_right"), [xr, h], [0, -1, 0]),
    ]


class Placer:
    """단계 순서대로 소형 부품을 실제 구멍 좌표에 하나씩 배정한다."""

    def __init__(self, manual: Manual):
        self.w, self.h, self.d = manual.outer_size_cm
        role_of = {p.id: p.role for p in manual.parts if p.kind == "panel"}
        self.added_at = {role_of[pid]: i for i, s in enumerate(manual.steps) for pid in s.adds}
        never = len(manual.steps)
        joints = sorted(dowel_joints(self.w, self.h), key=lambda j: self.added_at.get(j[0], never))
        dz = self.d / 2 - DOWEL_INSET
        self.dowels = [{"at": [x, y, z], "axis": axis} for _, (x, y), axis in joints for z in (-dz, dz)]
        self.corners = corner_joints(self.w, self.h)
        self.used: Counter = Counter()
        bracket = HARDWARE["115753"]["dims"]
        self.bracket = bracket
        # 벽 고정 브래킷: 왼쪽 옆판 안쪽 면과 칸막이 오른쪽 면의 윗판 바로 아래 뒤 모서리(18쪽)
        y = self.h - OUTER_T - bracket["height"] / 2
        z = -self.d / 2 + bracket["t"]
        self.bracket_origins = [[-self.w / 2 + OUTER_T, y, z], [INNER_T / 2, y, z]]
        self.wall_z = -self.d / 2 - WALL_GAP

    def take(self, key: str, pool: list) -> dict:
        n = self.used[key]
        self.used[key] += 1
        return pool[n % len(pool)]

    def corner_screws(self, index: int, qty: int) -> list[dict]:
        ready = [c for c in self.corners if all(self.added_at.get(r, 1e9) <= index for r in c[0])]
        ready += [c for c in self.corners if c not in ready]
        slots = []
        dz = self.d / 2 - SCREW_INSET
        for (_, (x, y), axis) in ready:
            if self.used[("corner", x, y)]:
                continue
            self.used[("corner", x, y)] = 1
            slots += [{"at": [x, y, z], "axis": axis} for z in (-dz, dz)]
            if len(slots) >= qty:
                break
        return slots[:qty]

    def place(self, index: int, model: str, dims: dict, qty: int) -> list[dict]:
        b = self.bracket
        frame = {"axis": [-1, 0, 0], "up": [0, 0, 1]}  # 브래킷 로컬: +Y 판 쪽, +Z 앞, +X 위
        if model == "dowel":
            return [self.take("dowel", self.dowels) for _ in range(qty)]
        if model == "connector_screw":
            return self.corner_screws(index, qty)
        if model == "felt_pad":
            sx, sz = self.w / 2 - PAD_INSET, self.d / 2 - PAD_INSET
            pads = [{"at": [x, 0, z], "axis": [0, 1, 0]} for x in (-sx, sx) for z in (-sz, sz)]
            return [self.take(model, pads) for _ in range(qty)]
        if model == "corner_bracket" or model == "bracket_cover":
            return [{"at": o, **frame} for o in (self.take(model, self.bracket_origins) for _ in range(qty))]
        if model == "euro_screw":
            holes = [{"at": [x + b["t"], y + sx, z + b["screw_z"]], "axis": [-1, 0, 0]}
                     for x, y, z in self.bracket_origins for sx in (b["screw_x"], -b["screw_x"])]
            return [self.take(model, holes) for _ in range(qty)]
        hook = HARDWARE["103693"]["dims"]
        if model == "hook_plate":
            plates = [{"at": [x + b["wall"] / 2, y, z], **frame} for x, y, z in self.bracket_origins]
            return [self.take(model, plates) for _ in range(qty)]
        if model == "wall_screw":
            # 고리 판 열쇠 구멍의 좁은 쪽에 걸리도록 벽에서 고리 판 앞면까지 튀어나온다.
            dims["protrude"] = round(-self.d / 2 + b["t"] + hook["t"] - self.wall_z, 3)
            neck_y = (hook["key_y"] + hook["slot_top"]) / 2 + 0.2
            screws = [{"at": [x + b["wall"] / 2, y + neck_y, self.wall_z], "axis": [0, 0, -1]}
                      for x, y, _ in self.bracket_origins]
            return [self.take(model, screws) for _ in range(qty)]
        return []


def check_counts(manual: Manual) -> list[str]:
    used = Counter()
    for step in manual.steps:
        for use in step.uses:
            used[use.part_id] += use.qty
    issues = []
    for part in manual.parts:
        if part.kind in ("panel", "tool"):
            continue
        if used[part.id] != part.qty:
            issues.append(f"{part.id}({part.name_ko}): 부품표 {part.qty}개, 단계 합계 {used[part.id]}개")
    added = Counter(pid for s in manual.steps for pid in s.adds)
    for part in manual.parts:
        if part.kind == "panel" and added[part.id] != 1:
            issues.append(f"{part.id}: 판재가 {added[part.id]}번 붙음")
    return issues


def build_scene(manual: Manual) -> dict:
    w, h, d = manual.outer_size_cm
    boxes = panel_boxes(w, h, d)
    kinds = {p.id: p for p in manual.parts}
    panels = [
        {"id": p.id, "name_ko": p.name_ko, **boxes[p.role],
         "from": [c * INSERT_DISTANCE for c in boxes[p.role]["from"]]}
        for p in manual.parts if p.kind == "panel"
    ]
    lying_until = max((s.number for s in manual.steps if s.adds), default=0)
    placer = Placer(manual)
    floor = 0.0
    steps = []
    for i, step in enumerate(manual.steps):
        small = []
        for use in step.uses:
            part = kinds[use.part_id]
            if part.kind in ("panel", "tool"):
                continue
            spec = hardware(part.id, part.kind)
            if spec["model"] == "felt_pad":
                floor = spec["dims"]["t"]
            for n, slot in enumerate(placer.place(i, spec["model"], spec["dims"], use.qty)):
                small.append({"id": f"s{step.number}-{part.id}-{n}", "part_id": part.id, **spec, **slot})
        steps.append({
            **step.model_dump(include={"number", "page", "caption_ko", "warning_ko", "confidence", "adds"}),
            "uses": [{"part_id": u.part_id, "qty": u.qty, "name_ko": kinds[u.part_id].name_ko} for u in step.uses],
            "small": small,
            "pose": "lying" if step.number <= lying_until else "upright",
            "wall": step.number >= 12,
        })
    return {
        "product": manual.product,
        "size": [w, h, d],
        "wall_z": placer.wall_z,
        # 부품 목록 썸네일용: 판재가 아닌 부품 번호별 형상
        "hardware": {p.id: hardware(p.id, p.kind) for p in manual.parts if p.kind != "panel"},
        "floor_offset": floor,
        "panels": panels,
        "steps": steps,
        "safety_ko": manual.safety_ko,
        "extracted_by": manual.extracted_by,
        "issues": check_counts(manual),
    }


if __name__ == "__main__":
    manual = Manual.model_validate_json(Path(sys.argv[1]).read_text())
    scene = build_scene(manual)
    Path(sys.argv[2]).write_text(json.dumps(scene, ensure_ascii=False, indent=2))
    for issue in scene["issues"]:
        print("확인 필요:", issue, file=sys.stderr)
    print(sys.argv[2])
