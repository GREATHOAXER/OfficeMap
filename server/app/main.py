from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

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


@app.get("/api/health")
def health() -> dict[str, str]:
    """DB까지 닿으면 ok. version: 지금 떠 있는 커밋 (배포가 새 버전으로 바뀌었는지 확인할 때)"""
    with pool.connection() as conn:
        conn.execute("SELECT 1")
    return {"status": "ok", "version": settings.app_version}
