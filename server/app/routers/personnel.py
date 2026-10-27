"""인사이동 API (최종·전사 관리자): 발령 엑셀 한 장으로 여러 사람의 소속(과 직급·직책)을 한 번에 바꾸고,
새 부서 구역의 빈 고정석에 자동으로 앉힌다. 날짜를 정하면 그날 0시(서울)에 서버 작업(app/jobs.py)이 반영한다.

엑셀은 화면에서 읽어 한 줄씩 보낸다 (frontend/src/lib/personnelFile.ts). 서버는 줄마다 확인한다:
없는 사번·퇴사자·이름이 다름·조직도에 없는 부서는 빼고, 지금 부서가 엑셀과 다르면 알려 주고 그대로 옮긴다.

반영 (한 트랜잭션):
1) 소속·직급·직책을 바꾼다. 부서가 바뀌면 원래 고정석은 DB 트리거(release_seat_on_org_change)가 비운다
2) 자동 배치면 새 부서 구역의 빈 고정석에 엑셀 순서대로 앉힌다 (원래 자리가 이미 새 부서 구역이면 그 자리 그대로).
   층마다 좌석 배치 묶음(change_requests, 반영됨)을 만들어 _apply로 반영한다 → 좌석 배치 화면의 요청 목록과
   자리 알림이 그대로 쓰인다. 자리가 모자라거나, 새 부서에 팀 구역이 없거나, 휴직 중이면 미배치로 두고 이유를 남긴다
미리 보기는 같은 반영을 트랜잭션 안에서 해 보고 되돌린다 (보여 준 결과가 지금 반영했을 때와 같다).
"""

import datetime as dt
import logging
import re
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Request
from psycopg import Connection, Rollback
from pydantic import BaseModel, Field

from app.admin_auth import CurrentAdmin, grants_of, is_company_wide
from app.db import pool
from app.routers.auth import client_info
from app.routers.seating import LOCK_SEATING, _apply, _effective_at, _json

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/admin/personnel", tags=["personnel"])

MAX_ROWS = 2000
SeatMode = Literal["AUTO", "UNASSIGN"]
# 반영하면 이 사람에게 할 일이 있는 줄 (SAME: 바뀌는 것이 없음, ERROR: 뺌)
TODO = ("OK", "WARN")
FLOOR_ACCESS = {"mode": "FLOOR", "apply": "IMMEDIATE", "zones": None}  # 최종·전사 관리자는 모든 층의 층 관리자 이상


class RowIn(BaseModel):
    line: int = Field(ge=1)  # 엑셀 행 번호 (알림에 쓴다)
    emp_no: str = Field(max_length=40)
    name: str | None = Field(default=None, max_length=100)
    from_department: str | None = Field(default=None, max_length=100)
    to_department: str | None = Field(default=None, max_length=100)
    rank: str | None = Field(default=None, max_length=30)
    position: str | None = Field(default=None, max_length=30)


class PreviewIn(BaseModel):
    rows: list[RowIn] = Field(min_length=1, max_length=MAX_ROWS)
    seat_mode: SeatMode = "AUTO"


class CreateIn(PreviewIn):
    title: str = Field(min_length=1, max_length=100)
    effective_date: dt.date | None = None  # 이날 0시(서울)부터. 없으면 바로


def _require_company(admin: dict[str, Any]) -> None:
    if not is_company_wide(admin["grants"]):
        raise HTTPException(status_code=403, detail={"code": "COMPANY_ONLY"})


def _key(value: str | None) -> str:
    """이름·부서를 견줄 때: 빈칸을 모두 빼고 소문자로 ("재무 팀" = "재무팀")"""
    return re.sub(r"\s+", "", value or "").lower()


def _clean(value: str | None) -> str | None:
    value = (value or "").strip()
    return value or None


# 확인 -------------------------------------------------------------------------


def _check(conn: Connection, rows: list[RowIn]) -> list[dict[str, Any]]:
    """엑셀 줄마다 누구를 어느 부서로(직급·직책) 옮기나.
    status: OK / WARN(알릴 것이 있지만 옮김) / SAME(바뀌는 것 없음) / ERROR(빼고 반영)"""
    depts: dict[str, dict[str, Any]] = {}
    for d in conn.execute("SELECT id, name, dept_code, is_active FROM departments ORDER BY is_active, id").fetchall():
        # 살아 있는 부서가 나중에 들어가 같은 이름의 없어진 부서를 덮는다
        depts[_key(d["name"])] = d
        depts.setdefault(_key(d["dept_code"]), d)
    emp_nos = list({r.emp_no.strip() for r in rows})
    people = {
        e["emp_no"]: e
        for e in conn.execute(
            """
            SELECT e.id, e.emp_no, e.name, e.rank_name, e.position_name, e.employment_status, e.department_id,
                   d.name AS department, d.dept_code
            FROM employees e LEFT JOIN departments d ON d.id = e.department_id
            WHERE e.emp_no = ANY(%s) AND e.employment_status <> 'SYSTEM'
            """,
            (emp_nos,),
        ).fetchall()
    }
    zone_grants: dict[int, list[str]] = {}
    for g in grants_of(conn):
        if g["role"] == "ZONE_ADMIN":
            zone_grants.setdefault(g["employee_id"], []).append(g["scope"])

    seen: dict[str, int] = {}
    out = []
    for r in rows:
        emp_no = r.emp_no.strip()
        p = people.get(emp_no)
        row: dict[str, Any] = {
            "line": r.line,
            "emp_no": emp_no,
            "excel_name": _clean(r.name),
            "name": p["name"] if p else None,
            "employee_id": p["id"] if p else None,
            "from_department": p["department"] if p else _clean(r.from_department),
            "from_department_id": p["department_id"] if p else None,
            "to_department": _clean(r.to_department),
            "to_department_id": None,
            "rank": None,
            "position": None,
            "status": "OK",
            "messages": [],
        }
        out.append(row)
        errors: list[str] = []
        warns: list[str] = []
        if not emp_no:
            errors.append("사번이 비어 있어요")
        elif emp_no in seen:
            errors.append(f"같은 사번이 {seen[emp_no]}행에도 있어요")
        elif p is None:
            errors.append("조직도에 없는 사번이에요")
        elif p["employment_status"] == "RETIRED":
            errors.append("퇴사한 사람이에요")
        elif row["excel_name"] and _key(row["excel_name"]) != _key(p["name"]):
            errors.append(f"사번 {emp_no}은 {p['name']} 님인데 엑셀에는 {row['excel_name']}(으)로 적혀 있어요")
        seen.setdefault(emp_no, r.line)

        to = _clean(r.to_department)
        dept = depts.get(_key(to)) if to else None
        if to and dept is None:
            errors.append(f"조직도에 없는 부서예요: {to}")
        elif dept is not None and not dept["is_active"]:
            errors.append(f"없어진 부서예요: {dept['name']}")
        elif dept is not None:
            row["to_department"] = dept["name"]
            row["to_department_id"] = dept["id"]

        if p is not None:
            frm = _clean(r.from_department)
            if frm and _key(frm) not in (_key(p["department"]), _key(p["dept_code"])):
                warns.append(f"지금 부서는 {p['department']}이에요 (엑셀: {frm})")
            rank, position = _clean(r.rank), _clean(r.position)
            if rank and rank != p["rank_name"]:
                row["rank"] = {"from": p["rank_name"], "to": rank}
            if position and position != p["position_name"]:
                row["position"] = {"from": p["position_name"], "to": position}
            if dept is not None and dept["id"] == p["department_id"]:
                row["to_department_id"] = None  # 부서는 그대로
                row["to_department"] = None
            moving = row["to_department_id"] is not None
            if not to and not row["rank"] and not row["position"] and not errors:
                errors.append("새 부서가 비어 있어요")
            if moving and p["employment_status"] == "LEAVE":
                warns.append("휴직 중이라 소속만 바꾸고 자리는 정하지 않아요")
            if moving and zone_grants.get(p["id"]):
                warns.append(f"관리자 권한이 있어요 ({' / '.join(zone_grants[p['id']])}). 새 부서에 맞는지 확인하세요")
            if not errors and not moving and not row["rank"] and not row["position"]:
                row["status"] = "SAME"
                row["messages"] = [f"이미 {p['department']} 소속이에요"]
                continue
        if errors:
            row["status"] = "ERROR"
            row["messages"] = errors
        elif warns:
            row["status"] = "WARN"
            row["messages"] = warns
    return out


# 반영 -------------------------------------------------------------------------


def _natural(code: str) -> tuple[Any, ...]:
    """좌석 번호를 사람이 읽는 순서로 (B-2 < B-10)"""
    return tuple(int(part) if part.isdigit() else part for part in re.split(r"(\d+)", code))


def _execute(
    conn: Connection,
    items: list[dict[str, Any]],
    seat_mode: SeatMode,
    actor: int,
    request: Request | None,
    title: str,
) -> tuple[dict[int, dict[str, Any]], int | None]:
    """소속을 바꾸고 자리를 정한다 (호출한 쪽의 트랜잭션 안에서). items: employee_id, to_department_id(None = 그대로),
    rank·position(None = 그대로). 돌려주는 것: 사람마다 결과 {status APPLIED|SKIPPED, seat_id, seat_label, note},
    자동 배치로 만든 좌석 배치 묶음 번호"""
    ids = [i["employee_id"] for i in items]
    people = {
        e["id"]: e
        for e in conn.execute(
            """
            SELECT e.id, e.emp_no, e.name, e.employment_status, e.department_id, e.rank_name, e.position_name,
                   cur.seat_id, cur.floor_id AS seat_floor_id
            FROM employees e
            LEFT JOIN LATERAL (
                SELECT a.seat_id, s.floor_id FROM seat_assignments a JOIN seats s ON s.id = a.seat_id
                WHERE a.employee_id = e.id AND a.kind = 'FIXED' AND a.starts_at <= now()
                  AND (a.ends_at IS NULL OR a.ends_at > now())
                ORDER BY a.starts_at DESC LIMIT 1
            ) cur ON true
            WHERE e.id = ANY(%s)
            ORDER BY e.id
            FOR UPDATE OF e
            """,
            (ids,),
        ).fetchall()
    }
    targets = {i["to_department_id"] for i in items if i["to_department_id"]}
    alive = {
        d["id"]
        for d in conn.execute(
            "SELECT id FROM departments WHERE id = ANY(%s) AND is_active", (list(targets),)
        ).fetchall()
    }

    results: dict[int, dict[str, Any]] = {}
    todo: list[dict[str, Any]] = []
    for i in items:
        p = people.get(i["employee_id"])
        if p is None or p["employment_status"] in ("RETIRED", "SYSTEM"):
            results[i["employee_id"]] = {"status": "SKIPPED", "note": "퇴사했거나 조직도에 없는 사람이에요"}
            continue
        if i["to_department_id"] and i["to_department_id"] not in alive:
            results[i["employee_id"]] = {"status": "SKIPPED", "note": "새 부서가 없어졌어요"}
            continue
        moving = bool(i["to_department_id"]) and i["to_department_id"] != p["department_id"]
        rank = i["rank"] if i["rank"] and i["rank"] != p["rank_name"] else None
        position = i["position"] if i["position"] and i["position"] != p["position_name"] else None
        if not moving and not rank and not position:
            results[i["employee_id"]] = {"status": "SKIPPED", "note": "바뀌는 것이 없어요 (이미 그 부서)"}
            continue
        todo.append({**i, "person": p, "moving": moving, "rank": rank, "position": position})

    # 층을 잠그는 순서를 정해 두 사람이 동시에 해도 엇갈리지 않게: 옮기는 사람이 앉은 층과 새 부서 구역이 있는 층
    movers = [t for t in todo if t["moving"]]
    floors = {t["person"]["seat_floor_id"] for t in movers if t["person"]["seat_floor_id"]}
    floors |= {
        r["floor_id"]
        for r in conn.execute(
            "SELECT DISTINCT floor_id FROM zones WHERE department_id = ANY(%s) AND is_active",
            ([t["to_department_id"] for t in movers],),
        ).fetchall()
    }
    for floor_id in sorted(floors):
        conn.execute("SELECT pg_advisory_xact_lock(%s, %s)", (LOCK_SEATING, floor_id))

    # 1) 소속·직급·직책 (부서가 바뀌면 트리거가 원래 고정석을 비운다)
    with conn.cursor() as cur:
        cur.executemany(
            """
            UPDATE employees
            SET department_id = coalesce(%s, department_id), rank_name = coalesce(%s, rank_name),
                position_name = coalesce(%s, position_name), updated_at = now()
            WHERE id = %s
            """,
            [
                (t["to_department_id"] if t["moving"] else None, t["rank"], t["position"], t["employee_id"])
                for t in todo
            ],
        )
    for t in todo:
        results[t["employee_id"]] = {"status": "APPLIED", "note": None if t["moving"] else "직급·직책만 바꿨어요"}

    # 2) 자리: 새 부서 구역의 빈 고정석에 엑셀 순서대로
    places: dict[int, dict[str, Any]] = {}
    for dept_id in dict.fromkeys(t["to_department_id"] for t in movers):
        group = [t for t in movers if t["to_department_id"] == dept_id]
        if seat_mode == "UNASSIGN":
            for t in group:
                results[t["employee_id"]]["note"] = "미배치로 두었어요 (좌석 배치 편집에서 정해요)"
            continue
        free = conn.execute(
            """
            SELECT s.id, s.code, s.floor_id, f.name AS floor_name, si.name AS site_name,
                   si.sort_order AS site_order, si.id AS site_id, f.sort_order AS floor_order, z.code AS zone_code
            FROM seats s
            JOIN zones z ON z.id = s.zone_id
            JOIN floors f ON f.id = s.floor_id
            JOIN sites si ON si.id = f.site_id
            WHERE z.department_id = %s AND z.is_active AND f.is_active AND si.is_active
              AND s.status = 'ACTIVE' AND s.seat_type = 'FIXED'
              AND NOT EXISTS (SELECT 1 FROM seat_assignments a
                              WHERE a.seat_id = s.id AND (a.ends_at IS NULL OR a.ends_at > now()))
            """,
            (dept_id,),
        ).fetchall()
        free.sort(key=lambda s: (s["site_order"], s["site_id"], -s["floor_order"], s["zone_code"], _natural(s["code"])))
        by_id = {s["id"]: s for s in free}
        has_zone = conn.execute(
            "SELECT EXISTS (SELECT 1 FROM zones WHERE department_id = %s AND is_active) AS yes", (dept_id,)
        ).fetchone()["yes"]
        seated = [t for t in group if t["person"]["employment_status"] == "ACTIVE"]
        for t in group:
            if t["person"]["employment_status"] != "ACTIVE":
                results[t["employee_id"]]["note"] = "휴직 중이라 자리는 정하지 않았어요"
        # 원래 자리가 이미 새 부서 구역이면 그 자리 그대로 (구역을 미리 새 팀으로 바꿔 둔 경우)
        for t in seated:
            seat = by_id.pop(t["person"]["seat_id"], None) if t["person"]["seat_id"] else None
            if seat:
                places[t["employee_id"]] = seat
        rest = [s for s in free if s["id"] in by_id]
        for t in seated:
            if t["employee_id"] in places:
                continue
            if rest:
                places[t["employee_id"]] = rest.pop(0)
            else:
                results[t["employee_id"]]["note"] = (
                    "새 부서 구역에 빈 자리가 모자라 미배치로 두었어요"
                    if has_zone
                    else "새 부서에 팀 구역이 없어 미배치로 두었어요"
                )

    group_id: int | None = None
    by_floor: dict[int, list[int]] = {}
    for emp_id, seat in places.items():
        by_floor.setdefault(seat["floor_id"], []).append(emp_id)
    for floor_id in sorted(by_floor):
        cr = conn.execute(
            """
            INSERT INTO change_requests (floor_id, request_type, status, note, requested_by, move_group)
            VALUES (%s, 'SEAT_ASSIGNMENT', 'APPROVED', %s, %s, %s)
            RETURNING id, floor_id, status, request_type, effective_at, requested_by, note
            """,
            (floor_id, f"인사이동: {title}", actor, group_id),
        ).fetchone()
        if group_id is None:
            group_id = cr["id"]
            conn.execute("UPDATE change_requests SET move_group = id WHERE id = %s", (group_id,))
        with conn.cursor() as cur:
            cur.executemany(
                """
                INSERT INTO change_request_items (request_id, seat_id, action, employee_id, expected_employee_id)
                VALUES (%s, %s, 'ASSIGN', %s, NULL)
                """,
                [(cr["id"], places[emp_id]["id"], emp_id) for emp_id in by_floor[floor_id]],
            )
        _apply(conn, cr, FLOOR_ACCESS, actor, request)
    for emp_id, seat in places.items():
        results[emp_id].update(
            seat_id=seat["id"], seat_label=f"{seat['site_name']} {seat['floor_name']} {seat['code']}", note=None
        )
    return results, group_id


def _summary(results: dict[int, dict[str, Any]], moving: set[int]) -> dict[str, int]:
    applied = [e for e, r in results.items() if r["status"] == "APPLIED"]
    return {
        "changed": len(applied),
        "moved": sum(1 for e in applied if e in moving),
        "seated": sum(1 for e in applied if results[e].get("seat_id")),
        "unseated": sum(1 for e in applied if e in moving and not results[e].get("seat_id")),
        "skipped": len(results) - len(applied),
    }


def _items(checked: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "employee_id": c["employee_id"],
            "line": c["line"],
            "from_department_id": c["from_department_id"],
            "to_department_id": c["to_department_id"],
            "rank": c["rank"]["to"] if c["rank"] else None,
            "position": c["position"]["to"] if c["position"] else None,
        }
        for c in checked
        if c["status"] in TODO
    ]


def _row_out(c: dict[str, Any], results: dict[int, dict[str, Any]]) -> dict[str, Any]:
    """확인한 줄 + 반영 결과 (뺀 줄·바뀌는 것이 없는 줄은 결과 없음. 같은 사람이 두 줄이면 앞 줄에만)"""
    result = results.get(c["employee_id"]) if c["status"] in TODO else None
    return {
        **{k: v for k, v in c.items() if k not in ("employee_id", "from_department_id", "to_department_id")},
        "result": (
            {"status": result["status"], "seat": result.get("seat_label"), "note": result.get("note")}
            if result
            else None
        ),
    }


def _departments(conn: Connection, checked: list[dict[str, Any]], results: dict[int, dict[str, Any]]) -> list[Any]:
    """부서마다 들고 나는 사람과 자리 (미리 보기·반영 결과)"""
    movers = [c for c in checked if c["status"] in TODO and c["to_department_id"]]
    ids = {c["to_department_id"] for c in movers} | {c["from_department_id"] for c in movers if c["from_department_id"]}
    if not ids:
        return []
    names = {
        d["id"]: d
        for d in conn.execute(
            """
            SELECT d.id, d.name, EXISTS (SELECT 1 FROM zones z WHERE z.department_id = d.id AND z.is_active) AS has_zone
            FROM departments d WHERE d.id = ANY(%s)
            """,
            (list(ids),),
        ).fetchall()
    }
    out = []
    for dept_id in sorted(ids, key=lambda i: names[i]["name"]):
        incoming = [c for c in movers if c["to_department_id"] == dept_id]
        seated = sum(1 for c in incoming if results.get(c["employee_id"], {}).get("seat_id"))
        out.append(
            {
                "name": names[dept_id]["name"],
                "has_zone": names[dept_id]["has_zone"],
                "incoming": len(incoming),
                "outgoing": sum(1 for c in movers if c["from_department_id"] == dept_id),
                "seated": seated,
                "unseated": len(incoming) - seated,
            }
        )
    return out


# API --------------------------------------------------------------------------


@router.post("/preview")
def preview(body: PreviewIn, admin: CurrentAdmin, request: Request) -> dict[str, Any]:
    """확인과 미리 보기: 줄마다 확인 결과, 지금 반영하면 앉을 자리 (반영해 보고 되돌린다)"""
    _require_company(admin)
    with pool.connection() as conn:
        checked = _check(conn, body.rows)
        items = _items(checked)
        results: dict[int, dict[str, Any]] = {}
        if items:
            with conn.transaction() as tx:
                results, _ = _execute(conn, items, body.seat_mode, admin["employee_id"], request, "미리 보기")
                departments = _departments(conn, checked, results)
                raise Rollback(tx)
        else:
            departments = []
    return {
        "rows": [_row_out(c, results) for c in checked],
        "departments": departments,
        "summary": _summary(results, {i["employee_id"] for i in items if i["to_department_id"]}),
    }


@router.post("", status_code=201)
def create(body: CreateIn, admin: CurrentAdmin, request: Request) -> dict[str, Any]:
    """반영(날짜를 정했으면 예약). 확인에서 뺀 줄(ERROR)·바뀌는 것이 없는 줄(SAME)은 넣지 않는다"""
    _require_company(admin)
    effective_at = _effective_at(body.effective_date)
    title = body.title.strip()
    actor = admin["employee_id"]
    with pool.connection() as conn:
        checked = _check(conn, body.rows)
        items = _items(checked)
        if not items:
            raise HTTPException(status_code=422, detail={"code": "NOTHING_TO_APPLY"})
        move = conn.execute(
            """
            INSERT INTO personnel_moves (title, status, seat_mode, effective_at, created_by)
            VALUES (%s, %s, %s, coalesce(%s, now()), %s)
            RETURNING id
            """,
            (title, "SCHEDULED" if effective_at else "APPLIED", body.seat_mode, effective_at, actor),
        ).fetchone()
        with conn.cursor() as cur:
            cur.executemany(
                """
                INSERT INTO personnel_move_items (move_id, line, employee_id, from_department_id, to_department_id,
                                                  rank_name, position_name)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                """,
                [
                    (
                        move["id"],
                        i["line"],
                        i["employee_id"],
                        i["from_department_id"],
                        i["to_department_id"],
                        i["rank"],
                        i["position"],
                    )
                    for i in items
                ],
            )
        results: dict[int, dict[str, Any]] = {}
        departments: list[Any] = []
        if effective_at is None:
            results, group = _execute(conn, items, body.seat_mode, actor, request, title)
            departments = _departments(conn, checked, results)
            _store(conn, move["id"], results, group, {i["employee_id"] for i in items if i["to_department_id"]})
        conn.execute(
            """
            INSERT INTO audit_logs (actor_id, action, target_type, target_id, after_data, ip_address)
            VALUES (%s, %s, 'personnel_move', %s, %s, %s)
            """,
            (
                actor,
                "PERSONNEL_MOVE_SCHEDULE" if effective_at else "PERSONNEL_MOVE",
                move["id"],
                _json({"title": title, "effective_at": effective_at, "rows": len(items), "seat_mode": body.seat_mode}),
                client_info(request)[0],
            ),
        )
        out = _move(conn, move["id"])
    return {
        "move": out,
        "rows": [_row_out(c, results) for c in checked],
        "departments": departments,
    }


def _store(
    conn: Connection, move_id: int, results: dict[int, dict[str, Any]], group: int | None, moving: set[int]
) -> None:
    with conn.cursor() as cur:
        cur.executemany(
            """
            UPDATE personnel_move_items SET status = %s, seat_id = %s, seat_label = %s, note = %s
            WHERE move_id = %s AND employee_id = %s
            """,
            [
                (r["status"], r.get("seat_id"), r.get("seat_label"), r.get("note"), move_id, emp_id)
                for emp_id, r in results.items()
            ],
        )
    conn.execute(
        """
        UPDATE personnel_moves SET status = 'APPLIED', applied_at = now(), move_group = %s, summary = %s
        WHERE id = %s
        """,
        (group, _json(_summary(results, moving)), move_id),
    )


_MOVE_SQL = """
    SELECT m.id, m.title, m.status, m.seat_mode, m.effective_at, m.created_at, m.applied_at, m.cancelled_at,
           m.summary, m.move_group, c.name AS created_by, x.name AS cancelled_by,
           (SELECT count(*) FROM personnel_move_items i WHERE i.move_id = m.id)::int AS people
    FROM personnel_moves m
    JOIN employees c ON c.id = m.created_by
    LEFT JOIN employees x ON x.id = m.cancelled_by
"""


def _move(conn: Connection, move_id: int) -> dict[str, Any]:
    row = conn.execute(_MOVE_SQL + " WHERE m.id = %s", (move_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail={"code": "MOVE_NOT_FOUND"})
    return dict(row)


@router.get("")
def moves(admin: CurrentAdmin) -> dict[str, Any]:
    """인사이동 기록: 예약한 것 먼저, 그다음 최근에 반영·취소한 것 (50건)"""
    _require_company(admin)
    with pool.connection() as conn:
        rows = conn.execute(
            _MOVE_SQL + " ORDER BY m.status = 'SCHEDULED' DESC, m.effective_at DESC, m.id DESC LIMIT 50"
        ).fetchall()
    return {"moves": rows}


@router.get("/{move_id}")
def move_detail(move_id: int, admin: CurrentAdmin) -> dict[str, Any]:
    """인사이동 한 번: 사람마다 부서·직급·직책과 결과(새 자리, 미배치·건너뛴 이유)"""
    _require_company(admin)
    with pool.connection() as conn:
        move = _move(conn, move_id)
        items = conn.execute(
            """
            SELECT i.line, e.emp_no, e.name, fd.name AS from_department, td.name AS to_department,
                   i.rank_name AS rank, i.position_name AS position, i.status, i.seat_label AS seat, i.note
            FROM personnel_move_items i
            JOIN employees e ON e.id = i.employee_id
            LEFT JOIN departments fd ON fd.id = i.from_department_id
            LEFT JOIN departments td ON td.id = i.to_department_id
            WHERE i.move_id = %s
            ORDER BY i.line
            """,
            (move_id,),
        ).fetchall()
    return {"move": move, "items": items}


@router.post("/{move_id}/cancel")
def cancel(move_id: int, admin: CurrentAdmin, request: Request) -> dict[str, Any]:
    """예약한 인사이동 취소 (그날이 되기 전만)"""
    _require_company(admin)
    with pool.connection() as conn:
        row = conn.execute(
            """
            UPDATE personnel_moves SET status = 'CANCELLED', cancelled_by = %s, cancelled_at = now()
            WHERE id = %s AND status = 'SCHEDULED'
            RETURNING id
            """,
            (admin["employee_id"], move_id),
        ).fetchone()
        if row is None:
            _move(conn, move_id)  # 없으면 404
            raise HTTPException(status_code=409, detail={"code": "NOT_SCHEDULED"})
        conn.execute(
            """
            INSERT INTO audit_logs (actor_id, action, target_type, target_id, ip_address)
            VALUES (%s, 'PERSONNEL_MOVE_CANCEL', 'personnel_move', %s, %s)
            """,
            (admin["employee_id"], move_id, client_info(request)[0]),
        )
        return {"move": _move(conn, move_id)}


# 서버 작업 ----------------------------------------------------------------------


def apply_due_personnel() -> list[dict[str, Any]]:
    """날짜가 된 인사이동 예약을 반영한다 (app/jobs.py가 1분마다). 하나가 실패해도 나머지는 하고,
    실패한 것은 FAILED로 두고 이유를 남긴다 (아무것도 바뀌지 않는다)"""
    with pool.connection() as conn:
        due = [
            r["id"]
            for r in conn.execute(
                """
                SELECT id FROM personnel_moves WHERE status = 'SCHEDULED' AND effective_at <= now()
                ORDER BY effective_at, id
                """
            ).fetchall()
        ]
    done = []
    for move_id in due:
        try:
            with pool.connection() as conn:
                move = conn.execute(
                    """
                    SELECT id, title, seat_mode, created_by FROM personnel_moves
                    WHERE id = %s AND status = 'SCHEDULED' AND effective_at <= now()
                    FOR UPDATE SKIP LOCKED
                    """,
                    (move_id,),
                ).fetchone()
                if move is None:
                    continue  # 다른 서버가 하고 있거나 이미 했다
                items = conn.execute(
                    """
                    SELECT employee_id, line, from_department_id, to_department_id,
                           rank_name AS rank, position_name AS position
                    FROM personnel_move_items WHERE move_id = %s ORDER BY line
                    """,
                    (move_id,),
                ).fetchall()
                results, group = _execute(conn, items, move["seat_mode"], move["created_by"], None, move["title"])
                _store(conn, move_id, results, group, {i["employee_id"] for i in items if i["to_department_id"]})
                done.append({"id": move_id, "title": move["title"]})
        except Exception as error:  # noqa: BLE001 - 하나가 실패해도 다른 예약은 반영하고, 실패는 기록으로 남긴다
            log.exception("인사이동 예약 반영 실패 (personnel_moves.id=%s)", move_id)
            detail = getattr(error, "detail", None) or str(error)
            with pool.connection() as conn:
                conn.execute(
                    "UPDATE personnel_moves SET status = 'FAILED', summary = %s WHERE id = %s AND status = 'SCHEDULED'",
                    (_json({"error": detail}), move_id),
                )
    return done
