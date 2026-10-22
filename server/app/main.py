from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.db import pool
from app.routers import auth, office, presence


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    pool.open()
    yield
    pool.close()


app = FastAPI(title="OfficeMap API", lifespan=lifespan)
app.include_router(auth.router)
app.include_router(office.router)
app.include_router(presence.router)


@app.get("/api/health")
def health() -> dict[str, str]:
    with pool.connection() as conn:
        conn.execute("SELECT 1")
    return {"status": "ok"}
