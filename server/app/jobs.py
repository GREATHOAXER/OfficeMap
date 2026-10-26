"""서버 안에서 도는 정기 작업.

- 1분마다: 날짜가 된 도면 게시 예약을 게시한다 (routers/plans.py의 apply_due_plans)
- 하루 한 번: 보관 기간(5년)이 지난 이력을 지운다 (db/schema/09_retention.sql의 purge_history)

서버를 여러 개 띄워도 한 번에 하나만 돌도록 DB 잠금(pg_try_advisory_lock)을 잡는다.
스레드에서 돈다 (DB 작업이 동기 방식이라 이벤트 루프를 막지 않게).
"""

import logging
import threading
import time

import psycopg

from app.db import pool
from app.routers.plans import apply_due_plans

log = logging.getLogger(__name__)

TICK_SECONDS = 60
PURGE_EVERY_SECONDS = 24 * 60 * 60
JOB_LOCK = 5152  # pg_advisory_lock 키 (5150 좌석 배치, 5151 예비)
# 새 DB면 init_db, DB 구조(db/schema)가 바뀐 버전을 올렸으면 init_db --reset (docs/deploy-aws.md 5)
SCHEMA_HINT = "새 DB면 scripts.init_db, DB 구조가 바뀐 버전을 올렸으면 scripts.init_db --reset"


class Jobs:
    def __init__(self) -> None:
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._last_purge: float | None = None  # 서버를 켜면 한 번 바로 정리한다
        self._warned_schema = False

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, name="officemap-jobs", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5)

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                self.tick()
            except psycopg.errors.UndefinedTable as error:
                # 테이블을 안 넣은 새 DB나 DB 구조가 바뀐 버전: 매분 같은 오류를 쌓지 않게 한 번만 알린다
                if not self._warned_schema:
                    self._warned_schema = True
                    log.warning("정기 작업: DB에 테이블이 없어요 (%s). %s", str(error).splitlines()[0], SCHEMA_HINT)
            except Exception:  # noqa: BLE001 - 작업 하나가 실패해도 다음 주기에 다시 한다
                log.exception("정기 작업 실패")
            self._stop.wait(TICK_SECONDS)

    def tick(self) -> None:
        # 잠금은 세션에 붙으므로 같은 연결로 잡고 푼다
        with pool.connection() as lock_conn:
            if not lock_conn.execute("SELECT pg_try_advisory_lock(%s) AS ok", (JOB_LOCK,)).fetchone()["ok"]:
                return  # 다른 서버가 하고 있다
            try:
                for result in apply_due_plans():
                    log.info("예약한 도면 게시: v%s", result["version"])
                if self._last_purge is None or time.monotonic() - self._last_purge >= PURGE_EVERY_SECONDS:
                    with pool.connection() as conn:
                        result = conn.execute("SELECT purge_history() AS result").fetchone()["result"]
                    self._last_purge = time.monotonic()
                    log.info("이력 정리: %s", result)
            finally:
                lock_conn.execute("SELECT pg_advisory_unlock(%s)", (JOB_LOCK,))


jobs = Jobs()
