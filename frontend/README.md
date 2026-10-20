# OfficeMap 화면 (Next.js)

```bash
npm install
cp .env.example .env.local   # Windows: copy .env.example .env.local
npm run dev                  # http://localhost:3000
```

API 서버(`server/`, uvicorn)가 `http://localhost:8000`에서 떠 있어야 로그인이 됩니다.
브라우저는 `/api/...`로만 요청하고, Next.js가 `API_URL`로 넘겨줍니다(`next.config.ts`).

| 명령 | 하는 일 |
|---|---|
| `npm run dev` | 개발 서버 (코드 바꾸면 바로 반영) |
| `npm run build` / `npm start` | 운영용 빌드와 실행 |
| `npm run lint` | ESLint |
| `npm run typecheck` | TypeScript 검사 |

## 구조

```
src/
  app/
    layout.tsx          공통 글꼴(IBM Plex Sans KR)·색
    globals.css         디자인 색·글꼴 기준값
    page.tsx            로그인 뒤 첫 화면 (자리·재실 현황이 들어올 자리)
    login/
      page.tsx          로그인 화면 (서버에서 공지·문의처를 읽어 옴)
      LoginForm.tsx     사번 로그인 폼 (오류, 잠금, 사번 기억하기)
      FloorIllustration.tsx  왼쪽 장식용 평면도 그림
  lib/api.ts            서버 컴포넌트에서 FastAPI 부르는 함수
```

## 사내망에서 빌드할 때

글꼴은 `next/font/google`이 **빌드할 때** 받아서 이 서버에서 직접 제공합니다. 화면을 여는 사용자는
Google에 접속하지 않지만, 빌드하는 PC는 인터넷이 필요합니다. 빌드 환경도 망이 막혀 있으면
글꼴 파일을 저장소에 넣고 `next/font/local`로 바꾸세요.
