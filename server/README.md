# OfficeMap API 서버 (FastAPI)

실행 방법은 저장소 최상위 `README.md`의 "2. API 서버"를 보세요.

```
app/
  main.py          FastAPI 앱, /api/health
  config.py        환경 변수 (.env)
  db.py            PostgreSQL 연결 풀, app_settings 읽기
  security.py      비밀번호 해시(bcrypt), 세션 토큰
  session.py       로그인 확인. 로그인이 필요한 API는 CurrentUser 인자를 받는다
  routers/auth.py      로그인 화면 API
  routers/office.py    자리·재실 현황 API
  routers/presence.py  내 재실 상태 바꾸기 API
scripts/
  init_db.py       db/schema + db/seed 실행
```

## 로그인 API

| 요청 | 하는 일 |
|---|---|
| `GET /api/auth/login-info` | 로그인 화면의 공지, 문의처, 자동 로그아웃 시간, 실패 허용 횟수 |
| `POST /api/auth/login` | 사번·비밀번호 로그인. 성공하면 HttpOnly 쿠키로 세션 발급 |
| `GET /api/auth/me` | 쿠키로 로그인한 사람 확인. 30분 미사용, 퇴사·잠금이면 401 |
| `POST /api/auth/logout` | 세션 종료, 쿠키 삭제 |

로그인 실패 응답은 `code`로 구분합니다. 화면 문구는 프론트엔드가 정합니다.

| 상태 | code | 같이 오는 값 |
|---|---|---|
| 401 | `INVALID_CREDENTIALS` | 있는 사번이면 `failed_count`, `max_failed_count` |
| 423 | `LOCKED` | `max_failed_count` |
| 403 | `NOT_ACTIVE` | 퇴사·휴직 |

로그인 시도는 성공·실패 모두 `login_history`에 남깁니다.

## 자리·재실 현황 API (로그인 필요, 아니면 401)

| 요청 | 하는 일 |
|---|---|
| `GET /api/office/sites` | 사업장과 층 목록, 층마다 입주 팀 이름. `my_floor_id`는 로그인한 사람의 자리가 있는 층 |
| `GET /api/office/floors/{층 ID}` | 게시된 도면(벽·기둥·공용 공간), 팀 구역, 회의실 지금 사용 여부, 좌석과 앉은 사람·재실 상태 |

- 좌표(`x`, `y`, `shape`)는 모두 도면 너비·높이 대비 비율(0~1)입니다. 좌석 `x`, `y`는 중심점입니다.
- 재실 상태는 `expires_at`이 지났으면 `null`로 내려갑니다.
- 퇴사·휴직 처리된 사람은 배정이 남아 있어도 빈 자리로 보입니다.
- 층의 `description`은 사무실이 아닌 층의 용도입니다 (예: 로비, 대강당). 사무실 층은 `null`입니다.

## 내 재실 상태 API (로그인 필요)

`presence_status` 테이블에 직원당 1행을 덮어씁니다. 이력은 남기지 않습니다.

| 요청 | 하는 일 |
|---|---|
| `GET /api/presence/me` | 지금 내 상태. 없거나 자동 해제 시각이 지났으면 `{"presence": null}` |
| `PUT /api/presence/me` | 상태 저장. `{"status", "message", "duration"}` |
| `DELETE /api/presence/me` | 상태 지우기 (204) |

- `status`: `AVAILABLE` 방문 가능, `DO_NOT_DISTURB` 방해 금지, `IN_MEETING` 회의 중, `AWAY` 자리 비움
- `message`: 100자까지, 빈 문자열이면 지웁니다.
- `duration`: 자동 해제 시각(`expires_at`). `NONE` 계속, `30M`, `1H`, `END_OF_DAY` 퇴근 시
  (`app_settings`의 `presence.workday_end`, 기본 18:00. 이미 지났으면 오늘 자정)
