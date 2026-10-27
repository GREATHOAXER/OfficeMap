"""db/schema 파일과 지금 DB를 맞춰 본다: 새 버전에서 늘어난 테이블·컬럼·함수가 DB에 들어갔는지.

init_db --upgrade가 빠진 파일만 넣고, check_db·서버를 켤 때 로그(app/db_check.py)·API 오류(app/main.py)가
무엇이 빠졌는지 알려 준다. 배포 스크립트(deploy/remote-deploy.sh)는 새 버전을 띄우기 전에 init_db --upgrade를 돌린다.

파일마다 만드는 것(테이블·인덱스·컬럼·함수)이 DB에 있는지 보고 셋 중 하나로 본다:
  APPLIED  다 있다
  MISSING  넣어야 한다. 테이블을 만드는 파일이면 그 테이블·인덱스가 하나도 없을 때,
           여러 번 돌려도 되는 파일(IF NOT EXISTS · CREATE OR REPLACE만 있는 것)이면 하나라도 없을 때
  PARTIAL  일부만 있다: 넣은 뒤에 고친 파일이라 자동으로 넣을 수 없다 (손으로 맞춘다)
그래서 이미 있는 테이블을 바꿀 때는 기존 파일을 고치지 않고 새 파일에 ALTER TABLE ... ADD COLUMN IF NOT EXISTS로 쓴다
(13_ai_chat.sql처럼). 기존 파일의 CREATE TABLE 안에서 바뀐 것(컬럼·제약)은 여기서 알 수 없다.
"""

import re
from dataclasses import dataclass
from functools import cache
from pathlib import Path

from psycopg import Connection
from psycopg.rows import tuple_row

DB_DIR = Path(__file__).resolve().parents[2] / "db"
SCHEMA_DIR = DB_DIR / "schema"
UPGRADE_COMMAND = "docker compose run --rm backend python -m scripts.init_db --upgrade"

_NAME = r'"?(\w+)"?'
_IF_NOT_EXISTS = r"(IF\s+NOT\s+EXISTS\s+)?"
_RELATION = re.compile(rf"CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)\s+{_IF_NOT_EXISTS}(?!ON\s){_NAME}", re.I)
_FUNCTION = re.compile(rf"CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+{_NAME}", re.I)
_ALTER = re.compile(rf"ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?{_NAME}\s+", re.I)
_ADD_COLUMN = re.compile(rf"ADD\s+COLUMN\s+{_IF_NOT_EXISTS}{_NAME}", re.I)
# 이미 있으면 그대로 넘어가는 문장 (파일 전체가 이것뿐이면 여러 번 돌려도 된다)
_RERUNNABLE = re.compile(
    r"(CREATE\s+EXTENSION\s+IF\s+NOT\s+EXISTS|CREATE\s+(UNIQUE\s+)?(TABLE|INDEX)\s+IF\s+NOT\s+EXISTS"
    r"|CREATE\s+OR\s+REPLACE\s+FUNCTION|COMMENT\s+ON)\b",
    re.I,
)


@dataclass(frozen=True)
class SchemaFile:
    name: str
    relations: tuple[str, ...]  # 만드는 테이블·인덱스
    columns: tuple[tuple[str, str], ...]  # ALTER TABLE로 더하는 (테이블, 컬럼)
    functions: tuple[str, ...]
    rerunnable: bool  # 여러 번 돌려도 된다

    @property
    def path(self) -> Path:
        return SCHEMA_DIR / self.name


@dataclass(frozen=True)
class FileState:
    file: SchemaFile
    status: str  # APPLIED | MISSING | PARTIAL
    missing: tuple[str, ...]  # DB에 없는 것 (예: 테이블·인덱스 personnel_moves, 컬럼 ai_messages.blocks)

    def describe(self, limit: int = 4) -> str:
        """없는 것 몇 개만 (로그·화면 한 줄에)"""
        more = len(self.missing) - limit
        return ", ".join(self.missing[:limit]) + (f" 외 {more}개" if more > 0 else "")


def _statements(text: str) -> list[str]:
    text = re.sub(r"\$(\w*)\$.*?\$\1\$", "", text, flags=re.S)  # 함수 본문
    text = re.sub(r"--[^\n]*", "", text)
    return [s.strip() for s in text.split(";") if s.strip()]


def _clauses(text: str) -> list[str]:
    """ALTER TABLE 뒤의 절들 (괄호 안의 쉼표로는 나누지 않는다)"""
    while (flat := re.sub(r"\([^()]*\)", "", text)) != text:
        text = flat
    return [c.strip() for c in text.split(",")]


def parse(name: str, text: str) -> SchemaFile:
    relations: list[str] = []
    columns: list[tuple[str, str]] = []
    functions: list[str] = []
    statements = _statements(text)
    rerunnable = bool(statements)
    for stmt in statements:
        if m := _RELATION.match(stmt):
            relations.append(m[2].lower())
        elif m := _FUNCTION.match(stmt):
            functions.append(m[1].lower())
        elif m := _ALTER.match(stmt):
            adds = [_ADD_COLUMN.match(c) for c in _clauses(stmt[m.end() :])]
            columns += [(m[1].lower(), a[2].lower()) for a in adds if a]
            if all(a and a[1] for a in adds):
                continue  # ADD COLUMN IF NOT EXISTS만 있다
        if not _RERUNNABLE.match(stmt):
            rerunnable = False
    return SchemaFile(name, tuple(relations), tuple(columns), tuple(functions), rerunnable)


@cache
def schema_files() -> tuple[SchemaFile, ...]:
    """db/schema의 파일 (이름 순서 = 넣는 순서)"""
    return tuple(parse(p.name, p.read_text(encoding="utf-8")) for p in sorted(SCHEMA_DIR.glob("*.sql")))


def check(conn: Connection) -> list[FileState]:
    """파일마다 DB에 들어갔는지 (조회만 한다)"""
    files = schema_files()
    cur = conn.cursor(row_factory=tuple_row)
    have_relations = {
        name
        for (name,) in cur.execute(
            "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
            "WHERE n.nspname = 'public' AND c.relname = ANY(%s)",
            ([r for f in files for r in f.relations],),
        )
    }
    have_columns = set(
        cur.execute(
            "SELECT table_name::text, column_name::text FROM information_schema.columns "
            "WHERE table_schema = 'public' AND table_name = ANY(%s)",
            ([t for f in files for t, _ in f.columns],),
        )
    )
    have_functions = {
        name
        for (name,) in cur.execute(
            "SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace "
            "WHERE n.nspname = 'public' AND p.proname = ANY(%s)",
            ([fn for f in files for fn in f.functions],),
        )
    }

    states: list[FileState] = []
    for f in files:
        missing = (
            [f"테이블·인덱스 {r}" for r in f.relations if r not in have_relations]
            + [f"컬럼 {t}.{c}" for t, c in f.columns if (t, c) not in have_columns]
            + [f"함수 {fn}" for fn in f.functions if fn not in have_functions]
        )
        if not missing:
            status = "APPLIED"
        elif f.rerunnable:
            status = "MISSING"
        elif f.relations:  # 테이블을 만드는 파일: 그 테이블·인덱스가 하나도 없으면 아직 안 넣은 것
            status = "PARTIAL" if any(r in have_relations for r in f.relations) else "MISSING"
        else:
            status = "MISSING" if len(missing) == len(f.columns) + len(f.functions) else "PARTIAL"
        states.append(FileState(f, status, tuple(missing)))
    return states


def upgrade_plan(states: list[FileState]) -> list[SchemaFile]:
    """init_db --upgrade가 돌릴 파일: 빠진 파일, 그리고 하나라도 넣을 때는 여러 번 돌려도 되는 파일 모두
    (함수 본문이 새 테이블을 쓰도록 바뀌었을 수 있다. 예: 09_retention.sql이 12_personnel.sql의 테이블도 정리한다)"""
    if not any(s.status == "MISSING" for s in states):
        return []
    return [s.file for s in states if s.status == "MISSING" or (s.status == "APPLIED" and s.file.rerunnable)]


def file_for(error_text: str) -> str | None:
    """'relation "personnel_moves" does not exist' 같은 DB 오류에서, 그것을 만드는 db/schema 파일 이름"""
    m = re.search(r'(relation|column|function) "?([\w.]+)"?(?:\(.*?\))? does not exist', error_text)
    if not m:
        return None
    kind, name = m[1], m[2].rsplit(".", 1)[-1].lower()
    for f in schema_files():
        if (
            (kind == "relation" and name in f.relations)
            or (kind == "column" and any(c == name for _, c in f.columns))
            or (kind == "function" and name in f.functions)
        ):
            return f.name
    return None
