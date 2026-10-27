#!/usr/bin/env bash
# 배포 방식 pull: 서버에 배포 타이머를 설치한다 (한 번). 서버에서 ubuntu 사용자로:
#
#   bash ~/OfficeMap/deploy/install-pull-deploy.sh            # 설치하고 바로 한 번 확인
#   bash ~/OfficeMap/deploy/install-pull-deploy.sh --remove   # 끄기
#
# 하는 일: deploy/.env에 IMAGE_PREFIX(ghcr.io/<저장소 주인>/) 넣기, systemd 서비스·타이머(officemap-deploy) 만들기.
# 그 뒤로는 2분마다 deploy/pull-deploy.sh가 main의 새 버전을 가져가 띄운다. 설명: docs/cicd.md
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_AS="$(id -un)"
UNIT=/etc/systemd/system/officemap-deploy

if [[ "${1:-}" == "--remove" ]]; then
  sudo systemctl disable --now officemap-deploy.timer 2> /dev/null || true
  sudo rm -f "$UNIT.service" "$UNIT.timer"
  sudo systemctl daemon-reload
  echo "배포 타이머를 껐어요. 다시 켜려면: bash $REPO/deploy/install-pull-deploy.sh"
  exit 0
fi
[[ "$RUN_AS" != root ]] || {
  echo "✘ root가 아니라 ubuntu 사용자로 돌리세요 (sudo 없이)"
  exit 1
}
docker info > /dev/null 2>&1 || {
  echo "✘ 이 사용자로 docker를 쓸 수 없어요 (docker 그룹인지 확인: groups)"
  exit 1
}
[[ -f "$REPO/deploy/.env" ]] || {
  echo "✘ $REPO/deploy/.env가 없어요 (docs/deploy-aws.md 3)"
  exit 1
}

# 이미지 주소: ghcr.io/<저장소 주인, 소문자>/
owner="$(git -C "$REPO" remote get-url origin | sed -E 's#.*github\.com[/:]([^/]+)/.*#\1#' | tr '[:upper:]' '[:lower:]')"
prefix="ghcr.io/$owner/"
have="$(sed -n 's/^IMAGE_PREFIX=//p' "$REPO/deploy/.env" | tail -n 1 | tr -d "\r\"'")"
if [[ -z "$have" ]]; then
  [[ -z "$(tail -c 1 "$REPO/deploy/.env")" ]] || echo >> "$REPO/deploy/.env"
  echo "IMAGE_PREFIX=$prefix" >> "$REPO/deploy/.env"
  echo "deploy/.env에 넣음: IMAGE_PREFIX=$prefix"
elif [[ "$have" != "$prefix" ]]; then
  echo "참고: deploy/.env의 IMAGE_PREFIX가 $have 예요 (pull 방식은 보통 $prefix). 맞는지 확인하세요"
fi

sudo tee "$UNIT.service" > /dev/null << EOF
[Unit]
Description=OfficeMap: main의 새 버전을 가져와 띄우기 (deploy/pull-deploy.sh)
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=$RUN_AS
WorkingDirectory=$REPO
ExecStart=/usr/bin/bash $REPO/deploy/pull-deploy.sh
TimeoutStartSec=900
EOF
sudo tee "$UNIT.timer" > /dev/null << EOF
[Unit]
Description=OfficeMap 새 버전 확인 (2분마다)

[Timer]
OnBootSec=2min
OnUnitInactiveSec=2min

[Install]
WantedBy=timers.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now officemap-deploy.timer > /dev/null
echo "배포 타이머를 켰어요 (2분마다). 지금 한 번 확인합니다…"
sudo systemctl start officemap-deploy.service || true
journalctl -u officemap-deploy -n 20 --no-pager || true
cat << EOF

로그 보기:   journalctl -u officemap-deploy -e
지금 확인:   sudo systemctl start officemap-deploy
끄기:        bash $REPO/deploy/install-pull-deploy.sh --remove
EOF
