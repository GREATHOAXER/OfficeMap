from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.db import pool
from app.realtime import hub
from app.routers import admin, auth, employees, office, presence, rooms, seating


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    pool.open()
    hub.start()
    with hub.close_streams_on_exit():
        yield
    hub.stop()
    pool.close()


app = FastAPI(title="OfficeMap API", lifespan=lifespan)
app.include_router(auth.router)
app.include_router(office.router)
app.include_router(presence.router)
app.include_router(employees.router)
app.include_router(rooms.router)
app.include_router(admin.router)
app.include_router(seating.router)


@app.get("/api/health")
def health() -> dict[str, str]:
    with pool.connection() as conn:
        conn.execute("SELECT 1")
    return {"status": "ok"}
