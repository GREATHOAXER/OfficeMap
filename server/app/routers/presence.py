"""재실 상태 API. presence_status 테이블에 직원당 1행을 덮어쓴다 (이력은 남기지 않는다).

내 상태 읽기·바꾸기·지우기와, 동료들의 상태가 바뀔 때마다 화면에 바로 보내는 실시간 알림(SSE).
"""

import asyncio
from collections.abc import AsyncIterator
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from app.config import settings
from app.db import get_setting, pool
from app.realtime import CLOSE, RESYNC, hub
from app.routers.employees import NO_WINDOW, find_employees
from app.session import CurrentUser, load_session

router = APIRouter(prefix="/api/presence", tags=["presence"])

PresenceStatus = Literal["AVAILABLE", "DO_NOT_DISTURB", "IN_MEETING", "AWAY"]
# 자동 해제: 계속 유지 / 30분 뒤 / 1시간 뒤 / 퇴근 시(오늘 퇴근 시각, 이미 지났으면 자정)
Duration = Literal["NONE", "30M", "1H", "END_OF_DAY"]


class PresenceUpdate(BaseModel):
    status: PresenceStatus
    message: str | None = Field(default=None, max_length=100)
    duration: Duration = "END_OF_DAY"


@router.get("/me")
def my_presence(user: CurrentUser) -> dict[str, Any]:
    with pool.connection() as conn:
        row = conn.execute(
            """
            SELECT status, message, expires_at, updated_at
            FROM presence_status
            WHERE employee_id = %s AND (expires_at IS NULL OR expires_at > now())
            """,
            (user["employee_id"],),
        ).fetchone()
    return {"presence": row}


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
            "e.id = %(me)s DESC, e.name, e.emp_no",
            {"me": user["employee_id"], "team": team["id"], "limit": 500, **NO_WINDOW},
        )
    return {"team": {"id": team["id"], "name": team["name"]}, "fetched_at": team["fetched_at"], "members": members}


@router.put("/me")
def set_my_presence(body: PresenceUpdate, user: CurrentUser) -> dict[str, Any]:
    message = (body.message or "").strip() or None
    with pool.connection() as conn:
        workday_end = get_setting(conn, "presence.workday_end", "18:00")
        row = conn.execute(
            """
            WITH today AS (SELECT date_trunc('day', now() AT TIME ZONE 'Asia/Seoul') AS d),
            expiry AS (
                SELECT CASE %(duration)s
                    WHEN '30M' THEN now() + interval '30 minutes'
                    WHEN '1H' THEN now() + interval '1 hour'
                    WHEN 'END_OF_DAY' THEN greatest(
                        (d + %(workday_end)s::time) AT TIME ZONE 'Asia/Seoul',
                        -- 퇴근 시각이 이미 지났으면 오늘 자정까지
                        CASE WHEN (d + %(workday_end)s::time) AT TIME ZONE 'Asia/Seoul' <= now()
                             THEN (d + interval '1 day') AT TIME ZONE 'Asia/Seoul' END)
                END AS expires_at
                FROM today
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


PING_SECONDS = 20  # 아무 변경이 없어도 이 간격으로 신호를 보내 중간 프록시가 연결을 끊지 않게 한다
SESSION_CHECK_SECONDS = 60  # 로그아웃·자동 로그아웃되면 이 시간 안에 연결을 닫는다


def _session_alive(token: str | None) -> bool:
    if not token:
        return False
    with pool.connection() as conn:
        return load_session(conn, token, touch=False) is not None


@router.get("/stream")
async def presence_stream(request: Request) -> StreamingResponse:
    """동료들의 재실 상태가 바뀔 때마다 보내는 SSE. 화면은 EventSource로 받는다.

    event: presence  data: {"emp_no", "presence": {status, message, expires_at, updated_at} | null, "at"}
    event: resync    놓친 변경이 있을 수 있다. 화면 데이터를 전부 다시 읽는다

    연결이 열려 있는 것만으로는 자동 로그아웃 시간을 늘리지 않는다.
    """
    token = request.cookies.get(settings.session_cookie_name)
    if not await run_in_threadpool(_session_alive, token):
        raise HTTPException(status_code=401, detail={"code": "NOT_LOGGED_IN"})
    return StreamingResponse(
        _events(token),
        media_type="text/event-stream",
        # 압축·버퍼링하는 프록시(Next.js, nginx)가 알림을 모아 두지 않게 한다
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
    )


async def _events(token: str | None) -> AsyncIterator[str]:
    sub = hub.subscribe()
    loop = asyncio.get_running_loop()
    check_at = loop.time() + SESSION_CHECK_SECONDS
    try:
        yield "retry: 3000\n\n"  # 끊기면 3초 뒤 다시 연결
        while not hub.closing and not sub.lost:
            try:
                payload: str | None = await asyncio.wait_for(sub.queue.get(), timeout=PING_SECONDS)
            except TimeoutError:
                payload = None
            if payload == CLOSE:
                break
            if payload is None:
                yield ": ping\n\n"
            elif payload == RESYNC:
                yield "event: resync\ndata: {}\n\n"
            else:
                yield f"event: presence\ndata: {payload}\n\n"
            if loop.time() >= check_at:
                if not await run_in_threadpool(_session_alive, token):
                    break
                check_at = loop.time() + SESSION_CHECK_SECONDS
    finally:
        hub.unsubscribe(sub)
