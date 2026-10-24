/** 로그인 화면으로 보낼 주소. 보던 화면(next)과 이유(reason)를 붙인다 */
export function loginUrl(base: "/login" | "/admin/login", next: string | null, reason: "expired" | null) {
  const params = new URLSearchParams();
  if (next && next !== "/" && next !== "/admin") params.set("next", next);
  if (reason) params.set("reason", reason);
  const query = params.toString();
  return query ? `${base}?${query}` : base;
}

/** 로그인 후 돌아갈 주소. 다른 사이트로 넘어가지 않게 이 사이트 안의 경로만 받는다 */
export function safeNext(next: string | string[] | undefined, fallback: string) {
  if (typeof next !== "string" || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) {
    return fallback;
  }
  return next;
}

/** 화면을 보다가 로그인이 끊겼을 때(브라우저에서) 보낼 로그인 주소: 지금 화면으로 돌아오게 한다 */
export function expiredLoginUrl() {
  return loginUrl("/login", window.location.pathname + window.location.search, "expired");
}
