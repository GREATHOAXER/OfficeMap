// 서버 컴포넌트에서 FastAPI를 직접 부를 때 쓰는 함수들.
// 브라우저(클라이언트 컴포넌트)에서는 상대 경로 /api/... 를 쓴다 (next.config.ts 참고)

export const API_URL = process.env.API_URL ?? "http://localhost:8000";

export type User = {
  emp_no: string;
  name: string;
  rank: string | null;
  department: string;
  role: "USER" | "ADMIN";
  must_change_password: boolean;
};

export type LoginInfo = {
  notices: { id: number; title: string }[];
  support_contact: string | null;
  idle_minutes: number;
  max_failed_count: number;
};

const DEFAULT_LOGIN_INFO: LoginInfo = {
  notices: [],
  support_contact: null,
  idle_minutes: 30,
  max_failed_count: 5,
};

/** 쿠키로 로그인한 사람을 확인한다. 로그인 안 했거나 API가 꺼져 있으면 null */
export async function fetchMe(cookieHeader: string | null): Promise<User | null> {
  if (!cookieHeader) return null;
  try {
    const res = await fetch(`${API_URL}/api/auth/me`, {
      headers: { cookie: cookieHeader },
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json()).user as User;
  } catch {
    return null;
  }
}

/** 로그인 화면의 공지·문의처. API가 꺼져 있어도 화면은 기본값으로 뜬다 */
export async function fetchLoginInfo(): Promise<LoginInfo> {
  try {
    const res = await fetch(`${API_URL}/api/auth/login-info`, { cache: "no-store" });
    if (!res.ok) return DEFAULT_LOGIN_INFO;
    return { ...DEFAULT_LOGIN_INFO, ...(await res.json()) };
  } catch {
    return DEFAULT_LOGIN_INFO;
  }
}
