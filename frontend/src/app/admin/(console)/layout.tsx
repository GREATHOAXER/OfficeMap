import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import AppShell from "@/components/AppShell";
import { ADMIN_COOKIE, fetchAdmin } from "@/lib/api";
import { loginUrl } from "@/lib/loginRedirect";
import { SIDEBAR_COOKIE } from "@/lib/sidebar";

export const metadata: Metadata = { title: "관리자 · 오피스 안내" };

// 관리자 페이지의 공통 틀. 관리자 쿠키로 로그인한 관리자만 들어온다 (직원 로그인과 따로)
export default async function AdminLayout({ children }: LayoutProps<"/admin">) {
  const headerList = await headers();
  const cookieHeader = headerList.get("cookie");
  const admin = await fetchAdmin(cookieHeader);
  if (!admin) {
    // 관리자 쿠키가 남아 있는데 안 되면: 오래 쓰지 않았거나 권한이 바뀌었다
    const expired = (await cookies()).has(ADMIN_COOKIE);
    redirect(loginUrl("/admin/login", headerList.get("x-pathname"), expired ? "expired" : null));
  }
  // 권한을 받으며 임시 비밀번호를 받았으면 관리자 비밀번호부터 정한다 (그 전에는 다른 관리자 API가 막혀 있다)
  if (admin.must_change_password) {
    const here = headerList.get("x-pathname");
    redirect(here && here !== "/admin" ? `/admin/password?next=${encodeURIComponent(here)}` : "/admin/password");
  }

  const saved = (await cookies()).get(SIDEBAR_COOKIE)?.value;
  const collapsed = saved === "collapsed" ? true : saved === "expanded" ? false : null;

  return (
    <AppShell variant="admin" admin={admin} initialCollapsed={collapsed}>
      {children}
    </AppShell>
  );
}
