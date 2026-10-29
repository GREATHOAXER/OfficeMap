// 팀 구역 모양. 서버(db/schema/15_zone_shapes.sql 의 zone_floor_shapes)와 같은 방법으로 좌석을 감싸는 사각형을 만든다.
// 배치 화면에서 좌석을 다른 구역으로 옮길 때 반영 전에 바뀔 모양을 미리 그리는 데 쓴다

import type { Rect, ZoneShape } from "./api";
import { seatRatio } from "./planGeometry";

// 여백 (m). 도면 크기로 나눠 비율로 쓴다. 위쪽은 의자 자리까지 조금 넉넉하게
const NEAR_X = 2.5; // 좌석 사이가 이보다 가까우면 한 덩어리
const NEAR_Y = 1.5;
const PAD_X = 0.5;
const PAD_TOP = 1.5;
const PAD_BOTTOM = 0.9;
const GAP = 0.2; // 두 구역이 맞닿는 곳에 남기는 틈 (가운데 선에서 양쪽으로 반씩)
const EPS = 1e-9;
const TOUCH = 1e-6; // m. 이보다 적게 겹치면 맞닿은 것 (소수 오차)

/** 저장된 모양 → 사각형 목록 (없으면 빈 목록) */
export function zoneRects(shape: ZoneShape | null | undefined): Rect[] {
  if (!shape) return [];
  if (shape.type === "rects") return shape.rects;
  return [{ x: shape.x, y: shape.y, w: shape.w, h: shape.h }];
}

/** 구역에 든 좌석 (중심점, 크기가 없으면 기본 책상) */
export type ZoneSeat = { id: number; zoneId: number; x: number; y: number; w?: number | null; h?: number | null };

type Box = { x0: number; y0: number; x1: number; y1: number };
const hits = (a: Box, b: Box) => a.x0 < b.x1 - EPS && b.x0 < a.x1 - EPS && a.y0 < b.y1 - EPS && b.y0 < a.y1 - EPS;
const union = (a: Box, b: Box): Box => ({
  x0: Math.min(a.x0, b.x0),
  y0: Math.min(a.y0, b.y0),
  x1: Math.max(a.x1, b.x1),
  y1: Math.max(a.y1, b.y1),
});

/**
 * 한 층의 구역 모양을 모두 한 번에 계산한다 (구역 id → 사각형들, 위에서 아래·왼쪽에서 오른쪽 순). 크기는 도면 크기(m).
 * 다른 구역을 침범하지 않게:
 *  1) 같은 구역 좌석 중 가까운 것끼리 한 덩어리로 묶되, 묶은 사각형이 다른 구역 좌석에 걸리면 묶지 않는다
 *     (다른 팀 좌석을 사이에 둔 두 좌석은 따로 그린다)
 *  2) 덩어리마다 좌석을 감싸고 여백을 둔다
 *  3) 다른 구역 덩어리와 여백이 겹치면 두 덩어리 사이 가운데에서 나눈다(틈 GAP). 자기 좌석은 끝까지 덮는다.
 *     나누는 방향: 두 덩어리가 위아래로 놓였으면 가로로, 옆으로 놓였으면 세로로 (대각선이면 더 멀리 떨어진 쪽)
 */
export function autoZoneRects(seats: ZoneSeat[], size: { width_m: number; height_m: number }): Map<number, Rect[]> {
  const W = size.width_m;
  const H = size.height_m;
  const base = seatRatio(W, H);
  const list = [...seats]
    .sort((a, b) => a.id - b.id)
    .map((s) => {
      const w = s.w ?? base.w;
      const h = s.h ?? base.h;
      return { zoneId: s.zoneId, x: s.x, y: s.y, w, h, box: { x0: s.x - w / 2, y0: s.y - h / 2, x1: s.x + w / 2, y1: s.y + h / 2 } };
    });
  const n = list.length;

  // 1) 가까운 좌석 쌍을 가까운 순으로 묶는다 (union-find, 덩어리마다 감싸는 사각형)
  const pairs: { i: number; j: number; d: number }[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = list[i];
      const b = list[j];
      if (a.zoneId !== b.zoneId) continue;
      const gx = Math.abs(a.x - b.x) - (a.w + b.w) / 2;
      const gy = Math.abs(a.y - b.y) - (a.h + b.h) / 2;
      if (gx > NEAR_X / W || gy > NEAR_Y / H) continue;
      const d = Math.round((Math.max(0, gx) * W + Math.max(0, gy) * H) * 1000) / 1000; // 틈 (m, 서버와 같게 mm까지)
      pairs.push({ i, j, d });
    }
  }
  pairs.sort((p, q) => p.d - q.d || p.i - q.i || p.j - q.j);
  const parent = list.map((_, i) => i);
  const boxOf = list.map((s) => s.box);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (const { i, j } of pairs) {
    const a = find(i);
    const b = find(j);
    if (a === b) continue;
    const merged = union(boxOf[a], boxOf[b]);
    const zoneId = list[i].zoneId;
    if (list.some((s) => s.zoneId !== zoneId && hits(merged, s.box))) continue;
    const root = Math.min(a, b);
    parent[Math.max(a, b)] = root;
    boxOf[root] = merged;
  }

  // 2) 덩어리마다 여백 (구역 → 위에서 아래, 왼쪽에서 오른쪽 순)
  const pieces = list
    .map((s, i) => ({ zoneId: s.zoneId, root: find(i) }))
    .filter((p, i) => p.root === i)
    .map(({ zoneId, root }) => {
      const core = boxOf[root];
      const rect = {
        x0: Math.max(0, core.x0 - PAD_X / W),
        y0: Math.max(0, core.y0 - PAD_TOP / H),
        x1: Math.min(1, core.x1 + PAD_X / W),
        y1: Math.min(1, core.y1 + PAD_BOTTOM / H),
      };
      return { zoneId, core, rect, lim: { ...rect } };
    })
    .sort((p, q) => p.zoneId - q.zoneId || p.core.y0 - q.core.y0 || p.core.x0 - q.core.x0);

  // 3) 다른 구역과 겹치는 여백을 가운데에서 나눈다 (처음 여백끼리 비교하므로 순서와 상관없이 같은 결과)
  for (let p = 0; p < pieces.length; p++) {
    for (let q = p + 1; q < pieces.length; q++) {
      const a = pieces[p];
      const b = pieces[q];
      if (a.zoneId === b.zoneId || !hits(a.rect, b.rect)) continue;
      const xo = (Math.min(a.core.x1, b.core.x1) - Math.max(a.core.x0, b.core.x0)) * W;
      const yo = (Math.min(a.core.y1, b.core.y1) - Math.max(a.core.y0, b.core.y0)) * H;
      if (xo > TOUCH && yo > TOUCH) continue; // 좌석끼리 겹친다: 나눌 수 없다 (맞닿은 것은 겹친 것이 아니다)
      if (xo > yo) {
        const [top, bottom] = a.core.y0 + a.core.y1 <= b.core.y0 + b.core.y1 ? [a, b] : [b, a];
        const mid = (top.core.y1 + bottom.core.y0) / 2;
        top.lim.y1 = Math.min(top.lim.y1, mid - GAP / 2 / H);
        bottom.lim.y0 = Math.max(bottom.lim.y0, mid + GAP / 2 / H);
      } else {
        const [left, right] = a.core.x0 + a.core.x1 <= b.core.x0 + b.core.x1 ? [a, b] : [b, a];
        const mid = (left.core.x1 + right.core.x0) / 2;
        left.lim.x1 = Math.min(left.lim.x1, mid - GAP / 2 / W);
        right.lim.x0 = Math.max(right.lim.x0, mid + GAP / 2 / W);
      }
    }
  }

  const round = (v: number) => Math.round(v * 10000) / 10000;
  const out = new Map<number, Rect[]>();
  for (const { zoneId, core, lim } of pieces) {
    const x0 = Math.max(0, Math.min(core.x0, lim.x0));
    const y0 = Math.max(0, Math.min(core.y0, lim.y0));
    const x1 = Math.min(1, Math.max(core.x1, lim.x1));
    const y1 = Math.min(1, Math.max(core.y1, lim.y1));
    out.set(zoneId, [
      ...(out.get(zoneId) ?? []),
      { x: round(x0), y: round(y0), w: round(x1 - x0), h: round(y1 - y0) },
    ]);
  }
  for (const rects of out.values()) rects.sort((a, b) => a.y - b.y || a.x - b.x);
  return out;
}

export type ZoneEdge = { dir: "h" | "v"; x: number; y: number; len: number };

/**
 * 한 구역 사각형들의 바깥 테두리 선 (겹치거나 맞닿은 조각을 한 모양으로 그리려고: 조각 사이에 선이 생기지 않게).
 * 가로 선은 (x, y)부터 오른쪽으로 len, 세로 선은 (x, y)부터 아래로 len. 좌표는 사각형과 같은 단위
 */
export function zoneOutline(rects: Rect[]): ZoneEdge[] {
  const k = (v: number) => Math.round(v * 1e6) / 1e6;
  const xs = [...new Set(rects.flatMap((r) => [k(r.x), k(r.x + r.w)]))].sort((a, b) => a - b);
  const ys = [...new Set(rects.flatMap((r) => [k(r.y), k(r.y + r.h)]))].sort((a, b) => a - b);
  const cells = (i: number, j: number) => {
    if (i < 0 || j < 0 || i >= xs.length - 1 || j >= ys.length - 1) return false;
    const cx = (xs[i] + xs[i + 1]) / 2;
    const cy = (ys[j] + ys[j + 1]) / 2;
    return rects.some((r) => cx > r.x && cx < r.x + r.w && cy > r.y && cy < r.y + r.h);
  };
  const edges: ZoneEdge[] = [];
  // 가로 선: 칸 위아래 중 한쪽만 구역이면 경계. 이어진 칸은 한 선으로
  for (let j = 0; j < ys.length; j++) {
    for (let i = 0; i < xs.length - 1; i++) {
      if (cells(i, j - 1) === cells(i, j)) continue;
      let end = i;
      while (end + 1 < xs.length - 1 && cells(end + 1, j - 1) !== cells(end + 1, j)) end++;
      edges.push({ dir: "h", x: xs[i], y: ys[j], len: xs[end + 1] - xs[i] });
      i = end;
    }
  }
  for (let i = 0; i < xs.length; i++) {
    for (let j = 0; j < ys.length - 1; j++) {
      if (cells(i - 1, j) === cells(i, j)) continue;
      let end = j;
      while (end + 1 < ys.length - 1 && cells(i - 1, end + 1) !== cells(i, end + 1)) end++;
      edges.push({ dir: "v", x: xs[i], y: ys[j], len: ys[end + 1] - ys[j] });
      j = end;
    }
  }
  return edges;
}
