"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { LogoutIcon } from "./icons";
import { announceLogout } from "./SessionWatch";

type Props = { className?: string; endpoint?: string; redirectTo?: string };

/** 로그아웃. 누른 쪽(직원 화면 또는 관리자 페이지) 로그인만 끝난다. 같은 브라우저의 다른 쪽 로그인은 그대로 */
export default function LogoutButton({ className, endpoint = "/api/auth/logout", redirectTo = "/login" }: Props) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function logout() {
    setPending(true);
    try {
      await fetch(endpoint, { method: "POST" });
      announceLogout(endpoint.startsWith("/api/admin/") ? "admin" : "user"); // 같은 쪽의 다른 탭도 로그인 화면으로
    } finally {
      router.replace(redirectTo);
      router.refresh();
    }
  }

  return (
    <button type="button" className={className} onClick={logout} disabled={pending}>
      <LogoutIcon size={18} />
      {pending ? "로그아웃 중…" : "로그아웃"}
    </button>
  );
}
