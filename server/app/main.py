import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import psycopg
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app import schema
from app.config import settings
from app.db import pool
from app.db_check import log_problems
from app.jobs import jobs
from app.realtime import hub
from app.routers import (
    admin,
    ai,
    auth,
    employees,
    grants,
    moves,
    office,
    org,
    personnel,
    plans,
    presence,
    profile,
    rooms,
    seating,
)


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    log_problems(settings.database_url)  # DB에 못 붙거나 비어 있으면 이유를 로그 맨 앞에 남긴다
    pool.open()
    hub.start()
    jobs.start()
    with hub.close_streams_on_exit():
        yield
    jobs.stop()
    hub.stop()
    pool.close()


app = FastAPI(title="OfficeMap API", lifespan=lifespan)
app.include_router(auth.router)
app.include_router(office.router)
app.include_router(presence.router)
app.include_router(employees.router)
app.include_router(rooms.router)
app.include_router(admin.router)
app.include_router(grants.router)
app.include_router(seating.router)
app.include_router(plans.router)
app.include_router(moves.router)
app.include_router(profile.router)
app.include_router(org.router)
app.include_router(personnel.router)
app.include_router(ai.router)

log = logging.getLogger(__name__)


@app.exception_handler(psycopg.errors.UndefinedTable)
@app.exception_handler(psycopg.errors.UndefinedColumn)
@app.exception_handler(psycopg.errors.UndefinedFunction)
async def db_outdated(request: Request, error: psycopg.Error) -> JSONResponse:
    """새 버전의 테이블·컬럼이 DB에 없을 때(init_db --upgrade를 안 돌림): 빠진 파일과 고칠 명령을 로그에 남긴다"""
    file = schema.file_for(str(error))
    if file is None:  # db/schema에 없는 이름: 코드 오류
        raise error
    log.error(
        "%s %s: DB에 이 버전의 db/schema/%s가 들어가지 않았어요 (%s)\n  → 데이터는 그대로 두고 빠진 것만 넣기: %s",
        request.method,
        request.url.path,
        file,
        error.diag.message_primary,
        schema.UPGRADE_COMMAND,
    )
    return JSONResponse(status_code=503, content={"detail": {"code": "DB_OUTDATED", "file": file}})


@app.get("/api/health")
def health() -> dict[str, str]:
    """DB까지 닿으면 ok. version: 지금 떠 있는 커밋 (배포가 새 버전으로 바뀌었는지 확인할 때)"""
    with pool.connection() as conn:
        conn.execute("SELECT 1")
    return {"status": "ok", "version": settings.app_version}
