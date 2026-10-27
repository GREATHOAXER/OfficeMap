#!/usr/bin/env bash
# 배포 방식 pull: 서버가 main의 새 버전을 스스로 가져가 띄운다 (.github/workflows/deploy.yml이 이미지를 ghcr.io에 올린다).
# systemd 타이머(officemap-deploy.timer)가 2분마다 부른다. 설치: bash deploy/install-pull-deploy.sh
#
#   1. main의 최근 커밋 중 이미지(API 서버·화면)가 다 올라온 가장 새 커밋을 찾는다 (빌드 중인 커밋은 건너뛴다)
#   2. 지금 떠 있는 버전(deploy/.env의 IMAGE_TAG)과 다르면 저장소를 그 커밋으로 맞추고 deploy/remote-deploy.sh로 바꿔 띄운다
#   3. 새 버전이 정상으로 뜨지 않으면 remote-deploy.sh가 직전 버전으로 되돌린다. 그 커밋은 deploy/.deploy-failed에 적어
#      다시 시도하지 않는다 (2분마다 내렸다 올렸다 하지 않게). 더 새 커밋이 오면 다시 해 본다
#
# 손으로 한 번 돌리기: bash deploy/pull-deploy.sh      로그: journalctl -u officemap-deploy -e
# 새 버전이 없으면 아무것도 찍지 않는다 (2분마다 로그가 쌓이지 않게)
set -euo pipefail

LOOKBACK=10 # main에서 거슬러 볼 커밋 수

env_value() {
  sed -n "s/^$1=//p" deploy/.env | tail -n 1 | tr -d "\r\"'"
}

# 그 커밋의 이미지 두 개가 저장소에 다 있나 (받지는 않고 목록만 본다)
images_ready() {
  local svc flags=()
  [[ "$PREFIX" == localhost:* || "$PREFIX" == 127.0.0.1:* ]] && flags=(--insecure) # http로 여는 사내 저장소
  for svc in backend frontend; do
    local out
    if ! out="$(docker manifest inspect "${flags[@]}" "${PREFIX}officemap-$svc:$1" 2>&1 > /dev/null)"; then
      if grep -qiE 'unauthorized|denied' <<< "$out"; then
        echo "✘ ${PREFIX}officemap-$svc 이미지를 볼 권한이 없어요. GitHub 패키지를 공개(Public)로 바꾸세요 (docs/cicd.md)" >&2
      fi
      return 1
    fi
  done
}

main() {
  cd "$(dirname "${BASH_SOURCE[0]}")/.."
  [[ -f deploy/.env ]] || {
    echo "✘ deploy/.env가 없어요"
    exit 1
  }
  PREFIX="$(env_value IMAGE_PREFIX)"
  [[ "$PREFIX" == */ ]] || {
    echo "✘ deploy/.env에 IMAGE_PREFIX가 없어요 (예: ghcr.io/greathoaxer/). bash deploy/install-pull-deploy.sh 가 넣어 줘요"
    exit 1
  }
  local current failed target="" sha
  current="$(env_value IMAGE_TAG)"
  failed="$(cat deploy/.deploy-failed 2> /dev/null || true)"

  git fetch --quiet origin main
  for sha in $(git rev-list --first-parent --max-count="$LOOKBACK" origin/main); do
    [[ "$sha" == "$current" ]] && return 0 # 이미지가 다 올라온 것 중 가장 새 버전이 이미 떠 있다
    if images_ready "$sha"; then
      target="$sha"
      break
    fi
  done
  [[ -n "$target" ]] || return 0  # 최근 커밋이 아직 빌드 중
  [[ "$target" == "$failed" ]] && return 0 # 지난번에 정상으로 뜨지 않은 버전: 더 새 커밋을 기다린다

  echo "새 버전 ${target:0:7} 배포 (지금 ${current:0:7})"
  git checkout --quiet --force -B main "$target"
  if bash deploy/remote-deploy.sh "$target"; then
    rm -f deploy/.deploy-failed
  else
    echo "$target" > deploy/.deploy-failed
    echo "✘ ${target:0:7}은 정상으로 뜨지 않아 직전 버전으로 되돌렸어요. 더 새 커밋이 오면 다시 해 봐요"
    exit 1
  fi
}

# 함수 안에 두어 끝까지 읽은 뒤 돈다 (git checkout으로 이 파일이 바뀌어도 안전)
main "$@"
exit
