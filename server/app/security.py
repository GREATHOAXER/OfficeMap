import hashlib
import secrets

import bcrypt

# 없는 사번으로 로그인할 때도 비밀번호 검사 시간을 똑같이 쓰려고 쓰는 해시
_DUMMY_HASH = bcrypt.hashpw(b"officemap-dummy", bcrypt.gensalt(12))


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt(12)).decode()


def verify_password(password: str, password_hash: str | None) -> bool:
    target = password_hash.encode() if password_hash else _DUMMY_HASH
    try:
        ok = bcrypt.checkpw(password.encode(), target)
    except ValueError:  # 72바이트 넘는 비밀번호, 깨진 해시
        return False
    return ok and password_hash is not None


def new_session_token() -> tuple[str, str]:
    """(쿠키에 넣을 토큰, DB에 넣을 해시)"""
    token = secrets.token_urlsafe(32)
    return token, hash_token(token)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()
