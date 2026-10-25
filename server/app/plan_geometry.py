"""도면 그림(floor_plans.geometry) 다루기.

v0 (목업): {"walls": [rect], "pillars": [{x, y}], "spaces": [{kind, label, x, y, w, h}]}. 좌표는 도면 대비 비율(0~1).
    좌석·회의실은 seats·meeting_rooms 테이블에만 있다.

v1 (도면 편집기): {"schema": 1, "grid_m": 0.5, "elements": [...]}. 좌표는 미터, 모든 요소는 사각형(결정 8)이다.
    wall        {id, type, x, y, w, h}                         벽. 굵은 테두리로 그린다 (가늘게 그리면 선이 된다)
    pillar      {id, type, x, y, w, h}                         기둥
    space       {id, type, kind, label, x, y, w, h}            공용 공간 (SPACE_KINDS)
    room        {id, type, name, capacity, equipment, x, y, w, h}     회의실 → meeting_rooms (plan_element_key = id)
    desk_group  {id, type, layout, rows, cols, x, y, cells: [{id, desk, code}]}
                책상 묶음. 책상 칸 하나 = 좌석 하나 (seats.plan_element_key = 칸 id). 칸은 줄 순서로 rows × cols 개
                layout face: 두 줄씩 마주 붙이고 위 줄은 의자가 위, 아래 줄은 의자가 아래 / one: 모두 의자가 아래

책상 크기·간격은 미터로 정해져 있다. 직원 화면은 좌석을 "책상 크기 ÷ 도면 크기" 비율로 그리므로(seat_ratio),
도면이 커지면 화면의 좌석이 그만큼 작아진다. 목업 도면(50 × 30 m)에서 이 값은 예전 고정 비율(0.0533 × 0.0556)과 같다.
"""

import math
import re
from typing import Any

SCHEMA = 1
GRID_M = 0.5

# 책상 크기·간격 (m). 화면(frontend/src/lib/planGeometry.ts)과 같아야 한다
DESK_W = 2.665
DESK_H = 1.668
PITCH_X = 2.75  # 옆 책상 중심 간격
PAIR_PITCH = 4.35  # 마주보기: 두 줄 묶음 사이 간격
ONE_PITCH = 2.718  # 한 방향: 줄 간격 (의자 자리 포함)
PILLAR_W = 0.015  # v0 기둥 크기 (비율)
PILLAR_H = 0.025
DEFAULT_SIZE = (50.0, 30.0)  # 도면이 없는 층의 크기 (m)
MIN_SIZE, MAX_SIZE = 10.0, 300.0  # 도면 크기로 고를 수 있는 범위 (m)

SPACE_KINDS = ("core", "pantry", "restroom", "lounge", "storage", "service", "restricted")
ELEMENT_TYPES = ("wall", "pillar", "space", "room", "desk_group")
LAYOUTS = ("face", "one")
MAX_ELEMENTS = 2000
MAX_CELLS = 20
ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,50}$")


class GeometryError(ValueError):
    """도면 데이터 모양이 틀렸다 (화면이 잘못 보냈거나 손으로 고친 JSON)"""


def is_v1(geometry: Any) -> bool:
    return isinstance(geometry, dict) and geometry.get("schema") == SCHEMA


# 책상 묶음 ----------------------------------------------------------------------


def seat_ratio(width_m: float, height_m: float) -> tuple[float, float]:
    """직원 화면이 그리는 좌석 크기 (도면 대비 비율)"""
    return DESK_W / width_m, DESK_H / height_m


def cell_center(group: dict[str, Any], row: int, col: int) -> tuple[float, float, int]:
    """칸 하나의 중심(미터)과 의자 방향 (0 = 아래, 180 = 위)"""
    cx = group["x"] + DESK_W / 2 + col * PITCH_X
    if group["layout"] == "face":
        cy = group["y"] + DESK_H / 2 + (row // 2) * PAIR_PITCH + (row % 2) * DESK_H
        rotation = 180 if row % 2 == 0 else 0
    else:
        cy = group["y"] + DESK_H / 2 + row * ONE_PITCH
        rotation = 0
    return cx, cy, rotation


def group_size(group: dict[str, Any]) -> tuple[float, float]:
    rows, cols = group["rows"], group["cols"]
    w = DESK_W + (cols - 1) * PITCH_X
    if group["layout"] == "face":
        last = rows - 1
        h = (last // 2) * PAIR_PITCH + (last % 2) * DESK_H + DESK_H
    else:
        h = DESK_H + (rows - 1) * ONE_PITCH
    return w, h


def desk_cells(geometry: dict[str, Any], width_m: float, height_m: float) -> dict[str, dict[str, Any]]:
    """책상 칸 id → 좌석이 될 모습 {code, x, y (비율, 중심), rotation, group}"""
    out: dict[str, dict[str, Any]] = {}
    for el in geometry["elements"]:
        if el["type"] != "desk_group":
            continue
        for i, cell in enumerate(el["cells"]):
            if not cell["desk"]:
                continue
            cx, cy, rotation = cell_center(el, i // el["cols"], i % el["cols"])
            out[cell["id"]] = {
                "code": cell["code"].strip(),
                "x": cx / width_m,
                "y": cy / height_m,
                "rotation": rotation,
                "group": el["id"],
            }
    return out


def room_elements(geometry: dict[str, Any], width_m: float, height_m: float) -> dict[str, dict[str, Any]]:
    """회의실 공간 id → 회의실이 될 모습 {name, capacity, equipment, shape (비율)}"""
    return {
        el["id"]: {
            "name": el["name"].strip(),
            "capacity": el["capacity"],
            "equipment": el.get("equipment", []),
            "shape": _ratio_rect(el, width_m, height_m),
        }
        for el in geometry["elements"]
        if el["type"] == "room"
    }


# 직원 화면용 (비율) ------------------------------------------------------------


def _ratio_rect(el: dict[str, Any], width_m: float, height_m: float) -> dict[str, Any]:
    return {
        "type": "rect",
        "x": round(el["x"] / width_m, 4),
        "y": round(el["y"] / height_m, 4),
        "w": round(el["w"] / width_m, 4),
        "h": round(el["h"] / height_m, 4),
    }


def to_ratio(geometry: Any, width_m: float, height_m: float) -> Any:
    """직원 화면이 그리는 모양 (v0과 같은 비율 좌표). v0은 그대로. 회의실·좌석은 각자 테이블에서 따로 온다"""
    if not is_v1(geometry):
        return geometry
    walls, pillars, spaces = [], [], []
    for el in geometry["elements"]:
        if el["type"] == "wall":
            walls.append({k: v for k, v in _ratio_rect(el, width_m, height_m).items() if k != "type"})
        elif el["type"] == "pillar":
            r = _ratio_rect(el, width_m, height_m)
            pillars.append(
                {"x": round(r["x"] + r["w"] / 2, 4), "y": round(r["y"] + r["h"] / 2, 4), "w": r["w"], "h": r["h"]}
            )
        elif el["type"] == "space":
            r = _ratio_rect(el, width_m, height_m)
            spaces.append(
                {"kind": el["kind"], "label": el["label"], "x": r["x"], "y": r["y"], "w": r["w"], "h": r["h"]}
            )
    return {"walls": walls, "pillars": pillars, "spaces": spaces}


# v0 → v1 (목업 도면을 처음 편집할 때) ------------------------------------------------


def from_v0(
    geometry: Any,
    width_m: float,
    height_m: float,
    seats: list[dict[str, Any]],
    rooms: list[dict[str, Any]],
) -> dict[str, Any]:
    """비율 좌표 도면 + 지금 좌석·회의실 → 편집기 도면. seats: {id, key, code, x, y, rotation, zone_id, zone_code},
    rooms: {id, key, name, capacity, equipment, shape}. key는 이미 정해진 plan_element_key (없으면 None)"""
    geometry = geometry or {}
    m = _meters(width_m, height_m)
    elements: list[dict[str, Any]] = []
    for i, w in enumerate(geometry.get("walls", [])):
        elements.append({"id": f"wall-{i + 1}", "type": "wall", **m(w)})
    for i, p in enumerate(geometry.get("pillars", [])):
        pw, ph = p.get("w", PILLAR_W), p.get("h", PILLAR_H)
        elements.append(
            {
                "id": f"pillar-{i + 1}",
                "type": "pillar",
                **m({"x": p["x"] - pw / 2, "y": p["y"] - ph / 2, "w": pw, "h": ph}),
            }
        )
    for i, sp in enumerate(geometry.get("spaces", [])):
        kind = sp.get("kind") if sp.get("kind") in SPACE_KINDS else "lounge"
        elements.append({"id": f"space-{i + 1}", "type": "space", "kind": kind, "label": sp.get("label", ""), **m(sp)})
    for room in rooms:
        if not room["shape"]:
            continue
        elements.append(
            {
                "id": room["key"] or f"room-{room['id']}",
                "type": "room",
                "name": room["name"],
                "capacity": room["capacity"],
                "equipment": list(room["equipment"] or []),
                **m(room["shape"]),
            }
        )
    by_zone: dict[Any, list[dict[str, Any]]] = {}
    for seat in seats:
        by_zone.setdefault(seat["zone_id"], []).append(seat)
    for n, group_seats in enumerate(by_zone.values(), start=1):
        prefix = f"desks-{(group_seats[0]['zone_code'] or 'x').lower()}{n}"
        fitted = _fit_group(prefix, group_seats, width_m, height_m)
        elements.extend(fitted if fitted else _single_desks(prefix, group_seats, width_m, height_m))
    return {"schema": SCHEMA, "grid_m": GRID_M, "elements": elements}


def _meters(width_m: float, height_m: float):
    def convert(r: dict[str, Any]) -> dict[str, float]:
        return {
            "x": round(r["x"] * width_m, 3),
            "y": round(r["y"] * height_m, 3),
            "w": round(r["w"] * width_m, 3),
            "h": round(r["h"] * height_m, 3),
        }

    return convert


def _seat_key(seat: dict[str, Any]) -> str:
    return seat["key"] or f"seat-{seat['id']}"


def _fit_group(prefix: str, seats: list[dict[str, Any]], width_m: float, height_m: float) -> list[dict[str, Any]]:
    """좌석들이 마주보기 책상 묶음 한 개의 칸에 딱 맞으면 그 묶음을 돌려준다 (아니면 빈 목록)"""
    tol = 0.05
    desk_w, desk_h = DESK_W, DESK_H
    pitch_x, pair = PITCH_X, PAIR_PITCH
    centers = [(s["x"] * width_m, s["y"] * height_m) for s in seats]
    ox = min(c[0] for c in centers) - desk_w / 2
    oy = min(c[1] for c in centers) - desk_h / 2
    placed: dict[tuple[int, int], dict[str, Any]] = {}
    for seat, (cx, cy) in zip(seats, centers, strict=True):
        col = round((cx - ox - desk_w / 2) / pitch_x)
        dy = cy - oy - desk_h / 2
        pair_index = int((dy + tol) // pair)
        rest = dy - pair_index * pair
        if abs(rest) < tol:
            row = pair_index * 2
        elif abs(rest - desk_h) < tol:
            row = pair_index * 2 + 1
        else:
            return []
        expected_x = ox + desk_w / 2 + col * pitch_x
        expected_rotation = 180 if row % 2 == 0 else 0
        if abs(cx - expected_x) > tol or seat["rotation"] != expected_rotation or (row, col) in placed:
            return []
        placed[(row, col)] = seat
    rows = max(r for r, _ in placed) + 1
    cols = max(c for _, c in placed) + 1
    if rows > MAX_CELLS or cols > MAX_CELLS:
        return []
    cells = []
    for r in range(rows):
        for c in range(cols):
            seat = placed.get((r, c))
            if seat:
                cells.append({"id": _seat_key(seat), "desk": True, "code": seat["code"]})
            else:
                cells.append({"id": f"{prefix}.{r}-{c}", "desk": False, "code": ""})
    return [
        {
            "id": prefix,
            "type": "desk_group",
            "layout": "face",
            "rows": rows,
            "cols": cols,
            "x": round(ox, 3),
            "y": round(oy, 3),
            "cells": cells,
        }
    ]


def _single_desks(prefix: str, seats: list[dict[str, Any]], width_m: float, height_m: float) -> list[dict[str, Any]]:
    """묶음으로 맞지 않는 좌석은 1인 책상으로 하나씩"""
    desk_w, desk_h = DESK_W, DESK_H
    return [
        {
            "id": f"{prefix}-{i + 1}",
            "type": "desk_group",
            "layout": "face" if seat["rotation"] == 180 else "one",
            "rows": 1,
            "cols": 1,
            "x": round(seat["x"] * width_m - desk_w / 2, 3),
            "y": round(seat["y"] * height_m - desk_h / 2, 3),
            "cells": [{"id": _seat_key(seat), "desk": True, "code": seat["code"]}],
        }
        for i, seat in enumerate(seats)
    ]


# 검사 ------------------------------------------------------------------------


def _number(el: dict[str, Any], key: str, low: float, high: float) -> float:
    value = el.get(key)
    if not isinstance(value, (int, float)) or isinstance(value, bool) or math.isnan(value) or not low <= value <= high:
        raise GeometryError(f"{el.get('id')}: {key}")
    return float(value)


def validate(geometry: Any, width_m: float, height_m: float) -> dict[str, Any]:
    """저장할 수 있는 모양인지 본다 (틀리면 GeometryError). 게시해도 되는지는 problems()가 따로 본다"""
    if not is_v1(geometry) or not isinstance(geometry.get("elements"), list):
        raise GeometryError("schema")
    elements = geometry["elements"]
    if len(elements) > MAX_ELEMENTS:
        raise GeometryError("too many elements")
    ids: set[str] = set()

    def new_id(value: Any) -> None:
        if not isinstance(value, str) or not ID_RE.match(value) or value in ids:
            raise GeometryError(f"id {value!r}")
        ids.add(value)

    limit = max(width_m, height_m) * 2
    for el in elements:
        if not isinstance(el, dict) or el.get("type") not in ELEMENT_TYPES:
            raise GeometryError("type")
        new_id(el.get("id"))
        _number(el, "x", -limit, limit)
        _number(el, "y", -limit, limit)
        if el["type"] == "desk_group":
            if el.get("layout") not in LAYOUTS:
                raise GeometryError(f"{el['id']}: layout")
            rows = int(_number(el, "rows", 1, MAX_CELLS))
            cols = int(_number(el, "cols", 1, MAX_CELLS))
            cells = el.get("cells")
            if not isinstance(cells, list) or len(cells) != rows * cols:
                raise GeometryError(f"{el['id']}: cells")
            for cell in cells:
                if not isinstance(cell, dict) or not isinstance(cell.get("desk"), bool):
                    raise GeometryError(f"{el['id']}: cell")
                new_id(cell.get("id"))
                code = cell.get("code", "")
                if not isinstance(code, str) or len(code) > 20:
                    raise GeometryError(f"{cell.get('id')}: code")
            continue
        _number(el, "w", 0.05, limit)
        _number(el, "h", 0.05, limit)
        if el["type"] == "space":
            if (
                el.get("kind") not in SPACE_KINDS
                or not isinstance(el.get("label", ""), str)
                or len(el.get("label", "")) > 50
            ):
                raise GeometryError(f"{el['id']}: space")
        elif el["type"] == "room":
            name = el.get("name")
            equipment = el.get("equipment", [])
            if not isinstance(name, str) or len(name) > 100:
                raise GeometryError(f"{el['id']}: name")
            _number(el, "capacity", 1, 999)
            if not isinstance(equipment, list) or not all(isinstance(e, str) and len(e) <= 20 for e in equipment):
                raise GeometryError(f"{el['id']}: equipment")
    return geometry


def problems(geometry: dict[str, Any], width_m: float, height_m: float) -> list[dict[str, Any]]:
    """게시하면 안 되는 것: 같은 좌석 번호·회의실 이름, 이름 없는 회의실·번호 없는 책상, 도면 밖 요소"""
    found: list[dict[str, Any]] = []
    codes: dict[str, str] = {}
    for key, cell in desk_cells(geometry, width_m, height_m).items():
        if not cell["code"]:
            found.append({"code": "SEAT_CODE_EMPTY", "element": cell["group"], "cell": key})
        elif cell["code"] in codes:
            found.append({"code": "SEAT_CODE_DUPLICATE", "element": cell["group"], "seat": cell["code"]})
        else:
            codes[cell["code"]] = key
        if not (0 <= cell["x"] <= 1 and 0 <= cell["y"] <= 1):
            found.append({"code": "OUTSIDE", "element": cell["group"]})
    names: set[str] = set()
    for key, room in room_elements(geometry, width_m, height_m).items():
        if not room["name"]:
            found.append({"code": "ROOM_NAME_EMPTY", "element": key})
        elif room["name"] in names:
            found.append({"code": "ROOM_NAME_DUPLICATE", "element": key, "name": room["name"]})
        names.add(room["name"])
    for el in geometry["elements"]:
        if el["type"] == "desk_group":
            w, h = group_size(el)
        else:
            w, h = el["w"], el["h"]
        if el["x"] < -0.01 or el["y"] < -0.01 or el["x"] + w > width_m + 0.01 or el["y"] + h > height_m + 0.01:
            found.append({"code": "OUTSIDE", "element": el["id"]})
    # 같은 요소가 여러 번 걸리면 한 번만
    unique: list[dict[str, Any]] = []
    for p in found:
        if p not in unique:
            unique.append(p)
    return unique
