import type { Room } from "./api";
import { formatShortDay, kstDate } from "./dates";

export const hhmm = new Intl.DateTimeFormat("ko-KR", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "Asia/Seoul",
});

/** 시각(ISO) → "13:30", 오늘이 아니면 "10-28 13:30" */
function timeOrDate(timestamp: string): string {
  const time = hhmm.format(new Date(timestamp));
  const day = kstDate(timestamp);
  return day === kstDate(new Date().toISOString()) ? time : `${day.slice(5)} ${time}`;
}

/** 회의실 지금 상태 문구. 사용 중이면 끝나는 시각(여러 날 예약이면 날짜까지), 비어 있으면 오늘 다음 예약까지 */
export function roomStatusText(room: Room): string {
  if (room.busy_until) return `● 사용 중 ~${timeOrDate(room.busy_until)}`;
  if (room.next_start) return `○ 비어 있음 · ${hhmm.format(new Date(room.next_start))}까지`;
  return "○ 비어 있음";
}

/** 예약 기간 문구. 하루 안이면 "10-26 (월) 10:00–11:00", 여러 날이면 "10-26 (월) 10:00 – 10-28 (수) 11:00" */
export function rangeText(startsAt: string, endsAt: string): string {
  const startDay = kstDate(startsAt);
  const endDay = kstDate(endsAt);
  const start = hhmm.format(new Date(startsAt));
  const end = hhmm.format(new Date(endsAt));
  return startDay === endDay
    ? `${formatShortDay(startDay)} ${start}–${end}`
    : `${formatShortDay(startDay)} ${start} – ${formatShortDay(endDay)} ${end}`;
}

/** 여러 날에 걸친 예약이면 며칠짜리인지 (하루 안이면 null) */
export function spanDays(startsAt: string, endsAt: string): number | null {
  const startDay = kstDate(startsAt);
  const endDay = kstDate(endsAt);
  if (startDay === endDay) return null;
  const at = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
  return Math.round((at(endDay) - at(startDay)) / 86_400_000) + 1;
}
