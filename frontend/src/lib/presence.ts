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
