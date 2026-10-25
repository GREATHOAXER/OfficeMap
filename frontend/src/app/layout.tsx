import type { Metadata } from "next";
import { IBM_Plex_Mono } from "next/font/google";
import { headers } from "next/headers";
import DevHostHint from "@/components/DevHostHint";
import "./globals.css";

// 본문(한글)은 보는 기기의 글꼴을 쓴다 (globals.css --font-body: 맑은 고딕·Apple SD 고딕 Neo 등).
// 한글 웹 글꼴은 글자 묶음 파일이 수백 개라(첫 화면에 1.7MB) 휴대폰·느린 망에서 화면이 늦게 뜬다.
// 숫자용 고정폭 글꼴만 next/font로 둔다: 빌드할 때 받아 이 서버에서 직접 제공해서(라틴 2개, 20KB)
// 사내망에서 화면을 열 때 Google Fonts에 접속하지 않는다 (빌드할 때만 인터넷 필요)
const mono = IBM_Plex_Mono({
  weight: ["400", "600"],
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "오피스 안내",
  description: "층별 좌석과 동료의 재실 상태, 회의실 예약을 한 곳에서",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // 개발 서버에서만: 지금 연 주소가 막혀 화면 스크립트가 안 붙으면 안내를 띄운다 (빌드한 서버에는 없음)
  const devHost = process.env.NODE_ENV === "development" ? await requestHost() : null;
  return (
    <html lang="ko" className={mono.variable}>
      <body>
        {children}
        {devHost && <DevHostHint host={devHost} />}
      </body>
    </html>
  );
}

/** 브라우저 주소창의 호스트 이름 (ngrok 같은 터널을 거치면 x-forwarded-host). localhost는 개발 서버가 막지 않으니 null */
async function requestHost(): Promise<string | null> {
  const h = await headers();
  const host = (h.get("x-forwarded-host") ?? h.get("host") ?? "").split(",")[0].trim().replace(/:\d+$/, "");
  return !host || /(^|\.)localhost$|^127\.0\.0\.1$|^\[::1\]$/.test(host) ? null : host;
}
