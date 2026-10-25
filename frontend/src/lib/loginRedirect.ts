/** 로그인이 끊긴 이유. 서버(/api/auth/me의 reason)와 같고, 로그인 화면이 이유에 맞는 안내를 띄운다.
 *  expired: 오래 쓰지 않음 / max: 로그인 유지 시간이 지남 / reset: 관리자가 비밀번호 초기화 /
 *  changed: 다른 곳에서 비밀번호 변경 / locked: 비밀번호를 여러 번 틀려 잠김 / inactive: 휴직·퇴사 / logout: 로그아웃 */
export const LOGOUT_REASONS = ["expired", "max", "reset", "changed", "locked", "inactive", "logout"] as const;
export type LogoutReason = (typeof LOGOUT_REASONS)[number];

/** 서버가 준 이유. 모르는 값이면 "expired" */
export const toLogoutReason = (value: unknown): LogoutReason =>
  LOGOUT_REASONS.includes(value as LogoutReason) ? (value as LogoutReason) : "expired";

/** 로그인 화면으로 보낼 주소. 보던 화면(next)과 이유(reason)를 붙인다 */
export function loginUrl(base: "/login" | "/admin/login", next: string | null, reason: LogoutReason | null) {
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
export function expiredLoginUrl(reason: LogoutReason = "expired") {
  return loginUrl("/login", window.location.pathname + window.location.search, reason);
}

/** 관리자 화면을 보다가 관리자 로그인이 끊겼을 때: 다시 로그인하면 지금 화면(?floor=·?dept= 포함)으로 돌아온다 */
export function adminExpiredUrl() {
  return loginUrl("/admin/login", window.location.pathname + window.location.search, "expired");
}

/** 브라우저에서 로그인이 끊긴 것을 알았을 때: 서버에 왜 끊겼는지 묻고 로그인 화면 주소를 만든다 */
export async function sessionEndUrl() {
  const res = await fetch("/api/auth/me", { cache: "no-store" }).catch(() => null);
  const body = res ? ((await res.json().catch(() => null)) as { reason?: unknown } | null) : null;
  return expiredLoginUrl(toLogoutReason(body?.reason));
}
