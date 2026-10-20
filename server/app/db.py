from typing import Any

from psycopg import Connection
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from app.config import settings

# 동기 풀을 쓴다. psycopg 비동기 모드는 Windows 기본 이벤트 루프에서 동작하지 않고,
# FastAPI는 일반 def 엔드포인트를 스레드에서 돌려서 bcrypt 계산도 서버를 막지 않는다
pool = ConnectionPool(settings.database_url, open=False, kwargs={"row_factory": dict_row})


def get_setting(conn: Connection, key: str, default: Any) -> Any:
    """app_settings 값을 읽는다. 없으면 기본값."""
    row = conn.execute("SELECT value FROM app_settings WHERE key = %s", (key,)).fetchone()
    return default if row is None else row["value"]
