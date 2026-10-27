#!/usr/bin/env bash
# Claude(코딩 도우미)가 이 프로젝트의 AWS를 점검할 수 있게 전용 IAM 사용자 claude-officemap을 만든다.
# AWS 콘솔 위쪽의 CloudShell(>_ 아이콘, 리전 서울)에서:
#
#   git clone --depth 1 https://github.com/GREATHOAXER/OfficeMap.git && cd OfficeMap
#   bash deploy/aws/setup-claude-access.sh              # 만들기 (여러 번 돌려도 된다. 권한만 다시 맞춘다)
#   bash deploy/aws/setup-claude-access.sh --new-key    # 액세스 키 새로 만들기 (바꿀 때. 옛 키는 지우는 명령을 알려 준다)
#   bash deploy/aws/setup-claude-access.sh --remove     # 사용자와 키를 모두 지우기 (권한 회수)
#
# 할 수 있는 것: AWS 리소스 보기(ViewOnlyAccess: 설정만, 데이터는 못 읽음), 이 서버 한 대에만 명령 보내기(SSM),
# ECR 이미지·이 프로젝트 IAM 역할 보기, 비용 보기, Bedrock Claude 호출(AI 도우미 시험). 정책: claude-operator-policy.json
# 할 수 없는 것: 리소스 만들기·바꾸기·지우기(보안 그룹, RDS, IAM 등), DB·S3 데이터 읽기, 다른 서버에 명령.
# 리전은 CloudShell을 연 리전 (서버가 없으면 어느 리전에 있는지 알려 준다). 바꾸려면 AWS_REGION=ap-northeast-2 를 앞에
# 서버 이름 태그가 officemap-app이 아니면: INSTANCE_ID=i-0123... bash deploy/aws/setup-claude-access.sh
set -euo pipefail

export AWS_REGION="${AWS_REGION:-ap-northeast-2}"
export AWS_PAGER=""
cd "$(dirname "${BASH_SOURCE[0]}")"

USER_NAME=claude-officemap
VIEW_ONLY=arn:aws:iam::aws:policy/job-function/ViewOnlyAccess
MODE="${1:-}"

user_exists() { aws iam get-user --user-name "$USER_NAME" > /dev/null 2>&1; }
key_ids() { aws iam list-access-keys --user-name "$USER_NAME" --query 'AccessKeyMetadata[].AccessKeyId' --output text; }

if [[ "$MODE" == "--remove" ]]; then
  if ! user_exists; then
    echo "사용자 $USER_NAME이 없어요. 지울 것이 없어요"
    exit 0
  fi
  for key in $(key_ids); do aws iam delete-access-key --user-name "$USER_NAME" --access-key-id "$key"; done
  aws iam detach-user-policy --user-name "$USER_NAME" --policy-arn "$VIEW_ONLY" 2> /dev/null || true
  aws iam delete-user-policy --user-name "$USER_NAME" --policy-name officemap-operator 2> /dev/null || true
  aws iam delete-user --user-name "$USER_NAME"
  echo "지웠어요: $USER_NAME (키도 모두). Claude 환경 설정의 OFFICEMAP_AWS_* 변수도 지워 주세요"
  exit 0
fi
if [[ -n "$MODE" && "$MODE" != "--new-key" ]]; then
  echo "사용법: bash deploy/aws/setup-claude-access.sh [--new-key | --remove]"
  exit 1
fi

# shellcheck source=find-instance.sh
source ./find-instance.sh

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
find_instance "$@"
echo "계정 $ACCOUNT_ID · 리전 $AWS_REGION · 서버 $INSTANCE_ID"

echo "1) 사용자 $USER_NAME"
if user_exists; then
  echo "   있음"
else
  aws iam create-user --user-name "$USER_NAME" \
    --tags Key=purpose,Value="Claude coding assistant for OfficeMap" > /dev/null
  echo "   만듦"
fi

echo "2) 권한: 보기 전용 + 이 서버에만 명령 + 이미지·역할·비용 보기 + Bedrock"
aws iam attach-user-policy --user-name "$USER_NAME" --policy-arn "$VIEW_ONLY"
POLICY="$(mktemp)"
sed "s/ACCOUNT_ID/$ACCOUNT_ID/g; s/INSTANCE_ID/$INSTANCE_ID/g; s/REGION/$AWS_REGION/g" claude-operator-policy.json > "$POLICY"
aws iam put-user-policy --user-name "$USER_NAME" --policy-name officemap-operator --policy-document "file://$POLICY"

echo "3) 액세스 키"
existing="$(key_ids)"
if [[ -n "$existing" && "$MODE" != "--new-key" ]]; then
  echo "   이미 있어요 ($existing). 키 값은 만들 때 한 번만 보여서 다시 볼 수 없어요."
  echo "   잃어버렸으면: bash deploy/aws/setup-claude-access.sh --new-key"
  exit 0
fi
if [[ "$(wc -w <<< "$existing")" -ge 2 ]]; then
  echo "✘ 키가 이미 2개라 더 만들 수 없어요. 안 쓰는 키를 지우세요: aws iam delete-access-key --user-name $USER_NAME --access-key-id <키 ID>"
  exit 1
fi
read -r KEY_ID SECRET <<< "$(aws iam create-access-key --user-name "$USER_NAME" \
  --query 'AccessKey.[AccessKeyId,SecretAccessKey]' --output text)"

cat << EOF

끝. 아래 4줄을 Claude 환경 설정에 넣으세요 (채팅에 붙여 넣지 마세요):
  claude.ai/code 세션 제목 줄의 클라우드 환경 메뉴 → Edit → 환경 변수 → 저장 → 새 세션부터 적용

OFFICEMAP_AWS_ACCESS_KEY_ID=$KEY_ID
OFFICEMAP_AWS_SECRET_ACCESS_KEY=$SECRET
OFFICEMAP_AWS_REGION=$AWS_REGION
OFFICEMAP_EC2_INSTANCE_ID=$INSTANCE_ID

비밀 키는 지금 한 번만 보여요. 넣고 나면 이 창을 지우세요(clear).
EOF
if [[ -n "$existing" ]]; then
  echo
  echo "새 키가 잘 되는 걸 확인한 뒤 옛 키를 지우세요: aws iam delete-access-key --user-name $USER_NAME --access-key-id $existing"
fi
