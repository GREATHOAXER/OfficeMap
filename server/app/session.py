"""로그인 세션 확인. 로그인이 필요한 API는 CurrentUser를 인자로 받는다."""

from typing import Annotated, Any

from fastapi import Depends, HTTPException, Request, Response
from psycopg import Connection

from app.config import settings
from app.db import get_setting, pool
from app.security import hash_token

# 직원 화면에서 쓰는 "관리자인가": 관리자 계정이 있고 살아 있는 권한이 하나 이상.
# 권한을 회수하면 바로 왼쪽 메뉴의 "관리자 페이지" 링크도 사라진다 (employees 별칭 e 기준)
IS_ADMIN_SQL = """EXISTS (
    SELECT 1 FROM admin_grants g JOIN admin_accounts aa ON aa.employee_id = g.employee_id
    WHERE g.employee_id = e.id AND g.revoked_at IS NULL
) AS is_admin"""


def load_session(conn: Connection, token: str, *, touch: bool = True) -> dict[str, Any] | None:
    """유효한 세션이면 직원 정보를 돌려준다. touch면 마지막 사용 시각도 갱신한다.

    실시간 알림 연결처럼 사람이 쓰지 않아도 열려 있는 요청은 touch=False로 확인만 한다
    (갱신하면 화면만 띄워 두어도 자동 로그아웃이 안 된다)."""
    idle_minutes = int(get_setting(conn, "session.idle_minutes", 30))
    user = conn.execute(
        f"""
        SELECT s.id AS session_id, s.token_hash, e.id AS employee_id, e.emp_no, e.name, e.rank_name,
               d.name AS department, a.must_change_password, {IS_ADMIN_SQL},
               pr.display_name, ph.updated_at AS photo_at,
               -- 자동 로그아웃까지 남은 초 (화면이 1분 전에 알려 준다)
               extract(epoch FROM s.last_active_at + make_interval(mins => %s) - now())::int AS idle_left
        FROM user_sessions s
        JOIN employees e ON e.id = s.employee_id
        JOIN departments d ON d.id = e.department_id
        JOIN user_accounts a ON a.employee_id = e.id
        LEFT JOIN employee_profiles pr ON pr.employee_id = e.id
        LEFT JOIN employee_photos ph ON ph.employee_id = e.id
        WHERE s.token_hash = %s
          AND s.kind = 'USER'  -- 관리자 페이지 세션으로는 직원 화면에 못 들어온다 (반대도 마찬가지)
          AND s.revoked_at IS NULL
          AND s.expires_at > now()
          AND s.last_active_at > now() - make_interval(mins => %s)
          AND e.employment_status = 'ACTIVE'  -- 퇴사·휴직 처리되면 남아 있던 세션도 바로 무효
          AND a.locked_at IS NULL
        """,
        (idle_minutes, hash_token(token), idle_minutes),
    ).fetchone()
    if user is not None and touch:
        conn.execute("UPDATE user_sessions SET last_active_at = now() WHERE id = %s", (user["session_id"],))
    return user


def session_end_reason(conn: Connection, token: str) -> str | None:
    """직원 화면 로그인이 왜 끊겼는지. 로그인 화면이 이유에 맞는 안내를 띄운다 (모르는 쿠키면 None).

    expired: 오래 쓰지 않음 / max: 로그인 유지 시간이 지남 / reset: 관리자가 비밀번호 초기화 /
    changed: 다른 곳에서 비밀번호 변경 / locked: 비밀번호를 여러 번 틀려 잠김 / inactive: 휴직·퇴사 /
    logout: 로그아웃"""
    row = conn.execute(
        """
        SELECT s.revoked_at IS NOT NULL AS revoked, s.revoked_reason, s.expires_at <= now() AS over,
               e.employment_status <> 'ACTIVE' AS inactive, a.locked_at IS NOT NULL AS locked
        FROM user_sessions s
        JOIN employees e ON e.id = s.employee_id
        JOIN user_accounts a ON a.employee_id = s.employee_id
        WHERE s.token_hash = %s AND s.kind = 'USER'
        """,
        (hash_token(token),),
    ).fetchone()
    if row is None:
        return None
    if row["inactive"]:
        return "inactive"
    if row["locked"]:
        return "locked"
    if row["revoked"]:
        return {"PASSWORD_RESET": "reset", "PASSWORD_CHANGED": "changed"}.get(row["revoked_reason"], "logout")
    return "max" if row["over"] else "expired"


def end_sessions(request: Request, cookie_name: str) -> Response:
    """이 브라우저에서 한쪽 로그인만 끝낸다 (직원 화면 로그아웃은 직원 세션, 관리자 페이지 로그아웃은 관리자 세션).

    직원 화면과 관리자 페이지는 계정·세션이 따로라, 한쪽에서 로그아웃하거나 다른 계정으로 로그인해도
    다른 쪽 로그인은 그대로 둔다."""
    token = request.cookies.get(cookie_name)
    if token:
        with pool.connection() as conn:
            conn.execute(
                """
                UPDATE user_sessions SET revoked_at = now(), revoked_reason = 'LOGOUT'
                WHERE token_hash = %s AND revoked_at IS NULL
                """,
                (hash_token(token),),
            )
    response = Response(status_code=204)
    response.delete_cookie(cookie_name, path="/")
    return response


def _require_user(request: Request, *, allow_temporary: bool) -> dict[str, Any]:
    token = request.cookies.get(settings.session_cookie_name)
    if token:
        with pool.connection() as conn:
            user = load_session(conn, token)
        if user is not None:
            # 임시 비밀번호 상태로는 비밀번호 변경 말고는 아무 API도 못 쓴다 (화면도 변경 화면으로 보낸다)
            if user["must_change_password"] and not allow_temporary:
                raise HTTPException(status_code=403, detail={"code": "PASSWORD_CHANGE_REQUIRED"})
            return user
    raise HTTPException(status_code=401, detail={"code": "NOT_LOGGED_IN"})


def require_user(request: Request) -> dict[str, Any]:
    return _require_user(request, allow_temporary=False)


def require_user_allow_temporary(request: Request) -> dict[str, Any]:
    return _require_user(request, allow_temporary=True)


CurrentUser = Annotated[dict[str, Any], Depends(require_user)]
# 비밀번호 변경처럼 임시 비밀번호 상태에서도 써야 하는 API
CurrentUserAllowTemporary = Annotated[dict[str, Any], Depends(require_user_allow_temporary)]
