"""자리·재실 현황(①) API: 사업장·층 목록, 층별 도면·구역·회의실·좌석"""

from typing import Any

from fastapi import APIRouter, HTTPException

from app.db import pool
from app.plan_geometry import to_ratio
from app.routers.profile import PROFILE_COLUMNS, PROFILE_JOIN, profile_out
from app.session import CurrentUser

router = APIRouter(prefix="/api/office", tags=["office"])

# 지금 유효한 배정 / 재실 상태 (만료된 상태는 없는 것으로 본다)
_CURRENT_ASSIGNMENT = "a.starts_at <= now() AND (a.ends_at IS NULL OR a.ends_at > now())"
_LIVE_PRESENCE = "(p.expires_at IS NULL OR p.expires_at > now())"


@router.get("/sites")
def sites(user: CurrentUser) -> dict[str, Any]:
    """사업장과 층 목록. 층마다 용도(로비 등)와 입주 팀 이름을 붙인다 (층 버튼 아래 작은 글씨)."""
    with pool.connection() as conn:
        rows = conn.execute(
            """
            SELECT s.id AS site_id, s.name AS site_name, f.id AS floor_id, f.name AS floor_name,
                   f.description,
                   coalesce(array_agg(z.name ORDER BY z.sort_order) FILTER (WHERE z.id IS NOT NULL), '{}') AS teams
            FROM sites s
            JOIN floors f ON f.site_id = s.id AND f.is_active
            LEFT JOIN zones z ON z.floor_id = f.id AND z.is_active AND z.department_id IS NOT NULL
            WHERE s.is_active
            GROUP BY s.id, f.id
            ORDER BY s.sort_order, s.id, f.sort_order
            """
        ).fetchall()
        my_seat = conn.execute(
            f"""
            SELECT s.floor_id
            FROM seat_assignments a
            JOIN seats s ON s.id = a.seat_id
            WHERE a.employee_id = %s AND {_CURRENT_ASSIGNMENT}
            ORDER BY a.kind = 'FIXED' DESC
            LIMIT 1
            """,
            (user["employee_id"],),
        ).fetchone()
        # 자리가 아직 없는 사람(신규 입사자 등)은 우리 팀 구역이 있는 층을 먼저 연다
        team_floor = conn.execute(
            """
            SELECT z.floor_id
            FROM employees e JOIN zones z ON z.department_id = e.department_id AND z.is_active
            WHERE e.id = %s
            ORDER BY z.floor_id
            LIMIT 1
            """,
            (user["employee_id"],),
        ).fetchone()

    result: list[dict[str, Any]] = []
    for row in rows:
        if not result or result[-1]["id"] != row["site_id"]:
            result.append({"id": row["site_id"], "name": row["site_name"], "floors": []})
        result[-1]["floors"].append(
            {"id": row["floor_id"], "name": row["floor_name"], "description": row["description"], "teams": row["teams"]}
        )
    return {
        "sites": result,
        "my_floor_id": my_seat["floor_id"] if my_seat else None,
        "team_floor_id": team_floor["floor_id"] if team_floor else None,
    }


@router.get("/floors/{floor_id}")
def floor_map(floor_id: int, user: CurrentUser) -> dict[str, Any]:
    """한 층의 게시된 도면, 팀 구역, 회의실 사용 현황, 좌석과 앉은 사람."""
    with pool.connection() as conn:
        floor = conn.execute(
            """
            SELECT f.id, f.name, s.id AS site_id, s.name AS site_name, now() AS fetched_at
            FROM floors f JOIN sites s ON s.id = f.site_id
            WHERE f.id = %s AND f.is_active
            """,
            (floor_id,),
        ).fetchone()
        if floor is None:
            raise HTTPException(status_code=404, detail={"code": "FLOOR_NOT_FOUND"})

        plan = conn.execute(
            """
            SELECT version, width_m::float8 AS width_m, height_m::float8 AS height_m, geometry, published_at
            FROM floor_plans
            WHERE floor_id = %s AND status = 'PUBLISHED'
            """,
            (floor_id,),
        ).fetchone()
        if plan is not None:
            # 도면 편집기 모양(미터)이면 화면이 그리는 비율 좌표로 바꾼다
            plan["geometry"] = to_ratio(plan["geometry"], plan["width_m"], plan["height_m"])

        zones = conn.execute(
            """
            SELECT z.id, z.code, z.name, d.name AS department, z.color_key, z.shape
            FROM zones z LEFT JOIN departments d ON d.id = z.department_id
            WHERE z.floor_id = %s AND z.is_active
            ORDER BY z.sort_order, z.code
            """,
            (floor_id,),
        ).fetchall()

        # 지금 사용 중인 예약과, 오늘(서울 기준) 안에 시작하는 다음 예약
        rooms = conn.execute(
            """
            SELECT m.id, m.name, m.capacity, m.equipment, m.shape,
                   cur.title AS current_title, cur.ends_at AS busy_until, nxt.starts_at AS next_start
            FROM meeting_rooms m
            LEFT JOIN LATERAL (
                SELECT r.title, r.ends_at FROM reservations r
                WHERE r.room_id = m.id AND r.status = 'CONFIRMED' AND r.starts_at <= now() AND r.ends_at > now()
                LIMIT 1
            ) cur ON true
            LEFT JOIN LATERAL (
                SELECT min(r.starts_at) AS starts_at FROM reservations r
                WHERE r.room_id = m.id AND r.status = 'CONFIRMED'
                  AND r.starts_at > now()
                  AND r.starts_at < (date_trunc('day', now() AT TIME ZONE 'Asia/Seoul') + interval '1 day')
                                    AT TIME ZONE 'Asia/Seoul'
            ) nxt ON true
            WHERE m.floor_id = %s AND m.is_active
            ORDER BY m.sort_order, m.id
            """,
            (floor_id,),
        ).fetchall()

        seats = conn.execute(
            f"""
            SELECT s.id, s.code, s.zone_id, s.seat_type, s.x::float8 AS x, s.y::float8 AS y, s.rotation,
                   s.w::float8 AS w, s.h::float8 AS h, s.status,
                   a.kind AS assignment_kind, e.emp_no, e.name, e.rank_name, d.name AS department,
                   e.extension, e.email,
                   CASE WHEN {_LIVE_PRESENCE} THEN p.status END AS presence_status,
                   CASE WHEN {_LIVE_PRESENCE} THEN p.message END AS presence_message,
                   CASE WHEN {_LIVE_PRESENCE} THEN p.expires_at END AS presence_expires_at,
                   CASE WHEN {_LIVE_PRESENCE} THEN p.updated_at END AS presence_updated_at,
                   {PROFILE_COLUMNS}
            FROM seats s
            LEFT JOIN seat_assignments a ON a.seat_id = s.id AND {_CURRENT_ASSIGNMENT}
            LEFT JOIN employees e ON e.id = a.employee_id AND e.employment_status = 'ACTIVE'
            LEFT JOIN departments d ON d.id = e.department_id
            LEFT JOIN presence_status p ON p.employee_id = e.id
            {PROFILE_JOIN}
            WHERE s.floor_id = %s AND s.status <> 'REMOVED'
            ORDER BY s.code
            """,
            (floor_id,),
        ).fetchall()

        # 날짜를 정해 둔 배치 변경·자율석 사용 끝 등, 이 층 자리가 다음에 저절로 바뀌는 시각.
        # 화면은 그때 다시 읽는다 (그 시각에는 따로 알림이 오지 않는다)
        next_change = conn.execute(
            """
            SELECT min(t) AS at FROM (
                SELECT a.starts_at AS t FROM seat_assignments a JOIN seats s ON s.id = a.seat_id
                WHERE s.floor_id = %(floor)s AND a.starts_at > now()
                UNION ALL
                SELECT a.ends_at FROM seat_assignments a JOIN seats s ON s.id = a.seat_id
                WHERE s.floor_id = %(floor)s AND a.ends_at > now()
            ) t
            """,
            {"floor": floor_id},
        ).fetchone()

    return {
        "floor": {
            "id": floor["id"],
            "name": floor["name"],
            "site": {"id": floor["site_id"], "name": floor["site_name"]},
        },
        # 이 데이터를 읽은 시각. 화면은 이보다 나중에 온 실시간 알림만 덮어쓴다
        "fetched_at": floor["fetched_at"],
        "next_change_at": next_change["at"],
        "plan": plan,
        "zones": zones,
        "rooms": [_room_out(r) for r in rooms],
        "seats": [_seat_out(s) for s in seats],
    }


@router.get("/my-seat")
def my_seat(user: CurrentUser) -> dict[str, Any]:
    """내 고정석: 지금 자리와, 날짜를 정해 둔 다음 변경 (새 자리 또는 배정 해제)."""
    with pool.connection() as conn:
        rows = conn.execute(
            """
            SELECT a.starts_at, a.ends_at, a.starts_at <= now() AS started,
                   s.id AS seat_id, s.code, f.id AS floor_id, f.name AS floor_name
            FROM seat_assignments a
            JOIN seats s ON s.id = a.seat_id
            JOIN floors f ON f.id = s.floor_id
            WHERE a.employee_id = %s AND a.kind = 'FIXED' AND (a.ends_at IS NULL OR a.ends_at > now())
            ORDER BY a.starts_at
            """,
            (user["employee_id"],),
        ).fetchall()

    def seat(row: dict[str, Any]) -> dict[str, Any]:
        return {"id": row["seat_id"], "code": row["code"], "floor_id": row["floor_id"], "floor": row["floor_name"]}

    current = next((r for r in rows if r["started"]), None)
    upcoming = next((r for r in rows if not r["started"]), None)
    change = None
    if upcoming is not None:
        change = {"at": upcoming["starts_at"], "seat": seat(upcoming)}
    elif current is not None and current["ends_at"] is not None:
        change = {"at": current["ends_at"], "seat": None}  # 그날 배정이 끝나고 새 자리는 없다
    return {"seat": seat(current) if current else None, "change": change}


def _room_out(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "capacity": row["capacity"],
        "equipment": row["equipment"],
        "shape": row["shape"],
        "busy_until": row["busy_until"],
        "current_title": row["current_title"],
        "next_start": row["next_start"],
    }


def _seat_out(row: dict[str, Any]) -> dict[str, Any]:
    occupant = None
    if row["emp_no"] is not None:
        occupant = {
            "emp_no": row["emp_no"],
            "name": row["name"],
            "rank": row["rank_name"],
            "department": row["department"],
            "extension": row["extension"],
            "email": row["email"],
            "kind": row["assignment_kind"],
            **profile_out(row),  # 사진·부르는 이름·한 줄 소개·하는 일·업무 키워드 (내 정보)
            "presence": (
                {
                    "status": row["presence_status"],
                    "message": row["presence_message"],
                    "expires_at": row["presence_expires_at"],
                    "updated_at": row["presence_updated_at"],  # 언제 바꾼 상태인지 (오래된 상태를 알아보게)
                }
                if row["presence_status"]
                else None
            ),
        }
    return {
        "id": row["id"],
        "code": row["code"],
        "zone_id": row["zone_id"],
        "seat_type": row["seat_type"],
        "x": row["x"],
        "y": row["y"],
        "rotation": row["rotation"],
        "w": row["w"],  # 좌석 크기 (도면 대비, 없으면 기본 책상)
        "h": row["h"],
        "status": row["status"],
        "occupant": occupant,
    }
