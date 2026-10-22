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
    globals.css         디자인 색·글꼴 기준값, 팀 색(data-color), 재실 표시(.mk)
    login/              로그인 화면
    (app)/              로그인해야 보는 화면 (괄호 폴더는 주소에 안 들어감)
      layout.tsx        로그인 확인 + 왼쪽 메뉴 틀
      page.tsx          ① 자리·재실 현황 ( /?floor=층ID )
      OfficeView.tsx    층 버튼, 팀 칩, 확대·축소, 범례, 오른쪽 패널
      FloorPlan.tsx     도면 그리기 (벽·공간·회의실·구역·좌석)
      SeatPanel.tsx     고른 자리 정보 / 층 요약
      AiPanel.tsx       AI 도우미 패널 (틀만)
  components/
    AppShell.tsx        왼쪽 메뉴. 햄버거로 접고 펴며, 상태는 쿠키에 저장
    icons.tsx           선 아이콘
  lib/
    api.ts              FastAPI 응답 타입과 호출 함수
    presence.ts         재실 상태 이름
```

## 왼쪽 메뉴 접기

- 햄버거 버튼으로 접고 펴면 본문 폭이 그만큼 늘고 줄며, 도면도 같이 커지고 작아집니다.
- 고른 상태는 `officemap_sidebar` 쿠키에 남아 새로고침해도 유지됩니다.
- 한 번도 고르지 않았으면 넓은 화면에서는 펼치고, 720px 이하에서는 접습니다.
- 좁은 화면에서 펼치면 본문을 밀지 않고 위에 겹쳐 뜹니다.

## 사내망에서 빌드할 때

글꼴은 `next/font/google`이 **빌드할 때** 받아서 이 서버에서 직접 제공합니다. 화면을 여는 사용자는
Google에 접속하지 않지만, 빌드하는 PC는 인터넷이 필요합니다. 빌드 환경도 망이 막혀 있으면
글꼴 파일을 저장소에 넣고 `next/font/local`로 바꾸세요.
