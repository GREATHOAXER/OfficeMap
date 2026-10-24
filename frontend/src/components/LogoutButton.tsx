"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { LogoutIcon } from "./icons";

type Props = { className?: string; endpoint?: string; redirectTo?: string };

/** 로그아웃. 관리자 페이지는 관리자 세션만 끝낸다 (직원 화면 로그인은 그대로) */
export default function LogoutButton({ className, endpoint = "/api/auth/logout", redirectTo = "/login" }: Props) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function logout() {
    setPending(true);
    try {
      await fetch(endpoint, { method: "POST" });
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
