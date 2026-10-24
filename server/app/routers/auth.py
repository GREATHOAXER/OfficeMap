"""로그인 화면(⓪) API: 사번 로그인, 로그아웃, 내 정보, 로그인 화면 안내 문구"""

import ipaddress
from datetime import timedelta
from typing import Any

from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from app.config import settings
from app.db import get_setting, pool
from app.security import hash_password, new_session_token, verify_password
from app.session import IS_ADMIN_SQL, CurrentUserAllowTemporary, end_other_identity, end_sessions, load_session

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
            "admin_idle_minutes": get_setting(conn, "admin.session.idle_minutes", 15),
            "max_failed_count": get_setting(conn, "login.max_failed_count", 5),
        }


@router.post("/login")
def login(body: LoginRequest, request: Request) -> JSONResponse:
    ip, user_agent = client_info(request)
    with pool.connection() as conn:
        max_failed = int(get_setting(conn, "login.max_failed_count", 5))
        # 동시에 여러 번 틀려도 실패 횟수가 정확히 올라가도록 계정 행을 잠근다
        user = conn.execute(
            f"""
            SELECT e.id, e.emp_no, e.name, e.rank_name, e.employment_status, d.name AS department,
                   a.password_hash, a.failed_login_count, a.locked_at, a.must_change_password, {IS_ADMIN_SQL}
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

        # 아래 오류 응답은 with 블록 안에서 반환해서 로그인 기록과 실패 횟수가 커밋되게 한다.
        # 비밀번호가 틀리면 없는 사번과 똑같이 답한다 (실패 횟수·퇴사 여부를 알려 주면 어떤 사번이 있는지 드러난다)
        if user is None:
            verify_password(body.password, None)  # 없는 사번도 같은 시간이 걸리게
            record("NO_ACCOUNT")
            return error_response(401, "INVALID_CREDENTIALS")
        if user["locked_at"] is not None:
            record("LOCKED")
            return error_response(423, "LOCKED", max_failed_count=max_failed)
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
                return error_response(423, "LOCKED", max_failed_count=max_failed)
            return error_response(401, "INVALID_CREDENTIALS")
        if user["employment_status"] != "ACTIVE":
            record("NOT_ACTIVE")
            return error_response(403, "NOT_ACTIVE")

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
        # 같은 브라우저에 다른 사람의 관리자 로그인이 남아 있으면 끝낸다
        drop_admin = end_other_identity(conn, request, settings.admin_cookie_name, user["id"])

    response = JSONResponse({"user": _user_out(user)})
    if drop_admin:
        response.delete_cookie(settings.admin_cookie_name, path="/")
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
            user = load_session(conn, token)
    if user is None:
        response = error_response(401, "NOT_LOGGED_IN")
        response.delete_cookie(settings.session_cookie_name, path="/")
        return response
    return JSONResponse({"user": _user_out(user)})


@router.get("/session")
def session_status(request: Request) -> JSONResponse:
    """자동 로그아웃까지 남은 시간. 확인만 하고 사용 시각은 늘리지 않는다 (열어 둔 화면이 주기적으로 묻는다)"""
    token = request.cookies.get(settings.session_cookie_name)
    with pool.connection() as conn:
        user = load_session(conn, token, touch=False) if token else None
        idle_minutes = int(get_setting(conn, "session.idle_minutes", 30))
    if user is None:
        return error_response(401, "NOT_LOGGED_IN")
    return JSONResponse({"idle_left": max(0, user["idle_left"]), "idle_minutes": idle_minutes})


@router.post("/logout", status_code=204)
def logout(request: Request) -> Response:
    """직원 화면 로그아웃. 같은 브라우저의 관리자 로그인도 같이 끝낸다"""
    return end_sessions(request)


class PasswordChange(BaseModel):
    current_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=1, max_length=128)


PASSWORD_MIN_LENGTH = 8


def password_problems(password: str, emp_no: str) -> list[str]:
    """새 비밀번호 규칙. 화면(PasswordForm)도 같은 규칙을 입력하는 동안 보여 준다"""
    problems = []
    if len(password) < PASSWORD_MIN_LENGTH:
        problems.append("TOO_SHORT")
    if not (any(c.isascii() and c.isalpha() for c in password) and any(c.isdigit() for c in password)):
        problems.append("NEEDS_LETTER_AND_DIGIT")
    if emp_no in password:
        problems.append("CONTAINS_EMP_NO")
    return problems


@router.post("/password", status_code=204)
def change_password(body: PasswordChange, user: CurrentUserAllowTemporary) -> Response:
    """비밀번호 변경. 임시 비밀번호 상태에서도 쓸 수 있는 유일한 API.

    바꾸면 이 브라우저 말고 다른 곳에 로그인해 있던 직원 화면 세션은 끝낸다."""
    with pool.connection() as conn:
        account = conn.execute(
            "SELECT password_hash FROM user_accounts WHERE employee_id = %s FOR UPDATE",
            (user["employee_id"],),
        ).fetchone()
        if not verify_password(body.current_password, account["password_hash"]):
            return error_response(400, "WRONG_CURRENT")
        problems = password_problems(body.new_password, user["emp_no"])
        if problems:
            return error_response(422, "WEAK_PASSWORD", problems=problems)
        if body.new_password == body.current_password:
            return error_response(422, "SAME_AS_OLD")
        conn.execute(
            """
            UPDATE user_accounts
            SET password_hash = %s, must_change_password = false, password_changed_at = now(),
                failed_login_count = 0, updated_at = now()
            WHERE employee_id = %s
            """,
            (hash_password(body.new_password), user["employee_id"]),
        )
        conn.execute(
            """
            UPDATE user_sessions SET revoked_at = now()
            WHERE employee_id = %s AND kind = 'USER' AND token_hash <> %s AND revoked_at IS NULL
            """,
            (user["employee_id"], user["token_hash"]),
        )
    return Response(status_code=204)


def _user_out(user: dict[str, Any]) -> dict[str, Any]:
    return {
        "emp_no": user["emp_no"],
        "name": user["name"],
        "rank": user["rank_name"],
        "department": user["department"],
        "role": "ADMIN" if user["is_admin"] else "USER",
        "must_change_password": user["must_change_password"],
    }


def error_response(status: int, code: str, **extra: Any) -> JSONResponse:
    return JSONResponse(status_code=status, content={"code": code, **extra})


def client_info(request: Request) -> tuple[str | None, str | None]:
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
