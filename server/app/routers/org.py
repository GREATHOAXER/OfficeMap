"""사업장·층·조직도 관리 API (관리자 페이지).

- 사업장 추가·고치기·닫기: 전사 관리자
- 층 추가·고치기·순서·없애기: 그 사업장의 사업장 관리자 이상
- 조직도(부서 추가·이름·위 부서·없애기, 팀원 옮기기·새 직원 등록·휴직·퇴사): 전사 관리자. 보기는 관리자 누구나

부서를 옮기거나 퇴사하면 고정석 배정은 DB 트리거(release_seat_on_org_change)가 끝내고, 그 사람은 새 팀의 미배치
인원이 된다. 없앤 부서·층은 지우지 않고 is_active = false로 둔다 (이력·감사 기록이 가리키므로).
"""

import json
import re
import secrets
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query, Request
from psycopg import Connection
from psycopg.errors import UniqueViolation
from pydantic import BaseModel, Field, field_validator

from app.admin_auth import CurrentAdmin, is_company_wide
from app.db import pool
from app.people_order import person_order
from app.routers.auth import client_info
from app.security import hash_password

router = APIRouter(prefix="/api/admin", tags=["org"])

SITE_KINDS = ("HQ", "CENTER")
EMP_NO_RE = re.compile(r"^[0-9A-Za-z]{4,20}$")
FLOOR_NAME_RE = re.compile(r"^[0-9A-Za-z가-힣 .\-]{1,20}$")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _is_company(admin: dict[str, Any]) -> bool:
    return is_company_wide(admin["grants"])


def _can_site(admin: dict[str, Any], site_id: int) -> bool:
    return _is_company(admin) or any(g["role"] == "SITE_ADMIN" and g["site_id"] == site_id for g in admin["grants"])


def _require_company(admin: dict[str, Any]) -> None:
    if not _is_company(admin):
        raise HTTPException(status_code=403, detail={"code": "COMPANY_ADMIN_ONLY"})


def _audit(
    conn: Connection,
    admin: dict[str, Any],
    request: Request,
    action: str,
    target: str,
    target_id: int,
    before: Any = None,
    after: Any = None,
) -> None:
    conn.execute(
        """
        INSERT INTO audit_logs (actor_id, action, target_type, target_id, before_data, after_data, ip_address)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        """,
        (
            admin["employee_id"],
            action,
            target,
            target_id,
            json.dumps(before, default=str) if before is not None else None,
            json.dumps(after, default=str) if after is not None else None,
            client_info(request)[0],
        ),
    )


def _clean(value: str | None) -> str | None:
    if value is None:
        return None
    value = value.strip()
    return value or None


def _check_email(value: str | None) -> str | None:
    value = _clean(value)
    if value is not None and not EMAIL_RE.match(value):
        raise ValueError("이메일 형식이 아니에요 (예: hong@kftc.or.kr)")
    return value


def _free_name(conn: Connection, table: str, row_id: int, name: str, limit: int) -> None:
    """없앤(is_active = false) 사업장·층이 쥐고 있던 이름을 풀어 준다: 그 행 이름 뒤에 ~번호를 붙인다.
    이름은 UNIQUE라 없앤 행이 이름을 계속 쥐면, 살아 있는 행을 그 이름으로 바꿀 수 없다"""
    tail = f"~{row_id}"
    conn.execute(f"UPDATE {table} SET name = %s WHERE id = %s", (name[: limit - len(tail)] + tail, row_id))


# 사업장 ------------------------------------------------------------------------------------------


class SiteIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    kind: Literal["HQ", "CENTER"] = "CENTER"
    address: str | None = Field(default=None, max_length=255)

    @field_validator("name")
    @classmethod
    def strip_name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("이름을 넣어 주세요")
        return v

    @field_validator("address")
    @classmethod
    def strip_address(cls, v: str | None) -> str | None:
        return _clean(v)


def _site_row(conn: Connection, site_id: int) -> dict[str, Any]:
    site = conn.execute(
        "SELECT id, kind, name, address, is_active FROM sites WHERE id = %s FOR UPDATE", (site_id,)
    ).fetchone()
    if site is None or not site["is_active"]:
        raise HTTPException(status_code=404, detail={"code": "SITE_NOT_FOUND"})
    return site


@router.post("/sites", status_code=201)
def create_site(body: SiteIn, admin: CurrentAdmin, request: Request) -> dict[str, Any]:
    _require_company(admin)
    with pool.connection() as conn:
        same = conn.execute(
            "SELECT id, is_active FROM sites WHERE lower(name) = lower(%s) FOR UPDATE", (body.name,)
        ).fetchone()
        if same and same["is_active"]:
            raise HTTPException(status_code=409, detail={"code": "SITE_NAME_TAKEN"})
        if same:
            # 예전에 닫은 같은 이름의 사업장은 다시 연다 (층을 같은 이름으로 다시 만들 때와 같다). 맨 뒤에 둔다
            site = conn.execute(
                """
                UPDATE sites SET kind = %s, name = %s, address = %s, is_active = true, updated_at = now(),
                       sort_order = (SELECT coalesce(max(sort_order), 0) + 1 FROM sites)
                WHERE id = %s
                RETURNING id, kind, name, address
                """,
                (body.kind, body.name, body.address, same["id"]),
            ).fetchone()
            _audit(conn, admin, request, "SITE_REOPEN", "site", site["id"], after=site)
            return {"site": site, "reopened": True}
        try:
            site = conn.execute(
                """
                INSERT INTO sites (kind, name, address, sort_order)
                VALUES (%s, %s, %s, (SELECT coalesce(max(sort_order), 0) + 1 FROM sites))
                RETURNING id, kind, name, address
                """,
                (body.kind, body.name, body.address),
            ).fetchone()
        except UniqueViolation:
            raise HTTPException(status_code=409, detail={"code": "SITE_NAME_TAKEN"}) from None
        _audit(conn, admin, request, "SITE_CREATE", "site", site["id"], after=site)
    return {"site": site}


@router.put("/sites/{site_id}")
def update_site(site_id: int, body: SiteIn, admin: CurrentAdmin, request: Request) -> dict[str, Any]:
    _require_company(admin)
    with pool.connection() as conn:
        before = _site_row(conn, site_id)
        same = conn.execute(
            "SELECT id, is_active FROM sites WHERE lower(name) = lower(%s) AND id <> %s FOR UPDATE",
            (body.name, site_id),
        ).fetchone()
        if same and same["is_active"]:
            raise HTTPException(status_code=409, detail={"code": "SITE_NAME_TAKEN"})
        if same:
            _free_name(conn, "sites", same["id"], body.name, 100)
        try:
            site = conn.execute(
                """
                UPDATE sites SET kind = %s, name = %s, address = %s, updated_at = now() WHERE id = %s
                RETURNING id, kind, name, address
                """,
                (body.kind, body.name, body.address, site_id),
            ).fetchone()
        except UniqueViolation:
            raise HTTPException(status_code=409, detail={"code": "SITE_NAME_TAKEN"}) from None
        _audit(conn, admin, request, "SITE_UPDATE", "site", site_id, before=before, after=site)
    return {"site": site}


@router.delete("/sites/{site_id}", status_code=204)
def close_site(site_id: int, admin: CurrentAdmin, request: Request) -> None:
    """사업장 닫기: 층이 남아 있으면 먼저 층을 없애야 한다"""
    _require_company(admin)
    with pool.connection() as conn:
        site = _site_row(conn, site_id)
        floors = conn.execute(
            "SELECT name FROM floors WHERE site_id = %s AND is_active ORDER BY sort_order DESC", (site_id,)
        ).fetchall()
        if floors:
            raise HTTPException(
                status_code=409, detail={"code": "SITE_HAS_FLOORS", "floors": [f["name"] for f in floors]}
            )
        conn.execute("UPDATE sites SET is_active = false, updated_at = now() WHERE id = %s", (site_id,))
        conn.execute(
            "UPDATE admin_grants SET revoked_at = now(), revoked_by = %s WHERE site_id = %s AND revoked_at IS NULL",
            (admin["employee_id"], site_id),
        )
        _audit(conn, admin, request, "SITE_CLOSE", "site", site_id, before=site)


# 층 ----------------------------------------------------------------------------------------------


class FloorIn(BaseModel):
    name: str = Field(min_length=1, max_length=20)
    description: str | None = Field(default=None, max_length=50)  # 사무실이 아닌 층의 용도 (로비, 대강당 등)
    # 놓을 자리: 이 층 바로 아래 (없으면 맨 위). 고칠 때 move가 거짓이면 자리는 그대로
    under_floor_id: int | None = None
    move: bool = True

    @field_validator("name")
    @classmethod
    def check_name(cls, v: str) -> str:
        v = v.strip().upper() if re.fullmatch(r"[0-9a-zA-Z]+", v.strip()) else v.strip()
        if not FLOOR_NAME_RE.match(v):
            raise ValueError("층 이름은 20자 안의 글자·숫자로 (예: 11F, B1)")
        return v

    @field_validator("description")
    @classmethod
    def strip_description(cls, v: str | None) -> str | None:
        return _clean(v)


def _place_floor(conn: Connection, site_id: int, floor_id: int, under: int | None) -> None:
    """층 순서를 다시 매긴다: 위층이 큰 sort_order. under 바로 아래(없으면 맨 위)에 floor_id를 둔다"""
    rows = conn.execute(
        "SELECT id FROM floors WHERE site_id = %s AND is_active AND id <> %s ORDER BY sort_order DESC, id",
        (site_id, floor_id),
    ).fetchall()
    order = [r["id"] for r in rows]
    if under is not None and under not in order:
        raise HTTPException(status_code=422, detail={"code": "BAD_POSITION"})
    at = 0 if under is None else order.index(under) + 1
    order.insert(at, floor_id)
    with conn.cursor() as cur:
        cur.executemany(
            "UPDATE floors SET sort_order = %s WHERE id = %s", [(len(order) - i, fid) for i, fid in enumerate(order)]
        )


@router.post("/sites/{site_id}/floors", status_code=201)
def create_floor(site_id: int, body: FloorIn, admin: CurrentAdmin, request: Request) -> dict[str, Any]:
    if not _can_site(admin, site_id):
        raise HTTPException(status_code=403, detail={"code": "NOT_IN_SCOPE"})
    with pool.connection() as conn:
        _site_row(conn, site_id)
        if conn.execute(
            "SELECT 1 FROM floors WHERE site_id = %s AND lower(name) = lower(%s) AND is_active", (site_id, body.name)
        ).fetchone():
            raise HTTPException(status_code=409, detail={"code": "FLOOR_NAME_TAKEN"})
        # 예전에 없앤 같은 이름의 층이 있으면 다시 살린다 (UNIQUE (site_id, name))
        floor = conn.execute(
            """
            INSERT INTO floors (site_id, name, description, sort_order) VALUES (%s, %s, %s, 0)
            ON CONFLICT (site_id, name) DO UPDATE
            SET description = EXCLUDED.description, is_active = true, updated_at = now()
            RETURNING id, name, description
            """,
            (site_id, body.name, body.description),
        ).fetchone()
        _place_floor(conn, site_id, floor["id"], body.under_floor_id)
        _audit(conn, admin, request, "FLOOR_CREATE", "floor", floor["id"], after={**floor, "site_id": site_id})
    return {"floor": floor}


def _floor_row(conn: Connection, floor_id: int) -> dict[str, Any]:
    floor = conn.execute(
        "SELECT id, site_id, name, description, sort_order, is_active FROM floors WHERE id = %s FOR UPDATE",
        (floor_id,),
    ).fetchone()
    if floor is None or not floor["is_active"]:
        raise HTTPException(status_code=404, detail={"code": "FLOOR_NOT_FOUND"})
    return floor


@router.put("/floors/{floor_id}")
def update_floor(floor_id: int, body: FloorIn, admin: CurrentAdmin, request: Request) -> dict[str, Any]:
    with pool.connection() as conn:
        before = _floor_row(conn, floor_id)
        if not _can_site(admin, before["site_id"]):
            raise HTTPException(status_code=403, detail={"code": "NOT_IN_SCOPE"})
        same = conn.execute(
            "SELECT id, is_active FROM floors WHERE site_id = %s AND lower(name) = lower(%s) AND id <> %s",
            (before["site_id"], body.name, floor_id),
        ).fetchone()
        if same and same["is_active"]:
            raise HTTPException(status_code=409, detail={"code": "FLOOR_NAME_TAKEN"})
        if same:
            # 없앤 층이 쥐고 있던 이름이면 풀어 주고 그 이름을 쓴다
            _free_name(conn, "floors", same["id"], body.name, 20)
        floor = conn.execute(
            """
            UPDATE floors SET name = %s, description = %s, updated_at = now() WHERE id = %s
            RETURNING id, name, description
            """,
            (body.name, body.description, floor_id),
        ).fetchone()
        if body.move:
            if body.under_floor_id == floor_id:
                raise HTTPException(status_code=422, detail={"code": "BAD_POSITION"})
            _place_floor(conn, before["site_id"], floor_id, body.under_floor_id)
        _audit(conn, admin, request, "FLOOR_UPDATE", "floor", floor_id, before=before, after=floor)
    return {"floor": floor}


@router.delete("/floors/{floor_id}", status_code=204)
def close_floor(floor_id: int, admin: CurrentAdmin, request: Request) -> None:
    """층 없애기: 좌석·회의실이 남아 있으면 막는다 (도면에서 지우고 게시한 뒤). 빈 구역·초안·이 층 권한은 함께 정리"""
    with pool.connection() as conn:
        floor = _floor_row(conn, floor_id)
        if not _can_site(admin, floor["site_id"]):
            raise HTTPException(status_code=403, detail={"code": "NOT_IN_SCOPE"})
        use = conn.execute(
            """
            SELECT (SELECT count(*) FROM seats WHERE floor_id = %(f)s AND status <> 'REMOVED')::int AS seats,
                   (SELECT count(*) FROM meeting_rooms WHERE floor_id = %(f)s AND is_active)::int AS rooms
            """,
            {"f": floor_id},
        ).fetchone()
        if use["seats"] or use["rooms"]:
            raise HTTPException(status_code=409, detail={"code": "FLOOR_IN_USE", **use})
        conn.execute("UPDATE floors SET is_active = false, updated_at = now() WHERE id = %s", (floor_id,))
        conn.execute("UPDATE zones SET is_active = false, updated_at = now() WHERE floor_id = %s", (floor_id,))
        conn.execute("DELETE FROM floor_plans WHERE floor_id = %s AND status IN ('DRAFT', 'SCHEDULED')", (floor_id,))
        conn.execute(
            """
            UPDATE admin_grants SET revoked_at = now(), revoked_by = %s
            WHERE revoked_at IS NULL
              AND (floor_id = %s OR zone_id IN (SELECT id FROM zones WHERE floor_id = %s))
            """,
            (admin["employee_id"], floor_id, floor_id),
        )
        _audit(conn, admin, request, "FLOOR_CLOSE", "floor", floor_id, before=floor)


# 조직도 ------------------------------------------------------------------------------------------


@router.get("/org")
def org_tree(admin: CurrentAdmin, inactive: bool = False) -> dict[str, Any]:
    """부서 목록 (위 부서·인원·이 부서 구역). 화면이 나무 모양으로 그린다"""
    with pool.connection() as conn:
        rows = conn.execute(
            """
            SELECT d.id, d.dept_code AS code, d.name, d.parent_id, d.sort_order, d.is_active,
                   (SELECT count(*) FROM employees e WHERE e.department_id = d.id
                      AND e.employment_status <> 'RETIRED')::int AS members,
                   coalesce((
                       SELECT jsonb_agg(jsonb_build_object('floor', f.name, 'code', z.code) ORDER BY f.sort_order DESC)
                       FROM zones z JOIN floors f ON f.id = z.floor_id
                       WHERE z.department_id = d.id AND z.is_active AND f.is_active
                   ), '[]'::jsonb) AS zones
            FROM departments d
            WHERE d.is_active OR %s
            ORDER BY d.sort_order, d.name
            """,
            (inactive,),
        ).fetchall()
    return {"departments": rows, "can_edit": _is_company(admin)}


def _dept(conn: Connection, dept_id: int, *, active: bool = True) -> dict[str, Any]:
    dept = conn.execute(
        """
        SELECT id, dept_code AS code, name, parent_id, sort_order, is_active
        FROM departments WHERE id = %s FOR UPDATE
        """,
        (dept_id,),
    ).fetchone()
    if dept is None or (active and not dept["is_active"]):
        raise HTTPException(status_code=404, detail={"code": "DEPARTMENT_NOT_FOUND"})
    return dept


@router.get("/org/departments/{dept_id}/members")
def members(dept_id: int, admin: CurrentAdmin) -> dict[str, Any]:
    """부서 사람 (재직·휴직). 지금 자리와 관리자 여부"""
    with pool.connection() as conn:
        dept = _dept(conn, dept_id, active=False)
        rows = conn.execute(
            f"""
            SELECT e.emp_no, e.name, e.rank_name AS rank, e.position_name AS position, e.email, e.extension,
                   e.employment_status AS status, e.hired_on,
                   s.code AS seat_code, f.name AS floor_name, si.name AS site_name,
                   EXISTS (SELECT 1 FROM admin_grants g WHERE g.employee_id = e.id AND g.revoked_at IS NULL)
                       AS is_admin,
                   a.must_change_password AS temporary_password
            FROM employees e
            LEFT JOIN user_accounts a ON a.employee_id = e.id
            LEFT JOIN LATERAL (
                SELECT sa.seat_id FROM seat_assignments sa
                WHERE sa.employee_id = e.id AND sa.kind = 'FIXED' AND sa.starts_at <= now()
                  AND (sa.ends_at IS NULL OR sa.ends_at > now())
                LIMIT 1
            ) cur ON true
            LEFT JOIN seats s ON s.id = cur.seat_id
            LEFT JOIN floors f ON f.id = s.floor_id
            LEFT JOIN sites si ON si.id = f.site_id
            WHERE e.department_id = %s AND e.employment_status <> 'RETIRED'
            ORDER BY {person_order()}
            """,
            (dept_id,),
        ).fetchall()
    return {"department": dept, "members": rows, "can_edit": _is_company(admin)}


class DeptIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    parent_id: int | None = None
    code: str | None = Field(default=None, max_length=20)

    @field_validator("name")
    @classmethod
    def strip_name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("이름을 넣어 주세요")
        return v


def _check_dept_name(conn: Connection, name: str, dept_id: int | None = None) -> None:
    """살아 있는 부서끼리 이름이 같으면 막는다 (대소문자·앞뒤 공백 무시).
    구역·팀 이사 화면이 부서를 이름으로만 보여 주므로 같은 이름이 둘이면 고를 수 없다"""
    same = conn.execute(
        """
        SELECT d.name, p.name AS parent FROM departments d LEFT JOIN departments p ON p.id = d.parent_id
        WHERE d.is_active AND lower(d.name) = lower(%s) AND d.id IS DISTINCT FROM %s
        LIMIT 1
        """,
        (name, dept_id),
    ).fetchone()
    if same:
        raise HTTPException(status_code=409, detail={"code": "DEPT_NAME_TAKEN", "parent": same["parent"]})


def _descendants(conn: Connection, dept_id: int) -> set[int]:
    rows = conn.execute(
        """
        WITH RECURSIVE sub AS (
            SELECT id FROM departments WHERE id = %s
            UNION ALL SELECT d.id FROM departments d JOIN sub ON d.parent_id = sub.id
        ) SELECT id FROM sub
        """,
        (dept_id,),
    ).fetchall()
    return {r["id"] for r in rows}


@router.post("/org/departments", status_code=201)
def create_department(body: DeptIn, admin: CurrentAdmin, request: Request) -> dict[str, Any]:
    _require_company(admin)
    with pool.connection() as conn:
        if body.parent_id is not None:
            _dept(conn, body.parent_id)
        _check_dept_name(conn, body.name)
        code = (
            _clean(body.code)
            or conn.execute(
                # 인사 부서코드가 없으면 만들어 둔다 (나중에 조직도 동기화 때 맞춘다)
                """
                SELECT 'NEW' || lpad((count(*) + 1)::text, 3, '0') AS code
                FROM departments WHERE dept_code LIKE 'NEW%%'
                """
            ).fetchone()["code"]
        )
        try:
            dept = conn.execute(
                """
                INSERT INTO departments (dept_code, name, parent_id, sort_order)
                VALUES (%s, %s, %s, (SELECT coalesce(max(sort_order), 0) + 1 FROM departments
                                     WHERE parent_id IS NOT DISTINCT FROM %s))
                RETURNING id, dept_code AS code, name, parent_id, sort_order, is_active
                """,
                (code, body.name, body.parent_id, body.parent_id),
            ).fetchone()
        except UniqueViolation:
            raise HTTPException(status_code=409, detail={"code": "DEPT_CODE_TAKEN"}) from None
        _audit(conn, admin, request, "DEPT_CREATE", "department", dept["id"], after=dept)
    return {"department": dept}


@router.put("/org/departments/{dept_id}")
def update_department(dept_id: int, body: DeptIn, admin: CurrentAdmin, request: Request) -> dict[str, Any]:
    """이름·위 부서 바꾸기. 이름이 바뀌면 이 부서 구역 이름도 따라간다 (트리거)"""
    _require_company(admin)
    with pool.connection() as conn:
        before = _dept(conn, dept_id)
        if body.parent_id is not None:
            _dept(conn, body.parent_id)
            if body.parent_id in _descendants(conn, dept_id):
                raise HTTPException(status_code=422, detail={"code": "PARENT_CYCLE"})
        _check_dept_name(conn, body.name, dept_id)
        code = _clean(body.code) or before["code"]
        try:
            dept = conn.execute(
                """
                UPDATE departments SET name = %s, parent_id = %s, dept_code = %s, updated_at = now() WHERE id = %s
                RETURNING id, dept_code AS code, name, parent_id, sort_order, is_active
                """,
                (body.name, body.parent_id, code, dept_id),
            ).fetchone()
        except UniqueViolation:
            raise HTTPException(status_code=409, detail={"code": "DEPT_CODE_TAKEN"}) from None
        _audit(conn, admin, request, "DEPT_UPDATE", "department", dept_id, before=before, after=dept)
    return {"department": dept}


@router.delete("/org/departments/{dept_id}", status_code=204)
def close_department(dept_id: int, admin: CurrentAdmin, request: Request) -> None:
    """부서 없애기: 사람·아래 부서가 남아 있으면 막는다. 이 부서 구역은 남고 배치 화면에 "폐지된 부서"로 뜬다"""
    _require_company(admin)
    with pool.connection() as conn:
        dept = _dept(conn, dept_id)
        left = conn.execute(
            """
            SELECT (SELECT count(*) FROM employees WHERE department_id = %(d)s
                      AND employment_status <> 'RETIRED')::int AS members,
                   (SELECT count(*) FROM departments WHERE parent_id = %(d)s AND is_active)::int AS children
            """,
            {"d": dept_id},
        ).fetchone()
        if left["members"] or left["children"]:
            raise HTTPException(status_code=409, detail={"code": "DEPT_NOT_EMPTY", **left})
        conn.execute("UPDATE departments SET is_active = false, updated_at = now() WHERE id = %s", (dept_id,))
        _audit(conn, admin, request, "DEPT_CLOSE", "department", dept_id, before=dept)


class MoveIn(BaseModel):
    emp_nos: list[str] = Field(min_length=1, max_length=200)


def _seated(conn: Connection, employee_ids: list[int]) -> dict[int, str]:
    """지금(또는 날짜를 정해 둔) 고정석 배정이 있는 사람: id → 이름"""
    rows = conn.execute(
        """
        SELECT DISTINCT e.id, e.name FROM seat_assignments a JOIN employees e ON e.id = a.employee_id
        WHERE a.employee_id = ANY(%s) AND a.kind = 'FIXED' AND (a.ends_at IS NULL OR a.ends_at > now())
        """,
        (employee_ids,),
    ).fetchall()
    return {r["id"]: r["name"] for r in rows}


@router.post("/org/departments/{dept_id}/members")
def move_members(dept_id: int, body: MoveIn, admin: CurrentAdmin, request: Request) -> dict[str, Any]:
    """팀원 데려오기: 다른 부서 사람을 이 부서로. 고정석 배정은 끝나고 이 팀의 미배치 인원이 된다"""
    _require_company(admin)
    with pool.connection() as conn:
        dept = _dept(conn, dept_id)
        people = conn.execute(
            """
            SELECT e.id, e.emp_no, e.name, e.department_id, d.name AS department FROM employees e
            JOIN departments d ON d.id = e.department_id
            WHERE e.emp_no = ANY(%s) AND e.employment_status <> 'RETIRED' FOR UPDATE OF e
            """,
            (body.emp_nos,),
        ).fetchall()
        if len(people) != len(set(body.emp_nos)):
            raise HTTPException(status_code=404, detail={"code": "EMPLOYEE_NOT_FOUND"})
        moving = [p for p in people if p["department_id"] != dept["id"]]
        seated = _seated(conn, [p["id"] for p in moving])
        conn.execute(
            "UPDATE employees SET department_id = %s, updated_at = now() WHERE id = ANY(%s)",
            (dept_id, [p["id"] for p in moving]),
        )
        still = _seated(conn, list(seated))
        released = [name for pid, name in seated.items() if pid not in still]
        _audit(
            conn,
            admin,
            request,
            "DEPT_MEMBERS_MOVE",
            "department",
            dept_id,
            after={"people": [{"emp_no": p["emp_no"], "from": p["department"]} for p in moving]},
        )
    return {"moved": len(moving), "released": released}


class EmployeeIn(BaseModel):
    emp_no: str
    name: str = Field(min_length=1, max_length=50)
    department_id: int
    rank: str | None = Field(default=None, max_length=30)
    position: str | None = Field(default=None, max_length=30)
    email: str | None = Field(default=None, max_length=100)
    extension: str | None = Field(default=None, max_length=20)
    hired_on: str | None = None

    @field_validator("emp_no")
    @classmethod
    def check_emp_no(cls, v: str) -> str:
        v = v.strip()
        if not EMP_NO_RE.match(v):
            raise ValueError("사번은 영문·숫자 4~20자")
        return v

    @field_validator("name")
    @classmethod
    def strip_name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("이름을 넣어 주세요")
        return v

    @field_validator("rank", "position", "extension", "hired_on")
    @classmethod
    def strip_optional(cls, v: str | None) -> str | None:
        return _clean(v)

    @field_validator("email")
    @classmethod
    def check_email(cls, v: str | None) -> str | None:
        return _check_email(v)


def _temp_password() -> str:
    """임시 비밀번호 (첫 로그인 때 바꾸게 한다). 헷갈리는 글자(0/O, 1/l)는 빼고 10자"""
    letters = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789"
    while True:
        pw = "".join(secrets.choice(letters) for _ in range(10))
        if any(c.isdigit() for c in pw) and any(c.isalpha() for c in pw):
            return pw


@router.post("/org/employees", status_code=201)
def create_employee(body: EmployeeIn, admin: CurrentAdmin, request: Request) -> dict[str, Any]:
    """새 직원 등록 (신규 입사 등): 직원 화면 계정을 임시 비밀번호로 만든다. 임시 비밀번호는 이 응답에서만 보여 준다"""
    _require_company(admin)
    password = _temp_password()
    with pool.connection() as conn:
        _dept(conn, body.department_id)
        try:
            emp = conn.execute(
                """
                INSERT INTO employees
                    (emp_no, name, department_id, rank_name, position_name, email, extension, hired_on)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s::date)
                RETURNING id, emp_no, name
                """,
                (
                    body.emp_no,
                    body.name,
                    body.department_id,
                    body.rank,
                    body.position,
                    body.email,
                    body.extension,
                    body.hired_on,
                ),
            ).fetchone()
        except UniqueViolation:
            raise HTTPException(status_code=409, detail={"code": "EMP_NO_TAKEN"}) from None
        conn.execute(
            "INSERT INTO user_accounts (employee_id, password_hash, must_change_password) VALUES (%s, %s, true)",
            (emp["id"], hash_password(password)),
        )
        _audit(
            conn,
            admin,
            request,
            "EMPLOYEE_CREATE",
            "employee",
            emp["id"],
            after={**body.model_dump(), "account": "TEMPORARY_PASSWORD"},
        )
    return {"employee": {"emp_no": emp["emp_no"], "name": emp["name"]}, "temporary_password": password}


class EmployeeUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=50)
    department_id: int | None = None
    rank: str | None = Field(default=None, max_length=30)
    position: str | None = Field(default=None, max_length=30)
    email: str | None = Field(default=None, max_length=100)
    extension: str | None = Field(default=None, max_length=20)
    status: Literal["ACTIVE", "LEAVE", "RETIRED"] | None = None

    @field_validator("email")
    @classmethod
    def check_email(cls, v: str | None) -> str | None:
        return _check_email(v)


@router.put("/org/employees/{emp_no}")
def update_employee(emp_no: str, body: EmployeeUpdate, admin: CurrentAdmin, request: Request) -> dict[str, Any]:
    """인사 정보 고치기·부서 옮기기·휴직·퇴사. 보낸 칸만 바꾼다.
    부서를 옮기거나 퇴사하면 고정석 배정이 끝난다(트리거). 퇴사하면 관리자 권한도 회수하고 로그인도 끝난다"""
    _require_company(admin)
    fields = body.model_dump(exclude_unset=True)
    columns = {
        "name": "name",
        "department_id": "department_id",
        "rank": "rank_name",
        "position": "position_name",
        "email": "email",
        "extension": "extension",
        "status": "employment_status",
    }
    with pool.connection() as conn:
        before = conn.execute(
            """
            SELECT id, emp_no, name, department_id, rank_name, position_name, email, extension, employment_status
            FROM employees WHERE emp_no = %s FOR UPDATE
            """,
            (emp_no,),
        ).fetchone()
        if before is None or before["employment_status"] in ("RETIRED", "SYSTEM"):
            raise HTTPException(status_code=404, detail={"code": "EMPLOYEE_NOT_FOUND"})
        if before["id"] == admin["employee_id"] and fields.get("status") == "RETIRED":
            raise HTTPException(status_code=422, detail={"code": "CANNOT_RETIRE_SELF"})
        if "department_id" in fields:
            if fields["department_id"] is None:
                raise HTTPException(status_code=422, detail={"code": "DEPARTMENT_REQUIRED"})
            _dept(conn, fields["department_id"])
        values = {k: (v.strip() or None) if isinstance(v, str) and k != "status" else v for k, v in fields.items()}
        if "name" in values and not values["name"]:
            raise HTTPException(status_code=422, detail={"code": "NAME_REQUIRED"})
        seated = _seated(conn, [before["id"]])
        if values:
            sets = ", ".join(f"{columns[k]} = %({k})s" for k in values)
            conn.execute(
                f"UPDATE employees SET {sets}, updated_at = now() WHERE id = %(id)s", {**values, "id": before["id"]}
            )
        released = [name for pid, name in seated.items() if pid not in _seated(conn, [pid])]
        if values.get("status") == "RETIRED":
            conn.execute(
                """
                UPDATE admin_grants SET revoked_at = now(), revoked_by = %s
                WHERE employee_id = %s AND revoked_at IS NULL
                """,
                (admin["employee_id"], before["id"]),
            )
            conn.execute(
                "UPDATE user_sessions SET revoked_at = now() WHERE employee_id = %s AND revoked_at IS NULL",
                (before["id"],),
            )
        _audit(conn, admin, request, "EMPLOYEE_UPDATE", "employee", before["id"], before=before, after=values)
    return {"emp_no": emp_no, "released": released}


@router.post("/org/employees/{emp_no}/reset-password")
def reset_password(emp_no: str, admin: CurrentAdmin, request: Request) -> dict[str, Any]:
    """직원 화면 비밀번호를 임시 비밀번호로 (잠금도 푼다). 임시 비밀번호는 이 응답에서만 보여 준다"""
    _require_company(admin)
    password = _temp_password()
    with pool.connection() as conn:
        emp = conn.execute(
            "SELECT id FROM employees WHERE emp_no = %s AND employment_status NOT IN ('RETIRED', 'SYSTEM')",
            (emp_no,),
        ).fetchone()
        if emp is None:
            raise HTTPException(status_code=404, detail={"code": "EMPLOYEE_NOT_FOUND"})
        conn.execute(
            """
            INSERT INTO user_accounts (employee_id, password_hash, must_change_password) VALUES (%(id)s, %(h)s, true)
            ON CONFLICT (employee_id) DO UPDATE
            SET password_hash = %(h)s, must_change_password = true, failed_login_count = 0, locked_at = NULL
            """,
            {"id": emp["id"], "h": hash_password(password)},
        )
        conn.execute(
            """
            UPDATE user_sessions SET revoked_at = now(), revoked_reason = 'PASSWORD_RESET'
            WHERE employee_id = %s AND kind = 'USER' AND revoked_at IS NULL
            """,
            (emp["id"],),
        )
        _audit(conn, admin, request, "PASSWORD_RESET", "employee", emp["id"])
    return {"temporary_password": password}


@router.get("/org/people")
def search_people(admin: CurrentAdmin, q: str = Query(min_length=1, max_length=50)) -> dict[str, Any]:
    """팀원 데려오기에서 찾는 사람: 이름·사번 (재직·휴직). 지금 부서를 같이 준다"""
    like = "%" + q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
    with pool.connection() as conn:
        rows = conn.execute(
            """
            SELECT e.emp_no, e.name, e.rank_name AS rank, e.employment_status AS status,
                   d.id AS department_id, d.name AS department
            FROM employees e JOIN departments d ON d.id = e.department_id
            WHERE e.employment_status <> 'RETIRED' AND (e.name ILIKE %(q)s OR e.emp_no ILIKE %(q)s)
            ORDER BY e.name = %(exact)s DESC, e.name, e.emp_no
            LIMIT 30
            """,
            {"q": like, "exact": q.strip()},
        ).fetchall()
    return {"people": rows}
