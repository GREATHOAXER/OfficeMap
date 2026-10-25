"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { addDays, kstDate } from "./dates";

const DAY_MS = 24 * 3600_000;

/**
 * 서버가 그린 상태가 그 시각에 바뀌는 화면(회의실 "사용 중 ~14:00", 오늘 일정)을 열어 둔 채로 두어도 맞게:
 * times 중 지금 이후 가장 이른 시각(없으면 오늘 자정)에 한 번만 서버 데이터를 다시 읽는다 (1분마다 묻지 않는다).
 * 그때 탭이 안 보이면 다시 보일 때 읽는다
 */
export function useRefreshAt(times: (string | null | undefined)[]) {
  const router = useRouter();
  const key = times.filter(Boolean).join("|");
  useEffect(() => {
    const now = Date.now();
    const midnight = Date.parse(`${addDays(kstDate(new Date(now).toISOString()), 1)}T00:00:00+09:00`);
    const next = Math.min(
      midnight,
      ...key
        .split("|")
        .filter(Boolean)
        .map((t) => Date.parse(t))
        .filter((t) => t > now),
    );
    let done = false;
    const fire = () => {
      if (done || document.hidden || Date.now() < next) return;
      done = true;
      router.refresh();
    };
    const timer = setTimeout(fire, Math.min(next - now + 1000, DAY_MS));
    document.addEventListener("visibilitychange", fire);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", fire);
    };
  }, [key, router]);
}
