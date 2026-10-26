"""관리자 페이지 로그인 확인. 관리자 API는 CurrentAdmin 인자를 받는다.

관리자 페이지는 직원 화면과 쿠키·비밀번호·세션 종류(kind = 'ADMIN')가 모두 다르다.
권한(admin_grants)이 모두 회수되면 로그인해 있어도 바로 못 쓴다.
권한을 받으며 임시 비밀번호를 받은 관리자는 비밀번호를 바꾸기 전에는 다른 관리자 API를 못 쓴다.
"""

from typing import Annotated, Any

from fastapi import Depends, HTTPException, Request
from psycopg import Connection

from app.config import settings
from app.db import get_setting, pool
from app.security import hash_token

# 역할: (단계, 이름). 숫자가 작을수록 넓은 범위. 최종 관리자(admin 계정)는 1~4단계 위에 있다
ROLES: dict[str, tuple[int, str]] = {
    "SUPER_ADMIN": (0, "최종 관리자"),
    "COMPANY_ADMIN": (1, "전사 관리자"),
    "SITE_ADMIN": (2, "사업장 관리자"),
    "FLOOR_ADMIN": (3, "층 관리자"),
    "ZONE_ADMIN": (4, "구역 관리자"),
}
# 모든 사업장을 맡는 역할 (최종 관리자는 전사 관리자가 하는 일을 모두 한다)
COMPANY_WIDE = ("SUPER_ADMIN", "COMPANY_ADMIN")


def is_company_wide(grants: list[dict[str, Any]]) -> bool:
    return any(g["role"] in COMPANY_WIDE for g in grants)


def grants_of(conn: Connection, employee_id: int | None = None) -> list[dict[str, Any]]:
    """살아 있는 관리자 권한과 범위 이름. employee_id가 없으면 전체 (관리자 목록)."""
    rows = conn.execute(
        """
        SELECT g.id, g.employee_id, g.role, g.apply_mode, g.granted_at,
               coalesce(s.id, fs.id, zs.id) AS site_id, coalesce(s.name, fs.name, zs.name) AS site_name,
               coalesce(f.id, zf.id) AS floor_id, coalesce(f.name, zf.name) AS floor_name,
               z.id AS zone_id, z.code AS zone_code, z.name AS zone_name,
               e.emp_no, e.name, e.rank_name, d.name AS department,
               gb.name AS granted_by, a.locked_at IS NOT NULL AS locked,
               coalesce(a.must_change_password, false) AS temporary_password
        FROM admin_grants g
        LEFT JOIN admin_accounts a ON a.employee_id = g.employee_id
        JOIN employees e ON e.id = g.employee_id
        LEFT JOIN departments d ON d.id = e.department_id  -- 최종 관리자(시스템 계정)는 부서가 없다
        LEFT JOIN employees gb ON gb.id = g.granted_by
        LEFT JOIN sites s ON s.id = g.site_id
        LEFT JOIN floors f ON f.id = g.floor_id
        LEFT JOIN sites fs ON fs.id = f.site_id
        LEFT JOIN zones z ON z.id = g.zone_id
        LEFT JOIN floors zf ON zf.id = z.floor_id
        LEFT JOIN sites zs ON zs.id = zf.site_id
        WHERE g.revoked_at IS NULL AND (%(emp)s::bigint IS NULL OR g.employee_id = %(emp)s)
        ORDER BY array_position(ARRAY['SUPER_ADMIN','COMPANY_ADMIN','SITE_ADMIN','FLOOR_ADMIN','ZONE_ADMIN'],
                                g.role::text),
                 g.granted_at
        """,
        {"emp": employee_id},
    ).fetchall()
    return [_grant_out(r) for r in rows]


def _grant_out(row: dict[str, Any]) -> dict[str, Any]:
    level, label = ROLES[row["role"]]
    if row["role"] in COMPANY_WIDE:
        scope = "전체 사업장"
    elif row["role"] == "SITE_ADMIN":
        scope = row["site_name"]
    elif row["role"] == "FLOOR_ADMIN":
        scope = f"{row['site_name']} · {row['floor_name']}"
    else:
        scope = f"{row['site_name']} · {row['floor_name']} · {row['zone_name']} {row['zone_code']}구역"
    return {
        "id": row["id"],
        "role": row["role"],
        "level": level,
        "label": label,
        "scope": scope,
        "site_id": row["site_id"],
        "floor_id": row["floor_id"],
        "zone_id": row["zone_id"],
        # 구역 관리자의 변경 반영: 즉시 / 층 관리자 승인 후
        "apply_mode": row["apply_mode"],
        "granted_at": row["granted_at"],
        "granted_by": row["granted_by"],
        "employee_id": row["employee_id"],
        # 관리자 계정 상태: 잠김(비밀번호를 여러 번 틀림) / 임시 비밀번호(아직 첫 로그인 전)
        "account": {"locked": row["locked"], "temporary_password": row["temporary_password"]},
        "employee": {
            "emp_no": row["emp_no"],
            "name": row["name"],
            "rank": row["rank_name"],
            "department": row["department"],
        },
    }


def load_admin(conn: Connection, token: str, *, touch: bool = True) -> dict[str, Any] | None:
    """유효한 관리자 세션이면 관리자 정보와 권한 목록을 돌려준다."""
    idle_minutes = int(get_setting(conn, "admin.session.idle_minutes", 15))
    admin = conn.execute(
        """
        SELECT s.id AS session_id, s.token_hash, e.id AS employee_id, e.emp_no, e.name, e.rank_name,
               d.name AS department, a.must_change_password,
               extract(epoch FROM s.last_active_at + make_interval(mins => %s) - now())::int AS idle_left
        FROM user_sessions s
        JOIN employees e ON e.id = s.employee_id
        LEFT JOIN departments d ON d.id = e.department_id
        JOIN admin_accounts a ON a.employee_id = e.id
        WHERE s.token_hash = %s
          AND s.kind = 'ADMIN'
          AND s.revoked_at IS NULL
          AND s.expires_at > now()
          AND s.last_active_at > now() - make_interval(mins => %s)
          AND e.employment_status IN ('ACTIVE', 'SYSTEM')
          AND a.locked_at IS NULL
        """,
        (idle_minutes, hash_token(token), idle_minutes),
    ).fetchone()
    if admin is None:
        return None
    grants = grants_of(conn, admin["employee_id"])
    if not grants:
        return None
    if touch:
        conn.execute("UPDATE user_sessions SET last_active_at = now() WHERE id = %s", (admin["session_id"],))
    return {**admin, "grants": grants, "idle_minutes": idle_minutes}


def _require_admin(request: Request, *, allow_temporary: bool) -> dict[str, Any]:
    token = request.cookies.get(settings.admin_cookie_name)
    if token:
        with pool.connection() as conn:
            admin = load_admin(conn, token)
        if admin is not None:
            # 임시 비밀번호 상태로는 비밀번호 변경 말고는 아무 관리자 API도 못 쓴다 (화면도 변경 화면으로 보낸다)
            if admin["must_change_password"] and not allow_temporary:
                raise HTTPException(status_code=403, detail={"code": "PASSWORD_CHANGE_REQUIRED"})
            return admin
    raise HTTPException(status_code=401, detail={"code": "NOT_ADMIN_LOGGED_IN"})


def require_admin(request: Request) -> dict[str, Any]:
    return _require_admin(request, allow_temporary=False)


def require_admin_allow_temporary(request: Request) -> dict[str, Any]:
    return _require_admin(request, allow_temporary=True)


CurrentAdmin = Annotated[dict[str, Any], Depends(require_admin)]
# 내 정보·비밀번호 변경처럼 임시 비밀번호 상태에서도 써야 하는 API
CurrentAdminAllowTemporary = Annotated[dict[str, Any], Depends(require_admin_allow_temporary)]


def can_manage(grants: list[dict[str, Any]], target: dict[str, Any]) -> bool:
    """target 권한(role·범위)을 내가 주거나 고치거나 회수할 수 있나: 내 범위 안의 더 아래 단계.
    최종 관리자는 1~4단계 전부, 전사 관리자는 2~4단계, 사업장 관리자는 그 사업장의 층·구역 관리자,
    층 관리자는 그 층의 구역 관리자. 최종 관리자 권한은 아무도 주거나 고칠 수 없다"""
    level = ROLES[target["role"]][0]
    if level == 0:
        return False
    for g in grants:
        if ROLES[g["role"]][0] >= level:
            continue
        if g["role"] in COMPANY_WIDE:
            return True
        if g["role"] == "SITE_ADMIN" and g["site_id"] == target["site_id"]:
            return True
        if g["role"] == "FLOOR_ADMIN" and g["floor_id"] == target["floor_id"]:
            return True
    return False


def admin_out(admin: dict[str, Any]) -> dict[str, Any]:
    top = admin["grants"][0]
    return {
        "emp_no": admin["emp_no"],
        "name": admin["name"],
        "rank": admin["rank_name"],
        "department": admin["department"],  # 최종 관리자(시스템 계정)는 None
        "role": top["role"],  # 가장 넓은 권한
        "role_label": top["label"],
        "grants": admin["grants"],
        "idle_minutes": admin["idle_minutes"],
        "must_change_password": admin["must_change_password"],
    }
