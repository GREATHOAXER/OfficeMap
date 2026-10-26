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
docker compose up -d --build      # 처음엔 이미지 빌드로 5~10분
docker compose ps                 # backend가 (healthy), 나머지 Up이면 정상
docker compose run --rm backend python -m scripts.init_db   # 테이블 + 목업 데이터 (처음 한 번)
```

브라우저에서 `http://<서버 IP>` → 로그인 화면. 목업 계정은 [README의 목업 계정](../README.md#목업-계정)과 같습니다.

**안 될 때**

| 증상 | 확인 |
|---|---|
| `docker compose ps`에서 backend가 unhealthy | `docker compose logs backend`. 대개 `DATABASE_URL` 오타, 암호, 엔드포인트, 초기 DB 이름(`officemap`)을 안 만듦 |
| 브라우저가 접속 자체를 못 함 | EC2 보안 그룹의 HTTP(80) 소스가 지금 내 IP인지 (집·회사·휴대폰 망마다 다름) |
| 로그인 버튼을 눌러도 로그인 화면으로 돌아옴 | HTTP로 접속하는데 `.env`의 `COOKIE_SECURE=true`이면 쿠키가 저장되지 않음 → `false` |
| init_db가 "이미 테이블이 있어서 멈췄습니다" | 이미 한 번 넣었음. 목업을 처음 상태로: `docker compose run --rm backend python -m scripts.init_db --reset` |

## 5. 새 버전 올리기

```bash
cd ~/OfficeMap && git pull && cd deploy && docker compose up -d --build
```

바뀐 이미지만 다시 빌드하고, 바뀐 컨테이너만 다시 띄웁니다(몇십 초 끊김).
DB 구조(`db/schema`)가 바뀐 버전이면 지금은 시험 서버라 목업을 다시 넣습니다:
`docker compose run --rm backend python -m scripts.init_db --reset`. 실제 데이터가 들어간 뒤에는 이렇게 할 수 없으므로
그 전에 마이그레이션(바뀐 부분만 적용) 도구를 들여옵니다(아래 8).

## 6. HTTPS 켜기 (도메인이 생기면)

1. 도메인의 DNS에 A 레코드 추가: 예 `officemap.example.com` → `<서버 IP>`
2. EC2 보안 그룹에 **HTTP(80)·HTTPS(443) 소스 0.0.0.0/0** — 인증서 발급처(Let's Encrypt)가 인터넷에서 확인하러 들어옵니다.
3. `deploy/.env`:
   ```
   SITE_ADDRESS=officemap.example.com
   COOKIE_SECURE=true
   ```
4. `docker compose up -d` → Caddy가 인증서를 받아 HTTPS로 열고, HTTP는 HTTPS로 넘깁니다.

인터넷 전체에 열지 않고 사내에서만 쓰게 하려면 이 방법 대신 로드밸런서(ALB) + AWS 인증서(ACM) + 사내망 접속(VPN 등)으로
갑니다. 실제 운영 전에 정보보호팀과 정할 부분입니다.

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
5. **이미지 빌드를 서버 밖으로**: GitHub Actions에서 빌드해 ECR(이미지 저장소)에 올리고, 서버는 받기만 합니다.

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
