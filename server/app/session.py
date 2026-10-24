"""로그인 세션 확인. 로그인이 필요한 API는 CurrentUser를 인자로 받는다."""

from typing import Annotated, Any

from fastapi import Depends, HTTPException, Request
from psycopg import Connection

from app.config import settings
from app.db import get_setting, pool
from app.security import hash_token


def load_session(conn: Connection, token: str, *, touch: bool = True) -> dict[str, Any] | None:
    """유효한 세션이면 직원 정보를 돌려준다. touch면 마지막 사용 시각도 갱신한다.

    실시간 알림 연결처럼 사람이 쓰지 않아도 열려 있는 요청은 touch=False로 확인만 한다
    (갱신하면 화면만 띄워 두어도 자동 로그아웃이 안 된다)."""
    idle_minutes = int(get_setting(conn, "session.idle_minutes", 30))
    user = conn.execute(
        """
        SELECT s.id AS session_id, e.id AS employee_id, e.emp_no, e.name, e.rank_name,
               d.name AS department, a.role, a.must_change_password
        FROM user_sessions s
        JOIN employees e ON e.id = s.employee_id
        JOIN departments d ON d.id = e.department_id
        JOIN user_accounts a ON a.employee_id = e.id
        WHERE s.token_hash = %s
          AND s.kind = 'USER'  -- 관리자 페이지 세션으로는 직원 화면에 못 들어온다 (반대도 마찬가지)
          AND s.revoked_at IS NULL
          AND s.expires_at > now()
          AND s.last_active_at > now() - make_interval(mins => %s)
          AND e.employment_status = 'ACTIVE'  -- 퇴사·휴직 처리되면 남아 있던 세션도 바로 무효
          AND a.locked_at IS NULL
        """,
        (hash_token(token), idle_minutes),
    ).fetchone()
    if user is not None and touch:
        conn.execute("UPDATE user_sessions SET last_active_at = now() WHERE id = %s", (user["session_id"],))
    return user


def require_user(request: Request) -> dict[str, Any]:
    token = request.cookies.get(settings.session_cookie_name)
    if token:
        with pool.connection() as conn:
            user = load_session(conn, token)
        if user is not None:
            return user
    raise HTTPException(status_code=401, detail={"code": "NOT_LOGGED_IN"})


CurrentUser = Annotated[dict[str, Any], Depends(require_user)]
