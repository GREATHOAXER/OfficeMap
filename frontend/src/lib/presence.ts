import type { PresenceStatus } from "./api";

export const PRESENCE_ORDER: PresenceStatus[] = ["AVAILABLE", "DO_NOT_DISTURB", "IN_MEETING", "AWAY"];

export const PRESENCE_LABEL: Record<PresenceStatus, string> = {
  AVAILABLE: "방문 가능",
  DO_NOT_DISTURB: "방해 금지",
  IN_MEETING: "회의 중",
  AWAY: "부재",
};

export const PRESENCE_HINT: Record<PresenceStatus, string> = {
  AVAILABLE: "자리로 찾아와도 돼요",
  DO_NOT_DISTURB: "메신저로만 연락",
  IN_MEETING: "회의·외부 미팅 중",
  AWAY: "휴가·외근·재택",
};

/** 상태 메시지 칸의 예시 (고른 상태에 맞춰) */
export const PRESENCE_PLACEHOLDER: Record<PresenceStatus, string> = {
  AVAILABLE: "예: 편하게 자리로 찾아오세요",
  DO_NOT_DISTURB: "예: 15시까지 집중 업무",
  IN_MEETING: "예: 예산 회의 (7F 701)",
  AWAY: "예: 외근, 14시 복귀",
};

/** 상태를 정하지 않은 사람 (도면 범례·거르기·숫자에 같이 쓴다) */
export const NO_STATUS_LABEL = "상태 없음";

/** 도면에서 거르기: 재실 상태 4가지 + 상태를 정하지 않은 사람 */
export type StatusFilter = PresenceStatus | "NONE";
export const STATUS_FILTERS: StatusFilter[] = [...PRESENCE_ORDER, "NONE"];
