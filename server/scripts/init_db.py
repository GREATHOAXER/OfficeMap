"""DB에 테이블과 목업 데이터를 넣는다.

server 디렉토리에서 실행:
    python -m scripts.init_db            # 빈 DB에 db/schema + db/seed 실행
    python -m scripts.init_db --reset    # 기존 테이블을 모두 지우고 다시 (개발용)
    python -m scripts.init_db --no-seed  # 테이블만
    python -m scripts.init_db --upgrade  # 데이터는 그대로 두고, 새 버전에서 늘어난 db/schema 파일만 실행
    python -m scripts.init_db --only 12_personnel.sql 09_retention.sql
        # 데이터는 그대로 두고 db/schema의 이 파일만 실행
배포 서버(deploy 디렉토리)에서는 앞에 docker compose run --rm backend 를 붙인다. 새 버전 배포(deploy/remote-deploy.sh)는
띄우기 전에 --upgrade를 돌린다. 무엇이 빠졌는지 보는 법: app/schema.py
"""

import argparse
from pathlib import Path

import psycopg

from app import schema
from app.config import settings

DB_DIR = schema.DB_DIR


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--reset", action="store_true", help="public 스키마의 테이블을 모두 지우고 다시 만든다")
    parser.add_argument("--no-seed", action="store_true", help="목업 데이터는 넣지 않는다")
    parser.add_argument(
        "--only",
        nargs="+",
        metavar="파일",
        help="데이터는 그대로 두고 db/schema의 이 파일만 실행한다 (예: 12_personnel.sql)",
    )
    parser.add_argument(
        "--upgrade",
        action="store_true",
        help="데이터는 그대로 두고, DB에 아직 없는 db/schema 파일만 실행한다 (새 버전으로 바꿀 때)",
    )
    args = parser.parse_args()
    if args.reset and settings.app_env == "production":
        raise SystemExit("APP_ENV=production인 서버에서는 --reset(모든 테이블 지우기)을 쓸 수 없습니다.")
    if sum(map(bool, (args.only, args.reset, args.upgrade))) > 1:
        raise SystemExit("--only, --reset, --upgrade는 하나만 쓸 수 있습니다.")

    if args.only:
        files = [DB_DIR / "schema" / name for name in args.only]
        missing = [f.name for f in files if not f.is_file()]
        if missing:
            raise SystemExit(f"db/schema에 없는 파일입니다: {', '.join(missing)}")
    else:
        files = sorted((DB_DIR / "schema").glob("*.sql"))
        if not args.no_seed:
            files += sorted((DB_DIR / "seed").glob("*.sql"))

    try:
        conn = psycopg.connect(settings.database_url)
    except psycopg.OperationalError as error:
        raise SystemExit(
            f"DB에 연결하지 못했습니다: {error}\n"
            "DB가 켜져 있는지(docker compose up -d db), server/.env의 DATABASE_URL이 맞는지 확인하세요.\n"
            "배포 서버에서 막힌 곳 찾기: docker compose run --rm backend python -m scripts.check_db"
        ) from None

    # 파일 하나라도 실패하면 전부 되돌린다 (with 블록을 예외로 빠져나가면 롤백)
    with conn:
        tables = [t for (t,) in conn.execute("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")]
        if args.upgrade:
            files = upgrade_files(conn, tables)
            if not files:
                return
        elif tables and not args.reset and not args.only:
            raise SystemExit(
                f"이미 테이블이 {len(tables)}개 있어서 아무것도 바꾸지 않고 멈췄습니다.\n"
                "목업 데이터를 처음 상태로 다시 넣으려면 기존 데이터를 지우는 --reset을 붙이세요:\n"
                "    python -m scripts.init_db --reset"
            )
        if args.reset:
            for table in tables:
                conn.execute(f'DROP TABLE IF EXISTS "{table}" CASCADE')
            print(f"기존 테이블 {len(tables)}개 삭제")
        for path in files:
            name = path.relative_to(DB_DIR.parent)
            try:
                conn.execute(path.read_text(encoding="utf-8"))
            except psycopg.Error as error:
                raise SystemExit(f"{name} 실행 중 오류가 나서 모든 변경을 되돌렸습니다:\n{error}") from None
            print(f"실행: {name}")
    print("완료")


def upgrade_files(conn: psycopg.Connection, tables: list[str]) -> list[Path]:
    """--upgrade로 돌릴 파일. 없으면 이유를 찍고 빈 목록"""
    if not tables:
        print("DB에 테이블이 없어서 아무것도 하지 않았습니다. 처음이면 목업까지: python -m scripts.init_db")
        return []
    states = schema.check(conn)
    for state in states:
        if state.status == "PARTIAL":
            # 넣은 뒤에 고친 파일: 다시 돌리면 이미 있는 것에서 멈추므로 건너뛴다 (배포는 막지 않는다)
            print(f"주의: {state.file.name}의 일부만 DB에 있어요 (없는 것: {state.describe()}). 손으로 맞추세요")
    plan = schema.upgrade_plan(states)
    if not plan:
        print("DB가 이 버전과 맞습니다. 넣을 파일이 없어요")
        return []
    for state in states:
        if state.status == "MISSING":
            print(f"DB에 없음: {state.file.name} ({state.describe()})")
    return [f.path for f in plan]


if __name__ == "__main__":
    main()
