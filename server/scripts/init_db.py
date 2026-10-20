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

    files = sorted((DB_DIR / "schema").glob("*.sql"))
    if not args.no_seed:
        files += sorted((DB_DIR / "seed").glob("*.sql"))

    # 파일 하나라도 실패하면 전부 되돌린다
    with psycopg.connect(settings.database_url) as conn:
        if args.reset:
            tables = conn.execute("SELECT tablename FROM pg_tables WHERE schemaname = 'public'").fetchall()
            for (table,) in tables:
                conn.execute(f'DROP TABLE IF EXISTS "{table}" CASCADE')
            print(f"기존 테이블 {len(tables)}개 삭제")
        for path in files:
            conn.execute(path.read_text(encoding="utf-8"))
            print(f"실행: {path.relative_to(DB_DIR.parent)}")
    print("완료")


if __name__ == "__main__":
    main()
