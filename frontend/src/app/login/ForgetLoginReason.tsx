"use client";

import { useEffect } from "react";

/**
 * 로그인 화면의 "왜 로그인 화면으로 왔는지" 안내(15분 넘게 사용하지 않음 등)는 그때 한 번만 보여 준다.
 * 보여 준 뒤 주소에서 reason을 지워 새로고침하거나 창을 다시 열어도 뜨지 않게 하고, 끊긴 로그인의 쿠키도 지운다
 * (쿠키가 남아 있으면 다음에 들어올 때 다시 "끊김"으로 보고 같은 안내를 띄운다. me는 끊겼을 때만 쿠키를 지운다)
 */
export default function ForgetLoginReason({ me }: { me: "/api/auth/me" | "/api/admin/auth/me" }) {
  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("reason")) return;
    url.searchParams.delete("reason");
    window.history.replaceState(null, "", url);
    void fetch(me, { cache: "no-store" }).catch(() => undefined);
  }, [me]);
  return null;
}
