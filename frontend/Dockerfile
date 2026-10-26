# OfficeMap 화면 (Next.js) 이미지
#   docker build -t officemap-frontend frontend
# 실행에 필요한 파일만 모은 standalone 빌드라 node_modules 전체를 싣지 않는다
FROM public.ecr.aws/docker/library/node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM public.ecr.aws/docker/library/node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# next.config는 빌드할 때 굳는다. API_URL은 /api 넘기기(rewrites)가 가리키는 API 서버 주소 (compose의 서비스 이름)
ARG API_URL=http://backend:8000
ENV API_URL=$API_URL \
    NEXT_OUTPUT=standalone \
    NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM public.ecr.aws/docker/library/node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
RUN chown node:node /app
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
USER node
EXPOSE 3000
# 서버 화면이 API를 부를 주소(API_URL)는 실행할 때 환경변수로 준다 (deploy/compose.yml)
CMD ["node", "server.js"]
