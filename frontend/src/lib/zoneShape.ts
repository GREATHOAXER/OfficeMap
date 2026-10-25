// 팀 구역 모양. 서버(db/schema/03_space.sql 의 zone_auto_shape)와 같은 방법으로 좌석을 감싸는 사각형을 만든다.
// 배치 화면에서 좌석을 다른 구역으로 옮길 때 반영 전에 바뀔 모양을 미리 그리는 데 쓴다

import type { Rect, ZoneShape } from "./api";

// 좌석 크기(도면 대비 비율)와 여백. 위쪽 여백은 구역 이름표 자리
const SEAT_W = 0.0533;
const SEAT_H = 0.0556;
const NEAR = 0.05; // 좌석 사이가 이보다 가까우면 한 덩어리
const PAD_X = 0.01;
const PAD_TOP = 0.05;
const PAD_BOTTOM = 0.03;

/** 저장된 모양 → 사각형 목록 (없으면 빈 목록) */
export function zoneRects(shape: ZoneShape | null | undefined): Rect[] {
  if (!shape) return [];
  if (shape.type === "rects") return shape.rects;
  return [{ x: shape.x, y: shape.y, w: shape.w, h: shape.h }];
}

/** 좌석 중심점들 → 덩어리마다 감싸는 사각형 (위에서 아래, 왼쪽에서 오른쪽 순) */
export function autoRects(points: { x: number; y: number }[]): Rect[] {
  const n = points.length;
  const label = points.map((_, i) => i);
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (
          label[i] !== label[j] &&
          Math.abs(points[i].x - points[j].x) <= SEAT_W + NEAR &&
          Math.abs(points[i].y - points[j].y) <= SEAT_H + NEAR
        ) {
          const m = Math.min(label[i], label[j]);
          label[i] = m;
          label[j] = m;
          changed = true;
        }
      }
    }
  }
  const boxes = new Map<number, { x0: number; y0: number; x1: number; y1: number }>();
  points.forEach((p, i) => {
    const b = boxes.get(label[i]) ?? { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    b.x0 = Math.min(b.x0, p.x - SEAT_W / 2 - PAD_X);
    b.y0 = Math.min(b.y0, p.y - SEAT_H / 2 - PAD_TOP);
    b.x1 = Math.max(b.x1, p.x + SEAT_W / 2 + PAD_X);
    b.y1 = Math.max(b.y1, p.y + SEAT_H / 2 + PAD_BOTTOM);
    boxes.set(label[i], b);
  });
  return [...boxes.values()]
    .map((b) => {
      const x = Math.max(0, b.x0);
      const y = Math.max(0, b.y0);
      return { x, y, w: Math.min(1, b.x1) - x, h: Math.min(1, b.y1) - y };
    })
    .sort((a, b) => a.y - b.y || a.x - b.x);
}

export type ZonePiece<Z> = { zone: Z; rect: Rect; tagged: boolean };

/**
 * 구역들을 그릴 조각으로 편다. 큰 조각을 먼저 그려서, 다른 구역 안에 들어간 작은 조각(옮겨 온 좌석 한두 개)이
 * 가려지지 않게 한다. 이름표는 구역마다 가장 큰 조각에만 붙인다
 */
export function zonePieces<Z extends { id: number }>(zones: Z[], rectsOf: (zone: Z) => Rect[]): ZonePiece<Z>[] {
  const pieces: ZonePiece<Z>[] = [];
  for (const zone of zones) {
    const rects = rectsOf(zone);
    const biggest = rects.reduce((best, r, i) => (r.w * r.h > rects[best].w * rects[best].h ? i : best), 0);
    rects.forEach((rect, i) => pieces.push({ zone, rect, tagged: i === biggest }));
  }
  return pieces.sort((a, b) => b.rect.w * b.rect.h - a.rect.w * a.rect.h);
}
