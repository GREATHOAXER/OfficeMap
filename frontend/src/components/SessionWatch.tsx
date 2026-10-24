"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { loginUrl } from "@/lib/loginRedirect";
import styles from "./SessionWatch.module.css";

const WARN_SECONDS = 60; // 자동 로그아웃 이만큼 전에 알려 준다
const AUTH_CHANNEL = "officemap-auth"; // 다른 탭에서 로그아웃하면 이 탭도 바로 로그인 화면으로

/** 다른 탭에 로그아웃을 알린다 (LogoutButton이 부른다) */
export function announceLogout() {
  try {
    const channel = new BroadcastChannel(AUTH_CHANNEL);
    channel.postMessage("logout");
    channel.close();
  } catch {
    // BroadcastChannel이 없는 브라우저: 그 탭은 다음 확인 때 알게 된다
  }
}

/**
 * 열어 둔 화면이 로그인이 끝난 것을 알아채게 한다.
 * - 자동 로그아웃 1분 전에 아래에 알림을 띄우고 "계속 사용"으로 연장할 수 있게 한다
 * - 시간이 다 되었거나, 다른 탭에서 로그아웃했거나, 탭으로 돌아왔을 때 끊겨 있으면 로그인 화면으로 보낸다
 * 남은 시간은 서버에 묻는다 (확인만 하고 사용 시각은 늘리지 않는 API)
 */
export default function SessionWatch({ kind }: { kind: "user" | "admin" }) {
  const router = useRouter();
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const checkRef = useRef<() => void>(() => {});
  const base = kind === "admin" ? "/admin/login" : "/login";

  const goLogin = useCallback(
    (reason: "expired" | "logout") => {
      router.replace(
        reason === "logout"
          ? `${base}?reason=logout`
          : loginUrl(base, window.location.pathname + window.location.search, "expired"),
      );
    },
    [router, base],
  );

  useEffect(() => {
    const statusUrl = kind === "admin" ? "/api/admin/auth/session" : "/api/auth/session";
    let deadline = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let tick: ReturnType<typeof setInterval> | undefined;
    let stopped = false;

    function countdown() {
      clearInterval(tick);
      const update = () => {
        const left = Math.round((deadline - Date.now()) / 1000);
        if (left <= 0) {
          clearInterval(tick);
          void check(); // 서버가 정말 끝났다고 하면 로그인 화면으로
          return;
        }
        setSecondsLeft(left);
      };
      update();
      tick = setInterval(update, 1000);
    }

    async function check() {
      try {
        const res = await fetch(statusUrl, { cache: "no-store" });
        if (stopped) return;
        if (res.status === 401) {
          goLogin("expired");
          return;
        }
        if (!res.ok) return;
        const { idle_left: idleLeft } = (await res.json()) as { idle_left: number };
        deadline = Date.now() + idleLeft * 1000;
        clearTimeout(timer);
        clearInterval(tick);
        const untilWarn = deadline - Date.now() - WARN_SECONDS * 1000;
        if (untilWarn > 0) {
          setSecondsLeft(null);
          // 그사이 이 화면에서 무언가 하면 서버의 남은 시간이 늘어나 있으니, 알림 전에 다시 묻는다
          timer = setTimeout(check, Math.min(untilWarn, 5 * 60_000));
        } else {
          countdown();
        }
      } catch {
        // 네트워크 오류는 넘어가고 다음 확인 때 다시 본다
        timer = setTimeout(check, 60_000);
      }
    }
    checkRef.current = () => void check();

    void check();
    const onVisible = () => document.visibilityState === "visible" && void check();
    document.addEventListener("visibilitychange", onVisible);
    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel(AUTH_CHANNEL);
      channel.onmessage = (event) => event.data === "logout" && goLogin("logout");
    } catch {
      channel = null;
    }
    return () => {
      stopped = true;
      clearTimeout(timer);
      clearInterval(tick);
      document.removeEventListener("visibilitychange", onVisible);
      channel?.close();
    };
  }, [kind, goLogin]);

  async function keepAlive() {
    // 사용 시각을 늘리는 API를 한 번 부른다 (내 정보 읽기)
    await fetch(kind === "admin" ? "/api/admin/auth/me" : "/api/auth/me", { cache: "no-store" }).catch(() => null);
    checkRef.current();
  }

  if (secondsLeft === null) return null;
  return (
    <div className={styles.bar} role="alertdialog" aria-live="assertive" aria-label="자동 로그아웃 알림">
      <span>
        {kind === "admin" ? "관리자 화면을" : "화면을"} 한동안 쓰지 않아 <strong className="mono">{secondsLeft}</strong>초 뒤에
        자동으로 로그아웃돼요.
      </span>
      <button type="button" onClick={() => void keepAlive()}>
        계속 사용
      </button>
    </div>
  );
}
