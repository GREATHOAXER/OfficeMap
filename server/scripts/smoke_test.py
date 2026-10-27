"""API 연기 시험: 켜 둔 API 서버에 목업 계정으로 들어가 주요 화면이 부르는 API를 한 번씩 불러 본다.
목업 데이터(init_db)가 든 DB에서 돌린다. CI(.github/workflows/ci.yml)가 쓰고, 손으로도 돌릴 수 있다:

    python -m scripts.smoke_test                       # http://localhost:8000
    python -m scripts.smoke_test --base http://localhost:8000

하나라도 기대와 다르면 무엇이 틀렸는지 찍고 1로 끝난다. 데이터를 바꾸는 요청은 하지 않는다 (인사이동은 미리 보기만).
"""

import argparse
import http.cookiejar
import json
import sys
import urllib.error
import urllib.request
from typing import Any

EMPLOYEE = ("20190005", "officemap1234")  # 조시우 (재무팀, 7F 자리 있음)
ADMIN = ("admin", "officemapking")  # 최종 관리자


class Client:
    def __init__(self, base: str) -> None:
        self.base = base.rstrip("/")
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def call(self, method: str, path: str, body: Any = None) -> tuple[int, Any]:
        req = urllib.request.Request(
            self.base + path,
            method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers={"content-type": "application/json"},
        )
        try:
            with self.opener.open(req, timeout=30) as res:
                raw = res.read()
                return res.status, json.loads(raw) if raw else None
        except urllib.error.HTTPError as error:
            raw = error.read()
            try:
                return error.code, json.loads(raw) if raw else None
            except ValueError:
                return error.code, raw[:200]


failures: list[str] = []


def check(name: str, ok: bool, detail: Any = "") -> None:
    print(f"{'ok  ' if ok else 'FAIL'} {name}" + (f"  ({detail})" if detail and not ok else ""))
    if not ok:
        failures.append(name)


def expect(client: Client, name: str, method: str, path: str, body: Any = None, status: int = 200) -> Any:
    got, data = client.call(method, path, body)
    check(f"{name}: {method} {path} → {status}", got == status, f"{got} {str(data)[:200]}")
    return data if got == status else None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base", default="http://localhost:8000", help="API 서버 주소")
    base = parser.parse_args().base

    anon = Client(base)
    health = expect(anon, "상태 확인", "GET", "/api/health")
    check("상태 확인 내용", health == {"status": "ok"}, health)
    expect(anon, "로그인 전 막힘", "GET", "/api/auth/me", status=401)
    expect(anon, "로그인 화면 안내", "GET", "/api/auth/login-info")

    # 직원 화면
    user = Client(base)
    expect(user, "직원 로그인", "POST", "/api/auth/login", {"emp_no": EMPLOYEE[0], "password": EMPLOYEE[1]})
    me = expect(user, "내 정보", "GET", "/api/auth/me")
    check("내 정보 사번", bool(me) and me.get("emp_no", me.get("user", {}).get("emp_no")) == EMPLOYEE[0], me)
    sites = expect(user, "사업장·층", "GET", "/api/office/sites")
    floors = [f for s in (sites or {}).get("sites", []) for f in s.get("floors", [])]
    check("층이 있음", bool(floors), sites)
    mine = expect(user, "내 자리", "GET", "/api/office/my-seat")
    seat = (mine or {}).get("seat")
    check("내 자리가 있음", bool(seat), mine)
    if seat:
        floor = expect(user, "내 층 도면·자리", "GET", f"/api/office/floors/{seat['floor_id']}")
        codes = {s.get("code") for s in (floor or {}).get("seats", [])}
        check("도면에 내 자리가 보임", seat["code"] in codes, sorted(codes)[:10])
    expect(user, "내 재실 상태", "GET", "/api/presence/me")
    expect(user, "회의실 예약표", "GET", "/api/rooms/day")
    expect(user, "내 예약", "GET", "/api/reservations/mine")
    expect(user, "직원은 관리자 API 못 씀", "GET", "/api/admin/overview", status=401)

    # 관리자 페이지 (최종 관리자)
    admin = Client(base)
    expect(admin, "관리자 로그인", "POST", "/api/admin/auth/login", {"emp_no": ADMIN[0], "password": ADMIN[1]})
    expect(admin, "관리자 정보", "GET", "/api/admin/auth/me")
    expect(admin, "사업장·층·권한", "GET", "/api/admin/overview")
    expect(admin, "승인함", "GET", "/api/admin/approvals")
    expect(admin, "조직도", "GET", "/api/admin/org")
    expect(admin, "좌석 배치 층", "GET", "/api/admin/seating/floors")
    plan_floors = expect(admin, "도면 편집 층", "GET", "/api/admin/plans/floors")
    if plan_floors and plan_floors.get("floors"):
        expect(admin, "도면 편집 화면", "GET", f"/api/admin/floors/{plan_floors['floors'][0]['id']}/plan")
    expect(admin, "팀 이사", "GET", "/api/admin/moves/options")
    expect(admin, "인사이동 기록", "GET", "/api/admin/personnel")
    preview = expect(
        admin,
        "인사이동 미리 보기",
        "POST",
        "/api/admin/personnel/preview",
        {"rows": [{"line": 2, "emp_no": EMPLOYEE[0], "to_department": "인사팀"}]},
    )
    check(
        "미리 보기 결과",
        bool(preview) and preview["rows"][0]["status"] in ("OK", "WARN") and preview["rows"][0]["result"] is not None,
        preview,
    )

    # AI 도우미: 켰는지만 본다 (CI에는 모델 설정이 없어 꺼져 있고, 꺼져 있으면 질문은 503)
    ai = expect(user, "AI 도우미 상태", "GET", "/api/ai/status")
    if ai and not ai.get("enabled"):
        expect(user, "AI 꺼져 있으면 질문 막힘", "POST", "/api/ai/chat", {"message": "안녕"}, status=503)

    print(f"\n{'모두 통과' if not failures else f'실패 {len(failures)}건'}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
