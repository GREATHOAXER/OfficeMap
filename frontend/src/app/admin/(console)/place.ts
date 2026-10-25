import type { SeatRef } from "@/lib/api";

/** 다른 자리 표시 "7F B-03". 지금 보는 사업장(site)과 다른 사업장의 자리면 사업장 이름을 붙인다
 *  (두 사업장에 같은 이름의 층(1F 등)이 있으면 어느 1F인지 헷갈린다). site를 모르면 늘 붙인다 */
export const placeOf = (seat: SeatRef, site?: string) =>
  `${seat.site && seat.site !== site ? `${seat.site} ` : ""}${seat.floor} ${seat.code}`;
