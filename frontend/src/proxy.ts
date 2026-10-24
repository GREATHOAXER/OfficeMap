import { type NextRequest, NextResponse } from "next/server";

// 서버 레이아웃이 지금 주소를 알 수 있게 요청 헤더에 넣는다.
// 로그인이 끊겨 로그인 화면으로 보낼 때 ?next= 로 붙여서, 로그인 후 보던 화면(층·자리 링크 포함)으로 돌아간다
export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set("x-pathname", request.nextUrl.pathname + request.nextUrl.search);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  // API, 빌드 파일, 이미지에는 필요 없다
  matcher: ["/((?!api|_next/static|_next/image|.*\\.(?:png|jpg|svg|ico)$).*)"],
};
