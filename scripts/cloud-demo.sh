#!/usr/bin/env bash
# Claude Code 클라우드 세션에서 화면을 띄우고 ngrok으로 임시 공개 주소를 만든다 (데모용)
#
# 미리 환경 설정에 넣어 둘 것:
#   - 환경 변수 NGROK_AUTHTOKEN   (https://dashboard.ngrok.com/get-started/your-authtoken)
#   - 네트워크 허용 도메인 connect.ngrok-agent.com
#
# 실행: bash scripts/cloud-demo.sh
# 끄기: bash scripts/cloud-demo.sh stop
#
# 공개 주소는 링크를 아는 누구나 접속할 수 있다. 목업 데이터만 넣고, 다 보면 끈다.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$ROOT/.demo"  # 로그, pid, ngrok 실행 파일 (git에 올리지 않음)
mkdir -p "$WORK"

stop() {
  for name in ngrok next uvicorn; do
    if [[ -f "$WORK/$name.pid" ]]; then
      kill "$(cat "$WORK/$name.pid")" 2>/dev/null || true
      rm -f "$WORK/$name.pid"
    fi
  done
  echo "데모를 껐습니다."
}

# start_bg <이름> <명령...>: 이미 떠 있으면 그대로 둔다
start_bg() {
  local name=$1
  shift
  if [[ -f "$WORK/$name.pid" ]] && kill -0 "$(cat "$WORK/$name.pid")" 2>/dev/null; then
    return
  fi
  nohup "$@" >"$WORK/$name.log" 2>&1 &
  echo $! >"$WORK/$name.pid"
}

# wait_for <주소> <이름>
wait_for() {
  for _ in $(seq 1 60); do
    curl -fs -o /dev/null "$1" && return 0
    sleep 1
  done
  echo "$2이(가) 뜨지 않았습니다. 로그: $WORK" >&2
  exit 1
}

as_postgres() {
  (cd / && su postgres -c "$1")
}

if [[ "${1:-}" == "stop" ]]; then
  stop
  exit 0
fi

: "${NGROK_AUTHTOKEN:?환경 변수 NGROK_AUTHTOKEN이 없습니다. 환경 설정에 추가한 뒤 새 세션에서 실행하세요.}"

echo "1/5 DB (PostgreSQL 16 + pgvector)"
if [[ ! -f /usr/share/postgresql/16/extension/vector.control ]]; then
  apt-get install -y -qq postgresql-16-pgvector >/dev/null 2>&1 ||
    { apt-get update -qq && apt-get install -y -qq postgresql-16-pgvector >/dev/null; }
fi
pg_lsclusters | grep -q ' online ' || pg_ctlcluster 16 main start
as_postgres "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname = 'officemap'\"" | grep -q 1 ||
  as_postgres "psql -qc \"CREATE ROLE officemap LOGIN PASSWORD 'officemap'\""
as_postgres "psql -tAc \"SELECT 1 FROM pg_database WHERE datname = 'officemap'\"" | grep -q 1 ||
  as_postgres "psql -qc 'CREATE DATABASE officemap OWNER officemap'"
# vector 확장은 관리자만 만들 수 있어서 미리 만든다
as_postgres "psql -q -d officemap -c 'CREATE EXTENSION IF NOT EXISTS btree_gist' -c 'CREATE EXTENSION IF NOT EXISTS vector'"

echo "2/5 API 서버 (uvicorn :8000)"
cd "$ROOT/server"
if [[ ! -x .venv/bin/uvicorn ]]; then
  python3 -m venv .venv
  .venv/bin/pip install -q -r requirements.txt
fi
.venv/bin/python -m scripts.init_db --reset >/dev/null  # 목업 데이터를 처음 상태로
start_bg uvicorn .venv/bin/uvicorn app.main:app --port 8000
wait_for http://127.0.0.1:8000/api/health "API 서버"

echo "3/5 화면 (Next.js :3000)"
cd "$ROOT/frontend"
[[ -d node_modules ]] || npm ci --silent
[[ -f .env.local ]] || cp .env.example .env.local
NEXT_TELEMETRY_DISABLED=1 npm run -s build >"$WORK/build.log" 2>&1
start_bg next env NEXT_TELEMETRY_DISABLED=1 node_modules/.bin/next start -p 3000
wait_for http://127.0.0.1:3000/login "화면"

echo "4/5 ngrok"
NGROK="$WORK/ngrok"
if [[ ! -x "$NGROK" ]]; then
  # 기본 다운로드 주소(bin.equinox.io)는 막혀 있어서 ngrok 공식 apt 저장소에서 받는다
  repo=https://ngrok-agent.s3.amazonaws.com
  deb=$(curl -fsS "$repo/dists/buster/main/binary-amd64/Packages" |
    awk '/^Version:/{v=$2} /^Filename:/{print v, $2}' | sort -V | tail -1 | cut -d' ' -f2)
  curl -fsS "$repo/$deb" -o "$WORK/ngrok.deb"
  dpkg -x "$WORK/ngrok.deb" "$WORK/ngrok-deb"
  cp "$(find "$WORK/ngrok-deb" -name ngrok -type f)" "$NGROK"
fi
# 토큰은 파일에 쓰지 않는다. ngrok이 NGROK_AUTHTOKEN 환경 변수를 직접 읽는다
{
  echo 'version: "2"'
  echo 'update_check: false'
  if [[ -n "${HTTPS_PROXY:-}" ]]; then
    # 이 환경은 외부 연결이 모두 프록시를 거치고, 프록시가 TLS 인증서를 다시 서명한다
    echo "proxy_url: $HTTPS_PROXY"
    echo 'root_cas: host'
  fi
} >"$WORK/ngrok.yml"
start_bg ngrok "$NGROK" http 3000 --config "$WORK/ngrok.yml" --log "$WORK/ngrok.log" --log-format logfmt

echo "5/5 공개 주소 확인"
url=""
for _ in $(seq 1 30); do
  url=$(curl -fs http://127.0.0.1:4040/api/tunnels 2>/dev/null |
    python3 -c 'import json, sys; t = json.load(sys.stdin)["tunnels"]; print(t[0]["public_url"] if t else "")' 2>/dev/null) || true
  [[ -n "$url" ]] && break
  sleep 1
done
if [[ -z "$url" ]]; then
  echo "공개 주소를 만들지 못했습니다. ngrok 로그 마지막 오류:" >&2
  grep -E 'lvl=(eror|crit)' "$WORK/ngrok.log" | tail -2 >&2 || true
  exit 1
fi
echo
echo "공개 주소: $url/login"
echo "목업 계정: 사번 20190005 / 비밀번호 officemap1234"
echo "끄기: bash scripts/cloud-demo.sh stop"
