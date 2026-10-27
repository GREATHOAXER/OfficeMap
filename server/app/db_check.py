"""DB에 접속하지 못할 때 이유와 고칠 곳을 알려 준다.

서버를 켤 때(app/main.py) 한 번 접속해 보고 안 되면 로그에 남기고, 점검 스크립트(scripts/check_db.py)가 단계별로 쓴다.
DB 접속이 안 되면 API 상태 확인(/api/health)이 실패해서 docker compose가
"dependency failed to start: container officemap-backend-1 is unhealthy"라고만 보여 주기 때문이다.
"""

import logging
import re
from urllib.parse import unquote, urlsplit

import psycopg

from app import schema

log = logging.getLogger(__name__)

CHECK_COMMAND = "docker compose run --rm backend python -m scripts.check_db"
INIT_COMMAND = "docker compose run --rm backend python -m scripts.init_db"
CHECK_TIMEOUT = 5  # 초. 보안 그룹에 막히면 응답 없이 기다리기만 하므로 짧게
GENERIC = "위 오류 문구로 원인을 찾아보세요."
REFUSED_HINT = "DB 서버가 접속을 거절했어요. 포트(5432)가 맞는지, DB가 켜지는 중은 아닌지 보세요."
_SYMBOL_HINT = (
    "주소를 읽을 수 없어요. 대개 암호에 기호(@ # ? / % : 등)가 있어서예요. "
    "RDS → 데이터베이스 → officemap-db → 수정에서 마스터 암호를 영문·숫자로만 바꾸고 .env도 같이 고치세요."
)


def describe(url: str) -> str:
    """암호를 가린 접속 주소 (로그·화면에 보여도 되게)."""
    try:
        parts = urlsplit(url)
        user = unquote(parts.username or "?")
        return f"{user}@{parts.hostname or '?'}:{parts.port or 5432}{parts.path or '/'}" + (
            f"?{parts.query}" if parts.query else ""
        )
    except ValueError:
        return "(주소 형식이 깨져서 읽을 수 없음)"


def url_problems(url: str) -> list[str]:
    """접속해 보기 전에 주소만 보고 알 수 있는 실수."""
    problems: list[str] = []
    if "<" in url or ">" in url:
        problems.append("주소에 꺾쇠(< >)가 있어요. <마스터 암호>·<RDS 엔드포인트>는 꺾쇠까지 지우고 값만 넣으세요.")
    if "xxxxxxxxxxxx" in url or "비밀번호" in url:
        problems.append("예시 값(비밀번호, xxxxxxxxxxxx)이 그대로 있어요. 실제 암호와 RDS 엔드포인트로 바꾸세요.")
    if url != url.strip() or url[:1] in "\"'":
        problems.append("주소 앞뒤에 빈칸이나 따옴표가 있어요. DATABASE_URL= 바로 뒤에 주소만 넣으세요.")
    try:
        parts = urlsplit(url.strip())
        port = parts.port
    except ValueError:
        parts, port = urlsplit(""), None
        problems.append(_SYMBOL_HINT)
    else:
        if parts.scheme not in ("postgresql", "postgres"):
            problems.append("주소는 postgresql:// 로 시작해야 해요.")
        elif parts.netloc.count("@") > 1 or parts.fragment or not parts.hostname:
            problems.append(_SYMBOL_HINT)
        elif not parts.path.strip("/"):
            problems.append("주소 끝에 DB 이름이 없어요: ...:5432/officemap 처럼 /officemap 을 붙이세요.")
    host = _host(url)
    if host.endswith(".rds.amazonaws.com") and "sslmode=" not in parts.query:
        problems.append("RDS는 암호화 접속만 받아요. 주소 끝에 ?sslmode=require 를 붙이세요.")
    if port is not None and port != 5432 and host.endswith(".rds.amazonaws.com"):
        problems.append(f"포트가 {port}이에요. RDS PostgreSQL은 보통 5432예요.")
    return problems


def message(error: BaseException, url: str) -> str:
    """오류 문구 한 줄로: 암호는 가리고, 접속을 여러 번 시도해서 같은 줄이 반복되면 한 번만."""
    lines = [line.strip().removeprefix("connection failed: ") for line in str(error).splitlines()]
    return redact(" / ".join(dict.fromkeys(line for line in lines if line)), url)


def redact(text: str, url: str) -> str:
    """오류 문구에서 암호를 가린다. 주소가 깨지면 오류 문구에 암호 조각이 "..."로 섞여 나온다."""
    rest = url.split("://", 1)[-1]
    userinfo = rest.rsplit("@", 1)[0] if "@" in rest else ""
    password = userinfo.split(":", 1)[1] if ":" in userinfo else ""
    if not password:
        return text
    text = text.replace(password, "***")
    return re.sub(r'"([^"]+)"', lambda m: '"***"' if m[1] in password else m[0], text)


def _host(url: str) -> str:
    try:
        return urlsplit(url.strip()).hostname or ""
    except ValueError:
        return ""


def dns_hint(url: str) -> str:
    return (
        f"DB 주소 {_host(url) or '(빈 값)'}를 찾을 수 없어요. 엔드포인트 오타일 가능성이 커요: "
        "RDS → 데이터베이스 → officemap-db → 연결 및 보안 → 엔드포인트를 그대로 복사해 넣으세요."
    )


def timeout_hint(url: str) -> str:
    if _host(url).endswith(".rds.amazonaws.com"):
        return (
            "DB 서버가 응답하지 않아요. 대개 RDS 보안 그룹이 이 EC2에서 오는 5432 접속을 막고 있어서예요. "
            "RDS → 데이터베이스 → officemap-db → 작업 → 'EC2 연결 설정'에서 officemap-app을 고르면 열립니다 "
            "(또는 RDS 보안 그룹 인바운드 규칙에 유형 PostgreSQL, 소스 officemap-app-sg 추가). "
            "RDS 상태가 '사용 가능'인지(일시 중지·시작 중이 아닌지)도 보세요."
        )
    return "DB 서버가 응답하지 않아요. 주소·포트가 맞는지, DB가 켜져 있는지, 방화벽(보안 그룹)이 막지 않는지 보세요."


def explain(error: BaseException, url: str) -> str:
    """psycopg 접속 오류를 고칠 곳으로 바꾼다."""
    text = str(error)
    if "password authentication failed" in text:
        return (
            "암호가 틀렸어요. .env의 DATABASE_URL에서 officemap: 뒤, @ 앞이 RDS 마스터 암호와 같은지 보세요. "
            "암호가 기억나지 않으면 RDS → 데이터베이스 → officemap-db → 수정 → 마스터 암호 변경."
        )
    if m := re.search(r'database "([^"]+)" does not exist', text):
        return (
            f'DB 서버에는 접속했는데 "{m[1]}"라는 데이터베이스가 없어요 '
            "(RDS를 만들 때 '추가 구성 → 초기 데이터베이스 이름'을 비워 둔 경우). 만들려면:\n"
            f"    {CHECK_COMMAND} --create-db"
        )
    if m := re.search(r'role "([^"]+)" does not exist', text):
        return f'"{m[1]}" 사용자가 없어요. 주소의 postgresql:// 바로 뒤가 RDS 마스터 사용자 이름(officemap)인지 보세요.'
    if "permission denied to create database" in text:
        return "이 계정은 데이터베이스를 만들 권한이 없어요. RDS 마스터 사용자(officemap)로 접속하는 주소인지 보세요."
    if "no pg_hba.conf entry" in text and "no encryption" in text:
        return "DB가 암호화하지 않은 접속을 막았어요. 주소 끝에 ?sslmode=require 를 붙이세요."
    if "server does not support SSL" in text:
        return "이 DB는 암호화 접속을 지원하지 않아요(내 PC·local-db). 주소 끝의 ?sslmode=require 를 지우세요."
    if "resolve host" in text or "could not translate host name" in text or "Name or service not known" in text:
        return dns_hint(url)
    if "timeout expired" in text or "timed out" in text:
        return timeout_hint(url)
    if "Connection refused" in text:
        return REFUSED_HINT
    if "invalid dsn" in text or "invalid connection option" in text or "invalid integer value" in text:
        return _SYMBOL_HINT
    return GENERIC


def log_problems(url: str) -> None:
    """서버를 켤 때 한 번 접속해 보고, 안 되면 이유를, 테이블이 없으면 init_db 안내를,
    이 버전의 db/schema 파일이 빠졌으면 init_db --upgrade 안내를 로그에 남긴다.
    서버는 그대로 켠다 (DB가 나중에 살아나면 접속 풀이 다시 붙는다)."""
    try:
        with psycopg.connect(url, connect_timeout=CHECK_TIMEOUT) as conn:
            empty = conn.execute("SELECT to_regclass('public.employees') IS NULL").fetchone()[0]
            behind = [] if empty else [s for s in schema.check(conn) if s.status != "APPLIED"]
    except Exception as error:  # noqa: BLE001 - 주소 형식 오류 등 무엇이든 로그로 알려 준다
        log.error(
            "DB에 접속하지 못했어요 (%s): %s\n  → %s\n  단계별 점검: %s",
            describe(url),
            message(error, url),
            "\n  → ".join(hints(error, url)),
            CHECK_COMMAND,
        )
        return
    if empty:
        log.warning("DB에 테이블이 아직 없어요. 처음 한 번: %s", INIT_COMMAND)
    elif behind:
        log.warning(
            'DB가 이 버전보다 오래됐어요. 이것을 쓰는 화면은 "불러오지 못했습니다"로 나와요:\n  %s\n'
            "  → 데이터는 그대로 두고 빠진 것만 넣기: %s",
            "\n  ".join(f"{s.file.name}: {s.describe()}" for s in behind),
            schema.UPGRADE_COMMAND,
        )


def hints(error: BaseException, url: str) -> list[str]:
    """고칠 곳: 오류에서 읽은 것 먼저, 그다음 주소에서 보이는 실수 (겹치는 것은 한 번만)."""
    first = explain(error, url)
    out = [] if first == GENERIC else [first]
    out += [p for p in url_problems(url) if p not in out]
    return out or [GENERIC]
