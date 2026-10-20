import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans_KR } from "next/font/google";
import "./globals.css";

// next/font는 빌드할 때 글꼴 파일을 받아 이 서버에서 직접 제공한다.
// 그래서 사내망에서 화면을 열 때 Google Fonts에 접속하지 않는다 (빌드할 때만 인터넷 필요)
const sans = IBM_Plex_Sans_KR({
  weight: ["400", "600", "700"],
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});
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

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ko" className={`${sans.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
