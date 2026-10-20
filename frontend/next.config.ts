import type { NextConfig } from "next";

const apiUrl = process.env.API_URL ?? "http://localhost:8000";

const nextConfig: NextConfig = {
  // 브라우저는 /api 로만 요청하고, Next.js가 FastAPI 서버로 넘겨준다.
  // 화면과 API가 같은 주소가 되어 로그인 쿠키가 그대로 동작하고 CORS 설정이 필요 없다
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiUrl}/api/:path*` }];
  },
};

export default nextConfig;
