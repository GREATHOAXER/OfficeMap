"""재실 상태 API. presence_status 테이블에 직원당 1행을 덮어쓴다 (이력은 남기지 않는다).

내 상태 읽기·바꾸기·지우기와, 동료들의 상태가 바뀔 때마다 화면에 바로 보내는 실시간 알림(SSE).
"""

import datetime as dt
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from app.config import settings
from app.db import get_setting, pool
from app.people_order import person_order
from app.realtime import SSE_HEADERS, hub
from app.routers.employees import NO_WINDOW, find_employees
from app.session import CurrentUser, load_session

router = APIRouter(prefix="/api/presence", tags=["presence"])

# 자리에 있음: 재실 · 방해 금지 · 회의 중 · 잠시 자리 비움 / 자리에 없음: 외근 · 출장 · 재택 · 교육 · 휴가 · 부재
# (DB db/schema/14_presence_statuses.sql, 화면 frontend/src/lib/presence.ts와 같아야 한다)
PresenceStatus = Literal[
    "AVAILABLE",
    "DO_NOT_DISTURB",
    "IN_MEETING",
    "STEPPED_OUT",
    "OUTSIDE",
    "BUSINESS_TRIP",
    "REMOTE",
    "TRAINING",
    "VACATION",
    "AWAY",
]
# 자동 해제: 해제 안 함 / 30분 뒤 / 1시간 뒤 / 퇴근 시(오늘 퇴근 시각, 이미 지났으면 자정)
# / 지금 해제 시각 그대로 (메시지만 고칠 때 해제 시각이 바뀌지 않게)
# / 그날까지 (until 날짜가 끝나는 자정, 휴가·출장처럼 며칠 가는 상태)
Duration = Literal["NONE", "30M", "1H", "END_OF_DAY", "KEEP", "UNTIL_DATE"]
MAX_UNTIL_DAYS = 366  # "그날까지"는 1년 안
KST = dt.timezone(dt.timedelta(hours=9), "KST")

# "퇴근 시"의 해제 시각: 오늘 퇴근 시각, 이미 지났으면 오늘 자정. %(workday_end)s 를 받는다
END_OF_DAY_SQL = """
    (SELECT CASE WHEN (d + %(workday_end)s::time) AT TIME ZONE 'Asia/Seoul' > now()
                 THEN (d + %(workday_end)s::time) AT TIME ZONE 'Asia/Seoul'
                 ELSE (d + interval '1 day') AT TIME ZONE 'Asia/Seoul' END
     FROM (SELECT date_trunc('day', now() AT TIME ZONE 'Asia/Seoul') AS d) today)
"""


class PresenceUpdate(BaseModel):
    status: PresenceStatus
    message: str | None = Field(default=None, max_length=100)
    duration: Duration = "END_OF_DAY"
    until: dt.date | None = None  # duration이 UNTIL_DATE일 때 마지막 날 (그날 포함, KST)


@router.get("/me")
def my_presence(user: CurrentUser) -> dict[str, Any]:
    """지금 내 상태와, 지금 "퇴근 시"를 고르면 풀리는 시각 (화면이 고르기 전에 미리 보여 준다)"""
    with pool.connection() as conn:
        workday_end = get_setting(conn, "presence.workday_end", "18:00")
        row = conn.execute(
            """
            SELECT status, message, expires_at, updated_at
            FROM presence_status
            WHERE employee_id = %(employee_id)s AND (expires_at IS NULL OR expires_at > now())
            """,
            {"employee_id": user["employee_id"]},
        ).fetchone()
        end_of_day = conn.execute(f"SELECT {END_OF_DAY_SQL} AS at", {"workday_end": workday_end}).fetchone()
    return {"presence": row, "end_of_day_at": end_of_day["at"], "workday_end": workday_end}


@router.get("/team")
def my_team(user: CurrentUser) -> dict[str, Any]:
    """우리 팀(내 부서) 사람들의 재실 상태와 자리. 내 재실 상태 화면에서 쓴다."""
    with pool.connection() as conn:
        team = conn.execute(
            """
            SELECT d.id, d.name, now() AS fetched_at
            FROM employees e JOIN departments d ON d.id = e.department_id
            WHERE e.id = %s
            """,
            (user["employee_id"],),
        ).fetchone()
        members = find_employees(
            conn,
            "e.department_id = %(team)s",
            person_order(),  # 직급 순 → 입사연도 → 입사일 (app/people_order.py)
            {"me": user["employee_id"], "team": team["id"], "limit": 500, **NO_WINDOW},
        )
    return {"team": {"id": team["id"], "name": team["name"]}, "fetched_at": team["fetched_at"], "members": members}


@router.put("/me")
def set_my_presence(body: PresenceUpdate, user: CurrentUser) -> dict[str, Any]:
    message = (body.message or "").strip() or None
    if body.duration == "UNTIL_DATE":
        today = dt.datetime.now(KST).date()
        if body.until is None or not today <= body.until <= today + dt.timedelta(days=MAX_UNTIL_DAYS):
            raise HTTPException(status_code=422, detail={"code": "BAD_UNTIL", "max_days": MAX_UNTIL_DAYS})
    with pool.connection() as conn:
        workday_end = get_setting(conn, "presence.workday_end", "18:00")
        row = conn.execute(
            f"""
            WITH expiry AS (
                SELECT CASE %(duration)s
                    WHEN '30M' THEN now() + interval '30 minutes'
                    WHEN '1H' THEN now() + interval '1 hour'
                    WHEN 'END_OF_DAY' THEN {END_OF_DAY_SQL}
                    -- 그날까지: 마지막 날 다음 날 0시 (KST)
                    WHEN 'UNTIL_DATE' THEN (%(until)s::date + 1)::timestamp AT TIME ZONE 'Asia/Seoul'
                    -- 그대로: 지금 걸려 있는 해제 시각. 없거나 이미 지났으면 퇴근 시
                    WHEN 'KEEP' THEN coalesce(
                        (SELECT p.expires_at FROM presence_status p
                         WHERE p.employee_id = %(employee_id)s AND p.expires_at > now()),
                        {END_OF_DAY_SQL})
                END AS expires_at
            )
            INSERT INTO presence_status (employee_id, status, message, expires_at, source, updated_at)
            SELECT %(employee_id)s, %(status)s, %(message)s, expires_at, 'MANUAL', now() FROM expiry
            ON CONFLICT (employee_id) DO UPDATE
                SET status = EXCLUDED.status, message = EXCLUDED.message, expires_at = EXCLUDED.expires_at,
                    source = 'MANUAL', updated_at = now()
            RETURNING status, message, expires_at, updated_at
            """,
            {
                "duration": body.duration,
                "until": body.until,
                "workday_end": workday_end,
                "employee_id": user["employee_id"],
                "status": body.status,
                "message": message,
            },
        ).fetchone()
    return {"presence": row}


@router.delete("/me", status_code=204)
def clear_my_presence(user: CurrentUser) -> Response:
    with pool.connection() as conn:
        conn.execute("DELETE FROM presence_status WHERE employee_id = %s", (user["employee_id"],))
    return Response(status_code=204)


def _session_alive(token: str | None) -> bool:
    if not token:
        return False
    with pool.connection() as conn:
        return load_session(conn, token, touch=False) is not None


@router.get("/stream")
async def presence_stream(request: Request) -> StreamingResponse:
    """동료들의 재실 상태와 도면·좌석 배치가 바뀔 때마다 보내는 SSE. 화면은 EventSource로 받는다.

    event: presence  data: {"emp_no", "presence": {status, message, expires_at, updated_at} | null, "at"}
    event: floor     data: {"kind": "seats" | "zones" | "plan" | "requests", "floor_id",
                            "seat_id"?, "emp_no"?, "version"?, "at"}
    event: resync    놓친 변경이 있을 수 있다. 화면 데이터를 전부 다시 읽는다

    연결이 열려 있는 것만으로는 자동 로그아웃 시간을 늘리지 않는다.
    """
    token = request.cookies.get(settings.session_cookie_name)
    if not await run_in_threadpool(_session_alive, token):
        raise HTTPException(status_code=401, detail={"code": "NOT_LOGGED_IN"})
    return StreamingResponse(
        hub.events(frozenset({"presence", "floor"}), lambda: _session_alive(token)),
        media_type="text/event-stream",
        headers=SSE_HEADERS,
    )
