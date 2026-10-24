"""회의실 확인·예약(②) API: 하루 예약 현황표, 예약 만들기·취소, 내 예약."""

import datetime as dt
from typing import Any, Literal

import psycopg
from fastapi import APIRouter, HTTPException, Query
from psycopg import Connection
from pydantic import BaseModel, Field

from app.db import get_setting, pool
from app.session import CurrentUser

router = APIRouter(prefix="/api", tags=["rooms"])

# 한국은 서머타임이 없어 고정 +9시간으로 충분하다 (Windows는 시간대 DB가 없어 ZoneInfo를 쓰려면 패키지가 더 필요)
KST = dt.timezone(dt.timedelta(hours=9), "KST")
MAX_REPEAT_DAYS = 92  # 반복 예약은 석 달까지
MAX_OCCURRENCES = 60


def _minutes(hhmm: str) -> int:
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def _policy(conn: Connection) -> dict[str, int]:
    hours = get_setting(conn, "room.open_hours", {"start": "08:00", "end": "20:00"})
    return {
        "slot": int(get_setting(conn, "room.slot_minutes", 30)),
        "max": int(get_setting(conn, "room.max_minutes", 7 * 24 * 60)),
        "open_start": _minutes(hours["start"]),
        "open_end": _minutes(hours["end"]),
    }


def _at(day: dt.date, minutes: int) -> dt.datetime:
    return dt.datetime.combine(day, dt.time(), KST) + dt.timedelta(minutes=minutes)


def _error(status: int, code: str, **extra: Any) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, **extra})


@router.get("/rooms/day")
def rooms_day(user: CurrentUser, date: dt.date | None = None, site_id: int | None = None) -> dict[str, Any]:
    """한 사업장 회의실들의 하루 예약 현황. 시간은 모두 서울 기준 그날 0시부터 분(start_min, end_min)."""
    now = dt.datetime.now(KST)
    day = date or now.date()
    with pool.connection() as conn:
        policy = _policy(conn)
        if site_id is None:  # 내 자리가 있는 사업장, 없으면 첫 사업장
            row = conn.execute(
                """
                SELECT coalesce(
                    (SELECT f.site_id FROM seat_assignments a JOIN seats s ON s.id = a.seat_id
                     JOIN floors f ON f.id = s.floor_id
                     WHERE a.employee_id = %s AND a.starts_at <= now() AND (a.ends_at IS NULL OR a.ends_at > now())
                     ORDER BY a.kind = 'FIXED' DESC LIMIT 1),
                    (SELECT id FROM sites WHERE is_active ORDER BY sort_order, id LIMIT 1)) AS site_id
                """,
                (user["employee_id"],),
            ).fetchone()
            site_id = row["site_id"]
        site = conn.execute("SELECT id, name FROM sites WHERE id = %s AND is_active", (site_id,)).fetchone()
        if site is None:
            raise _error(404, "SITE_NOT_FOUND")

        rooms = conn.execute(
            """
            SELECT m.id, m.name, m.capacity, m.equipment, f.id AS floor_id, f.name AS floor_name
            FROM meeting_rooms m JOIN floors f ON f.id = m.floor_id AND f.is_active
            WHERE f.site_id = %s AND m.is_active
            ORDER BY f.sort_order, m.sort_order, m.id
            """,
            (site_id,),
        ).fetchall()

        day_start = _at(day, 0)
        bookings = conn.execute(
            """
            SELECT r.id, r.room_id, r.title, r.status, r.starts_at, r.ends_at,
                   greatest(0, extract(epoch FROM r.starts_at - %(start)s) / 60)::int AS start_min,
                   least(1440, extract(epoch FROM r.ends_at - %(start)s) / 60)::int AS end_min,
                   e.name AS organizer, d.name AS department,
                   (r.organizer_id = %(me)s OR EXISTS (
                       SELECT 1 FROM reservation_attendees ra
                       WHERE ra.reservation_id = r.id AND ra.employee_id = %(me)s)) AS mine
            FROM reservations r
            JOIN employees e ON e.id = r.organizer_id
            JOIN departments d ON d.id = e.department_id
            WHERE r.room_id = ANY(%(rooms)s) AND r.status = 'CONFIRMED'
              AND r.starts_at < %(end)s AND r.ends_at > %(start)s
            ORDER BY r.starts_at
            """,
            {
                "start": day_start,
                "end": day_start + dt.timedelta(days=1),
                "me": user["employee_id"],
                "rooms": [r["id"] for r in rooms],
            },
        ).fetchall()

    by_room: dict[int, list[dict[str, Any]]] = {r["id"]: [] for r in rooms}
    for b in bookings:
        by_room[b.pop("room_id")].append(b)
    return {
        "date": day.isoformat(),
        "today": now.date().isoformat(),
        # 오늘이면 지금 시각(분). 지난 칸을 막고 "지금" 선을 그린다
        "now_min": now.hour * 60 + now.minute if day == now.date() else None,
        "past": day < now.date(),
        "site": site,
        "policy": policy,
        "rooms": [
            {
                "id": r["id"],
                "name": r["name"],
                "capacity": r["capacity"],
                "equipment": r["equipment"],
                "floor": {"id": r["floor_id"], "name": r["floor_name"]},
                "bookings": by_room[r["id"]],
            }
            for r in rooms
        ],
    }


class ReservationIn(BaseModel):
    room_id: int
    date: dt.date  # 시작 날짜
    start_min: int = Field(ge=0, le=1440)
    end_date: dt.date | None = None  # 끝나는 날짜. 없으면 시작 날짜 (여러 날에 걸친 예약은 다른 날)
    end_min: int = Field(ge=0, le=1440)
    title: str = Field(max_length=200)
    attendees: list[str] = Field(default_factory=list, max_length=50)  # 사번
    repeat: Literal["NONE", "WEEKLY", "WEEKDAYS"] = "NONE"
    repeat_until: dt.date | None = None  # 반복할 때 마지막 날 (그날까지 포함)
    skip_conflicts: bool = False  # 반복 예약에서 이미 차 있는 날은 빼고 나머지만 예약
    notify: bool = True


def _occurrences(body: ReservationIn) -> list[dt.date]:
    if body.repeat == "NONE":
        return [body.date]
    until = body.repeat_until
    if until is None or until < body.date:
        raise _error(422, "INVALID_REPEAT")
    if (until - body.date).days > MAX_REPEAT_DAYS:
        raise _error(422, "REPEAT_TOO_LONG", max_days=MAX_REPEAT_DAYS)
    step = 7 if body.repeat == "WEEKLY" else 1
    days = [body.date + dt.timedelta(days=i) for i in range(0, (until - body.date).days + 1, step)]
    if body.repeat == "WEEKDAYS":
        days = [d for d in days if d.weekday() < 5]
    if not days:
        raise _error(422, "INVALID_REPEAT")
    return days[:MAX_OCCURRENCES]


def _check_request(
    conn: Connection,
    body: ReservationIn,
    user: dict[str, Any],
    span_days: int,
    first_day: dt.date,
    started_at: dt.datetime | None = None,
) -> tuple[dict[str, Any], list[int]]:
    """만들기·고치기 공통 확인: 시간 규칙, 회의실, 참석자. (회의실, 참석자 직원 id들)을 돌려준다.

    started_at: 고치는 예약의 원래 시작 시각. 이미 시작한 회의는 시작 시각을 그대로 두면 지난 시간이어도 된다.
    """
    policy = _policy(conn)
    slot = policy["slot"]
    length = span_days * 24 * 60 + body.end_min - body.start_min
    if (
        body.start_min % slot
        or body.end_min % slot
        or not policy["open_start"] <= body.start_min < policy["open_end"]
        or not policy["open_start"] <= body.end_min <= policy["open_end"]
        or length <= 0
    ):
        raise _error(422, "INVALID_TIME", **policy)
    if length > policy["max"]:
        raise _error(422, "TOO_LONG", max=policy["max"])
    # 지금 칸(예: 13:40이면 13:30 칸)부터 예약할 수 있다
    now = dt.datetime.now(KST)
    current_slot = now.replace(minute=now.minute - now.minute % slot, second=0, microsecond=0)
    starts_at = _at(first_day, body.start_min)
    if starts_at < current_slot and starts_at != started_at:
        raise _error(422, "IN_PAST")

    room = conn.execute("SELECT id, name FROM meeting_rooms WHERE id = %s AND is_active", (body.room_id,)).fetchone()
    if room is None:
        raise _error(404, "ROOM_NOT_FOUND")

    emp_nos = list(dict.fromkeys(body.attendees))
    attendees = conn.execute(
        "SELECT id, emp_no FROM employees WHERE emp_no = ANY(%s) AND employment_status = 'ACTIVE'", (emp_nos,)
    ).fetchall()
    unknown = set(emp_nos) - {a["emp_no"] for a in attendees}
    if unknown:
        raise _error(422, "UNKNOWN_ATTENDEE", emp_nos=sorted(unknown))
    return room, [a["id"] for a in attendees if a["id"] != user["employee_id"]]


@router.post("/reservations", status_code=201)
def create_reservation(body: ReservationIn, user: CurrentUser) -> dict[str, Any]:
    """예약을 만든다. 승인 절차 없이 바로 확정(CONFIRMED)된다.

    여러 날에 걸쳐 잡을 수 있다 (예: 10-26 10:00 ~ 10-28 11:00). 시작·끝 시각은 각각 그날 운영 시간 안,
    전체 길이는 room.max_minutes(기본 7일)까지. 반복 예약은 하루 안의 예약만 된다.
    반복 예약은 회차마다 한 행씩 만들고, 한 회차라도 겹치면 아무것도 만들지 않고 겹치는 날짜를 알려 준다
    (skip_conflicts면 겹치는 날만 빼고 만든다).
    """
    title = body.title.strip()
    if not title:
        raise _error(422, "TITLE_REQUIRED")
    span_days = ((body.end_date or body.date) - body.date).days
    if span_days < 0:
        raise _error(422, "INVALID_TIME")
    if span_days > 0 and body.repeat != "NONE":
        raise _error(422, "REPEAT_SINGLE_DAY")
    days = _occurrences(body)

    with pool.connection() as conn:
        room, attendee_ids = _check_request(conn, body, user, span_days, days[0])
        spans = [(_at(d, body.start_min), _at(d + dt.timedelta(days=span_days), body.end_min)) for d in days]
        taken = conn.execute(
            """
            SELECT DISTINCT r.id, r.title, r.starts_at, r.ends_at,
                   (r.starts_at AT TIME ZONE 'Asia/Seoul')::date AS day
            FROM reservations r, unnest(%(starts)s::timestamptz[], %(ends)s::timestamptz[]) AS w(s, e)
            WHERE r.room_id = %(room)s AND r.status = 'CONFIRMED' AND r.starts_at < w.e AND r.ends_at > w.s
            ORDER BY r.starts_at
            """,
            {
                "starts": [s for s, _ in spans],
                "ends": [e for _, e in spans],
                "room": room["id"],
            },
        ).fetchall()
        skipped: list[str] = []
        if taken and body.repeat != "NONE" and body.skip_conflicts:
            clash = {t["day"] for t in taken}
            skipped = sorted(d.isoformat() for d in clash)
            kept = [(d, span) for d, span in zip(days, spans, strict=True) if d not in clash]
            days = [d for d, _ in kept]
            spans = [span for _, span in kept]
            taken = [] if days else taken
        if taken:
            raise _error(
                409,
                "TIME_TAKEN",
                dates=sorted({t["day"].isoformat() for t in taken}),
                conflicts=[
                    {"title": t["title"], "starts_at": t["starts_at"].isoformat(), "ends_at": t["ends_at"].isoformat()}
                    for t in taken[:5]
                ],
            )

        try:
            with conn.transaction():
                series_id = None
                if body.repeat != "NONE":
                    series_id = conn.execute(
                        """
                        INSERT INTO reservation_series (room_id, organizer_id, title, repeat_rule,
                                                        start_time, end_time, first_date, last_date)
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s) RETURNING id
                        """,
                        (
                            room["id"],
                            user["employee_id"],
                            title,
                            body.repeat,
                            dt.time(*divmod(body.start_min, 60)),
                            dt.time(*divmod(body.end_min, 60)) if body.end_min < 1440 else dt.time(23, 59),
                            days[0],
                            days[-1],
                        ),
                    ).fetchone()["id"]
                ids = []
                for starts_at, ends_at in spans:
                    ids.append(
                        conn.execute(
                            """
                            INSERT INTO reservations (room_id, organizer_id, series_id, title, starts_at, ends_at,
                                                      notify_attendees)
                            VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING id
                            """,
                            (room["id"], user["employee_id"], series_id, title, starts_at, ends_at, body.notify),
                        ).fetchone()["id"]
                    )
                if attendee_ids:
                    conn.execute(
                        """
                        INSERT INTO reservation_attendees (reservation_id, employee_id)
                        SELECT r, e FROM unnest(%s::bigint[]) AS r, unnest(%s::bigint[]) AS e
                        """,
                        (ids, attendee_ids),
                    )
                if body.notify and attendee_ids:
                    # 메신저 연동 전이라 화면 알림으로 쌓아 둔다 (첫 회차 기준)
                    conn.execute(
                        """
                        INSERT INTO notifications (recipient_id, channel, type, payload)
                        SELECT e, 'IN_APP', 'RESERVATION_INVITE',
                               jsonb_build_object('reservation_id', %s::bigint, 'title', %s::text,
                                                  'starts_at', %s::timestamptz, 'occurrences', %s::int)
                        FROM unnest(%s::bigint[]) AS e
                        """,
                        (ids[0], title, spans[0][0], len(ids), attendee_ids),
                    )
        except psycopg.errors.ExclusionViolation:
            # 검사한 뒤 저장하기 전에 누가 먼저 예약했다
            raise _error(409, "TIME_TAKEN", dates=[]) from None

    return {
        "count": len(ids),
        "skipped": skipped,
        "room": room["name"],
        "first": {"id": ids[0], "starts_at": spans[0][0], "ends_at": spans[0][1]},
    }


@router.put("/reservations/{reservation_id}")
def update_reservation(reservation_id: int, body: ReservationIn, user: CurrentUser) -> dict[str, Any]:
    """예약 한 건(반복 예약이면 이 회차만)을 고친다: 회의실, 일시, 제목, 참석자. 만든 사람만, 끝나기 전에만.

    다시 만들지 않고 고치므로 참석자에게 취소 알림 + 새 초대가 가지 않고, 변경 알림 한 번만 쌓인다.
    """
    title = body.title.strip()
    if not title:
        raise _error(422, "TITLE_REQUIRED")
    span_days = ((body.end_date or body.date) - body.date).days
    if span_days < 0:
        raise _error(422, "INVALID_TIME")
    if body.repeat != "NONE":
        raise _error(422, "EDIT_NO_REPEAT")

    with pool.connection() as conn:
        row = conn.execute(
            """
            SELECT organizer_id, status, starts_at, ends_at > now() AS open
            FROM reservations WHERE id = %s FOR UPDATE
            """,
            (reservation_id,),
        ).fetchone()
        if row is None:
            raise _error(404, "RESERVATION_NOT_FOUND")
        if row["organizer_id"] != user["employee_id"]:
            raise _error(403, "NOT_ORGANIZER")
        if row["status"] != "CONFIRMED" or not row["open"]:
            raise _error(409, "NOT_EDITABLE")
        room, attendee_ids = _check_request(conn, body, user, span_days, body.date, row["starts_at"])
        starts_at = _at(body.date, body.start_min)
        ends_at = _at(body.date + dt.timedelta(days=span_days), body.end_min)
        taken = conn.execute(
            """
            SELECT r.id, r.title, r.starts_at, r.ends_at FROM reservations r
            WHERE r.room_id = %s AND r.status = 'CONFIRMED' AND r.id <> %s AND r.starts_at < %s AND r.ends_at > %s
            ORDER BY r.starts_at LIMIT 5
            """,
            (room["id"], reservation_id, ends_at, starts_at),
        ).fetchall()
        if taken:
            raise _error(
                409,
                "TIME_TAKEN",
                dates=sorted({t["starts_at"].astimezone(KST).date().isoformat() for t in taken}),
                conflicts=[
                    {"title": t["title"], "starts_at": t["starts_at"].isoformat(), "ends_at": t["ends_at"].isoformat()}
                    for t in taken
                ],
            )
        try:
            with conn.transaction():
                conn.execute(
                    """
                    UPDATE reservations
                    SET room_id = %s, title = %s, starts_at = %s, ends_at = %s, notify_attendees = %s,
                        updated_at = now()
                    WHERE id = %s
                    """,
                    (room["id"], title, starts_at, ends_at, body.notify, reservation_id),
                )
                conn.execute("DELETE FROM reservation_attendees WHERE reservation_id = %s", (reservation_id,))
                if attendee_ids:
                    conn.execute(
                        """
                        INSERT INTO reservation_attendees (reservation_id, employee_id)
                        SELECT %s, e FROM unnest(%s::bigint[]) AS e
                        """,
                        (reservation_id, attendee_ids),
                    )
                if body.notify and attendee_ids:
                    conn.execute(
                        """
                        INSERT INTO notifications (recipient_id, channel, type, payload)
                        SELECT e, 'IN_APP', 'RESERVATION_UPDATED',
                               jsonb_build_object('reservation_id', %s::bigint, 'title', %s::text,
                                                  'starts_at', %s::timestamptz)
                        FROM unnest(%s::bigint[]) AS e
                        """,
                        (reservation_id, title, starts_at, attendee_ids),
                    )
        except psycopg.errors.ExclusionViolation:
            raise _error(409, "TIME_TAKEN", dates=[]) from None
    return {"id": reservation_id, "room": room["name"], "starts_at": starts_at, "ends_at": ends_at}


@router.get("/rooms/{room_id}/conflicts")
def room_conflicts(
    room_id: int,
    user: CurrentUser,
    start_date: dt.date,
    start_min: int = Query(ge=0, le=1440),
    end_date: dt.date | None = None,
    end_min: int = Query(ge=0, le=1440),
    exclude: int | None = None,
) -> dict[str, Any]:
    """그 시간(여러 날도 됨)에 이 회의실에 이미 잡힌 예약. 예약 폼이 여러 날 예약을 고를 때 미리 보여 준다.

    exclude: 고치고 있는 예약 (자기 자신과는 겹치지 않는다)"""
    starts_at = _at(start_date, start_min)
    ends_at = _at(end_date or start_date, end_min)
    if ends_at <= starts_at:
        return {"conflicts": []}
    with pool.connection() as conn:
        rows = conn.execute(
            """
            SELECT r.id, r.title, r.starts_at, r.ends_at, e.name AS organizer, d.name AS department
            FROM reservations r
            JOIN employees e ON e.id = r.organizer_id
            JOIN departments d ON d.id = e.department_id
            WHERE r.room_id = %s AND r.status = 'CONFIRMED' AND r.starts_at < %s AND r.ends_at > %s
              AND r.id IS DISTINCT FROM %s
            ORDER BY r.starts_at
            LIMIT 20
            """,
            (room_id, ends_at, starts_at, exclude),
        ).fetchall()
    return {"conflicts": rows}


@router.get("/reservations/mine")
def my_reservations(
    user: CurrentUser,
    scope: Literal["upcoming", "past"] = "upcoming",
    limit: int = Query(default=50, ge=1, le=200),
) -> dict[str, Any]:
    """내가 만들었거나 참석하는 예약.

    upcoming: 아직 끝나지 않은 예약, 가까운 순. 최근 7일 안에 취소된 것도 "취소됨"으로 남겨 둔다
    (초대받은 회의가 말없이 사라지면 취소인지 원래 없던 건지 알 수 없다).
    past: 최근 30일 안에 끝났거나, 그보다 전에 취소된 예약, 최근 순.
    """
    upcoming = (
        "r.ends_at > now() AND (r.status = 'CONFIRMED'"
        " OR (r.status = 'CANCELLED' AND r.cancelled_at > now() - interval '7 days'))"
    )
    where = (
        upcoming
        if scope == "upcoming"
        else f"(r.ends_at <= now() OR r.status <> 'CONFIRMED') AND NOT ({upcoming})"
        " AND r.starts_at > now() - interval '30 days'"
    )
    order = "r.starts_at" if scope == "upcoming" else "r.starts_at DESC"
    with pool.connection() as conn:
        rows = conn.execute(
            f"""
            SELECT r.id, r.title, r.starts_at, r.ends_at, r.status, r.series_id, r.cancelled_at,
                   m.name AS room, f.id AS floor_id, f.name AS floor,
                   r.organizer_id = %(me)s AS is_organizer, e.name AS organizer, d.name AS organizer_department,
                   (SELECT count(*) FROM reservation_attendees ra WHERE ra.reservation_id = r.id)::int AS attendees
            FROM reservations r
            JOIN meeting_rooms m ON m.id = r.room_id
            JOIN floors f ON f.id = m.floor_id
            JOIN employees e ON e.id = r.organizer_id
            JOIN departments d ON d.id = e.department_id
            WHERE {where}
              AND (r.organizer_id = %(me)s OR EXISTS (
                  SELECT 1 FROM reservation_attendees ra
                  WHERE ra.reservation_id = r.id AND ra.employee_id = %(me)s))
            ORDER BY {order}
            LIMIT %(limit)s
            """,
            {"me": user["employee_id"], "limit": limit},
        ).fetchall()
    return {"reservations": rows}


@router.get("/reservations/{reservation_id}")
def reservation_detail(reservation_id: int, user: CurrentUser) -> dict[str, Any]:
    """예약 한 건의 자세한 내용: 회의실, 시간, 만든 사람, 참석자(재실 상태 포함), 반복 규칙."""
    with pool.connection() as conn:
        row = conn.execute(
            """
            SELECT r.id, r.title, r.starts_at, r.ends_at, r.status, r.created_at, r.checked_in_at, r.cancelled_at,
                   r.ends_at > now() AS open, r.series_id, m.id AS room_id,
                   (SELECT count(*) FROM reservations o
                    WHERE o.series_id = r.series_id AND o.status = 'CONFIRMED' AND o.starts_at >= r.starts_at
                   )::int AS series_left,
                   m.name AS room, m.capacity, m.equipment, f.id AS floor_id, f.name AS floor, si.name AS site,
                   e.id AS organizer_id, e.emp_no, e.name, e.rank_name, d.name AS department, e.extension, e.email,
                   s.repeat_rule, s.first_date, s.last_date
            FROM reservations r
            JOIN meeting_rooms m ON m.id = r.room_id
            JOIN floors f ON f.id = m.floor_id
            JOIN sites si ON si.id = f.site_id
            JOIN employees e ON e.id = r.organizer_id
            JOIN departments d ON d.id = e.department_id
            LEFT JOIN reservation_series s ON s.id = r.series_id
            WHERE r.id = %s
            """,
            (reservation_id,),
        ).fetchone()
        if row is None:
            raise _error(404, "RESERVATION_NOT_FOUND")
        attendees = conn.execute(
            """
            SELECT e.emp_no, e.name, e.rank_name AS rank, d.name AS department, e.id = %(me)s AS is_me,
                   z.color_key, CASE WHEN p.expires_at IS NULL OR p.expires_at > now() THEN p.status END AS presence
            FROM reservation_attendees ra
            JOIN employees e ON e.id = ra.employee_id
            JOIN departments d ON d.id = e.department_id
            LEFT JOIN LATERAL (
                SELECT s.zone_id FROM seat_assignments a JOIN seats s ON s.id = a.seat_id
                WHERE a.employee_id = e.id AND a.starts_at <= now() AND (a.ends_at IS NULL OR a.ends_at > now())
                ORDER BY a.kind = 'FIXED' DESC LIMIT 1
            ) cur ON true
            LEFT JOIN zones z ON z.id = cur.zone_id
            LEFT JOIN presence_status p ON p.employee_id = e.id
            WHERE ra.reservation_id = %(id)s
            ORDER BY d.name, e.name
            """,
            {"id": reservation_id, "me": user["employee_id"]},
        ).fetchall()

    is_organizer = row["organizer_id"] == user["employee_id"]
    return {
        "id": row["id"],
        "title": row["title"],
        "starts_at": row["starts_at"],
        "ends_at": row["ends_at"],
        "status": row["status"],
        "created_at": row["created_at"],
        "checked_in_at": row["checked_in_at"],
        "cancelled_at": row["cancelled_at"],
        "room": {
            "id": row["room_id"],
            "name": row["room"],
            "capacity": row["capacity"],
            "equipment": row["equipment"],
            "floor_id": row["floor_id"],
            "floor": row["floor"],
            "site": row["site"],
        },
        "organizer": {
            "emp_no": row["emp_no"],
            "name": row["name"],
            "rank": row["rank_name"],
            "department": row["department"],
            "extension": row["extension"],
            "email": row["email"],
        },
        "attendees": attendees,
        "series": (
            {
                "repeat": row["repeat_rule"],
                "first_date": row["first_date"],
                "last_date": row["last_date"],
                # 이 회차를 포함해 앞으로 남은 확정 회차 수 (이후 회차 모두 취소할 때 알려 준다)
                "left": row["series_left"],
            }
            if row["repeat_rule"]
            else None
        ),
        "ended": not row["open"],
        "is_organizer": is_organizer,
        "can_cancel": is_organizer and row["status"] == "CONFIRMED" and row["open"],
    }


@router.delete("/reservations/{reservation_id}")
def cancel_reservation(
    reservation_id: int, user: CurrentUser, scope: Literal["one", "following"] = "one"
) -> dict[str, Any]:
    """예약을 취소한다. 만든 사람만, 끝나기 전에만.

    반복 예약은 이 회차만(one), 또는 이 회차와 그 뒤 회차 모두(following). 참석자에게 취소 알림을 쌓아 둔다.
    """
    with pool.connection() as conn:
        row = conn.execute(
            """
            SELECT organizer_id, status, series_id, starts_at, title, notify_attendees, ends_at > now() AS open
            FROM reservations WHERE id = %s FOR UPDATE
            """,
            (reservation_id,),
        ).fetchone()
        if row is None:
            raise _error(404, "RESERVATION_NOT_FOUND")
        if row["organizer_id"] != user["employee_id"]:
            raise _error(403, "NOT_ORGANIZER")
        if row["status"] != "CONFIRMED" or not row["open"]:
            raise _error(409, "NOT_CANCELLABLE")
        following = scope == "following" and row["series_id"] is not None
        cancelled = conn.execute(
            """
            UPDATE reservations SET status = 'CANCELLED', cancelled_at = now(), updated_at = now()
            WHERE status = 'CONFIRMED' AND ends_at > now()
              AND (id = %(id)s OR (%(following)s AND series_id = %(series)s AND starts_at >= %(from)s))
            RETURNING id
            """,
            {"id": reservation_id, "following": following, "series": row["series_id"], "from": row["starts_at"]},
        ).fetchall()
        if row["notify_attendees"]:
            # 메신저 연동 전이라 화면 알림으로 쌓아 둔다 (초대 알림과 같은 방식)
            conn.execute(
                """
                INSERT INTO notifications (recipient_id, channel, type, payload)
                SELECT DISTINCT ra.employee_id, 'IN_APP', 'RESERVATION_CANCELLED',
                       jsonb_build_object('reservation_id', %s::bigint, 'title', %s::text,
                                          'starts_at', %s::timestamptz, 'occurrences', %s::int)
                FROM reservation_attendees ra WHERE ra.reservation_id = ANY(%s)
                """,
                (reservation_id, row["title"], row["starts_at"], len(cancelled), [c["id"] for c in cancelled]),
            )
    return {"cancelled": len(cancelled)}
