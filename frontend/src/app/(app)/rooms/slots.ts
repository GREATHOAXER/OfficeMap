import type { EmployeeHit, RoomDay, RoomsDay } from "@/lib/api";
import { addDays, daysBetween, weekdayOf } from "@/lib/dates";
import type { SearchWhen } from "@/lib/useEmployeeSearch";

// 예약 현황표의 칸 계산. 시간은 모두 그날 0시부터 분, 칸 하나 = policy.slot분

export type Repeat = "NONE" | "WEEKLY" | "WEEKDAYS";

/** 참석자. sameName: 고를 때 같은 이름이 또 있었다 (칩에 직급까지 붙여 구별) */
export type Attendee = EmployeeHit & { sameName?: boolean };

/** 팀 전체를 한 번에 넣은 참석자 묶음. members에 나는 빠져 있다 */
export type TeamGroup = { id: number; name: string; members: Attendee[] };

/**
 * 작성 중인 예약. 시작 날짜는 화면에서 보고 있는 날(day.date)이고, 끝나는 날은 거기서 endDays일 뒤.
 * 시작 날짜를 바꾸면 끝나는 날도 같이 밀려서 기간이 유지된다.
 */
export type Draft = {
  roomId: number | null;
  start: number | null; // 시작 날의 분
  endDays: number; // 0이면 같은 날에 끝남
  end: number | null; // 끝나는 날의 분
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
  endDays: 0,
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
  return { start, endDays: 0, end: Math.min(start + 60, latestEnd(day, room, start)) };
}

/** 한 번에 잡을 수 있는 최대 일수 (policy.max가 7일이면 끝나는 날은 시작 날 + 7일까지) */
export const maxEndDays = (day: RoomsDay) => Math.floor(day.policy.max / 1440);

/** 예약 길이 (분) */
export const lengthOf = (d: Draft) => (d.start === null || d.end === null ? 0 : d.endDays * 1440 + d.end - d.start);

/**
 * 고를 수 있는 끝 시각.
 * 같은 날: 다음 예약·문 닫는 시각 전까지 (현황표로 빈 시간을 알 수 있다).
 * 다른 날: 그날 운영 시간 안 아무 칸이나 (겹치는지는 서버에 물어서 따로 보여 준다).
 */
export function endOptions(day: RoomsDay, room: RoomDay, d: Draft): number[] {
  if (d.start === null) return [];
  const { slot, open_start, open_end, max } = day.policy;
  const ends: number[] = [];
  if (d.endDays === 0) {
    for (let e = d.start + slot; e <= latestEnd(day, room, d.start); e += slot) ends.push(e);
  } else {
    for (let e = open_start; e <= open_end; e += slot) if (d.endDays * 1440 + e - d.start <= max) ends.push(e);
  }
  return ends;
}

/** 참석자 일정 확인용 기간 */
export function whenOf(day: RoomsDay, d: Draft): SearchWhen | null {
  if (d.start === null || d.end === null) return null;
  return { date: day.date, start_min: d.start, end_date: addDays(day.date, d.endDays), end_min: d.end };
}

/** 실제로 초대할 사람 (한 사람씩 넣은 사람 + 팀 묶음, 겹치면 한 번만) */
export function allAttendees(draft: Draft): Attendee[] {
  const byEmpNo = new Map<string, Attendee>();
  for (const person of [...draft.attendees, ...draft.teams.flatMap((t) => t.members)]) {
    if (!byEmpNo.has(person.emp_no)) byEmpNo.set(person.emp_no, person);
  }
  return [...byEmpNo.values()];
}

/** 반복 예약 회차 수 (서버와 같은 규칙: 매주는 7일 간격, 평일은 토·일 빼고) */
export function occurrenceCount(date: string, repeat: Repeat, until: string | null): number {
  if (repeat === "NONE") return 1;
  if (!until || until < date) return 0;
  const span = daysBetween(date, until);
  let count = 0;
  for (let i = 0; i <= span; i += repeat === "WEEKLY" ? 7 : 1) {
    const weekday = weekdayOf(addDays(date, i));
    if (repeat === "WEEKLY" || (weekday !== 0 && weekday !== 6)) count += 1;
  }
  return count;
}

/** 반복을 처음 켰을 때의 종료일: 4주 뒤 같은 요일(매주), 4주 안의 마지막 평일(평일) */
export function defaultRepeatUntil(date: string, repeat: Repeat): string {
  let until = addDays(date, 28);
  if (repeat === "WEEKDAYS") {
    while (weekdayOf(until) === 0 || weekdayOf(until) === 6) until = addDays(until, -1);
  }
  return until;
}

/** 하루 안의 예약에서 고른 시간이 이 회의실에 비어 있나 (지난 시간·다른 예약과 겹침) */
export function timeIsFree(day: RoomsDay, room: RoomDay, d: Draft): boolean {
  if (d.start === null || d.end === null || d.endDays > 0) return true; // 여러 날은 서버에 따로 묻는다
  return canStartAt(day, room, d.start) && d.end <= latestEnd(day, room, d.start);
}

/** 고른 시간(하루 안)에 비어 있는 다른 회의실 */
export function freeRoomsFor(day: RoomsDay, d: Draft): RoomDay[] {
  if (d.start === null || d.end === null || d.endDays > 0) return [];
  return day.rooms.filter((r) => r.id !== d.roomId && timeIsFree(day, r, d));
}

/** 고치는 예약은 현황에서 빼고 계산한다 (자기 자신과 겹친다고 막지 않게) */
export function withoutBooking(day: RoomsDay, id: number | null): RoomsDay {
  if (id === null) return day;
  return { ...day, rooms: day.rooms.map((r) => ({ ...r, bookings: r.bookings.filter((b) => b.id !== id) })) };
}
