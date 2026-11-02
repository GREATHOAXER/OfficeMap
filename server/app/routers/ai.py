"""AI 도우미 API. 답을 만드는 쪽은 app/assistant.py.

GET  /api/ai/status                  AI를 켰는지 (화면이 입력창을 열지 정한다)
POST /api/ai/chat                    질문 하나 → 답을 조금씩 보내는 SSE (text, tool, proposal, error, done)
GET  /api/ai/conversations/{id}      대화 다시 보기 (패널을 다시 열었을 때)
"""

import datetime as dt
import json
from collections.abc import Iterator
from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app import assistant
from app.config import settings
from app.db import pool
from app.realtime import SSE_HEADERS
from app.session import CurrentUser

router = APIRouter(prefix="/api/ai", tags=["ai"])

BUSY_MINUTES = 3  # 한 대화에 답을 만드는 중 표시. 서버가 중간에 꺼져도 이 시간이 지나면 풀린다
MAX_PARALLEL = 2  # 한 사람이 동시에 답을 기다릴 수 있는 대화 수 (탭 두 개 정도)


def _error(status: int, code: str, **extra: Any) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, **extra})


@router.get("/status")
def ai_status(user: CurrentUser) -> dict[str, Any]:
    return assistant.status()


class ChatIn(BaseModel):
    message: str = Field(min_length=1, max_length=1000)
    conversation_id: int | None = None  # 없으면 새 대화
    source: Literal["PANEL", "ROOMS"] = "PANEL"  # 자리·재실 현황의 패널 / 회의실 예약 폼의 AI 추천
    site_id: int | None = None  # 예약 폼에서 보고 있는 사업장·날짜
    date: dt.date | None = None


@router.post("/chat")
def chat(body: ChatIn, user: CurrentUser) -> StreamingResponse:
    if not assistant.status()["enabled"]:
        raise _error(503, "AI_OFF")
    question = body.message.strip()
    if not question:
        raise _error(422, "EMPTY")
    with pool.connection() as conn:
        # 한 사람의 질문은 한 번에 하나씩 확인한다. 질문은 답이 끝난 뒤에 저장되므로, 동시에 여러 개를 보내면
        # 저장된 질문만 세어서는 한 시간 한도를 넘길 수 있다: 지금 답하는 중인 대화도 한 번씩 센다
        conn.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended('ai-chat:' || %s::text, 0))", (user["employee_id"],)
        )
        count = conn.execute(
            """
            SELECT (SELECT count(*) FROM ai_messages m JOIN ai_conversations c ON c.id = m.conversation_id
                    WHERE c.employee_id = %(emp)s AND m.role = 'USER'
                      AND m.created_at > now() - interval '1 hour') AS sent,
                   (SELECT count(*) FROM ai_conversations
                    WHERE employee_id = %(emp)s AND busy_until > now()) AS busy
            """,
            {"emp": user["employee_id"]},
        ).fetchone()
        if count["sent"] + count["busy"] >= settings.ai_hourly_limit:
            raise _error(429, "TOO_MANY", limit=settings.ai_hourly_limit)
        if count["busy"] >= MAX_PARALLEL:
            raise _error(409, "BUSY")
        if body.conversation_id is None:
            conversation_id = conn.execute(
                "INSERT INTO ai_conversations (employee_id, source, model) VALUES (%s, %s, %s) RETURNING id",
                (user["employee_id"], body.source, assistant.model()),
            ).fetchone()["id"]
        else:
            row = conn.execute(
                """
                SELECT c.id, (SELECT count(*) FROM ai_messages m WHERE m.conversation_id = c.id) AS n
                FROM ai_conversations c WHERE c.id = %s AND c.employee_id = %s
                """,
                (body.conversation_id, user["employee_id"]),
            ).fetchone()
            if row is None:
                raise _error(404, "CONVERSATION_NOT_FOUND")
            if row["n"] >= assistant.MAX_ROWS:
                raise _error(409, "CONVERSATION_FULL")
            conversation_id = row["id"]
        # 같은 대화에 두 곳(다른 탭)에서 동시에 물으면 대화 순서가 꼬인다: 답하는 동안 잠가 둔다
        locked = conn.execute(
            f"""
            UPDATE ai_conversations SET busy_until = now() + interval '{BUSY_MINUTES} minutes'
            WHERE id = %s AND (busy_until IS NULL OR busy_until < now()) RETURNING id
            """,
            (conversation_id,),
        ).fetchone()
        if locked is None:
            raise _error(409, "BUSY")

    def events() -> Iterator[str]:
        try:
            yield _sse({"type": "start", "conversation_id": conversation_id})
            for event in assistant.run_turn(user, conversation_id, question, body.source, body.site_id, body.date):
                yield _sse(event)
        finally:
            with pool.connection() as conn:
                conn.execute("UPDATE ai_conversations SET busy_until = NULL WHERE id = %s", (conversation_id,))

    return StreamingResponse(events(), media_type="text/event-stream", headers=SSE_HEADERS)


def _sse(event: dict[str, Any]) -> str:
    return f"data: {json.dumps(event, ensure_ascii=False, default=str)}\n\n"


@router.get("/conversations/{conversation_id}")
def conversation(conversation_id: int, user: CurrentUser) -> dict[str, Any]:
    """사람이 보는 대화: 질문, 답 글, 그 답에서 보여 준 예약 제안"""
    with pool.connection() as conn:
        owner = conn.execute(
            "SELECT id, started_at FROM ai_conversations WHERE id = %s AND employee_id = %s",
            (conversation_id, user["employee_id"]),
        ).fetchone()
        if owner is None:
            raise _error(404, "CONVERSATION_NOT_FOUND")
        rows = conn.execute(
            "SELECT role, content, tool_args FROM ai_messages WHERE conversation_id = %s ORDER BY id",
            (conversation_id,),
        ).fetchall()
    messages: list[dict[str, Any]] = []
    for row in rows:
        if row["role"] == "USER":
            messages.append({"role": "user", "text": row["content"], "proposals": []})
            continue
        if not messages or messages[-1]["role"] != "assistant":
            messages.append({"role": "assistant", "text": "", "proposals": []})
        last = messages[-1]
        if row["role"] == "ASSISTANT" and row["content"]:
            last["text"] = f"{last['text']}\n\n{row['content']}" if last["text"] else row["content"]
        elif row["role"] == "TOOL" and row["tool_args"]:
            last["proposals"] += [e for e in row["tool_args"].get("events", []) if e.get("type") == "proposal"]
    return {
        "id": owner["id"],
        "full": len(rows) >= assistant.MAX_ROWS,
        "messages": messages,
    }
