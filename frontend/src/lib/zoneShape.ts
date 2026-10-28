// 팀 구역 모양. 서버(db/schema/03_space.sql 의 zone_auto_shape)와 같은 방법으로 좌석을 감싸는 사각형을 만든다.
// 배치 화면에서 좌석을 다른 구역으로 옮길 때 반영 전에 바뀔 모양을 미리 그리는 데 쓴다

import type { Rect, ZoneShape } from "./api";
import { seatRatio } from "./planGeometry";

// 여백 (m). 도면 크기로 나눠 비율로 쓴다. 위쪽 여백은 구역 이름표 자리
const NEAR_X = 2.5; // 좌석 사이가 이보다 가까우면 한 덩어리
const NEAR_Y = 1.5;
const PAD_X = 0.5;
const PAD_TOP = 1.5;
const PAD_BOTTOM = 0.9;

/** 저장된 모양 → 사각형 목록 (없으면 빈 목록) */
export function zoneRects(shape: ZoneShape | null | undefined): Rect[] {
  if (!shape) return [];
  if (shape.type === "rects") return shape.rects;
  return [{ x: shape.x, y: shape.y, w: shape.w, h: shape.h }];
}

type SeatPoint = { x: number; y: number; w?: number | null; h?: number | null };

/** 좌석 중심점들 → 덩어리마다 감싸는 사각형 (위에서 아래, 왼쪽에서 오른쪽 순). 크기는 도면 크기(m).
 * 좌석 크기(w·h)가 없으면 기본 책상 */
export function autoRects(seats: SeatPoint[], size: { width_m: number; height_m: number }): Rect[] {
  const base = seatRatio(size.width_m, size.height_m);
  const points = seats.map((p) => ({ x: p.x, y: p.y, w: p.w ?? base.w, h: p.h ?? base.h }));
  const [nearX, nearY] = [NEAR_X / size.width_m, NEAR_Y / size.height_m];
  const [padX, padTop, padBottom] = [PAD_X / size.width_m, PAD_TOP / size.height_m, PAD_BOTTOM / size.height_m];
  const n = points.length;
  const label = points.map((_, i) => i);
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (
          label[i] !== label[j] &&
          Math.abs(points[i].x - points[j].x) <= (points[i].w + points[j].w) / 2 + nearX &&
          Math.abs(points[i].y - points[j].y) <= (points[i].h + points[j].h) / 2 + nearY
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
    b.x0 = Math.min(b.x0, p.x - p.w / 2 - padX);
    b.y0 = Math.min(b.y0, p.y - p.h / 2 - padTop);
    b.x1 = Math.max(b.x1, p.x + p.w / 2 + padX);
    b.y1 = Math.max(b.y1, p.y + p.h / 2 + padBottom);
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

export type ZonePiece<Z> = { zone: Z; rect: Rect };

/**
 * 구역들을 그릴 조각으로 편다. 큰 조각을 먼저 그려서, 다른 구역 안에 들어간 작은 조각(옮겨 온 좌석 한두 개)이
 * 가려지지 않게 한다
 */
export function zonePieces<Z extends { id: number }>(zones: Z[], rectsOf: (zone: Z) => Rect[]): ZonePiece<Z>[] {
  const pieces: ZonePiece<Z>[] = [];
  for (const zone of zones) for (const rect of rectsOf(zone)) pieces.push({ zone, rect });
  return pieces.sort((a, b) => b.rect.w * b.rect.h - a.rect.w * a.rect.h);
}

export type ZoneTag<Z> = { zone: Z; x: number; y: number; maxW: number };

/**
 * 구역 이름표 자리 (도면 대비 비율). 조각마다 왼쪽 위 안쪽, 위쪽 여백(이름표 자리)에 붙인다:
 * 옮겨 온 좌석 한두 개의 작은 조각도 어느 팀인지 보이게. 그 자리에 다른 구역의 더 작은 조각이 들어와 있으면
 * 그 조각 오른쪽으로 비켜서, 남의 조각 위에 이름이 얹히지 않게 한다.
 * maxW: 조각 오른쪽 끝까지 남은 폭 (이름이 길면 이 안에서 줄을 바꾼다. 조각 밖으로 나가지 않게)
 */
export function zoneTags<Z extends { id: number }>(
  pieces: ZonePiece<Z>[],
  size: { width_m: number; height_m: number },
): ZoneTag<Z>[] {
  const strip = PAD_TOP / size.height_m; // 이름표가 차지하는 높이 (위쪽 여백)
  const minW = PAD_TOP / size.width_m; // 이름표가 들어갈 최소 폭
  return pieces.map(({ zone, rect }, i) => {
    const right = rect.x + rect.w;
    let x = rect.x;
    for (let moved = true; moved; ) {
      moved = false;
      for (const other of pieces.slice(i + 1)) {
        const o = other.rect;
        if (
          other.zone.id !== zone.id &&
          o.x < x + minW &&
          o.x + o.w > x &&
          o.y < rect.y + strip &&
          o.y + o.h > rect.y
        ) {
          x = o.x + o.w;
          moved = true;
        }
      }
    }
    if (x + minW > right) x = rect.x; // 비킬 자리가 없으면 원래 자리
    return { zone, x, y: rect.y, maxW: right - x };
  });
}
