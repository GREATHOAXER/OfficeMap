// 좌석 배치 편집(⑤) 화면의 계산: 서버에서 읽은 지금 배치(base) + 내가 바꾼 것(draft) = 반영하면 될 모습.
// 바꾼 것은 좌석마다 "반영하면 앉을 사람"으로만 기억한다. 끌어다 놓기·교환·해제는 모두 이 값을 바꾸는 일이고,
// 저장할 때는 지금 배치와 다른 좌석만 항목으로 보낸다 (그래서 되돌려 놓으면 항목도 저절로 없어진다)

import type { ChangeSet, SeatMode, SeatRef, SeatingPerson, SeatingSeat } from "./api";
import { shortDate } from "./dates";

/** 좌석 하나의 바뀐 배정. emp: 반영하면 앉을 사람 (null = 비움). expected: 바꾸기 전에 앉아 있던 사람 (충돌 확인) */
export type Override = { emp: string | null; expected: string | null };

export type SeatDraft = {
  overrides: Record<number, Override>;
  modes: Record<number, SeatMode>;
  /** 좌석 → 반영하면 속할 구역 (null = 구역 없음). 지금과 다른 좌석만 */
  zones: Record<number, number | null>;
};

export const EMPTY_DRAFT: SeatDraft = { overrides: {}, modes: {}, zones: {} };

/** 화면에 나오는 사람 (이름·부서, 다른 층 자리) */
export type Person = SeatingPerson & {
  seat?: SeatRef | null; // 다른 층에 자리가 있으면
  locked?: boolean; // 날짜를 정해 둔 변경이 있어 그날까지 못 옮긴다
  lockText?: string;
  note?: string; // 미배치 칸의 짧은 설명 (신규 입사, 자리 해제 10-20 …)
};

export const MODE_LABEL: Record<SeatMode, string> = {
  FIXED: "고정석",
  FLEX: "팀 내 자율석",
  OUT_OF_SERVICE: "사용 중지",
};

export const baseMode = (seat: SeatingSeat): SeatMode =>
  seat.status === "OUT_OF_SERVICE" ? "OUT_OF_SERVICE" : seat.seat_type;

/** 지금 이 좌석의 고정석 주인 (오늘 자율석을 쓰는 사람은 주인이 아니다) */
export const baseOccupant = (seat: SeatingSeat): string | null =>
  seat.occupant?.kind === "FIXED" ? seat.occupant.emp_no : null;

export type Layout = {
  /** 좌석 → 반영하면 앉을 사람 */
  occupant: (seatId: number) => string | null;
  /** 사람 → 반영하면 앉을 좌석 (이 층) */
  seatOf: (empNo: string) => number | undefined;
  mode: (seat: SeatingSeat) => SeatMode;
  /** 반영하면 속할 구역 */
  zoneOf: (seat: SeatingSeat) => number | null;
};

export function layoutOf(seats: SeatingSeat[], draft: SeatDraft): Layout {
  // 다른 좌석으로 옮기기로 한 사람의 원래 좌석은 비워진다 (반영할 때 서버도 그 사람의 다른 고정석을 끝낸다)
  const moved = new Set<string>();
  for (const o of Object.values(draft.overrides)) if (o.emp) moved.add(o.emp);
  const occ = new Map<number, string | null>();
  const where = new Map<string, number>();
  for (const seat of seats) {
    const base = baseOccupant(seat);
    const o = draft.overrides[seat.id];
    const emp = o ? o.emp : base && moved.has(base) ? null : base;
    occ.set(seat.id, emp);
    if (emp) where.set(emp, seat.id);
  }
  return {
    occupant: (seatId) => occ.get(seatId) ?? null,
    seatOf: (empNo) => where.get(empNo),
    mode: (seat) => draft.modes[seat.id] ?? baseMode(seat),
    zoneOf: (seat) => (seat.id in draft.zones ? draft.zones[seat.id] : seat.zone_id),
  };
}

function withSeat(draft: SeatDraft, seats: SeatingSeat[], seatId: number, emp: string | null): SeatDraft {
  const seat = seats.find((s) => s.id === seatId)!;
  return { ...draft, overrides: { ...draft.overrides, [seatId]: { emp, expected: baseOccupant(seat) } } };
}

/** 지금 배치와 같아진 좌석은 바뀐 것에서 뺀다 */
function normalize(draft: SeatDraft, seats: SeatingSeat[]): SeatDraft {
  const overrides: Record<number, Override> = {};
  const modes: Record<number, SeatMode> = {};
  const zones: Record<number, number | null> = {};
  for (const seat of seats) {
    const o = draft.overrides[seat.id];
    if (o && o.emp !== baseOccupant(seat)) overrides[seat.id] = o;
    const m = draft.modes[seat.id];
    if (m && m !== baseMode(seat)) modes[seat.id] = m;
    if (seat.id in draft.zones && draft.zones[seat.id] !== seat.zone_id) zones[seat.id] = draft.zones[seat.id];
  }
  return { overrides, modes, zones };
}

/** 사람을 좌석에 놓는다. 앉은 사람이 있으면: 그 사람이 내 원래 자리로 (교환), 미배치에서 왔으면 그 사람은 미배치로 */
export function place(draft: SeatDraft, seats: SeatingSeat[], empNo: string, seatId: number): SeatDraft {
  const layout = layoutOf(seats, draft);
  const from = layout.seatOf(empNo);
  if (from === seatId) return draft;
  const there = layout.occupant(seatId);
  let next = withSeat(draft, seats, seatId, empNo);
  if (from !== undefined) next = withSeat(next, seats, from, there);
  return normalize(next, seats);
}

/** 좌석을 비운다 (앉아 있던 사람은 미배치로) */
export function unassign(draft: SeatDraft, seats: SeatingSeat[], seatId: number): SeatDraft {
  return normalize(withSeat(draft, seats, seatId, null), seats);
}

/**
 * 사람을 미배치 칸으로 뺀다. 그 자리가 내가 바꾼 자리이고 원래 앉아 있던 사람이 지금 아무 데도 없으면
 * 원래 사람을 되돌려 놓는다 (끌어다 놓은 것을 다시 빼면 처음으로 돌아가게). restored: 되돌려 놓은 사람
 */
export function toPanel(
  draft: SeatDraft,
  seats: SeatingSeat[],
  empNo: string,
): { draft: SeatDraft; restored: string | null } {
  const layout = layoutOf(seats, draft);
  const seatId = layout.seatOf(empNo);
  if (seatId === undefined) return { draft, restored: null };
  const base = baseOccupant(seats.find((s) => s.id === seatId)!);
  if (draft.overrides[seatId] && base && base !== empNo && layout.seatOf(base) === undefined) {
    const overrides = { ...draft.overrides };
    delete overrides[seatId];
    return { draft: normalize({ ...draft, overrides }, seats), restored: base };
  }
  return { draft: unassign(draft, seats, seatId), restored: null };
}

export function swap(draft: SeatDraft, seats: SeatingSeat[], a: number, b: number): SeatDraft {
  const layout = layoutOf(seats, draft);
  const [ea, eb] = [layout.occupant(a), layout.occupant(b)];
  return normalize(withSeat(withSeat(draft, seats, a, eb), seats, b, ea), seats);
}

/** 좌석 유형. 자율석·사용 중지로 바꾸면 앉아 있던 사람은 미배치로 간다 */
export function setMode(draft: SeatDraft, seats: SeatingSeat[], seatId: number, mode: SeatMode): SeatDraft {
  let next: SeatDraft = { ...draft, modes: { ...draft.modes, [seatId]: mode } };
  if (mode !== "FIXED" && layoutOf(seats, next).occupant(seatId)) next = withSeat(next, seats, seatId, null);
  return normalize(next, seats);
}

/** 좌석들을 구역에 넣는다 (zoneId가 null이면 구역에서 뺀다). 앉아 있는 사람은 그대로 */
export function moveZone(draft: SeatDraft, seats: SeatingSeat[], seatIds: number[], zoneId: number | null): SeatDraft {
  const zones = { ...draft.zones };
  for (const id of seatIds) zones[id] = zoneId;
  return normalize({ ...draft, zones }, seats);
}

/** 서버에 저장된 묶음 → 화면 상태 */
export function draftFromChangeSet(changeSet: ChangeSet | null, seats: SeatingSeat[]): SeatDraft {
  if (!changeSet) return EMPTY_DRAFT;
  const overrides: Record<number, Override> = {};
  for (const a of changeSet.assignments) overrides[a.seat_id] = { emp: a.emp_no, expected: a.expected_emp_no };
  const modes: Record<number, SeatMode> = {};
  for (const t of changeSet.types) modes[t.seat_id] = t.mode;
  const zones: Record<number, number | null> = {};
  for (const z of changeSet.zone_moves) zones[z.seat_id] = z.zone_id;
  return normalize({ overrides, modes, zones }, seats);
}

/** 저장할 항목: 지금 배치와 다른 좌석만 */
export function payloadOf(draft: SeatDraft, seats: SeatingSeat[]) {
  const layout = layoutOf(seats, draft);
  const assignments = seats
    .filter((s) => layout.occupant(s.id) !== baseOccupant(s))
    .map((s) => ({
      seat_id: s.id,
      emp_no: layout.occupant(s.id),
      // 저장해 둔 "바꾸기 전 사람"이 있으면 그대로 (빈 자리였으면 null). 그사이 바뀌었으면 충돌로 보인다
      expected_emp_no: s.id in draft.overrides ? draft.overrides[s.id].expected : baseOccupant(s),
    }));
  const types = Object.entries(draft.modes).map(([seatId, mode]) => ({ seat_id: Number(seatId), mode }));
  const zones = Object.entries(draft.zones).map(([seatId, zoneId]) => ({ seat_id: Number(seatId), zone_id: zoneId }));
  return { assignments, types, zones };
}

export type Change =
  | { kind: "assign"; seatId: number; code: string; emp: string; from: string; prev: string | null }
  | { kind: "clear"; seatId: number; code: string; prev: string | null }
  | { kind: "mode"; seatId: number; code: string; mode: SeatMode }
  | { kind: "zone"; seatId: number; code: string; zoneId: number | null };

/** 변경 내용 목록 (사람이 읽는 순서: 배정 → 비우기 → 유형 → 구역) */
export function changesOf(draft: SeatDraft, seats: SeatingSeat[], people: Map<string, Person>): Change[] {
  const bySeat = new Map(seats.map((s) => [s.id, s]));
  const baseSeatOf = new Map<string, SeatingSeat>();
  for (const s of seats) {
    const b = baseOccupant(s);
    if (b) baseSeatOf.set(b, s);
  }
  const out: Change[] = [];
  for (const { seat_id, emp_no } of payloadOf(draft, seats).assignments) {
    const seat = bySeat.get(seat_id)!;
    const prev = baseOccupant(seat);
    if (emp_no) {
      const other = people.get(emp_no)?.seat;
      const from = baseSeatOf.get(emp_no)?.code ?? (other ? `${other.floor} ${other.code}` : "미배치");
      out.push({ kind: "assign", seatId: seat_id, code: seat.code, emp: emp_no, from, prev });
    } else {
      out.push({ kind: "clear", seatId: seat_id, code: seat.code, prev });
    }
  }
  out.sort((a, b) => (a.kind === b.kind ? a.code.localeCompare(b.code) : a.kind === "assign" ? -1 : 1));
  for (const [seatId, mode] of Object.entries(draft.modes)) {
    const seat = bySeat.get(Number(seatId));
    if (seat) out.push({ kind: "mode", seatId: seat.id, code: seat.code, mode });
  }
  for (const [seatId, zoneId] of Object.entries(draft.zones)) {
    const seat = bySeat.get(Number(seatId));
    if (seat) out.push({ kind: "zone", seatId: seat.id, code: seat.code, zoneId });
  }
  return out;
}

/** 반영하면 멈출 좌석 (화면에서 미리 알려 준다. 서버가 반영할 때 다시 확인한다) */
export function conflictsOf(draft: SeatDraft, seats: SeatingSeat[], people: Map<string, Person>): Map<number, string> {
  const out = new Map<number, string>();
  const nameOf = (emp: string | null) => (emp ? (people.get(emp)?.name ?? emp) : "빈 자리");
  const bySeat = new Map(seats.map((s) => [s.id, s]));
  for (const { seat_id, emp_no, expected_emp_no } of payloadOf(draft, seats).assignments) {
    const seat = bySeat.get(seat_id)!;
    if (seat.upcoming) out.set(seat_id, `${shortDate(seat.upcoming.at)} 변경이 예정돼 있어 그날까지 바꿀 수 없어요`);
    else if (expected_emp_no !== baseOccupant(seat))
      out.set(seat_id, `그사이 다른 관리자가 바꿨어요 (지금: ${nameOf(baseOccupant(seat))})`);
    else if (emp_no && people.get(emp_no)?.locked)
      out.set(seat_id, `${nameOf(emp_no)}: ${people.get(emp_no)?.lockText}`);
  }
  for (const seatId of Object.keys(draft.modes).map(Number)) {
    if (bySeat.get(seatId)?.upcoming && !out.has(seatId)) out.set(seatId, "변경이 예정돼 있어 그날까지 바꿀 수 없어요");
  }
  return out;
}

/** 서버가 돌려준 충돌 사유 → 문구 */
export function conflictText(reason: string, extra: { current?: string | null; name?: string }): string {
  switch (reason) {
    case "CHANGED":
      return `그사이 다른 관리자가 바꿨어요 (지금: ${extra.current ?? "빈 자리"})`;
    case "SCHEDULED":
      return "변경이 예정돼 있어 그날까지 바꿀 수 없어요";
    case "SCHEDULED_PERSON":
      return `${extra.name}: 날짜를 정해 둔 자리 변경이 있어요`;
    case "INACTIVE":
      return `${extra.name}: 재직 중이 아니에요`;
    case "PERSON_OUT_OF_SCOPE":
      return `${extra.name}: 우리 팀원이 아니에요 (부서가 바뀌었을 수 있어요)`;
    case "NOT_FIXED":
      return "고정석이 아니라 배정할 수 없어요";
    case "OCCUPIED":
      return "앉아 있는 사람이 있어 유형을 바꿀 수 없어요";
    case "OUT_OF_SCOPE":
      return "내 구역의 좌석이 아니에요";
    case "SEAT_GONE":
      return "도면에서 빠진 좌석이에요";
    default:
      return "반영할 수 없어요";
  }
}
