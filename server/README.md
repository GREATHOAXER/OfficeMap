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
  routers/presence.py  내 재실 상태 바꾸기, 실시간 알림(SSE) API
  routers/employees.py 직원 검색 API (검색창, 참석자 추가)
  routers/rooms.py     회의실 확인·예약 API
  realtime.py      재실 상태 변경을 DB에서 받아(LISTEN) 열린 화면마다 나눠 주기
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

## 직원 검색 API (로그인 필요)

| 요청 | 하는 일 |
|---|---|
| `GET /api/employees/search?q=김민준` | 이름·팀·사번으로 찾기. 띄어 쓴 낱말은 모두 맞아야 함 (`김민준 IT`). 기본 20명 |

- 결과마다 직급·팀·지금 자리(사업장·층·좌석)·재실 상태가 붙습니다. 자리가 없으면 `seat: null`.
- `date`, `start_min`, `end_min`(서울 기준 그날 0시부터 분)을 같이 주면 그 시간에 겹치는 다른 회의(`busy`)와
  휴가·출장·재택(`absence`)도 알려 줍니다. 참석자를 고를 때 "이 시간 다른 회의" 표시에 씁니다.
- 이름이 같은 사람이 먼저, 그다음 이름이 그 글자로 시작하는 사람 순서입니다.

## 회의실 확인·예약 API (로그인 필요)

| 요청 | 하는 일 |
|---|---|
| `GET /api/rooms/day?date=2026-10-23&site_id=1` | 한 사업장 회의실들의 하루 예약 현황. 날짜·사업장을 빼면 오늘, 내 자리가 있는 사업장 |
| `POST /api/reservations` | 예약 만들기 (아래) |
| `GET /api/reservations/mine` | 내가 만들었거나 참석하는, 아직 끝나지 않은 예약 |
| `DELETE /api/reservations/{id}` | 예약 취소 (만든 사람만, 끝나기 전에만). 반복 예약은 그 회차만 |

- 시간은 모두 서울 기준 그날 0시부터 분(`start_min`, `end_min`)입니다. 13:30 → 810.
- 예약 정책은 `app_settings`에서 읽습니다: `room.slot_minutes`(30분 단위), `room.max_minutes`(최대 2시간),
  `room.open_hours`(08:00~20:00).
- `POST /api/reservations` 본문:
  `{"room_id", "date", "start_min", "end_min", "title", "attendees": [사번], "repeat": "NONE"|"WEEKLY"|"WEEKDAYS", "repeat_until", "notify"}`
  - 승인제 회의실(임원 회의실, 대강당)은 `PENDING_APPROVAL`(승인 대기)로 들어갑니다.
  - 반복 예약은 회차마다 한 행씩 만듭니다(`reservation_series`가 규칙). 석 달(92일), 60회까지.
    한 회차라도 겹치면 아무것도 만들지 않고 겹치는 날짜를 돌려줍니다.
  - `notify`면 참석자에게 화면 알림(`notifications`)을 쌓아 둡니다 (메신저 연동 전).
- 같은 회의실·겹치는 시간은 DB 제약(EXCLUDE)이 마지막으로 막습니다. 검사와 저장 사이에 누가 먼저 잡아도 409.

| 상태 | code | 뜻 |
|---|---|---|
| 409 | `TIME_TAKEN` | 그 시간에 이미 예약이 있음 (`dates`: 겹치는 날짜) |
| 422 | `INVALID_TIME` | 30분 단위가 아니거나 운영 시간 밖 |
| 422 | `TOO_LONG` | 최대 시간 넘음 |
| 422 | `IN_PAST` | 지난 시간 (지금 진행 중인 칸은 됨) |
| 422 | `TITLE_REQUIRED`, `INVALID_REPEAT`, `REPEAT_TOO_LONG`, `UNKNOWN_ATTENDEE` | 입력 확인 |
| 403 | `NOT_ORGANIZER` | 남의 예약 취소 |
| 409 | `NOT_CANCELLABLE` | 이미 끝났거나 취소된 예약 |

## 내 재실 상태 API (로그인 필요)

`presence_status` 테이블에 직원당 1행을 덮어씁니다. 이력은 남기지 않습니다.

| 요청 | 하는 일 |
|---|---|
| `GET /api/presence/me` | 지금 내 상태. 없거나 자동 해제 시각이 지났으면 `{"presence": null}` |
| `PUT /api/presence/me` | 상태 저장. `{"status", "message", "duration"}` |
| `DELETE /api/presence/me` | 상태 지우기 (204) |
| `GET /api/presence/stream` | 누구든 상태가 바뀔 때마다 보내는 실시간 알림 (SSE, 아래 참고) |

- `status`: `AVAILABLE` 방문 가능, `DO_NOT_DISTURB` 방해 금지, `IN_MEETING` 회의 중, `AWAY` 부재
- `message`: 100자까지, 빈 문자열이면 지웁니다.
- `duration`: 자동 해제 시각(`expires_at`). `NONE` 계속, `30M`, `1H`, `END_OF_DAY` 퇴근 시
  (`app_settings`의 `presence.workday_end`, 기본 18:00. 이미 지났으면 오늘 자정)

### 실시간 알림 (`/api/presence/stream`)

```
DB 트리거 ──NOTIFY presence_changed──▶ API 서버(LISTEN 연결 1개) ──SSE──▶ 열려 있는 화면들
```

- `presence_status`에 저장·삭제가 일어나면 트리거(`db/schema/05_presence.sql`)가 알림을 보냅니다.
  API를 거치지 않고 SQL로 직접 바꿔도 화면에 바로 반영됩니다.
- 보내는 이벤트
  - `event: presence` / `data: {"emp_no", "presence": {status, message, expires_at, updated_at} | null, "at"}`
  - `event: resync`: 서버의 DB 연결이 끊겼다 다시 붙음. 놓친 변경이 있을 수 있어 화면이 전체를 다시 읽습니다.
  - 20초마다 `: ping` (중간 프록시가 조용한 연결을 끊지 않게)
- 연결이 열려 있는 것만으로는 자동 로그아웃 시간이 늘어나지 않습니다. 60초마다 세션을 확인해서
  로그아웃·자동 로그아웃·퇴사 처리되면 연결을 닫고, 화면은 로그인 화면으로 갑니다.
- 자동 해제(`expires_at`)는 알림이 따로 가지 않습니다. 화면이 해제 시각에 맞춰 데이터를 다시 읽습니다.
- 서버를 끄거나 `--reload`로 재시작하면 열린 연결부터 닫습니다(안 그러면 uvicorn이 연결이 끝나기를 기다리며 멈춤).
- nginx 같은 프록시 뒤에 둘 때를 위해 `X-Accel-Buffering: no`, `Cache-Control: no-transform`을 붙입니다.
  운영에서는 HTTPS(HTTP/2)로 서비스하세요. HTTP/1.1에서는 브라우저가 한 주소에 연결을 6개까지만 열어서,
  같은 화면을 탭 여러 개로 띄우면 다른 요청이 막힐 수 있습니다.
