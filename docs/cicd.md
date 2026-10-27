# GitHub Actions로 검사·자동 배포 (CI/CD)

```
PR 올림 ───▶ CI (.github/workflows/ci.yml)
             ├─ API 서버   ruff → 빈 DB에 스키마·목업 → API 서버 켜고 연기 시험 (server/scripts/smoke_test.py)
             ├─ 화면       eslint → 타입 검사 → next build
             └─ 도커       두 이미지가 빌드되는지
main에 합침 ─▶ Deploy (.github/workflows/deploy.yml)
             CI → arm64 이미지 빌드 → ECR(이미지 저장소) → SSM으로 EC2에 명령 → deploy/remote-deploy.sh
                                                              (ECR에서 받아 바꿔 띄우기, 안 뜨면 직전 버전으로)
```

- **GitHub에 AWS 키를 넣지 않습니다.** GitHub이 실행마다 주는 임시 토큰(OIDC)으로 정해진 역할만 받습니다.
- **SSH 포트를 열지 않습니다.** 서버 명령은 AWS Systems Manager(SSM)로 보냅니다.
- **서버에서 빌드하지 않습니다.** 서버는 이미지를 받아 컨테이너만 바꿉니다 (몇십 초, 메모리 걱정 없음).
- 새 버전이 정상(healthy)으로 뜨지 않으면 **직전 버전으로 저절로 되돌리고** 실패로 표시합니다.

## CI만 쓰기 (설정 없음)

PR을 열면 바로 돕니다. PR 아래쪽 검사 목록에 `CI / API 서버`, `CI / 화면`, `CI / 도커 이미지 빌드`가 보입니다.
실패하면 그 줄의 Details → 빨간 단계를 펼치면 원인이 있습니다.

검사가 통과해야만 합치게 하려면: 저장소 Settings → Branches → Add classic branch protection rule → Branch name `main`
→ **Require status checks to pass** → `API 서버`, `화면`, `도커 이미지 빌드` 검색해 추가 → Create.

연기 시험은 손으로도 돌릴 수 있습니다 (API 서버를 켜 둔 채, `server`에서): `python -m scripts.smoke_test`

## 자동 배포 켜기 (한 번만)

[AWS 배포 가이드](deploy-aws.md)대로 서버가 떠 있는 상태에서 시작합니다. 약 20분.

### 1. AWS 쪽 만들기 (CloudShell에서 스크립트 한 번)

AWS 콘솔(리전 **서울**) 위쪽 막대의 **CloudShell** 아이콘(`>_`)을 누르면 브라우저 안에 터미널이 열립니다. 거기서:

```bash
git clone --depth 1 https://github.com/GREATHOAXER/OfficeMap.git && cd OfficeMap
bash deploy/aws/setup-cicd.sh
```

[`deploy/aws/setup-cicd.sh`](../deploy/aws/setup-cicd.sh)가 만드는 것 (여러 번 돌려도 됩니다):

| 무엇 | 이름 | 하는 일 |
|---|---|---|
| ECR 저장소 2개 | `officemap-backend`, `officemap-frontend` | 이미지 보관. 최근 20개만 남기고 저절로 지움 ([규칙](../deploy/aws/ecr-lifecycle.json)) |
| OIDC 공급자 | `token.actions.githubusercontent.com` | AWS가 GitHub의 임시 토큰을 믿게 함 |
| GitHub용 역할 | `officemap-github-deploy` | 이 저장소의 **main**에서 돈 Actions만 받을 수 있음 ([신뢰 정책](../deploy/aws/github-oidc-trust.json)). 할 수 있는 일은 두 ECR 저장소에 올리기와 이 서버에 명령 보내기뿐 ([권한](../deploy/aws/github-deploy-policy.json)) |
| EC2 역할 | `officemap-ec2` | 서버가 SSM 명령을 받고 ECR에서 이미지를 받음 (AWS 관리형 정책 `AmazonSSMManagedInstanceCore`, `AmazonEC2ContainerRegistryReadOnly`) |

끝나면 GitHub 변수와 서버에 넣을 값이 찍힙니다. 창을 닫지 말고 다음 단계에서 복사해 씁니다.

### 2. 서버 준비

```bash
ssh -i ~/.ssh/officemap-key.pem ubuntu@<서버 IP>

# ECR 로그인 도우미: docker가 서버의 IAM 역할로 ECR에 로그인한다 (비밀번호 저장 없음)
sudo apt-get update && sudo apt-get install -y amazon-ecr-credential-helper
mkdir -p ~/.docker
echo '{"credHelpers": {"<계정ID>.dkr.ecr.ap-northeast-2.amazonaws.com": "ecr-login"}}' > ~/.docker/config.json

# 이미지 주소 (1의 출력에 있는 IMAGE_PREFIX 줄, 끝의 / 까지)
echo 'IMAGE_PREFIX=<계정ID>.dkr.ecr.ap-northeast-2.amazonaws.com/' >> ~/OfficeMap/deploy/.env

# SSM 연결 확인: active가 나오면 됨. 역할을 방금 붙였으면 한 번 다시 켠다
sudo snap restart amazon-ssm-agent && sudo snap services amazon-ssm-agent
```

AWS 콘솔 → **Systems Manager → Fleet Manager**에 `officemap-app`이 "온라인"으로 보이면 됩니다 (몇 분 걸릴 수 있음).

서버의 저장소 파일(`compose.yml` 등)은 손으로 고치지 마세요. 배포할 때 그 커밋의 파일로 덮어씁니다. 서버별 설정은 `deploy/.env`에만 둡니다.

### 3. GitHub 설정

저장소 **Settings → Secrets and variables → Actions → Variables 탭 → New repository variable** (Secrets가 아니라 Variables):

| 이름 | 값 |
|---|---|
| `AWS_REGION` | `ap-northeast-2` |
| `AWS_ROLE_ARN` | 1의 출력 (`arn:aws:iam::<계정ID>:role/officemap-github-deploy`) |
| `EC2_INSTANCE_ID` | 1의 출력 (`i-...`) |
| `APP_URL` | (선택) HTTPS를 켠 뒤 `https://<도메인>`. 배포 끝에 `/api/health`로 접속 확인 |
| `DEPLOY_ENABLED` | `true` — **마지막에** 넣습니다. 없으면 main에 합쳐도 검사만 합니다 |

배포 환경: **Settings → Environments → New environment** → 이름 `production` → Deployment branches and tags에서
**Selected branches and tags → `main`** 추가. 배포 전에 사람 승인을 받으려면 **Required reviewers**에 본인을 넣습니다.

그 밖에 필요할 때만 쓰는 변수:

| 이름 | 언제 |
|---|---|
| `APP_DIR` | 서버의 저장소 위치가 `/home/ubuntu/OfficeMap`이 아닐 때 |
| `IMAGE_PLATFORM` | 서버가 x86(t3 등)일 때 `linux/amd64` |
| `BUILD_RUNNER` | arm 러너(`ubuntu-24.04-arm`, 공개 저장소에서 무료)를 못 쓸 때 `ubuntu-24.04` (흉내 내 빌드라 느림) |

### 4. 첫 배포

**Actions → Deploy → Run workflow** (Branch: main) → Run workflow.
처음엔 빌드 캐시가 없어 10분 안팎, 다음부터는 3~5분입니다. 끝나면 서버에서 `docker compose ps`의 IMAGE가 ECR 주소로 바뀌어 있습니다.

## 평소에

| 할 일 | 방법 |
|---|---|
| 새 버전 올리기 | PR → CI 통과 → main에 합치기. 끝 |
| DB 스키마가 바뀐 버전 | 배포 요약에 "지난 배포 뒤로 DB 스키마 파일이 바뀌었어요"가 뜹니다. 새 테이블·함수 파일이면 **Actions → Deploy → Run workflow**의 `schema_files`에 파일 이름을 빈칸으로 구분해 넣고 다시 돌립니다 (예: `12_personnel.sql 09_retention.sql`, `init_db --only`와 같음). 기존 테이블의 열이 바뀐 파일은 이 방법으로 넣을 수 없습니다 ([deploy-aws.md 5](deploy-aws.md#5-새-버전-올리기)) |
| 되돌리기 | **Run workflow**의 `ref`에 이전 커밋 SHA (GitHub의 Commits 목록에서 복사) |
| 서버에서 손으로 같은 일 | `cd ~/OfficeMap && git fetch && git checkout -B main <SHA> && bash deploy/remote-deploy.sh <SHA>` (그 커밋 이미지가 ECR에 있어야 함) |
| 자동 배포 잠깐 끄기 | 변수 `DEPLOY_ENABLED`를 `false`로 |

배포 로그는 Actions → 그 실행 → **서버에 올리기** 단계에 서버 출력 그대로 나옵니다.

## 안 될 때

| 증상 | 확인 |
|---|---|
| 이미지 빌드: "배포 설정" 오류, 또는 `Input required and not supplied: aws-region` | 저장소 변수 `AWS_REGION`·`AWS_ROLE_ARN`·`EC2_INSTANCE_ID`가 없거나 다른 곳에 있음. **Variables 탭**(Secrets 탭 아님)의 **Repository variables**(Environments → production 안 아님)에 넣습니다. AWS 쪽(1)을 아직 안 했으면 `DEPLOY_ENABLED`를 `false`로 |
| 이미지 빌드: `Not authorized to perform sts:AssumeRoleWithWebIdentity` | main이 아닌 브랜치에서 Run workflow를 눌렀거나, 역할의 신뢰 정책에 적힌 저장소 이름(`GREATHOAXER/OfficeMap`, 대소문자까지)이 다름. 저장소 이름을 바꿨으면 `github-oidc-trust.json`을 고치고 1을 다시 |
| 이미지 빌드가 "Waiting for a runner"에서 오래 멈춤 | arm 러너는 공개 저장소에서만 무료. 저장소를 비공개로 바꿨다면 변수 `BUILD_RUNNER=ubuntu-24.04` |
| 서버에 올리기: "SSM 명령을 보내지 못했어요" / `InvalidInstanceId` | Fleet Manager에 인스턴스가 온라인인지 (2의 `snap restart`), `EC2_INSTANCE_ID`·`AWS_REGION` |
| 서버: "ECR에서 … 받지 못했어요" / `no basic auth credentials` | `~/.docker/config.json`의 계정ID·리전, `amazon-ecr-credential-helper` 설치, 인스턴스에 EC2 역할이 붙었는지 (EC2 → 인스턴스 → 보안 탭의 IAM 역할) |
| 서버: "새 버전이 … 정상으로 뜨지 않았어요" | 직전 버전으로 이미 되돌렸습니다. 위에 찍힌 backend 로그를 보세요. 새 스키마를 안 넣은 것이 흔한 원인 |
| 서버: `git fetch` 실패 | 저장소를 비공개로 바꿨다면 서버에 읽기 전용 배포 키(Deploy key)를 넣어야 합니다 |
| 접속 확인(`APP_URL`) 실패 | 보안 그룹이 80·443을 내 IP에만 열어 두면 GitHub에서 닿지 않습니다. HTTPS를 켜기 전에는 변수 `APP_URL`을 비워 두세요 |

## 보안 메모

- GitHub용 역할은 **이 서버에 아무 명령이나 보낼 수 있는** 권한(AWS-RunShellScript)을 갖습니다. main에 올릴 수 있는 사람은 서버도
  바꿀 수 있다는 뜻이라, main 보호 규칙(CI 통과·리뷰)과 `production` 환경의 승인자를 같이 쓰는 것을 권합니다.
- 비용: GitHub Actions는 공개 저장소에서 무료, ECR 보관은 이미지 40개(약 4GB) 기준 월 0.4달러 안팎, 같은 리전 EC2로 받는 전송은 무료.
