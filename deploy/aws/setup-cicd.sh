#!/usr/bin/env bash
# GitHub Actions 자동 배포(.github/workflows/deploy.yml)에 필요한 AWS 쪽을 한 번에 만든다. 여러 번 돌려도 된다.
# AWS 콘솔 위쪽의 CloudShell(>_ 아이콘, 리전 서울)에서:
#
#   git clone --depth 1 https://github.com/GREATHOAXER/OfficeMap.git && cd OfficeMap
#   bash deploy/aws/setup-cicd.sh
#
# 만드는 것: ECR 저장소 2개(+ 오래된 이미지 자동 정리), GitHub OIDC 공급자, GitHub용 역할(officemap-github-deploy),
# EC2용 역할(officemap-ec2: SSM으로 명령 받기 + ECR에서 이미지 받기)과 인스턴스 연결.
# 끝에 GitHub 변수와 서버 .env에 넣을 값을 찍는다. 설명: docs/cicd.md
#
# 인스턴스는 이름 태그 officemap-app으로 찾는다. 다르면: INSTANCE_ID=i-0123... bash deploy/aws/setup-cicd.sh
set -euo pipefail

export AWS_REGION="${AWS_REGION:-ap-northeast-2}"
export AWS_PAGER=""
cd "$(dirname "${BASH_SOURCE[0]}")"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
INSTANCE_ID="${INSTANCE_ID:-$(aws ec2 describe-instances \
  --filters Name=tag:Name,Values=officemap-app Name=instance-state-name,Values=pending,running,stopped \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)}"
[[ "$INSTANCE_ID" =~ ^i-[0-9a-f]+$ ]] || {
  echo "✘ $AWS_REGION에서 이름이 officemap-app인 EC2를 찾지 못했어요. INSTANCE_ID=i-... 를 앞에 붙여 다시 돌리세요"
  exit 1
}
echo "계정 $ACCOUNT_ID · 리전 $AWS_REGION · 인스턴스 $INSTANCE_ID"

echo "1) ECR 저장소"
for repo in officemap-backend officemap-frontend; do
  if ! aws ecr describe-repositories --repository-names "$repo" > /dev/null 2>&1; then
    aws ecr create-repository --repository-name "$repo" --image-scanning-configuration scanOnPush=true > /dev/null
    echo "   만듦: $repo"
  else
    echo "   있음: $repo"
  fi
  aws ecr put-lifecycle-policy --repository-name "$repo" --lifecycle-policy-text file://ecr-lifecycle.json > /dev/null
done

echo "2) GitHub OIDC 공급자"
OIDC_ARN="arn:aws:iam::$ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com"
if aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$OIDC_ARN" > /dev/null 2>&1; then
  echo "   있음"
else
  aws iam create-open-id-connect-provider --url https://token.actions.githubusercontent.com \
    --client-id-list sts.amazonaws.com > /dev/null
  echo "   만듦"
fi

echo "3) GitHub Actions용 역할 officemap-github-deploy"
TMP="$(mktemp -d)"
sed "s/ACCOUNT_ID/$ACCOUNT_ID/g" github-oidc-trust.json > "$TMP/trust.json"
sed "s/ACCOUNT_ID/$ACCOUNT_ID/g; s/INSTANCE_ID/$INSTANCE_ID/g; s/ap-northeast-2/$AWS_REGION/g" \
  github-deploy-policy.json > "$TMP/policy.json"
if aws iam get-role --role-name officemap-github-deploy > /dev/null 2>&1; then
  aws iam update-assume-role-policy --role-name officemap-github-deploy --policy-document "file://$TMP/trust.json"
  echo "   있음 (신뢰 정책·권한을 이 저장소의 파일로 맞춤)"
else
  aws iam create-role --role-name officemap-github-deploy --assume-role-policy-document "file://$TMP/trust.json" \
    --description "GitHub Actions deploy for GREATHOAXER/OfficeMap" > /dev/null
  echo "   만듦"
fi
aws iam put-role-policy --role-name officemap-github-deploy --policy-name officemap-deploy \
  --policy-document "file://$TMP/policy.json"

echo "4) EC2 인스턴스 역할 (SSM + ECR 읽기)"
# 인스턴스에 이미 다른 역할이 붙어 있으면 그 역할에 권한만 더한다
CURRENT_PROFILE="$(aws ec2 describe-iam-instance-profile-associations \
  --filters Name=instance-id,Values="$INSTANCE_ID" Name=state,Values=associated \
  --query 'IamInstanceProfileAssociations[0].IamInstanceProfile.Arn' --output text)"
if [[ "$CURRENT_PROFILE" == arn:* ]]; then
  EC2_ROLE="$(aws iam get-instance-profile --instance-profile-name "${CURRENT_PROFILE##*/}" \
    --query 'InstanceProfile.Roles[0].RoleName' --output text)"
  echo "   인스턴스에 붙은 역할 $EC2_ROLE에 권한을 더함"
else
  EC2_ROLE=officemap-ec2
  if ! aws iam get-role --role-name "$EC2_ROLE" > /dev/null 2>&1; then
    aws iam create-role --role-name "$EC2_ROLE" --assume-role-policy-document \
      '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \
      > /dev/null
  fi
  if ! aws iam get-instance-profile --instance-profile-name "$EC2_ROLE" > /dev/null 2>&1; then
    aws iam create-instance-profile --instance-profile-name "$EC2_ROLE" > /dev/null
    aws iam add-role-to-instance-profile --instance-profile-name "$EC2_ROLE" --role-name "$EC2_ROLE"
    sleep 10 # 새 인스턴스 프로파일이 퍼질 때까지
  fi
  aws ec2 associate-iam-instance-profile --instance-id "$INSTANCE_ID" --iam-instance-profile Name="$EC2_ROLE" > /dev/null
  echo "   역할 $EC2_ROLE을 만들어 인스턴스에 붙임"
fi
for policy in AmazonSSMManagedInstanceCore AmazonEC2ContainerRegistryReadOnly; do
  aws iam attach-role-policy --role-name "$EC2_ROLE" --policy-arn "arn:aws:iam::aws:policy/$policy"
done

REGISTRY="$ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com"
cat << EOF

끝. 아래 값을 넣으세요 (docs/cicd.md)

[GitHub] 저장소 Settings → Secrets and variables → Actions → Variables
  AWS_REGION       $AWS_REGION
  AWS_ROLE_ARN     arn:aws:iam::$ACCOUNT_ID:role/officemap-github-deploy
  EC2_INSTANCE_ID  $INSTANCE_ID

[서버] deploy/.env 에 한 줄
  IMAGE_PREFIX=$REGISTRY/

[서버] ECR 로그인 도우미 (~/.docker/config.json)
  {"credHelpers": {"$REGISTRY": "ecr-login"}}
EOF
