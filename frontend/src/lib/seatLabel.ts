// 도면 좌석(책상)의 이름 글자 크기. 도면 안의 크기는 도면 폭 기준(cqw)이라, 책상 크기에서 글자 크기를 정한다.
// - 층 기본 크기: 그 층의 보통 책상에 "● 가나다"(재실 표시 + 세 글자 이름)가 다 들어가는 크기
// - 이름이 더 길면 그 좌석만 줄인다
// - 화면에 그릴 때는 기본 크기가 READABLE_PX 이상이 되도록 도면 폭을 넓힌다(minPlanWidth). 사람이 많아 책상이
//   작은 층은 도면이 화면보다 커지고 끌어서 옮겨 본다. "전체 보기"로 줄이면 COMPACT_PX 아래에서 이름을 숨긴다

const MARK_EM = 1.25; // 재실 표시 (1em + 여백)
const FILL = 0.86; // 좌석 폭에서 테두리·여백을 뺀 이름 칸
export const READABLE_PX = 8.5; // 100%일 때 이름 글자가 이 크기 이상 (보통 층은 1440px 화면에서 도면이 카드 폭에 들어온다)
export const COMPACT_PX = 6.5; // 이보다 작으면 이름을 숨기고 재실 표시만

/** 글자 폭 (em). 한글·한자는 1, 영문 대문자·숫자는 0.65, 그 밖은 0.55 */
export function textEm(text: string): number {
  let em = 0;
  for (const ch of text) {
    if (/[\u1100-\u11ff\u3130-\u318f\uac00-\ud7a3\u3400-\u9fff]/.test(ch)) em += 1;
    else if (/[A-Z0-9]/.test(ch)) em += 0.65;
    else if (ch === " ") em += 0.3;
    else em += 0.55;
  }
  return em;
}

/** 좌석이 도면에서 차지하는 폭·높이 (cqw = 도면 폭의 %). w·h는 도면 폭·높이 대비 비율 */
export type SeatBox = { w: number; h: number };
export const seatBox = (w: number, h: number, aspect: number): SeatBox => ({ w: w * 100, h: h * 100 * aspect });

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

/** 층 기본 글자 크기 (cqw). typicalEm: 보통 글자 폭 (이름 세 글자 = 3, 도면 편집의 좌석 번호 "A-01" = 2.5) */
export function baseSeatFont(boxes: SeatBox[], typicalEm = 3): number {
  if (boxes.length === 0) return 1.1;
  const long = median(boxes.map((b) => Math.max(b.w, b.h)));
  const short = median(boxes.map((b) => Math.min(b.w, b.h)));
  return Math.min((long * FILL) / (typicalEm + MARK_EM), short * 0.5);
}

/** 이 좌석의 글자 크기 (cqw). 세로 책상은 이름을 세로로 쓰니 긴 쪽에 맞춘다 */
export function seatFont(box: SeatBox, text: string, mark: boolean, base: number): number {
  const long = Math.max(box.w, box.h);
  const short = Math.min(box.w, box.h);
  const fit = (long * FILL) / (textEm(text) + (mark ? MARK_EM : 0) + 0.15);
  return Math.min(base, fit, short * 0.55);
}

/** 기본 글자가 readable(px)이 되는 도면 폭 (px) */
export const minPlanWidth = (base: number, readable = READABLE_PX) => Math.ceil((readable / base) * 100);

/** 이 폭(px)으로 그린 도면에서 이름을 숨길까 */
export const compactAt = (planPx: number, base: number) => (planPx * base) / 100 < COMPACT_PX;
