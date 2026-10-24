import type { EmployeeHit, RoomDay, RoomsDay } from "@/lib/api";

// 예약 현황표의 칸 계산. 시간은 모두 그날 0시부터 분, 칸 하나 = policy.slot분

export type Repeat = "NONE" | "WEEKLY" | "WEEKDAYS";

/** 참석자. sameName: 고를 때 같은 이름이 또 있었다 (칩에 직급까지 붙여 구별) */
export type Attendee = EmployeeHit & { sameName?: boolean };

/** 팀 전체를 한 번에 넣은 참석자 묶음. members에 나는 빠져 있다 */
export type TeamGroup = { id: number; name: string; members: Attendee[] };

/** 작성 중인 예약. 날짜는 화면에서 보고 있는 날(day.date)을 쓴다 */
export type Draft = {
  roomId: number | null;
  start: number | null;
  end: number | null;
  title: string;
  attendees: Attendee[]; // 한 사람씩 넣은 참석자
  teams: TeamGroup[];
  repeat: Repeat;
  repeatUntil: string | null;
  notify: boolean;
};

export const EMPTY_DRAFT: Draft = {
  roomId: null,
  start: null,
  end: null,
  title: "",
  attendees: [],
  teams: [],
  repeat: "NONE",
  repeatUntil: null,
  notify: true,
};

export function slotStarts(day: RoomsDay): number[] {
  const { open_start, open_end, slot } = day.policy;
  return Array.from({ length: (open_end - open_start) / slot }, (_, i) => open_start + i * slot);
}

/** 지나간 칸 (지금 진행 중인 칸은 예약할 수 있다) */
export function isPast(day: RoomsDay, start: number): boolean {
  return day.past || (day.now_min !== null && start + day.policy.slot <= day.now_min);
}

export function isFree(room: RoomDay, start: number, end: number): boolean {
  return !room.bookings.some((b) => b.start_min < end && b.end_min > start);
}

/** start에서 시작하면 어디까지 이어서 잡을 수 있나 (다음 예약, 문 닫는 시각, 최대 시간 중 먼저 오는 것) */
export function latestEnd(day: RoomsDay, room: RoomDay, start: number): number {
  const next = room.bookings.filter((b) => b.start_min >= start).map((b) => b.start_min);
  return Math.min(day.policy.open_end, start + day.policy.max, ...next);
}

/** 고를 수 있는 시작 칸 */
export function canStartAt(day: RoomsDay, room: RoomDay, start: number): boolean {
  return !isPast(day, start) && isFree(room, start, start + day.policy.slot);
}

/** 빈 칸을 눌렀을 때 새로 잡는 시간: 기본 1시간, 다음 예약 전까지 */
export function defaultRange(day: RoomsDay, room: RoomDay, start: number) {
  return { start, end: Math.min(start + 60, latestEnd(day, room, start)) };
}

/** 실제로 초대할 사람 (한 사람씩 넣은 사람 + 팀 묶음, 겹치면 한 번만) */
export function allAttendees(draft: Draft): Attendee[] {
  const byEmpNo = new Map<string, Attendee>();
  for (const person of [...draft.attendees, ...draft.teams.flatMap((t) => t.members)]) {
    if (!byEmpNo.has(person.emp_no)) byEmpNo.set(person.emp_no, person);
  }
  return [...byEmpNo.values()];
}
