"""관리자 권한 부여·편집 API (관리자 첫 화면의 "권한 부여"와 관리자 목록의 "편집").

누가 누구의 권한을 다루나 (admin_auth.can_manage): 최종 관리자는 1~4단계 전부, 전사 관리자는 2~4단계,
사업장 관리자는 그 사업장의 층·구역 관리자, 층 관리자는 그 층의 구역 관리자. 같은 층에 층 관리자를 여러 명 둘 수 있고,
구역 관리자를 두지 않으면 층 관리자가 그 구역 배치까지 맡는다 (층 관리자는 층 전체를 편집한다).

권한을 처음 받는 사람에게는 관리자 계정을 임시 비밀번호로 만들어 이 응답에서만 보여 준다 (첫 로그인 때 바꾼다).
"""

from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query, Request
from psycopg import Connection
from psycopg.errors import UniqueViolation
from pydantic import BaseModel

from app.admin_auth import COMPANY_WIDE, ROLES, CurrentAdmin, can_manage, grants_of
from app.db import pool
from app.routers.org import _audit, _temp_password
from app.security import hash_password

router = APIRouter(prefix="/api/admin", tags=["admin-grants"])

Role = Literal["COMPANY_ADMIN", "SITE_ADMIN", "FLOOR_ADMIN", "ZONE_ADMIN"]
ApplyMode = Literal["IMMEDIATE", "NEEDS_APPROVAL"]


class GrantIn(BaseModel):
    """role에 맞는 범위 하나: 전사는 없음, 사업장은 site_id, 층은 floor_id, 구역은 zone_id"""

    role: Role
    site_id: int | None = None
    floor_id: int | None = None
    zone_id: int | None = None
    apply_mode: ApplyMode = "IMMEDIATE"  # 구역 관리자의 변경 반영: 즉시 / 층 관리자 승인 후


class NewGrantIn(GrantIn):
    emp_no: str


def _target(conn: Connection, body: GrantIn) -> dict[str, Any]:
    """새 권한의 범위를 확인하고 사업장·층까지 채운다 (can_manage가 범위를 비교할 수 있게)"""
    site_id = floor_id = zone_id = None
    if body.role == "SITE_ADMIN":
        row = conn.execute("SELECT id FROM sites WHERE id = %s AND is_active", (body.site_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=422, detail={"code": "SCOPE_REQUIRED"})
        site_id = row["id"]
    elif body.role == "FLOOR_ADMIN":
        row = conn.execute(
            "SELECT f.id, f.site_id FROM floors f JOIN sites s ON s.id = f.site_id "
            "WHERE f.id = %s AND f.is_active AND s.is_active",
            (body.floor_id,),
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=422, detail={"code": "SCOPE_REQUIRED"})
        site_id, floor_id = row["site_id"], row["id"]
    elif body.role == "ZONE_ADMIN":
        row = conn.execute(
            "SELECT z.id, z.floor_id, f.site_id FROM zones z JOIN floors f ON f.id = z.floor_id "
            "WHERE z.id = %s AND z.is_active AND f.is_active",
            (body.zone_id,),
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=422, detail={"code": "SCOPE_REQUIRED"})
        site_id, floor_id, zone_id = row["site_id"], row["floor_id"], row["id"]
    return {
        "role": body.role,
        "site_id": site_id,
        "floor_id": floor_id,
        "zone_id": zone_id,
        "apply_mode": body.apply_mode if body.role == "ZONE_ADMIN" else "IMMEDIATE",
    }


def _require_manage(admin: dict[str, Any], target: dict[str, Any]) -> None:
    if not can_manage(admin["grants"], target):
        raise HTTPException(status_code=403, detail={"code": "NOT_IN_SCOPE"})


def _insert(conn: Connection, employee_id: int, target: dict[str, Any], by: int) -> int:
    """권한 한 줄 넣기. 같은 사람에게 같은 범위의 같은 권한이 이미 있으면 409"""
    # 같은 트랜잭션의 다른 변경(편집의 회수)은 살리고 이 INSERT만 되돌리도록 savepoint 안에서
    try:
        with conn.transaction():
            row = conn.execute(
                """
                INSERT INTO admin_grants (employee_id, role, site_id, floor_id, zone_id, apply_mode, granted_by)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                RETURNING id
                """,
                (
                    employee_id,
                    target["role"],
                    target["site_id"] if target["role"] == "SITE_ADMIN" else None,
                    target["floor_id"] if target["role"] == "FLOOR_ADMIN" else None,
                    target["zone_id"],
                    target["apply_mode"],
                    by,
                ),
            ).fetchone()
    except UniqueViolation:
        raise HTTPException(status_code=409, detail={"code": "ALREADY_GRANTED"}) from None
    return row["id"]


def _grant(conn: Connection, grant_id: int) -> dict[str, Any]:
    """살아 있는 권한 한 줄 (grants_of 모양)"""
    for g in grants_of(conn):
        if g["id"] == grant_id:
            return g
    raise HTTPException(status_code=404, detail={"code": "GRANT_NOT_FOUND"})


@router.get("/grants/options")
def grant_options(admin: CurrentAdmin) -> dict[str, Any]:
    """권한 부여 창의 고를 거리: 내가 줄 수 있는 역할과, 내 범위 안의 사업장 → 층 → 구역"""
    mine = admin["grants"]
    roles = [
        {"role": role, "level": level, "label": label}
        for role, (level, label) in ROLES.items()
        if level > 0
        and any(ROLES[g["role"]][0] < level and g["role"] != "ZONE_ADMIN" for g in mine)
        # 전사 관리자는 최종 관리자만, 사업장 관리자는 전사 이상만 준다
        and (role != "COMPANY_ADMIN" or any(g["role"] == "SUPER_ADMIN" for g in mine))
        and (role != "SITE_ADMIN" or any(g["role"] in COMPANY_WIDE for g in mine))
    ]
    with pool.connection() as conn:
        sites = conn.execute("SELECT id, name FROM sites WHERE is_active ORDER BY sort_order, id").fetchall()
        floors = conn.execute(
            "SELECT id, site_id, name FROM floors WHERE is_active ORDER BY site_id, sort_order DESC"
        ).fetchall()
        zones = conn.execute(
            """
            SELECT z.id, z.floor_id, z.code, z.name FROM zones z
            WHERE z.is_active ORDER BY z.floor_id, z.sort_order, z.code
            """
        ).fetchall()

    def floor_ok(f: dict[str, Any]) -> bool:
        """이 층의 구역 관리자를 줄 수 있나 (층 관리자 이상이 맡은 층)"""
        return can_manage(mine, {"role": "ZONE_ADMIN", "site_id": f["site_id"], "floor_id": f["id"]})

    out = []
    for s in sites:
        site_floors = [f for f in floors if f["site_id"] == s["id"] and floor_ok(f)]
        if not site_floors and not can_manage(mine, {"role": "SITE_ADMIN", "site_id": s["id"], "floor_id": None}):
            continue
        out.append(
            {
                "id": s["id"],
                "name": s["name"],
                "floors": [
                    {
                        "id": f["id"],
                        "name": f["name"],
                        # 층 관리자를 줄 수 있나 (사업장 관리자 이상). 층 관리자는 자기 층의 구역 관리자만 준다
                        "floor_admin": can_manage(
                            mine, {"role": "FLOOR_ADMIN", "site_id": s["id"], "floor_id": f["id"]}
                        ),
                        "zones": [
                            {"id": z["id"], "code": z["code"], "name": z["name"]}
                            for z in zones
                            if z["floor_id"] == f["id"]
                        ],
                    }
                    for f in site_floors
                ],
            }
        )
    return {"roles": roles, "sites": out}


@router.get("/grants/people")
def grant_people(admin: CurrentAdmin, q: str = Query(min_length=1, max_length=50)) -> dict[str, Any]:
    """권한을 줄 사람 찾기: 재직 중인 직원의 이름·사번. 이미 가진 관리자 권한을 같이 준다"""
    if admin["grants"][0]["role"] == "ZONE_ADMIN":
        raise HTTPException(status_code=403, detail={"code": "NOT_IN_SCOPE"})
    like = "%" + q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
    with pool.connection() as conn:
        rows = conn.execute(
            """
            SELECT e.id, e.emp_no, e.name, e.rank_name AS rank, d.name AS department,
                   EXISTS (SELECT 1 FROM admin_accounts a WHERE a.employee_id = e.id) AS has_account
            FROM employees e JOIN departments d ON d.id = e.department_id
            WHERE e.employment_status = 'ACTIVE' AND (e.name ILIKE %(q)s OR e.emp_no ILIKE %(q)s)
            ORDER BY e.name = %(exact)s DESC, e.name, e.emp_no
            LIMIT 20
            """,
            {"q": like, "exact": q.strip()},
        ).fetchall()
        held: dict[int, list[str]] = {}
        for g in grants_of(conn):
            held.setdefault(g["employee_id"], []).append(f"{g['label']} · {g['scope']}")
    return {
        "people": [
            {
                "emp_no": r["emp_no"],
                "name": r["name"],
                "rank": r["rank"],
                "department": r["department"],
                "has_account": r["has_account"],
                "grants": held.get(r["id"], []),
            }
            for r in rows
        ]
    }


@router.post("/grants", status_code=201)
def create_grant(body: NewGrantIn, admin: CurrentAdmin, request: Request) -> dict[str, Any]:
    """권한 부여. 관리자 계정이 없던 사람이면 임시 비밀번호로 계정을 만들고 그 비밀번호를 돌려준다"""
    with pool.connection() as conn:
        target = _target(conn, body)
        _require_manage(admin, target)
        person = conn.execute(
            """
            SELECT e.id, e.emp_no, e.name FROM employees e JOIN departments d ON d.id = e.department_id
            WHERE e.emp_no = %s AND e.employment_status = 'ACTIVE'
            """,
            (body.emp_no.strip(),),
        ).fetchone()
        if person is None:
            raise HTTPException(status_code=404, detail={"code": "EMPLOYEE_NOT_FOUND"})
        grant_id = _insert(conn, person["id"], target, admin["employee_id"])
        password = None
        if conn.execute("SELECT 1 FROM admin_accounts WHERE employee_id = %s", (person["id"],)).fetchone() is None:
            password = _temp_password()
            conn.execute(
                """
                INSERT INTO admin_accounts (employee_id, password_hash, must_change_password, created_by)
                VALUES (%s, %s, true, %s)
                """,
                (person["id"], hash_password(password), admin["employee_id"]),
            )
        _audit(
            conn,
            admin,
            request,
            "GRANT_CREATE",
            "admin_grant",
            grant_id,
            after={**target, "emp_no": person["emp_no"], "new_account": password is not None},
        )
        grant = _grant(conn, grant_id)
    return {"grant": grant, "temporary_password": password}


@router.put("/grants/{grant_id}")
def update_grant(grant_id: int, body: GrantIn, admin: CurrentAdmin, request: Request) -> dict[str, Any]:
    """권한 편집: 역할·범위·반영 방식. 역할이나 범위가 바뀌면 이전 권한을 회수하고 새로 준다 (지정 기록이 남게)"""
    with pool.connection() as conn:
        before = _grant(conn, grant_id)
        _require_manage(admin, before)
        target = _target(conn, body)
        _require_manage(admin, target)
        same_scope = (
            target["role"] == before["role"]
            and target["zone_id"] == before["zone_id"]
            and (target["role"] != "FLOOR_ADMIN" or target["floor_id"] == before["floor_id"])
            and (target["role"] != "SITE_ADMIN" or target["site_id"] == before["site_id"])
        )
        if same_scope:
            conn.execute("UPDATE admin_grants SET apply_mode = %s WHERE id = %s", (target["apply_mode"], grant_id))
            new_id = grant_id
        else:
            conn.execute(
                "UPDATE admin_grants SET revoked_at = now(), revoked_by = %s WHERE id = %s",
                (admin["employee_id"], grant_id),
            )
            new_id = _insert(conn, before["employee_id"], target, admin["employee_id"])
        _audit(conn, admin, request, "GRANT_UPDATE", "admin_grant", new_id, before=before, after=target)
        grant = _grant(conn, new_id)
    return {"grant": grant}


@router.delete("/grants/{grant_id}", status_code=204)
def revoke_grant(grant_id: int, admin: CurrentAdmin, request: Request) -> None:
    """권한 회수. 남은 권한이 없으면 그 사람은 관리자 페이지에 더 들어오지 못한다 (계정은 남는다)"""
    with pool.connection() as conn:
        before = _grant(conn, grant_id)
        _require_manage(admin, before)
        conn.execute(
            "UPDATE admin_grants SET revoked_at = now(), revoked_by = %s WHERE id = %s",
            (admin["employee_id"], grant_id),
        )
        _audit(conn, admin, request, "GRANT_REVOKE", "admin_grant", grant_id, before=before)


@router.post("/admins/{emp_no}/reset-password")
def reset_admin_password(emp_no: str, admin: CurrentAdmin, request: Request) -> dict[str, Any]:
    """관리자 비밀번호를 임시 비밀번호로 (잠금도 푼다). 그 사람의 권한을 모두 내가 다룰 수 있을 때만
    (위 단계 권한도 가진 사람의 계정을 아래 단계 범위로 가져가지 못하게). 임시 비밀번호는 이 응답에서만 보여 준다"""
    with pool.connection() as conn:
        person = conn.execute(
            """
            SELECT e.id FROM employees e JOIN admin_accounts a ON a.employee_id = e.id
            WHERE e.emp_no = %s AND e.employment_status = 'ACTIVE'
            """,
            (emp_no,),
        ).fetchone()
        if person is None:
            raise HTTPException(status_code=404, detail={"code": "EMPLOYEE_NOT_FOUND"})
        theirs = grants_of(conn, person["id"])
        mine = admin["grants"]
        if not theirs or person["id"] == admin["employee_id"] or not all(can_manage(mine, g) for g in theirs):
            raise HTTPException(status_code=403, detail={"code": "NOT_IN_SCOPE"})
        password = _temp_password()
        conn.execute(
            """
            UPDATE admin_accounts
            SET password_hash = %s, must_change_password = true, failed_login_count = 0, locked_at = NULL,
                password_changed_at = now(), updated_at = now()
            WHERE employee_id = %s
            """,
            (hash_password(password), person["id"]),
        )
        conn.execute(
            """
            UPDATE user_sessions SET revoked_at = now(), revoked_reason = 'PASSWORD_RESET'
            WHERE employee_id = %s AND kind = 'ADMIN' AND revoked_at IS NULL
            """,
            (person["id"],),
        )
        _audit(conn, admin, request, "ADMIN_PASSWORD_RESET", "employee", person["id"])
    return {"temporary_password": password}
