"""자리·재실 현황(①) API: 사업장·층 목록, 층별 도면·구역·회의실·좌석"""

from typing import Any

from fastapi import APIRouter, HTTPException

from app.db import pool
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

    result: list[dict[str, Any]] = []
    for row in rows:
        if not result or result[-1]["id"] != row["site_id"]:
            result.append({"id": row["site_id"], "name": row["site_name"], "floors": []})
        result[-1]["floors"].append(
            {"id": row["floor_id"], "name": row["floor_name"], "description": row["description"], "teams": row["teams"]}
        )
    return {"sites": result, "my_floor_id": my_seat["floor_id"] if my_seat else None}


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
            SELECT m.id, m.name, m.capacity, m.equipment, m.requires_approval, m.shape,
                   cur.title AS current_title, cur.ends_at AS busy_until, nxt.starts_at AS next_start
            FROM meeting_rooms m
            LEFT JOIN LATERAL (
                SELECT r.title, r.ends_at FROM reservations r
                WHERE r.room_id = m.id AND r.status = 'CONFIRMED' AND r.starts_at <= now() AND r.ends_at > now()
                LIMIT 1
            ) cur ON true
            LEFT JOIN LATERAL (
                SELECT min(r.starts_at) AS starts_at FROM reservations r
                WHERE r.room_id = m.id AND r.status IN ('CONFIRMED', 'PENDING_APPROVAL')
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
            SELECT s.id, s.code, s.zone_id, s.seat_type, s.x::float8 AS x, s.y::float8 AS y, s.rotation, s.status,
                   a.kind AS assignment_kind, e.emp_no, e.name, e.rank_name, d.name AS department,
                   e.extension, e.email,
                   CASE WHEN {_LIVE_PRESENCE} THEN p.status END AS presence_status,
                   CASE WHEN {_LIVE_PRESENCE} THEN p.message END AS presence_message,
                   CASE WHEN {_LIVE_PRESENCE} THEN p.expires_at END AS presence_expires_at
            FROM seats s
            LEFT JOIN seat_assignments a ON a.seat_id = s.id AND {_CURRENT_ASSIGNMENT}
            LEFT JOIN employees e ON e.id = a.employee_id AND e.employment_status = 'ACTIVE'
            LEFT JOIN departments d ON d.id = e.department_id
            LEFT JOIN presence_status p ON p.employee_id = e.id
            WHERE s.floor_id = %s AND s.status <> 'REMOVED'
            ORDER BY s.code
            """,
            (floor_id,),
        ).fetchall()

    return {
        "floor": {
            "id": floor["id"],
            "name": floor["name"],
            "site": {"id": floor["site_id"], "name": floor["site_name"]},
        },
        # 이 데이터를 읽은 시각. 화면은 이보다 나중에 온 실시간 알림만 덮어쓴다
        "fetched_at": floor["fetched_at"],
        "plan": plan,
        "zones": zones,
        "rooms": [_room_out(r) for r in rooms],
        "seats": [_seat_out(s) for s in seats],
    }


def _room_out(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "capacity": row["capacity"],
        "equipment": row["equipment"],
        "requires_approval": row["requires_approval"],
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
            "presence": (
                {
                    "status": row["presence_status"],
                    "message": row["presence_message"],
                    "expires_at": row["presence_expires_at"],
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
        "status": row["status"],
        "occupant": occupant,
    }
