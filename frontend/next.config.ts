import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

const apiUrl = process.env.API_URL ?? "http://localhost:8000";

/** "https://abc.ngrok-free.dev/"처럼 주소째 넣어도 호스트 이름만 쓴다 ("*.example.com" 같은 패턴도 그대로) */
function hostOf(entry: string): string | null {
  const text = entry.trim();
  if (!text) return null;
  try {
    return new URL(text.includes("://") ? text : `http://${text}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** 이 PC에서 돌고 있는 ngrok의 공개 주소 (ngrok 관리 화면 API). ngrok이 꺼져 있으면 빈 목록 */
async function ngrokHosts(): Promise<string[]> {
  try {
    const res = await fetch("http://127.0.0.1:4040/api/tunnels", { signal: AbortSignal.timeout(1000) });
    const body = (await res.json()) as { tunnels?: { public_url?: string }[] };
    return (body.tunnels ?? []).flatMap((t) => hostOf(t.public_url ?? "") ?? []);
  } catch {
    return [];
  }
}

/** 개발 서버(npm run dev)를 localhost가 아닌 주소(ngrok 같은 터널, 사내 PC 이름·IP)로 열 때 허용할 호스트 이름.
 *  개발 서버는 모르는 주소에서 오는 개발용 연결(/_next/…)을 막는데, 막히면 화면 스크립트가 돌지 않아 버튼이 동작하지 않는다.
 *  .env.local의 DEV_ORIGINS(쉼표로 여러 개)와, 개발 서버를 켤 때 이미 돌고 있는 ngrok 주소를 허용한다 */
async function devOrigins(): Promise<string[]> {
  const listed = (process.env.DEV_ORIGINS ?? "").split(",").flatMap((entry) => hostOf(entry) ?? []);
  const hosts = [...new Set([...listed, ...(await ngrokHosts())])];
  console.log(
    hosts.length
      ? `  - 개발 서버 외부 주소 허용: ${hosts.join(", ")}`
      : "  - 개발 서버 외부 주소 허용: 없음 (localhost만. ngrok을 먼저 켜고 다시 켜거나 .env.local의 DEV_ORIGINS)",
  );
  return hosts;
}

export default async function config(phase: string): Promise<NextConfig> {
  return {
    allowedDevOrigins: phase === PHASE_DEVELOPMENT_SERVER ? await devOrigins() : [],
    // 브라우저는 /api 로만 요청하고, Next.js가 FastAPI 서버로 넘겨준다.
    // 화면과 API가 같은 주소가 되어 로그인 쿠키가 그대로 동작하고 CORS 설정이 필요 없다
    async rewrites() {
      return [{ source: "/api/:path*", destination: `${apiUrl}/api/:path*` }];
    },
  };
}
