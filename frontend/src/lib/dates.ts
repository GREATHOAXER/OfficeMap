// 날짜는 "YYYY-MM-DD" 문자열, 시각은 그날 0시부터 분으로 다룬다 (서버도 서울 기준으로 같은 값을 쓴다).
// 브라우저 시간대와 상관없이 계산되도록 Date는 UTC로만 쓴다

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

export const pad2 = (n: number) => String(n).padStart(2, "0");

/** 810 → "13:30" */
export const minToHHMM = (min: number) => `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`;

export function isoOf(year: number, month: number, day: number): string {
  const d = new Date(Date.UTC(year, month - 1, day));
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

export function partsOf(iso: string): { year: number; month: number; day: number } {
  const [year, month, day] = iso.split("-").map(Number);
  return { year, month, day };
}

export function addDays(iso: string, days: number): string {
  const { year, month, day } = partsOf(iso);
  return isoOf(year, month, day + days);
}

/** 0 = 일요일 */
export function weekdayOf(iso: string): number {
  const { year, month, day } = partsOf(iso);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export const weekdayName = (iso: string) => WEEKDAYS[weekdayOf(iso)];

/** "2026-10-23 (금)" */
export const formatDay = (iso: string) => `${iso} (${weekdayName(iso)})`;

/** "10-23 (금)" */
export const formatShortDay = (iso: string) => `${iso.slice(5)} (${weekdayName(iso)})`;

/** b - a (일). 둘 다 "YYYY-MM-DD" */
export function daysBetween(a: string, b: string): number {
  const at = (iso: string) => {
    const { year, month, day } = partsOf(iso);
    return Date.UTC(year, month - 1, day);
  };
  return Math.round((at(b) - at(a)) / 86_400_000);
}

/** 1500 → "1일 1시간", 90 → "1시간 30분", 30 → "30분" */
export function formatDuration(minutes: number): string {
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  return [days && `${days}일`, hours && `${hours}시간`, mins && `${mins}분`].filter(Boolean).join(" ") || "0분";
}

export const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

const kstDateFormat = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }); // en-CA = YYYY-MM-DD

/** 시각(ISO) → 서울 기준 날짜 "YYYY-MM-DD" */
export const kstDate = (timestamp: string) => kstDateFormat.format(new Date(timestamp));

export const WEEKDAY_NAMES = WEEKDAYS;

/** 얼마 전인지: "방금", "12분 전", "3시간 전", 그보다 오래면 "10-21". now가 0(서버)이면 빈 글자 */
export function agoText(iso: string, now: number): string {
  if (!now) return "";
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "방금";
  if (minutes < 60) return `${minutes}분 전`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}시간 전`;
  return kstDate(iso).slice(5);
}

/** 시각(ISO) → 서울 기준 "11/2(월)" */
export function shortDate(iso: string): string {
  const day = kstDate(iso);
  return `${Number(day.slice(5, 7))}/${Number(day.slice(8))}(${weekdayName(day)})`;
}
