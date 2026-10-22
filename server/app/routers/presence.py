"""내 재실 상태 API. presence_status 테이블에 직원당 1행을 덮어쓴다 (이력은 남기지 않는다)."""

from typing import Any, Literal

from fastapi import APIRouter, Response
from pydantic import BaseModel, Field

from app.db import get_setting, pool
from app.session import CurrentUser

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
