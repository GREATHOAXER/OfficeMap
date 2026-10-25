"""좌석 배치 편집(⑤) API: 배치 화면 데이터와 작업 묶음(자동 저장 · 반영 · 승인 요청 · 승인 · 반려 · 예정 취소).

작업 묶음은 change_requests 한 행(+ change_request_items)이다. 화면에서 끌어다 놓을 때마다 바로 반영하지 않고
묶음에 모았다가 한 번에 반영한다. 반영은 한 트랜잭션이고, 항목마다 만들 때의 상태(그 좌석에 원래 누가 있었나)를
기억해 두었다가 그사이 다른 관리자가 바꿨으면 그 항목을 충돌로 돌려준다 (아무것도 바꾸지 않는다).

날짜를 정한 묶음은 배정을 그날 0시(서울)부터 시작하게 미리 넣어 둔다. 직원 화면은 지금 시각에 걸친 배정만 보여
주므로 그날이 되면 저절로 바뀐다. 예정이 걸린 좌석·사람은 그날까지 잠긴다. 좌석 유형 변경은 날짜를 정할 수 없다.

권한: 층 관리자 이상은 층 전체를 바로 반영한다. 구역 관리자는 내 구역 좌석과 우리 팀원만 움직이고,
반영 방식(admin_grants.apply_mode)에 따라 바로 반영하거나 층 관리자에게 승인을 요청한다.
"""

import datetime as dt
import json
from typing import Any, Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from psycopg import Connection, errors
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from app.admin_auth import CurrentAdmin, grants_of, load_admin
from app.config import settings
from app.db import pool
from app.plan_geometry import to_ratio
from app.realtime import SSE_HEADERS, hub
from app.routers.auth import client_info
from app.routers.employees import _like

router = APIRouter(prefix="/api/admin", tags=["seating"])

KST = ZoneInfo("Asia/Seoul")
MAX_SCHEDULE_DAYS = 365  # 날짜 지정은 1년 안까지
NEW_HIRE_DAYS = 90  # 미배치 인원에 "신규 입사"로 표시하는 기간
LOCK_SEATING = 5150  # 같은 층의 반영·예정 취소를 한 번에 하나씩 (pg_advisory_xact_lock의 첫 번째 키)

SeatMode = Literal["FIXED", "FLEX", "OUT_OF_SERVICE"]
MODE_LABEL = {"FIXED": "고정석", "FLEX": "팀 내 자율석", "OUT_OF_SERVICE": "사용 중지"}

# 지금 시각에 걸친 배정 / 날짜를 정해 둔 변경(아직 시작 안 한 배정, 묶음이 끝내기로 한 배정)
_NOW = "{a}.starts_at <= now() AND ({a}.ends_at IS NULL OR {a}.ends_at > now())"
_SCHEDULED = "({a}.starts_at > now() OR ({a}.ended_by_request_id IS NOT NULL AND {a}.ends_at > now()))"


def _now(alias: str = "a") -> str:
    return _NOW.format(a=alias)


def _scheduled(alias: str = "a") -> str:
    return _SCHEDULED.format(a=alias)


# 권한 ------------------------------------------------------------------------


def _floor(conn: Connection, floor_id: int) -> dict[str, Any]:
    floor = conn.execute(
        """
        SELECT f.id, f.name, f.site_id, s.name AS site_name
        FROM floors f JOIN sites s ON s.id = f.site_id
        WHERE f.id = %s AND f.is_active
        """,
        (floor_id,),
    ).fetchone()
    if floor is None:
        raise HTTPException(status_code=404, detail={"code": "FLOOR_NOT_FOUND"})
    return floor


def _access(admin: dict[str, Any], floor: dict[str, Any]) -> dict[str, Any] | None:
    """이 층에서 내가 할 수 있는 것. mode FLOOR: 층 전체 / ZONE: 내 구역만 (zones), apply: 바로 반영 / 승인 후"""
    grants = admin["grants"]
    if any(
        g["role"] == "COMPANY_ADMIN"
        or (g["role"] == "SITE_ADMIN" and g["site_id"] == floor["site_id"])
        or (g["role"] == "FLOOR_ADMIN" and g["floor_id"] == floor["id"])
        for g in grants
    ):
        return {"mode": "FLOOR", "apply": "IMMEDIATE", "zones": None}
    zone_grants = [g for g in grants if g["role"] == "ZONE_ADMIN" and g["floor_id"] == floor["id"]]
    if not zone_grants:
        return None
    # 구역 여러 개를 맡았는데 반영 방식이 다르면 더 조심스러운 쪽(승인 후)을 따른다
    needs_approval = any(g["apply_mode"] == "NEEDS_APPROVAL" for g in zone_grants)
    return {
        "mode": "ZONE",
        "apply": "NEEDS_APPROVAL" if needs_approval else "IMMEDIATE",
        "zones": [g["zone_id"] for g in zone_grants],
    }


def _require_access(admin: dict[str, Any], floor: dict[str, Any]) -> dict[str, Any]:
    access = _access(admin, floor)
    if access is None:
        raise HTTPException(status_code=403, detail={"code": "NOT_IN_SCOPE"})
    return access


def _departments(conn: Connection, access: dict[str, Any], floor_id: int) -> list[int]:
    """미배치 인원을 보여 줄 부서: 층 관리자는 이 층에 구역이 있는 팀 전부, 구역 관리자는 내 구역의 팀"""
    if access["mode"] == "FLOOR":
        rows = conn.execute(
            "SELECT DISTINCT department_id FROM zones WHERE floor_id = %s AND is_active AND department_id IS NOT NULL",
            (floor_id,),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT DISTINCT department_id FROM zones WHERE id = ANY(%s) AND department_id IS NOT NULL",
            (access["zones"],),
        ).fetchall()
    return [r["department_id"] for r in rows]


def _allowed_departments(conn: Connection, access: dict[str, Any], floor_id: int) -> list[int] | None:
    """앉힐 수 있는 사람의 부서. None이면 누구나 (층 관리자 이상)"""
    return None if access["mode"] == "FLOOR" else _departments(conn, access, floor_id)


def _seat_editable(access: dict[str, Any], zone_id: int | None) -> bool:
    return access["mode"] == "FLOOR" or zone_id in access["zones"]


# 배치 화면 데이터 ----------------------------------------------------------------


@router.get("/seating/floors")
def seating_floors(admin: CurrentAdmin) -> dict[str, Any]:
    """배치를 편집할 수 있는 층 (층 고르기). 처음 열 층은 맨 앞"""
    with pool.connection() as conn:
        floors = conn.execute(
            """
            SELECT f.id, f.name, f.site_id, s.name AS site_name,
                   EXISTS (SELECT 1 FROM seats st WHERE st.floor_id = f.id AND st.status <> 'REMOVED') AS has_seats
            FROM floors f JOIN sites s ON s.id = f.site_id
            WHERE f.is_active AND s.is_active
            ORDER BY s.sort_order, s.id, f.sort_order DESC
            """
        ).fetchall()
    return {"floors": _floor_choices(admin, floors)}


def _floor_choices(admin: dict[str, Any], floors: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out = []
    for f in floors:
        access = _access(admin, f)
        if access is not None and f["has_seats"]:
            out.append({"id": f["id"], "name": f["name"], "site": f["site_name"], "mode": access["mode"]})
    # 구역 관리자는 내 구역이 있는 층, 층 관리자는 맡은 층이 먼저 열리게 범위가 좁은 쪽을 앞에
    return sorted(out, key=lambda f: f["mode"] != "ZONE") if any(f["mode"] == "ZONE" for f in out) else out


@router.get("/floors/{floor_id}/seating")
def seating(floor_id: int, admin: CurrentAdmin) -> dict[str, Any]:
    """배치 화면: 도면, 구역(편집 가능 여부·관리자), 좌석과 지금 앉은 사람·예정된 변경, 미배치 인원,
    내 작업 묶음(작성 중·승인 대기), 이 층의 요청·승인 현황, 권한."""
    with pool.connection() as conn:
        floor = _floor(conn, floor_id)
        access = _require_access(admin, floor)
        return _seating(conn, admin, floor, access)


def _seating(conn: Connection, admin: dict[str, Any], floor: dict[str, Any], access: dict[str, Any]) -> dict[str, Any]:
    floor_id = floor["id"]
    plan = conn.execute(
        """
        SELECT version, width_m::float8 AS width_m, height_m::float8 AS height_m, geometry
        FROM floor_plans WHERE floor_id = %s AND status = 'PUBLISHED'
        """,
        (floor_id,),
    ).fetchone()
    if plan is not None:
        plan["geometry"] = to_ratio(plan["geometry"], plan["width_m"], plan["height_m"])
    # 게시를 예약한 새 도면: 그날 없어지는 좌석에 앉은 사람은 (게시할 때 정한 사람 말고는) 미배치가 된다
    plan_scheduled = conn.execute(
        """
        SELECT version, effective_at FROM floor_plans
        WHERE floor_id = %s AND status = 'SCHEDULED'
        """,
        (floor_id,),
    ).fetchone()
    rooms = conn.execute(
        "SELECT id, name, shape FROM meeting_rooms WHERE floor_id = %s AND is_active ORDER BY sort_order, id",
        (floor_id,),
    ).fetchall()
    grants = grants_of(conn)
    zones = conn.execute(
        """
        SELECT z.id, z.code, z.name, z.name_custom, z.department_id, d.name AS department,
               coalesce(d.is_active, true) AS department_active, z.color_key, z.shape
        FROM zones z LEFT JOIN departments d ON d.id = z.department_id
        WHERE z.floor_id = %s AND z.is_active
        ORDER BY z.sort_order, z.code
        """,
        (floor_id,),
    ).fetchall()
    for z in zones:
        z["editable"] = _seat_editable(access, z["id"])
        z["managers"] = [
            f"{g['employee']['name']} {g['employee']['rank'] or ''}".strip()
            for g in grants
            if g["role"] == "ZONE_ADMIN" and g["zone_id"] == z["id"]
        ]

    seats = conn.execute(
        f"""
        SELECT s.id, s.code, s.zone_id, s.seat_type, s.status, s.x::float8 AS x, s.y::float8 AS y, s.rotation,
               s.w::float8 AS w, s.h::float8 AS h,
               cur.kind, cur.ends_at AS cur_ends_at, cur.ended_by_request_id,
               ce.emp_no, ce.name, ce.rank_name, ce.employment_status, cd.name AS department, ce.department_id,
               nxt.starts_at AS next_at, ne.emp_no AS next_emp_no, ne.name AS next_name, ne.rank_name AS next_rank,
               nd.name AS next_department
        FROM seats s
        LEFT JOIN seat_assignments cur ON cur.seat_id = s.id AND {_now("cur")}
        LEFT JOIN employees ce ON ce.id = cur.employee_id
        LEFT JOIN departments cd ON cd.id = ce.department_id
        LEFT JOIN LATERAL (
            SELECT a.starts_at, a.employee_id FROM seat_assignments a
            WHERE a.seat_id = s.id AND a.starts_at > now() ORDER BY a.starts_at LIMIT 1
        ) nxt ON true
        LEFT JOIN employees ne ON ne.id = nxt.employee_id
        LEFT JOIN departments nd ON nd.id = ne.department_id
        WHERE s.floor_id = %s AND s.status <> 'REMOVED'
        ORDER BY s.code
        """,
        (floor_id,),
    ).fetchall()

    people = conn.execute(
        f"""
        SELECT e.emp_no, e.name, e.rank_name, e.department_id, d.name AS department,
               e.hired_on > (now() AT TIME ZONE 'Asia/Seoul')::date - %(new_days)s AS new_hire,
               (SELECT max(a.ends_at) FROM seat_assignments a
                WHERE a.employee_id = e.id AND a.kind = 'FIXED' AND a.ends_at <= now()) AS released_at,
               up.starts_at AS next_at, us.code AS next_code, uf.name AS next_floor
        FROM employees e
        JOIN departments d ON d.id = e.department_id
        LEFT JOIN LATERAL (
            SELECT a.starts_at, a.seat_id FROM seat_assignments a
            WHERE a.employee_id = e.id AND a.kind = 'FIXED' AND a.starts_at > now() ORDER BY a.starts_at LIMIT 1
        ) up ON true
        LEFT JOIN seats us ON us.id = up.seat_id
        LEFT JOIN floors uf ON uf.id = us.floor_id
        WHERE e.employment_status = 'ACTIVE' AND e.department_id = ANY(%(depts)s)
          AND NOT EXISTS (SELECT 1 FROM seat_assignments a WHERE a.employee_id = e.id AND a.kind = 'FIXED' AND {_now()})
        ORDER BY d.sort_order, e.name, e.emp_no
        """,
        {"depts": _departments(conn, access, floor_id), "new_days": NEW_HIRE_DAYS},
    ).fetchall()

    mine = conn.execute(
        """
        SELECT id FROM change_requests
        WHERE floor_id = %s AND requested_by = %s AND status IN ('DRAFT', 'PENDING')
          AND request_type = 'SEAT_ASSIGNMENT'
        """,
        (floor_id, admin["employee_id"]),
    ).fetchone()

    floor_admins = [
        f"{g['employee']['name']} {g['employee']['rank'] or ''}".strip()
        for g in grants
        if g["role"] == "FLOOR_ADMIN" and g["floor_id"] == floor_id
    ]
    floors = conn.execute(
        """
        SELECT f.id, f.name, f.site_id, s.name AS site_name,
               EXISTS (SELECT 1 FROM seats st WHERE st.floor_id = f.id AND st.status <> 'REMOVED') AS has_seats
        FROM floors f JOIN sites s ON s.id = f.site_id
        WHERE f.is_active AND s.is_active
        ORDER BY s.sort_order, s.id, f.sort_order DESC
        """
    ).fetchall()

    return {
        "floor": {"id": floor_id, "name": floor["name"], "site": {"id": floor["site_id"], "name": floor["site_name"]}},
        "fetched_at": conn.execute("SELECT now() AS t").fetchone()["t"],
        "floors": _floor_choices(admin, floors),
        "permissions": {
            "mode": access["mode"],
            "apply": access["apply"],
            "zones": access["zones"],
            "can_review": access["mode"] == "FLOOR",
            "floor_admins": floor_admins,
        },
        "plan": plan,
        "plan_scheduled": plan_scheduled,
        "rooms": rooms,
        "zones": zones,
        # 구역에 고를 수 있는 부서 (구역을 만들고 고치는 층 관리자 이상만)
        "departments": _department_choices(conn) if access["mode"] == "FLOOR" else [],
        "seats": [_seat_out(s, access) for s in seats],
        "unassigned": [_person_out(p) for p in people],
        "draft": _change_set(conn, mine["id"]) if mine else None,
        "requests": _requests(conn, admin, floor_id, access),
    }


def _department_choices(conn: Connection) -> list[dict[str, Any]]:
    """살아 있는 팀(아래 부서가 없는 부서)과 위 부서 이름"""
    return conn.execute(
        """
        SELECT d.id, d.name, p.name AS parent
        FROM departments d LEFT JOIN departments p ON p.id = d.parent_id
        WHERE d.is_active AND NOT EXISTS (SELECT 1 FROM departments c WHERE c.parent_id = d.id AND c.is_active)
        ORDER BY p.sort_order NULLS FIRST, d.sort_order, d.name
        """
    ).fetchall()


def _seat_out(row: dict[str, Any], access: dict[str, Any]) -> dict[str, Any]:
    occupant = None
    if row["emp_no"] is not None:
        occupant = {
            "emp_no": row["emp_no"],
            "name": row["name"],
            "rank": row["rank_name"],
            "department": row["department"],
            "department_id": row["department_id"],
            "kind": row["kind"],  # FIXED: 고정석 / DAILY: 오늘 자율석 사용
            "active": row["employment_status"] == "ACTIVE",  # 휴직 중이면 False (자리는 그대로)
        }
    upcoming = None  # 날짜를 정해 둔 다음 변경. 있으면 그날까지 이 좌석은 잠긴다
    if row["next_at"] is not None:
        upcoming = {
            "at": row["next_at"],
            "occupant": {
                "emp_no": row["next_emp_no"],
                "name": row["next_name"],
                "rank": row["next_rank"],
                "department": row["next_department"],
            },
        }
    elif row["ended_by_request_id"] is not None and row["cur_ends_at"] is not None:
        upcoming = {"at": row["cur_ends_at"], "occupant": None}
    return {
        "id": row["id"],
        "code": row["code"],
        "zone_id": row["zone_id"],
        "seat_type": row["seat_type"],
        "status": row["status"],
        "x": row["x"],
        "y": row["y"],
        "rotation": row["rotation"],
        "w": row["w"],  # 좌석 크기 (도면 대비, 없으면 기본 책상)
        "h": row["h"],
        "occupant": occupant,
        "upcoming": upcoming,
        "editable": _seat_editable(access, row["zone_id"]),
    }


def _person_out(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "emp_no": row["emp_no"],
        "name": row["name"],
        "rank": row["rank_name"],
        "department": row["department"],
        "department_id": row["department_id"],
        "new_hire": bool(row["new_hire"]),
        "released_at": row["released_at"],  # 마지막 고정석이 끝난 시각 (부서 이동·도면 변경 등)
        # 날짜를 정해 둔 새 자리. 있으면 그날까지 잠긴다
        "upcoming": (
            {"at": row["next_at"], "seat": f"{row['next_floor']} {row['next_code']}"} if row["next_at"] else None
        ),
    }


def _change_set(conn: Connection, request_id: int) -> dict[str, Any]:
    """작업 묶음 하나와 항목. 항목에 나오는 사람의 이름·부서·지금 자리를 people에 모은다"""
    cr = conn.execute(
        """
        SELECT c.id, c.floor_id, c.request_type, c.status, c.note, c.effective_at, c.submitted_at,
               c.reviewed_at, c.review_comment, c.updated_at, c.requested_by, c.created_at,
               rq.name AS requester_name, rq.rank_name AS requester_rank, rv.name AS reviewer_name
        FROM change_requests c
        JOIN employees rq ON rq.id = c.requested_by
        LEFT JOIN employees rv ON rv.id = c.reviewed_by
        WHERE c.id = %s
        """,
        (request_id,),
    ).fetchone()
    items = conn.execute(
        """
        SELECT i.seat_id, i.action, i.seat_mode, i.to_zone_id, s.code AS seat_code,
               e.emp_no, x.emp_no AS expected_emp_no
        FROM change_request_items i
        JOIN seats s ON s.id = i.seat_id
        LEFT JOIN employees e ON e.id = i.employee_id
        LEFT JOIN employees x ON x.id = i.expected_employee_id
        WHERE i.request_id = %s
        ORDER BY i.id
        """,
        (request_id,),
    ).fetchall()
    emp_nos = {i["emp_no"] for i in items if i["emp_no"]} | {
        i["expected_emp_no"] for i in items if i["expected_emp_no"]
    }
    people = conn.execute(
        f"""
        SELECT e.emp_no, e.name, e.rank_name, e.department_id, d.name AS department, e.employment_status,
               cs.id AS seat_id, cs.code AS seat_code, cf.id AS floor_id, cf.name AS floor_name,
               csi.name AS site_name
        FROM employees e
        JOIN departments d ON d.id = e.department_id
        LEFT JOIN LATERAL (
            SELECT s.id, s.code, s.floor_id FROM seat_assignments a JOIN seats s ON s.id = a.seat_id
            WHERE a.employee_id = e.id AND a.kind = 'FIXED' AND {_now()} LIMIT 1
        ) cs ON true
        LEFT JOIN floors cf ON cf.id = cs.floor_id
        LEFT JOIN sites csi ON csi.id = cf.site_id
        WHERE e.emp_no = ANY(%s)
        """,
        (list(emp_nos),),
    ).fetchall()
    return {
        "id": cr["id"],
        "floor_id": cr["floor_id"],
        "type": cr["request_type"],
        "status": cr["status"],
        "note": cr["note"],
        "effective_at": cr["effective_at"],
        "submitted_at": cr["submitted_at"],
        "reviewed_at": cr["reviewed_at"],
        "reviewer": cr["reviewer_name"],
        "review_comment": cr["review_comment"],
        "updated_at": cr["updated_at"],
        "requester": f"{cr['requester_name']} {cr['requester_rank'] or ''}".strip(),
        "assignments": [
            {"seat_id": i["seat_id"], "emp_no": i["emp_no"], "expected_emp_no": i["expected_emp_no"]}
            for i in items
            if i["action"] in ("ASSIGN", "UNASSIGN")
        ],
        "types": [{"seat_id": i["seat_id"], "mode": i["seat_mode"]} for i in items if i["action"] == "SET_TYPE"],
        "zone_moves": [
            {"seat_id": i["seat_id"], "zone_id": i["to_zone_id"]} for i in items if i["action"] == "MOVE_ZONE"
        ],
        "people": {
            p["emp_no"]: {
                "emp_no": p["emp_no"],
                "name": p["name"],
                "rank": p["rank_name"],
                "department": p["department"],
                "department_id": p["department_id"],
                "active": p["employment_status"] == "ACTIVE",
                "seat": (
                    {
                        "id": p["seat_id"],
                        "code": p["seat_code"],
                        "floor_id": p["floor_id"],
                        "floor": p["floor_name"],
                        "site": p["site_name"],
                    }
                    if p["seat_id"]
                    else None
                ),
            }
            for p in people
        },
    }


def _requests(conn: Connection, admin: dict[str, Any], floor_id: int, access: dict[str, Any]) -> list[dict[str, Any]]:
    """요청·승인 현황: 승인 대기, 날짜를 정해 둔 예정, 최근 30일에 끝난 묶음 (구역 관리자는 내 요청과 예정만)"""
    rows = conn.execute(
        """
        SELECT c.id, c.request_type, c.status, c.note, c.effective_at, c.submitted_at, c.reviewed_at,
               c.review_comment, c.updated_at, c.requested_by = %(me)s AS mine, c.move_group,
               rq.name AS requester_name, rq.rank_name AS requester_rank, rv.name AS reviewer_name,
               c.status = 'APPROVED' AND c.effective_at > now() AS scheduled,
               (SELECT count(*) FROM change_request_items i WHERE i.request_id = c.id)::int AS item_count,
               EXISTS (SELECT 1 FROM change_request_items i
                       WHERE i.request_id = c.id AND i.action = 'MOVE_ZONE') AS zone_moves
        FROM change_requests c
        JOIN employees rq ON rq.id = c.requested_by
        LEFT JOIN employees rv ON rv.id = c.reviewed_by
        WHERE c.floor_id = %(floor)s
          AND c.status <> 'DRAFT'
          AND (c.status = 'PENDING' OR (c.status = 'APPROVED' AND c.effective_at > now())
               OR c.updated_at > now() - interval '30 days')
          AND (%(review)s OR c.requested_by = %(me)s OR (c.status = 'APPROVED' AND c.effective_at > now()))
        ORDER BY c.status = 'PENDING' DESC, c.status = 'APPROVED' AND c.effective_at > now() DESC,
                 c.updated_at DESC
        LIMIT 12
        """,
        {"me": admin["employee_id"], "floor": floor_id, "review": access["mode"] == "FLOOR"},
    ).fetchall()
    summaries = _summaries(conn, [r["id"] for r in rows])
    return [
        {
            "id": r["id"],
            "type": r["request_type"],
            "status": r["status"],
            "scheduled": r["scheduled"],
            "note": r["note"],
            "effective_at": r["effective_at"],
            "submitted_at": r["submitted_at"],
            "reviewed_at": r["reviewed_at"],
            "reviewer": r["reviewer_name"],
            "review_comment": r["review_comment"],
            "requester": f"{r['requester_name']} {r['requester_rank'] or ''}".strip(),
            "mine": r["mine"],
            "item_count": r["item_count"],
            "zone_moves": r["zone_moves"],  # 구역 경계 변경이 들어 있다
            "team_move": r["move_group"] is not None,  # 팀 이사로 여러 층에 함께 만든 묶음 (취소도 함께)
            "summary": summaries.get(r["id"], []),
            "can_review": r["status"] == "PENDING" and access["mode"] == "FLOOR",
            "can_cancel": r["scheduled"] and (r["mine"] or access["mode"] == "FLOOR"),
        }
        for r in rows
    ]


def _summaries(conn: Connection, request_ids: list[int]) -> dict[int, list[str]]:
    """묶음마다 항목을 한 줄씩 사람이 읽는 말로 (예: "이서연 → B-17", "B-04 비우기", "B-18 사용 중지")"""
    rows = conn.execute(
        """
        SELECT i.request_id, i.action, i.seat_mode, s.code, e.name, x.name AS expected_name,
               z.name AS zone_name, z.code AS zone_code
        FROM change_request_items i
        JOIN seats s ON s.id = i.seat_id
        LEFT JOIN employees e ON e.id = i.employee_id
        LEFT JOIN employees x ON x.id = i.expected_employee_id
        LEFT JOIN zones z ON z.id = i.to_zone_id
        WHERE i.request_id = ANY(%s)
        ORDER BY i.request_id, i.action <> 'ASSIGN', i.id
        """,
        (request_ids,),
    ).fetchall()
    out: dict[int, list[str]] = {}
    for r in rows:
        if r["action"] == "ASSIGN":
            text = f"{r['name']} → {r['code']}"
        elif r["action"] == "UNASSIGN":
            text = f"{r['code']} 비우기" + (f" ({r['expected_name']})" if r["expected_name"] else "")
        elif r["action"] == "SET_TYPE":
            text = f"{r['code']} {MODE_LABEL[r['seat_mode']]}"
        elif r["zone_name"] is None:
            text = f"{r['code']} → 구역 없음"
        else:
            text = f"{r['code']} → {r['zone_name']} · {r['zone_code']}구역"
        out.setdefault(r["request_id"], []).append(text)
    return out


@router.get("/change-sets/{request_id}")
def change_set(request_id: int, admin: CurrentAdmin) -> dict[str, Any]:
    """묶음 하나 (승인할 요청을 도면 위에서 미리 보기)"""
    with pool.connection() as conn:
        cr = _load(conn, request_id)
        access = _require_access(admin, _floor(conn, cr["floor_id"]))
        if access["mode"] != "FLOOR" and cr["requested_by"] != admin["employee_id"]:
            raise HTTPException(status_code=403, detail={"code": "NOT_IN_SCOPE"})
        return _change_set(conn, request_id)


@router.get("/seating/people")
def seating_people(admin: CurrentAdmin, floor_id: int, q: str = Query(min_length=1, max_length=30)) -> dict[str, Any]:
    """배치 화면에서 사람 찾기 (미배치 목록에 없는 사람, 다른 층 사람). 구역 관리자는 우리 팀원만"""
    query = q.strip()
    with pool.connection() as conn:
        floor = _floor(conn, floor_id)
        access = _require_access(admin, floor)
        depts = _allowed_departments(conn, access, floor_id)
        rows = conn.execute(
            f"""
            SELECT e.emp_no, e.name, e.rank_name, e.department_id, d.name AS department,
                   cs.id AS seat_id, cs.code AS seat_code, cf.id AS floor_id, cf.name AS floor_name,
                   csi.name AS site_name,
                   EXISTS (SELECT 1 FROM seat_assignments a WHERE a.employee_id = e.id AND a.kind = 'FIXED'
                           AND {_scheduled()}) AS locked
            FROM employees e
            JOIN departments d ON d.id = e.department_id
            LEFT JOIN LATERAL (
                SELECT s.id, s.code, s.floor_id FROM seat_assignments a JOIN seats s ON s.id = a.seat_id
                WHERE a.employee_id = e.id AND a.kind = 'FIXED' AND {_now()} LIMIT 1
            ) cs ON true
            LEFT JOIN floors cf ON cf.id = cs.floor_id
            LEFT JOIN sites csi ON csi.id = cf.site_id
            WHERE e.employment_status = 'ACTIVE'
              AND (e.name LIKE '%%' || %(like)s || '%%' OR e.emp_no = %(q)s)
              AND (%(depts)s::bigint[] IS NULL OR e.department_id = ANY(%(depts)s))
            ORDER BY e.name = %(q)s DESC, e.name LIKE %(like)s || '%%' DESC, e.name, e.emp_no
            LIMIT 20
            """,
            {"q": query, "like": _like(query), "depts": depts},
        ).fetchall()
    return {
        "people": [
            {
                "emp_no": r["emp_no"],
                "name": r["name"],
                "rank": r["rank_name"],
                "department": r["department"],
                "department_id": r["department_id"],
                "seat": (
                    {
                        "id": r["seat_id"],
                        "code": r["seat_code"],
                        "floor_id": r["floor_id"],
                        "floor": r["floor_name"],
                        "site": r["site_name"],
                    }
                    if r["seat_id"]
                    else None
                ),
                "locked": r["locked"],
            }
            for r in rows
        ]
    }


# 작업 묶음 저장 ----------------------------------------------------------------


class AssignmentIn(BaseModel):
    """반영하면 이 좌석에 앉을 사람 (None = 비우기). expected_emp_no: 바꾸기 전에 앉아 있던 사람"""

    seat_id: int
    emp_no: str | None = Field(default=None, max_length=20)
    expected_emp_no: str | None = Field(default=None, max_length=20)


class SeatTypeIn(BaseModel):
    seat_id: int
    mode: SeatMode


class ZoneMoveIn(BaseModel):
    """좌석을 다른 구역으로 (zone_id가 None이면 구역 없음으로 빼기)"""

    seat_id: int
    zone_id: int | None = None


class ChangeSetIn(BaseModel):
    assignments: list[AssignmentIn] = Field(default_factory=list, max_length=500)
    types: list[SeatTypeIn] = Field(default_factory=list, max_length=500)
    zones: list[ZoneMoveIn] = Field(default_factory=list, max_length=500)
    effective_date: dt.date | None = None  # 이날 0시(서울)부터. 없으면 반영하는 즉시
    note: str | None = Field(default=None, max_length=200)


def _effective_at(day: dt.date | None) -> dt.datetime | None:
    if day is None:
        return None
    today = dt.datetime.now(KST).date()
    if day <= today or day > today + dt.timedelta(days=MAX_SCHEDULE_DAYS):
        raise HTTPException(status_code=422, detail={"code": "BAD_DATE", "max_days": MAX_SCHEDULE_DAYS})
    return dt.datetime.combine(day, dt.time.min, tzinfo=KST)


@router.put("/floors/{floor_id}/change-set")
def save_change_set(floor_id: int, body: ChangeSetIn, admin: CurrentAdmin) -> dict[str, Any]:
    """내 작업 묶음 자동 저장. 항목 목록을 통째로 바꾼다. 항목이 하나도 없으면 묶음을 지운다.

    여기서는 모양(내 범위의 좌석·사람인지, 같은 사람이 두 번 나오지 않는지)만 본다.
    그사이 바뀐 것과의 충돌은 반영할 때 본다.

    구역 관리자의 구역 경계 변경: 다른 구역 좌석을 내 구역으로 넣거나(확장), 내 구역 좌석을 빼는 것만 된다.
    배정·유형은 반영한 뒤 내 구역이 되는 좌석에만 할 수 있다.
    """
    effective_at = _effective_at(body.effective_date)
    if effective_at is not None and (body.types or body.zones):
        raise HTTPException(status_code=422, detail={"code": "SCHEDULE_WITH_TYPES"})
    with pool.connection() as conn:
        floor = _floor(conn, floor_id)
        access = _require_access(admin, floor)
        open_set = conn.execute(
            """
            SELECT id, status FROM change_requests
            WHERE floor_id = %s AND requested_by = %s AND status IN ('DRAFT', 'PENDING')
              AND request_type = 'SEAT_ASSIGNMENT'
            FOR UPDATE
            """,
            (floor_id, admin["employee_id"]),
        ).fetchone()
        if open_set is not None and open_set["status"] == "PENDING":
            raise HTTPException(status_code=409, detail={"code": "PENDING"})

        seat_ids = [a.seat_id for a in body.assignments]
        type_ids = [t.seat_id for t in body.types]
        move_ids = [z.seat_id for z in body.zones]
        if any(len(set(ids)) != len(ids) for ids in (seat_ids, type_ids, move_ids)):
            raise HTTPException(status_code=422, detail={"code": "DUPLICATE_SEAT"})
        seats = {
            s["id"]: s
            for s in conn.execute(
                "SELECT id, zone_id FROM seats WHERE id = ANY(%s) AND floor_id = %s AND status <> 'REMOVED'",
                (seat_ids + type_ids + move_ids, floor_id),
            ).fetchall()
        }
        floor_zones = {
            z["id"]
            for z in conn.execute("SELECT id FROM zones WHERE floor_id = %s AND is_active", (floor_id,)).fetchall()
        }
        moves = {z.seat_id: z.zone_id for z in body.zones}
        for seat_id in seat_ids + type_ids + move_ids:
            if seat_id not in seats:
                raise HTTPException(status_code=422, detail={"code": "SEAT_NOT_FOUND", "seat_id": seat_id})
        for move in body.zones:
            if move.zone_id is not None and move.zone_id not in floor_zones:
                raise HTTPException(status_code=422, detail={"code": "ZONE_NOT_FOUND", "zone_id": move.zone_id})
            current = seats[move.seat_id]["zone_id"]
            if not (_seat_editable(access, current) or _seat_editable(access, move.zone_id)):
                raise HTTPException(status_code=403, detail={"code": "SEAT_LOCKED", "seat_id": move.seat_id})
        for seat_id in seat_ids + type_ids:
            # 반영한 뒤의 구역 기준 (내 구역으로 넣는 좌석에는 바로 사람을 앉힐 수 있다)
            if not _seat_editable(access, moves.get(seat_id, seats[seat_id]["zone_id"])):
                raise HTTPException(status_code=403, detail={"code": "SEAT_LOCKED", "seat_id": seat_id})

        assignees = [a.emp_no for a in body.assignments if a.emp_no]
        if len(set(assignees)) != len(assignees):
            raise HTTPException(status_code=422, detail={"code": "DUPLICATE_PERSON"})
        emp_nos = set(assignees) | {a.expected_emp_no for a in body.assignments if a.expected_emp_no}
        people = {
            e["emp_no"]: e
            for e in conn.execute(
                "SELECT id, emp_no, department_id, employment_status FROM employees WHERE emp_no = ANY(%s)",
                (list(emp_nos),),
            ).fetchall()
        }
        depts = _allowed_departments(conn, access, floor_id)
        for emp_no in emp_nos:
            if emp_no not in people:
                raise HTTPException(status_code=422, detail={"code": "PERSON_NOT_FOUND", "emp_no": emp_no})
        for emp_no in assignees:
            person = people[emp_no]
            if person["employment_status"] != "ACTIVE":
                raise HTTPException(status_code=422, detail={"code": "PERSON_INACTIVE", "emp_no": emp_no})
            if depts is not None and person["department_id"] not in depts:
                raise HTTPException(status_code=403, detail={"code": "PERSON_OUT_OF_SCOPE", "emp_no": emp_no})

        if not body.assignments and not body.types and not body.zones:
            if open_set is not None:
                conn.execute("DELETE FROM change_requests WHERE id = %s", (open_set["id"],))
            return {"draft": None}

        if open_set is None:
            request_id = conn.execute(
                """
                INSERT INTO change_requests (floor_id, zone_id, request_type, status, note, effective_at, requested_by)
                VALUES (%s, %s, 'SEAT_ASSIGNMENT', 'DRAFT', %s, %s, %s)
                RETURNING id
                """,
                (
                    floor_id,
                    access["zones"][0] if access["mode"] == "ZONE" else None,
                    body.note,
                    effective_at,
                    admin["employee_id"],
                ),
            ).fetchone()["id"]
        else:
            request_id = open_set["id"]
            conn.execute(
                "UPDATE change_requests SET note = %s, effective_at = %s, updated_at = now() WHERE id = %s",
                (body.note, effective_at, request_id),
            )
            conn.execute("DELETE FROM change_request_items WHERE request_id = %s", (request_id,))

        def emp_id(emp_no: str | None) -> int | None:
            return people[emp_no]["id"] if emp_no else None

        with conn.cursor() as cur:
            cur.executemany(
                """
                INSERT INTO change_request_items (request_id, seat_id, action, employee_id, expected_employee_id)
                VALUES (%s, %s, %s, %s, %s)
                """,
                [
                    (
                        request_id,
                        a.seat_id,
                        "ASSIGN" if a.emp_no else "UNASSIGN",
                        emp_id(a.emp_no),
                        emp_id(a.expected_emp_no),
                    )
                    for a in body.assignments
                ],
            )
            cur.executemany(
                """
                INSERT INTO change_request_items (request_id, seat_id, action, seat_mode)
                VALUES (%s, %s, 'SET_TYPE', %s)
                """,
                [(request_id, t.seat_id, t.mode) for t in body.types],
            )
            cur.executemany(
                """
                INSERT INTO change_request_items (request_id, seat_id, action, to_zone_id)
                VALUES (%s, %s, 'MOVE_ZONE', %s)
                """,
                [(request_id, z.seat_id, z.zone_id) for z in body.zones],
            )
        saved = conn.execute("SELECT updated_at FROM change_requests WHERE id = %s", (request_id,)).fetchone()
    return {"draft": {"id": request_id, "updated_at": saved["updated_at"], "effective_at": effective_at}}


@router.delete("/floors/{floor_id}/change-set", status_code=204)
def discard_change_set(floor_id: int, admin: CurrentAdmin) -> None:
    """작성 중인 내 묶음 버리기 (반영하지 않은 것이라 이력 없이 지운다)"""
    with pool.connection() as conn:
        conn.execute(
            """
            DELETE FROM change_requests
            WHERE floor_id = %s AND requested_by = %s AND status = 'DRAFT' AND request_type = 'SEAT_ASSIGNMENT'
            """,
            (floor_id, admin["employee_id"]),
        )


# 팀 구역 ----------------------------------------------------------------------
# 구역 속성(부서·이름·코드·색)과 빈 구역 만들기는 자리에 영향이 없어 바로 반영한다.
# 좌석을 구역에 넣고 빼는 것(경계)은 작업 묶음의 MOVE_ZONE 항목으로 한다. 구역 없애기는 점검을 거쳐 한 번에


ColorKey = Literal["t0", "t1", "t2", "t3", "t4"]


class ZoneIn(BaseModel):
    code: str = Field(pattern=r"^[A-Z][A-Z0-9]?$")  # 층 안에서 겹치지 않는 짧은 이름 (A, B, Z, S1 …)
    department_id: int | None = None  # 공용 구역이면 없음
    color_key: ColorKey
    name: str | None = Field(default=None, max_length=100)  # 비우면 부서 이름을 따라간다


def _floor_access_only(admin: dict[str, Any], floor: dict[str, Any]) -> dict[str, Any]:
    access = _require_access(admin, floor)
    if access["mode"] != "FLOOR":
        raise HTTPException(status_code=403, detail={"code": "FLOOR_ADMIN_ONLY"})
    return access


def _zone_fields(conn: Connection, body: ZoneIn) -> dict[str, Any]:
    """구역 이름: 적은 이름이 부서 이름과 다르면 별칭, 아니면 부서 이름을 따라간다"""
    department = None
    if body.department_id is not None:
        department = conn.execute(
            "SELECT id, name FROM departments WHERE id = %s AND is_active", (body.department_id,)
        ).fetchone()
        if department is None:
            raise HTTPException(status_code=422, detail={"code": "DEPARTMENT_NOT_FOUND"})
    name = (body.name or "").strip()
    if department is not None and (not name or name == department["name"]):
        return {"name": department["name"], "name_custom": False}
    if not name:
        return {"name": "공용 구역", "name_custom": True}
    return {"name": name, "name_custom": True}


def _zone_row(conn: Connection, zone_id: int) -> dict[str, Any]:
    zone = conn.execute(
        """
        SELECT z.id, z.floor_id, z.code, z.name, z.name_custom, z.department_id, z.color_key, z.is_active,
               f.site_id, f.name AS floor_name
        FROM zones z JOIN floors f ON f.id = z.floor_id
        WHERE z.id = %s
        """,
        (zone_id,),
    ).fetchone()
    if zone is None or not zone["is_active"]:
        raise HTTPException(status_code=404, detail={"code": "ZONE_NOT_FOUND"})
    return zone


def _zone_audit(
    conn: Connection, actor_id: int, action: str, zone_id: int, before: Any, after: Any, request: Request
) -> None:
    conn.execute(
        """
        INSERT INTO audit_logs (actor_id, action, target_type, target_id, before_data, after_data, ip_address)
        VALUES (%s, %s, 'zone', %s, %s, %s, %s)
        """,
        (
            actor_id,
            action,
            zone_id,
            _json(before) if before else None,
            _json(after) if after else None,
            client_info(request)[0],
        ),
    )


@router.post("/floors/{floor_id}/zones", status_code=201)
def create_zone(floor_id: int, body: ZoneIn, admin: CurrentAdmin, request: Request) -> dict[str, Any]:
    """빈 팀 구역을 만든다 (층 관리자 이상). 좌석은 배치 화면에서 구역으로 묶어 반영한다"""
    with pool.connection() as conn:
        _floor_access_only(admin, _floor(conn, floor_id))
        fields = _zone_fields(conn, body)
        try:
            zone = conn.execute(
                """
                INSERT INTO zones (floor_id, code, name, name_custom, department_id, color_key, sort_order)
                VALUES (%s, %s, %s, %s, %s, %s,
                        (SELECT coalesce(max(sort_order), 0) + 1 FROM zones WHERE floor_id = %s AND is_active))
                RETURNING id, code, name
                """,
                (
                    floor_id,
                    body.code,
                    fields["name"],
                    fields["name_custom"],
                    body.department_id,
                    body.color_key,
                    floor_id,
                ),
            ).fetchone()
        except errors.UniqueViolation:
            raise HTTPException(status_code=409, detail={"code": "CODE_TAKEN"}) from None
        _zone_audit(conn, admin["employee_id"], "ZONE_CREATE", zone["id"], None, body.model_dump(), request)
    return {"zone": zone}


@router.patch("/zones/{zone_id}")
def update_zone(zone_id: int, body: ZoneIn, admin: CurrentAdmin, request: Request) -> dict[str, Any]:
    """구역의 부서·이름·코드·색 (층 관리자 이상). 앉아 있는 사람에게는 영향이 없다"""
    with pool.connection() as conn:
        zone = _zone_row(conn, zone_id)
        _floor_access_only(admin, {"id": zone["floor_id"], "site_id": zone["site_id"]})
        fields = _zone_fields(conn, body)
        try:
            conn.execute(
                """
                UPDATE zones SET code = %s, name = %s, name_custom = %s, department_id = %s, color_key = %s,
                       updated_at = now()
                WHERE id = %s
                """,
                (body.code, fields["name"], fields["name_custom"], body.department_id, body.color_key, zone_id),
            )
        except errors.UniqueViolation:
            raise HTTPException(status_code=409, detail={"code": "CODE_TAKEN"}) from None
        before = {k: zone[k] for k in ("code", "name", "department_id", "color_key")}
        _zone_audit(
            conn, admin["employee_id"], "ZONE_UPDATE", zone_id, before, {**body.model_dump(), **fields}, request
        )
    return {"zone": {"id": zone_id, "code": body.code, "name": fields["name"]}}


class ZoneDeleteIn(BaseModel):
    merge_into: int | None = None  # 좌석을 이 구역에 합친다. 없으면 구역 없는 좌석이 된다
    unassign: bool = False  # 앉아 있는 사람을 미배치로 (아니면 그 자리 그대로)


@router.post("/zones/{zone_id}/delete")
def delete_zone(zone_id: int, body: ZoneDeleteIn, admin: CurrentAdmin, request: Request) -> dict[str, Any]:
    """팀 구역 없애기 (층 관리자 이상). 좌석은 다른 구역에 합치거나 구역 없음으로, 앉은 사람은 그대로 또는 미배치로.
    그 구역의 구역 관리자 권한은 회수하고 알린다. 날짜를 정한 변경이 걸린 좌석이 있으면 먼저 취소해야 한다"""
    with pool.connection() as conn:
        zone = _zone_row(conn, zone_id)
        floor_id = zone["floor_id"]
        _floor_access_only(admin, {"id": floor_id, "site_id": zone["site_id"]})
        if body.merge_into is not None:
            target = conn.execute(
                "SELECT id FROM zones WHERE id = %s AND floor_id = %s AND is_active AND id <> %s",
                (body.merge_into, floor_id, zone_id),
            ).fetchone()
            if target is None:
                raise HTTPException(status_code=422, detail={"code": "ZONE_NOT_FOUND"})
        conn.execute("SELECT pg_advisory_xact_lock(%s, %s)", (LOCK_SEATING, floor_id))
        scheduled = conn.execute(
            f"""
            SELECT 1 FROM seat_assignments a JOIN seats s ON s.id = a.seat_id
            WHERE s.zone_id = %s AND {_scheduled()} LIMIT 1
            """,
            (zone_id,),
        ).fetchone()
        if scheduled is not None:
            raise HTTPException(status_code=409, detail={"code": "SCHEDULED"})

        released: list[dict[str, Any]] = []
        if body.unassign:
            released = conn.execute(
                f"""
                UPDATE seat_assignments a SET ends_at = now()
                FROM seats s
                WHERE s.id = a.seat_id AND s.zone_id = %s AND a.kind = 'FIXED' AND {_now()} AND a.starts_at < now()
                RETURNING a.employee_id, s.code
                """,
                (zone_id,),
            ).fetchall()
        seats = conn.execute(
            "UPDATE seats SET zone_id = %s, updated_at = now() WHERE zone_id = %s RETURNING id",
            (body.merge_into, zone_id),
        ).fetchall()
        # 이 구역 관리자가 올린 진행 중 묶음은 취소, 권한은 회수
        conn.execute(
            """
            UPDATE change_requests SET status = 'CANCELLED', updated_at = now()
            WHERE zone_id = %s AND status IN ('DRAFT', 'PENDING')
            """,
            (zone_id,),
        )
        revoked = conn.execute(
            """
            UPDATE admin_grants SET revoked_at = now(), revoked_by = %s
            WHERE zone_id = %s AND revoked_at IS NULL
            RETURNING employee_id
            """,
            (admin["employee_id"], zone_id),
        ).fetchall()
        conn.execute("UPDATE zones SET is_active = false, updated_at = now() WHERE id = %s", (zone_id,))

        label = f"{zone['floor_name']} {zone['name']} {zone['code']}구역"
        notes = [
            (r["employee_id"], "SEAT_CHANGED", {"floor": zone["floor_name"], "seat": None, "from_seat": r["code"]})
            for r in released
        ] + [(r["employee_id"], "GRANT_REVOKED", {"zone": label, "reason": "ZONE_DELETED"}) for r in revoked]
        with conn.cursor() as cur:
            cur.executemany(
                "INSERT INTO notifications (recipient_id, channel, type, payload) VALUES (%s, 'IN_APP', %s, %s)",
                [(emp, kind, _json(payload)) for emp, kind, payload in notes],
            )
        result = {
            "seats": len(seats),
            "merged_into": body.merge_into,
            "unassigned": len(released),
            "revoked": len(revoked),
        }
        _zone_audit(conn, admin["employee_id"], "ZONE_DELETE", zone_id, {"zone": label}, result, request)
    return result


# 반영 · 승인 흐름 ---------------------------------------------------------------


def _load(conn: Connection, request_id: int, *, lock: bool = False) -> dict[str, Any]:
    cr = conn.execute(
        f"""
        SELECT id, floor_id, status, request_type, effective_at, requested_by, note, move_group,
               effective_at > now() AS in_future
        FROM change_requests WHERE id = %s {"FOR UPDATE" if lock else ""}
        """,
        (request_id,),
    ).fetchone()
    if cr is None:
        raise HTTPException(status_code=404, detail={"code": "CHANGE_SET_NOT_FOUND"})
    return cr


def _audit(
    conn: Connection, actor_id: int, action: str, request_id: int, data: dict[str, Any], request: Request
) -> None:
    conn.execute(
        """
        INSERT INTO audit_logs (actor_id, action, target_type, target_id, after_data, ip_address)
        VALUES (%s, %s, 'change_request', %s, %s, %s)
        """,
        (actor_id, action, request_id, _json(data), client_info(request)[0]),
    )


def _json(data: dict[str, Any]) -> Jsonb:
    """감사 기록·알림 내용 (시각은 ISO 문자열로)"""
    return Jsonb(data, dumps=lambda obj: json.dumps(obj, default=str, ensure_ascii=False))


def _apply(
    conn: Connection, cr: dict[str, Any], access: dict[str, Any], actor_id: int, request: Request
) -> dict[str, Any]:
    """묶음을 반영한다 (호출한 쪽의 트랜잭션 안에서). 충돌이 하나라도 있으면 아무것도 바꾸지 않고 409"""
    floor_id = cr["floor_id"]
    conn.execute("SELECT pg_advisory_xact_lock(%s, %s)", (LOCK_SEATING, floor_id))
    # 날짜가 지났으면(승인이 늦었으면) 지금 반영한다
    timing = conn.execute(
        """
        SELECT greatest(coalesce(%(at)s::timestamptz, now()), now()) AS eff,
               coalesce(%(at)s::timestamptz > now(), false) AS later
        """,
        {"at": cr["effective_at"]},
    ).fetchone()
    eff, later = timing["eff"], timing["later"]

    items = conn.execute(
        """
        SELECT i.seat_id, i.action, i.employee_id, i.expected_employee_id, i.seat_mode, i.to_zone_id,
               s.floor_id, s.zone_id, s.status AS seat_status, s.seat_type, s.code,
               e.emp_no, e.name, e.employment_status, e.department_id
        FROM change_request_items i
        JOIN seats s ON s.id = i.seat_id
        LEFT JOIN employees e ON e.id = i.employee_id
        WHERE i.request_id = %s
        ORDER BY i.id
        """,
        (cr["id"],),
    ).fetchall()
    if not items:
        raise HTTPException(status_code=422, detail={"code": "EMPTY"})
    seat_ids = list({i["seat_id"] for i in items})
    occupants = {
        r["seat_id"]: r
        for r in conn.execute(
            """
            SELECT a.seat_id, a.employee_id, e.emp_no, e.name
            FROM seat_assignments a JOIN employees e ON e.id = a.employee_id
            WHERE a.seat_id = ANY(%(seats)s) AND a.kind = 'FIXED'
              AND a.starts_at <= %(eff)s AND (a.ends_at IS NULL OR a.ends_at > %(eff)s)
            """,
            {"seats": seat_ids, "eff": eff},
        ).fetchall()
    }

    def occupant_id(seat_id: int) -> int | None:
        row = occupants.get(seat_id)
        return row["employee_id"] if row else None

    # 할 필요가 없어진 항목(이미 그렇게 되어 있음)은 뺀다
    seat_items = [
        i for i in items if i["action"] in ("ASSIGN", "UNASSIGN") and occupant_id(i["seat_id"]) != i["employee_id"]
    ]
    type_items = [i for i in items if i["action"] == "SET_TYPE"]
    zone_items = [i for i in items if i["action"] == "MOVE_ZONE"]
    if later and (type_items or zone_items):
        raise HTTPException(status_code=422, detail={"code": "SCHEDULE_WITH_TYPES"})

    assignees = [i["employee_id"] for i in seat_items if i["action"] == "ASSIGN"]
    locked_seats = {
        r["seat_id"]
        for r in conn.execute(
            f"SELECT a.seat_id FROM seat_assignments a WHERE a.seat_id = ANY(%s) AND {_scheduled()}",
            ([i["seat_id"] for i in seat_items],),
        ).fetchall()
    }
    locked_people = {
        r["employee_id"]
        for r in conn.execute(
            f"""
            SELECT a.employee_id FROM seat_assignments a
            WHERE a.employee_id = ANY(%s) AND a.kind = 'FIXED' AND {_scheduled()}
            """,
            (assignees,),
        ).fetchall()
    }
    depts = _allowed_departments(conn, access, floor_id)
    new_mode = {i["seat_id"]: i["seat_mode"] for i in type_items}

    conflicts: list[dict[str, Any]] = []

    def conflict(item: dict[str, Any], reason: str, **extra: Any) -> None:
        conflicts.append({"seat_id": item["seat_id"], "code": item["code"], "reason": reason, **extra})

    for i in items:
        if i["floor_id"] != floor_id or i["seat_status"] == "REMOVED":
            conflict(i, "SEAT_GONE")
        elif not _seat_editable(access, i["zone_id"]):
            conflict(i, "OUT_OF_SCOPE")
    for i in seat_items:
        current = occupants.get(i["seat_id"])
        if i["seat_id"] in locked_seats:
            conflict(i, "SCHEDULED")
        elif occupant_id(i["seat_id"]) != i["expected_employee_id"]:
            conflict(i, "CHANGED", current=current["name"] if current else None)
        elif i["action"] == "ASSIGN":
            mode = new_mode.get(i["seat_id"]) or (
                "OUT_OF_SERVICE" if i["seat_status"] == "OUT_OF_SERVICE" else i["seat_type"]
            )
            if i["employment_status"] != "ACTIVE":
                conflict(i, "INACTIVE", name=i["name"])
            elif depts is not None and i["department_id"] not in depts:
                conflict(i, "PERSON_OUT_OF_SCOPE", name=i["name"])
            elif i["employee_id"] in locked_people:
                conflict(i, "SCHEDULED_PERSON", name=i["name"])
            elif mode != "FIXED":
                conflict(i, "NOT_FIXED")
    # 자율석·사용 중지가 되는 좌석에는 반영 뒤에 앉아 있는 사람이 없어야 한다
    final_by_seat = {i["seat_id"]: i["employee_id"] for i in seat_items}
    for t in type_items:
        if t["seat_mode"] == "FIXED":
            continue
        stays = occupant_id(t["seat_id"])
        final = (
            final_by_seat[t["seat_id"]] if t["seat_id"] in final_by_seat else (None if stays in assignees else stays)
        )
        if final is not None:
            conflict(t, "OCCUPIED")
    for z in zone_items:
        if z["to_zone_id"] is None:
            continue
        ok = conn.execute(
            "SELECT 1 FROM zones WHERE id = %s AND floor_id = %s AND is_active", (z["to_zone_id"], floor_id)
        ).fetchone()
        if ok is None:
            conflict(z, "ZONE_GONE")
    if conflicts:
        raise HTTPException(status_code=409, detail={"code": "CONFLICTS", "conflicts": conflicts})

    params = {"eff": eff, "cr": cr["id"]}
    # 1) 바꾸는 좌석의 지금 배정(오늘 자율석 사용 포함)과 새로 앉는 사람의 다른 고정석을 그 시각에 끝낸다
    conn.execute(
        """
        UPDATE seat_assignments SET ends_at = %(eff)s, ended_by_request_id = %(cr)s
        WHERE seat_id = ANY(%(seats)s) AND starts_at < %(eff)s AND (ends_at IS NULL OR ends_at > %(eff)s)
        """,
        {**params, "seats": [i["seat_id"] for i in seat_items]},
    )
    conn.execute(
        """
        UPDATE seat_assignments SET ends_at = %(eff)s, ended_by_request_id = %(cr)s
        WHERE employee_id = ANY(%(people)s) AND kind = 'FIXED'
          AND starts_at < %(eff)s AND (ends_at IS NULL OR ends_at > %(eff)s)
        """,
        {**params, "people": assignees},
    )
    # 2) 좌석 유형·구역 (날짜 지정 없이 바로)
    for t in type_items:
        if t["seat_mode"] == "OUT_OF_SERVICE":
            conn.execute(
                "UPDATE seats SET status = 'OUT_OF_SERVICE', updated_at = now() WHERE id = %s", (t["seat_id"],)
            )
            conn.execute(
                """
                UPDATE seat_assignments a SET ends_at = now(), ended_by_request_id = %s
                WHERE a.seat_id = %s AND a.starts_at < now() AND (a.ends_at IS NULL OR a.ends_at > now())
                """,
                (cr["id"], t["seat_id"]),
            )
        else:
            conn.execute(
                "UPDATE seats SET seat_type = %s, status = 'ACTIVE', updated_at = now() WHERE id = %s",
                (t["seat_mode"], t["seat_id"]),
            )
    for z in zone_items:
        conn.execute("UPDATE seats SET zone_id = %s, updated_at = now() WHERE id = %s", (z["to_zone_id"], z["seat_id"]))
    # 3) 새 배정
    try:
        with conn.cursor() as cur:
            cur.executemany(
                """
                INSERT INTO seat_assignments
                    (seat_id, employee_id, kind, starts_at, assigned_by, source, change_request_id)
                VALUES (%s, %s, 'FIXED', %s, %s, 'CHANGE_SET', %s)
                """,
                [
                    (i["seat_id"], i["employee_id"], eff, actor_id, cr["id"])
                    for i in seat_items
                    if i["action"] == "ASSIGN"
                ],
            )
    except errors.ExclusionViolation:
        # 위에서 확인했는데도 겹쳤다: 그사이 다른 변경이 끼어들었다
        raise HTTPException(status_code=409, detail={"code": "CONFLICTS", "conflicts": []}) from None

    conn.execute(
        """
        UPDATE change_requests
        SET status = 'APPROVED', effective_at = %s, reviewed_by = %s, reviewed_at = now(),
            submitted_at = coalesce(submitted_at, now()), updated_at = now()
        WHERE id = %s
        """,
        (eff, actor_id, cr["id"]),
    )

    floor_name = conn.execute("SELECT name FROM floors WHERE id = %s", (floor_id,)).fetchone()["name"]
    changes = [
        {
            "seat": i["code"],
            "from": occupants[i["seat_id"]]["emp_no"] if i["seat_id"] in occupants else None,
            "to": i["emp_no"],
        }
        for i in seat_items
    ]
    _audit(
        conn,
        actor_id,
        "CHANGE_SET_APPLY",
        cr["id"],
        {
            "floor": floor_name,
            "effective_at": eff,
            "seats": changes,
            "types": [{"seat": t["code"], "mode": t["seat_mode"]} for t in type_items],
            "zones": [{"seat": z["code"], "zone_id": z["to_zone_id"]} for z in zone_items],
        },
        request,
    )
    # 자리가 바뀐 사람에게 알림을 남긴다 (메신저 연동 후 발송). 새 자리 없이 끝난 사람은 seat가 None
    displaced = {
        occupants[i["seat_id"]]["employee_id"]: i["code"]
        for i in seat_items
        if i["seat_id"] in occupants and occupants[i["seat_id"]]["employee_id"] not in assignees
    }
    notes = [
        (i["employee_id"], {"floor": floor_name, "seat": i["code"], "effective_at": eff})
        for i in seat_items
        if i["action"] == "ASSIGN"
    ] + [
        (emp, {"floor": floor_name, "seat": None, "from_seat": code, "effective_at": eff})
        for emp, code in displaced.items()
    ]
    with conn.cursor() as cur:
        cur.executemany(
            """
            INSERT INTO notifications (recipient_id, channel, type, payload)
            VALUES (%s, 'IN_APP', 'SEAT_CHANGED', %s)
            """,
            [(emp, _json(payload)) for emp, payload in notes],
        )
    return {
        "id": cr["id"],
        "effective_at": eff,
        "scheduled": later,
        "changed": len(seat_items) + len(type_items) + len(zone_items),
    }


def _needs_approval(conn: Connection, request_id: int, access: dict[str, Any]) -> bool:
    """이 묶음은 층 관리자 승인을 거쳐야 하나: "승인 후" 구역 관리자, 또는 구역 경계 변경이 든 구역 관리자의 묶음"""
    if access["apply"] == "NEEDS_APPROVAL":
        return True
    if access["mode"] != "ZONE":
        return False
    row = conn.execute(
        "SELECT 1 FROM change_request_items WHERE request_id = %s AND action = 'MOVE_ZONE' LIMIT 1", (request_id,)
    ).fetchone()
    return row is not None


@router.post("/change-sets/{request_id}/apply")
def apply_change_set(request_id: int, admin: CurrentAdmin, request: Request) -> dict[str, Any]:
    """내 작업 묶음을 반영한다 (층 관리자 이상, "즉시 반영" 구역 관리자. 구역 경계 변경은 승인 요청만)"""
    with pool.connection() as conn:
        cr = _load(conn, request_id, lock=True)
        if cr["requested_by"] != admin["employee_id"] or cr["status"] != "DRAFT":
            raise HTTPException(status_code=409, detail={"code": "NOT_DRAFT"})
        access = _require_access(admin, _floor(conn, cr["floor_id"]))
        if _needs_approval(conn, request_id, access):
            raise HTTPException(status_code=403, detail={"code": "NEEDS_APPROVAL"})
        return {"applied": _apply(conn, cr, access, admin["employee_id"], request)}


@router.post("/change-sets/{request_id}/submit")
def submit_change_set(request_id: int, admin: CurrentAdmin, request: Request) -> dict[str, Any]:
    """층 관리자에게 승인 요청 ("층 관리자 승인 후" 구역 관리자, 구역 경계를 바꾸려는 구역 관리자)"""
    with pool.connection() as conn:
        cr = _load(conn, request_id, lock=True)
        if cr["requested_by"] != admin["employee_id"] or cr["status"] != "DRAFT":
            raise HTTPException(status_code=409, detail={"code": "NOT_DRAFT"})
        access = _require_access(admin, _floor(conn, cr["floor_id"]))
        if not _needs_approval(conn, request_id, access):
            raise HTTPException(status_code=409, detail={"code": "APPLY_DIRECTLY"})
        if (
            conn.execute("SELECT 1 FROM change_request_items WHERE request_id = %s LIMIT 1", (request_id,)).fetchone()
            is None
        ):
            raise HTTPException(status_code=422, detail={"code": "EMPTY"})
        conn.execute(
            "UPDATE change_requests SET status = 'PENDING', submitted_at = now(), updated_at = now() WHERE id = %s",
            (request_id,),
        )
        _audit(conn, admin["employee_id"], "CHANGE_SET_SUBMIT", request_id, {"floor_id": cr["floor_id"]}, request)
    return {"status": "PENDING"}


@router.post("/change-sets/{request_id}/withdraw")
def withdraw_change_set(request_id: int, admin: CurrentAdmin) -> dict[str, Any]:
    """승인 요청을 거두고 다시 작성 중으로 (고치려고)"""
    with pool.connection() as conn:
        cr = _load(conn, request_id, lock=True)
        if cr["requested_by"] != admin["employee_id"] or cr["status"] != "PENDING":
            raise HTTPException(status_code=409, detail={"code": "NOT_PENDING"})
        conn.execute(
            "UPDATE change_requests SET status = 'DRAFT', submitted_at = NULL, updated_at = now() WHERE id = %s",
            (request_id,),
        )
    return {"status": "DRAFT"}


@router.post("/change-sets/{request_id}/approve")
def approve_change_set(request_id: int, admin: CurrentAdmin, request: Request) -> dict[str, Any]:
    """승인하고 반영한다 (그 층 관리자 이상)"""
    with pool.connection() as conn:
        cr = _load(conn, request_id, lock=True)
        if cr["status"] != "PENDING":
            raise HTTPException(status_code=409, detail={"code": "NOT_PENDING"})
        access = _require_access(admin, _floor(conn, cr["floor_id"]))
        if access["mode"] != "FLOOR":
            raise HTTPException(status_code=403, detail={"code": "NOT_REVIEWER"})
        return {"applied": _apply(conn, cr, access, admin["employee_id"], request)}


class RejectIn(BaseModel):
    comment: str = Field(min_length=1, max_length=200)


@router.post("/change-sets/{request_id}/reject")
def reject_change_set(request_id: int, body: RejectIn, admin: CurrentAdmin, request: Request) -> dict[str, Any]:
    """반려 (사유 필수). 요청한 사람은 사유를 보고 고쳐서 다시 요청한다"""
    with pool.connection() as conn:
        cr = _load(conn, request_id, lock=True)
        if cr["status"] != "PENDING":
            raise HTTPException(status_code=409, detail={"code": "NOT_PENDING"})
        access = _require_access(admin, _floor(conn, cr["floor_id"]))
        if access["mode"] != "FLOOR":
            raise HTTPException(status_code=403, detail={"code": "NOT_REVIEWER"})
        comment = body.comment.strip()
        if not comment:
            raise HTTPException(status_code=422, detail={"code": "COMMENT_REQUIRED"})
        conn.execute(
            """
            UPDATE change_requests SET status = 'REJECTED', reviewed_by = %s, reviewed_at = now(),
                   review_comment = %s, updated_at = now()
            WHERE id = %s
            """,
            (admin["employee_id"], comment, request_id),
        )
        _audit(conn, admin["employee_id"], "CHANGE_SET_REJECT", request_id, {"comment": comment}, request)
    return {"status": "REJECTED"}


@router.post("/change-sets/{request_id}/reopen")
def reopen_change_set(request_id: int, admin: CurrentAdmin) -> dict[str, Any]:
    """반려된 내 요청을 새 작성 중 묶음으로 복사해서 다시 고친다 (반려된 것은 이력으로 남는다)"""
    with pool.connection() as conn:
        cr = _load(conn, request_id)
        if (
            cr["requested_by"] != admin["employee_id"]
            or cr["status"] != "REJECTED"
            or cr["request_type"] != "SEAT_ASSIGNMENT"
        ):
            raise HTTPException(status_code=409, detail={"code": "NOT_REJECTED"})
        _require_access(admin, _floor(conn, cr["floor_id"]))
        try:
            new_id = conn.execute(
                """
                INSERT INTO change_requests (floor_id, zone_id, request_type, status, note, effective_at, requested_by)
                SELECT floor_id, zone_id, request_type, 'DRAFT', note,
                       CASE WHEN effective_at > now() THEN effective_at END, requested_by
                FROM change_requests WHERE id = %s
                RETURNING id
                """,
                (request_id,),
            ).fetchone()["id"]
        except errors.UniqueViolation:
            raise HTTPException(status_code=409, detail={"code": "HAS_OPEN"}) from None
        conn.execute(
            """
            INSERT INTO change_request_items
                (request_id, seat_id, action, employee_id, expected_employee_id, to_zone_id, seat_mode)
            SELECT %s, seat_id, action, employee_id, expected_employee_id, to_zone_id, seat_mode
            FROM change_request_items WHERE request_id = %s ORDER BY id
            """,
            (new_id, request_id),
        )
    return {"draft_id": new_id}


@router.post("/change-sets/{request_id}/cancel")
def cancel_scheduled(request_id: int, admin: CurrentAdmin, request: Request) -> dict[str, Any]:
    """날짜를 정해 반영한 묶음을 그날이 오기 전에 취소한다. 새 배정은 지우고, 끝내기로 한 배정은 되살린다.
    팀 이사처럼 여러 층에 걸쳐 함께 만든 묶음(move_group)은 함께 취소한다"""
    with pool.connection() as conn:
        cr = _load(conn, request_id, lock=True)
        if cr["status"] != "APPROVED" or not cr["in_future"]:
            raise HTTPException(status_code=409, detail={"code": "NOT_SCHEDULED"})
        group = [cr]
        if cr["move_group"] is not None:
            group = [
                _load(conn, r["id"], lock=True)
                for r in conn.execute(
                    """
                    SELECT id FROM change_requests
                    WHERE move_group = %s AND status = 'APPROVED' AND effective_at > now()
                    ORDER BY floor_id
                    """,
                    (cr["move_group"],),
                ).fetchall()
            ]
        for item in group:
            access = _require_access(admin, _floor(conn, item["floor_id"]))
            if access["mode"] != "FLOOR" and item["requested_by"] != admin["employee_id"]:
                raise HTTPException(status_code=403, detail={"code": "NOT_IN_SCOPE"})
        for floor_id in sorted({item["floor_id"] for item in group}):
            conn.execute("SELECT pg_advisory_xact_lock(%s, %s)", (LOCK_SEATING, floor_id))
        for item in group:
            conn.execute(
                "DELETE FROM seat_assignments WHERE change_request_id = %s AND starts_at > now()", (item["id"],)
            )
            conn.execute(
                """
                UPDATE seat_assignments SET ends_at = NULL, ended_by_request_id = NULL
                WHERE ended_by_request_id = %s AND kind = 'FIXED' AND ends_at > now()
                """,
                (item["id"],),
            )
            conn.execute(
                "UPDATE change_requests SET status = 'CANCELLED', updated_at = now() WHERE id = %s", (item["id"],)
            )
            _audit(
                conn,
                admin["employee_id"],
                "CHANGE_SET_CANCEL",
                item["id"],
                {"effective_at": item["effective_at"], "move_group": item["move_group"]},
                request,
            )
    return {"status": "CANCELLED", "cancelled": [item["id"] for item in group]}


# 실시간 ----------------------------------------------------------------------


def _admin_alive(token: str | None) -> bool:
    if not token:
        return False
    with pool.connection() as conn:
        return load_admin(conn, token, touch=False) is not None


@router.get("/stream")
async def admin_stream(request: Request) -> StreamingResponse:
    """배치 화면용 SSE: 다른 관리자가 반영한 좌석 변경 (event: floor, resync).

    열려 있는 것만으로는 자동 로그아웃 시간을 늘리지 않는다.
    """
    token = request.cookies.get(settings.admin_cookie_name)
    if not await run_in_threadpool(_admin_alive, token):
        raise HTTPException(status_code=401, detail={"code": "NOT_ADMIN_LOGGED_IN"})
    return StreamingResponse(
        hub.events(frozenset({"floor"}), lambda: _admin_alive(token)),
        media_type="text/event-stream",
        headers=SSE_HEADERS,
    )
