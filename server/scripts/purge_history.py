"""보관 기간(기본 5년)이 지난 이력을 지운다. 서버도 하루 한 번 같은 일을 한다 (app/jobs.py).

server 디렉토리에서 실행:
    python -m scripts.purge_history             # 5년 지난 이력 지우기
    python -m scripts.purge_history --dry-run   # 지울 개수만 보고 되돌리기
    python -m scripts.purge_history --years 7   # 보관 기간을 바꿔서
"""

import argparse
import json

import psycopg

from app.config import settings


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--years", type=int, default=5, help="보관 기간 (년, 기본 5)")
    parser.add_argument("--dry-run", action="store_true", help="지울 개수만 보여 주고 아무것도 바꾸지 않는다")
    args = parser.parse_args()
    if args.years < 1:
        raise SystemExit("보관 기간은 1년 이상이어야 합니다")

    with psycopg.connect(settings.database_url) as conn:
        (result,) = conn.execute("SELECT purge_history(make_interval(years => %s))", (args.years,)).fetchone()
        print(json.dumps(result, ensure_ascii=False, indent=2))
        if args.dry_run:
            conn.rollback()
            print("--dry-run: 되돌렸습니다 (아무것도 지우지 않음)")


if __name__ == "__main__":
    main()
