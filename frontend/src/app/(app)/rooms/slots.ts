import type { AiProposal } from "@/lib/ai";
import type { EmployeeHit, RoomDay, RoomsDay } from "@/lib/api";
import { addDays, daysBetween, weekdayOf } from "@/lib/dates";
import { seoulNow } from "@/lib/rooms";
import type { SearchWhen } from "@/lib/useEmployeeSearch";

// 예약 현황표의 칸 계산. 시간은 모두 그날 0시부터 분, 칸 하나 = policy.slot분

export type Repeat = "NONE" | "WEEKLY" | "WEEKDAYS";

/**
 * 참석자 한 사람. sameName: 고를 때 같은 이름이 또 있었다 (칩에 직급까지 붙여 구별).
 * via: 팀을 통째로 넣을 때 같이 들어왔으면 그 팀 이름 (칩을 팀별로 묶어 보여 주고 한 번에 뺄 수 있게)
 */
export type Attendee = EmployeeHit & { sameName?: boolean; via?: string };

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
  attendees: Attendee[]; // 참석자 (나 말고). 팀을 넣어도 한 사람씩 들어가서 빼고 싶은 사람만 뺄 수 있다
  /** 예약하는 나도 회의에 들어가나. 비서처럼 예약만 해 주는 사람은 끈다 */
  meAttends: boolean;
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
  meAttends: true,
  repeat: "NONE",
  repeatUntil: null,
  notify: true,
};

/**
 * 화면을 열어 둔 동안에도 시간이 흐르게: 서버가 읽어 온 때의 "오늘·지금"을 브라우저 시계로 바꾼다.
 * 지난 칸·"지금" 선·오늘 단추가 따라 움직이고, 자정이 지나면 보던 날이 지난 날이 된다.
 * now가 0(서버에서 그릴 때·화면이 붙기 전)이면 서버 값 그대로
 */
export function liveDay(day: RoomsDay, now: number): RoomsDay {
  if (!now) return day;
  const { date: today, min } = seoulNow(now);
  const now_min = day.date === today ? min : null;
  const past = day.date < today;
  if (today === day.today && now_min === day.now_min && past === day.past) return day;
  return { ...day, today, now_min, past };
}

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

/**
 * 표에서 끌어서 고른 시간: 처음 누른 칸(from)에서 끈 칸(to)까지. 지난 칸·다른 예약·문 닫는 시각·최대 시간에 막히면
 * 그 앞까지만 (왼쪽으로 끌면 from 칸이 끝 칸이 된다)
 */
export function dragRange(day: RoomsDay, room: RoomDay, from: number, to: number) {
  const { slot, max } = day.policy;
  if (to >= from) return { start: from, end: Math.max(from + slot, Math.min(to + slot, latestEnd(day, room, from))) };
  let start = from;
  while (start - slot >= to && from + slot - (start - slot) <= max && canStartAt(day, room, start - slot))
    start -= slot;
  return { start, end: from + slot };
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

/** 회의에 실제로 들어가는 사람 수 (나도 참석하면 나까지) */
export const headcount = (draft: Draft) => draft.attendees.length + (draft.meAttends ? 1 : 0);

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

/**
 * 고른 회의실이 차 있을 때 권할 빈 회의실 순서: 인원이 들어가는 곳 먼저, 그다음 고른 회의실과 같은 층·가까운 층,
 * 그다음 작은 방 (2명 회의에 200석 대강당을 먼저 권하지 않게)
 */
export function suggestRooms(day: RoomsDay, d: Draft, people: number): RoomDay[] {
  const floorOrder = [...new Set(day.rooms.map((r) => r.floor.id))];
  const chosen = day.rooms.find((r) => r.id === d.roomId);
  const at = chosen ? floorOrder.indexOf(chosen.floor.id) : 0;
  const distance = (r: RoomDay) => Math.abs(floorOrder.indexOf(r.floor.id) - at);
  return freeRoomsFor(day, d).sort(
    (a, b) =>
      Number(b.capacity >= people) - Number(a.capacity >= people) ||
      distance(a) - distance(b) ||
      a.capacity - b.capacity,
  );
}

/** 고치는 예약은 현황에서 빼고 계산한다 (자기 자신과 겹친다고 막지 않게) */
export function withoutBooking(day: RoomsDay, id: number | null): RoomsDay {
  if (id === null) return day;
  return { ...day, rooms: day.rooms.map((r) => ({ ...r, bookings: r.bookings.filter((b) => b.id !== id) })) };
}

/** AI 도우미가 고른 예약 후보 → 예약 폼 내용. base의 반복·알림 설정은 그대로 두고, 제목은 비어 있을 때만 채운다 */
export function draftFromProposal(p: AiProposal, base: Draft = EMPTY_DRAFT): Draft {
  const picked = new Set(base.attendees.map((a) => a.emp_no));
  return {
    ...base,
    roomId: p.room.id,
    start: p.start_min,
    endDays: 0,
    end: p.end_min,
    title: base.title.trim() ? base.title : p.title,
    attendees: [...base.attendees, ...p.attendees.filter((a) => !a.is_me && !picked.has(a.emp_no))],
  };
}
