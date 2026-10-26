"""DB 접속 점검: DATABASE_URL로 DB에 닿는지 단계별로 보고, 안 되면 고칠 곳을 알려 준다.

배포 서버(deploy 디렉토리)에서:
    docker compose run --rm backend python -m scripts.check_db
    docker compose run --rm backend python -m scripts.check_db --create-db   # 데이터베이스가 없으면 만든다
server 디렉토리에서:
    python -m scripts.check_db

암호는 화면에 나오지 않는다. 결과를 다른 사람에게 보여 줘도 된다.
"""

import argparse
import socket
import sys
from typing import NoReturn
from urllib.parse import urlsplit, urlunsplit

import psycopg
from psycopg import sql

from app.config import settings
from app.db_check import (
    CHECK_TIMEOUT,
    INIT_COMMAND,
    REFUSED_HINT,
    describe,
    dns_hint,
    hints,
    message,
    timeout_hint,
    url_problems,
)

EXTENSIONS = ("vector", "btree_gist")  # db/schema에서 CREATE EXTENSION 하는 것


def ok(text: str) -> None:
    print(f"  ✔ {text}")


def fail(text: str, fixes: list[str]) -> NoReturn:
    print(f"  ✘ {text}")
    for fix in fixes:
        print(f"    → {fix}")
    sys.exit(1)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--create-db", action="store_true", help="주소의 데이터베이스가 없으면 만든다")
    args = parser.parse_args()
    url = settings.database_url

    print(f"DB 접속 점검: {describe(url)}")
    for problem in url_problems(url):
        print(f"  ! {problem}")

    try:
        parts = urlsplit(url.strip())
        host, port, dbname = parts.hostname or "", parts.port or 5432, parts.path.strip("/")
    except ValueError:
        fail("주소 형식", url_problems(url))

    # 1) 이름 찾기 (DNS): 엔드포인트 오타
    try:
        addresses = sorted({a[4][0] for a in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)})
    except (socket.gaierror, UnicodeError) as error:
        fail(f"DB 주소 {host or '(빈 값)'} 찾기: {error}", [dns_hint(url)])
    ok(f"DB 주소 찾음: {host} → {', '.join(addresses)}")

    # 2) 포트 연결: 보안 그룹·DB 상태
    try:
        socket.create_connection((host, port), timeout=CHECK_TIMEOUT).close()
    except TimeoutError:
        fail(f"{port} 포트 연결: {CHECK_TIMEOUT}초 동안 응답 없음", [timeout_hint(url)])
    except OSError as error:
        fail(f"{port} 포트 연결: {error}", [REFUSED_HINT])
    ok(f"{port} 포트 연결됨")

    # 3) 로그인 (사용자·암호·데이터베이스·암호화)
    try:
        conn = psycopg.connect(url, connect_timeout=CHECK_TIMEOUT)
    except psycopg.Error as error:
        if args.create_db and f'database "{dbname}" does not exist' in str(error):
            create_database(url, dbname)
            conn = psycopg.connect(url, connect_timeout=CHECK_TIMEOUT)
        else:
            fail(f"로그인: {message(error, url)}", hints(error, url))

    with conn:
        version = conn.execute("SHOW server_version").fetchone()[0]
        ssl = conn.pgconn.ssl_in_use
        ok(f"로그인됨: PostgreSQL {version}, 암호화 접속 {'예' if ssl else '아니요'}")

        # 4) 확장 기능 (db/schema가 쓰는 것)
        available = {name for (name,) in conn.execute("SELECT name FROM pg_available_extensions")}
        missing = [e for e in EXTENSIONS if e not in available]
        if missing:
            fail(
                f"확장 기능 없음: {', '.join(missing)}",
                ["PostgreSQL 16 이상(RDS면 엔진 버전 16.x)인지 보세요. 로컬 DB면 pgvector/pgvector:pg16 이미지로."],
            )
        ok(f"확장 기능 있음: {', '.join(EXTENSIONS)}")

        # 5) 테이블: 처음이면 init_db
        tables = conn.execute("SELECT count(*) FROM pg_tables WHERE schemaname = 'public'").fetchone()[0]
        if tables == 0:
            print("  ! 테이블이 아직 없어요. 처음 한 번 테이블과 목업 데이터를 넣으세요:")
            print(f"    → {INIT_COMMAND}")
        else:
            ok(f"테이블 {tables}개")
    print("DB 접속 정상")


def create_database(url: str, dbname: str) -> None:
    """같은 계정으로 기본 데이터베이스(postgres)에 붙어서 만든다. RDS 마스터 계정은 만들 권한이 있다."""
    parts = urlsplit(url.strip())
    admin_url = urlunsplit(parts._replace(path="/postgres"))
    try:
        with psycopg.connect(admin_url, connect_timeout=CHECK_TIMEOUT, autocommit=True) as conn:
            conn.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(dbname)))
    except psycopg.Error as error:
        fail(f'데이터베이스 "{dbname}" 만들기: {message(error, url)}', hints(error, url))
    ok(f'데이터베이스 "{dbname}" 만듦')


if __name__ == "__main__":
    main()
