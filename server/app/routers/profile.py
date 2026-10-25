"""내 정보 API: 직원이 스스로 고치는 프로필(사진·부르는 이름·한 줄 소개·하는 일·업무 키워드).

이름·부서·직급·내선·이메일은 인사 정보(조직도)라 여기서 바꾸지 않는다. 프로필은 employee_profiles·employee_photos에
따로 두어 조직도를 다시 가져와도 남는다. 하는 일·키워드는 직원 검색과 AI 도우미(담당자 찾기)가 쓴다.
"""

import json
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field, field_validator

from app.db import pool
from app.routers.auth import client_info, photo_url
from app.session import CurrentUser

router = APIRouter(tags=["profile"])

MAX_PHOTO_BYTES = 400_000  # 화면에서 320px로 줄여 올리면 보통 30KB 안팎
MAX_SKILLS = 15
MAX_SKILL_LEN = 20
# 파일 앞부분으로 실제 그림 형식을 확인한다 (보낸 content-type만 믿지 않는다)
MAGIC = {
    "image/jpeg": (b"\xff\xd8\xff",),
    "image/png": (b"\x89PNG\r\n\x1a\n",),
    "image/webp": (b"RIFF",),
}


def profile_out(row: dict[str, Any]) -> dict[str, Any]:
    """다른 사람에게 보이는 프로필 칸 (자리 카드·검색 결과). row에 display_name·headline·duties·skills·photo_at"""
    return {
        "photo": photo_url(row["emp_no"], row.get("photo_at")),
        "display_name": row.get("display_name"),
        "headline": row.get("headline"),
        "duties": row.get("duties"),
        "skills": row.get("skills") or [],
    }


# employees e 와 함께 쓰는 조인 (프로필·사진 시각)
PROFILE_JOIN = """
    LEFT JOIN employee_profiles pr ON pr.employee_id = e.id
    LEFT JOIN employee_photos ph ON ph.employee_id = e.id
"""
PROFILE_COLUMNS = "pr.display_name, pr.headline, pr.duties, pr.skills, ph.updated_at AS photo_at"


def _clean(text: str | None) -> str | None:
    if text is None:
        return None
    text = text.strip()
    return text or None


class ProfileIn(BaseModel):
    display_name: str | None = Field(default=None, max_length=30)
    headline: str | None = Field(default=None, max_length=80)
    duties: str | None = Field(default=None, max_length=1000)
    skills: list[str] = Field(default_factory=list, max_length=50)

    @field_validator("display_name", "headline", "duties")
    @classmethod
    def strip(cls, value: str | None) -> str | None:
        return _clean(value)

    @field_validator("skills")
    @classmethod
    def tidy_skills(cls, value: list[str]) -> list[str]:
        """앞뒤 공백·#·쉼표를 떼고, 같은 키워드(대소문자 무시)는 하나만"""
        out: list[str] = []
        seen: set[str] = set()
        for raw in value:
            skill = raw.strip().lstrip("#").replace(",", " ").strip()
            if not skill:
                continue
            if len(skill) > MAX_SKILL_LEN:
                raise ValueError(f"키워드는 {MAX_SKILL_LEN}자까지예요")
            if skill.lower() in seen:
                continue
            seen.add(skill.lower())
            out.append(skill)
        if len(out) > MAX_SKILLS:
            raise ValueError(f"키워드는 {MAX_SKILLS}개까지예요")
        return out


def _my_profile(conn: Any, employee_id: int) -> dict[str, Any]:
    row = conn.execute(
        f"""
        SELECT e.emp_no, e.name, e.rank_name, e.position_name, e.email, e.extension,
               d.name AS department, pd.name AS division, {PROFILE_COLUMNS}, pr.updated_at
        FROM employees e
        JOIN departments d ON d.id = e.department_id
        LEFT JOIN departments pd ON pd.id = d.parent_id
        {PROFILE_JOIN}
        WHERE e.id = %s
        """,
        (employee_id,),
    ).fetchone()
    return {
        "emp_no": row["emp_no"],
        # 인사 정보 (여기서 바꾸지 않는다)
        "name": row["name"],
        "rank": row["rank_name"],
        "position": row["position_name"],
        "department": row["department"],
        "division": row["division"],
        "email": row["email"],
        "extension": row["extension"],
        # 내가 고치는 것
        **profile_out(row),
        "updated_at": row["updated_at"],
    }


def _audit(conn: Any, user: dict[str, Any], action: str, data: dict[str, Any], request: Request) -> None:
    conn.execute(
        """
        INSERT INTO audit_logs (actor_id, action, target_type, target_id, after_data, ip_address)
        VALUES (%s, %s, 'employee', %s, %s, %s)
        """,
        (user["employee_id"], action, user["employee_id"], json.dumps(data), client_info(request)[0]),
    )


@router.get("/api/profile")
def get_profile(user: CurrentUser) -> dict[str, Any]:
    with pool.connection() as conn:
        return _my_profile(conn, user["employee_id"])


@router.put("/api/profile")
def put_profile(body: ProfileIn, user: CurrentUser, request: Request) -> dict[str, Any]:
    """내 정보 저장 (부르는 이름·한 줄 소개·하는 일·업무 키워드를 통째로)"""
    with pool.connection() as conn:
        before = conn.execute(
            "SELECT display_name, headline, duties, skills FROM employee_profiles WHERE employee_id = %s",
            (user["employee_id"],),
        ).fetchone() or {"display_name": None, "headline": None, "duties": None, "skills": []}
        after = body.model_dump()
        changed = [key for key in after if (before[key] or None) != (after[key] or None)]
        conn.execute(
            """
            INSERT INTO employee_profiles (employee_id, display_name, headline, duties, skills)
            VALUES (%(id)s, %(display_name)s, %(headline)s, %(duties)s, %(skills)s)
            ON CONFLICT (employee_id) DO UPDATE
            SET display_name = EXCLUDED.display_name, headline = EXCLUDED.headline, duties = EXCLUDED.duties,
                skills = EXCLUDED.skills, updated_at = now()
            """,
            {"id": user["employee_id"], **after},
        )
        if changed:
            # 무엇을 바꿨는지만 남긴다 (내용은 프로필에 있다)
            _audit(conn, user, "PROFILE_UPDATE", {"fields": changed}, request)
        return _my_profile(conn, user["employee_id"])


@router.put("/api/profile/photo")
async def put_photo(user: CurrentUser, request: Request) -> dict[str, Any]:
    """사진 올리기: 요청 본문이 그림 파일 그대로 (content-type: image/jpeg·png·webp, 400KB까지)"""
    content_type = (request.headers.get("content-type") or "").split(";")[0].strip().lower()
    if content_type not in MAGIC:
        raise HTTPException(status_code=415, detail={"code": "PHOTO_TYPE"})
    length = request.headers.get("content-length")
    if length and length.isdigit() and int(length) > MAX_PHOTO_BYTES:
        raise HTTPException(status_code=413, detail={"code": "PHOTO_TOO_BIG", "max": MAX_PHOTO_BYTES})
    data = await request.body()
    if len(data) > MAX_PHOTO_BYTES:
        raise HTTPException(status_code=413, detail={"code": "PHOTO_TOO_BIG", "max": MAX_PHOTO_BYTES})
    if not any(data.startswith(m) for m in MAGIC[content_type]) or (
        content_type == "image/webp" and data[8:12] != b"WEBP"
    ):
        raise HTTPException(status_code=415, detail={"code": "PHOTO_TYPE"})
    with pool.connection() as conn:
        row = conn.execute(
            """
            INSERT INTO employee_photos (employee_id, image, content_type) VALUES (%s, %s, %s)
            ON CONFLICT (employee_id) DO UPDATE
            SET image = EXCLUDED.image, content_type = EXCLUDED.content_type, updated_at = now()
            RETURNING updated_at
            """,
            (user["employee_id"], data, content_type),
        ).fetchone()
        _audit(conn, user, "PROFILE_PHOTO_SET", {"bytes": len(data), "type": content_type}, request)
    return {"photo": photo_url(user["emp_no"], row["updated_at"])}


@router.delete("/api/profile/photo", status_code=204)
def delete_photo(user: CurrentUser, request: Request) -> Response:
    with pool.connection() as conn:
        gone = conn.execute("DELETE FROM employee_photos WHERE employee_id = %s", (user["employee_id"],)).rowcount
        if gone:
            _audit(conn, user, "PROFILE_PHOTO_DELETE", {}, request)
    return Response(status_code=204)


@router.get("/api/employees/{emp_no}/photo")
def get_photo(emp_no: str, user: CurrentUser, request: Request, v: int | None = None) -> Response:
    """직원 사진 (로그인한 사람만). 주소에 v(바꾼 시각)가 있으면 브라우저가 하루 동안 다시 묻지 않는다"""
    with pool.connection() as conn:
        row = conn.execute(
            """
            SELECT ph.image, ph.content_type, ph.updated_at
            FROM employee_photos ph JOIN employees e ON e.id = ph.employee_id
            WHERE e.emp_no = %s AND e.employment_status = 'ACTIVE'
            """,
            (emp_no,),
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail={"code": "NO_PHOTO"})
    etag = f'"{int(row["updated_at"].timestamp() * 1000)}"'
    headers = {
        "ETag": etag,
        "Cache-Control": "private, max-age=86400" if v is not None else "private, no-cache",
        "X-Content-Type-Options": "nosniff",
    }
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    return Response(content=bytes(row["image"]), media_type=row["content_type"], headers=headers)
