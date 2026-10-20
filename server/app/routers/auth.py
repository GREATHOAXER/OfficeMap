"""로그인 화면(⓪) API: 사번 로그인, 로그아웃, 내 정보, 로그인 화면 안내 문구"""

import ipaddress
from datetime import timedelta
from typing import Any

from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse
from psycopg import Connection
from pydantic import BaseModel, Field

from app.config import settings
from app.db import get_setting, pool
from app.security import hash_token, new_session_token, verify_password

router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginRequest(BaseModel):
    emp_no: str = Field(min_length=1, max_length=20)
    password: str = Field(min_length=1, max_length=128)


@router.get("/login-info")
def login_info() -> dict[str, Any]:
    with pool.connection() as conn:
        notices = conn.execute(
            """
            SELECT id, title
            FROM notices
            WHERE is_active AND display_from <= now() AND (display_until IS NULL OR display_until > now())
            ORDER BY display_from DESC
            LIMIT 5
            """
        ).fetchall()
        return {
            "notices": notices,
            "support_contact": get_setting(conn, "support.contact", None),
            "idle_minutes": get_setting(conn, "session.idle_minutes", 30),
            "max_failed_count": get_setting(conn, "login.max_failed_count", 5),
        }


@router.post("/login")
def login(body: LoginRequest, request: Request) -> JSONResponse:
    ip, user_agent = _client_info(request)
    with pool.connection() as conn:
        max_failed = int(get_setting(conn, "login.max_failed_count", 5))
        # 동시에 여러 번 틀려도 실패 횟수가 정확히 올라가도록 계정 행을 잠근다
        user = conn.execute(
            """
            SELECT e.id, e.emp_no, e.name, e.rank_name, e.employment_status, d.name AS department,
                   a.password_hash, a.role, a.failed_login_count, a.locked_at, a.must_change_password
            FROM employees e
            JOIN departments d ON d.id = e.department_id
            JOIN user_accounts a ON a.employee_id = e.id
            WHERE e.emp_no = %s
            FOR UPDATE OF a
            """,
            (body.emp_no,),
        ).fetchone()

        def record(result: str) -> None:
            conn.execute(
                """
                INSERT INTO login_history (emp_no_input, employee_id, result, ip_address, user_agent)
                VALUES (%s, %s, %s, %s, %s)
                """,
                (body.emp_no, user["id"] if user else None, result, ip, user_agent),
            )

        # 아래 오류 응답은 with 블록 안에서 반환해서 로그인 기록과 실패 횟수가 커밋되게 한다
        if user is None:
            verify_password(body.password, None)  # 없는 사번도 같은 시간이 걸리게
            record("NO_ACCOUNT")
            return _error(401, "INVALID_CREDENTIALS")
        if user["employment_status"] != "ACTIVE":
            record("NOT_ACTIVE")
            return _error(403, "NOT_ACTIVE")
        if user["locked_at"] is not None:
            record("LOCKED")
            return _error(423, "LOCKED", max_failed_count=max_failed)
        if not verify_password(body.password, user["password_hash"]):
            failed = user["failed_login_count"] + 1
            locked = failed >= max_failed
            conn.execute(
                """
                UPDATE user_accounts
                SET failed_login_count = %s, locked_at = CASE WHEN %s THEN now() END, updated_at = now()
                WHERE employee_id = %s
                """,
                (failed, locked, user["id"]),
            )
            record("WRONG_PASSWORD")
            if locked:
                return _error(423, "LOCKED", max_failed_count=max_failed)
            return _error(401, "INVALID_CREDENTIALS", failed_count=failed, max_failed_count=max_failed)

        token, token_hash = new_session_token()
        conn.execute(
            """
            UPDATE user_accounts
            SET failed_login_count = 0, last_login_at = now(), updated_at = now()
            WHERE employee_id = %s
            """,
            (user["id"],),
        )
        conn.execute(
            """
            INSERT INTO user_sessions (token_hash, employee_id, expires_at, ip_address, user_agent)
            VALUES (%s, %s, now() + %s, %s, %s)
            """,
            (token_hash, user["id"], timedelta(hours=settings.session_max_hours), ip, user_agent),
        )
        record("SUCCESS")

    response = JSONResponse({"user": _user_out(user)})
    response.set_cookie(
        settings.session_cookie_name,
        token,
        max_age=settings.session_max_hours * 3600,
        httponly=True,
        samesite="lax",
        secure=settings.cookie_secure,
        path="/",
    )
    return response


@router.get("/me")
def me(request: Request) -> JSONResponse:
    token = request.cookies.get(settings.session_cookie_name)
    user = None
    if token:
        with pool.connection() as conn:
            user = _load_session(conn, token)
    if user is None:
        response = _error(401, "NOT_LOGGED_IN")
        response.delete_cookie(settings.session_cookie_name, path="/")
        return response
    return JSONResponse({"user": _user_out(user)})


@router.post("/logout", status_code=204)
def logout(request: Request) -> Response:
    token = request.cookies.get(settings.session_cookie_name)
    if token:
        with pool.connection() as conn:
            conn.execute(
                "UPDATE user_sessions SET revoked_at = now() WHERE token_hash = %s AND revoked_at IS NULL",
                (hash_token(token),),
            )
    response = Response(status_code=204)
    response.delete_cookie(settings.session_cookie_name, path="/")
    return response


def _load_session(conn: Connection, token: str) -> dict[str, Any] | None:
    """유효한 세션이면 직원 정보를 돌려주고 마지막 사용 시각을 갱신한다."""
    idle_minutes = int(get_setting(conn, "session.idle_minutes", 30))
    user = conn.execute(
        """
        SELECT s.id AS session_id, e.emp_no, e.name, e.rank_name, d.name AS department,
               a.role, a.must_change_password
        FROM user_sessions s
        JOIN employees e ON e.id = s.employee_id
        JOIN departments d ON d.id = e.department_id
        JOIN user_accounts a ON a.employee_id = e.id
        WHERE s.token_hash = %s
          AND s.revoked_at IS NULL
          AND s.expires_at > now()
          AND s.last_active_at > now() - make_interval(mins => %s)
          AND e.employment_status = 'ACTIVE'  -- 퇴사·휴직 처리되면 남아 있던 세션도 바로 무효
          AND a.locked_at IS NULL
        """,
        (hash_token(token), idle_minutes),
    ).fetchone()
    if user is not None:
        conn.execute("UPDATE user_sessions SET last_active_at = now() WHERE id = %s", (user["session_id"],))
    return user


def _user_out(user: dict[str, Any]) -> dict[str, Any]:
    return {
        "emp_no": user["emp_no"],
        "name": user["name"],
        "rank": user["rank_name"],
        "department": user["department"],
        "role": user["role"],
        "must_change_password": user["must_change_password"],
    }


def _error(status: int, code: str, **extra: Any) -> JSONResponse:
    return JSONResponse(status_code=status, content={"code": code, **extra})


def _client_info(request: Request) -> tuple[str | None, str | None]:
    ip = request.client.host if request.client else None
    # 같은 PC의 Next.js 서버를 거쳐 오면 브라우저 주소는 X-Forwarded-For에 들어 있다
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded and ip in ("127.0.0.1", "::1"):
        ip = forwarded.split(",")[0].strip()
    try:
        ip = str(ipaddress.ip_address(ip)) if ip else None
    except ValueError:
        ip = None
    user_agent = request.headers.get("user-agent")
    return ip, user_agent[:255] if user_agent else None
