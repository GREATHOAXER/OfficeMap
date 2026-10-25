import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FloorEvent, FloorMap, MySeat, Seat } from "@/lib/api";
import { shortDate } from "@/lib/dates";

const REFRESH_DELAY_MS = 400; // 한 번 반영에 알림이 여러 개 오므로 잠깐 모았다가 한 번만 다시 읽는다
const PLAN_COUNTDOWN_S = 5; // 도면 게시 배너를 보여 주고 이만큼 뒤에 새로 읽는다
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

export type FloorNotice = { text: string; href?: string };

/** 자리 배치가 달라진 좌석 수: 고정석 주인·좌석 유형·사용 중지·구역 (오늘 자율석 사용은 세지 않는다) */
function changedSeats(before: Seat[], after: Seat[]): number {
  const owner = (s: Seat | undefined) => (s?.occupant?.kind === "FIXED" ? s.occupant.emp_no : null);
  const prev = new Map(before.map((s) => [s.id, s]));
  let count = 0;
  for (const seat of after) {
    const old = prev.get(seat.id);
    prev.delete(seat.id);
    if (
      !old ||
      owner(old) !== owner(seat) ||
      old.seat_type !== seat.seat_type ||
      old.status !== seat.status ||
      old.zone_id !== seat.zone_id
    ) {
      count += 1;
    }
  }
  return count + prev.size;
}

function mySeatText(info: MySeat): FloorNotice {
  const place = (s: NonNullable<MySeat["seat"]>) => `${s.floor} ${s.code}`;
  if (info.change) {
    return info.change.seat
      ? { text: `${shortDate(info.change.at)}부터 내 자리가 바뀌어요: ${place(info.change.seat)}` }
      : { text: `${shortDate(info.change.at)}부터 내 자리 배정이 끝나요. 자세한 건 팀 관리자에게 문의하세요` };
  }
  if (info.seat) {
    return {
      text: `내 자리가 바뀌었어요: ${place(info.seat)}`,
      href: `/?floor=${info.seat.floor_id}&seat=${info.seat.id}`,
    };
  }
  return { text: "내 자리 배정이 해제됐어요. 자세한 건 팀 관리자에게 문의하세요" };
}

/**
 * 직원 화면의 도면·좌석 배치 실시간 반영.
 * - 보고 있는 층의 배정이 바뀌면 바로 다시 읽고 "7F 자리 배치가 바뀌었어요 (3석)"을 잠깐 띄운다 (확대·선택은 그대로)
 * - 도면이 새로 게시되면 배너를 띄우고 5초 뒤 새로 읽는다
 * - 내 자리가 바뀌면 어느 층을 보고 있든 따로 알린다 (날짜를 정한 변경이면 그 날짜와 함께)
 * - 날짜를 정해 둔 변경은 알림이 따로 오지 않으므로 그 시각(next_change_at)에 다시 읽는다
 */
export function useFloorUpdates(map: FloorMap, myEmpNo: string) {
  const router = useRouter();
  const floorId = map.floor.id;
  const [seatNotice, setSeatNotice] = useState<FloorNotice | null>(null);
  const [mineNotice, setMineNotice] = useState<FloorNotice | null>(null);
  const [plan, setPlan] = useState<{ floorId: number; left: number } | null>(null);
  // 배치 변경 알림을 받아 다시 읽는 중: 새 데이터가 오면 전과 비교해서 몇 석 바뀌었는지 알린다
  const [expecting, setExpecting] = useState(false);
  const [prevMap, setPrevMap] = useState(map);

  if (prevMap !== map) {
    setPrevMap(map);
    if (expecting && prevMap.floor.id === map.floor.id && prevMap.fetched_at !== map.fetched_at) {
      setExpecting(false);
      const count = changedSeats(prevMap.seats, map.seats);
      if (count > 0) setSeatNotice({ text: `${map.floor.name} 자리 배치가 바뀌었어요 (${count}석)` });
    }
  }

  const floorIdRef = useRef(floorId);
  useEffect(() => {
    floorIdRef.current = floorId;
  });
  const refreshTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const mineTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const planTimer = useRef<ReturnType<typeof setInterval>>(undefined);

  const refreshSoon = useCallback(() => {
    setExpecting(true);
    clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => router.refresh(), REFRESH_DELAY_MS);
  }, [router]);

  const showPlanNow = useCallback(() => {
    clearInterval(planTimer.current);
    setPlan(null);
    router.refresh();
  }, [router]);

  const onFloor = useCallback(
    (change: FloorEvent) => {
      if (change.kind === "requests") return; // 관리자 배치 화면 몫
      if (change.emp_no && change.emp_no === myEmpNo) {
        clearTimeout(mineTimer.current);
        mineTimer.current = setTimeout(async () => {
          try {
            const res = await fetch("/api/office/my-seat");
            if (res.ok) setMineNotice(mySeatText((await res.json()) as MySeat));
          } catch {
            // 다음 알림이나 새로고침 때 다시 보인다
          }
        }, REFRESH_DELAY_MS);
      }
      const here = change.floor_id === floorIdRef.current;
      if (change.kind === "plan") {
        if (!here) return;
        clearInterval(planTimer.current);
        const startedAt = Date.now();
        setPlan({ floorId: change.floor_id, left: PLAN_COUNTDOWN_S });
        planTimer.current = setInterval(() => {
          const left = PLAN_COUNTDOWN_S - Math.floor((Date.now() - startedAt) / 1000);
          if (left > 0) setPlan({ floorId: change.floor_id, left });
          else showPlanNow();
        }, 250);
        return;
      }
      // 다른 층이라도 내 자리가 바뀌었으면 층 버튼의 "내 자리" 표시를 맞추려고 다시 읽는다
      if (here || change.emp_no === myEmpNo) refreshSoon();
    },
    [myEmpNo, refreshSoon, showPlanNow],
  );

  // 날짜를 정해 둔 변경·자율석 사용 끝: 그 시각에 다시 읽는다 (서버와 PC 시계가 어긋나도 지난 뒤에 읽게 1초 늦게)
  useEffect(() => {
    if (!map.next_change_at) return;
    const delay = Math.max(0, Date.parse(map.next_change_at) - Date.now() + 1000);
    if (delay > MAX_TIMEOUT_MS) return;
    const timer = setTimeout(() => {
      setExpecting(true);
      router.refresh();
    }, delay);
    return () => clearTimeout(timer);
  }, [map.next_change_at, router]);

  // 안내는 잠깐 보였다가 사라진다 (내 자리 안내는 조금 더 길게)
  useEffect(() => {
    if (!seatNotice) return;
    const timer = setTimeout(() => setSeatNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [seatNotice]);
  useEffect(() => {
    if (!mineNotice) return;
    const timer = setTimeout(() => setMineNotice(null), 15000);
    return () => clearTimeout(timer);
  }, [mineNotice]);

  useEffect(
    () => () => {
      clearTimeout(refreshTimer.current);
      clearTimeout(mineTimer.current);
      clearInterval(planTimer.current);
    },
    [],
  );

  return {
    onFloor,
    seatNotice,
    mineNotice,
    dismissMine: () => setMineNotice(null),
    planCountdown: plan && plan.floorId === floorId ? plan.left : null,
    showPlanNow,
  };
}
