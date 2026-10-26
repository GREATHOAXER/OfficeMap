"""DB에 테이블과 목업 데이터를 넣는다.

server 디렉토리에서 실행:
    python -m scripts.init_db            # 빈 DB에 db/schema + db/seed 실행
    python -m scripts.init_db --reset    # 기존 테이블을 모두 지우고 다시 (개발용)
    python -m scripts.init_db --no-seed  # 테이블만
"""

import argparse
from pathlib import Path

import psycopg

from app.config import settings

DB_DIR = Path(__file__).resolve().parents[2] / "db"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--reset", action="store_true", help="public 스키마의 테이블을 모두 지우고 다시 만든다")
    parser.add_argument("--no-seed", action="store_true", help="목업 데이터는 넣지 않는다")
    args = parser.parse_args()
    if args.reset and settings.app_env == "production":
        raise SystemExit("APP_ENV=production인 서버에서는 --reset(모든 테이블 지우기)을 쓸 수 없습니다.")

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
        if tables and not args.reset:
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


if __name__ == "__main__":
    main()
