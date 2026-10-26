"""실시간 알림: 재실 상태, 도면·좌석 배치.

DB 트리거가 NOTIFY를 보낸다. presence_changed(재실 상태)와 floor_changed(좌석·배정·구역·도면 게시).
서버 프로세스마다 LISTEN 연결 하나가 이걸 받아서, 지금 열려 있는 화면(SSE 연결)마다 나눠 준다.
서버를 여러 개 띄워도 각자 받는다.
LISTEN은 스레드에서 돈다 (psycopg 비동기 모드는 Windows 기본 이벤트 루프에서 동작하지 않는다).
"""

import asyncio
import logging
import signal
import threading
from collections.abc import AsyncIterator, Callable, Iterator
from contextlib import contextmanager

import psycopg
from starlette.concurrency import run_in_threadpool

from app.config import settings
from app.db import CONNECT_TIMEOUT

log = logging.getLogger(__name__)

# DB 알림 채널 → 화면에 보내는 SSE 이벤트 이름
CHANNELS = {"presence_changed": "presence", "floor_changed": "floor"}
# LISTEN 연결이 끊겼다 다시 붙었다: 그 사이 놓친 변경이 있을 수 있어 화면에 전체를 다시 읽게 한다
RESYNC = "resync"
# 서버가 꺼진다: 열린 연결을 닫는다 (uvicorn은 열린 응답이 끝나기를 기다리며 종료·재시작을 멈춘다)
CLOSE = "close"

PING_SECONDS = 20  # 아무 변경이 없어도 이 간격으로 신호를 보내 중간 프록시가 연결을 끊지 않게 한다
SESSION_CHECK_SECONDS = 60  # 로그아웃·자동 로그아웃되면 이 시간 안에 연결을 닫는다

# (이벤트 이름, JSON 문자열)
Message = tuple[str, str]


class Subscription:
    def __init__(self, events: frozenset[str]) -> None:
        self.events = events  # 이 화면이 받는 이벤트 (presence, floor)
        self.queue: asyncio.Queue[Message] = asyncio.Queue(maxsize=256)
        self.lost = False  # 화면이 못 따라와서 알림을 버렸다. 연결을 끊고 다시 붙으면서 전체를 다시 읽는다


class RealtimeHub:
    def __init__(self) -> None:
        self._subs: set[Subscription] = set()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.closing = False  # 서버가 꺼지는 중. 새 연결은 바로 닫는다

    def subscribe(self, events: frozenset[str]) -> Subscription:
        sub = Subscription(events)
        self._subs.add(sub)
        return sub

    def unsubscribe(self, sub: Subscription) -> None:
        self._subs.discard(sub)

    def _publish(self, message: Message) -> None:
        event = message[0]
        for sub in list(self._subs):
            if event not in sub.events and event not in (RESYNC, CLOSE):
                continue
            try:
                sub.queue.put_nowait(message)
            except asyncio.QueueFull:
                sub.lost = True
                self._subs.discard(sub)

    def _publish_threadsafe(self, message: Message) -> None:
        if self._loop is not None and not self._loop.is_closed():
            self._loop.call_soon_threadsafe(self._publish, message)

    def _listen(self) -> None:
        delay = 1.0
        first = True
        while not self._stop.is_set():
            try:
                with psycopg.connect(settings.database_url, autocommit=True, connect_timeout=CONNECT_TIMEOUT) as conn:
                    for channel in CHANNELS:
                        conn.execute(f"LISTEN {channel}")
                    if not first:
                        self._publish_threadsafe((RESYNC, "{}"))
                    first, delay = False, 1.0
                    while not self._stop.is_set():
                        for notify in conn.notifies(timeout=1.0):  # 1초마다 멈출 때인지 확인
                            self._publish_threadsafe((CHANNELS[notify.channel], notify.payload))
            except psycopg.Error as error:
                log.warning("실시간 알림 LISTEN 연결 끊김, %.0f초 뒤 다시 연결: %s", delay, error)
                self._stop.wait(delay)
                delay = min(delay * 2, 30)

    def start(self) -> None:
        self._loop = asyncio.get_running_loop()
        self._stop.clear()
        self.closing = False
        self._thread = threading.Thread(target=self._listen, name="realtime-listen", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5)

    @contextmanager
    def close_streams_on_exit(self) -> Iterator[None]:
        """Ctrl+C·종료 신호가 오면 열린 SSE 연결부터 닫는다. 원래 신호 처리(uvicorn)는 그대로 이어서 부른다."""
        if threading.current_thread() is not threading.main_thread():
            yield
            return
        loop = asyncio.get_running_loop()
        signals = [signal.SIGINT, signal.SIGTERM] + ([signal.SIGBREAK] if hasattr(signal, "SIGBREAK") else [])
        previous = {sig: signal.getsignal(sig) for sig in signals}

        def on_exit(sig: int, frame: object) -> None:
            self.closing = True
            loop.call_soon_threadsafe(self._publish, (CLOSE, ""))
            handler = previous[sig]
            if callable(handler):
                handler(sig, frame)
            elif handler is not None:  # 기본 동작(종료)이나 무시: 원래대로 돌려놓고 신호를 다시 보낸다
                signal.signal(sig, handler)
                signal.raise_signal(sig)

        for sig in signals:
            signal.signal(sig, on_exit)
        try:
            yield
        finally:
            for sig, handler in previous.items():
                signal.signal(sig, handler)

    async def events(self, wanted: frozenset[str], session_alive: Callable[[], bool]) -> AsyncIterator[str]:
        """SSE 본문. wanted 이벤트와 resync를 보내고, 로그인이 끝나면(session_alive가 False) 연결을 닫는다."""
        sub = self.subscribe(wanted)
        loop = asyncio.get_running_loop()
        check_at = loop.time() + SESSION_CHECK_SECONDS
        try:
            yield "retry: 3000\n\n"  # 끊기면 3초 뒤 다시 연결
            while not self.closing and not sub.lost:
                try:
                    message: Message | None = await asyncio.wait_for(sub.queue.get(), timeout=PING_SECONDS)
                except TimeoutError:
                    message = None
                if message is None:
                    yield ": ping\n\n"
                elif message[0] == CLOSE:
                    break
                else:
                    yield f"event: {message[0]}\ndata: {message[1]}\n\n"
                if loop.time() >= check_at:
                    if not await run_in_threadpool(session_alive):
                        break
                    check_at = loop.time() + SESSION_CHECK_SECONDS
        finally:
            self.unsubscribe(sub)


hub = RealtimeHub()

# SSE 응답 머리글: 압축·버퍼링하는 프록시(Next.js, nginx)가 알림을 모아 두지 않게 한다
SSE_HEADERS = {"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"}
