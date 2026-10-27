# AWS에 서버 올리기 (EC2 한 대 + RDS)

처음 올리는 시험 서버 기준입니다. 서버 한 대(EC2)에 화면·API를 도커로 띄우고, DB는 AWS가 관리하는 PostgreSQL(RDS)을 씁니다.

```
브라우저 ──HTTP(S)──▶ EC2 t4g.medium (Ubuntu, 도커)
                       ├─ caddy     앞단 웹 서버 (80·443). /api → backend, 나머지 → frontend
                       ├─ frontend  Next.js 화면 (frontend/Dockerfile)
                       └─ backend   FastAPI (server/Dockerfile) ──5432──▶ RDS PostgreSQL 16
```

- 설정 파일: [`deploy/compose.yml`](../deploy/compose.yml), [`deploy/Caddyfile`](../deploy/Caddyfile),
  [`deploy/.env.example`](../deploy/.env.example)
- 리전은 **아시아 태평양(서울) ap-northeast-2**. 콘솔 오른쪽 위에서 먼저 바꿔 두세요.
- 비용(대략, 서울 리전·켜 둔 채로): EC2 t4g.medium + RDS db.t4g.micro~small + 디스크·고정 IP로 월 70~90달러 안팎.
  정확한 값은 [AWS 요금 계산기](https://calculator.aws/)로 확인하세요. 안 쓸 때 꺼 두면 줄어듭니다(아래 7).
- 지금 단계는 **목업 데이터로 시험**하는 서버입니다. 실제 직원 데이터를 넣기 전에 할 일은 아래 8에 있습니다.

## 0. 시작 전에 (계정)

1. [aws.amazon.com](https://aws.amazon.com/)에서 계정을 만듭니다 (결제 카드 필요).
2. **루트 계정에 MFA**를 켭니다: 오른쪽 위 계정 이름 → 보안 자격 증명 → MFA 할당.
3. **예산 알림**: Billing and Cost Management → 예산(Budgets) → 예산 생성 → "월별 비용 예산", 예: 100달러, 알림 메일 주소.
4. 평소에 쓸 **관리자 사용자**(권장): IAM → 사용자 → 사용자 생성 → "AWS Management Console에 대한 사용자 액세스 권한 제공"
   → 권한: `AdministratorAccess` 직접 연결. 이후 루트 계정은 쓰지 않습니다.
5. 콘솔 오른쪽 위 리전을 **서울**로.

비밀번호·키는 이 문서나 채팅·메신저에 붙여 넣지 말고, 서버의 `deploy/.env`와 본인 PC에만 둡니다.

## 1. EC2 만들기 (앱 서버)

EC2 → 인스턴스 → **인스턴스 시작(Launch instances)**

| 항목 | 값 |
|---|---|
| 이름 | `officemap-app` |
| AMI | **Ubuntu Server 24.04 LTS**, 아키텍처 **64비트(Arm)** |
| 인스턴스 유형 | **t4g.medium** (2 vCPU, 4 GiB) |
| 키 페어 | 새 키 페어 생성 → 이름 `officemap-key`, RSA, `.pem` → 내려받은 파일을 보관 |
| 네트워크 설정 → 편집 | 보안 그룹 생성 `officemap-app-sg`. 규칙: **SSH(22) 소스 "내 IP"**, **HTTP(80) 소스 "내 IP"** |
| 스토리지 | 30 GiB, gp3 |

- 회사·집 등 여러 곳에서 접속하면 HTTP 규칙을 곳마다 추가합니다(소스 "내 IP"는 지금 접속한 곳의 IP).
- 내려받은 키는 Mac에서: `mv ~/Downloads/officemap-key.pem ~/.ssh/ && chmod 400 ~/.ssh/officemap-key.pem`

**고정 IP 붙이기**: EC2 → 탄력적 IP(Elastic IPs) → 탄력적 IP 주소 할당 → 할당된 주소 선택 → 작업 → 탄력적 IP 주소 연결
→ 인스턴스 `officemap-app`. 이 주소가 서버 주소입니다(이하 `<서버 IP>`). 붙이지 않으면 서버를 껐다 켤 때마다 주소가 바뀝니다.

## 2. RDS 만들기 (DB)

EC2가 만들어진 뒤에 합니다(DB를 그 EC2에서만 접속하게 묶기 위해).

RDS → 데이터베이스 → **데이터베이스 생성**

| 항목 | 값 |
|---|---|
| 생성 방식 | 표준 생성 |
| 엔진 | **PostgreSQL**, 엔진 버전 **16**의 최신(16.x) — 로컬 개발 DB와 같은 16 |
| 템플릿 | 개발/테스트 (프리 티어가 보이면 그것도 됨) |
| 배포 옵션 | 단일 AZ DB 인스턴스 |
| DB 인스턴스 식별자 | `officemap-db` |
| 마스터 사용자 이름 | `officemap` |
| 자격 증명 관리 | **자체 관리** → 마스터 암호를 직접 입력. **영문·숫자로만 16자 이상** (기호는 접속 주소에서 깨짐) |
| 인스턴스 구성 | 버스트 가능 클래스 → `db.t4g.micro`(시험) 또는 `db.t4g.small` |
| 스토리지 | gp3, 20 GiB, 스토리지 자동 조정 켬 |
| 연결 | **EC2 컴퓨팅 리소스에 연결** → `officemap-app` 선택 (보안 그룹이 자동으로 만들어져 그 EC2에서만 5432로 접속 가능) |
| 퍼블릭 액세스 | 아니요 |
| 데이터베이스 인증 | 암호 인증 |
| 추가 구성 → **초기 데이터베이스 이름** | **`officemap`** (비우면 DB가 만들어지지 않습니다) |
| 추가 구성 → 백업 | 자동 백업 켬, 보존 기간 7일 |
| 추가 구성 → 삭제 방지 | 켬 |

5~10분 뒤 상태가 "사용 가능"이 되면 DB를 눌러 **연결 및 보안 → 엔드포인트**를 복사해 둡니다
(예: `officemap-db.abcdefghijkl.ap-northeast-2.rds.amazonaws.com`).

## 3. 서버 준비 (한 번만)

Mac 터미널에서 접속:

```bash
ssh -i ~/.ssh/officemap-key.pem ubuntu@<서버 IP>
```

서버에서:

```bash
# 화면 빌드할 때 메모리를 잠깐 1.5GB쯤 써서, 여유로 2GB 스왑을 만든다
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# 도커 설치 (Docker 공식 설치 스크립트: 도커 + compose + buildx)
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu
exit
```

다시 접속해서(그래야 `sudo` 없이 `docker`를 씁니다) 코드를 받고 설정 파일을 만듭니다:

```bash
ssh -i ~/.ssh/officemap-key.pem ubuntu@<서버 IP>
git clone https://github.com/GREATHOAXER/OfficeMap.git
cd OfficeMap/deploy
cp .env.example .env
nano .env
```

`.env`에서 `DATABASE_URL`만 바꿉니다 (나머지는 그대로):

```
DATABASE_URL=postgresql://officemap:<마스터 암호>@<RDS 엔드포인트>:5432/officemap?sslmode=require
```

`nano`는 Ctrl+O, Enter로 저장, Ctrl+X로 나옵니다.

## 4. 띄우기

```bash
cd ~/OfficeMap/deploy
docker compose build              # 이미지 빌드 (처음엔 5~10분)
docker compose run --rm backend python -m scripts.check_db   # DB 접속 점검: 끝에 "DB 접속 정상"이 나와야 함
docker compose run --rm backend python -m scripts.init_db    # 테이블 + 목업 데이터 (처음 한 번)
docker compose up -d              # 띄우기
docker compose ps                 # backend가 (healthy), 나머지 Up이면 정상
```

브라우저에서 `http://<서버 IP>` → 로그인 화면. 목업 계정은 [README의 목업 계정](../README.md#목업-계정)과 같습니다.

`check_db`는 DB 주소 찾기 → 5432 포트 연결 → 로그인 → 확장 기능 → 테이블 순서로 보고, 막힌 단계에서 ✘와 고칠 곳(→)을
보여 줍니다. 암호는 화면에 나오지 않으니 결과를 그대로 다른 사람에게 보여 줘도 됩니다.

```
DB 접속 점검: officemap@officemap-db.abcdefghijkl.ap-northeast-2.rds.amazonaws.com:5432/officemap?sslmode=require
  ✔ DB 주소 찾음: officemap-db.abcdefghijkl.ap-northeast-2.rds.amazonaws.com → 172.31.5.20
  ✘ 5432 포트 연결: 5초 동안 응답 없음
    → DB 서버가 응답하지 않아요. 대개 RDS 보안 그룹이 이 EC2에서 오는 5432 접속을 막고 있어서예요. ...
```

**안 될 때**

| 증상 | 확인 |
|---|---|
| `up` 중에 `✘ Container officemap-backend-1 Error` / `dependency failed to start: container officemap-backend-1 is unhealthy` | API가 DB에 접속하지 못해서 상태 확인이 실패한 것입니다. `docker compose run --rm backend python -m scripts.check_db`로 막힌 단계를 보고 아래 줄대로 고친 뒤 `docker compose up -d`. 서버 로그(`docker compose logs backend`) 맨 앞에도 "DB에 접속하지 못했어요"와 이유가 남습니다 |
| check_db: 5432 포트 연결 응답 없음 | RDS 보안 그룹이 EC2를 막고 있음. RDS → 데이터베이스 → `officemap-db` → 작업 → **EC2 연결 설정** → `officemap-app` 선택 (또는 RDS의 VPC 보안 그룹 → 인바운드 규칙 편집 → 유형 PostgreSQL, 소스 `officemap-app-sg`). RDS 상태가 "사용 가능"인지도 확인 |
| check_db: DB 주소를 찾을 수 없음 | 엔드포인트 오타. RDS → 연결 및 보안 → 엔드포인트를 그대로 복사 |
| check_db: 암호가 틀림 | `.env`의 `officemap:` 뒤 `@` 앞. 모르면 RDS → 수정 → 마스터 암호 변경(영문·숫자만) |
| check_db: 데이터베이스가 없음 | RDS를 만들 때 초기 데이터베이스 이름을 비워 둠. `docker compose run --rm backend python -m scripts.check_db --create-db` |
| check_db: 암호화하지 않은 접속을 막음 | 주소 끝에 `?sslmode=require` |
| 브라우저가 접속 자체를 못 함 | EC2 보안 그룹의 HTTP(80) 소스가 지금 내 IP인지 (집·회사·휴대폰 망마다 다름) |
| 로그인 버튼을 눌러도 로그인 화면으로 돌아옴 | HTTP로 접속하는데 `.env`의 `COOKIE_SECURE=true`이면 쿠키가 저장되지 않음 → `false` |
| init_db가 "이미 테이블이 있어서 멈췄습니다" | 이미 한 번 넣었음. 목업을 처음 상태로: `docker compose run --rm backend python -m scripts.init_db --reset` |

## 5. 새 버전 올리기

GitHub Actions 자동 배포를 켰다면 main에 합치기만 하면 됩니다: [docs/cicd.md](cicd.md). 손으로 올릴 때는:

```bash
cd ~/OfficeMap && git pull && cd deploy && docker compose up -d --build
```

바뀐 이미지만 다시 빌드하고, 바뀐 컨테이너만 다시 띄웁니다(몇십 초 끊김).
DB 구조(`db/schema`)가 바뀐 버전이면 둘 중 하나:

- 새 스키마 파일만 넣기 (데이터는 그대로): 새로 생긴 파일과 바뀐 함수 파일을 고릅니다. 예) 인사이동이 들어간 버전:
  ```bash
  docker compose run --rm backend python -m scripts.init_db --only 12_personnel.sql 09_retention.sql
  ```
  AI 도우미가 들어간 버전은 `13_ai_chat.sql` (켜는 법: [docs/ai.md](ai.md)).
  이미 있는 테이블을 다시 만들려 하면 아무것도 바꾸지 않고 멈춥니다.
- 목업을 처음부터 다시 (시험 서버만, 데이터가 지워짐): `docker compose run --rm backend python -m scripts.init_db --reset`

기존 테이블의 열이 바뀐 버전은 `--only`로 넣을 수 없어서, 실제 데이터가 들어가기 전에 마이그레이션(바뀐 부분만 적용) 도구를
들여옵니다(아래 8).

## 6. HTTPS 켜기 (도메인 연결)

앞단 Caddy가 Let's Encrypt 인증서를 저절로 받고(무료), 만료 전에 저절로 갱신합니다. 할 일은 **도메인이 서버 IP를 가리키게 하기**,
**80·443 열기**, **`.env`에 도메인 적기** 세 가지입니다. 아래는 가비아에서 산 도메인을 Route 53으로 관리하는 경우입니다
(예: 도메인 `example.com`, 접속 주소 `officemap.example.com`. 도메인 자체 `example.com`으로 써도 됩니다).

**6-1. 네임서버 확인** — Route 53 → 호스팅 영역 → 도메인 → `NS` 레코드의 값 4개(`ns-123.awsdns-45.com.` 같은 것)가
가비아 → My가비아 → 도메인 관리 → 네임서버 설정에 **4개 모두, 그대로** 들어가 있어야 합니다. Mac 터미널에서:

```bash
dig +short NS example.com     # awsdns가 들어간 이름 4개가 나오면 됨 (가비아 것이 나오면 아직 반영 전: 보통 1시간, 길면 하루)
```

네임서버를 Route 53으로 넘긴 뒤에는 **가비아의 DNS 레코드 설정은 쓰이지 않습니다.** 레코드는 모두 Route 53에서 만듭니다.
호스팅 영역을 지웠다 다시 만들면 NS 값이 바뀌니 가비아에도 다시 넣어야 합니다.

**6-2. A 레코드** — Route 53 → 호스팅 영역 → 도메인 → **레코드 생성**:

| 항목 | 값 |
|---|---|
| 레코드 이름 | `officemap` (도메인 자체로 쓰려면 비움) |
| 레코드 유형 | A |
| 값 | 서버의 **탄력적 IP** (`<서버 IP>`) |
| TTL | 300 |
| 라우팅 정책 | 단순 라우팅 |

```bash
dig +short A officemap.example.com   # <서버 IP>가 나오면 됨 (몇 분)
```

**6-3. 보안 그룹** — EC2 → 보안 그룹 → `officemap-app-sg` → 인바운드 규칙 편집 → 규칙 추가:
**HTTP(80) 소스 0.0.0.0/0**, **HTTPS(443) 소스 0.0.0.0/0**. 인증서 발급처가 인터넷에서 80으로 들어와 도메인 주인인지 확인하고,
갱신(약 60일마다) 때도 다시 들어옵니다. SSH(22)는 계속 "내 IP"만 둡니다.

**6-4. `.env`와 다시 띄우기** — 서버에서:

```bash
cd ~/OfficeMap/deploy
nano .env
#   SITE_ADDRESS=officemap.example.com        (여러 개면 쉼표: SITE_ADDRESS=example.com, www.example.com)
#   COOKIE_SECURE=true
docker compose up -d
docker compose logs -f caddy   # "certificate obtained successfully"가 나오면 Ctrl+C
```

브라우저에서 `https://officemap.example.com`. `http://`로 들어와도 HTTPS로 넘어갑니다. 이제 `http://<서버 IP>`로는 열리지 않습니다
(Caddy는 적어 둔 도메인으로 온 접속만 받습니다). 자동 배포를 쓰면 GitHub 변수 `APP_URL`에 `https://officemap.example.com`
([docs/cicd.md](cicd.md#3-github-설정)).

**안 될 때**

| 증상 | 확인 |
|---|---|
| `dig`에 아무것도 안 나옴 / caddy 로그 `NXDOMAIN` | 6-1 네임서버가 아직 반영 전이거나 가비아에 넣은 값이 Route 53 호스팅 영역의 NS와 다름. 6-2 레코드 이름 오타 |
| caddy 로그 `Timeout during connect (likely firewall problem)` · `connection refused` | 6-3 보안 그룹에 80·443이 0.0.0.0/0으로 열렸는지 |
| caddy 로그 `rateLimited` · `too many` | 실패를 여러 번 반복해 발급처가 잠시 막음. 원인을 고친 뒤 한 시간쯤 기다리면 Caddy가 저절로 다시 시도합니다 |
| 브라우저 "안전하지 않음" 경고 | IP나 `.env`에 없는 이름으로 접속함. 인증서 발급 전이면 위 로그부터 |
| 로그인해도 로그인 화면으로 돌아옴 | HTTPS인데 `COOKIE_SECURE=false`이거나, HTTP인데 `true` |

인증서는 `caddy-data` 볼륨에 있습니다. `docker compose down -v`는 이 볼륨까지 지워 인증서를 새로 받게 되니 쓰지 마세요
(그냥 `down`은 괜찮습니다).

**인터넷 전체에 열지 않으려면**: 위 방법은 로그인 화면이 인터넷에 열립니다(목업 데이터 시험 서버는 괜찮음). 실제 데이터를 넣을 때는
① Caddy가 80을 열지 않고 Route 53에 확인용 레코드를 써서 인증서를 받게(DNS 인증) 바꾸고 보안 그룹을 사내 IP로 좁히거나,
② 로드밸런서(ALB) + AWS 인증서(ACM) + 사내망 접속(VPN 등)으로 갑니다. 정보보호팀과 정할 부분입니다.

## 7. 관리

| 할 일 | 방법 |
|---|---|
| 로그 보기 | `docker compose logs -f backend` (또는 `frontend`, `caddy`) |
| 다시 시작 | `docker compose restart backend` |
| 안 쓸 때 비용 줄이기 | EC2 → 인스턴스 중지 (디스크·고정 IP 비용만 남음). RDS → 작업 → 일시 중지(최대 7일, 지나면 저절로 다시 켜짐) |
| 서버를 다시 켰을 때 | 컨테이너는 저절로 다시 뜹니다 (`restart: unless-stopped`) |
| DB 백업 | 자동 백업(7일 보관). 큰 변경 전에는 RDS → 작업 → 스냅샷 생성 |
| OS 보안 업데이트 | 가끔 `sudo apt update && sudo apt upgrade -y` 후 `sudo reboot` |

## 8. 실제 데이터를 넣기 전에 (다음 단계)

1. **마이그레이션 도구**: 지금 `init_db`는 "빈 DB에 전부 만들기"와 "`--reset` 전부 지우고 다시"뿐입니다.
2. **`APP_ENV=production`**: `.env`에서 바꾸면 `init_db --reset`이 막힙니다.
3. **앱 전용 DB 계정**: 마스터 계정 대신 읽기·쓰기만 되는 계정으로 접속합니다.
4. **접속 범위**: 사내망에서만 열기(ALB + VPN 등), 정보보호팀 검토.
5. **이미지 빌드를 서버 밖으로**: GitHub Actions에서 빌드해 ECR(이미지 저장소)에 올리고, 서버는 받기만 합니다 → [docs/cicd.md](cicd.md)

## 내 PC에서 같은 구성으로 먼저 시험하기 (선택)

RDS 없이 DB까지 컨테이너로 띄워, AWS에 올리기 전에 똑같은 구성을 Mac에서 확인할 수 있습니다 (Docker Desktop 필요).

```bash
cd deploy
cp .env.example .env    # DATABASE_URL을 postgresql://officemap:officemap@db:5432/officemap 로
docker compose --profile local-db up -d --build
docker compose run --rm backend python -m scripts.init_db
open http://localhost
docker compose --profile local-db down   # 끄기 (DB 내용은 남음. 지우려면 down -v)
```
