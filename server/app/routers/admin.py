"""관리자 페이지 API: 관리자 로그인(직원 로그인과 다른 비밀번호)과 비밀번호 변경, 관리자 첫 화면(사업장·층·권한 현황).

관리자 ID는 사번이다. 최종 관리자만 사번이 아닌 시스템 계정 ID(admin)로 들어온다."""

from datetime import timedelta
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from app.admin_auth import (
    COMPANY_WIDE,
    ROLES,
    CurrentAdmin,
    CurrentAdminAllowTemporary,
    admin_out,
    grants_of,
    is_company_wide,
    load_admin,
    require_admin_allow_temporary,
)
from app.config import settings
from app.db import get_setting, pool
from app.routers.auth import PasswordChange, client_info, error_response, password_problems
from app.security import hash_password, new_session_token, verify_password
from app.session import end_sessions

router = APIRouter(prefix="/api/admin", tags=["admin"])

SITE_KIND = {"HQ": "본사", "CENTER": "센터"}
# 최종 관리자(시스템 계정)는 잠금을 풀어 줄 상위 관리자가 없어서, 비밀번호를 여러 번 틀려 잠기면
# 이만큼(분) 뒤에 저절로 풀린다
SUPER_LOCK_MINUTES = 30


class AdminLoginRequest(BaseModel):
    emp_no: str = Field(min_length=1, max_length=20)
    password: str = Field(min_length=1, max_length=128)


@router.post("/auth/login")
def admin_login(body: AdminLoginRequest, request: Request) -> JSONResponse:
    """관리자 로그인. 관리자 계정(admin_accounts)과 살아 있는 권한이 있어야 한다.

    실패 횟수·잠금은 직원 로그인과 따로 센다. 최종 관리자의 잠금만 SUPER_LOCK_MINUTES 뒤에 저절로 풀린다.
    """
    ip, user_agent = client_info(request)
    with pool.connection() as conn:
        max_failed = int(get_setting(conn, "login.max_failed_count", 5))
        admin = conn.execute(
            """
            SELECT e.id, e.employment_status, a.password_hash, a.failed_login_count, a.locked_at,
                   e.employment_status = 'SYSTEM' AND a.locked_at < now() - make_interval(mins => %s) AS lock_expired
            FROM employees e
            JOIN admin_accounts a ON a.employee_id = e.id
            WHERE e.emp_no = %s
            FOR UPDATE OF a
            """,
            (SUPER_LOCK_MINUTES, body.emp_no),
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
        # 비밀번호가 맞기 전에는 퇴사 여부·실패 횟수를 알려 주지 않는다 (누가 관리자인지 드러나지 않게)
        if admin["locked_at"] is not None and not admin["lock_expired"]:
            record("LOCKED")
            return error_response(423, "LOCKED", max_failed_count=max_failed)
        if not verify_password(body.password, admin["password_hash"]):
            failed = (0 if admin["lock_expired"] else admin["failed_login_count"]) + 1
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
            return error_response(401, "INVALID_CREDENTIALS")
        if admin["employment_status"] not in ("ACTIVE", "SYSTEM"):
            record("NOT_ACTIVE")
            return error_response(403, "NOT_ACTIVE")
        if not grants_of(conn, admin["id"]):
            record("NO_PERMISSION")
            return error_response(403, "NO_PERMISSION")

        token, token_hash = new_session_token()
        conn.execute(
            """
            UPDATE admin_accounts
            SET failed_login_count = 0, locked_at = NULL, last_login_at = now(), updated_at = now()
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

    # 같은 브라우저의 직원 화면 로그인은 건드리지 않는다 (계정·세션이 따로)
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
def admin_me(request: Request) -> JSONResponse:
    """로그인한 관리자. 임시 비밀번호 상태(must_change_password)면 화면이 비밀번호 변경으로 보낸다.

    끊겼으면 401과 함께 남은 관리자 쿠키를 지운다. 관리자 로그인 화면이 끊긴 이유("15분 넘게 …")를 보여 준 뒤
    브라우저에서 이것을 불러, 다음에 들어올 때 다시 "끊김"으로 보지 않게 한다
    (그사이 다시 로그인했으면 쿠키는 그대로)"""
    try:
        admin = require_admin_allow_temporary(request)
    except HTTPException as error:
        response = JSONResponse(status_code=error.status_code, content={"detail": error.detail})
        response.delete_cookie(settings.admin_cookie_name, path="/")
        return response
    return JSONResponse(jsonable_encoder({"admin": admin_out(admin)}))


@router.post("/auth/password", status_code=204)
def change_admin_password(body: PasswordChange, admin: CurrentAdminAllowTemporary) -> Response:
    """관리자 비밀번호 변경 (직원 화면 비밀번호와 따로). 임시 비밀번호 상태에서도 쓸 수 있다.

    현재 비밀번호를 틀리면 관리자 로그인과 같은 실패 횟수를 올리고, 같은 횟수에서 잠근다.
    바꾸면 이 브라우저 말고 다른 곳의 관리자 로그인은 끝낸다."""
    with pool.connection() as conn:
        account = conn.execute(
            "SELECT password_hash, failed_login_count FROM admin_accounts WHERE employee_id = %s FOR UPDATE",
            (admin["employee_id"],),
        ).fetchone()
        if not verify_password(body.current_password, account["password_hash"]):
            max_failed = int(get_setting(conn, "login.max_failed_count", 5))
            failed = account["failed_login_count"] + 1
            locked = failed >= max_failed
            conn.execute(
                """
                UPDATE admin_accounts
                SET failed_login_count = %s, locked_at = CASE WHEN %s THEN now() END, updated_at = now()
                WHERE employee_id = %s
                """,
                (failed, locked, admin["employee_id"]),
            )
            if locked:
                return error_response(423, "LOCKED", max_failed_count=max_failed)
            return error_response(400, "WRONG_CURRENT", max_failed_count=max_failed)
        problems = password_problems(body.new_password, admin["emp_no"])
        if problems:
            return error_response(422, "WEAK_PASSWORD", problems=problems)
        if body.new_password == body.current_password:
            return error_response(422, "SAME_AS_OLD")
        conn.execute(
            """
            UPDATE admin_accounts
            SET password_hash = %s, must_change_password = false, password_changed_at = now(),
                failed_login_count = 0, updated_at = now()
            WHERE employee_id = %s
            """,
            (hash_password(body.new_password), admin["employee_id"]),
        )
        conn.execute(
            """
            UPDATE user_sessions SET revoked_at = now(), revoked_reason = 'PASSWORD_CHANGED'
            WHERE employee_id = %s AND kind = 'ADMIN' AND token_hash <> %s AND revoked_at IS NULL
            """,
            (admin["employee_id"], admin["token_hash"]),
        )
    return Response(status_code=204)


@router.get("/auth/session")
def admin_session_status(request: Request) -> JSONResponse:
    """관리자 자동 로그아웃까지 남은 시간. 확인만 하고 사용 시각은 늘리지 않는다"""
    token = request.cookies.get(settings.admin_cookie_name)
    with pool.connection() as conn:
        admin = load_admin(conn, token, touch=False) if token else None
    if admin is None:
        return error_response(401, "NOT_ADMIN_LOGGED_IN")
    return JSONResponse({"idle_left": max(0, admin["idle_left"]), "idle_minutes": admin["idle_minutes"]})


@router.post("/auth/logout", status_code=204)
def admin_logout(request: Request) -> Response:
    """관리자 페이지 로그아웃. 같은 브라우저의 직원 화면 로그인은 그대로 둔다"""
    return end_sessions(request, settings.admin_cookie_name)


def _scope(grants: list[dict[str, Any]], floors: list[dict[str, Any]]) -> dict[str, Any]:
    """내 관리 범위: 층 전체를 맡은 층(full), 그 밖에 구역만 맡은 구역(zones), 둘을 합친 층(floors)"""
    full: set[int] = set()
    for g in grants:
        for f in floors:
            if (
                g["role"] in COMPANY_WIDE
                or (g["role"] == "SITE_ADMIN" and g["site_id"] == f["site_id"])
                or (g["role"] == "FLOOR_ADMIN" and g["floor_id"] == f["id"])
            ):
                full.add(f["id"])
    zone_grants = [g for g in grants if g["role"] == "ZONE_ADMIN" and g["floor_id"] not in full]
    kind = "ALL" if is_company_wide(grants) else "FLOORS" if full else "ZONES"
    return {
        "kind": kind,
        "full": sorted(full),
        "zones": [g["zone_id"] for g in zone_grants],
        "floors": sorted(full | {g["floor_id"] for g in zone_grants}),
    }


@router.get("/overview")
def overview(admin: CurrentAdmin) -> dict[str, Any]:
    """관리자 첫 화면: 사업장별 층 현황(입주 팀, 층 관리자, 도면 상태, 좌석), 관리자 권한 목록, 요약 숫자.

    전사 관리자는 모든 사업장을, 그 아래 단계는 맡은 범위만 본다: 사업장 관리자는 맡은 사업장(모든 층),
    층·구역 관리자는 맡은 층이 있는 사업장의 그 층만. 층마다 내 관리 범위인지(in_scope)를 붙인다.
    """
    with pool.connection() as conn:
        sites = conn.execute(
            "SELECT id, kind, name, address FROM sites WHERE is_active ORDER BY sort_order, id"
        ).fetchall()
        floors = conn.execute(
            """
            SELECT f.id, f.site_id, f.name, f.description,
                   -- 개인석(고정석)과 자율석을 나눠 센다. 자율석은 배정하지 않는다.
                   -- 사용 중지(고장·수리) 자리는 앉을 수 없으니 좌석·빈 자리에서 빼고 따로 센다
                   (SELECT count(*) FROM seats s
                    WHERE s.floor_id = f.id AND s.status = 'ACTIVE' AND s.seat_type = 'FIXED')::int AS seats,
                   (SELECT count(*) FROM seats s
                    WHERE s.floor_id = f.id AND s.status = 'ACTIVE' AND s.seat_type = 'FLEX')::int AS flex,
                   (SELECT count(*) FROM seats s
                    WHERE s.floor_id = f.id AND s.status = 'OUT_OF_SERVICE')::int AS out_of_service,
                   (SELECT count(DISTINCT a.seat_id) FROM seat_assignments a JOIN seats s ON s.id = a.seat_id
                    WHERE s.floor_id = f.id AND s.status = 'ACTIVE' AND s.seat_type = 'FIXED' AND a.kind = 'FIXED'
                      AND a.starts_at <= now() AND (a.ends_at IS NULL OR a.ends_at > now())
                   )::int AS occupied,
                   (SELECT count(*) FROM meeting_rooms m WHERE m.floor_id = f.id AND m.is_active)::int AS rooms,
                   EXISTS (SELECT 1 FROM floor_plans p WHERE p.floor_id = f.id AND p.status = 'PUBLISHED') AS published,
                   EXISTS (SELECT 1 FROM floor_plans p WHERE p.floor_id = f.id AND p.status = 'DRAFT') AS drafting,
                   (SELECT p.effective_at FROM floor_plans p
                    WHERE p.floor_id = f.id AND p.status = 'SCHEDULED') AS plan_scheduled_at,
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
            SELECT z.floor_id, z.code, z.name, z.color_key, d.name AS department,
                   coalesce(d.is_active, true) AS department_active
            FROM zones z LEFT JOIN departments d ON d.id = z.department_id
            WHERE z.is_active
            ORDER BY z.floor_id, z.sort_order, z.code
            """
        ).fetchall()
        grants = grants_of(conn)
        mine = admin["grants"]
        scope = _scope(mine, floors)
        summary = conn.execute(
            """
            WITH scoped_seats AS (
                SELECT s.* FROM seats s
                WHERE s.status <> 'REMOVED' AND (s.floor_id = ANY(%(full)s) OR s.zone_id = ANY(%(zones)s))
            ),
            current AS (
                SELECT DISTINCT ON (a.employee_id) a.employee_id, a.seat_id FROM seat_assignments a
                WHERE a.starts_at <= now() AND (a.ends_at IS NULL OR a.ends_at > now())
            ),
            today AS (SELECT date_trunc('day', now() AT TIME ZONE 'Asia/Seoul') AS d)
            SELECT (SELECT count(*) FROM employees WHERE employment_status = 'ACTIVE')::int AS employees,
                   -- 재직 중인데 지금 앉을 자리가 없는 사람 (신규 입사자 등)
                   (SELECT count(*) FROM employees e WHERE e.employment_status = 'ACTIVE'
                      AND NOT EXISTS (SELECT 1 FROM current c WHERE c.employee_id = e.id))::int AS unseated,
                   (SELECT count(*) FROM scoped_seats WHERE status = 'ACTIVE' AND seat_type = 'FIXED')::int AS seats,
                   (SELECT count(*) FROM scoped_seats WHERE status = 'ACTIVE' AND seat_type = 'FLEX')::int AS flex,
                   (SELECT count(*) FROM scoped_seats WHERE status = 'OUT_OF_SERVICE')::int AS out_of_service,
                   (SELECT count(DISTINCT s.id) FROM scoped_seats s JOIN current c ON c.seat_id = s.id
                    WHERE s.status = 'ACTIVE' AND s.seat_type = 'FIXED')::int AS occupied,
                   (SELECT count(*) FROM meeting_rooms WHERE is_active AND floor_id = ANY(%(floors)s))::int AS rooms,
                   (SELECT count(*) FROM reservations r JOIN meeting_rooms m ON m.id = r.room_id, today
                    WHERE r.status = 'CONFIRMED' AND m.floor_id = ANY(%(floors)s)
                      AND r.starts_at < (today.d + interval '1 day') AT TIME ZONE 'Asia/Seoul'
                      AND r.ends_at > today.d AT TIME ZONE 'Asia/Seoul')::int AS reservations_today,
                   -- 층 관리 권한이 있으면 내가 승인할 요청, 구역 관리자는 내가 올려 승인을 기다리는 요청
                   (SELECT count(*) FROM change_requests c WHERE c.status = 'PENDING'
                      AND (c.floor_id = ANY(%(full)s) OR c.requested_by = %(me)s))::int AS pending_requests
            """,
            {"full": scope["full"], "zones": scope["zones"], "floors": scope["floors"], "me": admin["employee_id"]},
        ).fetchone()
        # 미배치 인원 알림: 재직 중인데 자리가 없는 사람을 부서마다 (인사이동·신규 입사로 생긴다).
        # 그 부서의 팀 구역이 있는 층을 같이 준다 (화면이 좌석 배치 편집으로 바로 보낸다).
        # 전사 관리자는 전부, 그 아래는 맡은 층(구역 관리자는 맡은 구역)에 팀 구역이 있는 부서만
        unseated_teams = conn.execute(
            """
            WITH current AS (
                SELECT DISTINCT a.employee_id FROM seat_assignments a
                WHERE a.starts_at <= now() AND (a.ends_at IS NULL OR a.ends_at > now())
            ),
            waiting AS (
                SELECT e.id, e.department_id FROM employees e
                WHERE e.employment_status = 'ACTIVE' AND NOT EXISTS (SELECT 1 FROM current c WHERE c.employee_id = e.id)
            )
            SELECT d.id AS department_id, d.name AS department, count(DISTINCT w.id)::int AS people,
                   coalesce(array_agg(DISTINCT z.floor_id) FILTER (WHERE z.floor_id IS NOT NULL), '{}') AS floor_ids
            FROM waiting w
            JOIN departments d ON d.id = w.department_id
            LEFT JOIN zones z ON z.department_id = d.id AND z.is_active
            WHERE %(all)s OR z.floor_id = ANY(%(full)s) OR z.id = ANY(%(zones)s)
            GROUP BY d.id, d.name
            ORDER BY count(DISTINCT w.id) DESC, d.name
            """,
            {"all": scope["kind"] == "ALL", "full": scope["full"], "zones": scope["zones"]},
        ).fetchall()

    def in_scope(floor: dict[str, Any]) -> str | None:
        """내가 이 층을 관리하나: "ALL"(층 전체) / "ZONE"(층 안 일부 구역) / None"""
        for g in mine:
            if g["role"] in COMPANY_WIDE or (g["role"] == "SITE_ADMIN" and g["site_id"] == floor["site_id"]):
                return "ALL"
            if g["role"] == "FLOOR_ADMIN" and g["floor_id"] == floor["id"]:
                return "ALL"
        return "ZONE" if any(g["role"] == "ZONE_ADMIN" and g["floor_id"] == floor["id"] for g in mine) else None

    def plan_state(floor: dict[str, Any]) -> str:
        if floor["plan_scheduled_at"]:
            return "SCHEDULED"
        if floor["published"]:
            return "EDITING" if floor["drafting"] else "PUBLISHED"
        return "DRAFT" if floor["drafting"] else "NONE"

    def holders(role: str, key: str, value: int) -> list[str]:
        """이 범위의 그 역할 관리자 이름"""
        return [g["employee"]["name"] for g in grants if g["role"] == role and g[key] == value]

    by_floor_zones: dict[int, list[dict[str, Any]]] = {}
    for z in zones:
        by_floor_zones.setdefault(z.pop("floor_id"), []).append(z)

    # 층 관리자를 아직 정하지 않은 층은 최고 단계 관리자가 임시로 맡는다 (전사 관리자는 모든 층을 관리할 수 있다).
    # 전사 관리자(1단계) 중 가나다 순 첫 사람, 없으면 최종 관리자. 화면이 층 관리자 칸에 "임시"로 보여 준다
    def first_holder(role: str) -> str | None:
        names = sorted(g["employee"]["name"] for g in grants if g["role"] == role)
        return names[0] if names else None

    acting = first_holder("COMPANY_ADMIN")
    acting_floor_admin = (
        {"name": acting, "role_label": ROLES["COMPANY_ADMIN"][1]}
        if acting
        else {"name": first_holder("SUPER_ADMIN"), "role_label": ROLES["SUPER_ADMIN"][1]}
        if first_holder("SUPER_ADMIN")
        else None
    )

    site_names = {s["id"]: s["name"] for s in sites}
    company_wide = is_company_wide(mine)
    my_sites = {g["site_id"] for g in mine if g["role"] == "SITE_ADMIN"}

    def site_visible(site: dict[str, Any]) -> bool:
        """맡은 사업장이거나 맡은 층이 있는 사업장 (아직 층이 없는 사업장도 사업장 관리자에게는 보인다)"""
        return company_wide or site["id"] in my_sites or any(f["site_id"] == site["id"] and in_scope(f) for f in floors)

    def floor_visible(floor: dict[str, Any]) -> bool:
        return company_wide or floor["site_id"] in my_sites or in_scope(floor) is not None

    return {
        "summary": {
            **summary,
            "admins": len({g["employee"]["emp_no"] for g in grants}),
            # ALL: 전사 관리자라 전체 / FLOORS: 사업장·층 단위 / ZONES: 구역만 (요청은 내가 올린 것)
            "scope": scope["kind"],
        },
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
                        "flex": f["flex"],
                        "occupied": f["occupied"],
                        "out_of_service": f["out_of_service"],
                        "rooms": f["rooms"],
                        "zones": by_floor_zones.get(f["id"], []),
                        "floor_admins": holders("FLOOR_ADMIN", "floor_id", f["id"]),
                        "zone_admins": len(holders("ZONE_ADMIN", "floor_id", f["id"])),
                        "plan": plan_state(f),
                        "plan_updated_at": f["plan_updated_at"],
                        "plan_scheduled_at": f["plan_scheduled_at"],  # 게시 예약 시각
                        "plan_updated_by": f["plan_updated_by"],
                        "in_scope": in_scope(f),
                    }
                    for f in floors
                    if f["site_id"] == s["id"] and floor_visible(f)
                ],
            }
            for s in sites
            if site_visible(s)
        ],
        "grants": grants,
        "acting_floor_admin": acting_floor_admin,
        "unseated_teams": [
            {
                "department": t["department"],
                "people": t["people"],
                "floors": [
                    {"id": f["id"], "label": f"{site_names[f['site_id']]} {f['name']}"}
                    for f in floors
                    if f["id"] in t["floor_ids"] and floor_visible(f)
                ],
            }
            for t in unseated_teams
        ],
    }
