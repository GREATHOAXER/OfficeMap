"""직원 검색 API. 자리·재실 현황의 검색창과 회의실 예약의 참석자 추가에서 쓴다."""

import datetime as dt
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query
from psycopg import Connection

from app.db import pool
from app.people_order import person_order
from app.routers.profile import PROFILE_COLUMNS, PROFILE_JOIN, profile_out
from app.session import CurrentUser

router = APIRouter(prefix="/api/employees", tags=["employees"])

MAX_TOKENS = 3


def _like(token: str) -> str:
    """LIKE 패턴에서 특수문자(%, _, \\)를 글자 그대로 찾도록 바꾼다."""
    return token.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


class TimeWindow:
    """회의 시간 (서울 기준 그날 0시부터 분). 주면 그 시간에 겹치는 다른 회의·휴가를 같이 찾는다.

    exclude: 고치고 있는 예약 ID. 그 예약 자신은 "겹치는 다른 회의"로 세지 않는다."""

    def __init__(
        self,
        date: dt.date | None = None,
        start_min: int | None = Query(default=None, ge=0, le=1440),
        end_date: dt.date | None = None,  # 여러 날에 걸친 회의면 끝나는 날
        end_min: int | None = Query(default=None, ge=0, le=1440),
        exclude: int | None = None,
    ) -> None:
        end_day = end_date or date
        self.check = (
            date is not None
            and end_day is not None
            and start_min is not None
            and end_min is not None
            and (end_day, end_min) > (date, start_min)
        )
        self.params = {
            "check": self.check,
            "date": date,
            "start_min": start_min or 0,
            "end_date": end_day,
            "end_min": end_min or 0,
            "exclude": exclude,
        }


Window = Annotated[TimeWindow, Depends()]

# 시간 없이 찾을 때 (다른 일정 확인 안 함)
NO_WINDOW: dict[str, Any] = {
    "check": False,
    "date": None,
    "start_min": 0,
    "end_date": None,
    "end_min": 0,
    "exclude": None,
}


def find_employees(conn: Connection, where: str, order: str, params: dict[str, Any]) -> list[dict[str, Any]]:
    """직원 목록을 자리·재실 상태·(시간을 줬으면) 그 시간의 다른 일정과 함께 읽는다.

    params에는 me(로그인한 사람), limit, TimeWindow.params 값이 있어야 한다.
    """
    params = {"exclude": None, **params}  # exclude를 넘기지 않는 쪽도 그대로 쓸 수 있게
    rows = conn.execute(
        f"""
        WITH RECURSIVE dept_path AS (  -- 부서마다 위 부서 이름까지 이은 경로 (예: "IT본부 IT운영팀")
            SELECT id, name::text AS path FROM departments WHERE parent_id IS NULL
            UNION ALL
            SELECT c.id, dp.path || ' ' || c.name FROM departments c JOIN dept_path dp ON c.parent_id = dp.id
        ), win AS (
            SELECT tstzrange(
                (%(date)s::date + make_interval(mins => %(start_min)s)) AT TIME ZONE 'Asia/Seoul',
                (%(end_date)s::date + make_interval(mins => %(end_min)s)) AT TIME ZONE 'Asia/Seoul') AS span
        )
        SELECT e.emp_no, e.name, e.rank_name, d.name AS department, pd.name AS division,
               e.extension, e.email, e.id = %(me)s AS is_me,
               s.id AS seat_id, s.code AS seat_code, f.id AS floor_id, f.name AS floor_name,
               si.name AS site_name, z.color_key,
               CASE WHEN p.expires_at IS NULL OR p.expires_at > now() THEN p.status END AS presence_status,
               CASE WHEN p.expires_at IS NULL OR p.expires_at > now() THEN p.message END AS presence_message,
               busy.title AS busy_title, busy.starts_at AS busy_starts_at, busy.ends_at AS busy_ends_at,
               absence.kind AS absence_kind, dp.path AS dept_path, {PROFILE_COLUMNS}
        FROM employees e
        JOIN departments d ON d.id = e.department_id
        LEFT JOIN departments pd ON pd.id = d.parent_id
        LEFT JOIN dept_path dp ON dp.id = d.id
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
        {PROFILE_JOIN}
        LEFT JOIN LATERAL (
            SELECT r.title, r.starts_at, r.ends_at
            FROM reservations r
            WHERE %(check)s
              AND r.status = 'CONFIRMED'
              AND r.id IS DISTINCT FROM %(exclude)s::bigint  -- 고치고 있는 그 예약은 빼고
              AND tstzrange(r.starts_at, r.ends_at) && (SELECT span FROM win)
              -- 실제로 들어가는 회의만 (예약만 해 준 회의는 그 사람 일정이 아니다)
              AND EXISTS (SELECT 1 FROM reservation_attendees ra
                          WHERE ra.reservation_id = r.id AND ra.employee_id = e.id)
            ORDER BY r.starts_at LIMIT 1
        ) busy ON true
        LEFT JOIN LATERAL (
            SELECT ab.kind FROM employee_absences ab
            WHERE %(check)s
              AND ab.employee_id = e.id AND tstzrange(ab.starts_at, ab.ends_at) && (SELECT span FROM win)
            LIMIT 1
        ) absence ON true
        WHERE e.employment_status = 'ACTIVE' AND {where}
        ORDER BY {order}
        LIMIT %(limit)s
        """,
        params,
    ).fetchall()
    return [_hit(r) for r in rows]


@router.get("/search")
def search(
    user: CurrentUser,
    window: Window,
    q: str = Query(min_length=1, max_length=50),
    limit: int = Query(default=20, ge=1, le=50),
) -> dict[str, Any]:
    """이름·사번, 또는 부서(본부)·팀 이름으로 사람을 찾는다. 띄어 쓴 낱말은 모두 맞아야 한다 (예: "김민준 IT").

    이름이 맞는 사람이 먼저, 그다음 팀·본부 이름으로 걸린 사람 순서다.
    date·start_min·end_min을 주면 그 시간에 겹치는 다른 회의와 휴가·외근을 같이 알려 준다.
    """
    tokens = q.split()[:MAX_TOKENS]
    if not tokens:
        return {"results": []}

    conditions = []
    params: dict[str, Any] = {"me": user["employee_id"], "q": q.strip(), "limit": limit, **window.params}
    for i, token in enumerate(tokens):
        params[f"t{i}"] = f"%{_like(token)}%"
        params[f"p{i}"] = f"{_like(token)}%"
        # 이름·부서·사번, 그리고 내 정보의 부르는 이름·한 줄 소개·하는 일·업무 키워드 ("법인카드 누가 해요?")
        conditions.append(
            f"(e.name ILIKE %(t{i})s OR dp.path ILIKE %(t{i})s OR e.emp_no LIKE %(p{i})s"
            f" OR pr.display_name ILIKE %(t{i})s OR pr.headline ILIKE %(t{i})s OR pr.duties ILIKE %(t{i})s"
            f" OR array_to_string(pr.skills, ' ') ILIKE %(t{i})s)"
        )

    with pool.connection() as conn:
        results = find_employees(
            conn,
            " AND ".join(conditions),
            # 이름이 정확히·앞부분이·어디든 맞는 순서, 그다음 부서로 걸린 사람, 하는 일로 걸린 사람.
            # 같은 단계에서는 우리 팀 사람 먼저, 그다음 이름 가나다순
            "e.name = %(q)s DESC, e.name LIKE %(p0)s DESC, e.name ILIKE %(t0)s DESC, dp.path ILIKE %(t0)s DESC,"
            " e.department_id = (SELECT department_id FROM employees WHERE id = %(me)s) DESC,"
            " e.name, d.sort_order, e.emp_no",
            params,
        )
    for hit in results:
        hit["matched"] = _matched(hit, tokens)
    return {"results": results}


def _matched(hit: dict[str, Any], tokens: list[str]) -> str | None:
    """이름·부서가 아니라 내 정보(하는 일·키워드 등)로 찾은 사람이면 걸린 부분을 짧게 보여 준다"""
    plain = f"{hit['name']} {hit['emp_no']} {hit['dept_path'] or ''}".lower()
    if all(t.lower() in plain for t in tokens):
        return None
    for skill in hit["skills"]:
        if any(t.lower() in skill.lower() for t in tokens):
            return f"#{skill}"
    for text in (hit["headline"], hit["duties"], hit["display_name"]):
        if not text:
            continue
        low = text.lower()
        at = min((low.find(t.lower()) for t in tokens if t.lower() in low), default=-1)
        if at >= 0:
            start = max(0, at - 12)
            snippet = text[start : start + 48].replace("\n", " ")
            return ("…" if start else "") + snippet + ("…" if start + 48 < len(text) else "")
    return None


# 부서와 그 아래 부서 전부 (본부를 고르면 본부 아래 팀 사람까지)
_SUBTREE = """
    WITH RECURSIVE sub AS (
        SELECT %(team)s::bigint AS id
        UNION ALL
        SELECT c.id FROM departments c JOIN sub ON c.parent_id = sub.id WHERE c.is_active
    ) SELECT id FROM sub
"""


@router.get("/teams")
def teams(user: CurrentUser, q: str = Query(default="", max_length=50)) -> dict[str, Any]:
    """팀·본부 이름으로 찾는다 (참석자 칸에서 "$총무팀"처럼 쓸 때). q가 비어 있으면 전부.

    member_count는 그 아래 팀 사람까지 센 재직자 수.
    """
    name = q.strip()
    with pool.connection() as conn:
        rows = conn.execute(
            """
            WITH RECURSIVE sub AS (  -- 부서마다 자기 자신과 아래 부서 전부
                SELECT id AS root, id FROM departments WHERE is_active
                UNION ALL
                SELECT sub.root, c.id FROM departments c JOIN sub ON c.parent_id = sub.id WHERE c.is_active
            )
            SELECT d.id, d.name, p.name AS parent, count(e.id)::int AS member_count,
                   EXISTS (SELECT 1 FROM departments c WHERE c.parent_id = d.id AND c.is_active) AS has_children
            FROM departments d
            LEFT JOIN departments p ON p.id = d.parent_id
            JOIN sub ON sub.root = d.id
            JOIN employees e ON e.department_id = sub.id AND e.employment_status = 'ACTIVE'
            WHERE d.is_active AND d.name ILIKE %(like)s
            GROUP BY d.id, p.name
            ORDER BY d.name = %(name)s DESC, d.name LIKE %(prefix)s DESC, d.parent_id IS NULL DESC, d.sort_order, d.name
            LIMIT 50
            """,
            {"like": f"%{_like(name)}%", "prefix": f"{_like(name)}%", "name": name},
        ).fetchall()
    return {"teams": rows}


@router.get("/teams/{department_id}/members")
def team_members(department_id: int, user: CurrentUser, window: Window) -> dict[str, Any]:
    """팀 전체 (재직 중인 사람만, 아래 팀 포함). 참석자에 팀을 통째로 넣을 때 쓴다."""
    with pool.connection() as conn:
        team = conn.execute("SELECT id, name FROM departments WHERE id = %s AND is_active", (department_id,)).fetchone()
        if team is None:
            raise HTTPException(status_code=404, detail={"code": "TEAM_NOT_FOUND"})
        members = find_employees(
            conn,
            f"e.department_id IN ({_SUBTREE})",
            person_order(),
            {"me": user["employee_id"], "team": department_id, "limit": 1000, **window.params},
        )
    return {"team": team, "members": members}


def _hit(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "emp_no": row["emp_no"],
        "name": row["name"],
        "rank": row["rank_name"],
        "department": row["department"],
        "division": row["division"],  # 위 부서 (본부)
        "extension": row["extension"],
        "email": row["email"],
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
        "dept_path": row["dept_path"],
        **profile_out(row),
    }
