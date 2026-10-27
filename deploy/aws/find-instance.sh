# setup-cicd.sh·setup-claude-access.sh가 같이 쓴다 (source): 이름 태그가 officemap-app인 EC2를 찾아 INSTANCE_ID를 정한다.
# CloudShell은 콘솔에서 고른 리전을 AWS_REGION으로 넘겨준다. 그 리전에 서버가 없으면 다른 리전을 찾아보고,
# 서버가 있는 리전으로 다시 돌리라고 알려 주며 멈춘다 (엉뚱한 리전에 ECR·사용자를 만들지 않게).

_officemap_instance_in() {
  aws ec2 describe-instances --region "$1" \
    --filters Name=tag:Name,Values=officemap-app Name=instance-state-name,Values=pending,running,stopped \
    --query 'Reservations[0].Instances[0].InstanceId' --output text
}

find_instance() {
  if [[ -z "${INSTANCE_ID:-}" ]]; then
    INSTANCE_ID="$(_officemap_instance_in "$AWS_REGION")"
  fi
  if [[ ! "$INSTANCE_ID" =~ ^i-[0-9a-f]+$ ]]; then
    echo "✘ $AWS_REGION 리전에 이름이 officemap-app인 EC2가 없어요. 다른 리전을 찾아볼게요…"
    local region id
    for region in $(aws ec2 describe-regions --query 'Regions[].RegionName' --output text); do
      [[ "$region" == "$AWS_REGION" ]] && continue
      id="$(_officemap_instance_in "$region" 2> /dev/null || true)"
      if [[ "$id" =~ ^i-[0-9a-f]+$ ]]; then
        echo "  → 서버($id)는 $region 리전에 있어요. 그 리전으로 다시 돌리세요:"
        echo "    AWS_REGION=$region bash $0 $*"
        exit 1
      fi
    done
    echo "  → 어느 리전에도 없어요. EC2 이름 태그(officemap-app)를 확인하거나 INSTANCE_ID=i-... 를 앞에 붙여 돌리세요"
    exit 1
  fi
  if [[ "$AWS_REGION" != "ap-northeast-2" ]]; then
    echo "참고: 서울(ap-northeast-2)이 아닌 $AWS_REGION 리전이에요. 국내에서 쓰면 서울이 빠르고, 실제 데이터는 국내 리전에 두는 것이 보통이에요."
  fi
}
