# OfficeMap
Vibe Coding Project @ KFTC

사업장·층별 좌석과 동료의 재실 상태, 회의실 예약을 한 곳에서 보는 사내 서비스입니다.

## 폴더 구조

| 폴더 | 내용 |
|---|---|
| `db/` | 테이블 정의(`schema/`)와 목업 데이터(`seed/`) — PostgreSQL 16 |
| `server/` | API 서버 — Python FastAPI, uvicorn으로 실행 |
| `frontend/` | 화면 — Next.js 16 |
| `docs/design/` | 설계 문서 — [도면 편집 · 좌석 배치 편집](docs/design/floor-plan-and-seating.md) |

브라우저는 Next.js(3000번)에만 접속하고, Next.js가 `/api/...` 요청을 FastAPI(8000번)로 넘겨줍니다.

## 로컬에서 실행하기

준비물: Python 3.11 이상, Node.js 20.9 이상, PostgreSQL 16 + pgvector (Docker가 있으면 Docker로 대신)

### 1. DB 띄우기

**Docker가 있으면** (pgvector가 들어 있는 이미지)

```bash
docker compose up -d db
```

**PostgreSQL을 직접 설치했다면** 관리자 계정(postgres)으로 한 번만:

```sql
CREATE ROLE officemap LOGIN PASSWORD 'officemap';
CREATE DATABASE officemap OWNER officemap;
\c officemap
CREATE EXTENSION btree_gist;
CREATE EXTENSION vector;   -- pgvector 확장이 설치돼 있어야 함
```

### 2. API 서버 (uvicorn)

```bash
cd server
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env               # Windows: copy .env.example .env   (DB 주소가 다르면 수정)
python -m scripts.init_db          # 테이블 + 목업 데이터 넣기
uvicorn app.main:app --reload --port 8000
```

- http://localhost:8000/docs 에서 API를 바로 눌러 볼 수 있습니다.
- DB를 처음 상태로 되돌리려면 `python -m scripts.init_db --reset`

### 3. 화면 (Next.js)

다른 터미널에서:

```bash
cd frontend
npm install
cp .env.example .env.local         # Windows: copy .env.example .env.local
npm run dev
```

http://localhost:3000 에 접속하면 로그인 화면이 뜹니다.

### 목업 계정

비밀번호는 모두 `officemap1234` 입니다.

목업 데이터는 서울 본사 1F~10F(1F 로비, 2F 대강당, 3F 식당, 4F~9F 사무실, 10F 임원실), 11개 팀, 좌석 210석, 직원 157명입니다.

| 사번 | 이름 | 확인할 수 있는 것 |
|---|---|---|
| 20190005 | 조시우 대리 (재무팀) | 일반 로그인, 로그인하면 내 자리가 있는 7F가 열림. 오늘 회의실 예약·반복 예약(재무팀 주간회의)이 있음 |
| 20130003 | 정민호 차장 (IT운영팀) | 6F가 열림. 조시우와 다른 브라우저(또는 시크릿 창)로 같이 로그인해서 7F를 보면, 조시우가 바꾼 재실 상태가 바로 보임 |
| 20090001 | 한도윤 부장 (총무팀) | 관리자 권한이 있어 왼쪽 메뉴에 "관리자 페이지" 입구가 보임 (일반 직원은 안 보임) |
| 20260006 | 이서연 사원 (재무팀) | 임시 비밀번호 상태: 로그인하면 새 비밀번호를 정하는 화면부터 나옴. 자리가 아직 없어 팀 층(7F)이 열림 |
| 20200007 | 김민준 대리 (경영기획팀) | 5번 틀려서 계정 잠그기 |
| 20100009 | 윤하은 차장 (비서실) | 내일 "경영회의"를 예약만 해 둔 사람 (본인은 참석 안 함, 내 예약에 "예약만") |

### 관리자 페이지 (`/admin`)

로그인 화면 아래 "관리자 페이지" 링크 → `/admin/login`. 직원 로그인과 **비밀번호가 따로**이고,
목업 관리자 비밀번호는 모두 `officemap-admin` 입니다 (직원 비밀번호 `officemap1234`로는 안 들어가짐).

| 사번 | 이름 | 관리자 권한 |
|---|---|---|
| 20090001 | 한도윤 부장 (총무팀) | 전사 관리자 · 전체 사업장 |
| 20120002 | 강지아 차장 (총무팀) | 사업장 관리자 · 서울 본사 |
| 20130003 | 정민호 차장 (IT운영팀) | 층 관리자 · 서울 본사 7F |
| 20150004 | 오서연 과장 (재무팀) | 구역 관리자 · 7F 재무팀 B구역 (층 관리자 승인 후 반영) |

관리자 화면은 15분 쓰지 않으면 자동 로그아웃되고, 관리자 비밀번호를 5번 틀리면 관리자 계정만 잠깁니다
(직원 화면 로그인은 그대로). 직원 화면이든 관리자 페이지든 로그아웃하면 그 브라우저의 두 로그인이 모두 끝납니다.

목업 회의실 예약은 `init_db`를 실행한 날을 오늘로 잡고 만듭니다. 며칠 지나 예약표가 비어 보이면 다시 만드세요.

잠긴 계정은 `python -m scripts.init_db --reset`으로 풀립니다. 저장소를 새로 받아 DB 구조나 목업이 바뀌었을 때도
같은 명령으로 다시 만드세요 (기존 데이터는 지워집니다).

## Claude Code 클라우드 세션에서 임시 공개하기 (데모용)

클라우드 세션의 컨테이너는 바깥에서 접속할 수 없어서 ngrok으로 임시 공개 주소를 만듭니다.
환경 설정에 환경 변수 `NGROK_AUTHTOKEN`과 네트워크 허용 도메인 `connect.ngrok-agent.com`을 넣은 뒤,
새 세션에서 아래를 실행하면 DB부터 화면까지 띄우고 공개 주소를 출력합니다.

```bash
bash scripts/cloud-demo.sh        # 끄기: bash scripts/cloud-demo.sh stop
```

공개 주소는 링크를 아는 누구나 접속할 수 있으니 목업 데이터로만 쓰고, 다 보면 끄세요.
