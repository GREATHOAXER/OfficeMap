import type { Room } from "./api";

export const hhmm = new Intl.DateTimeFormat("ko-KR", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "Asia/Seoul",
});

/** 회의실 지금 상태 문구. 사용 중이면 끝나는 시각, 비어 있으면 오늘 다음 예약까지 */
export function roomStatusText(room: Room): string {
  if (room.busy_until) return `● 사용 중 ~${hhmm.format(new Date(room.busy_until))}`;
  if (room.next_start) return `○ 비어 있음 · ${hhmm.format(new Date(room.next_start))}까지`;
  return "○ 비어 있음";
}
