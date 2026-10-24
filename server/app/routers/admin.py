"""관리자 페이지 API: 관리자 로그인(직원 로그인과 다른 비밀번호), 관리자 첫 화면(사업장·층·권한 현황)."""

from datetime import timedelta
from typing import Any

from fastapi import APIRouter, Request, Response
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from app.admin_auth import CurrentAdmin, admin_out, grants_of, load_admin
from app.config import settings
from app.db import get_setting, pool
from app.routers.auth import client_info, error_response
from app.security import hash_token, new_session_token, verify_password

router = APIRouter(prefix="/api/admin", tags=["admin"])

SITE_KIND = {"HQ": "본사", "CENTER": "센터"}


class AdminLoginRequest(BaseModel):
    emp_no: str = Field(min_length=1, max_length=20)
    password: str = Field(min_length=1, max_length=128)


@router.post("/auth/login")
def admin_login(body: AdminLoginRequest, request: Request) -> JSONResponse:
    """관리자 로그인. 관리자 계정(admin_accounts)과 살아 있는 권한이 있어야 한다.

    실패 횟수·잠금은 직원 로그인과 따로 센다.
    """
    ip, user_agent = client_info(request)
    with pool.connection() as conn:
        max_failed = int(get_setting(conn, "login.max_failed_count", 5))
        admin = conn.execute(
            """
            SELECT e.id, e.employment_status, a.password_hash, a.failed_login_count, a.locked_at
            FROM employees e
            JOIN admin_accounts a ON a.employee_id = e.id
            WHERE e.emp_no = %s
            FOR UPDATE OF a
            """,
            (body.emp_no,),
        ).fetchone()
        employee_id = admin["id"] if admin else None
        if employee_id is None:  # 관리자 계정이 없어도 직원이면 누가 시도했는지 남긴다
            row = conn.execute("SELECT id FROM employees WHERE emp_no = %s", (body.emp_no,)).fetchone()
            employee_id = row["id"] if row else None

        def record(result: str) -> None:
            conn.execute(
                """
                INSERT INTO login_history (emp_no_input, employee_id, kind, result, ip_address, user_agent)
                VALUES (%s, %s, 'ADMIN', %s, %s, %s)
                """,
                (body.emp_no, employee_id, result, ip, user_agent),
            )

        # 오류 응답은 with 블록 안에서 반환해서 로그인 기록과 실패 횟수가 커밋되게 한다
        if admin is None:
            verify_password(body.password, None)  # 계정이 없어도 같은 시간이 걸리게
            record("NO_ACCOUNT")
            return error_response(401, "INVALID_CREDENTIALS")
        if admin["employment_status"] != "ACTIVE":
            record("NOT_ACTIVE")
            return error_response(403, "NOT_ACTIVE")
        if admin["locked_at"] is not None:
            record("LOCKED")
            return error_response(423, "LOCKED", max_failed_count=max_failed)
        if not verify_password(body.password, admin["password_hash"]):
            failed = admin["failed_login_count"] + 1
            locked = failed >= max_failed
            conn.execute(
                """
                UPDATE admin_accounts
                SET failed_login_count = %s, locked_at = CASE WHEN %s THEN now() END, updated_at = now()
                WHERE employee_id = %s
                """,
                (failed, locked, admin["id"]),
            )
            record("WRONG_PASSWORD")
            if locked:
                return error_response(423, "LOCKED", max_failed_count=max_failed)
            return error_response(401, "INVALID_CREDENTIALS", failed_count=failed, max_failed_count=max_failed)
        if not grants_of(conn, admin["id"]):
            record("NO_PERMISSION")
            return error_response(403, "NO_PERMISSION")

        token, token_hash = new_session_token()
        conn.execute(
            """
            UPDATE admin_accounts SET failed_login_count = 0, last_login_at = now(), updated_at = now()
            WHERE employee_id = %s
            """,
            (admin["id"],),
        )
        conn.execute(
            """
            INSERT INTO user_sessions (token_hash, employee_id, kind, expires_at, ip_address, user_agent)
            VALUES (%s, %s, 'ADMIN', now() + %s, %s, %s)
            """,
            (token_hash, admin["id"], timedelta(hours=settings.admin_session_max_hours), ip, user_agent),
        )
        record("SUCCESS")
        loaded = load_admin(conn, token, touch=False)

    response = JSONResponse(jsonable_encoder({"admin": admin_out(loaded)}))
    response.set_cookie(
        settings.admin_cookie_name,
        token,
        max_age=settings.admin_session_max_hours * 3600,
        httponly=True,
        samesite="strict",  # 관리자 페이지는 다른 사이트에서 넘어오는 요청에 쿠키를 아예 보내지 않는다
        secure=settings.cookie_secure,
        path="/",
    )
    return response


@router.get("/auth/me")
def admin_me(admin: CurrentAdmin) -> dict[str, Any]:
    return {"admin": admin_out(admin)}


@router.post("/auth/logout", status_code=204)
def admin_logout(request: Request) -> Response:
    token = request.cookies.get(settings.admin_cookie_name)
    if token:
        with pool.connection() as conn:
            conn.execute(
                """
                UPDATE user_sessions SET revoked_at = now()
                WHERE token_hash = %s AND kind = 'ADMIN' AND revoked_at IS NULL
                """,
                (hash_token(token),),
            )
    response = Response(status_code=204)
    response.delete_cookie(settings.admin_cookie_name, path="/")
    return response


@router.get("/overview")
def overview(admin: CurrentAdmin) -> dict[str, Any]:
    """관리자 첫 화면: 사업장별 층 현황(입주 팀, 층 관리자, 도면 상태, 좌석), 관리자 권한 목록, 요약 숫자.

    조회는 전체를 보여 주고, 층마다 내 관리 범위인지(in_scope)를 붙인다.
    """
    with pool.connection() as conn:
        sites = conn.execute(
            "SELECT id, kind, name, address FROM sites WHERE is_active ORDER BY sort_order, id"
        ).fetchall()
        floors = conn.execute(
            """
            SELECT f.id, f.site_id, f.name, f.description,
                   (SELECT count(*) FROM seats s WHERE s.floor_id = f.id AND s.status <> 'REMOVED')::int AS seats,
                   (SELECT count(DISTINCT a.seat_id) FROM seat_assignments a JOIN seats s ON s.id = a.seat_id
                    WHERE s.floor_id = f.id AND a.starts_at <= now() AND (a.ends_at IS NULL OR a.ends_at > now())
                   )::int AS occupied,
                   (SELECT count(*) FROM meeting_rooms m WHERE m.floor_id = f.id AND m.is_active)::int AS rooms,
                   EXISTS (SELECT 1 FROM floor_plans p WHERE p.floor_id = f.id AND p.status = 'PUBLISHED') AS published,
                   EXISTS (SELECT 1 FROM floor_plans p WHERE p.floor_id = f.id AND p.status = 'DRAFT') AS drafting,
                   last.updated_at AS plan_updated_at, last.updated_by AS plan_updated_by
            FROM floors f
            LEFT JOIN LATERAL (
                SELECT p.updated_at, e.name AS updated_by
                FROM floor_plans p JOIN employees e ON e.id = p.updated_by
                WHERE p.floor_id = f.id ORDER BY p.updated_at DESC LIMIT 1
            ) last ON true
            WHERE f.is_active
            ORDER BY f.site_id, f.sort_order DESC
            """
        ).fetchall()
        zones = conn.execute(
            """
            SELECT z.floor_id, z.code, z.name, z.color_key, d.name AS department
            FROM zones z LEFT JOIN departments d ON d.id = z.department_id
            WHERE z.is_active
            ORDER BY z.floor_id, z.sort_order, z.code
            """
        ).fetchall()
        summary = conn.execute(
            """
            SELECT (SELECT count(*) FROM employees WHERE employment_status = 'ACTIVE')::int AS employees,
                   (SELECT count(*) FROM seats WHERE status <> 'REMOVED')::int AS seats,
                   (SELECT count(DISTINCT seat_id) FROM seat_assignments
                    WHERE starts_at <= now() AND (ends_at IS NULL OR ends_at > now()))::int AS occupied,
                   (SELECT count(*) FROM meeting_rooms WHERE is_active)::int AS rooms,
                   (SELECT count(*) FROM reservations WHERE status = 'CONFIRMED'
                      AND starts_at < (date_trunc('day', now() AT TIME ZONE 'Asia/Seoul') + interval '1 day')
                                      AT TIME ZONE 'Asia/Seoul'
                      AND ends_at > date_trunc('day', now() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul'
                   )::int AS reservations_today,
                   (SELECT count(*) FROM change_requests WHERE status = 'PENDING')::int AS pending_requests
            """
        ).fetchone()
        grants = grants_of(conn)

    mine = admin["grants"]

    def in_scope(floor: dict[str, Any]) -> str | None:
        """내가 이 층을 관리하나: "ALL"(층 전체) / "ZONE"(층 안 일부 구역) / None"""
        for g in mine:
            if g["role"] == "COMPANY_ADMIN" or (g["role"] == "SITE_ADMIN" and g["site_id"] == floor["site_id"]):
                return "ALL"
            if g["role"] == "FLOOR_ADMIN" and g["floor_id"] == floor["id"]:
                return "ALL"
        return "ZONE" if any(g["role"] == "ZONE_ADMIN" and g["floor_id"] == floor["id"] for g in mine) else None

    def plan_state(floor: dict[str, Any]) -> str:
        if floor["published"]:
            return "EDITING" if floor["drafting"] else "PUBLISHED"
        return "DRAFT" if floor["drafting"] else "NONE"

    def holders(role: str, key: str, value: int) -> list[str]:
        """이 범위의 그 역할 관리자 이름"""
        return [g["employee"]["name"] for g in grants if g["role"] == role and g[key] == value]

    by_floor_zones: dict[int, list[dict[str, Any]]] = {}
    for z in zones:
        by_floor_zones.setdefault(z.pop("floor_id"), []).append(z)

    return {
        "summary": {**summary, "admins": len({g["employee"]["emp_no"] for g in grants})},
        "sites": [
            {
                "id": s["id"],
                "kind": SITE_KIND.get(s["kind"], s["kind"]),
                "name": s["name"],
                "address": s["address"],
                "admins": holders("SITE_ADMIN", "site_id", s["id"]),
                "floors": [
                    {
                        "id": f["id"],
                        "name": f["name"],
                        "description": f["description"],
                        "seats": f["seats"],
                        "occupied": f["occupied"],
                        "rooms": f["rooms"],
                        "zones": by_floor_zones.get(f["id"], []),
                        "floor_admins": holders("FLOOR_ADMIN", "floor_id", f["id"]),
                        "zone_admins": len(holders("ZONE_ADMIN", "floor_id", f["id"])),
                        "plan": plan_state(f),
                        "plan_updated_at": f["plan_updated_at"],
                        "plan_updated_by": f["plan_updated_by"],
                        "in_scope": in_scope(f),
                    }
                    for f in floors
                    if f["site_id"] == s["id"]
                ],
            }
            for s in sites
        ],
        "grants": grants,
    }
