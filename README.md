# OfficeMap

Vibe Coding Project @ KFTC

**사업장·층별 좌석 배치도 위에서 동료가 어디에 앉아 있는지, 지금 자리에 있는지를 보고 회의실까지 예약하는 사내 오피스 서비스**입니다.
직원은 도면에서 사람을 찾고 재실 상태를 확인하며, 관리자는 도면을 그리고 좌석·팀 구역·조직을 관리합니다.

## 무엇을 하는 서비스인가

### 직원 화면

| 기능 | 내용 |
|---|---|
| 자리·재실 현황 | 사업장·층별 도면 위에 좌석과 앉은 사람, 재실 상태(재실·회의 중·외근·휴가 등 10가지)를 표시. 팀 구역은 색으로 구분하고 팀 칩이 범례 |
| 직원 검색 | 이름·팀·사번·하는 일·업무 키워드로 찾아 그 사람 자리로 바로 이동 |
| 사람 카드 | 사진·한 줄 소개·하는 일·업무 키워드·재실 상태와 기간·내선·이메일 |
| 내 재실 상태 | 상태와 메시지, 자동 해제(오늘까지·마지막 날 고르기 등) |
| 회의실 | 층별 예약 현황 타임라인, 끌어서 예약, 반복·여러 날 예약, 참석자(팀 단위 포함) 일정 충돌 표시 |
| AI 도우미 | 사람·자리·회의실을 자연어로 묻고 빈 회의실 추천 |
| 실시간 반영 | 재실 상태·자리 배치·도면이 바뀌면 새로고침 없이 화면에 반영 |

### 관리자 페이지

| 기능 | 내용 |
|---|---|
| 도면 편집 | 벽·기둥·회의실·공용 공간·출입구·책상 묶음을 실제 크기(m)로 그리고 게시. 그림·PDF·엑셀 도면을 불러와 초안 만들기, 게시 예약, PNG·PDF 내보내기 |
| 좌석 배치 편집 | 사람을 자리에 끌어다 놓기, 자리 교환, 팀 구역 지정(구역은 다른 팀·도면 요소를 침범하지 않게 자동 계산), 날짜 지정 반영, 승인 요청 |
| 조직도 | 부서 나무, 직원 등록·이동·휴직·퇴사, 비밀번호 초기화 |
| 인사이동 | 발령 엑셀을 올려 여러 사람의 소속과 자리를 한 번에 바꾸기(예약 가능) |
| 팀 이사 | 팀을 다른 층 빈 자리로 한 번에 옮기기 |
| 권한 | 최종 → 전사 → 사업장 → 층 → 구역 관리자 단계별 위임, 구역 관리자 변경은 승인 후 반영 |

## 기술 스택

| 영역 | 사용한 것 |
|---|---|
| 화면 | Next.js 16 (App Router) · React 19 · TypeScript · CSS Modules, pdf.js(PDF 도면 읽기) · ExcelJS(엑셀 도면·인사발령) |
| API 서버 | Python 3.13 · FastAPI · uvicorn · Pydantic · psycopg 3(커넥션 풀) · bcrypt |
| DB | PostgreSQL 16 · btree_gist(좌석 배정·회의실 예약 기간 겹침 방지) · pgvector(AI 업무 검색용으로 준비). 실시간 알림은 LISTEN/NOTIFY → 서버가 SSE로 화면에 전달 |
| AI | Claude (Anthropic API 또는 Amazon Bedrock) |
| 배포 | Docker(arm64) · Caddy(리버스 프록시·HTTPS 자동 인증서) · AWS EC2 · RDS PostgreSQL · ECR · Route 53 |
| CI/CD | GitHub Actions: PR마다 린트·타입 검사·빌드·DB 스키마 적재·API 연기 시험, main에 합치면 이미지 빌드 후 SSM으로 서버 배포 |

## 구조

```
브라우저 ──▶ Caddy ──┬─ /api/* ──▶ FastAPI (server/) ──▶ PostgreSQL (RDS)
                     └─ 그 밖 ───▶ Next.js (frontend/)
```

- 로컬에서는 Caddy 없이 Next.js(3000번)가 `/api/...` 요청을 FastAPI(8000번)로 넘겨줍니다.
- 직원 화면과 관리자 페이지는 로그인·세션이 따로입니다.
- DB 구조는 `db/schema/`의 SQL 파일로 관리하고, 배포할 때 새 파일만 자동으로 넣습니다(`init_db --upgrade`).

| 폴더 | 내용 |
|---|---|
| `frontend/` | 화면 (Next.js) — [frontend/README.md](frontend/README.md) |
| `server/` | API 서버 (FastAPI) — [server/README.md](server/README.md) |
| `db/` | 테이블 정의(`schema/`)와 목업 데이터(`seed/`) |
| `deploy/` | 운영 서버 설정 (도커 compose, Caddy, 배포 스크립트) |
| `docs/` | 설계·운영 문서 |
| `.github/workflows/` | CI(검사) · Deploy(자동 배포) |

## 문서

- [시작하기 · 둘러보기](docs/getting-started.md): 로컬 실행, 목업 계정, 관리자 기능 둘러보기
- [설계: 도면 편집 · 좌석 배치 편집](docs/design/floor-plan-and-seating.md)
- [AWS에 올리기](docs/deploy-aws.md) · [CI/CD](docs/cicd.md) · [AI 도우미](docs/ai.md) · [Claude 접근 권한](docs/claude-access.md)
