// 편집 화면(도면 편집·좌석 배치)의 단 수를 화면 폭으로 정한다.
// 단 수가 바뀌면 페이지 높이가 바뀌어 세로 스크롤 막대(약 15px)가 생겼다 없어진다. 경계 근처 폭에서는 그 차이로 단 수가
// 끝없이 오가며 화면이 깜빡였다(1024px 도면 편집). 단을 늘릴 때만 여유(SLACK_PX)를 넘어야 늘린다

const SLACK_PX = 24;

export type Columns = 1 | 2 | 3;

export function columnsFor(width: number, prev: Columns, threePx: number, twoPx: number): Columns {
  const plain: Columns = width >= threePx ? 3 : width >= twoPx ? 2 : 1;
  if (plain <= prev) return plain; // 줄이거나 그대로면 바로
  const grown: Columns = width >= threePx + SLACK_PX ? 3 : width >= twoPx + SLACK_PX ? 2 : 1;
  return Math.max(prev, grown) as Columns;
}
