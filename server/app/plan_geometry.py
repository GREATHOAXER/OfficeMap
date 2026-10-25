"""도면 그림(floor_plans.geometry) 다루기.

v0 (목업): {"walls": [rect], "pillars": [{x, y}], "spaces": [{kind, label, x, y, w, h}]}. 좌표는 도면 대비 비율(0~1).
    좌석·회의실은 seats·meeting_rooms 테이블에만 있다.

v1 (도면 편집기): {"schema": 1, "grid_m": 0.5, "desk": {w, h}?, "elements": [...]}. 좌표는 미터.
    wall        {id, type, x, y, w, h, line_w?}                벽 (사각형 테두리). 가늘고 길게 그리면 칸막이
    wall_line   {id, type, x, y, x2, y2, line_w?}              벽 (선). (x, y)에서 (x2, y2)까지, 굵기 line_w
    pillar      {id, type, x, y, w, h}                         기둥
    space       {id, type, kind, label, x, y, w, h, 모양?}       공용 공간 (SPACE_KINDS)
    room        {id, type, name, capacity, equipment, x, y, w, h, 모양?}  회의실 → meeting_rooms (plan_element_key = id)
    entrance    {id, type, label, main, x, y, w, h, 모양?}       출입구 (main: 주 출입구)
    desk_group  {id, type, layout, rows, cols, x, y, rotation?, desk_w?, desk_h?, cells: [{id, desk, code, flip?}]}
                책상 묶음. 책상 칸 하나 = 좌석 하나 (seats.plan_element_key = 칸 id). 칸은 줄 순서로 rows × cols 개
                layout face: 두 줄씩 마주 붙이고 위 줄은 의자가 위, 아래 줄은 의자가 아래 / one: 모두 의자가 아래
                rotation: 묶음을 통째로 돌린다 (90 = 의자가 아래였던 것이 오른쪽으로). flip: 그 책상만 반대로 앉는다
    모양: line_w (선 굵기, m), label_size (글자 크기 %, 100 = 기본), label_bold (굵게). 없으면 기본 모양

책상 크기는 미터(desk_w × desk_h, 없으면 2.665 × 1.668 m)이고, 직원 화면은 좌석마다 "책상 크기 ÷ 도면 크기" 비율로
그린다(seats.w·h). 목업 도면(50 × 30 m)의 기본 책상은 예전 고정 비율(0.0533 × 0.0556)과 같다.
"""

import math
import re
from typing import Any

SCHEMA = 1
GRID_M = 0.5

# 책상 기본 크기와 책상 사이 간격 (m). 화면(frontend/src/lib/planGeometry.ts)과 같아야 한다
DESK_W = 2.665
DESK_H = 1.668
GAP_X = 0.085  # 옆 책상 사이
AISLE = 1.014  # 마주보기: 두 줄 묶음 사이 통로
CHAIR = 1.05  # 한 방향: 줄 사이 (의자 자리)
PITCH_X = DESK_W + GAP_X  # 기본 책상의 옆 책상 중심 간격 (목업 도면 맞추기에 쓴다)
PAIR_PITCH = 2 * DESK_H + AISLE
WALL_LINE_W = 0.2  # 선 벽 기본 굵기 (m)
PILLAR_W = 0.015  # v0 기둥 크기 (비율)
PILLAR_H = 0.025
DEFAULT_SIZE = (50.0, 30.0)  # 도면이 없는 층의 크기 (m)
MIN_SIZE, MAX_SIZE = 10.0, 300.0  # 도면 크기로 고를 수 있는 범위 (m)

SPACE_KINDS = ("core", "pantry", "restroom", "lounge", "storage", "service", "restricted")
ELEMENT_TYPES = ("wall", "wall_line", "pillar", "space", "room", "entrance", "desk_group")
LAYOUTS = ("face", "one")
ROTATIONS = (0, 90, 180, 270)
DESK_RANGE = (0.3, 6.0)  # 책상 크기 (m)
LINE_RANGE = (0.01, 2.0)  # 선 굵기 (m)
LABEL_RANGE = (50, 400)  # 글자 크기 (%)
STYLED = ("wall", "wall_line", "space", "room", "entrance")  # 선 굵기를 고를 수 있는 요소
LABELED = ("space", "room", "entrance")  # 글자 모양을 고를 수 있는 요소
MAX_ELEMENTS = 2000
MAX_CELLS = 20
ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,50}$")


class GeometryError(ValueError):
    """도면 데이터 모양이 틀렸다 (화면이 잘못 보냈거나 손으로 고친 JSON)"""


def is_v1(geometry: Any) -> bool:
    return isinstance(geometry, dict) and geometry.get("schema") == SCHEMA


# 책상 묶음 ----------------------------------------------------------------------


def seat_ratio(width_m: float, height_m: float) -> tuple[float, float]:
    """기본 책상을 직원 화면이 그리는 좌석 크기 (도면 대비 비율)"""
    return DESK_W / width_m, DESK_H / height_m


def desk_dims(group: dict[str, Any]) -> tuple[float, float]:
    """이 묶음의 책상 하나 크기 (돌리기 전, m)"""
    return group.get("desk_w") or DESK_W, group.get("desk_h") or DESK_H


def _local_size(group: dict[str, Any]) -> tuple[float, float]:
    dw, dh = desk_dims(group)
    w = dw + (group["cols"] - 1) * (dw + GAP_X)
    last = group["rows"] - 1
    if group["layout"] == "face":
        h = (last // 2) * (2 * dh + AISLE) + (last % 2) * dh + dh
    else:
        h = dh + last * (dh + CHAIR)
    return w, h


def group_size(group: dict[str, Any]) -> tuple[float, float]:
    """묶음이 차지하는 폭·높이 (돌린 뒤, m)"""
    w, h = _local_size(group)
    return (h, w) if group.get("rotation", 0) in (90, 270) else (w, h)


def cell_center(group: dict[str, Any], row: int, col: int) -> tuple[float, float, int]:
    """칸 하나의 중심(미터)과 의자 방향 (0 = 아래, 90 = 오른쪽, 180 = 위, 270 = 왼쪽)"""
    dw, dh = desk_dims(group)
    lx = dw / 2 + col * (dw + GAP_X)
    if group["layout"] == "face":
        ly = dh / 2 + (row // 2) * (2 * dh + AISLE) + (row % 2) * dh
        rotation = 180 if row % 2 == 0 else 0
    else:
        ly = dh / 2 + row * (dh + CHAIR)
        rotation = 0
    turn = group.get("rotation", 0)
    w, h = _local_size(group)
    # 묶음을 돌린다: 돌린 뒤에도 (x, y)가 묶음이 차지하는 사각형의 왼쪽 위
    x, y = {0: (lx, ly), 90: (ly, w - lx), 180: (w - lx, h - ly), 270: (h - ly, lx)}[turn]
    cell = group["cells"][row * group["cols"] + col] if group.get("cells") else {}
    rotation = (rotation + turn + (180 if cell.get("flip") else 0)) % 360
    return group["x"] + x, group["y"] + y, rotation


def seat_dims(group: dict[str, Any]) -> tuple[float, float]:
    """좌석 하나가 도면에서 차지하는 폭·높이 (돌린 뒤, m)"""
    dw, dh = desk_dims(group)
    return (dh, dw) if group.get("rotation", 0) in (90, 270) else (dw, dh)


def desk_cells(geometry: dict[str, Any], width_m: float, height_m: float) -> dict[str, dict[str, Any]]:
    """책상 칸 id → 좌석이 될 모습 {code, x, y (비율, 중심), w, h (비율), rotation, group}"""
    out: dict[str, dict[str, Any]] = {}
    for el in geometry["elements"]:
        if el["type"] != "desk_group":
            continue
        sw, sh = seat_dims(el)
        for i, cell in enumerate(el["cells"]):
            if not cell["desk"]:
                continue
            cx, cy, rotation = cell_center(el, i // el["cols"], i % el["cols"])
            out[cell["id"]] = {
                "code": cell["code"].strip(),
                "x": cx / width_m,
                "y": cy / height_m,
                "w": sw / width_m,
                "h": sh / height_m,
                "rotation": rotation,
                "group": el["id"],
            }
    return out


def room_elements(geometry: dict[str, Any], width_m: float, height_m: float) -> dict[str, dict[str, Any]]:
    """회의실 공간 id → 회의실이 될 모습 {name, capacity, equipment, shape (비율, 선 굵기·글자 모양 포함)}"""
    return {
        el["id"]: {
            "name": el["name"].strip(),
            "capacity": el["capacity"],
            "equipment": el.get("equipment", []),
            "shape": {**_ratio_rect(el, width_m, height_m), **_style(el, width_m)},
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


def _style(el: dict[str, Any], width_m: float) -> dict[str, Any]:
    """선 굵기(도면 폭 대비 비율)와 글자 모양. 정하지 않은 것은 넣지 않는다 (화면이 기본 모양으로 그린다)"""
    out: dict[str, Any] = {}
    if el.get("line_w"):
        out["line"] = round(el["line_w"] / width_m, 5)
    if el.get("label_size"):
        out["label_size"] = el["label_size"]
    if el.get("label_bold"):
        out["label_bold"] = True
    return out


def to_ratio(geometry: Any, width_m: float, height_m: float) -> Any:
    """직원 화면이 그리는 모양 (v0과 같은 비율 좌표에 선 벽·출입구·모양을 더한 것). v0은 그대로.
    회의실·좌석은 각자 테이블에서 따로 온다"""
    if not is_v1(geometry):
        return geometry
    walls, lines, pillars, spaces, entrances = [], [], [], [], []
    for el in geometry["elements"]:
        if el["type"] == "wall":
            r = _ratio_rect(el, width_m, height_m)
            walls.append({**{k: v for k, v in r.items() if k != "type"}, **_style(el, width_m)})
        elif el["type"] == "wall_line":
            lines.append(
                {
                    "x1": round(el["x"] / width_m, 5),
                    "y1": round(el["y"] / height_m, 5),
                    "x2": round(el["x2"] / width_m, 5),
                    "y2": round(el["y2"] / height_m, 5),
                    "line": round((el.get("line_w") or WALL_LINE_W) / width_m, 5),
                }
            )
        elif el["type"] == "pillar":
            r = _ratio_rect(el, width_m, height_m)
            pillars.append(
                {"x": round(r["x"] + r["w"] / 2, 4), "y": round(r["y"] + r["h"] / 2, 4), "w": r["w"], "h": r["h"]}
            )
        elif el["type"] == "space":
            r = _ratio_rect(el, width_m, height_m)
            spaces.append(
                {
                    "kind": el["kind"],
                    "label": el["label"],
                    "x": r["x"],
                    "y": r["y"],
                    "w": r["w"],
                    "h": r["h"],
                    **_style(el, width_m),
                }
            )
        elif el["type"] == "entrance":
            r = _ratio_rect(el, width_m, height_m)
            entrances.append(
                {
                    "label": el.get("label") or ("주 출입구" if el.get("main") else "출입구"),
                    "main": bool(el.get("main")),
                    "x": r["x"],
                    "y": r["y"],
                    "w": r["w"],
                    "h": r["h"],
                    **_style(el, width_m),
                }
            )
    return {"walls": walls, "lines": lines, "pillars": pillars, "spaces": spaces, "entrances": entrances}


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
    if "desk" in geometry:
        desk = geometry["desk"]
        if not isinstance(desk, dict):
            raise GeometryError("desk")
        _number({**desk, "id": "desk"}, "w", *DESK_RANGE)
        _number({**desk, "id": "desk"}, "h", *DESK_RANGE)
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
        if el["type"] in STYLED and "line_w" in el:
            _number(el, "line_w", *LINE_RANGE)
        if el["type"] in LABELED:
            if "label_size" in el:
                _number(el, "label_size", *LABEL_RANGE)
            if not isinstance(el.get("label_bold", False), bool):
                raise GeometryError(f"{el['id']}: label_bold")
        if el["type"] == "wall_line":
            _number(el, "x2", -limit, limit)
            _number(el, "y2", -limit, limit)
            if math.hypot(el["x2"] - el["x"], el["y2"] - el["y"]) < 0.05:
                raise GeometryError(f"{el['id']}: length")
            continue
        if el["type"] == "desk_group":
            if el.get("layout") not in LAYOUTS:
                raise GeometryError(f"{el['id']}: layout")
            if el.get("rotation", 0) not in ROTATIONS:
                raise GeometryError(f"{el['id']}: rotation")
            for key in ("desk_w", "desk_h"):
                if key in el:
                    _number(el, key, *DESK_RANGE)
            rows = int(_number(el, "rows", 1, MAX_CELLS))
            cols = int(_number(el, "cols", 1, MAX_CELLS))
            cells = el.get("cells")
            if not isinstance(cells, list) or len(cells) != rows * cols:
                raise GeometryError(f"{el['id']}: cells")
            for cell in cells:
                if (
                    not isinstance(cell, dict)
                    or not isinstance(cell.get("desk"), bool)
                    or not isinstance(cell.get("flip", False), bool)
                ):
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
        elif el["type"] == "entrance":
            label = el.get("label", "")
            if not isinstance(label, str) or len(label) > 50 or not isinstance(el.get("main", False), bool):
                raise GeometryError(f"{el['id']}: entrance")
    return geometry


def box_of(el: dict[str, Any]) -> tuple[float, float, float, float]:
    """요소가 차지하는 사각형 (x, y, w, h, m)"""
    if el["type"] == "desk_group":
        return (el["x"], el["y"], *group_size(el))
    if el["type"] == "wall_line":
        x0, x1 = sorted((el["x"], el["x2"]))
        y0, y1 = sorted((el["y"], el["y2"]))
        return x0, y0, x1 - x0, y1 - y0
    return el["x"], el["y"], el["w"], el["h"]


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
        x, y, w, h = box_of(el)
        if x < -0.01 or y < -0.01 or x + w > width_m + 0.01 or y + h > height_m + 0.01:
            found.append({"code": "OUTSIDE", "element": el["id"]})
    # 같은 요소가 여러 번 걸리면 한 번만
    unique: list[dict[str, Any]] = []
    for p in found:
        if p not in unique:
            unique.append(p)
    return unique
