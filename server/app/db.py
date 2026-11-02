from typing import Any

from psycopg import Connection
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from app.config import settings

# 동기 풀을 쓴다. psycopg 비동기 모드는 Windows 기본 이벤트 루프에서 동작하지 않고,
# FastAPI는 일반 def 엔드포인트를 스레드에서 돌려서 bcrypt 계산도 서버를 막지 않는다
# DB가 응답하지 않을 때(보안 그룹에 막힘 등) 끝없이 기다리지 않고 이만큼(초) 뒤 오류로 남긴다
CONNECT_TIMEOUT = 10
# check: 풀에서 연결을 꺼낼 때마다 살아 있는지 확인하고, 끊긴 연결은 버리고 새로 맺는다.
# DB가 재시작되면(RDS 사양 변경·재부팅·유지 보수) 풀에 남은 연결이 모두 끊겨 있어서, 확인하지 않으면
# 재시작 직후 요청들이 그 연결을 하나씩 쓰다가 오류(500)가 났다. 확인은 빈 질의 한 번이라 요청마다 1ms 안팎
pool = ConnectionPool(
    settings.database_url,
    open=False,
    check=ConnectionPool.check_connection,
    kwargs={"row_factory": dict_row, "connect_timeout": CONNECT_TIMEOUT},
)


def get_setting(conn: Connection, key: str, default: Any) -> Any:
    """app_settings 값을 읽는다. 없으면 기본값."""
    row = conn.execute("SELECT value FROM app_settings WHERE key = %s", (key,)).fetchone()
    return default if row is None else row["value"]
