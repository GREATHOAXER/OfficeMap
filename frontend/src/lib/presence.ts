import type { PresenceStatus } from "./api";

/** 자리에 있음: 재실 · 방해 금지 · 회의 중 · 잠시 자리 비움 */
export const PRESENCE_IN: PresenceStatus[] = ["AVAILABLE", "DO_NOT_DISTURB", "IN_MEETING", "STEPPED_OUT"];
/** 자리에 없음: 외근 · 출장 · 재택 · 교육 · 휴가 · 부재(그 밖) */
export const PRESENCE_OUT: PresenceStatus[] = ["OUTSIDE", "BUSINESS_TRIP", "REMOTE", "TRAINING", "VACATION", "AWAY"];
// 서버(server/app/routers/presence.py)·DB(db/schema/14_presence_statuses.sql)와 같아야 한다
export const PRESENCE_ORDER: PresenceStatus[] = [...PRESENCE_IN, ...PRESENCE_OUT];

export const PRESENCE_LABEL: Record<PresenceStatus, string> = {
  AVAILABLE: "재실",
  DO_NOT_DISTURB: "방해 금지",
  IN_MEETING: "회의 중",
  STEPPED_OUT: "잠시 자리 비움",
  OUTSIDE: "외근",
  BUSINESS_TRIP: "출장",
  REMOTE: "재택",
  TRAINING: "교육",
  VACATION: "휴가",
  AWAY: "부재",
};

export const PRESENCE_HINT: Record<PresenceStatus, string> = {
  AVAILABLE: "자리에 있어요 · 찾아와도 돼요",
  DO_NOT_DISTURB: "메신저로만 연락",
  IN_MEETING: "회의·미팅 중",
  STEPPED_OUT: "식사·잠깐 자리를 비워요",
  OUTSIDE: "사외 업무 · 오늘 복귀",
  BUSINESS_TRIP: "다른 지역·해외 출장",
  REMOTE: "재택 근무 · 메신저 가능",
  TRAINING: "교육·연수",
  VACATION: "연차·반차·휴가",
  AWAY: "그 밖의 이유로 자리에 없어요",
};

/** 상태 메시지 칸의 예시 (고른 상태에 맞춰) */
export const PRESENCE_PLACEHOLDER: Record<PresenceStatus, string> = {
  AVAILABLE: "예: 편하게 자리로 찾아오세요",
  DO_NOT_DISTURB: "예: 15시까지 집중 업무",
  IN_MEETING: "예: 예산 회의 (7F 701)",
  STEPPED_OUT: "예: 점심 식사, 13시 복귀",
  OUTSIDE: "예: 고객사 방문, 16시 복귀",
  BUSINESS_TRIP: "예: 부산 센터 출장, 메신저 가능",
  REMOTE: "예: 오전 재택, 전화 가능",
  TRAINING: "예: 신입 직무 교육 (본사 교육장)",
  VACATION: "예: 여름 휴가, 급한 일은 김OO 과장에게",
  AWAY: "예: 병원 진료, 15시 복귀",
};

/** 며칠 가는 상태: 저장할 때 "그날까지"(마지막 날)를 먼저 권한다 */
export const MULTI_DAY: ReadonlySet<PresenceStatus> = new Set(["BUSINESS_TRIP", "TRAINING", "VACATION"]);

/** 상태 옆에 붙일 메시지. 메시지가 상태 이름과 같으면("회의 중 · 회의 중") 붙이지 않는다 */
export function presenceMessage(presence: { status: PresenceStatus; message: string | null } | null | undefined) {
  const message = presence?.message?.trim();
  return message && message !== PRESENCE_LABEL[presence!.status] ? message : null;
}

const KST = "Asia/Seoul";
const dayFmt = new Intl.DateTimeFormat("ko-KR", { timeZone: KST, month: "numeric", day: "numeric", weekday: "short" });
const timeFmt = new Intl.DateTimeFormat("ko-KR", { timeZone: KST, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const dateKey = new Intl.DateTimeFormat("en-CA", { timeZone: KST, year: "numeric", month: "2-digit", day: "2-digit" });

/** "10/31(금)" */
function dayText(at: Date) {
  const parts = Object.fromEntries(dayFmt.formatToParts(at).map((p) => [p.type, p.value]));
  return `${parts.month}/${parts.day}(${parts.weekday})`;
}

/**
 * 상태가 언제까지인지 (자리 카드·팀 현황). 오늘 안에 풀리면 "18:00까지", 다른 날 0시에 풀리면 그 전날로 "10/31(금)까지"
 * (휴가·출장처럼 마지막 날을 고른 상태), 다른 날 그 밖의 시각이면 "11/3(월) 09:00까지". 해제 시각이 없으면 null
 */
export function presenceUntil(expiresAt: string | null | undefined, now = new Date()): string | null {
  if (!expiresAt) return null;
  const at = new Date(expiresAt);
  const time = timeFmt.format(at);
  if (dateKey.format(at) === dateKey.format(now)) return `${time}까지`;
  if (time === "00:00") {
    const last = new Date(at.getTime() - 60_000);
    return dateKey.format(last) === dateKey.format(now) ? "오늘까지" : `${dayText(last)}까지`;
  }
  return `${dayText(at)} ${time}까지`;
}

/**
 * 상태 이름 옆에 붙일 기간: 자리에 없는 상태(외근·휴가 등)이거나 오늘을 넘기는 상태만 ("휴가 · 10/31(금)까지").
 * 자리에 있는 상태가 오늘 퇴근 시 풀리는 것("재실 · 18:00까지")은 거의 모두라 붙이지 않는다
 */
export function presencePeriod(
  presence: { status: PresenceStatus; expires_at?: string | null } | null | undefined,
  now = new Date(),
): string | null {
  if (!presence?.expires_at) return null;
  const today = dateKey.format(now);
  const lastDay = dateKey.format(new Date(Date.parse(presence.expires_at) - 60_000));
  if (!PRESENCE_OUT.includes(presence.status) && lastDay === today) return null;
  return presenceUntil(presence.expires_at, now);
}

/** 상태를 정하지 않은 사람 (도면 범례·거르기·숫자에 같이 쓴다) */
export const NO_STATUS_LABEL = "상태 없음";

/** 도면에서 거르기: 재실 상태 + 상태를 정하지 않은 사람 */
export type StatusFilter = PresenceStatus | "NONE";
export const STATUS_FILTERS: StatusFilter[] = [...PRESENCE_ORDER, "NONE"];
