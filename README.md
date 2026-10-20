# OfficeMap
Vibe Coding Project @ KFTC

사업장·층별 좌석과 동료의 재실 상태, 회의실 예약을 한 곳에서 보는 사내 서비스입니다.

## 폴더 구조

| 폴더 | 내용 |
|---|---|
| `db/` | 테이블 정의(`schema/`)와 목업 데이터(`seed/`) — PostgreSQL 16 |
| `server/` | API 서버 — Python FastAPI, uvicorn으로 실행 |
| `frontend/` | 화면 — Next.js 16 |

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

| 사번 | 이름 | 확인할 수 있는 것 |
|---|---|---|
| 20190005 | 조시우 대리 (재무팀) | 일반 로그인 |
| 20090001 | 한도윤 부장 (총무팀) | 관리자 계정 |
| 20260006 | 이서연 사원 (재무팀) | 임시 비밀번호 상태 |
| 20200007 | 김민준 대리 (경영기획팀) | 5번 틀려서 계정 잠그기 |

잠긴 계정은 `python -m scripts.init_db --reset`으로 풀립니다.
