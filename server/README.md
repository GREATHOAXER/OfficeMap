# OfficeMap API 서버 (FastAPI)

실행 방법은 저장소 최상위 `README.md`의 "2. API 서버"를 보세요.

```
app/
  main.py          FastAPI 앱, /api/health
  config.py        환경 변수 (.env)
  db.py            PostgreSQL 연결 풀, app_settings 읽기
  security.py      비밀번호 해시(bcrypt), 세션 토큰
  session.py       로그인 확인. 로그인이 필요한 API는 CurrentUser 인자를 받는다
  admin_auth.py    관리자 로그인 확인 (CurrentAdmin)
  plan_geometry.py 도면 모양(JSON v1, 미터) 검사·변환, 책상 칸 위치 계산
  jobs.py          정기 작업: 1분마다 게시 예약 게시, 하루 한 번 이력 정리(5년)
  routers/auth.py      로그인 화면 API
  routers/office.py    자리·재실 현황 API
  routers/presence.py  내 재실 상태 바꾸기, 실시간 알림(SSE) API
  routers/employees.py 직원 검색 API (검색창, 참석자 추가)
  routers/rooms.py     회의실 확인·예약 API
  routers/admin.py     관리자 로그인·첫 화면 API
  routers/seating.py   좌석 배치 편집·팀 구역 API
  routers/plans.py     도면 편집 API (초안·자동 저장·편집 잠금·게시 점검·게시·게시 예약)
  routers/moves.py     팀 이사 도우미 API
  realtime.py      재실 상태 변경을 DB에서 받아(LISTEN) 열린 화면마다 나눠 주기
scripts/
  init_db.py       db/schema + db/seed 실행
  purge_history.py 보관 기간(5년)이 지난 이력 지우기 (--dry-run, --years)
  gen_dense_floor.py 목업 8F(사람이 많은 층, 68석) 도면·좌석 SQL 만들기 → db/seed/03_dense_floor.sql
```

## 로그인 API

| 요청 | 하는 일 |
|---|---|
| `GET /api/auth/login-info` | 로그인 화면의 공지, 문의처, 자동 로그아웃 시간(직원·관리자), 실패 허용 횟수 |
| `POST /api/auth/login` | 사번·비밀번호 로그인. 성공하면 HttpOnly 쿠키로 세션 발급 |
| `GET /api/auth/me` | 쿠키로 로그인한 사람 확인. 30분 미사용, 퇴사·잠금이면 401. 401에는 끊긴 이유 `reason`(`expired`·`max`·`reset`·`changed`·`locked`·`inactive`·`logout`, `user_sessions.revoked_reason`에서) |
| `GET /api/auth/session` | 자동 로그아웃까지 남은 초(`idle_left`). 확인만 하고 사용 시각은 늘리지 않음 (화면의 1분 전 알림용) |
| `POST /api/auth/password` | 비밀번호 변경 `{"current_password", "new_password"}`. 다른 곳의 직원 세션은 끝냄. 현재 비밀번호를 틀리면 로그인 실패 횟수에 더하고 허용 횟수에 닿으면 잠금(423) |
| `POST /api/auth/logout` | 로그아웃. 같은 브라우저의 관리자 로그인도 같이 끝내고 두 쿠키를 지움 |

로그인 실패 응답은 `code`로 구분합니다. 화면 문구는 프론트엔드가 정합니다.

| 상태 | code | 같이 오는 값 |
|---|---|---|
| 401 | `INVALID_CREDENTIALS` | 없음. 없는 사번·틀린 비밀번호·(비밀번호가 틀린) 퇴사자가 모두 같은 답 |
| 423 | `LOCKED` | `max_failed_count` |
| 403 | `NOT_ACTIVE` | 퇴사·휴직 (비밀번호가 맞을 때만 알려 줌) |

- 실패 횟수는 응답에 넣지 않습니다. 있는 사번에만 횟수가 붙으면 어떤 사번이 있는지(누가 관리자인지) 드러납니다.
- 로그인하면 같은 브라우저에 남아 있던 **다른 사람의** 관리자 로그인을 끝냅니다 (관리자 로그인도 반대로 같음).
  공용 PC에서 A의 관리자 페이지에 B가 들어가지 않게 합니다.
- 임시 비밀번호 상태(`must_change_password`)로는 `/api/auth/password`, `/me`, `/session`, `/logout` 말고는
  403 `PASSWORD_CHANGE_REQUIRED`입니다. 새 비밀번호: 8자 이상, 영문·숫자 포함, 사번이 들어가지 않음
  (`WEAK_PASSWORD`의 `problems`로 알려 줌), 지금 비밀번호와 달라야 함(`SAME_AS_OLD`). 현재 비밀번호가 틀리면 400 `WRONG_CURRENT`.

로그인 시도는 성공·실패 모두 `login_history`에 남깁니다.

## 자리·재실 현황 API (로그인 필요, 아니면 401)

| 요청 | 하는 일 |
|---|---|
| `GET /api/office/sites` | 사업장과 층 목록, 층마다 입주 팀 이름. `my_floor_id`는 로그인한 사람의 자리가 있는 층, `team_floor_id`는 우리 팀 구역이 있는 층 (자리가 아직 없으면 이 층을 연다) |
| `GET /api/office/floors/{층 ID}` | 게시된 도면(벽·기둥·공용 공간), 팀 구역, 회의실 지금 사용 여부, 좌석과 앉은 사람·재실 상태. `next_change_at`: 날짜를 정한 배치 변경·자율석 사용 끝 등 이 층 자리가 다음에 저절로 바뀌는 시각 (화면이 그때 다시 읽음) |
| `GET /api/office/my-seat` | 내 고정석과 날짜를 정해 둔 다음 변경 (`change.seat`가 `null`이면 그날 배정이 끝남). "내 자리가 바뀌었어요" 안내에 씀 |

- 좌표(`x`, `y`, `shape`)는 모두 도면 너비·높이 대비 비율(0~1)입니다. 좌석 `x`, `y`는 중심점입니다.
- 재실 상태는 `expires_at`이 지났으면 `null`로 내려갑니다.
- 퇴사·휴직 처리된 사람은 배정이 남아 있어도 빈 자리로 보입니다.
- 층의 `description`은 사무실이 아닌 층의 용도입니다 (예: 로비, 대강당). 사무실 층은 `null`입니다.

## 직원 검색 API (로그인 필요)

| 요청 | 하는 일 |
|---|---|
| `GET /api/employees/search?q=김민준` | 이름·사번, 또는 부서(본부)·팀 이름으로 사람 찾기. 띄어 쓴 낱말은 모두 맞아야 함 (`김민준 IT`). 기본 20명 |
| `GET /api/employees/teams?q=총무` | 팀·본부 찾기 (참석자 칸의 `$총무팀`). `q`가 비면 전부. `member_count`는 아래 팀 사람까지 |
| `GET /api/employees/teams/{id}/members` | 팀 전체 (재직자만). 본부면 아래 팀 사람까지 |

- 검색·팀원 목록에 시간(`start_date`·`start_min`·`end_date`·`end_min`)을 주면 그 시간의 다른 회의 `busy`가 붙고, `exclude`(예약 ID)는
  고치고 있는 그 예약을 빼고 봅니다. 결과에는 `email`도 있습니다(자리 없는 사람의 연락처 카드).

- 결과마다 직급·팀·위 부서(`division`, 본부)·지금 자리(사업장·층·좌석)·재실 상태가 붙습니다. 자리가 없으면 `seat: null`.
- 팀·본부 이름으로도 걸립니다: `IT본부`로 찾으면 IT운영팀·보안팀·디지털혁신팀·데이터팀 사람이 나옵니다.
- `date`, `start_min`, `end_min`(서울 기준 그날 0시부터 분)을 같이 주면 그 시간에 겹치는 다른 회의(`busy`)와
  휴가·출장·재택(`absence`)도 알려 줍니다. 참석자를 고를 때 "이 시간 다른 회의" 표시에 씁니다.
- 이름이 같은 사람이 먼저, 그다음 이름이 그 글자로 시작하는 사람, 이름에 들어간 사람, 팀·본부로 걸린 사람 순서입니다.
- `members`에도 같은 `date`, `start_min`, `end_min`을 줄 수 있습니다.
- 검색은 "내 정보"의 부르는 이름·한 줄 소개·하는 일·업무 키워드도 봅니다. 이름·부서가 아니라 이것으로 찾은 사람에게는
  `matched`(걸린 부분, 키워드면 `#법인카드`)가 붙습니다. 결과마다 `photo`·`display_name`·`headline`·`duties`·`skills`.

## 내 정보 API (로그인 필요)

이름·부서·직급·내선·이메일은 인사 정보(조직도)라 여기서 바꾸지 않습니다. 직원이 고치는 것은 `employee_profiles`·
`employee_photos`(`db/schema/10_profile.sql`)에 따로 두어 조직도를 다시 가져와도 남습니다.

| 요청 | 하는 일 |
|---|---|
| `GET /api/profile` | 내 인사 정보 + `display_name`(부르는 이름, 30자), `headline`(한 줄 소개, 80자), `duties`(하는 일, 1000자), `skills`(키워드 15개·20자), `photo` |
| `PUT /api/profile` | 위 네 가지를 통째로 저장 (키워드는 앞뒤 공백·#·쉼표를 떼고 같은 것은 하나로). 감사 기록 `PROFILE_UPDATE`(바꾼 칸 이름만) |
| `PUT /api/profile/photo` | 본문이 그림 파일 그대로 (`image/jpeg`·`png`·`webp`, 400KB까지, 파일 앞부분으로 형식 확인). 413 `PHOTO_TOO_BIG`, 415 `PHOTO_TYPE` |
| `DELETE /api/profile/photo` | 사진 지우기 |
| `GET /api/employees/{사번}/photo` | 사진 (로그인한 사람만). 주소의 `?v=`(바꾼 시각)가 있으면 하루 캐시, `ETag`로 304 |

- 자리·재실 현황의 좌석 `occupant`와 `/api/auth/me`의 사용자에도 `photo`·`display_name`(좌석은 `headline`·`duties`·`skills`까지)이 붙습니다.

## 회의실 확인·예약 API (로그인 필요)

| 요청 | 하는 일 |
|---|---|
| `GET /api/rooms/day?date=2026-10-23&site_id=1` | 한 사업장 회의실들의 하루 예약 현황. 날짜·사업장을 빼면 오늘, 내 자리가 있는 사업장 |
| `POST /api/reservations` | 예약 만들기 (아래) |
| `PUT /api/reservations/{id}` | 예약 고치기: 회의실·일시·제목·참석자 (만든 사람만, 끝나기 전에만, 반복은 그 회차만). 본문은 만들기와 같고 `repeat`는 `NONE`. `expected_updated_at`(자세히 보기의 `updated_at`)을 보내면 그 뒤 다른 곳에서 고친 예약은 409 `CHANGED_ELSEWHERE`로 거절 |
| `GET /api/reservations/mine/clash?start_date&start_min&end_date&end_min&exclude` | 그 시간에 내가 들어가는 다른 회의(`busy`)나 휴가·출장·재택(`absence`). 예약 폼의 "나" 칩 |
| `GET /api/reservations/mine?scope=upcoming` | 내가 예약했거나 참석하는 예약 (`is_organizer`, `attending`: 내가 실제로 들어가는지). `upcoming`: 아직 안 끝난 것 (최근 7일 안에 취소된 것도 `CANCELLED`로 남김), `past`: 최근 30일 지난·취소된 것 |
| `GET /api/rooms/{id}/conflicts?start_date&start_min&end_date&end_min&exclude` | 그 기간에 이 회의실에 이미 잡힌 예약 (여러 날 예약을 고를 때 미리 확인). `exclude`: 고치는 예약 |
| `GET /api/reservations/{id}` | 예약 자세히: 회의실, 일시, 예약한 사람(내선, 회의 참석 여부 `attends`), 참석자(재실 상태, 예약한 사람이면 `is_organizer`), 반복 규칙(남은 회차 `left`), 취소 시각, 내가 취소·수정할 수 있는지 |
| `DELETE /api/reservations/{id}?scope=one\|following` | 예약 취소 (만든 사람만, 끝나기 전에만). 반복 예약은 그 회차만(`one`) 또는 그 뒤 회차 모두(`following`). `{"cancelled": n}` |

- 시간은 모두 서울 기준 그날 0시부터 분(`start_min`, `end_min`)입니다. 13:30 → 810.
- 예약 정책은 `app_settings`에서 읽습니다: `room.slot_minutes`(30분 단위), `room.max_minutes`(최대 길이, 7일),
  `room.open_hours`(08:00~20:00, 시작·끝 시각이 이 안에 있어야 함).
- 여러 날에 걸친 예약이 됩니다 (예: 10-26 10:00 ~ 10-28 11:00). 가운데 날은 하루 종일 막힙니다.
- `POST /api/reservations` 본문:
  `{"room_id", "date", "start_min", "end_date", "end_min", "title", "attendees": [사번], "repeat": "NONE"|"WEEKLY"|"WEEKDAYS", "repeat_until", "notify"}`
  - `end_date`가 없으면 시작 날짜와 같은 날에 끝납니다. 여러 날 예약은 반복할 수 없습니다(`REPEAT_SINGLE_DAY`).
  - `attendees`는 실제로 회의에 들어가는 사람(예약한 사람 빼고), `organizer_attends`(기본 `true`)는 예약한 사람도
    들어가는지. 비서가 임원 회의를 잡아 주는 것처럼 예약만 하면 `false`. 참석자는 `reservation_attendees`에만 있고
    (예약한 사람도 참석하면 거기에 들어감), "그 시간에 다른 회의" 확인도 참석자 기준입니다. 아무도 없으면 422 `NO_ATTENDEES`.
  - 승인 절차는 없습니다. 임원 회의실·대강당도 바로 확정(`CONFIRMED`)됩니다.
  - 반복 예약은 회차마다 한 행씩 만듭니다(`reservation_series`가 규칙). 석 달(92일), 60회까지.
    한 회차라도 겹치면 아무것도 만들지 않고 겹치는 날짜(그 회차의 날, 여러 날 예약과 겹쳐도)를 돌려줍니다. `"skip_conflicts": true`면 겹치는 날만 빼고
    만들고, 뺀 날짜를 `skipped`로 돌려줍니다.
  - `notify`면 참석자에게 화면 알림(`notifications`)을 쌓아 둡니다 (메신저 연동 전). 고치기·취소도 알림을 쌓습니다.
- 같은 회의실·겹치는 시간은 DB 제약(EXCLUDE)이 마지막으로 막습니다. 검사와 저장 사이에 누가 먼저 잡아도 409.

| 상태 | code | 뜻 |
|---|---|---|
| 409 | `TIME_TAKEN` | 그 시간에 이미 예약이 있음 (`dates`: 겹치는 날짜, `conflicts`: 겹치는 예약 5건까지) |
| 422 | `INVALID_TIME` | 30분 단위가 아니거나, 시작·끝 시각이 운영 시간 밖이거나, 끝이 시작보다 앞 |
| 422 | `TOO_LONG` | 최대 길이(7일) 넘음 |
| 422 | `REPEAT_SINGLE_DAY` | 여러 날 예약을 반복하려 함 |
| 422 | `IN_PAST` | 지난 시간 (지금 진행 중인 칸은 됨) |
| 422 | `TITLE_REQUIRED`, `INVALID_REPEAT`, `REPEAT_TOO_LONG`, `UNKNOWN_ATTENDEE` | 입력 확인 |
| 403 | `NOT_ORGANIZER` | 남의 예약 취소·수정 |
| 409 | `NOT_CANCELLABLE`, `NOT_EDITABLE` | 이미 끝났거나 취소된 예약 |
| 422 | `EDIT_NO_REPEAT` | 고칠 때 반복을 바꾸려 함 |

## 관리자 페이지 API (`/api/admin`, 관리자 로그인 필요)

직원 로그인과 따로입니다. 비밀번호는 `admin_accounts`(직원 비밀번호와 다름), 쿠키는 `officemap_admin_session`
(SameSite=Strict), 세션은 `user_sessions.kind = 'ADMIN'`으로 구분합니다. 직원 쿠키로는 관리자 API를,
관리자 쿠키로는 직원 API를 쓸 수 없습니다.

| 요청 | 하는 일 |
|---|---|
| `POST /api/admin/auth/login` | 사번·관리자 비밀번호 로그인. 관리자 계정과 살아 있는 권한(`admin_grants`)이 있어야 함 |
| `GET /api/admin/auth/me` | 로그인한 관리자와 권한 목록(가장 넓은 권한이 `role`). 아니면 401 `NOT_ADMIN_LOGGED_IN` |
| `GET /api/admin/auth/session` | 관리자 자동 로그아웃까지 남은 초. 사용 시각은 늘리지 않음 |
| `POST /api/admin/auth/logout` | 로그아웃. 직원 로그인도 같이 끝냄 (`/api/auth/logout`과 같음) |
| `GET /api/admin/overview` | 관리자 첫 화면: 요약 숫자, 사업장별 층(입주 팀 구역·좌석·층 관리자·도면 상태·최종 수정), 관리자 목록 |

- 로그인 실패 `code`는 직원 로그인과 같고(`INVALID_CREDENTIALS`, `LOCKED`, `NOT_ACTIVE`), 권한이 하나도 없으면
  403 `NO_PERMISSION`. 관리자 계정이 없는 사번도 `INVALID_CREDENTIALS`(누가 관리자인지 알려 주지 않음).
- 실패 횟수·잠금은 관리자 계정에 따로 셉니다. 시도는 `login_history`에 `kind = 'ADMIN'`으로 남깁니다.
- `app_settings`의 `admin.session.idle_minutes`(기본 15분) 동안 쓰지 않으면 401. 최대 8시간.
- 권한을 모두 회수하면 로그인해 있던 세션도 바로 401이 됩니다.
- 직원 화면의 `GET /api/auth/me`의 `role`은 관리자 계정 + 살아 있는 권한이 있으면 `ADMIN`입니다
  (따로 저장하지 않아서 권한을 회수하면 바로 바뀜). 직원 화면에는 관리자 페이지 링크를 두지 않습니다.
- 권한 단계: `COMPANY_ADMIN` 전사 > `SITE_ADMIN` 사업장 > `FLOOR_ADMIN` 층 > `ZONE_ADMIN` 구역.
  `overview`는 전체를 보여 주고, 층마다 `in_scope`(`ALL` 내 관리 / `ZONE` 층 안 내 구역만 / `null`)를 붙입니다.
- `overview.summary`의 좌석·회의실·오늘 예약·대기 요청은 **내 관리 범위 안** 숫자입니다 (`scope`: `ALL`/`FLOORS`/`ZONES`).
  좌석은 개인석(`seats`, 배정 `occupied`)과 자율석(`flex`)을 나눠 셉니다. `unseated`: 재직 중인데 자리가 없는 사람.
  `pending_requests`는 층 관리 권한이면 내가 승인할 요청, 구역만 맡았으면 내가 올려 승인을 기다리는 요청.

## 사업장·층·조직도 API (`/api/admin`)

사업장은 전사 관리자, 층은 그 사업장의 사업장 관리자 이상, 조직도 고치기는 전사 관리자(보기는 관리자 누구나).
없앤 사업장·층·부서는 지우지 않고 `is_active = false`로 둡니다. 모두 감사 기록(`SITE_*`, `FLOOR_*`, `DEPT_*`,
`EMPLOYEE_*`, `PASSWORD_RESET`)을 남깁니다.

| 요청 | 하는 일 |
|---|---|
| `POST /api/admin/sites` | 사업장 추가 `{name, kind: HQ\|CENTER, address?}`. 같은 이름 409 `SITE_NAME_TAKEN`. 닫은 사업장 이름이면 그 사업장을 다시 엶(`reopened: true`) |
| `PUT /api/admin/sites/{ID}` | 사업장 고치기 |
| `DELETE /api/admin/sites/{ID}` | 사업장 닫기. 층이 남아 있으면 409 `SITE_HAS_FLOORS`. 그 사업장 관리자 권한 회수 |
| `POST /api/admin/sites/{ID}/floors` | 층 추가 `{name, description?, under_floor_id?}` (그 층 바로 아래, 없으면 맨 위). 같은 이름 409 `FLOOR_NAME_TAKEN` |
| `PUT /api/admin/floors/{ID}` | 층 이름·용도·자리 (`move: false`면 자리는 그대로) |
| `DELETE /api/admin/floors/{ID}` | 층 없애기. 좌석·회의실이 있으면 409 `FLOOR_IN_USE {seats, rooms}`. 빈 구역·초안·이 층 권한 정리 |
| `GET /api/admin/org?inactive=` | 부서 목록 (`parent_id`, 인원 `members`, 이 부서 구역 `zones`), `can_edit` |
| `GET /api/admin/org/departments/{ID}/members` | 부서 사람 (재직·휴직, 자리·관리자·임시 비밀번호 여부) |
| `POST /api/admin/org/departments` | 부서 추가 `{name, parent_id?, code?}` (코드가 없으면 `NEW001`…). 쓰는 부서와 이름이 같으면(대소문자 무시) 409 `DEPT_NAME_TAKEN` |
| `PUT /api/admin/org/departments/{ID}` | 이름·위 부서·코드. 자기 아래로 옮기면 422 `PARENT_CYCLE` |
| `DELETE /api/admin/org/departments/{ID}` | 부서 없애기. 사람·아래 부서가 있으면 409 `DEPT_NOT_EMPTY {members, children}` |
| `POST /api/admin/org/departments/{ID}/members` | 데려오기 `{emp_nos}` → `{moved, released}` (고정석 배정이 끝난 사람 이름) |
| `GET /api/admin/org/people?q=` | 이름·사번으로 사람 찾기 (재직·휴직, 지금 부서) |
| `POST /api/admin/org/employees` | 새 직원 등록 → `{employee, temporary_password}` (직원 화면 계정, 첫 로그인 때 비밀번호 변경). 같은 사번 409 `EMP_NO_TAKEN` |
| `PUT /api/admin/org/employees/{사번}` | 보낸 칸만: 이름·직급·직책·이메일·내선·`department_id`·`status`(`ACTIVE`/`LEAVE`/`RETIRED`) → `{released}`. 나를 퇴사 422 `CANNOT_RETIRE_SELF` |
| `POST /api/admin/org/employees/{사번}/reset-password` | 직원 화면 임시 비밀번호(잠금 해제, 로그인 끊음 — 끊긴 이유 `reset`) → `{temporary_password}` |

- 이름 겹침은 쓰고 있는 사업장·층·부서끼리만 대소문자 없이 봅니다. 없앤 층·사업장 이름으로 바꾸거나 새로 만들면 없앤 쪽 이름을
  `이름~ID`로 비켜 줍니다. 이메일은 형식을 확인합니다(형식이 아니면 422, 본문 검증 오류).
- 부서를 옮기거나 퇴사하면 고정석 배정은 DB 트리거(`release_seat_on_org_change`)가 끝내고 새 팀의 미배치 인원이 됩니다.
  휴직(`LEAVE`)은 자리를 그대로 두고 로그인만 막힙니다. 퇴사하면 관리자 권한도 회수하고 세션을 끊습니다.

## 좌석 배치 편집 API (`/api/admin`, 관리자 로그인 필요)

배치 화면(⑤)에서 끌어다 놓은 변경은 바로 반영하지 않고 **작업 묶음**(`change_requests` 한 행 + 항목)에 모았다가
한 번에 반영합니다. 설계: [docs/design/floor-plan-and-seating.md](../docs/design/floor-plan-and-seating.md) 4장.

| 요청 | 하는 일 |
|---|---|
| `GET /api/admin/seating/floors` | 내가 배치를 편집할 수 있는 층 (`mode`: `FLOOR` 층 전체 / `ZONE` 내 구역만) |
| `GET /api/admin/floors/{층 ID}/seating` | 배치 화면: 도면, 구역(편집 가능·구역 관리자), 좌석(지금 앉은 사람, 날짜를 정해 둔 `upcoming`, `editable`), 미배치 인원, 내 작업 묶음(`draft`), 요청·승인 현황, 권한 |
| `GET /api/admin/seating/people?floor_id=&q=` | 사람 찾기 (다른 층·다른 팀). 구역 관리자는 우리 팀원만 |
| `PUT /api/admin/floors/{층 ID}/change-set` | 내 작업 묶음 자동 저장 `{assignments: [{seat_id, emp_no\|null, expected_emp_no}], types: [{seat_id, mode}], effective_date, note}`. 항목을 통째로 바꾸고, 비면 묶음을 지움 |
| `DELETE /api/admin/floors/{층 ID}/change-set` | 작성 중인 묶음 버리기 |
| `GET /api/admin/change-sets/{ID}` | 묶음 하나 (승인할 요청 미리 보기) |
| `POST /api/admin/change-sets/{ID}/apply` | 내 묶음 반영 (층 관리자 이상, "즉시 반영" 구역 관리자) |
| `POST /api/admin/change-sets/{ID}/submit` · `withdraw` | 승인 요청 / 요청 거두고 다시 작성 중으로 ("층 관리자 승인 후" 구역 관리자) |
| `POST /api/admin/change-sets/{ID}/approve` · `reject` | 승인하고 반영 / 반려 `{comment}` (그 층 관리자 이상) |
| `POST /api/admin/change-sets/{ID}/reopen` | 반려된 내 요청을 새 작성 중 묶음으로 복사 |
| `POST /api/admin/change-sets/{ID}/cancel` | 날짜를 정해 반영한 묶음을 그날 전에 취소 (새 배정은 지우고, 끝내기로 한 배정은 되살림) |
| `GET /api/admin/stream` | 배치 화면용 SSE (`event: floor`, `resync`). 다른 관리자가 이 층에 반영하면 다시 읽음 |
| `POST /api/admin/floors/{층 ID}/zones` | 빈 팀 구역 만들기 `{code, department_id\|null, color_key, name\|null}` (층 관리자 이상). 이름을 비우면 부서 이름을 따라감 |
| `PATCH /api/admin/zones/{구역 ID}` | 구역의 부서·이름·코드·색 고치기 (바로 반영, 앉은 사람 영향 없음) |
| `POST /api/admin/zones/{구역 ID}/delete` | 구역 없애기 `{merge_into: 구역 ID\|null, unassign}`: 좌석은 다른 구역에 합치거나 구역 없음, 앉은 사람은 그대로 또는 미배치. 구역 관리자 권한 회수 |

- 저장 본문의 `zones: [{seat_id, zone_id|null}]`는 구역 경계(좌석을 다른 구역으로, null이면 구역 없음). 좌석 유형처럼 날짜를
  정할 수 없습니다. 구역 관리자는 내 구역으로 넣거나 내 구역에서 빼는 것만, 그리고 경계가 든 묶음은 언제나 승인 요청으로 반영합니다.
- 구역 모양(`zones.shape`)은 좌석에서 자동으로 계산해 저장합니다(DB 트리거). 좌석 덩어리가 여럿이면 `{"type": "rects", "rects": [...]}`,
  좌석이 없으면 `null`. 부서 이름이 바뀌면 구역 이름도 따라 바뀝니다(별칭을 정한 구역 제외).
- 항목은 좌석마다 "반영하면 앉을 사람"과 "바꾸기 전에 앉아 있던 사람(`expected_emp_no`)"입니다. 자리 교환은 2건,
  다른 자리로 옮기기는 새 자리 + 옛 자리 비우기. 사람이 다른 고정석에 있으면 반영할 때 그 자리를 끝냅니다.
- **반영은 한 트랜잭션**이고 층마다 한 번에 하나씩 합니다(`pg_advisory_xact_lock`). 하나라도 충돌하면 아무것도 바꾸지
  않고 409 `CONFLICTS` + `conflicts: [{seat_id, code, reason}]`를 돌려줍니다. `reason`: `CHANGED`(그사이 다른 관리자가
  바꿈), `SCHEDULED`·`SCHEDULED_PERSON`(날짜를 정한 변경이 걸려 있음), `INACTIVE`, `PERSON_OUT_OF_SCOPE`(우리 팀원이
  아님·부서 이동), `NOT_FIXED`(자율석·사용 중지 좌석), `OCCUPIED`(자율석·사용 중지로 바꾸는데 앉은 사람이 남음),
  `OUT_OF_SCOPE`, `SEAT_GONE`.
- **날짜 지정**(`effective_date`, 내일부터 1년 안): 그날 0시(서울)부터 시작하는 배정을 미리 넣고, 지금 배정은 그 시각에
  끝나게 해 둡니다(`ended_by_request_id`). 직원 화면은 지금 시각에 걸친 배정만 보이므로 그날 저절로 바뀝니다.
  예정이 걸린 좌석·사람은 그날까지 잠깁니다. 좌석 유형 변경은 날짜를 정할 수 없습니다(422 `SCHEDULE_WITH_TYPES`).
  승인이 늦어 날짜가 지났으면 승인하는 순간 반영합니다.
- 구역 관리자는 내 구역 좌석과 우리 팀(내 구역의 부서) 사람만 넣을 수 있습니다 (403 `SEAT_LOCKED`, `PERSON_OUT_OF_SCOPE`).
  관리자 한 명이 한 층에 진행 중인 묶음(작성 중·승인 대기)은 하나입니다. 승인 대기 중에는 고칠 수 없습니다(409 `PENDING`).
- 반영하면 `audit_logs`(`CHANGE_SET_APPLY`, `_SUBMIT`, `_REJECT`, `_CANCEL`)와 자리가 바뀐 사람의 `notifications`
  (`SEAT_CHANGED`, 메신저 연동 후 발송)를 남깁니다. 배정은 지우지 않고 끝내고 새로 만들어 이력이 남습니다.
- **부서 이동·퇴사**: `employees`의 트리거가 고정석 배정을 끝냅니다 (좌석은 원래 팀 구역에 그대로, 그 사람은 새 팀의
  미배치 인원). 조직도 동기화든 직접 SQL이든 똑같이 동작하고 `audit_logs`에 `SEAT_RELEASE`로 남습니다.

## 도면 편집 API (`/api/admin`, 층 관리자 이상)

층마다 게시본 하나와 초안 하나. 초안은 직원 화면에 보이지 않고, 게시하는 순간 한 트랜잭션으로 좌석·회의실을 초안에 맞춥니다.
도면 모양은 미터 단위 JSON v1입니다 (`docs/design/floor-plan-and-seating.md` 2.2). 구역 관리자는 403 `FLOOR_ADMIN_ONLY`.

| 요청 | 하는 일 |
|---|---|
| `GET /api/admin/plans/floors` | 도면을 편집할 수 있는 층 (`published`, `drafting`) |
| `GET /api/admin/floors/{층 ID}/plan` | 편집 화면: `draft`(모양·`revision`·편집 중인 사람), `published`, `archived`, 복제할 수 있는 층(`sources`), `live`(책상 칸·회의실마다 지금 앉은 사람·남은 예약), `background`(밑그림 `{url, x_m, y_m, w_m, h_m, opacity, visible, name, bytes}` 또는 null) |
| `POST /api/admin/floors/{층 ID}/plan/draft` | 초안 만들기 `{source: published\|blank\|archived\|floor\|import, plan_id?, floor_id?, width_m?, height_m?, geometry?}` (`blank`에 사무실 크기 10~300 m, 없으면 지금 게시본 크기. `import`는 도면 파일에서 찾은 `geometry`와 크기가 꼭 있어야 함(422 `IMPORT_SIZE`), 요소 ID 앞에 `i{버전}-`을 붙임). 이미 있으면 409 `HAS_DRAFT` |
| `PUT /api/admin/plans/{ID}` | 자동 저장 `{revision, geometry, width_m?, height_m?}` (도면 크기 10~300 m) → `{revision, updated_at}`. 409 `REVISION`(먼저 저장한 곳이 있음, 서버 `revision` 포함), 423 `EDITING`(다른 사람이 편집 중), 409 `SCHEDULED`(게시 예약 중), 422 `BAD_GEOMETRY` |
| `POST /api/admin/plans/{ID}/heartbeat` | 편집 중 표시 (30초마다). `{take_over: true}`면 넘겨받기 |
| `DELETE /api/admin/plans/{ID}` | 초안 버리기 |
| `GET /api/admin/plans/{ID}/check` | 게시 전 점검: `summary`(좌석 수·새로·빠짐·옮김·번호 바뀜), `people`(자리가 없어지는 사람과 추천 자리), `rooms_removed`(남은 예약), `rooms_added`·`rooms_changed`, 고를 수 있는 자리·회의실, `problems` |
| `POST /api/admin/plans/{ID}/publish` | 게시 `{revision, people: [{emp_no, to_key?}], rooms: [{room_id, action: MOVE\|CANCEL, to_key?}], note?, effective_date?}`. `effective_date`(내일~1년)를 주면 게시 예약 → `{scheduled: {version, effective_at}}` |
| `POST /api/admin/plans/{ID}/unschedule` | 게시 예약 취소 (다시 고칠 수 있는 초안으로) |
| `PUT /api/admin/floors/{층 ID}/plan/background?w_m&h_m&x_m&y_m&opacity&name` | 밑그림 올리기(있으면 바꿈). 본문이 그림 파일 그대로(`image/png`·`jpeg`·`webp`, 8MB까지, 앞부분으로 형식 확인). 413 `IMAGE_TOO_BIG`, 415 `IMAGE_TYPE`, 422 `BAD_PLACE` |
| `PATCH /api/admin/floors/{층 ID}/plan/background` | 자리·크기·진하기·보이기 `{x_m?, y_m?, w_m?, h_m?, opacity?, visible?}`. 없으면 404 `NO_BACKGROUND` |
| `DELETE /api/admin/floors/{층 ID}/plan/background` | 밑그림 지우기 |
| `GET /api/admin/floors/{층 ID}/plan/background?v=` | 밑그림 그림 (`v`가 있으면 하루 캐시, ETag) |

- 책상 칸 하나가 좌석 하나이고, 칸 `id`가 `seats.plan_element_key`입니다. 같은 칸이면 같은 좌석이라 옮기거나 번호를 바꿔도
  앉은 사람은 그대로입니다. 초안에 없는 좌석은 `REMOVED`(지우지 않음), 새 칸은 새 좌석(같은 묶음의 가장 많은 구역·유형).
- 자리가 없어지는 사람은 `people`에 넣지 않으면 미배치입니다. 예약이 남은 회의실을 정하지 않으면 422 `ROOMS_UNRESOLVED`,
  게시를 막는 문제가 있으면 422 `PROBLEMS`, 고른 자리가 그새 찼으면 409 `TARGET_TAKEN`, 옮길 회의실에 같은 시간 예약이
  있으면 409 `ROOM_TIME_TAKEN`. 어느 경우든 아무것도 바꾸지 않습니다.
- 게시하면 이전 게시본은 `ARCHIVED`, 자리가 없어지거나 번호가 바뀐 사람에게 `SEAT_CHANGED`, 예약이 취소된 사람에게
  `RESERVATION_CANCELLED` 알림, `audit_logs`(`PLAN_DRAFT_CREATE`, `PLAN_TAKE_OVER`, `PLAN_DRAFT_DISCARD`, `PLAN_PUBLISH`).
  직원 화면에는 `floor` 이벤트 `kind: plan`이 가서 배너를 띄우고 5초 뒤 새로 읽습니다.
- 목업 게시본(v0, 비율 좌표)은 초안을 만들 때 v1으로 바꿉니다(구역마다 좌석을 책상 묶음으로 맞춤).
- **밑그림**(`floor_plan_backgrounds`, `db/schema/11_plan_background.sql`): 도면 파일 그림을 층마다 하나 둡니다. 편집 화면에서만
  요소 밑에 깔고 직원 화면에는 주지 않습니다. 초안이 아니라 층에 붙어 있어 초안을 버리거나 게시해도 남습니다(보관본마다 복사하지
  않음). 감사 기록 `PLAN_BACKGROUND_SET`·`PLAN_BACKGROUND_DELETE`(대상 `floor`). 도면 파일은 화면(브라우저)이 읽어서 찾은 요소를
  `source: import` 초안으로, 고른 부분 그림을 밑그림으로 보냅니다.
- **게시 예약**(`SCHEDULED`): 예약할 때는 고른 자리·회의실이 초안에 있는지만 보고, 없어지는 회의실은 예약이 없어도 모두
  정해야 합니다(422 `ROOMS_UNRESOLVED`). 그날 0시(서울)에 서버 작업(`app/jobs.py`, 1분마다)이 같은 방식으로 게시하는데,
  그사이 고른 자리가 찼으면 그 사람은 미배치, 옮길 회의실에 같은 시간 예약이 있으면 그 예약만 취소합니다. 실패하면 초안으로
  돌리고 예약한 사람에게 `PLAN_PUBLISH_FAILED` 알림. 감사 기록 `PLAN_SCHEDULE`, `PLAN_UNSCHEDULE`, `PLAN_SCHEDULE_FAILED`.
- **도면 요소**(JSON v1): 벽(사각형)·선 벽(`wall_line`, 양 끝점·굵기)·기둥·공간·회의실·출입구(`entrance`, `main` = 주 출입구)·
  책상 묶음. 벽·선 벽·공간·회의실·출입구는 `line_w`(선 굵기 m, 0.01~2), 공간·회의실·출입구는 `label_size`(글자 %, 50~400)·
  `label_bold`. 책상 묶음은 `rotation`(0·90·180·270, 90 = 의자가 아래였던 것이 오른쪽으로)·`desk_w`·`desk_h`(책상 하나 m,
  0.3~6), 칸마다 `flip`(그 책상만 반대로 앉기). 도면의 `desk`는 새 책상 기본 크기. 틀리면 422 `BAD_GEOMETRY`(`where`).
- 직원 화면(`GET /api/office/floors/{ID}`)·배치 화면 도면은 비율 좌표로 `walls`·`lines`(선 벽)·`pillars`·`spaces`·`entrances`를
  주고, 선 굵기는 도면 폭 대비 비율(`line`), 회의실 모양(`shape`)에도 `line`·`label_size`·`label_bold`. 좌석에는 의자 방향
  (`rotation`)과 크기 `w`·`h`(도면 대비 비율, 돌린 뒤; 예전 좌석은 null = 기본 책상)가 있고 게시할 때 맞춰집니다.
- **도면 크기**: 책상 크기는 미터(기본 2.665 × 1.668 m)라, 도면이 커지면 직원 화면의 좌석 비율이 작아집니다.
  구역 모양(`zone_auto_shape`)도 층의 게시본 크기와 좌석마다의 크기(`seats.w`·`h`)로 계산하고, 게시하면 그 층 구역 모양을 다시 계산합니다.

## 팀 이사 도우미 API (`/api/admin/moves`, 목적지 층의 층 관리자 이상)

| 요청 | 하는 일 |
|---|---|
| `GET /api/admin/moves/options` | 옮길 수 있는 팀(인원)과 목적지로 고를 수 있는 층 |
| `GET /api/admin/moves/team?department_id=` | 그 팀 사람과 지금 자리 (`locked`: 날짜를 정한 변경이 걸려 있음) |
| `POST /api/admin/moves` | `{department_id, to_floor_id, moves: [{emp_no, seat_id\|null}], effective_date?, note?, zone_ids?}` → 201 `{move: {id, scheduled, moved, unassigned, requests}}` |

- `seat_id`가 null이면 미배치로(지금 자리만 끝냄). 목록에 없는 팀원은 그대로입니다.
- 목적지 층에 "새 자리 배정" 묶음, 미배치로 보내는 사람이 앉은 층마다 "자리 비우기" 묶음을 만들어 같은 `move_group`으로
  묶고 한 트랜잭션에 반영합니다(`change-sets`의 반영과 같은 규칙과 충돌 검사: 409 `CONFLICTS`). 미배치로 보내는 사람의 층도
  층 관리자여야 합니다(403 `FLOOR_ADMIN_ONLY`). 고른 자리는 비어 있어야 하고, 함께 옮기는 팀원의 자리만 예외입니다.
- `zone_ids`: 목적지 구역을 이 팀 구역으로 바꿉니다(날짜와 상관없이 바로). 다른 팀 사람이 앉아 있으면 409 `ZONE_OCCUPIED`.
- 날짜를 정했으면 배치 화면 요청 목록에 예정으로 뜨고(`team_move: true`), 어느 층에서 "예정 취소"를 하든 함께 취소됩니다.
- 감사 기록 `TEAM_MOVE`.

## 정기 작업과 이력 정리

- 서버가 켜져 있는 동안 `app/jobs.py`가 1분마다 게시 예약을 게시하고, 켜질 때와 그 뒤 하루마다 `purge_history()`
  (`db/schema/09_retention.sql`)로 5년이 지난 이력을 지웁니다: 끝난 배정, 끝난 작업 묶음(남은 배정이 가리키지 않는 것),
  지난 예약, 감사 기록, 알림, 로그인 기록, 오래전에 빠진 좌석. 도면 보관본은 모두 남습니다. 지운 개수는 `audit_logs`에
  `HISTORY_PURGE`로 남습니다.
- 서버를 여러 개 띄워도 DB 잠금(`pg_try_advisory_lock`)으로 한 곳에서만 돕니다.
- 손으로: `python -m scripts.purge_history --dry-run`(개수만 보고 되돌리기), `--years 7`(보관 기간 바꾸기).


## 내 재실 상태 API (로그인 필요)

`presence_status` 테이블에 직원당 1행을 덮어씁니다. 이력은 남기지 않습니다.

| 요청 | 하는 일 |
|---|---|
| `GET /api/presence/me` | 지금 내 상태(없거나 해제 시각이 지났으면 `null`)와 지금 "퇴근 시"를 고르면 풀리는 시각 `end_of_day_at` |
| `GET /api/presence/team` | 우리 팀(내 부서) 사람들의 재실 상태와 자리 (내 재실 상태 화면) |
| `PUT /api/presence/me` | 상태 저장. `{"status", "message", "duration"}` |
| `DELETE /api/presence/me` | 상태 지우기 (204) |
| `GET /api/presence/stream` | 누구든 상태가 바뀔 때마다 보내는 실시간 알림 (SSE, 아래 참고) |

- `status`: `AVAILABLE` 방문 가능, `DO_NOT_DISTURB` 방해 금지, `IN_MEETING` 회의 중, `AWAY` 부재
- `message`: 100자까지, 빈 문자열이면 지웁니다.
- `duration`: 자동 해제 시각(`expires_at`). `NONE` 해제 안 함, `30M`, `1H`, `END_OF_DAY` 퇴근 시
  (`app_settings`의 `presence.workday_end`, 기본 18:00. 이미 지났으면 오늘 자정),
  `KEEP` 지금 걸린 해제 시각 그대로 (메시지만 고칠 때 해제 시각이 바뀌지 않게)

### 실시간 알림 (`/api/presence/stream`)

```
DB 트리거 ──NOTIFY presence_changed / floor_changed──▶ API 서버(LISTEN 연결 1개) ──SSE──▶ 열려 있는 화면들
```

- `presence_status`에 저장·삭제가 일어나면 트리거(`db/schema/05_presence.sql`)가 알림을 보냅니다.
  좌석·배정·구역·도면 게시·배치 요청이 바뀌면 `floor_changed`를 보냅니다 (`db/schema/04_seating.sql`).
  API를 거치지 않고 SQL로 직접 바꿔도 화면에 바로 반영됩니다. NOTIFY는 커밋된 뒤에만 전달됩니다.
- 보내는 이벤트
  - `event: presence` / `data: {"emp_no", "presence": {status, message, expires_at, updated_at} | null, "at"}`
  - `event: floor` / `data: {"kind": "seats" | "zones" | "plan" | "requests", "floor_id", "seat_id"?, "emp_no"?, "version"?, "at"}`.
    `emp_no`는 고정석 배정이 바뀐 사람(직원 화면이 "내 자리가 바뀌었어요"를 띄울지 정함).
    관리자 배치 화면은 `/api/admin/stream`으로 같은 `floor` 이벤트를 받습니다
  - `event: resync`: 서버의 DB 연결이 끊겼다 다시 붙음. 놓친 변경이 있을 수 있어 화면이 전체를 다시 읽습니다.
  - 20초마다 `: ping` (중간 프록시가 조용한 연결을 끊지 않게)
- 연결이 열려 있는 것만으로는 자동 로그아웃 시간이 늘어나지 않습니다. 60초마다 세션을 확인해서
  로그아웃·자동 로그아웃·퇴사 처리되면 연결을 닫고, 화면은 로그인 화면으로 갑니다.
- 자동 해제(`expires_at`)는 알림이 따로 가지 않습니다. 화면이 해제 시각에 맞춰 데이터를 다시 읽습니다.
- 서버를 끄거나 `--reload`로 재시작하면 열린 연결부터 닫습니다(안 그러면 uvicorn이 연결이 끝나기를 기다리며 멈춤).
- nginx 같은 프록시 뒤에 둘 때를 위해 `X-Accel-Buffering: no`, `Cache-Control: no-transform`을 붙입니다.
  운영에서는 HTTPS(HTTP/2)로 서비스하세요. HTTP/1.1에서는 브라우저가 한 주소에 연결을 6개까지만 열어서,
  같은 화면을 탭 여러 개로 띄우면 다른 요청이 막힐 수 있습니다.
