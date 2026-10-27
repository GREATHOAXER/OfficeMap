import type { Room } from "./api";
import { formatShortDay, kstDate } from "./dates";

export const hhmm = new Intl.DateTimeFormat("ko-KR", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "Asia/Seoul",
});

/** 지금 시각(ms) → 서울 기준 날짜와 그날 0시부터 분. 한국은 서머타임이 없어 +9시간 고정 (서버와 같다) */
export function seoulNow(now: number): { date: string; min: number } {
  const k = new Date(now + 9 * 3_600_000);
  return { date: k.toISOString().slice(0, 10), min: k.getUTCHours() * 60 + k.getUTCMinutes() };
}

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

export type ReservationErrorDetail = { code?: string; dates?: string[]; max?: number; max_days?: number } | undefined;

const maxText = (minutes: number) => (minutes >= 1440 ? `${Math.floor(minutes / 1440)}일` : `${minutes / 60}시간`);

/** 예약 만들기·고치기 API(POST·PUT /api/reservations)의 오류 → 화면에 보여 줄 말 */
export function reservationErrorText(detail: ReservationErrorDetail): string {
  switch (detail?.code) {
    case "CHANGED_ELSEWHERE":
      return "다른 탭이나 창에서 이 예약을 먼저 고쳤어요. 덮어쓰지 않으려고 저장하지 않았어요. 최신 내용을 불러와 다시 고쳐 주세요.";
    case "NOT_EDITABLE":
      return "이 예약은 이미 끝났거나 취소돼서 고칠 수 없어요.";
    case "TIME_TAKEN":
      return detail.dates?.length
        ? `그 시간에 이미 예약이 있어요: ${detail.dates.map(formatShortDay).join(", ")}`
        : "방금 다른 사람이 먼저 예약했어요. 현황표를 다시 확인하세요.";
    case "TOO_LONG":
      return `한 번에 최대 ${maxText(detail.max ?? 10080)}까지 예약할 수 있어요.`;
    case "INVALID_TIME":
      return "예약할 수 없는 시간이에요. 시작·끝 시각은 운영 시간 안에서 30분 단위로, 끝은 시작보다 뒤로 골라 주세요.";
    case "REPEAT_SINGLE_DAY":
      return "여러 날에 걸친 예약은 반복할 수 없어요.";
    case "IN_PAST":
      return "지난 시간은 예약할 수 없어요.";
    case "TITLE_REQUIRED":
      return "회의 제목을 적어 주세요.";
    case "INVALID_REPEAT":
      return "반복 종료일을 확인하세요. 평일 반복은 기간 안에 평일이 있어야 해요.";
    case "REPEAT_TOO_LONG":
      return `반복 예약은 ${detail.max_days ?? 92}일 안에서만 할 수 있어요.`;
    case "UNKNOWN_ATTENDEE":
      return "참석자 중 퇴사·휴직한 사람이 있어요. 다시 골라 주세요.";
    case "NO_ATTENDEES":
      return "참석자가 없어요. 나도 들어가지 않으면 회의에 들어갈 사람을 넣으세요.";
    case "ROOM_NOT_FOUND":
      return "지금은 쓸 수 없는 회의실이에요.";
    default:
      return "예약하지 못했어요. 잠시 후 다시 시도하세요.";
  }
}
