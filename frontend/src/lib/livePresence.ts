import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { FloorEvent, FloorMap, MyPresence, PresenceEvent } from "./api";
import { openEventStream } from "./eventStream";
import { expiredLoginUrl } from "./loginRedirect";

/** 사번 → 그 사람의 가장 최근 상태 변경 알림 */
export type LiveChanges = ReadonlyMap<string, PresenceEvent>;

const MAX_TIMEOUT_MS = 2 ** 31 - 1; // setTimeout이 받는 최대 지연 (약 24일)

/**
 * 동료들의 재실 상태 변경을 실시간으로 받는다 (/api/presence/stream, SSE).
 * - 받은 변경은 사번별로 모아 돌려준다. 서버에서 읽은 값보다 나중 것만 화면에 덮어쓴다 (withLivePresence)
 * - 끊겼다 다시 붙거나 서버가 resync를 보내면, 그 사이 놓친 변경이 있을 수 있어 화면 데이터를 다시 읽는다
 * - 탭이 안 보이는 동안은 연결을 닫는다 (lib/eventStream.ts: 탭이 많으면 페이지 이동이 멈추는 문제)
 * - 로그아웃·자동 로그아웃으로 연결이 거절되면 로그인 화면으로 보낸다
 * - 같은 연결로 도면·좌석 배치 변경(floor 이벤트)도 온다. onFloor로 받는다
 */
export function useLivePresence(onFloor?: (change: FloorEvent) => void): LiveChanges {
  const router = useRouter();
  const [changes, setChanges] = useState<LiveChanges>(() => new Map());
  const onFloorRef = useRef(onFloor);
  useEffect(() => {
    onFloorRef.current = onFloor;
  });

  useEffect(
    () =>
      openEventStream({
        url: "/api/presence/stream",
        on: {
          presence: (data) => {
            const change = JSON.parse(data) as PresenceEvent;
            setChanges((prev) => new Map(prev).set(change.emp_no, change));
          },
          floor: (data) => onFloorRef.current?.(JSON.parse(data) as FloorEvent),
        },
        onResync: () => router.refresh(),
        // 로그아웃·자동 로그아웃이면 로그인 화면으로, 아니면(서버 재시작 등) 다시 붙는다
        onRejected: async () => {
          const res = await fetch("/api/auth/me").catch(() => null);
          if (res?.status === 401) {
            router.replace(expiredLoginUrl());
            return false;
          }
          return true;
        },
      }),
    [router],
  );

  return changes;
}

/** 서버에서 읽은 층 데이터에, 그보다 나중에 온 상태 변경을 덮어쓴다 */
export function withLivePresence(map: FloorMap, changes: LiveChanges): FloorMap {
  const fetchedAt = Date.parse(map.fetched_at);
  let changed = false;
  const seats = map.seats.map((seat) => {
    const change = seat.occupant && changes.get(seat.occupant.emp_no);
    if (!seat.occupant || !change || Date.parse(change.at) <= fetchedAt) return seat;
    changed = true;
    return { ...seat, occupant: { ...seat.occupant, presence: change.presence } };
  });
  return changed ? { ...map, seats } : map;
}

/** 내 상태도 같은 방식으로 */
export function withLiveMine(mine: MyPresence, change: PresenceEvent | undefined, fetchedAt: string): MyPresence {
  return change && Date.parse(change.at) > Date.parse(fetchedAt) ? change.presence : mine;
}

/** 화면에 보이는 상태 중 가장 먼저 자동 해제되는 시각에 데이터를 다시 읽는다 (해제는 알림이 따로 오지 않는다) */
export function useRefreshAtExpiry(expiries: (string | null | undefined)[]) {
  const router = useRouter();
  const times = expiries.filter((t): t is string => !!t).map((t) => Date.parse(t));
  const next = times.length ? Math.min(...times) : null;

  useEffect(() => {
    if (next === null) return;
    // 서버와 PC 시계가 조금 어긋나도 해제된 뒤에 읽도록 1초 늦게
    const delay = Math.max(0, next - Date.now() + 1000);
    if (delay > MAX_TIMEOUT_MS) return;
    const timer = setTimeout(() => router.refresh(), delay);
    return () => clearTimeout(timer);
  }, [next, router]);
}
