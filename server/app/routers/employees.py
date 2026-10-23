"""직원 검색 API. 자리·재실 현황의 검색창과 회의실 예약의 참석자 추가에서 쓴다."""

import datetime as dt
from typing import Any

from fastapi import APIRouter, Query

from app.db import pool
from app.session import CurrentUser

router = APIRouter(prefix="/api/employees", tags=["employees"])

MAX_TOKENS = 3


def _like(token: str) -> str:
    """LIKE 패턴에서 특수문자(%, _, \\)를 글자 그대로 찾도록 바꾼다."""
    return token.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


@router.get("/search")
def search(
    user: CurrentUser,
    q: str = Query(min_length=1, max_length=50),
    limit: int = Query(default=20, ge=1, le=50),
    date: dt.date | None = None,
    start_min: int | None = Query(default=None, ge=0, le=1440),
    end_min: int | None = Query(default=None, ge=0, le=1440),
) -> dict[str, Any]:
    """이름·팀·사번으로 찾는다. 띄어 쓴 낱말은 모두 맞아야 한다 (예: "김민준 IT").

    date·start_min·end_min(서울 기준 그날 0시부터 분)을 주면 그 시간에 겹치는 다른 회의와
    휴가·외근 일정을 같이 알려 준다 (참석자 고를 때 "이 시간 회의 있음" 표시).
    """
    tokens = q.split()[:MAX_TOKENS]
    if not tokens:
        return {"results": []}

    conditions = []
    params: dict[str, Any] = {"me": user["employee_id"], "q": q.strip(), "limit": limit}
    for i, token in enumerate(tokens):
        params[f"t{i}"] = f"%{_like(token)}%"
        params[f"p{i}"] = f"{_like(token)}%"
        conditions.append(f"(e.name ILIKE %(t{i})s OR d.name ILIKE %(t{i})s OR e.emp_no LIKE %(p{i})s)")

    # 시간을 주면 그 시간에 겹치는 회의·휴가를 찾는다 (안 주면 이 부분은 건너뛴다)
    params["check"] = date is not None and start_min is not None and end_min is not None and end_min > start_min
    params.update(date=date, start_min=start_min or 0, end_min=end_min or 0)

    with pool.connection() as conn:
        rows = conn.execute(
            f"""
            WITH win AS (
                SELECT tstzrange(
                    (%(date)s::date + make_interval(mins => %(start_min)s)) AT TIME ZONE 'Asia/Seoul',
                    (%(date)s::date + make_interval(mins => %(end_min)s)) AT TIME ZONE 'Asia/Seoul') AS span
            )
            SELECT e.emp_no, e.name, e.rank_name, d.name AS department, e.extension, e.id = %(me)s AS is_me,
                   s.id AS seat_id, s.code AS seat_code, f.id AS floor_id, f.name AS floor_name,
                   si.name AS site_name, z.color_key,
                   CASE WHEN p.expires_at IS NULL OR p.expires_at > now() THEN p.status END AS presence_status,
                   CASE WHEN p.expires_at IS NULL OR p.expires_at > now() THEN p.message END AS presence_message,
                   busy.title AS busy_title, busy.starts_at AS busy_starts_at, busy.ends_at AS busy_ends_at,
                   absence.kind AS absence_kind
            FROM employees e
            JOIN departments d ON d.id = e.department_id
            LEFT JOIN LATERAL (
                SELECT a.seat_id FROM seat_assignments a
                WHERE a.employee_id = e.id AND a.starts_at <= now() AND (a.ends_at IS NULL OR a.ends_at > now())
                ORDER BY a.kind = 'FIXED' DESC LIMIT 1
            ) cur ON true
            LEFT JOIN seats s ON s.id = cur.seat_id
            LEFT JOIN floors f ON f.id = s.floor_id
            LEFT JOIN sites si ON si.id = f.site_id
            LEFT JOIN zones z ON z.id = s.zone_id
            LEFT JOIN presence_status p ON p.employee_id = e.id
            LEFT JOIN LATERAL (
                SELECT r.title, r.starts_at, r.ends_at
                FROM reservations r
                WHERE %(check)s
                  AND r.status IN ('PENDING_APPROVAL', 'CONFIRMED')
                  AND tstzrange(r.starts_at, r.ends_at) && (SELECT span FROM win)
                  AND (r.organizer_id = e.id
                       OR EXISTS (SELECT 1 FROM reservation_attendees ra
                                  WHERE ra.reservation_id = r.id AND ra.employee_id = e.id))
                ORDER BY r.starts_at LIMIT 1
            ) busy ON true
            LEFT JOIN LATERAL (
                SELECT ab.kind FROM employee_absences ab
                WHERE %(check)s
                  AND ab.employee_id = e.id AND tstzrange(ab.starts_at, ab.ends_at) && (SELECT span FROM win)
                LIMIT 1
            ) absence ON true
            WHERE e.employment_status = 'ACTIVE' AND {" AND ".join(conditions)}
            ORDER BY e.name = %(q)s DESC, e.name LIKE %(p0)s DESC, e.name, d.name, e.emp_no
            LIMIT %(limit)s
            """,
            params,
        ).fetchall()

    return {"results": [_hit(r) for r in rows]}


def _hit(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "emp_no": row["emp_no"],
        "name": row["name"],
        "rank": row["rank_name"],
        "department": row["department"],
        "extension": row["extension"],
        "is_me": row["is_me"],
        "seat": (
            {
                "id": row["seat_id"],
                "code": row["seat_code"],
                "floor_id": row["floor_id"],
                "floor_name": row["floor_name"],
                "site_name": row["site_name"],
                "color_key": row["color_key"],
            }
            if row["seat_id"]
            else None
        ),
        "presence": (
            {"status": row["presence_status"], "message": row["presence_message"]} if row["presence_status"] else None
        ),
        "busy": (
            {"title": row["busy_title"], "starts_at": row["busy_starts_at"], "ends_at": row["busy_ends_at"]}
            if row["busy_title"]
            else None
        ),
        "absence": row["absence_kind"],
    }
