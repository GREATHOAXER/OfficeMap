# Claude(코딩 도우미)에게 권한 주기

Claude Code 클라우드 세션이 GitHub·Claude API·AWS를 직접 다루게 할 때 무엇을 어디에 주는지. 원칙은 **이 프로젝트에 필요한 만큼만**,
그리고 **키는 채팅이 아니라 환경 설정에** 넣기입니다.

키를 넣는 곳: claude.ai/code 세션 제목 줄의 클라우드 환경 메뉴 → **Edit** → 환경 변수 → 저장. **새 세션부터** 적용됩니다.

| 대상 | 주는 것 | 환경 변수 | 할 수 있게 되는 것 |
|---|---|---|---|
| GitHub | 없음 (claude.ai의 GitHub 연결로 충분) | – | 브랜치에 올리기, PR 만들기(말했을 때), CI 로그 읽기 |
| Claude API | 개발용 API 키 | `ANTHROPIC_API_KEY` | AI 도우미를 실제 모델로 시험 |
| AWS | 전용 IAM 사용자 `claude-officemap`의 키 | `OFFICEMAP_AWS_ACCESS_KEY_ID`, `OFFICEMAP_AWS_SECRET_ACCESS_KEY`, `OFFICEMAP_AWS_REGION`, `OFFICEMAP_EC2_INSTANCE_ID` | 리소스 설정 보기, 서버에서 점검 명령(로그·`check_db`·`check_ai`), 배포 확인, 비용 보기 |

## Claude API 키

[console.anthropic.com](https://console.anthropic.com/) → Workspaces → 작업 공간 하나(`officemap-dev` 등)를 만들고 **월 사용 한도**를 건 뒤,
그 안에서 API Keys → Create Key. 서버(`deploy/.env`)에 넣는 키와는 따로 만듭니다.

## AWS: `claude-officemap` 사용자

CloudShell(콘솔 위쪽 `>_`, 리전 서울)에서:

```bash
git clone --depth 1 https://github.com/GREATHOAXER/OfficeMap.git && cd OfficeMap
bash deploy/aws/setup-claude-access.sh
```

끝에 나오는 네 줄(`OFFICEMAP_...`)을 환경 변수에 넣습니다. 비밀 키는 그때 한 번만 보입니다.
CloudShell을 연 리전에서 서버를 찾습니다. 서버가 다른 리전에 있으면 그 리전으로 다시 돌리라고 알려 줍니다 (예: `AWS_REGION=ap-northeast-2 bash deploy/aws/setup-claude-access.sh`).

| 할 수 있음 | 할 수 없음 |
|---|---|
| AWS 리소스 설정 보기 (AWS 관리형 `ViewOnlyAccess`: 목록·설정만) | 리소스 만들기·바꾸기·지우기 (보안 그룹, RDS, IAM, EC2 켜고 끄기 등) |
| `officemap-app` 서버 **한 대에만** SSM 명령 (로그 보기, 점검 스크립트, 배포 확인) | 다른 서버에 명령 |
| ECR 이미지, 이 프로젝트 IAM 역할(`officemap-*`) 설정 보기 | DB·S3 데이터, 비밀 값 읽기 |
| 비용 보기 (Cost Explorer) | 다른 IAM 사용자·역할 바꾸기 |
| Bedrock Claude 호출 (AI 도우미 시험, 쓴 만큼 요금) | |

권한은 [`deploy/aws/claude-operator-policy.json`](../deploy/aws/claude-operator-policy.json)에 있습니다. 서버 명령(SSM)은 서버에서 무엇이든
돌릴 수 있는 권한이라, Claude는 서버를 바꾸는 명령(재시작, 배포, DB 변경 등)은 실행하기 전에 먼저 묻습니다.

| 할 일 | 방법 |
|---|---|
| 키 바꾸기 (90일마다 권장, 잃어버렸을 때) | `bash deploy/aws/setup-claude-access.sh --new-key` → 환경 변수 바꾸기 → 안내대로 옛 키 지우기 |
| 권한 회수 | `bash deploy/aws/setup-claude-access.sh --remove` → 환경 변수 `OFFICEMAP_*` 지우기 |
| 권한 늘리기 | 정책 파일을 고쳐 다시 실행 (Claude에게 무엇이 필요한지 물어보세요) |

`AWS_...`가 아니라 `OFFICEMAP_AWS_...`로 넣는 까닭: 클라우드 세션에는 시스템이 쓰는 `AWS_` 변수가 이미 있어서, 같은 이름이면 섞입니다.

## 넣지 않는 것

AWS 루트 계정 키, `AdministratorAccess` 키, RDS 마스터 비밀번호, EC2 SSH 키(`.pem`), 운영 서버의 `deploy/.env` 내용.
