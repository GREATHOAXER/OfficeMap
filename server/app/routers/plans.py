"""도면 편집(⑥) API: 초안 만들기, 자동 저장, 편집 잠금, 게시 전 점검, 게시, 보관본에서 다시 시작.

층마다 게시본 1개와 초안 1개. 초안은 직원 화면에 보이지 않고, 게시하는 순간 한 트랜잭션으로
좌석(seats)·회의실(meeting_rooms)을 초안의 책상 칸·회의실 공간에 맞춘다 (plan_element_key로 연결).
같은 책상 칸이면 같은 좌석이라, 책상을 옮기거나 번호만 바꾸면 앉은 사람은 그대로다.
없어지는 책상의 사람은 기본이 미배치(결정 2)이고, 게시할 때 새 자리를 고를 수도 있다.
예약이 남은 회의실이 없어지면 다른 회의실로 옮기거나 취소를 골라야 게시된다.

게시는 날짜를 정해 예약할 수도 있다(SCHEDULED). 그날 0시에 서버 작업(app/jobs.py)이 같은 방식으로 게시하고,
그사이 고른 자리가 찼으면 그 사람은 미배치, 옮길 회의실에 같은 시간 예약이 있으면 그 예약만 취소한다.

도면 파일(이미지·PDF·엑셀)로 시작하면 화면이 파일을 읽어 벽·기둥·공간을 찾아 초안(source import)으로 보내고,
그 쪽 그림은 층의 밑그림(floor_plan_backgrounds)으로 올린다. 밑그림은 편집 화면에서만 요소 밑에 깔린다.

권한: 도면 편집·게시는 층 관리자 이상(결정 1). 구역 관리자는 보기만.
"""

import datetime as dt
import logging
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.encoders import jsonable_encoder
from psycopg import Connection, errors
from pydantic import BaseModel, Field

from app import plan_geometry as geo
from app.admin_auth import CurrentAdmin
from app.db import pool
from app.routers.auth import client_info
from app.routers.seating import LOCK_SEATING, _access, _effective_at, _floor, _json, _now

router = APIRouter(prefix="/api/admin", tags=["plans"])
log = logging.getLogger(__name__)

LOCK_MINUTES = 2  # 편집 화면이 이만큼 소식이 없으면 다른 사람이 편집할 수 있다
DEFAULT_SIZE = geo.DEFAULT_SIZE  # 도면이 하나도 없는 층의 크기 (m)
MOVED_RATIO = 0.002  # 좌석 위치가 이만큼(도면 대비) 넘게 바뀌면 "자리 옮김"으로 센다
MAX_BACKGROUND_BYTES = 8_000_000  # 밑그림 그림 (화면이 긴 쪽 4096px 안으로 줄여 올린다)
IMAGE_MAGIC = {
    "image/jpeg": (b"\xff\xd8\xff",),
    "image/png": (b"\x89PNG\r\n\x1a\n",),
    "image/webp": (b"RIFF",),
}


def _plan_access(admin: dict[str, Any], floor: dict[str, Any]) -> None:
    access = _access(admin, floor)
    if access is None or access["mode"] != "FLOOR":
        raise HTTPException(status_code=403, detail={"code": "FLOOR_ADMIN_ONLY"})


def _name(row: dict[str, Any], prefix: str) -> str | None:
    name = row.get(f"{prefix}_name")
    return f"{name} {row.get(f'{prefix}_rank') or ''}".strip() if name else None


# 편집 화면 데이터 ---------------------------------------------------------------


@router.get("/plans/floors")
def plan_floors(admin: CurrentAdmin) -> dict[str, Any]:
    """도면을 편집할 수 있는 층 (층 관리자 이상)과 도면 상태"""
    with pool.connection() as conn:
        return {"floors": _floor_list(conn, admin)}


def _floor_list(conn: Connection, admin: dict[str, Any]) -> list[dict[str, Any]]:
    floors = conn.execute(
        """
        SELECT f.id, f.name, f.site_id, s.name AS site_name,
               EXISTS (SELECT 1 FROM floor_plans p WHERE p.floor_id = f.id AND p.status = 'PUBLISHED') AS published,
               EXISTS (SELECT 1 FROM floor_plans p
                       WHERE p.floor_id = f.id AND p.status IN ('DRAFT', 'SCHEDULED')) AS drafting
        FROM floors f JOIN sites s ON s.id = f.site_id
        WHERE f.is_active AND s.is_active
        ORDER BY s.sort_order, s.id, f.sort_order DESC
        """
    ).fetchall()
    out = []
    for f in floors:
        access = _access(admin, f)
        if access is not None and access["mode"] == "FLOOR":
            out.append(
                {
                    "id": f["id"],
                    "name": f["name"],
                    "site": f["site_name"],
                    "site_id": f["site_id"],
                    "published": f["published"],
                    "drafting": f["drafting"],
                }
            )
    return out


@router.get("/floors/{floor_id}/plan")
def plan_editor(floor_id: int, admin: CurrentAdmin) -> dict[str, Any]:
    """도면 편집 화면: 게시본·초안(편집기 모양)·보관본, 지금 좌석·회의실(초안 위에 앉은 사람·예약을 보여 준다)"""
    with pool.connection() as conn:
        floor = _floor(conn, floor_id)
        _plan_access(admin, floor)
        return _editor_data(conn, admin, floor)


def _plans(conn: Connection, floor_id: int) -> list[dict[str, Any]]:
    return conn.execute(
        """
        SELECT p.id, p.version, p.status, p.width_m::float8 AS width_m, p.height_m::float8 AS height_m,
               p.geometry, p.revision, p.base_plan_id, p.publish_note, p.published_at, p.updated_at,
               p.editing_heartbeat_at, p.editing_by, p.effective_at, p.publish_options,
               p.editing_heartbeat_at > now() - make_interval(mins => %s) AS editing_fresh,
               pb.name AS publisher_name, pb.rank_name AS publisher_rank,
               ub.name AS updater_name, ub.rank_name AS updater_rank,
               eb.name AS editor_name, eb.rank_name AS editor_rank,
               sb.name AS scheduler_name, sb.rank_name AS scheduler_rank,
               bp.version AS base_version
        FROM floor_plans p
        LEFT JOIN employees pb ON pb.id = p.published_by
        LEFT JOIN employees ub ON ub.id = p.updated_by
        LEFT JOIN employees eb ON eb.id = p.editing_by
        LEFT JOIN employees sb ON sb.id = p.scheduled_by
        LEFT JOIN floor_plans bp ON bp.id = p.base_plan_id
        WHERE p.floor_id = %s
        ORDER BY p.version DESC
        """,
        (LOCK_MINUTES, floor_id),
    ).fetchall()


def _editor_data(conn: Connection, admin: dict[str, Any], floor: dict[str, Any]) -> dict[str, Any]:
    floor_id = floor["id"]
    plans = _plans(conn, floor_id)
    published = next((p for p in plans if p["status"] == "PUBLISHED"), None)
    # 게시를 예약한 초안도 층의 초안 자리를 차지한다 (예약을 취소하면 다시 고칠 수 있다)
    draft = next((p for p in plans if p["status"] in ("DRAFT", "SCHEDULED")), None)
    if draft is not None and not geo.is_v1(draft["geometry"]):
        # 편집기 전에 만든 초안(목업의 "수정 중")은 처음 열 때 편집기 모양으로 바꿔 둔다
        draft["geometry"] = _v1_from_plan(conn, draft, floor_id, link=True)
        conn.execute("UPDATE floor_plans SET geometry = %s WHERE id = %s", (_json(draft["geometry"]), draft["id"]))
    size = draft or published or {"width_m": DEFAULT_SIZE[0], "height_m": DEFAULT_SIZE[1]}
    seats = conn.execute(
        f"""
        SELECT s.plan_element_key AS key, s.code, z.color_key, z.code AS zone_code,
               e.name AS occupant,
               (SELECT count(*) FROM seat_assignments f
                WHERE f.seat_id = s.id AND f.kind = 'FIXED' AND f.starts_at > now())::int AS upcoming
        FROM seats s
        LEFT JOIN zones z ON z.id = s.zone_id
        LEFT JOIN seat_assignments a ON a.seat_id = s.id AND a.kind = 'FIXED' AND {_now()}
        LEFT JOIN employees e ON e.id = a.employee_id
        WHERE s.floor_id = %s AND s.status <> 'REMOVED' AND s.plan_element_key IS NOT NULL
        """,
        (floor_id,),
    ).fetchall()
    rooms = conn.execute(
        """
        SELECT m.plan_element_key AS key, m.name,
               (SELECT count(*) FROM reservations r
                WHERE r.room_id = m.id AND r.status = 'CONFIRMED' AND r.ends_at > now())::int AS upcoming
        FROM meeting_rooms m
        WHERE m.floor_id = %s AND m.is_active AND m.plan_element_key IS NOT NULL
        """,
        (floor_id,),
    ).fetchall()
    sources = conn.execute(
        """
        SELECT f.id, f.name, s.name AS site_name
        FROM floors f JOIN sites s ON s.id = f.site_id
        WHERE f.is_active AND f.id <> %s
          AND EXISTS (SELECT 1 FROM floor_plans p WHERE p.floor_id = f.id AND p.status = 'PUBLISHED')
        ORDER BY s.sort_order, f.sort_order DESC
        """,
        (floor_id,),
    ).fetchall()

    def summary(p: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": p["id"],
            "version": p["version"],
            "published_at": p["published_at"],
            "published_by": _name(p, "publisher"),
            "note": p["publish_note"],
        }

    return {
        "floor": {"id": floor_id, "name": floor["name"], "site": {"id": floor["site_id"], "name": floor["site_name"]}},
        "floors": _floor_list(conn, admin),
        "size": {"width_m": size["width_m"], "height_m": size["height_m"]},
        "published": summary(published) if published else None,
        "draft": (
            {
                "id": draft["id"],
                "status": draft["status"],
                "effective_at": draft["effective_at"],  # 게시 예약한 시각 (SCHEDULED)
                "scheduled_by": _name(draft, "scheduler"),
                "options": draft["publish_options"],  # 게시 예약 때 정한 사람·회의실
                "note": draft["publish_note"],
                "version": draft["version"],
                "revision": draft["revision"],
                "geometry": draft["geometry"],
                "updated_at": draft["updated_at"],
                "updated_by": _name(draft, "updater"),
                "base_version": draft["base_version"],
                "editing": (
                    {
                        "mine": draft["editing_by"] == admin["employee_id"],
                        "name": _name(draft, "editor"),
                        "at": draft["editing_heartbeat_at"],
                    }
                    if draft["editing_by"] and draft["editing_fresh"]
                    else None
                ),
            }
            if draft
            else None
        ),
        "background": _background(conn, floor_id),
        "archived": [summary(p) for p in plans if p["status"] == "ARCHIVED"][:20],
        "sources": [{"id": s["id"], "name": s["name"], "site": s["site_name"]} for s in sources],
        # 지금(게시본 기준) 책상 칸·회의실 공간에 앉은 사람과 예약. 초안에서 지우면 영향 받는 것을 미리 보여 준다
        "live": {
            "seats": {
                s["key"]: {
                    "code": s["code"],
                    "occupant": s["occupant"],
                    "color_key": s["color_key"],
                    "zone_code": s["zone_code"],
                    "upcoming": s["upcoming"],
                }
                for s in seats
            },
            "rooms": {r["key"]: {"name": r["name"], "upcoming": r["upcoming"]} for r in rooms},
        },
    }


# 초안 ------------------------------------------------------------------------


class DraftIn(BaseModel):
    source: Literal["published", "blank", "archived", "floor", "import"] = "published"
    plan_id: int | None = None  # archived: 이 층의 보관본(또는 게시본)
    floor_id: int | None = None  # floor: 다른 층의 게시본을 복제
    # blank: 사무실 실제 크기 (m). 없으면 지금 게시본 크기. import: 꼭 넣는다 (도면 파일에서 고른 부분의 실제 크기)
    width_m: float | None = Field(default=None, ge=geo.MIN_SIZE, le=geo.MAX_SIZE)
    height_m: float | None = Field(default=None, ge=geo.MIN_SIZE, le=geo.MAX_SIZE)
    geometry: dict[str, Any] | None = None  # import: 화면이 도면 파일에서 찾은 벽·기둥·공간 (편집기 모양)


def _v1_from_plan(conn: Connection, plan: dict[str, Any], seat_floor: int, *, link: bool) -> dict[str, Any]:
    """도면 버전 → 편집기 모양. v0이면 그 층의 지금 좌석·회의실로 책상 묶음·회의실 공간을 만든다.
    link: 연결 키가 없는 좌석·회의실에 키를 붙여 둔다 (이 층의 초안일 때만)"""
    if geo.is_v1(plan["geometry"]):
        return plan["geometry"]
    if link:
        conn.execute(
            """
            UPDATE seats SET plan_element_key = 'seat-' || id
            WHERE floor_id = %s AND status <> 'REMOVED' AND plan_element_key IS NULL
            """,
            (seat_floor,),
        )
        conn.execute(
            """
            UPDATE meeting_rooms SET plan_element_key = 'room-' || id
            WHERE floor_id = %s AND is_active AND plan_element_key IS NULL
            """,
            (seat_floor,),
        )
    seats = conn.execute(
        """
        SELECT s.id, s.plan_element_key AS key, s.code, s.x::float8 AS x, s.y::float8 AS y, s.rotation,
               s.w::float8 AS w, s.h::float8 AS h,
               s.zone_id, z.code AS zone_code
        FROM seats s LEFT JOIN zones z ON z.id = s.zone_id
        WHERE s.floor_id = %s AND s.status <> 'REMOVED'
        ORDER BY z.sort_order NULLS LAST, s.code
        """,
        (seat_floor,),
    ).fetchall()
    rooms = conn.execute(
        """
        SELECT id, plan_element_key AS key, name, capacity, equipment, shape
        FROM meeting_rooms WHERE floor_id = %s AND is_active ORDER BY sort_order, id
        """,
        (seat_floor,),
    ).fetchall()
    return geo.from_v0(plan["geometry"], plan["width_m"], plan["height_m"], seats, rooms)


def _rename_ids(geometry: dict[str, Any], tag: str) -> dict[str, Any]:
    """다른 층에서 복제한 도면: 요소·칸 ID를 새로 붙여 그 층 좌석·회의실과 섞이지 않게 한다"""

    def fresh(old: str) -> str:
        return f"{tag}{old}"[-50:]

    elements = []
    for el in geometry["elements"]:
        copy = {**el, "id": fresh(el["id"])}
        if el["type"] == "desk_group":
            copy["cells"] = [{**c, "id": fresh(c["id"])} for c in el["cells"]]
        elements.append(copy)
    return {**geometry, "elements": elements}


@router.post("/floors/{floor_id}/plan/draft", status_code=201)
def create_draft(floor_id: int, body: DraftIn, admin: CurrentAdmin, request: Request) -> dict[str, Any]:
    """초안 만들기: 지금 게시본에서(기본) · 빈 도면 · 보관본에서 · 다른 층 복제"""
    with pool.connection() as conn:
        floor = _floor(conn, floor_id)
        _plan_access(admin, floor)
        conn.execute("SELECT pg_advisory_xact_lock(%s, %s)", (LOCK_SEATING, floor_id))
        plans = _plans(conn, floor_id)
        if any(p["status"] in ("DRAFT", "SCHEDULED") for p in plans):
            raise HTTPException(status_code=409, detail={"code": "HAS_DRAFT"})
        published = next((p for p in plans if p["status"] == "PUBLISHED"), None)
        width, height = (published["width_m"], published["height_m"]) if published else DEFAULT_SIZE
        base_id = published["id"] if published else None
        version = max((p["version"] for p in plans), default=0) + 1

        if body.source == "published":
            if published is None:
                raise HTTPException(status_code=422, detail={"code": "NO_PUBLISHED"})
            geometry = _v1_from_plan(conn, published, floor_id, link=True)
        elif body.source == "blank":
            width, height = body.width_m or width, body.height_m or height
            geometry = {
                "schema": geo.SCHEMA,
                "grid_m": geo.GRID_M,
                "elements": [{"id": "wall-1", "type": "wall", "x": 1.5, "y": 1.5, "w": width - 3, "h": height - 3}],
            }
        elif body.source == "archived":
            source = next(
                (p for p in plans if p["id"] == body.plan_id and p["status"] in ("PUBLISHED", "ARCHIVED")), None
            )
            if source is None:
                raise HTTPException(status_code=422, detail={"code": "PLAN_NOT_FOUND"})
            width, height = source["width_m"], source["height_m"]
            geometry = _v1_from_plan(conn, source, floor_id, link=True)
            base_id = source["id"]
        elif body.source == "floor":
            other = _floor(conn, body.floor_id or 0)
            source = next((p for p in _plans(conn, other["id"]) if p["status"] == "PUBLISHED"), None)
            if source is None:
                raise HTTPException(status_code=422, detail={"code": "PLAN_NOT_FOUND"})
            width, height = source["width_m"], source["height_m"]
            geometry = _rename_ids(_v1_from_plan(conn, source, other["id"], link=False), f"f{other['id']}-")
        else:  # import
            if body.width_m is None or body.height_m is None or body.geometry is None:
                raise HTTPException(status_code=422, detail={"code": "IMPORT_SIZE"})
            width, height = body.width_m, body.height_m
            try:
                geometry = geo.validate(body.geometry, width, height)
            except geo.GeometryError as error:
                raise HTTPException(status_code=422, detail={"code": "BAD_GEOMETRY", "where": str(error)}) from None
            # 파일에서 찾은 책상이 우연히 지금 좌석 키와 같아 엉뚱한 사람이 이어지지 않게 ID를 새로 붙인다
            geometry = _rename_ids(geometry, f"i{version}-")

        plan_id = conn.execute(
            """
            INSERT INTO floor_plans (floor_id, version, status, width_m, height_m, geometry, base_plan_id,
                                     created_by, updated_by, editing_by, editing_heartbeat_at)
            VALUES (%s, %s, 'DRAFT', %s, %s, %s, %s, %s, %s, %s, now())
            RETURNING id
            """,
            (floor_id, version, width, height, _json(geometry), base_id, *[admin["employee_id"]] * 3),
        ).fetchone()["id"]
        _audit(
            conn,
            admin["employee_id"],
            "PLAN_DRAFT_CREATE",
            plan_id,
            {
                "source": body.source,
                "version": version,
                **({"elements": len(geometry["elements"])} if body.source == "import" else {}),
            },
            client_info(request)[0],
        )
        return _editor_data(conn, admin, floor)


class SaveIn(BaseModel):
    revision: int
    geometry: dict[str, Any]
    # 도면 크기 (m). 바꿀 때만 보낸다
    width_m: float | None = Field(default=None, ge=geo.MIN_SIZE, le=geo.MAX_SIZE)
    height_m: float | None = Field(default=None, ge=geo.MIN_SIZE, le=geo.MAX_SIZE)


def _plan_select(
    conn: Connection, plan_id: int, *, lock: bool = False, skip_locked: bool = False
) -> dict[str, Any] | None:
    return conn.execute(
        f"""
        SELECT p.id, p.floor_id, p.status, p.revision, p.width_m::float8 AS width_m, p.height_m::float8 AS height_m,
               p.geometry, p.base_plan_id, p.version, p.editing_by, p.effective_at, p.publish_options,
               p.publish_note, p.scheduled_by, p.effective_at <= now() AS due,
               p.editing_heartbeat_at > now() - make_interval(mins => %s) AS editing_fresh,
               e.name AS editor_name, e.rank_name AS editor_rank
        FROM floor_plans p LEFT JOIN employees e ON e.id = p.editing_by
        WHERE p.id = %s
        {"FOR UPDATE OF p" if lock or skip_locked else ""} {"SKIP LOCKED" if skip_locked else ""}
        """,
        (LOCK_MINUTES, plan_id),
    ).fetchone()


def _plan_row(conn: Connection, plan_id: int, admin: dict[str, Any], *, lock: bool = False) -> dict[str, Any]:
    """초안 또는 게시 예약한 초안 (권한 확인 포함)"""
    plan = _plan_select(conn, plan_id, lock=lock)
    if plan is None or plan["status"] not in ("DRAFT", "SCHEDULED"):
        raise HTTPException(status_code=404, detail={"code": "DRAFT_NOT_FOUND"})
    floor = _floor(conn, plan["floor_id"])
    _plan_access(admin, floor)
    return {**plan, "floor": floor}


def _draft_for_update(
    conn: Connection, plan_id: int, admin: dict[str, Any], *, take_over: bool = False
) -> dict[str, Any]:
    plan = _plan_row(conn, plan_id, admin, lock=True)
    if plan["status"] == "SCHEDULED":
        raise HTTPException(status_code=409, detail={"code": "SCHEDULED"})
    if plan["editing_by"] not in (None, admin["employee_id"]) and plan["editing_fresh"] and not take_over:
        raise HTTPException(status_code=423, detail={"code": "EDITING", "by": _name(plan, "editor")})
    return plan


@router.put("/plans/{plan_id}")
def save_draft(plan_id: int, body: SaveIn, admin: CurrentAdmin) -> dict[str, Any]:
    """자동 저장. revision이 서버와 다르면(다른 탭·사람이 먼저 저장) 덮어쓰지 않고 409"""
    with pool.connection() as conn:
        plan = _draft_for_update(conn, plan_id, admin)
        if body.revision != plan["revision"]:
            raise HTTPException(status_code=409, detail={"code": "REVISION", "revision": plan["revision"]})
        width = body.width_m or plan["width_m"]
        height = body.height_m or plan["height_m"]
        try:
            geometry = geo.validate(body.geometry, width, height)
        except geo.GeometryError as error:
            raise HTTPException(status_code=422, detail={"code": "BAD_GEOMETRY", "where": str(error)}) from None
        saved = conn.execute(
            """
            UPDATE floor_plans
            SET geometry = %s, width_m = %s, height_m = %s, revision = revision + 1, updated_by = %s,
                updated_at = now(), editing_by = %s, editing_heartbeat_at = now()
            WHERE id = %s
            RETURNING revision, updated_at
            """,
            (_json(geometry), width, height, admin["employee_id"], admin["employee_id"], plan_id),
        ).fetchone()
    return {"revision": saved["revision"], "updated_at": saved["updated_at"]}


class HeartbeatIn(BaseModel):
    take_over: bool = False


@router.post("/plans/{plan_id}/heartbeat")
def heartbeat(plan_id: int, body: HeartbeatIn, admin: CurrentAdmin, request: Request) -> dict[str, Any]:
    """편집 중 표시를 이어 간다 (30초마다). 다른 사람이 편집 중이면 423, take_over면 넘겨받는다"""
    with pool.connection() as conn:
        plan = _draft_for_update(conn, plan_id, admin, take_over=body.take_over)
        if body.take_over and plan["editing_by"] not in (None, admin["employee_id"]):
            _audit(
                conn,
                admin["employee_id"],
                "PLAN_TAKE_OVER",
                plan_id,
                {"from": _name(plan, "editor")},
                client_info(request)[0],
            )
        row = conn.execute(
            """
            UPDATE floor_plans SET editing_by = %s, editing_heartbeat_at = now() WHERE id = %s
            RETURNING revision
            """,
            (admin["employee_id"], plan_id),
        ).fetchone()
    return {"revision": row["revision"]}


@router.delete("/plans/{plan_id}", status_code=204)
def discard_draft(plan_id: int, admin: CurrentAdmin, request: Request) -> None:
    """초안 버리기 (게시하지 않은 것이라 지운다). 다른 사람이 편집 중이면 423"""
    with pool.connection() as conn:
        plan = _draft_for_update(conn, plan_id, admin)
        conn.execute("DELETE FROM floor_plans WHERE id = %s", (plan_id,))
        ip = client_info(request)[0]
        _audit(conn, admin["employee_id"], "PLAN_DRAFT_DISCARD", plan_id, {"version": plan["version"]}, ip)


# 밑그림 (도면 파일 그림) -----------------------------------------------------------


def _background(conn: Connection, floor_id: int) -> dict[str, Any] | None:
    row = conn.execute(
        """
        SELECT x_m::float8 AS x_m, y_m::float8 AS y_m, w_m::float8 AS w_m, h_m::float8 AS h_m,
               opacity::float8 AS opacity, visible, source_name, octet_length(image) AS bytes, updated_at
        FROM floor_plan_backgrounds WHERE floor_id = %s
        """,
        (floor_id,),
    ).fetchone()
    if row is None:
        return None
    version = int(row["updated_at"].timestamp() * 1000)
    return {
        "url": f"/api/admin/floors/{floor_id}/plan/background?v={version}",
        "x_m": row["x_m"],
        "y_m": row["y_m"],
        "w_m": row["w_m"],
        "h_m": row["h_m"],
        "opacity": row["opacity"],
        "visible": row["visible"],
        "name": row["source_name"],
        "bytes": row["bytes"],
        "updated_at": row["updated_at"],
    }


def _plan_floor(conn: Connection, floor_id: int, admin: dict[str, Any]) -> dict[str, Any]:
    floor = _floor(conn, floor_id)
    _plan_access(admin, floor)
    return floor


def _place_number(value: float | None, name: str, low: float, high: float) -> float | None:
    if value is not None and not low <= value <= high:
        raise HTTPException(status_code=422, detail={"code": "BAD_PLACE", "field": name})
    return value


@router.put("/floors/{floor_id}/plan/background")
async def put_background(
    floor_id: int,
    admin: CurrentAdmin,
    request: Request,
    w_m: float,
    h_m: float,
    x_m: float = 0,
    y_m: float = 0,
    opacity: float = 0.5,
    name: str | None = None,
) -> dict[str, Any]:
    """밑그림 올리기 (있으면 바꾼다). 본문이 그림 파일 그대로 (image/jpeg·png·webp, 8MB까지).
    w_m·h_m·x_m·y_m: 도면 위에 깔 자리 (m)"""
    content_type = (request.headers.get("content-type") or "").split(";")[0].strip().lower()
    if content_type not in IMAGE_MAGIC:
        raise HTTPException(status_code=415, detail={"code": "IMAGE_TYPE"})
    length = request.headers.get("content-length")
    if length and length.isdigit() and int(length) > MAX_BACKGROUND_BYTES:
        raise HTTPException(status_code=413, detail={"code": "IMAGE_TOO_BIG", "max": MAX_BACKGROUND_BYTES})
    for value, field, low, high in (
        (w_m, "w_m", 0.5, geo.MAX_SIZE * 2),
        (h_m, "h_m", 0.5, geo.MAX_SIZE * 2),
        (x_m, "x_m", -geo.MAX_SIZE, geo.MAX_SIZE),
        (y_m, "y_m", -geo.MAX_SIZE, geo.MAX_SIZE),
        (opacity, "opacity", 0.05, 1),
    ):
        _place_number(value, field, low, high)
    data = await request.body()
    if len(data) > MAX_BACKGROUND_BYTES:
        raise HTTPException(status_code=413, detail={"code": "IMAGE_TOO_BIG", "max": MAX_BACKGROUND_BYTES})
    if not any(data.startswith(m) for m in IMAGE_MAGIC[content_type]) or (
        content_type == "image/webp" and data[8:12] != b"WEBP"
    ):
        raise HTTPException(status_code=415, detail={"code": "IMAGE_TYPE"})
    source_name = (name or "").strip()[:200] or None
    with pool.connection() as conn:
        _plan_floor(conn, floor_id, admin)
        conn.execute(
            """
            INSERT INTO floor_plan_backgrounds
                (floor_id, image, content_type, x_m, y_m, w_m, h_m, opacity, visible, source_name, updated_by)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, true, %s, %s)
            ON CONFLICT (floor_id) DO UPDATE
            SET image = EXCLUDED.image, content_type = EXCLUDED.content_type, x_m = EXCLUDED.x_m,
                y_m = EXCLUDED.y_m, w_m = EXCLUDED.w_m, h_m = EXCLUDED.h_m, opacity = EXCLUDED.opacity,
                visible = true, source_name = EXCLUDED.source_name, updated_by = EXCLUDED.updated_by,
                updated_at = now()
            """,
            (floor_id, data, content_type, x_m, y_m, w_m, h_m, opacity, source_name, admin["employee_id"]),
        )
        _audit_floor(
            conn,
            admin["employee_id"],
            "PLAN_BACKGROUND_SET",
            floor_id,
            {"bytes": len(data), "type": content_type, "name": source_name, "w_m": w_m, "h_m": h_m},
            client_info(request)[0],
        )
        return {"background": _background(conn, floor_id)}


class BackgroundIn(BaseModel):
    x_m: float | None = Field(default=None, ge=-geo.MAX_SIZE, le=geo.MAX_SIZE)
    y_m: float | None = Field(default=None, ge=-geo.MAX_SIZE, le=geo.MAX_SIZE)
    w_m: float | None = Field(default=None, ge=0.5, le=geo.MAX_SIZE * 2)
    h_m: float | None = Field(default=None, ge=0.5, le=geo.MAX_SIZE * 2)
    opacity: float | None = Field(default=None, ge=0.05, le=1)
    visible: bool | None = None


@router.patch("/floors/{floor_id}/plan/background")
def patch_background(floor_id: int, body: BackgroundIn, admin: CurrentAdmin) -> dict[str, Any]:
    """밑그림 자리·진하기·보이기 (보낸 것만 바꾼다). 그림을 바꾸지 않아 기록은 남기지 않는다"""
    changes = body.model_dump(exclude_none=True)
    with pool.connection() as conn:
        _plan_floor(conn, floor_id, admin)
        if changes:
            sets = ", ".join(f"{key} = %({key})s" for key in changes)
            done = conn.execute(
                f"UPDATE floor_plan_backgrounds SET {sets} WHERE floor_id = %(floor_id)s",
                {**changes, "floor_id": floor_id},
            ).rowcount
            if not done:
                raise HTTPException(status_code=404, detail={"code": "NO_BACKGROUND"})
        background = _background(conn, floor_id)
        if background is None:
            raise HTTPException(status_code=404, detail={"code": "NO_BACKGROUND"})
        return {"background": background}


@router.delete("/floors/{floor_id}/plan/background", status_code=204)
def delete_background(floor_id: int, admin: CurrentAdmin, request: Request) -> Response:
    with pool.connection() as conn:
        _plan_floor(conn, floor_id, admin)
        gone = conn.execute("DELETE FROM floor_plan_backgrounds WHERE floor_id = %s", (floor_id,)).rowcount
        if gone:
            _audit_floor(conn, admin["employee_id"], "PLAN_BACKGROUND_DELETE", floor_id, {}, client_info(request)[0])
    return Response(status_code=204)


@router.get("/floors/{floor_id}/plan/background")
def get_background(floor_id: int, admin: CurrentAdmin, request: Request, v: int | None = None) -> Response:
    """밑그림 그림. 주소에 v(바꾼 시각)가 있으면 브라우저가 하루 동안 다시 묻지 않는다"""
    with pool.connection() as conn:
        _plan_floor(conn, floor_id, admin)
        row = conn.execute(
            "SELECT image, content_type, updated_at FROM floor_plan_backgrounds WHERE floor_id = %s",
            (floor_id,),
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail={"code": "NO_BACKGROUND"})
    etag = f'"{int(row["updated_at"].timestamp() * 1000)}"'
    headers = {
        "ETag": etag,
        "Cache-Control": "private, max-age=86400" if v is not None else "private, no-cache",
        "X-Content-Type-Options": "nosniff",
    }
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    return Response(content=bytes(row["image"]), media_type=row["content_type"], headers=headers)


# 게시 전 점검 · 게시 -------------------------------------------------------------


def _impact(conn: Connection, plan: dict[str, Any]) -> dict[str, Any]:
    """초안을 게시하면 바뀌는 것: 좌석(새로·빠짐·옮김·번호 바뀜), 자리가 없어지는 사람과 추천 자리, 회의실·예약"""
    floor_id = plan["floor_id"]
    width, height = plan["width_m"], plan["height_m"]
    geometry = plan["geometry"]
    cells = geo.desk_cells(geometry, width, height)
    room_els = geo.room_elements(geometry, width, height)

    seats = conn.execute(
        f"""
        SELECT s.id, s.plan_element_key AS key, s.code, s.x::float8 AS x, s.y::float8 AS y, s.rotation,
               s.w::float8 AS w, s.h::float8 AS h,
               s.zone_id, s.seat_type, s.status, z.name AS zone_name, z.code AS zone_code,
               cur.employee_id AS occupant_id
        FROM seats s
        LEFT JOIN zones z ON z.id = s.zone_id
        LEFT JOIN seat_assignments cur ON cur.seat_id = s.id AND cur.kind = 'FIXED' AND {_now("cur")}
        WHERE s.floor_id = %s AND s.status <> 'REMOVED'
        """,
        (floor_id,),
    ).fetchall()
    kept = [s for s in seats if s["key"] in cells]
    removed = [s for s in seats if s["key"] not in cells]
    existing_keys = {s["key"] for s in kept}
    added = [k for k in cells if k not in existing_keys]
    moved = [
        s
        for s in kept
        if abs(cells[s["key"]]["x"] - s["x"]) > MOVED_RATIO
        or abs(cells[s["key"]]["y"] - s["y"]) > MOVED_RATIO
        or cells[s["key"]]["rotation"] != s["rotation"]
    ]
    renamed = [s for s in kept if cells[s["key"]]["code"] != s["code"]]

    # 빠지는 좌석에 앉아 있거나 날짜를 정해 그 자리로 오기로 한 사람
    displaced = conn.execute(
        """
        SELECT DISTINCT ON (e.id) e.emp_no, e.name, e.rank_name, d.name AS department, s.code AS seat_code,
               s.plan_element_key AS seat_key, s.zone_id, a.starts_at > now() AS scheduled
        FROM seat_assignments a
        JOIN seats s ON s.id = a.seat_id
        JOIN employees e ON e.id = a.employee_id
        JOIN departments d ON d.id = e.department_id
        WHERE a.seat_id = ANY(%s) AND a.kind = 'FIXED' AND (a.ends_at IS NULL OR a.ends_at > now())
        ORDER BY e.id, a.starts_at
        """,
        ([s["id"] for s in removed],),
    ).fetchall()
    daily = conn.execute(
        f"SELECT count(*) AS n FROM seat_assignments a WHERE a.seat_id = ANY(%s) AND a.kind = 'DAILY' AND {_now()}",
        ([s["id"] for s in removed],),
    ).fetchone()["n"]

    # 추천 자리: 게시한 뒤 비어 있을 고정석 (같은 구역 → 가장 가까운 자리), 새 책상
    taken = {s["key"] for s in kept if s["occupant_id"]}
    free = [
        {"key": s["key"], "code": cells[s["key"]]["code"], "zone_id": s["zone_id"], **_xy(cells[s["key"]])}
        for s in kept
        if s["key"] not in taken and s["seat_type"] == "FIXED" and s["status"] == "ACTIVE"
    ] + [{"key": k, "code": cells[k]["code"], "zone_id": None, **_xy(cells[k])} for k in added]
    removed_xy = {s["key"]: (s["x"], s["y"]) for s in removed}
    used: set[str] = set()
    people = []
    for p in displaced:
        origin = removed_xy.get(p["seat_key"], (0.5, 0.5))
        candidates = sorted(
            (f for f in free if f["key"] not in used),
            key=lambda f: (f["zone_id"] != p["zone_id"], (f["x"] - origin[0]) ** 2 + (f["y"] - origin[1]) ** 2),
        )
        suggestion = candidates[0] if candidates else None
        if suggestion:
            used.add(suggestion["key"])
        people.append(
            {
                "emp_no": p["emp_no"],
                "name": p["name"],
                "rank": p["rank_name"],
                "department": p["department"],
                "seat_code": p["seat_code"],
                "scheduled": p["scheduled"],
                "suggestion": {"key": suggestion["key"], "code": suggestion["code"]} if suggestion else None,
            }
        )

    rooms = conn.execute(
        """
        SELECT m.id, m.plan_element_key AS key, m.name, m.capacity,
               (SELECT count(*) FROM reservations r
                WHERE r.room_id = m.id AND r.status = 'CONFIRMED' AND r.ends_at > now())::int AS upcoming,
               (SELECT min(r.starts_at) FROM reservations r
                WHERE r.room_id = m.id AND r.status = 'CONFIRMED' AND r.ends_at > now()) AS next_at
        FROM meeting_rooms m
        WHERE m.floor_id = %s AND m.is_active
        ORDER BY m.sort_order, m.id
        """,
        (floor_id,),
    ).fetchall()
    room_keys = {r["key"] for r in rooms}
    return {
        "cells": cells,
        "room_elements": room_els,
        "kept": kept,
        "removed": removed,
        "added": added,
        "people": people,
        "rooms": rooms,
        "summary": {
            "seats_before": len(seats),
            "seats_after": len(cells),
            "added": len(added),
            "removed": len(removed),
            "moved": len(moved),
            "renamed": [{"from": s["code"], "to": cells[s["key"]]["code"]} for s in renamed],
            "daily_ended": daily,
        },
        "rooms_removed": [
            {"id": r["id"], "name": r["name"], "upcoming": r["upcoming"], "next_at": r["next_at"]}
            for r in rooms
            if r["key"] not in room_els
        ],
        "rooms_added": [room_els[k]["name"] for k in room_els if k not in room_keys],
        "rooms_changed": [
            {"from": r["name"], "to": room_els[r["key"]]["name"], "capacity": room_els[r["key"]]["capacity"]}
            for r in rooms
            if r["key"] in room_els
            and (room_els[r["key"]]["name"] != r["name"] or room_els[r["key"]]["capacity"] != r["capacity"])
        ],
        "room_targets": [{"key": k, "name": v["name"], "capacity": v["capacity"]} for k, v in room_els.items()],
        "seat_targets": free,
        "problems": geo.problems(geometry, plan["width_m"], plan["height_m"]),
    }


def _xy(cell: dict[str, Any]) -> dict[str, float]:
    return {"x": cell["x"], "y": cell["y"]}


def _public_impact(impact: dict[str, Any]) -> dict[str, Any]:
    keys = ("summary", "people", "rooms_removed", "rooms_added", "rooms_changed", "room_targets", "problems")
    return {
        **{k: impact[k] for k in keys},
        "seat_targets": [{"key": t["key"], "code": t["code"]} for t in impact["seat_targets"]],
    }


@router.get("/plans/{plan_id}/check")
def publish_check(plan_id: int, admin: CurrentAdmin) -> dict[str, Any]:
    """게시 전 점검 화면 데이터"""
    with pool.connection() as conn:
        plan = _plan_row(conn, plan_id, admin)
        return {"revision": plan["revision"], **_public_impact(_impact(conn, plan))}


class PersonChoice(BaseModel):
    emp_no: str = Field(max_length=20)
    to_key: str | None = Field(default=None, max_length=50)  # 없으면 미배치 (기본)


class RoomChoice(BaseModel):
    room_id: int
    action: Literal["CANCEL", "MOVE"]
    to_key: str | None = Field(default=None, max_length=50)  # MOVE: 초안의 회의실 공간


class PublishIn(BaseModel):
    revision: int
    people: list[PersonChoice] = Field(default_factory=list, max_length=500)
    rooms: list[RoomChoice] = Field(default_factory=list, max_length=100)
    note: str | None = Field(default=None, max_length=200)
    effective_date: dt.date | None = None  # 이날 0시(서울)에 게시. 없으면 지금


@router.post("/plans/{plan_id}/publish")
def publish(plan_id: int, body: PublishIn, admin: CurrentAdmin, request: Request) -> dict[str, Any]:
    """게시: 한 트랜잭션으로 좌석·배정·회의실·예약을 초안에 맞추고, 이전 게시본은 보관본으로.
    좌석·사람·예약을 하나라도 맞추지 못하면 아무것도 바꾸지 않는다.
    effective_date를 주면 게시를 예약한다 (그날 0시에 서버가 같은 방식으로 게시한다)"""
    actor = admin["employee_id"]
    effective_at = _effective_at(body.effective_date)
    with pool.connection() as conn:
        plan = _draft_for_update(conn, plan_id, admin)
        floor_id = plan["floor_id"]
        if body.revision != plan["revision"]:
            raise HTTPException(status_code=409, detail={"code": "REVISION", "revision": plan["revision"]})
        conn.execute("SELECT pg_advisory_xact_lock(%s, %s)", (LOCK_SEATING, floor_id))
        impact = _impact(conn, plan)
        if impact["problems"]:
            raise HTTPException(status_code=422, detail={"code": "PROBLEMS", "problems": impact["problems"]})
        room_choice = {c.room_id: c for c in body.rooms}
        # 바로 게시하면 남은 예약이 있는 회의실만 정하면 된다.
        # 예약해 두면 그사이 예약이 생길 수 있어 없어지는 회의실을 모두 정한다
        unresolved = [
            r
            for r in impact["rooms_removed"]
            if r["id"] not in room_choice and (r["upcoming"] or effective_at is not None)
        ]
        if unresolved:
            raise HTTPException(
                status_code=422, detail=jsonable_encoder({"code": "ROOMS_UNRESOLVED", "rooms": unresolved})
            )
        people = {c.emp_no: c.to_key for c in body.people if c.to_key}
        rooms = {c.room_id: (c.action, c.to_key) for c in body.rooms}
        note = (body.note or "").strip() or None
        if effective_at is None:
            result = _publish(conn, plan, impact, people, rooms, note, actor, client_info(request)[0], lenient=False)
            return {"published": result}

        # 예약: 고른 자리·회의실이 초안에 있는지만 지금 보고, 그날 다시 맞춘다
        targets = list(people.values())
        if len(set(targets)) != len(targets) or any(t not in impact["cells"] for t in targets):
            raise HTTPException(status_code=422, detail={"code": "BAD_TARGET"})
        if any(a == "MOVE" and k not in impact["room_elements"] for a, k in rooms.values()):
            raise HTTPException(status_code=422, detail={"code": "BAD_ROOM_TARGET"})
        options = {
            "people": [{"emp_no": e, "to_key": k} for e, k in people.items()],
            "rooms": [{"room_id": r, "action": a, "to_key": k} for r, (a, k) in rooms.items()],
        }
        conn.execute(
            """
            UPDATE floor_plans
            SET status = 'SCHEDULED', effective_at = %s, publish_options = %s, publish_note = %s,
                scheduled_by = %s, editing_by = NULL, editing_heartbeat_at = NULL
            WHERE id = %s
            """,
            (effective_at, _json(options), note, actor, plan_id),
        )
        _audit(
            conn,
            actor,
            "PLAN_SCHEDULE",
            plan_id,
            {"version": plan["version"], "effective_at": effective_at, **options},
            client_info(request)[0],
        )
    return {"scheduled": {"version": plan["version"], "effective_at": effective_at}}


@router.post("/plans/{plan_id}/unschedule")
def unschedule(plan_id: int, admin: CurrentAdmin, request: Request) -> dict[str, Any]:
    """게시 예약 취소: 다시 고칠 수 있는 초안으로 돌린다"""
    with pool.connection() as conn:
        plan = _plan_row(conn, plan_id, admin, lock=True)
        if plan["status"] != "SCHEDULED":
            raise HTTPException(status_code=409, detail={"code": "NOT_SCHEDULED"})
        conn.execute(
            """
            UPDATE floor_plans
            SET status = 'DRAFT', effective_at = NULL, publish_options = NULL, scheduled_by = NULL,
                editing_by = %s, editing_heartbeat_at = now()
            WHERE id = %s
            """,
            (admin["employee_id"], plan_id),
        )
        _audit(
            conn,
            admin["employee_id"],
            "PLAN_UNSCHEDULE",
            plan_id,
            {"version": plan["version"], "effective_at": plan["effective_at"]},
            client_info(request)[0],
        )
        return _editor_data(conn, admin, plan["floor"])


def _publish(
    conn: Connection,
    plan: dict[str, Any],
    impact: dict[str, Any],
    people: dict[str, str],
    rooms: dict[int, tuple[str, str | None]],
    note: str | None,
    actor: int,
    ip: str | None,
    *,
    lenient: bool,
) -> dict[str, Any]:
    """게시 (호출한 쪽의 트랜잭션 안에서, 층 잠금을 잡은 뒤).

    people: 사번 → 옮길 책상 칸. 없는 사람은 미배치.
    rooms: 없어지는 회의실 → (MOVE, 옮길 회의실 공간) 또는 (CANCEL, None).
    lenient(예약한 게시를 서버가 할 때): 그사이 고른 자리가 찼으면 그 사람은 미배치, 정하지 않은 회의실의 예약은
    취소, 옮길 회의실에 같은 시간 예약이 있으면 그 예약만 취소한다. 사람이 고를 수 있을 때(바로 게시)는 막고
    다시 고르게 한다."""
    plan_id, floor_id = plan["id"], plan["floor_id"]
    published = conn.execute(
        "SELECT id, version FROM floor_plans WHERE floor_id = %s AND status = 'PUBLISHED' FOR UPDATE",
        (floor_id,),
    ).fetchone()
    cells, room_els = impact["cells"], impact["room_elements"]

    # 1) 빠지는 좌석: 지금 배정은 지금 끝내고, 아직 시작 안 한 배정은 지운다
    removed_ids = [s["id"] for s in impact["removed"]]
    conn.execute(
        "UPDATE seat_assignments SET ends_at = now() WHERE seat_id = ANY(%s) AND starts_at < now() "
        "AND (ends_at IS NULL OR ends_at > now())",
        (removed_ids,),
    )
    conn.execute("DELETE FROM seat_assignments WHERE seat_id = ANY(%s) AND starts_at >= now()", (removed_ids,))
    conn.execute(
        """
        UPDATE seats SET status = 'REMOVED', removed_at = now(), removed_by_plan_id = %s, updated_at = now()
        WHERE id = ANY(%s)
        """,
        (plan_id, removed_ids),
    )
    # 2) 남는 좌석: 위치·방향·번호. 번호를 서로 바꾸는 경우를 위해 잠깐 임시 번호를 거친다
    kept = impact["kept"]
    conn.execute(
        "UPDATE seats SET code = left(code, 10) || '~' || id WHERE id = ANY(%s)",
        ([s["id"] for s in kept if cells[s["key"]]["code"] != s["code"]],),
    )

    def place(c: dict[str, Any]) -> tuple[Any, ...]:
        return (c["code"], round(c["x"], 6), round(c["y"], 6), c["rotation"], round(c["w"], 6), round(c["h"], 6))

    changed = [
        (*place(c), s["id"])
        for s in kept
        for c in [cells[s["key"]]]
        if place(c) != place({**s, "w": s["w"] or -1, "h": s["h"] or -1})
    ]
    with conn.cursor() as cur:
        cur.executemany(
            """
            UPDATE seats SET code = %s, x = %s, y = %s, rotation = %s, w = %s, h = %s, updated_at = now()
            WHERE id = %s
            """,
            changed,
        )
    # 3) 새 책상: 같은 묶음의 다른 좌석이 많이 속한 구역·유형을 따른다 (없으면 구역 없음·고정석)
    group_zone: dict[str, list[Any]] = {}
    for s in kept:
        group_zone.setdefault(cells[s["key"]]["group"], []).append((s["zone_id"], s["seat_type"]))

    def majority(group: str, index: int, default: Any) -> Any:
        values = [v[index] for v in group_zone.get(group, [])]
        return max(set(values), key=values.count) if values else default

    try:
        with conn.cursor() as cur:
            cur.executemany(
                """
                INSERT INTO seats (floor_id, zone_id, code, seat_type, x, y, rotation, w, h, plan_element_key)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                [
                    (
                        floor_id,
                        majority(cells[k]["group"], 0, None),
                        cells[k]["code"],
                        majority(cells[k]["group"], 1, "FIXED"),
                        round(cells[k]["x"], 6),
                        round(cells[k]["y"], 6),
                        cells[k]["rotation"],
                        round(cells[k]["w"], 6),
                        round(cells[k]["h"], 6),
                        k,
                    )
                    for k in impact["added"]
                ],
            )
    except errors.UniqueViolation:
        raise HTTPException(status_code=422, detail={"code": "SEAT_CODE_TAKEN"}) from None
    seat_id = {
        r["key"]: r["id"]
        for r in conn.execute(
            "SELECT id, plan_element_key AS key FROM seats WHERE floor_id = %s AND status <> 'REMOVED'",
            (floor_id,),
        ).fetchall()
    }

    # 4) 자리가 없어진 사람: 고른 자리로 (아니면 미배치)
    displaced = {p["emp_no"]: p for p in impact["people"]}
    moves = [(emp, key) for emp, key in people.items() if emp in displaced]
    targets = [key for _, key in moves]
    if not lenient and (len(set(targets)) != len(targets) or any(t not in cells for t in targets)):
        raise HTTPException(status_code=422, detail={"code": "BAD_TARGET"})
    occupied = {
        r["seat_id"]
        for r in conn.execute(
            f"""
            SELECT a.seat_id FROM seat_assignments a
            WHERE a.seat_id = ANY(%s) AND a.kind = 'FIXED' AND (a.ends_at IS NULL OR a.ends_at > now())
              AND ({_now()} OR a.starts_at > now())
            """,
            ([seat_id[t] for t in targets if t in seat_id],),
        ).fetchall()
    }
    if occupied and not lenient:
        raise HTTPException(status_code=409, detail={"code": "TARGET_TAKEN"})
    if lenient:
        used: set[str] = set()
        ok = []
        for emp, key in moves:
            if key in seat_id and key not in used and seat_id[key] not in occupied:
                used.add(key)
                ok.append((emp, key))
        moves = ok
    try:
        with conn.cursor() as cur:
            cur.executemany(
                """
                INSERT INTO seat_assignments (seat_id, employee_id, kind, starts_at, assigned_by, source)
                SELECT %s, e.id, 'FIXED', now(), %s, 'PLAN_PUBLISH' FROM employees e WHERE e.emp_no = %s
                """,
                [(seat_id[key], actor, emp) for emp, key in moves],
            )
    except errors.ExclusionViolation:
        raise HTTPException(status_code=409, detail={"code": "TARGET_TAKEN"}) from None

    # 5) 회의실: 빠지는 회의실은 비활성, 남는 회의실은 이름·정원·위치, 새 회의실은 추가. 이름은 임시 이름을 거친다
    all_rooms = impact["rooms"]
    gone = [r for r in all_rooms if r["key"] not in room_els]
    stay = [r for r in all_rooms if r["key"] in room_els]
    conn.execute(
        "UPDATE meeting_rooms SET is_active = false, updated_at = now() WHERE id = ANY(%s)",
        ([r["id"] for r in gone],),
    )
    conn.execute(
        "UPDATE meeting_rooms SET name = left(name, 80) || '~' || id WHERE id = ANY(%s)",
        ([r["id"] for r in stay],),
    )
    try:
        with conn.cursor() as cur:
            cur.executemany(
                """
                UPDATE meeting_rooms SET name = %s, capacity = %s, equipment = %s, shape = %s, updated_at = now()
                WHERE id = %s
                """,
                [
                    (e["name"], e["capacity"], e["equipment"], _json(e["shape"]), r["id"])
                    for r in stay
                    for e in [room_els[r["key"]]]
                ],
            )
            stay_keys = {r["key"] for r in stay}
            cur.executemany(
                """
                INSERT INTO meeting_rooms (floor_id, name, capacity, equipment, shape, plan_element_key, sort_order)
                VALUES (%s, %s, %s, %s, %s, %s,
                        (SELECT coalesce(max(sort_order), 0) + 1 FROM meeting_rooms WHERE floor_id = %s))
                """,
                [
                    (floor_id, e["name"], e["capacity"], e["equipment"], _json(e["shape"]), k, floor_id)
                    for k, e in room_els.items()
                    if k not in stay_keys
                ],
            )
    except errors.UniqueViolation:
        raise HTTPException(status_code=422, detail={"code": "ROOM_NAME_TAKEN"}) from None
    room_id = {
        r["key"]: r["id"]
        for r in conn.execute(
            "SELECT id, plan_element_key AS key FROM meeting_rooms WHERE floor_id = %s AND is_active",
            (floor_id,),
        ).fetchall()
    }
    cancelled = moved_reservations = 0
    for r in gone:
        action, to_key = rooms.get(r["id"], ("CANCEL", None))
        if action == "MOVE" and to_key not in room_id:
            if not lenient:
                raise HTTPException(status_code=422, detail={"code": "BAD_ROOM_TARGET"})
            action = "CANCEL"
        if action == "MOVE" and not lenient:
            try:
                moved_reservations += conn.execute(
                    """
                    UPDATE reservations SET room_id = %s, updated_at = now()
                    WHERE room_id = %s AND status = 'CONFIRMED' AND ends_at > now()
                    """,
                    (room_id[to_key], r["id"]),
                ).rowcount
            except errors.ExclusionViolation:
                raise HTTPException(status_code=409, detail={"code": "ROOM_TIME_TAKEN", "room": r["name"]}) from None
            continue
        upcoming = conn.execute(
            """
            SELECT id, title, starts_at, organizer_id FROM reservations
            WHERE room_id = %s AND status = 'CONFIRMED' AND ends_at > now()
            ORDER BY starts_at
            """,
            (r["id"],),
        ).fetchall()
        drop = []
        for x in upcoming:
            if action == "MOVE":
                # 예약마다 옮겨 보고, 같은 시간 예약이 있는 것만 취소한다
                try:
                    with conn.transaction():
                        conn.execute(
                            "UPDATE reservations SET room_id = %s, updated_at = now() WHERE id = %s",
                            (room_id[to_key], x["id"]),
                        )
                    moved_reservations += 1
                    continue
                except errors.ExclusionViolation:
                    pass
            drop.append(x)
        conn.execute(
            """
            UPDATE reservations SET status = 'CANCELLED', cancelled_at = now(), updated_at = now()
            WHERE id = ANY(%s)
            """,
            ([x["id"] for x in drop],),
        )
        cancelled += len(drop)
        with conn.cursor() as cur:
            cur.executemany(
                """
                INSERT INTO notifications (recipient_id, channel, type, payload)
                SELECT DISTINCT e, 'IN_APP', 'RESERVATION_CANCELLED',
                       jsonb_build_object('reservation_id', %s::bigint, 'title', %s::text,
                                          'starts_at', %s::timestamptz, 'reason', 'ROOM_REMOVED')
                FROM (SELECT employee_id AS e FROM reservation_attendees WHERE reservation_id = %s
                      UNION SELECT %s) t
                """,
                [(x["id"], x["title"], x["starts_at"], x["id"], x["organizer_id"]) for x in drop],
            )

    # 6) 도면: 이전 게시본은 보관본으로, 초안은 게시본으로. 도면 크기가 바뀌었을 수 있어 구역 모양을 다시 계산한다
    if published:
        conn.execute("UPDATE floor_plans SET status = 'ARCHIVED' WHERE id = %s", (published["id"],))
    conn.execute(
        """
        UPDATE floor_plans
        SET status = 'PUBLISHED', published_by = %s, published_at = now(), publish_note = %s,
            editing_by = NULL, editing_heartbeat_at = NULL, effective_at = NULL, publish_options = NULL
        WHERE id = %s
        """,
        (actor, note, plan_id),
    )
    conn.execute(
        """
        UPDATE zones SET shape = zone_auto_shape(id), updated_at = now()
        WHERE floor_id = %s AND is_active AND shape_mode = 'AUTO'
        """,
        (floor_id,),
    )

    # 7) 기록과 알림: 자리가 없어진 사람(새 자리 또는 미배치), 좌석 번호가 바뀐 사람
    moved_to = {emp: cells[key]["code"] for emp, key in moves}
    floor_name = plan["floor"]["name"]
    ids = {
        r["emp_no"]: r["id"]
        for r in conn.execute(
            "SELECT id, emp_no FROM employees WHERE emp_no = ANY(%s)", ([p["emp_no"] for p in impact["people"]],)
        ).fetchall()
    }
    notes = [
        (ids[p["emp_no"]], {"floor": floor_name, "seat": moved_to.get(p["emp_no"]), "from_seat": p["seat_code"]})
        for p in impact["people"]
    ] + [
        (s["occupant_id"], {"floor": floor_name, "seat": cells[s["key"]]["code"], "from_seat": s["code"]})
        for s in kept
        if s["occupant_id"] and cells[s["key"]]["code"] != s["code"]
    ]
    with conn.cursor() as cur:
        cur.executemany(
            """
            INSERT INTO notifications (recipient_id, channel, type, payload)
            VALUES (%s, 'IN_APP', 'SEAT_CHANGED', %s)
            """,
            [(emp, _json({**payload, "reason": "PLAN_PUBLISH"})) for emp, payload in notes],
        )
    result = {
        "version": plan["version"],
        **impact["summary"],
        "unassigned": len(impact["people"]) - len(moves),
        "reseated": len(moves),
        "rooms_removed": len(gone),
        "reservations_cancelled": cancelled,
        "reservations_moved": moved_reservations,
    }
    _audit(conn, actor, "PLAN_PUBLISH", plan_id, {**result, "scheduled": lenient}, ip)
    return result


# 예약한 게시 (서버 작업이 1분마다 부른다) -------------------------------------------


def apply_due_plans() -> list[dict[str, Any]]:
    """날짜가 된 게시 예약을 게시한다. 층마다 따로 하고, 하나가 실패해도 나머지는 한다.
    실패하면 그 초안을 다시 고칠 수 있게 돌리고 예약한 사람에게 알린다"""
    with pool.connection() as conn:
        due = [
            r["id"]
            for r in conn.execute(
                "SELECT id FROM floor_plans WHERE status = 'SCHEDULED' AND effective_at <= now() ORDER BY effective_at"
            ).fetchall()
        ]
    done = []
    for plan_id in due:
        try:
            with pool.connection() as conn:
                plan = _plan_select(conn, plan_id, skip_locked=True)
                if plan is None or plan["status"] != "SCHEDULED" or not plan["due"]:
                    continue  # 다른 서버가 하고 있거나 이미 했다
                plan = {**plan, "floor": _floor(conn, plan["floor_id"])}
                conn.execute("SELECT pg_advisory_xact_lock(%s, %s)", (LOCK_SEATING, plan["floor_id"]))
                options = plan["publish_options"] or {}
                people = {p["emp_no"]: p["to_key"] for p in options.get("people", []) if p.get("to_key")}
                rooms = {r["room_id"]: (r["action"], r.get("to_key")) for r in options.get("rooms", [])}
                impact = _impact(conn, plan)
                done.append(
                    _publish(
                        conn,
                        plan,
                        impact,
                        people,
                        rooms,
                        plan["publish_note"],
                        plan["scheduled_by"],
                        None,
                        lenient=True,
                    )
                )
        except Exception as error:  # noqa: BLE001 - 한 층이 실패해도 다른 층은 게시하고, 실패는 기록으로 남긴다
            log.exception("게시 예약 실패 (floor_plans.id=%s)", plan_id)
            detail = getattr(error, "detail", None) or str(error)
            with pool.connection() as conn:
                row = conn.execute(
                    """
                    UPDATE floor_plans SET status = 'DRAFT', effective_at = NULL
                    WHERE id = %s AND status = 'SCHEDULED'
                    RETURNING scheduled_by, version, floor_id
                    """,
                    (plan_id,),
                ).fetchone()
                if row is not None:
                    _audit(conn, row["scheduled_by"], "PLAN_SCHEDULE_FAILED", plan_id, {"error": detail}, None)
                    conn.execute(
                        """
                        INSERT INTO notifications (recipient_id, channel, type, payload)
                        VALUES (%s, 'IN_APP', 'PLAN_PUBLISH_FAILED', %s)
                        """,
                        (row["scheduled_by"], _json({"floor_id": row["floor_id"], "version": row["version"]})),
                    )
    return done


def _audit(conn: Connection, actor_id: int, action: str, plan_id: int, data: dict[str, Any], ip: str | None) -> None:
    conn.execute(
        """
        INSERT INTO audit_logs (actor_id, action, target_type, target_id, after_data, ip_address)
        VALUES (%s, %s, 'floor_plan', %s, %s, %s)
        """,
        (actor_id, action, plan_id, _json(data), ip),
    )


def _audit_floor(
    conn: Connection, actor_id: int, action: str, floor_id: int, data: dict[str, Any], ip: str | None
) -> None:
    conn.execute(
        """
        INSERT INTO audit_logs (actor_id, action, target_type, target_id, after_data, ip_address)
        VALUES (%s, %s, 'floor', %s, %s, %s)
        """,
        (actor_id, action, floor_id, _json(data), ip),
    )
