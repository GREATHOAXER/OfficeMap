# OfficeMap API 서버 (FastAPI) 이미지
# 저장소 루트에서 빌드한다 (DB 초기화 스크립트가 db/schema·db/seed를 읽는다):
#   docker build -f server/Dockerfile -t officemap-backend .
# 기본 이미지는 Docker Hub 대신 AWS ECR Public 미러에서 받는다 (EC2에서 Docker Hub 받기 횟수 제한에 걸리지 않게)
FROM public.ecr.aws/docker/library/python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app/server
COPY server/requirements.txt .
RUN pip install -r requirements.txt

COPY db /app/db
COPY server/app ./app
COPY server/scripts ./scripts

RUN useradd --system --uid 10001 officemap
USER officemap

# 이 이미지의 커밋 (배포가 빌드할 때 넣는다). /api/health가 알려 줘서 새 버전이 떴는지 확인한다
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION

EXPOSE 8000
# 프로세스 수는 WEB_CONCURRENCY(기본 1). 실시간 알림과 예약 작업은 프로세스가 여럿이어도 안전하다 (app/realtime.py, app/jobs.py).
# 앞단 프록시(Caddy)가 넣어 준 접속자 IP를 믿는다. 이 포트는 컨테이너 밖에 열지 않는다 (deploy/compose.yml)
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
