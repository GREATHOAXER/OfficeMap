"""AI 도우미: 사람·자리·재실·회의실·업무 담당을 도구로 읽어 답하는 Claude 대화.

화면(자리·재실 현황의 AI 도우미 패널, 회의실 예약 폼의 AI 추천) → POST /api/ai/chat (routers/ai.py) → run_turn().
모델이 도구를 부르면 여기서 질문한 사람으로 DB를 읽어 결과를 돌려주고, 모델이 답을 끝낼 때까지 되풀이한다.
예약은 하지 않는다: propose_reservation은 "예약 제안" 카드를 화면에 보내기만 하고, 사람이 눌러야 예약 API로 잡힌다.

제공처 (config.ai_provider, 서버 환경변수 AI_PROVIDER)
  anthropic  Anthropic API. ANTHROPIC_API_KEY
  bedrock    Amazon Bedrock. 서버의 IAM 역할(또는 AWS 키)과 AWS_REGION
대화는 ai_conversations·ai_messages에 남는다 (모델에 다시 보낼 원문은 blocks).
스키마: db/schema/08_ai.sql, 13_ai_chat.sql
"""

import datetime as dt
import json
import logging
import uuid
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any

import anthropic
from fastapi import HTTPException
from psycopg import Connection
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field, ValidationError

from app.config import settings
from app.db import pool
from app.people_order import person_order
from app.routers.employees import NO_WINDOW, TimeWindow, find_employees
from app.routers.employees import search as search_employees
from app.routers.rooms import KST, ReservationIn, _at, _check_request, _policy

log = logging.getLogger(__name__)

PROVIDERS: dict[str, dict[str, str]] = {
    "anthropic": {"label": "Anthropic API", "model": "claude-opus-5-5"},
    "bedrock": {"label": "Amazon Bedrock", "model": "anthropic.claude-opus-5-5"},
}
EFFORTS = ("low", "medium", "high", "xhigh", "max")
MAX_STEPS = 8  # 질문 하나에 모델을 부르는 최대 횟수 (도구를 부르고 다시 묻기를 되풀이)
MAX_TOKENS = 16000  # 응답 하나의 상한 (생각 포함). 답은 보통 수백 토큰
MAX_ROWS = 80  # 대화 하나에 쌓을 수 있는 줄 수. 넘으면 새 대화를 열게 한다 (길어질수록 느리고 비싸다)
PROPOSAL_LIMIT = 3  # 질문 하나에 보여 줄 예약 제안 수

WEEKDAYS = "월화수목금토일"
PRESENCE = {"AVAILABLE": "방문 가능", "DO_NOT_DISTURB": "방해 금지", "IN_MEETING": "회의 중", "AWAY": "부재"}
ABSENCE = {"LEAVE": "휴가", "BUSINESS_TRIP": "출장·외근", "REMOTE": "재택"}


# 설정 ------------------------------------------------------------------------------------------------


def provider() -> str:
    return settings.ai_provider.strip().lower()


def model() -> str:
    return settings.ai_model.strip() or PROVIDERS.get(provider(), {}).get("model", "")


def status() -> dict[str, Any]:
    """화면이 AI를 켤지 정한다. 꺼져 있으면 reason: OFF(설정 안 함) · UNKNOWN_PROVIDER · NO_KEY"""
    info = PROVIDERS.get(provider())
    if info is None:
        return {"enabled": False, "reason": "OFF" if not provider() else "UNKNOWN_PROVIDER"}
    if provider() == "anthropic" and not settings.anthropic_api_key:
        return {"enabled": False, "reason": "NO_KEY"}
    return {"enabled": True, "provider": provider(), "label": info["label"], "model": model()}


@lru_cache(maxsize=1)
def _client() -> Any:
    timeout = anthropic.Timeout(120.0, connect=10.0)
    if provider() == "bedrock":
        return anthropic.AnthropicBedrockMantle(aws_region=settings.aws_region, timeout=timeout)
    return anthropic.Anthropic(api_key=settings.anthropic_api_key, timeout=timeout)


# 시험(scripts/check_ai.py 등)에서 가짜 모델로 바꿔 끼울 수 있게
client_factory: Callable[[], Any] = _client


# 도구 ------------------------------------------------------------------------------------------------


@dataclass
class Context:
    user: dict[str, Any]  # 로그인한 직원 (session.load_session)
    now: dt.datetime  # 서울 시각
    site_id: int | None = None  # 화면에서 보고 있는 사업장 (회의실 예약 폼)
    events: list[dict[str, Any]] = field(default_factory=list)  # 화면에 보낼 것 (예약 제안)


class ToolError(Exception):
    """모델에 is_error로 돌려줄 설명 (모델이 고쳐서 다시 부를 수 있게)"""


class SearchPeople(BaseModel):
    query: str = Field(
        description="이름, 사번, 부서·팀 이름, 또는 하는 일 키워드. 띄어 쓴 낱말은 모두 맞아야 한다 "
        "(예: '조시우', '재무팀', '법인카드')"
    )


class FindFreeRooms(BaseModel):
    date: dt.date = Field(description="날짜 (YYYY-MM-DD)")
    start: str = Field(description="시작 시각 HH:MM (24시간)")
    end: str = Field(description="끝 시각 HH:MM (24시간)")
    min_capacity: int | None = Field(
        default=None, description="최소 정원 = 참석 인원 (질문한 사람 포함). 모르면 비운다"
    )
    floor: str | None = Field(default=None, description="층 (예: '7F'). 비우면 모든 층")
    site: str | None = Field(default=None, description="사업장 이름. 비우면 질문한 사람의 사업장")


class RoomSchedule(BaseModel):
    date: dt.date = Field(description="날짜 (YYYY-MM-DD)")
    floor: str | None = Field(default=None, description="층 (예: '7F'). 비우면 모든 층")
    room: str | None = Field(default=None, description="회의실 이름 일부 (예: '701'). 비우면 모든 회의실")
    site: str | None = Field(default=None, description="사업장 이름. 비우면 질문한 사람의 사업장")


class PeopleSchedules(BaseModel):
    emp_nos: list[str] = Field(description="사번 목록 (search_people로 찾은 값, 질문한 사람도 넣을 수 있음). 10명까지")
    date: dt.date = Field(description="날짜 (YYYY-MM-DD)")


class FindDutyOwner(BaseModel):
    keyword: str = Field(description="업무 이름이나 키워드 (예: '법인카드', '세금계산서')")


class ProposeReservation(BaseModel):
    room_id: int = Field(description="회의실 ID (find_free_rooms·room_schedule 결과의 room_id)")
    date: dt.date = Field(description="날짜 (YYYY-MM-DD)")
    start: str = Field(description="시작 시각 HH:MM")
    end: str = Field(description="끝 시각 HH:MM")
    title: str = Field(description="회의 제목. 짧게 (예: '예산 검토'). 모르면 '회의'")
    attendee_emp_nos: list[str] = Field(description="참석자 사번 (질문한 사람은 빼고). 없으면 빈 목록")


def _hhmm(text: str) -> int:
    try:
        h, m = text.strip().split(":")
        minutes = int(h) * 60 + int(m)
    except ValueError:
        raise ToolError(f"시각은 HH:MM으로 주세요: {text!r}") from None
    if not 0 <= minutes <= 24 * 60:
        raise ToolError(f"시각이 하루를 벗어나요: {text!r}")
    return minutes


def _clock(minutes: int) -> str:
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def _day_text(day: dt.date) -> str:
    return f"{day.isoformat()}({WEEKDAYS[day.weekday()]})"


def _floor_name(text: str | None) -> str | None:
    """'7층'·'7f'·'7' → '7F'"""
    if not text:
        return None
    name = text.strip().upper().removesuffix("층").strip()
    return f"{name}F" if name.isdigit() else name


def _site(conn: Connection, ctx: Context, name: str | None) -> dict[str, Any]:
    """사업장: 이름을 줬으면 그것, 아니면 화면에서 보던 곳, 아니면 내 자리가 있는 곳, 아니면 첫 사업장"""
    if name:
        row = conn.execute(
            "SELECT id, name FROM sites WHERE is_active AND name ILIKE %s ORDER BY sort_order LIMIT 1",
            (f"%{name.strip()}%",),
        ).fetchone()
        if row is None:
            names = [r["name"] for r in conn.execute("SELECT name FROM sites WHERE is_active ORDER BY sort_order")]
            raise ToolError(f"'{name}' 사업장이 없어요. 있는 사업장: {', '.join(names)}")
        return row
    row = conn.execute(
        """
        SELECT s.id, s.name FROM sites s WHERE s.is_active AND s.id = coalesce(
            %(site)s,
            (SELECT f.site_id FROM seat_assignments a
             JOIN seats st ON st.id = a.seat_id JOIN floors f ON f.id = st.floor_id
             WHERE a.employee_id = %(me)s AND a.starts_at <= now() AND (a.ends_at IS NULL OR a.ends_at > now())
             ORDER BY a.kind = 'FIXED' DESC LIMIT 1),
            (SELECT id FROM sites WHERE is_active ORDER BY sort_order, id LIMIT 1))
        """,
        {"site": ctx.site_id, "me": ctx.user["employee_id"]},
    ).fetchone()
    if row is None:
        raise ToolError("사업장이 없어요")
    return row


def _free_gaps(busy: list[tuple[int, int]], open_start: int, open_end: int, after: int | None) -> list[str]:
    """예약 가능 시간(open_start~open_end) 중 busy와 겹치지 않는 구간. after가 있으면 그 뒤만 (오늘)"""
    start = max(open_start, after) if after is not None else open_start
    gaps = []
    for b_start, b_end in sorted(busy):
        if b_start > start:
            gaps.append((start, min(b_start, open_end)))
        start = max(start, b_end)
    if start < open_end:
        gaps.append((start, open_end))
    return [f"{_clock(a)}-{_clock(b)}" for a, b in gaps if b > a]


def _person(hit: dict[str, Any]) -> dict[str, Any]:
    seat = hit["seat"]
    busy = hit["busy"]
    presence = hit["presence"]
    return {
        "emp_no": hit["emp_no"],
        "name": hit["name"],
        "rank": hit["rank"],
        "department": " ".join(x for x in (hit["division"], hit["department"]) if x),
        "seat": f"{seat['site_name']} {seat['floor_name']} {seat['code']}" if seat else None,
        # 상태를 따로 정하지 않았으면 null (자리에 있는지는 모름)
        "presence": (
            PRESENCE.get(presence["status"], presence["status"])
            + (f" — {presence['message']}" if presence["message"] else "")
            if presence
            else None
        ),
        "now_in_meeting": (
            {"title": busy["title"], "until": busy["ends_at"].astimezone(KST).strftime("%H:%M")} if busy else None
        ),
        "absence_now": ABSENCE.get(hit["absence"] or "", hit["absence"]),
        "extension": hit["extension"],
        "headline": hit.get("headline"),
        "matched_by": hit.get("matched"),
        "is_me": hit["is_me"],
    }


def search_people(ctx: Context, a: SearchPeople) -> dict[str, Any]:
    minute = ctx.now.hour * 60 + ctx.now.minute
    window = TimeWindow(
        date=ctx.now.date(), start_min=minute, end_date=None, end_min=min(minute + 1, 1440), exclude=None
    )
    hits = search_employees(user=ctx.user, window=window, q=a.query.strip()[:50], limit=8)["results"]
    return {"people": [_person(h) for h in hits], "more_may_exist": len(hits) == 8}


def find_free_rooms(ctx: Context, a: FindFreeRooms) -> dict[str, Any]:
    start, end = _hhmm(a.start), _hhmm(a.end)
    if end <= start:
        raise ToolError("끝 시각이 시작 시각보다 늦어야 해요")
    with pool.connection() as conn:
        site = _site(conn, ctx, a.site)
        policy = _policy(conn)
        rooms = conn.execute(
            """
            SELECT m.id AS room_id, m.name, f.name AS floor, m.capacity, m.equipment
            FROM meeting_rooms m JOIN floors f ON f.id = m.floor_id AND f.is_active
            WHERE f.site_id = %(site)s AND m.is_active
              AND (%(floor)s::text IS NULL OR f.name = %(floor)s)
              AND m.capacity >= %(capacity)s
              AND NOT EXISTS (
                  SELECT 1 FROM reservations r
                  WHERE r.room_id = m.id AND r.status = 'CONFIRMED' AND r.starts_at < %(end)s AND r.ends_at > %(start)s)
            ORDER BY m.capacity, f.sort_order, m.sort_order, m.id
            LIMIT 20
            """,
            {
                "site": site["id"],
                "floor": _floor_name(a.floor),
                "capacity": a.min_capacity or 0,
                "start": _at(a.date, start),
                "end": _at(a.date, end),
            },
        ).fetchall()
    notes = []
    if start % policy["slot"] or end % policy["slot"]:
        notes.append(f"예약은 {policy['slot']}분 단위예요")
    if start < policy["open_start"] or end > policy["open_end"]:
        notes.append(f"예약할 수 있는 시간은 {_clock(policy['open_start'])}-{_clock(policy['open_end'])}이에요")
    if _at(a.date, end) <= ctx.now:
        notes.append("이미 지난 시간이에요")
    return {
        "site": site["name"],
        "when": f"{_day_text(a.date)} {_clock(start)}-{_clock(end)}",
        "free_rooms": rooms,
        "notes": notes,
    }


def room_schedule(ctx: Context, a: RoomSchedule) -> dict[str, Any]:
    with pool.connection() as conn:
        site = _site(conn, ctx, a.site)
        policy = _policy(conn)
        day_start = _at(a.date, 0)
        rooms = conn.execute(
            """
            SELECT m.id AS room_id, m.name, f.name AS floor, m.capacity, m.equipment,
                   coalesce((
                       SELECT json_agg(json_build_object(
                                  'start_min', greatest(0, extract(epoch FROM r.starts_at - %(day)s) / 60)::int,
                                  'end_min', least(1440, extract(epoch FROM r.ends_at - %(day)s) / 60)::int,
                                  'title', r.title, 'organizer', e.name) ORDER BY r.starts_at)
                       FROM reservations r JOIN employees e ON e.id = r.organizer_id
                       WHERE r.room_id = m.id AND r.status = 'CONFIRMED'
                         AND r.starts_at < %(day)s + interval '1 day' AND r.ends_at > %(day)s), '[]') AS bookings
            FROM meeting_rooms m JOIN floors f ON f.id = m.floor_id AND f.is_active
            WHERE f.site_id = %(site)s AND m.is_active
              AND (%(floor)s::text IS NULL OR f.name = %(floor)s)
              AND (%(room)s::text IS NULL OR m.name ILIKE %(room)s)
            ORDER BY f.sort_order, m.sort_order, m.id
            LIMIT 15
            """,
            {
                "site": site["id"],
                "day": day_start,
                "floor": _floor_name(a.floor),
                "room": f"%{a.room.strip()}%" if a.room else None,
            },
        ).fetchall()
    after = ctx.now.hour * 60 + ctx.now.minute if a.date == ctx.now.date() else None
    out = []
    for r in rooms:
        bookings = r.pop("bookings")
        busy = [(b["start_min"], b["end_min"]) for b in bookings]
        out.append(
            {
                **r,
                "bookings": [
                    {
                        "time": f"{_clock(b['start_min'])}-{_clock(b['end_min'])}",
                        "title": b["title"],
                        "by": b["organizer"],
                    }
                    for b in bookings
                ],
                "free": _free_gaps(busy, policy["open_start"], policy["open_end"], after),
            }
        )
    return {"site": site["name"], "date": _day_text(a.date), "rooms": out}


def people_schedules(ctx: Context, a: PeopleSchedules) -> dict[str, Any]:
    emp_nos = list(dict.fromkeys(e.strip() for e in a.emp_nos))[:10]
    with pool.connection() as conn:
        policy = _policy(conn)
        day_start = _at(a.date, 0)
        rows = conn.execute(
            """
            SELECT e.emp_no, e.name, e.rank_name AS rank, d.name AS department,
                   coalesce((
                       SELECT json_agg(json_build_object(
                                  'start_min', greatest(0, extract(epoch FROM r.starts_at - %(day)s) / 60)::int,
                                  'end_min', least(1440, extract(epoch FROM r.ends_at - %(day)s) / 60)::int,
                                  'title', r.title) ORDER BY r.starts_at)
                       FROM reservations r JOIN reservation_attendees ra ON ra.reservation_id = r.id
                       WHERE ra.employee_id = e.id AND r.status = 'CONFIRMED'
                         AND r.starts_at < %(day)s + interval '1 day' AND r.ends_at > %(day)s), '[]') AS meetings,
                   coalesce((
                       SELECT json_agg(json_build_object(
                                  'start_min', greatest(0, extract(epoch FROM ab.starts_at - %(day)s) / 60)::int,
                                  'end_min', least(1440, extract(epoch FROM ab.ends_at - %(day)s) / 60)::int,
                                  'kind', ab.kind))
                       FROM employee_absences ab
                       WHERE ab.employee_id = e.id
                         AND ab.starts_at < %(day)s + interval '1 day' AND ab.ends_at > %(day)s), '[]') AS absences
            FROM employees e JOIN departments d ON d.id = e.department_id
            WHERE e.emp_no = ANY(%(emp_nos)s) AND e.employment_status = 'ACTIVE'
            """,
            {"day": day_start, "emp_nos": emp_nos},
        ).fetchall()
    found = {r["emp_no"] for r in rows}
    after = ctx.now.hour * 60 + ctx.now.minute if a.date == ctx.now.date() else None
    people, all_busy = [], []
    for r in rows:
        busy = [(m["start_min"], m["end_min"]) for m in r["meetings"]] + [
            (x["start_min"], x["end_min"]) for x in r["absences"]
        ]
        all_busy += busy
        people.append(
            {
                "emp_no": r["emp_no"],
                "name": r["name"],
                "rank": r["rank"],
                "department": r["department"],
                "meetings": [
                    {"time": f"{_clock(m['start_min'])}-{_clock(m['end_min'])}", "title": m["title"]}
                    for m in r["meetings"]
                ],
                "absences": [
                    {
                        "time": f"{_clock(x['start_min'])}-{_clock(x['end_min'])}",
                        "kind": ABSENCE.get(x["kind"], x["kind"]),
                    }
                    for x in r["absences"]
                ],
                "free": _free_gaps(busy, policy["open_start"], policy["open_end"], after),
            }
        )
    return {
        "date": _day_text(a.date),
        "people": people,
        # 모두 비어 있는 시간 (회의실은 따로 find_free_rooms로)
        "everyone_free": _free_gaps(all_busy, policy["open_start"], policy["open_end"], after),
        "not_found": sorted(set(emp_nos) - found),
        "bookable_hours": f"{_clock(policy['open_start'])}-{_clock(policy['open_end'])}, {policy['slot']}분 단위",
    }


def find_duty_owner(ctx: Context, a: FindDutyOwner) -> dict[str, Any]:
    keyword = a.keyword.strip()[:50]
    with pool.connection() as conn:
        tasks = conn.execute(
            """
            SELECT t.name AS task, t.description, t.keywords, d.name AS department,
                   dd.title AS document, dd.effective_date::text AS updated,
                   coalesce(json_agg(json_build_object('emp_no', e.emp_no, 'name', e.name, 'rank', e.rank_name,
                                                       'role', CASE o.role WHEN 'PRIMARY' THEN '정' ELSE '부' END)
                                     ORDER BY o.role DESC, e.name) FILTER (WHERE e.id IS NOT NULL), '[]') AS owners
            FROM duty_tasks t
            JOIN duty_documents dd ON dd.id = t.document_id AND dd.is_active
            JOIN departments d ON d.id = t.department_id
            LEFT JOIN duty_task_owners o ON o.task_id = t.id
            LEFT JOIN employees e ON e.id = o.employee_id AND e.employment_status = 'ACTIVE'
            WHERE t.name ILIKE %(k)s OR t.description ILIKE %(k)s OR array_to_string(t.keywords, ' ') ILIKE %(k)s
            GROUP BY t.id, d.name, dd.title, dd.effective_date
            ORDER BY t.name
            LIMIT 5
            """,
            {"k": f"%{keyword}%"},
        ).fetchall()
    return {
        "tasks": tasks,
        "hint": None
        if tasks
        else "업무분장표에 없어요. search_people에 같은 키워드를 넣으면 '하는 일'에 적어 둔 사람을 찾을 수 있어요",
    }


# 예약 확인에서 나는 오류 코드 → 모델이 고칠 수 있게 풀어 쓴 말
PROPOSAL_ERRORS = {
    "INVALID_TIME": "예약 가능 시간·단위를 벗어났어요",
    "TOO_LONG": "예약 길이가 너무 길어요",
    "IN_PAST": "이미 지난 시간이에요",
    "ROOM_NOT_FOUND": "그 회의실이 없어요 (room_id 확인)",
    "UNKNOWN_ATTENDEE": "없는 사번이 있어요",
    "NO_ATTENDEES": "참석자가 없어요",
}


def propose_reservation(ctx: Context, a: ProposeReservation) -> dict[str, Any]:
    if sum(e["type"] == "proposal" for e in ctx.events) >= PROPOSAL_LIMIT:
        raise ToolError(f"제안은 한 번에 {PROPOSAL_LIMIT}개까지예요. 이미 보여 준 것으로 답을 마무리하세요")
    start, end = _hhmm(a.start), _hhmm(a.end)
    emp_nos = [e.strip() for e in a.attendee_emp_nos if e.strip() and e.strip() != ctx.user["emp_no"]][:50]
    body = ReservationIn(
        room_id=a.room_id, date=a.date, start_min=start, end_min=end, title=a.title.strip()[:200], attendees=emp_nos
    )
    with pool.connection() as conn:
        try:
            _check_request(conn, body, ctx.user, 0, a.date)
        except HTTPException as error:
            detail = error.detail if isinstance(error.detail, dict) else {"code": str(error.detail)}
            raise ToolError(
                f"{PROPOSAL_ERRORS.get(detail['code'], detail['code'])}: {json.dumps(detail, default=str)}"
            ) from None
        policy = _policy(conn)
        room = conn.execute(
            """
            SELECT m.id, m.name, m.capacity, m.equipment, f.id AS floor_id, f.name AS floor_name,
                   s.id AS site_id, s.name AS site_name,
                   EXISTS (SELECT 1 FROM reservations r
                           WHERE r.room_id = m.id AND r.status = 'CONFIRMED'
                             AND r.starts_at < %(end)s AND r.ends_at > %(start)s) AS taken
            FROM meeting_rooms m JOIN floors f ON f.id = m.floor_id JOIN sites s ON s.id = f.site_id
            WHERE m.id = %(room)s
            """,
            {"room": a.room_id, "start": _at(a.date, start), "end": _at(a.date, end)},
        ).fetchone()
        if room["taken"]:
            raise ToolError("그 시간에 이 회의실은 이미 예약이 있어요. find_free_rooms로 빈 방을 다시 찾으세요")
        window = {"check": True, "date": a.date, "start_min": start, "end_date": a.date, "end_min": end}
        attendees = find_employees(
            conn,
            "e.emp_no = ANY(%(emp_nos)s)",
            person_order(),
            {"me": ctx.user["employee_id"], "limit": 50, "emp_nos": emp_nos, **window},
        )
    warnings = []
    people = len(attendees) + 1  # 예약하는 사람도 들어간다
    if people > room["capacity"]:
        warnings.append(f"참석 {people}명이 정원 {room['capacity']}명보다 많아요")
    for p in attendees:
        if p["busy"]:
            warnings.append(f"{p['name']}: 그 시간에 '{p['busy']['title']}' 회의가 있어요")
        if p["absence"]:
            warnings.append(f"{p['name']}: {ABSENCE.get(p['absence'], p['absence'])}")
    proposal = {
        "type": "proposal",
        "id": uuid.uuid4().hex[:12],
        "room": {
            "id": room["id"],
            "name": room["name"],
            "capacity": room["capacity"],
            "equipment": room["equipment"],
            "floor": {"id": room["floor_id"], "name": room["floor_name"]},
            "site": {"id": room["site_id"], "name": room["site_name"]},
        },
        "date": a.date.isoformat(),
        "start_min": start,
        "end_min": end,
        "title": body.title or "회의",
        "attendees": attendees,  # 화면의 참석자 칩과 같은 모양 (EmployeeHit)
        "warnings": warnings,
        "slot": policy["slot"],
    }
    ctx.events.append(proposal)
    return {
        "shown_to_user": True,
        "summary": f"{room['floor_name']} {room['name']} {_day_text(a.date)} {_clock(start)}-{_clock(end)}",
        "warnings": warnings,
        "note": "예약은 아직 안 됐어요. 사용자가 카드의 '예약하기'를 눌러야 확정돼요",
    }


@dataclass
class Tool:
    run: Callable[[Context, Any], dict[str, Any]]
    args: type[BaseModel]
    label: str  # 화면에 보여 주는 "하는 중" 문구
    description: str


TOOLS: dict[str, Tool] = {
    "search_people": Tool(
        search_people,
        SearchPeople,
        "사람을 찾고 있어요",
        "직원을 이름·사번·부서·팀·하는 일 키워드로 찾는다. 그 사람의 자리(사업장 층 좌석), 지금 재실 상태(presence), "
        "지금 들어가 있는 회의, 오늘 휴가·외근, 내선번호를 같이 준다. 사람이 어디 있는지·자리에 있는지 물을 때, "
        "참석자를 정할 때, 동명이인을 가릴 때 먼저 부른다. "
        "presence가 null이면 상태를 따로 정하지 않은 것이라 자리에 있는지는 모른다.",
    ),
    "find_free_rooms": Tool(
        find_free_rooms,
        FindFreeRooms,
        "빈 회의실을 찾고 있어요",
        "어느 날 몇 시부터 몇 시까지 비어 있는 회의실을 정원이 작은 것부터 찾는다. '지금 빈 회의실', "
        "'내일 10시에 6명 회의할 곳'처럼 시간이 정해진 질문에 부른다. "
        "지금이면 지금 시각부터 30분이나 1시간으로 찾는다.",
    ),
    "room_schedule": Tool(
        room_schedule,
        RoomSchedule,
        "회의실 예약 현황을 보고 있어요",
        "어느 날 회의실별 예약(시간·제목·예약한 사람)과 그날 남은 빈 시간을 보여 준다. '701호 오늘 언제 비어?', "
        "'7층 회의실 오늘 예약 현황'처럼 시간이 정해지지 않은 질문에 부른다.",
    ),
    "people_schedules": Tool(
        people_schedules,
        PeopleSchedules,
        "참석자 일정을 보고 있어요",
        "여러 사람의 어느 날 회의·휴가와 각자 빈 시간, 모두 비어 있는 시간(everyone_free)을 준다. "
        "'김민준·이서연이랑 오늘 1시간 회의'처럼 참석자가 정해진 회의 시간을 고를 때 부른다 "
        "(사번은 search_people로 먼저 찾는다).",
    ),
    "find_duty_owner": Tool(
        find_duty_owner,
        FindDutyOwner,
        "업무 담당자를 찾고 있어요",
        "부서 업무분장표에서 업무 이름·키워드로 정·부 담당자를 찾는다. "
        "'법인카드 정산 누가 해?'처럼 어떤 일을 누가 맡는지 물을 때 부른다. "
        "없으면 search_people에 같은 키워드를 넣어 '하는 일'에 적어 둔 사람을 찾는다.",
    ),
    "propose_reservation": Tool(
        propose_reservation,
        ProposeReservation,
        "예약 제안을 만들고 있어요",
        "회의실 예약 제안 카드를 사용자 화면에 보여 준다. 예약을 잡아 달라거나 회의할 곳·시간을 골라 달라고 하면, "
        "빈 방과 참석자 일정을 확인한 뒤 이것을 불러 후보를 보여 준다 (질문 하나에 3개까지). 예약은 되지 않고, "
        "사용자가 카드의 '예약하기'를 눌러야 확정된다.",
    ),
}


def _schema(model_cls: type[BaseModel]) -> dict[str, Any]:
    """pydantic 모델 → 도구 입력 스키마 (strict: 객체마다 additionalProperties false, 쓰지 않는 키는 뺀다)"""

    def clean(node: Any) -> Any:
        if isinstance(node, list):
            return [clean(v) for v in node]
        if not isinstance(node, dict):
            return node
        out: dict[str, Any] = {}
        for key, value in node.items():
            if key == "properties":
                out[key] = {name: clean(sub) for name, sub in value.items()}
            elif key not in ("title", "default"):
                out[key] = clean(value)
        if out.get("type") == "object":
            out["additionalProperties"] = False
        return out

    return clean(model_cls.model_json_schema())


def tool_specs() -> list[dict[str, Any]]:
    specs = []
    for name, tool in TOOLS.items():
        spec: dict[str, Any] = {
            "name": name,
            "description": tool.description,
            "input_schema": _schema(tool.args),
            "strict": True,
        }
        if provider() == "anthropic":
            spec["eager_input_streaming"] = True  # Bedrock은 배포에 따라 이 필드를 받지 않는다
        specs.append(spec)
    return specs


def run_tool(ctx: Context, name: str, raw: Any) -> tuple[dict[str, Any], bool]:
    """(결과, 오류인가). 입력은 모델이 만든 값이라 스키마로 다시 확인한다"""
    tool = TOOLS.get(name)
    if tool is None:
        return {"error": f"없는 도구: {name}"}, True
    try:
        args = tool.args.model_validate(raw)
    except ValidationError as error:
        return {"INVALID_INPUT": json.dumps(raw, ensure_ascii=False, default=str), "errors": error.errors()[:3]}, True
    try:
        return tool.run(ctx, args), False
    except (ToolError, ValidationError) as error:
        return {"error": str(error)}, True


# 대화 ------------------------------------------------------------------------------------------------

SYSTEM_PROMPT = """당신은 회사 사무실 앱 OfficeMap의 AI 도우미입니다. \
직원이 사람·자리·재실 상태·회의실·업무 담당자를 묻거나, \
회의할 곳과 시간을 골라 달라고 할 때 돕습니다.

답하는 법
- 한국어로, 짧고 바로 쓸 수 있게 답합니다. 두세 문장이나 "- "로 시작하는 짧은 목록. 표·제목·굵은 글씨는 쓰지 않습니다.
- 사람·자리·재실·회의실·일정에 관한 사실은 도구로 확인한 것만 말합니다. \
도구 결과에 없으면 모른다고 말하고 추측하지 않습니다.
- 시간은 서울 기준입니다. "지금·오늘·내일·다음 주"는 각 질문 앞에 붙은 현재 시각으로 계산합니다.
- 이름이 같은 사람이 여럿이면 부서·직급으로 누구인지 되묻습니다.
- 재실 상태가 없으면(null) "상태를 따로 정하지 않았다"고 말합니다. 자리에 없다고 단정하지 않습니다.

예약
- 예약은 직접 할 수 없습니다. 회의할 곳·시간을 찾아 달라거나 예약해 달라고 하면 조건(날짜·시간·길이·인원·참석자)을 \
도구로 확인해 propose_reservation으로 후보 카드를 보여 줍니다. 사용자가 카드의 '예약하기'를 눌러야 예약됩니다. \
"예약했습니다"라고 말하지 않습니다.
- 참석자가 있으면 people_schedules로 모두 비어 있는 시간을 먼저 찾고, \
정원이 참석 인원(질문한 사람 포함) 이상인 방을 고릅니다.
- 시간·길이를 말하지 않았으면 1시간, 날짜를 말하지 않았으면 오늘(지났으면 다음 근무일)로 잡고 \
그렇게 잡았다고 짧게 말합니다.
- 회의 제목을 말하지 않았으면 내용에 맞게 짧게 붙입니다 (모르면 "회의").

이 앱과 관계없는 요청(일반 지식, 글쓰기 등)에는 이 도우미가 도울 수 있는 일을 한 문장으로 안내합니다."""

SOURCE_NOTE = {
    "ROOMS": "회의실 예약 폼의 'AI 추천' 칸에서 물었어요. 조건에 맞는 후보를 propose_reservation으로 1~3개 보여 주고, "
    "말은 한두 문장으로 짧게 하세요.",
}


def _profile_line(user: dict[str, Any]) -> str:
    with pool.connection() as conn:
        me = find_employees(conn, "e.id = %(me)s", "e.id", {"me": user["employee_id"], "limit": 1, **NO_WINDOW})
    seat = me[0]["seat"] if me else None
    where = f"{seat['site_name']} {seat['floor_name']} {seat['code']}" if seat else "고정 자리 없음"
    rank = f" {user['rank_name']}" if user.get("rank_name") else ""
    return f"질문하는 사람: {user['name']}{rank} ({user['department']}), 사번 {user['emp_no']}, 자리 {where}."


def _context_line(ctx: Context, source: str, site_name: str | None, date: dt.date | None) -> str:
    now = ctx.now
    parts = [f"[지금 {_day_text(now.date())} {now:%H:%M}"]
    if source == "ROOMS":
        if site_name:
            parts.append(f"보고 있는 사업장 {site_name}")
        if date:
            parts.append(f"보고 있는 날짜 {_day_text(date)}")
    return " · ".join(parts) + "]" + (f" {SOURCE_NOTE[source]}" if source in SOURCE_NOTE else "")


def _dump(block: Any) -> dict[str, Any]:
    """응답 블록 → 다음 요청에 그대로 다시 보낼 JSON (생각 블록의 서명, fallback 블록의 from 등 그대로)"""
    return block.model_dump(mode="json", by_alias=True, exclude_none=True)


def _history(conn: Connection, conversation_id: int) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT role, blocks FROM ai_messages WHERE conversation_id = %s AND blocks IS NOT NULL ORDER BY id",
        (conversation_id,),
    ).fetchall()
    return [{"role": "assistant" if r["role"] == "ASSISTANT" else "user", "content": r["blocks"]} for r in rows]


def _error_text(error: Exception) -> tuple[str, str]:
    """(코드, 화면에 보여 줄 말). 자세한 원인은 서버 로그에 남긴다"""
    if isinstance(error, anthropic.AuthenticationError | anthropic.PermissionDeniedError):
        return "AI_AUTH", "AI 서비스 인증에 실패했어요. 관리자에게 알려 주세요 (API 키·권한 확인)."
    if isinstance(error, anthropic.NotFoundError):
        return "AI_MODEL", "AI 모델을 찾지 못했어요. 관리자에게 알려 주세요 (AI_MODEL 확인)."
    if isinstance(error, anthropic.RateLimitError):
        return "AI_BUSY", "AI 서비스 사용량이 많아요. 잠시 뒤에 다시 물어봐 주세요."
    if isinstance(error, anthropic.APIConnectionError):
        return "AI_UNREACHABLE", "AI 서비스에 연결하지 못했어요. 잠시 뒤에 다시 물어봐 주세요."
    if isinstance(error, anthropic.APIStatusError) and error.status_code >= 500:
        return "AI_BUSY", "AI 서비스가 잠시 응답하지 않아요. 잠시 뒤에 다시 물어봐 주세요."
    return "AI_ERROR", "답을 만들지 못했어요. 잠시 뒤에 다시 물어봐 주세요."


def _stream(client: Any, system: list[dict[str, Any]], messages: list[dict[str, Any]]) -> Any:
    effort = settings.ai_effort if settings.ai_effort in EFFORTS else "medium"
    kwargs: dict[str, Any] = {
        "model": model(),
        "max_tokens": MAX_TOKENS,
        "system": system,
        "tools": tool_specs(),
        "messages": messages,
        "output_config": {"effort": effort},
        "cache_control": {"type": "ephemeral"},  # 도구·지시문·앞의 대화를 캐시해 다음 단계·질문을 싸고 빠르게
    }
    if provider() == "anthropic":
        # 안전 분류기가 거절하면 서버가 다른 모델로 다시 돌린다 (Bedrock에는 없는 기능)
        kwargs |= {"betas": ["server-side-fallback-2026-07-01"], "fallbacks": "default"}
    return client.beta.messages.stream(**kwargs)


def run_turn(
    user: dict[str, Any],
    conversation_id: int,
    question: str,
    source: str = "PANEL",
    site_id: int | None = None,
    date: dt.date | None = None,
) -> Iterator[dict[str, Any]]:
    """질문 하나에 답한다. 화면에 보낼 이벤트를 차례로 내보낸다:
    text(답 글자 조각), tool(도구를 쓰는 중), proposal(예약 제안), error, done.
    이번 질문에서 주고받은 것은 끝에 한꺼번에 저장한다 (중간에 실패해도 대화가 깨지지 않는 데까지)."""
    ctx = Context(user=user, now=dt.datetime.now(KST), site_id=site_id)
    rows: list[dict[str, Any]] = []
    try:
        with pool.connection() as conn:
            messages = _history(conn, conversation_id)
            site_name = None
            if site_id is not None:
                site = conn.execute("SELECT name FROM sites WHERE id = %s", (site_id,)).fetchone()
                site_name = site["name"] if site else None
        system = [{"type": "text", "text": SYSTEM_PROMPT}, {"type": "text", "text": _profile_line(user)}]
        user_blocks = [
            {"type": "text", "text": _context_line(ctx, source, site_name, date)},
            {"type": "text", "text": question},
        ]
        messages.append({"role": "user", "content": user_blocks})
        rows.append({"role": "USER", "content": question, "blocks": user_blocks})

        client = client_factory()
        wrote = False  # 앞 단계에서 글을 보냈으면 다음 단계 글 앞에 줄을 띄운다
        json_retries = 0
        for _ in range(MAX_STEPS):
            started = False
            try:
                with _stream(client, system, messages) as stream:
                    for event in stream:
                        if event.type == "text" and event.text:
                            if wrote and not started:
                                yield {"type": "text", "text": "\n\n"}
                            started = wrote = True
                            yield {"type": "text", "text": event.text}
                    message = stream.get_final_message()
            except ValueError:
                # 도구 입력 JSON을 아예 읽지 못함 (eager_input_streaming). 같은 단계를 다시 묻는다
                json_retries += 1
                if json_retries > 2:
                    raise
                continue
            json_retries = 0
            usage = message.usage
            tokens = {
                "input_tokens": usage.input_tokens
                + (usage.cache_read_input_tokens or 0)
                + (usage.cache_creation_input_tokens or 0),
                "output_tokens": usage.output_tokens,
            }
            if message.stop_reason == "refusal":
                yield {
                    "type": "error",
                    "code": "AI_REFUSED",
                    "message": "이 질문에는 답할 수 없어요. 다르게 물어봐 주세요.",
                }
                break  # 거절된 응답은 대화에 남기지 않는다
            tool_uses = [b for b in message.content if b.type == "tool_use"]
            blocks = [_dump(b) for b in message.content]
            text = "".join(b.text for b in message.content if b.type == "text")
            if message.stop_reason == "max_tokens" and tool_uses:
                yield {
                    "type": "error",
                    "code": "AI_ERROR",
                    "message": "답이 너무 길어져 멈췄어요. 조건을 좁혀 다시 물어봐 주세요.",
                }
                break
            assistant_row = {"role": "ASSISTANT", "content": text, "blocks": blocks, **tokens}
            messages.append({"role": "assistant", "content": blocks})
            if message.stop_reason == "pause_turn":
                rows.append(assistant_row)
                continue
            if not tool_uses:
                rows.append(assistant_row)
                break

            results, names, shown = [], [], len(ctx.events)
            for block in tool_uses:
                yield {
                    "type": "tool",
                    "name": block.name,
                    "label": TOOLS[block.name].label if block.name in TOOLS else "",
                }
                result, failed = run_tool(ctx, block.name, block.input)
                names.append(block.name)
                results.append(
                    {
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": json.dumps(result, ensure_ascii=False, default=str),
                        **({"is_error": True} if failed else {}),
                    }
                )
            new_events = ctx.events[shown:]
            yield from new_events
            messages.append({"role": "user", "content": results})
            # 도구를 부른 응답과 그 결과는 같이 남긴다 (한쪽만 남으면 다음 질문에서 대화가 깨진다)
            rows.append(assistant_row)
            rows.append(
                {
                    "role": "TOOL",
                    "content": ", ".join(names),
                    "blocks": results,
                    "tool_name": ",".join(names)[:50],
                    "tool_args": {
                        "calls": [{"name": b.name, "input": b.input} for b in tool_uses],
                        "events": new_events,
                    },
                }
            )
        else:
            yield {"type": "text", "text": "\n\n(확인할 것이 많아 여기서 멈췄어요. 조건을 좁혀 다시 물어봐 주세요.)"}
    except Exception as error:  # 화면에는 짧게, 원인은 로그에
        log.exception("AI 도우미 답 만들기 실패 (대화 %s)", conversation_id)
        code, text = _error_text(error)
        yield {"type": "error", "code": code, "message": text}
    finally:
        _save(conversation_id, rows)
    yield {"type": "done"}


def _jsonb(value: Any) -> Jsonb:
    # 예약 제안의 참석자 일정 등 시각(datetime)이 섞여 있다: 화면에 보낸 것(SSE)과 같은 글자로 남긴다
    return Jsonb(value, dumps=lambda v: json.dumps(v, ensure_ascii=False, default=str))


def _save(conversation_id: int, rows: list[dict[str, Any]]) -> None:
    if not rows:
        return
    try:
        with pool.connection() as conn:
            for row in rows:
                conn.execute(
                    """
                    INSERT INTO ai_messages (conversation_id, role, content, blocks, tool_name, tool_args,
                                             input_tokens, output_tokens)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    (
                        conversation_id,
                        row["role"],
                        row["content"],
                        _jsonb(row["blocks"]),
                        row.get("tool_name"),
                        _jsonb(row["tool_args"]) if row.get("tool_args") is not None else None,
                        row.get("input_tokens"),
                        row.get("output_tokens"),
                    ),
                )
    except Exception:
        log.exception("AI 대화 저장 실패 (대화 %s)", conversation_id)
