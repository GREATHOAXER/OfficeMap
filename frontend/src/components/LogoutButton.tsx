"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { LogoutIcon } from "./icons";

type Props = { className?: string; endpoint?: string; redirectTo?: string };

/** 로그아웃. 직원 화면·관리자 페이지 어디서 눌러도 이 브라우저의 두 로그인이 모두 끝난다 (서버가 처리) */
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
