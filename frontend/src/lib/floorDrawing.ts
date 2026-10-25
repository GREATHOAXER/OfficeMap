// 층 도면을 그림 한 장(SVG)으로: 팀 이사 도우미의 미니 도면, PNG·PDF 내보내기가 같이 쓴다.
// 좌표는 미터 (SVG 한 칸 = 1 m). 화면 데이터(비율 좌표)는 도면 크기를 곱해 바꾼다.
// 내보낸 그림은 화면의 CSS를 쓸 수 없어서 팀 구역 색을 여기 직접 적는다 (globals.css의 --t0~--t4와 같은 값)

import type { PlanEditorData, PlanGeometry, Rect, SeatingData } from "./api";
import { cellCenter, SPACE_KINDS } from "./planGeometry";
import { zoneRects } from "./zoneShape";

export const TEAM_COLORS: Record<string, { line: string; fill: string }> = {
  t0: { line: "#6e6e69", fill: "#efefec" },
  t1: { line: "#3b5b92", fill: "#e3eaf6" },
  t2: { line: "#9a5b1e", fill: "#f7e9d7" },
  t3: { line: "#4c7a34", fill: "#e5f0dc" },
  t4: { line: "#6e4a86", fill: "#eee4f4" },
};
export const teamColor = (key: string | null | undefined) => TEAM_COLORS[key ?? "t0"] ?? TEAM_COLORS.t0;

/** free: 빈 고정석, taken: 앉은 사람 있음, flex: 자율석, off: 사용 중지, target: 고른 자리(이사 도우미), new: 새 책상 */
export type SeatState = "free" | "taken" | "flex" | "off" | "target" | "new";

export type DrawingSeat = {
  id: number | string;
  x: number; // 중심 (m)
  y: number;
  rotation: number; // 0 = 의자가 아래, 180 = 위
  code: string;
  name: string | null; // 앉은 사람 (이름 표시를 켤 때)
  color: string; // 팀 구역 색 키 (t0~t4)
  state: SeatState;
};

export type FloorDrawing = {
  width: number; // m
  height: number;
  walls: Rect[];
  pillars: Rect[];
  spaces: (Rect & { kind: string; label: string })[];
  rooms: (Rect & { name: string })[];
  zones: { id: number; name: string; code: string; color: string; rects: Rect[] }[];
  seats: DrawingSeat[];
};

const spaceLabel = (kind: string, label: string) => label || SPACE_KINDS.find((k) => k.kind === kind)?.label || "";

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
    walls: (g.walls ?? []).map(m),
    pillars: (g.pillars ?? []).map((p) => {
      const w = p.w ?? 0.015;
      const h = p.h ?? 0.025;
      return m({ x: p.x - w / 2, y: p.y - h / 2, w, h });
    }),
    spaces: (g.spaces ?? []).map((s) => ({ ...m(s), kind: s.kind, label: spaceLabel(s.kind, s.label) })),
    rooms: data.rooms.flatMap((r) => (r.shape ? [{ ...m(r.shape), name: r.name }] : [])),
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
  const out: FloorDrawing = { width, height, walls: [], pillars: [], spaces: [], rooms: [], zones: [], seats: [] };
  for (const el of geometry.elements) {
    if (el.type === "wall") out.walls.push(el);
    else if (el.type === "pillar") out.pillars.push(el);
    else if (el.type === "space") out.spaces.push({ ...el, label: spaceLabel(el.kind, el.label) });
    else if (el.type === "room") out.rooms.push(el);
    else {
      el.cells.forEach((cell, i) => {
        if (!cell.desk) return;
        const c = cellCenter(el, Math.floor(i / el.cols), i % el.cols);
        const seat = live.seats[cell.id];
        out.seats.push({
          id: cell.id,
          x: c.x,
          y: c.y,
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
