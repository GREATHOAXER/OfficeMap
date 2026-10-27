#!/usr/bin/env bash
# 서버에서 새 버전으로 바꿔 띄우기: ECR에서 그 커밋의 이미지를 받아(서버에서 빌드하지 않음) 컨테이너를 바꾼다.
# GitHub Actions의 Deploy(.github/workflows/deploy.yml)가 SSM으로 저장소를 그 커밋에 맞춘 뒤 부른다. 손으로도 된다:
#
#   bash deploy/remote-deploy.sh <커밋 SHA>
#   bash deploy/remote-deploy.sh <커밋 SHA> 12_personnel.sql 09_retention.sql   # 새 DB 스키마 파일도 넣기 (init_db --only)
#
# deploy/.env의 IMAGE_PREFIX(ECR 주소)가 있어야 한다. 새 버전이 정상(healthy)으로 뜨지 않으면 직전 버전으로 되돌리고
# 실패로 끝난다. 성공하면 IMAGE_TAG를 .env에 남겨서, 나중에 손으로 docker compose up을 해도 같은 버전이 뜬다.
# 처음 설정하는 순서: docs/cicd.md
set -euo pipefail

fail() {
  echo "✘ $*"
  exit 1
}

# deploy/.env의 값 (따옴표는 뗀다). 없으면 빈 값
env_value() {
  sed -n "s/^$1=//p" .env | tail -n 1 | tr -d "\r\"'"
}

set_env_value() {
  if grep -q "^$1=" .env; then
    sed -i "s|^$1=.*|$1=$2|" .env
  else
    [[ -z "$(tail -c 1 .env)" ]] || echo >> .env
    echo "$1=$2" >> .env
  fi
}

# 함수 안에 두어 끝까지 읽은 뒤 돈다 (돌던 중에 git checkout으로 이 파일이 바뀌어도 안전)
main() {
  [[ $# -gt 0 ]] || fail "사용법: bash deploy/remote-deploy.sh <커밋 SHA> [db/schema 파일 ...]"
  cd "$(dirname "${BASH_SOURCE[0]}")"
  [[ -f .env ]] || fail "deploy/.env가 없어요 (docs/deploy-aws.md 3)"
  # 이미지 태그는 커밋 SHA 전체(40자). 짧은 SHA·HEAD도 받아서 늘린다
  local tag
  tag="$(git rev-parse --verify --quiet --end-of-options "$1^{commit}")" ||
    fail "이 저장소에 없는 커밋이에요: $1 (git fetch 했는지 확인)"
  shift

  local prefix prev
  prefix="$(env_value IMAGE_PREFIX)"
  prev="$(env_value IMAGE_TAG)"
  [[ "$prefix" == */ ]] ||
    fail "deploy/.env에 IMAGE_PREFIX를 넣으세요 (끝에 /). 예: IMAGE_PREFIX=123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/ (docs/cicd.md)"

  # 지난 배포 뒤로 DB 구조 파일이 바뀌었는데 넣을 파일을 안 줬으면 알린다 (넣을지는 사람이 정한다: 기존 테이블이 바뀐 파일은 --only로 못 넣음)
  if [[ $# -eq 0 && -n "$prev" && "$prev" != "$tag" ]]; then
    local changed
    changed="$(git diff --name-only "$prev" "$tag" -- ../db/schema 2>/dev/null | xargs -r -n 1 basename | xargs)" || true
    [[ -z "$changed" ]] ||
      echo "주의: 지난 배포 뒤로 DB 스키마 파일이 바뀌었어요: $changed — 새 테이블·함수가 있으면 Deploy를 schema_files에 넣어 다시 돌리세요 (docs/cicd.md)"
  fi

  # 이번에 쓸 이미지 태그. 셸 환경변수가 .env보다 앞선다 (성공한 뒤에야 .env에 적는다)
  export IMAGE_TAG="$tag"
  echo "이미지 받기: ${prefix}officemap-backend:$tag, officemap-frontend:$tag"
  docker compose pull --quiet backend frontend || true
  local svc
  for svc in backend frontend; do
    docker image inspect "${prefix}officemap-$svc:$tag" > /dev/null 2>&1 ||
      fail "ECR에서 ${prefix}officemap-$svc:$tag 를 받지 못했어요. 서버의 IAM 역할(AmazonEC2ContainerRegistryReadOnly)과 ~/.docker/config.json의 credHelpers, 그 커밋의 이미지가 ECR에 있는지 확인하세요 (docs/cicd.md)"
  done

  if [[ $# -gt 0 ]]; then
    echo "DB 스키마 넣기: $*"
    docker compose run --rm --no-deps backend python -m scripts.init_db --only "$@" ||
      fail "DB 스키마 파일을 넣지 못해서 멈췄어요 (지금 떠 있는 버전은 그대로). 위 오류를 보세요"
  fi

  echo "새 버전 띄우기"
  if ! docker compose up -d --no-build --wait --wait-timeout 300; then
    docker compose ps -a
    docker compose logs --tail 60 backend frontend
    if [[ -n "$prev" && "$prev" != "$tag" ]] && git cat-file -e "$prev^{commit}" 2> /dev/null; then
      echo "직전 버전($prev)으로 되돌립니다"
      git checkout --quiet --force -B main "$prev"
      IMAGE_TAG="$prev" docker compose up -d --no-build --wait --wait-timeout 300 || echo "✘ 직전 버전도 정상으로 뜨지 않았어요"
    fi
    fail "새 버전($tag)이 정상으로 뜨지 않았어요. 위 로그를 보세요"
  fi
  set_env_value IMAGE_TAG "$tag"

  # 이 앱의 옛 이미지는 지금 것과 직전 것(되돌리기용)만 남긴다
  docker images --format '{{.Repository}}:{{.Tag}}' --filter "reference=${prefix}officemap-*" |
    grep -vE ":(${tag}|${prev:-none}|latest)$" | xargs -r docker rmi > /dev/null || true
  docker image prune -f > /dev/null
  docker compose ps
  echo "배포 끝: $tag"
}

main "$@"
exit
