import type { NextConfig } from "next";

const apiUrl = process.env.API_URL ?? "http://localhost:8000";

// 개발 서버(npm run dev)를 localhost가 아닌 주소(ngrok 같은 터널, 사내 PC 이름)로 열 때 그 호스트 이름.
// 개발 서버는 모르는 주소에서 오는 개발용 요청(/_next/…)을 막아서, 화면이 반쯤만 뜨고 버튼이 동작하지 않는다
const devOrigins = (process.env.DEV_ORIGINS ?? "")
  .split(",")
  .map((host) => host.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  allowedDevOrigins: devOrigins,
  // 브라우저는 /api 로만 요청하고, Next.js가 FastAPI 서버로 넘겨준다.
  // 화면과 API가 같은 주소가 되어 로그인 쿠키가 그대로 동작하고 CORS 설정이 필요 없다
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiUrl}/api/:path*` }];
  },
};

export default nextConfig;
