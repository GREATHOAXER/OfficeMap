"""팀 이사 도우미 API: 한 팀을 다른 층(또는 같은 층의 다른 자리)으로 한 번에, 날짜를 정해 옮긴다.

좌석 배치 묶음(change_requests)을 그대로 쓴다. 목적지 층에는 "새 자리 배정" 묶음 하나, 미배치로 보내는 사람이
있으면 그 사람이 지금 앉은 층마다 "자리 비우기" 묶음을 만들고 같은 move_group으로 묶어 한 트랜잭션에 반영한다.
새 자리에 앉으면 원래 자리(다른 층이어도)는 같은 시각에 끝난다. 날짜를 정했으면 그날 0시에 바뀌고,
그 전에는 배치 화면의 요청 목록에서 "예정 취소"로 함께 취소한다.

목적지 구역의 부서를 이 팀으로 바꾸는 것(구역 이름표)은 날짜와 상관없이 바로 반영한다.
권한: 목적지 층과 미배치로 보내는 사람이 앉은 층의 층 관리자 이상.
"""

import datetime as dt
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from app.admin_auth import CurrentAdmin
from app.db import pool
from app.routers.auth import client_info
from app.routers.seating import (
    LOCK_SEATING,
    _access,
    _apply,
    _department_choices,
    _effective_at,
    _floor,
    _json,
)

router = APIRouter(prefix="/api/admin/moves", tags=["moves"])


def _floor_access(admin: dict[str, Any], floor: dict[str, Any]) -> dict[str, Any]:
    access = _access(admin, floor)
    if access is None or access["mode"] != "FLOOR":
        raise HTTPException(status_code=403, detail={"code": "FLOOR_ADMIN_ONLY", "floor": floor["name"]})
    return access


@router.get("/options")
def move_options(admin: CurrentAdmin) -> dict[str, Any]:
    """옮길 수 있는 팀(살아 있는 팀과 인원)과 목적지로 고를 수 있는 층 (층 관리자 이상인 층)"""
    with pool.connection() as conn:
        floors = conn.execute(
            """
            SELECT f.id, f.name, f.site_id, s.name AS site_name
            FROM floors f JOIN sites s ON s.id = f.site_id
            WHERE f.is_active AND s.is_active
            ORDER BY s.sort_order, s.id, f.sort_order DESC
            """
        ).fetchall()
        counts = {
            r["department_id"]: r["n"]
            for r in conn.execute(
                """
                SELECT department_id, count(*)::int AS n FROM employees
                WHERE employment_status = 'ACTIVE' GROUP BY department_id
                """
            ).fetchall()
        }
        departments = [{**d, "members": counts.get(d["id"], 0)} for d in _department_choices(conn)]
    mine = [f for f in floors if (a := _access(admin, f)) is not None and a["mode"] == "FLOOR"]
    return {
        "departments": [d for d in departments if d["members"]],
        "floors": [{"id": f["id"], "name": f["name"], "site": f["site_name"]} for f in mine],
    }


@router.get("/team")
def team(admin: CurrentAdmin, department_id: int = Query()) -> dict[str, Any]:
    """옮길 팀의 사람과 지금 자리 (날짜를 정해 둔 변경이 걸린 사람은 locked)"""
    if not move_options(admin)["floors"]:
        raise HTTPException(status_code=403, detail={"code": "FLOOR_ADMIN_ONLY"})
    with pool.connection() as conn:
        rows = conn.execute(
            """
            SELECT e.emp_no, e.name, e.rank_name, s.id AS seat_id, s.code AS seat_code, f.id AS floor_id,
                   f.name AS floor_name, z.code AS zone_code,
                   EXISTS (SELECT 1 FROM seat_assignments x
                           WHERE x.employee_id = e.id AND x.kind = 'FIXED'
                             AND (x.starts_at > now() OR (x.ended_by_request_id IS NOT NULL AND x.ends_at > now()))
                   ) AS locked
            FROM employees e
            LEFT JOIN seat_assignments a ON a.employee_id = e.id AND a.kind = 'FIXED'
                 AND a.starts_at <= now() AND (a.ends_at IS NULL OR a.ends_at > now())
            LEFT JOIN seats s ON s.id = a.seat_id
            LEFT JOIN floors f ON f.id = s.floor_id
            LEFT JOIN zones z ON z.id = s.zone_id
            WHERE e.department_id = %s AND e.employment_status = 'ACTIVE'
            ORDER BY f.sort_order DESC NULLS LAST, s.code NULLS LAST, e.name
            """,
            (department_id,),
        ).fetchall()
    return {
        "members": [
            {
                "emp_no": r["emp_no"],
                "name": r["name"],
                "rank": r["rank_name"],
                "seat": (
                    {"id": r["seat_id"], "code": r["seat_code"], "floor_id": r["floor_id"], "floor": r["floor_name"]}
                    if r["seat_id"]
                    else None
                ),
                "zone_code": r["zone_code"],
                "locked": r["locked"],
            }
            for r in rows
        ]
    }


class MoveItem(BaseModel):
    emp_no: str = Field(max_length=20)
    seat_id: int | None = None  # 목적지 층의 새 자리. None이면 미배치로 (지금 자리만 끝낸다)


class MoveIn(BaseModel):
    department_id: int
    to_floor_id: int
    moves: list[MoveItem] = Field(min_length=1, max_length=500)
    effective_date: dt.date | None = None  # 이날 0시(서울)부터. 없으면 바로
    note: str | None = Field(default=None, max_length=200)
    zone_ids: list[int] = Field(default_factory=list, max_length=20)  # 이 팀의 구역으로 바꿀 목적지 구역


@router.post("", status_code=201)
def create_move(body: MoveIn, admin: CurrentAdmin, request: Request) -> dict[str, Any]:
    """팀 이사 반영 (날짜를 정했으면 예약). 하나라도 맞지 않으면 아무것도 바꾸지 않고 409 CONFLICTS"""
    actor = admin["employee_id"]
    effective_at = _effective_at(body.effective_date)
    emp_nos = [m.emp_no for m in body.moves]
    seat_ids = [m.seat_id for m in body.moves if m.seat_id is not None]
    if len(set(emp_nos)) != len(emp_nos):
        raise HTTPException(status_code=422, detail={"code": "DUPLICATE_PERSON"})
    if len(set(seat_ids)) != len(seat_ids):
        raise HTTPException(status_code=422, detail={"code": "DUPLICATE_SEAT"})
    with pool.connection() as conn:
        dest = _floor(conn, body.to_floor_id)
        dest_access = _floor_access(admin, dest)
        dept = conn.execute(
            "SELECT id, name FROM departments WHERE id = %s AND is_active", (body.department_id,)
        ).fetchone()
        if dept is None:
            raise HTTPException(status_code=422, detail={"code": "DEPARTMENT_NOT_FOUND"})
        people = {
            e["emp_no"]: e
            for e in conn.execute(
                """
                SELECT e.id, e.emp_no, e.name, e.department_id, e.employment_status,
                       a.seat_id, s.floor_id AS seat_floor_id
                FROM employees e
                LEFT JOIN seat_assignments a ON a.employee_id = e.id AND a.kind = 'FIXED'
                     AND a.starts_at <= now() AND (a.ends_at IS NULL OR a.ends_at > now())
                LEFT JOIN seats s ON s.id = a.seat_id
                WHERE e.emp_no = ANY(%s)
                """,
                (emp_nos,),
            ).fetchall()
        }
        for emp_no in emp_nos:
            person = people.get(emp_no)
            if person is None or person["employment_status"] != "ACTIVE" or person["department_id"] != dept["id"]:
                raise HTTPException(status_code=422, detail={"code": "NOT_IN_TEAM", "emp_no": emp_no})
        seats = {
            s["id"]: s
            for s in conn.execute(
                "SELECT id, code, zone_id, seat_type, status FROM seats WHERE id = ANY(%s) AND floor_id = %s",
                (seat_ids, dest["id"]),
            ).fetchall()
        }
        for seat_id in seat_ids:
            seat = seats.get(seat_id)
            if seat is None or seat["status"] != "ACTIVE" or seat["seat_type"] != "FIXED":
                raise HTTPException(status_code=422, detail={"code": "SEAT_NOT_AVAILABLE", "seat_id": seat_id})

        # 미배치로 보낼 사람: 지금 앉은 층마다 자리 비우기 (그 층도 층 관리자여야 한다)
        leave: dict[int, list[dict[str, Any]]] = {}
        for m in body.moves:
            person = people[m.emp_no]
            if m.seat_id is None and person["seat_id"] is not None:
                leave.setdefault(person["seat_floor_id"], []).append(person)
        accesses = {dest["id"]: dest_access}
        for floor_id in leave:
            accesses[floor_id] = _floor_access(admin, _floor(conn, floor_id))
        # 층을 잠그는 순서를 정해 두 사람이 서로 다른 층에서 동시에 해도 엇갈리지 않게
        for floor_id in sorted(accesses):
            conn.execute("SELECT pg_advisory_xact_lock(%s, %s)", (LOCK_SEATING, floor_id))

        # 목적지 구역을 이 팀 구역으로 (바로). 다른 팀 사람이 앉아 있는 구역은 바꾸지 않는다
        for zone_id in body.zone_ids:
            zone = conn.execute(
                "SELECT id, name, department_id FROM zones WHERE id = %s AND floor_id = %s AND is_active",
                (zone_id, dest["id"]),
            ).fetchone()
            if zone is None:
                raise HTTPException(status_code=422, detail={"code": "ZONE_NOT_FOUND", "zone_id": zone_id})
            others = conn.execute(
                """
                SELECT count(*)::int AS n FROM seat_assignments a
                JOIN seats s ON s.id = a.seat_id JOIN employees e ON e.id = a.employee_id
                WHERE s.zone_id = %s AND a.kind = 'FIXED' AND (a.ends_at IS NULL OR a.ends_at > now())
                  AND e.department_id IS DISTINCT FROM %s AND NOT (e.emp_no = ANY(%s))
                """,
                (zone_id, dept["id"], emp_nos),
            ).fetchone()["n"]
            if others:
                raise HTTPException(status_code=409, detail={"code": "ZONE_OCCUPIED", "zone": zone["name"]})
            conn.execute(
                """
                UPDATE zones
                SET department_id = %s, name = CASE WHEN name_custom THEN name ELSE %s END, updated_at = now()
                WHERE id = %s
                """,
                (dept["id"], dept["name"], zone_id),
            )

        note = f"팀 이사: {dept['name']} → {dest['name']}" + (f" · {body.note.strip()}" if body.note else "")
        created: list[dict[str, Any]] = []

        def new_request(floor_id: int) -> dict[str, Any]:
            # 처음부터 APPROVED로 넣는다 (관리자의 작성 중 묶음과 겹치지 않게). 아래 _apply가 마저 채운다
            row = conn.execute(
                """
                INSERT INTO change_requests (floor_id, request_type, status, note, effective_at, requested_by,
                                             move_group)
                VALUES (%s, 'SEAT_ASSIGNMENT', 'APPROVED', %s, %s, %s, %s)
                RETURNING id, floor_id, status, request_type, effective_at, requested_by, note
                """,
                (floor_id, note, effective_at, actor, created[0]["id"] if created else None),
            ).fetchone()
            if not created:
                conn.execute("UPDATE change_requests SET move_group = id WHERE id = %s", (row["id"],))
            created.append(row)
            return row

        assigns = [m for m in body.moves if m.seat_id is not None]
        if assigns:
            cr = new_request(dest["id"])
            # 고른 자리는 비어 있어야 한다. 이번에 함께 옮기는 팀원이 앉은 자리만 예외 (팀 안에서 자리 바꾸기)
            moving = {people[m.emp_no]["id"] for m in body.moves}
            sitting = {
                r["seat_id"]: r["employee_id"]
                for r in conn.execute(
                    """
                    SELECT a.seat_id, a.employee_id FROM seat_assignments a
                    WHERE a.seat_id = ANY(%s) AND a.kind = 'FIXED' AND a.starts_at <= now()
                      AND (a.ends_at IS NULL OR a.ends_at > now())
                    """,
                    (seat_ids,),
                ).fetchall()
            }
            with conn.cursor() as cur:
                cur.executemany(
                    """
                    INSERT INTO change_request_items (request_id, seat_id, action, employee_id, expected_employee_id)
                    VALUES (%s, %s, 'ASSIGN', %s, %s)
                    """,
                    [
                        (
                            cr["id"],
                            m.seat_id,
                            people[m.emp_no]["id"],
                            sitting.get(m.seat_id) if sitting.get(m.seat_id) in moving else None,
                        )
                        for m in assigns
                    ],
                )
        for floor_id, leavers in leave.items():
            cr = new_request(floor_id)
            with conn.cursor() as cur:
                cur.executemany(
                    """
                    INSERT INTO change_request_items (request_id, seat_id, action, expected_employee_id)
                    VALUES (%s, %s, 'UNASSIGN', %s)
                    """,
                    [(cr["id"], p["seat_id"], p["id"]) for p in leavers],
                )
        if not created:
            raise HTTPException(status_code=422, detail={"code": "NOTHING_TO_MOVE"})

        results = [_apply(conn, cr, accesses[cr["floor_id"]], actor, request) for cr in created]
        group = created[0]["id"]
        summary = {
            "department": dept["name"],
            "to_floor": dest["name"],
            "effective_at": results[0]["effective_at"],
            "scheduled": results[0]["scheduled"],
            "moved": len(assigns),
            "unassigned": sum(len(v) for v in leave.values()),
            "zones": body.zone_ids,
            "requests": [cr["id"] for cr in created],
        }
        conn.execute(
            """
            INSERT INTO audit_logs (actor_id, action, target_type, target_id, after_data, ip_address)
            VALUES (%s, 'TEAM_MOVE', 'change_request', %s, %s, %s)
            """,
            (actor, group, _json(summary), client_info(request)[0]),
        )
    return {"move": {"id": group, **summary}}
