// 층 도면을 그림 한 장(SVG)으로: 팀 이사 도우미의 미니 도면, PNG·PDF 내보내기가 같이 쓴다.
// 좌표는 미터 (SVG 한 칸 = 1 m). 화면 데이터(비율 좌표)는 도면 크기를 곱해 바꾼다.
// 내보낸 그림은 화면의 CSS를 쓸 수 없어서 팀 구역 색은 lib/zoneColors.ts의 값(직접 고른 색 포함)을 직접 쓴다

import type { PlanEditorData, PlanGeometry, PlanStyle, Rect, SeatingData, ShapeStyle } from "./api";
import { cellCenter, DESK, lineOf, SPACE_KINDS, seatDims } from "./planGeometry";
import { zoneColor } from "./zoneColors";
import { zoneRects } from "./zoneShape";

export const teamColor = zoneColor;

/** free: 빈 고정석, taken: 앉은 사람 있음, flex: 자율석, off: 사용 중지, target: 고른 자리(이사 도우미), new: 새 책상 */
export type SeatState = "free" | "taken" | "flex" | "off" | "target" | "new";

export type DrawingSeat = {
  id: number | string;
  x: number; // 중심 (m)
  y: number;
  w: number; // 도면에서 차지하는 폭·높이 (돌린 뒤, m)
  h: number;
  rotation: number; // 의자 방향. 0 = 아래, 90 = 오른쪽, 180 = 위, 270 = 왼쪽
  code: string;
  name: string | null; // 앉은 사람 (이름 표시를 켤 때)
  color: string; // 팀 구역 색 키 (t0~t11 또는 #rrggbb)
  state: SeatState;
};

/** 요소 모양: 선 굵기 (m), 글자 크기 (%), 굵게. 없으면 기본 모양 */
export type DrawingStyle = { line?: number; label_size?: number; label_bold?: boolean };

export type FloorDrawing = {
  width: number; // m
  height: number;
  walls: (Rect & DrawingStyle)[];
  lines: { x1: number; y1: number; x2: number; y2: number; line: number }[];
  pillars: Rect[];
  spaces: (Rect & DrawingStyle & { kind: string; label: string })[];
  rooms: (Rect & DrawingStyle & { name: string })[];
  entrances: (Rect & DrawingStyle & { label: string; main: boolean })[];
  zones: { id: number; name: string; code: string; color: string; rects: Rect[] }[];
  seats: DrawingSeat[];
};

const spaceLabel = (kind: string, label: string) => label || SPACE_KINDS.find((k) => k.kind === kind)?.label || "";

/** 화면 데이터의 모양(선 굵기는 도면 폭 대비 비율) → 미터 */
function styleM(s: ShapeStyle, W: number): DrawingStyle {
  return {
    ...(s.line ? { line: s.line * W } : {}),
    ...(s.label_size ? { label_size: s.label_size } : {}),
    ...(s.label_bold ? { label_bold: true } : {}),
  };
}

/** 도면 편집기 요소의 모양 → 그림 모양 */
function styleOf(el: PlanStyle): DrawingStyle {
  return {
    ...(el.line_w ? { line: el.line_w } : {}),
    ...(el.label_size ? { label_size: el.label_size } : {}),
    ...(el.label_bold ? { label_bold: true } : {}),
  };
}

/** 배치 화면 데이터(게시본 도면 + 지금 배치) → 그림. 도면이 없으면 null */
export function drawingFromSeating(data: SeatingData): FloorDrawing | null {
  const plan = data.plan;
  if (!plan) return null;
  const W = plan.width_m;
  const H = plan.height_m;
  const m = (r: Rect): Rect => ({ x: r.x * W, y: r.y * H, w: r.w * W, h: r.h * H });
  const g = plan.geometry ?? {};
  const colorOf = new Map(data.zones.map((z) => [z.id, z.color_key]));
  return {
    width: W,
    height: H,
    walls: (g.walls ?? []).map((w) => ({ ...m(w), ...styleM(w, W) })),
    lines: (g.lines ?? []).map((l) => ({ x1: l.x1 * W, y1: l.y1 * H, x2: l.x2 * W, y2: l.y2 * H, line: l.line * W })),
    pillars: (g.pillars ?? []).map((p) => {
      const w = p.w ?? 0.015;
      const h = p.h ?? 0.025;
      return m({ x: p.x - w / 2, y: p.y - h / 2, w, h });
    }),
    spaces: (g.spaces ?? []).map((s) => ({
      ...m(s),
      ...styleM(s, W),
      kind: s.kind,
      label: spaceLabel(s.kind, s.label),
    })),
    rooms: data.rooms.flatMap((r) => (r.shape ? [{ ...m(r.shape), ...styleM(r.shape, W), name: r.name }] : [])),
    entrances: (g.entrances ?? []).map((e) => ({ ...m(e), ...styleM(e, W), label: e.label, main: e.main })),
    zones: data.zones.map((z) => ({
      id: z.id,
      name: z.name,
      code: z.code,
      color: z.color_key,
      rects: zoneRects(z.shape).map(m),
    })),
    seats: data.seats.map((s) => ({
      id: s.id,
      x: s.x * W,
      y: s.y * H,
      w: s.w ? s.w * W : DESK.w,
      h: s.h ? s.h * H : DESK.h,
      rotation: s.rotation,
      code: s.code,
      name: s.occupant?.name ?? null,
      color: (s.zone_id && colorOf.get(s.zone_id)) || "t0",
      state: s.status === "OUT_OF_SERVICE" ? "off" : s.seat_type === "FLEX" ? "flex" : s.occupant ? "taken" : "free",
    })),
  };
}

/** 도면 편집기의 초안(미터) → 그림. 앉은 사람·구역 색은 지금 게시본 기준 */
export function drawingFromPlan(
  geometry: PlanGeometry,
  width: number,
  height: number,
  live: PlanEditorData["live"],
): FloorDrawing {
  const out: FloorDrawing = {
    width,
    height,
    walls: [],
    lines: [],
    pillars: [],
    spaces: [],
    rooms: [],
    entrances: [],
    zones: [],
    seats: [],
  };
  for (const el of geometry.elements) {
    if (el.type === "wall") out.walls.push({ ...el, ...styleOf(el) });
    else if (el.type === "wall_line") out.lines.push({ x1: el.x, y1: el.y, x2: el.x2, y2: el.y2, line: lineOf(el) });
    else if (el.type === "pillar") out.pillars.push(el);
    else if (el.type === "space") out.spaces.push({ ...el, ...styleOf(el), label: spaceLabel(el.kind, el.label) });
    else if (el.type === "room") out.rooms.push({ ...el, ...styleOf(el) });
    else if (el.type === "entrance") out.entrances.push({ ...el, ...styleOf(el) });
    else {
      const size = seatDims(el);
      el.cells.forEach((cell, i) => {
        if (!cell.desk) return;
        const c = cellCenter(el, Math.floor(i / el.cols), i % el.cols);
        const seat = live.seats[cell.id];
        out.seats.push({
          id: cell.id,
          x: c.x,
          y: c.y,
          ...size,
          rotation: c.rotation,
          code: cell.code,
          name: seat?.occupant ?? null,
          color: seat?.color_key ?? "t0",
          state: !seat ? "new" : seat.occupant ? "taken" : "free",
        });
      });
    }
  }
  return out;
}
