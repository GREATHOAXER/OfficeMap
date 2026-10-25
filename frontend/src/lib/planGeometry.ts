// 도면 편집기(⑥)의 도면 모양 계산. 서버(server/app/plan_geometry.py)와 같은 규칙이다.
// 좌표는 미터. 책상 칸 하나 = 좌석 하나 (칸 id가 좌석과 이어지는 열쇠)

import type { DeskGroup, PlanElement, PlanGeometry, PlanRect, SpaceKind } from "./api";

export const GRID_M = 0.5;

// 책상 기본 크기와 책상 사이 간격 (m). 서버(server/app/plan_geometry.py)와 같아야 한다.
// 직원 화면은 좌석을 "책상 크기 ÷ 도면 크기" 비율로 그린다. 기본 책상을 50 × 30 m 도면에 두면 0.0533 × 0.0556
const DESK_W = 2.665;
const DESK_H = 1.668;
const GAP_X = 0.085; // 옆 책상 사이
const AISLE = 1.014; // 마주보기: 두 줄 묶음 사이 통로
const CHAIR = 1.05; // 한 방향: 줄 사이 (의자 자리)
export const MIN_SIZE = 10;
export const MAX_SIZE = 300;
export const DESK_RANGE = { min: 0.3, max: 6 }; // 책상 크기 (m)
export const LINE_RANGE = { min: 0.01, max: 2 }; // 선 굵기 (m)
export const LABEL_RANGE = { min: 50, max: 400 }; // 글자 크기 (%)
export const WALL_LINE_W = 0.2; // 선 벽 기본 굵기 (m)

/** 선 굵기를 정하지 않았을 때 그리는 굵기 (m). 화면의 기본 모양과 비슷하게 */
export const DEFAULT_LINE: Partial<Record<PlanElement["type"], number>> = {
  wall: 0.3,
  wall_line: WALL_LINE_W,
  room: 0.1,
  space: 0.08,
  entrance: 0.1,
};

export const SPACE_KINDS: { kind: SpaceKind; label: string }[] = [
  { kind: "core", label: "코어 · EV · 계단" },
  { kind: "pantry", label: "탕비실" },
  { kind: "restroom", label: "화장실" },
  { kind: "lounge", label: "라운지 · 휴게" },
  { kind: "storage", label: "창고 · 포커스룸" },
  { kind: "service", label: "설비 · 복합기" },
  { kind: "restricted", label: "출입 제한" },
];

export const EQUIPMENT: { key: string; label: string }[] = [
  { key: "VIDEO", label: "화상회의" },
  { key: "TV", label: "TV" },
  { key: "PROJECTOR", label: "프로젝터" },
];

export const TYPE_LABEL: Record<PlanElement["type"], string> = {
  wall: "벽",
  wall_line: "선 벽",
  pillar: "기둥",
  space: "공간",
  room: "회의실",
  entrance: "출입구",
  desk_group: "책상 묶음",
};

type Lined = Extract<PlanElement, { type: "wall" | "wall_line" | "space" | "room" | "entrance" }>;
type Labeled = Extract<PlanElement, { type: "space" | "room" | "entrance" }>;

/** 선 굵기를 고를 수 있는 요소 */
export const hasLine = (el: PlanElement): el is Lined => el.type in DEFAULT_LINE;
/** 글자 크기·굵게를 고를 수 있는 요소 (이름표) */
export const hasLabel = (el: PlanElement): el is Labeled =>
  el.type === "space" || el.type === "room" || el.type === "entrance";
/** 선 굵기 (m). 정하지 않았으면 기본 굵기 */
export const lineOf = (el: Lined) => el.line_w ?? DEFAULT_LINE[el.type] ?? 0.1;

/** 기본 책상 하나의 크기 (m) */
export const DESK = { w: DESK_W, h: DESK_H } as const;

/** 기본 책상을 직원 화면·배치 화면이 그리는 좌석 크기 (도면 폭·높이 대비 비율). 도면이 없으면 50 × 30 m로 본다 */
export function seatRatio(width_m = 50, height_m = 30) {
  return { w: DESK_W / width_m, h: DESK_H / height_m };
}

/** 이 묶음의 책상 하나 크기 (돌리기 전, m) */
export function deskDims(group: Pick<DeskGroup, "desk_w" | "desk_h">) {
  return { w: group.desk_w || DESK_W, h: group.desk_h || DESK_H };
}

type GroupShape = Pick<DeskGroup, "layout" | "rows" | "cols" | "rotation" | "desk_w" | "desk_h">;

function localSize(group: GroupShape) {
  const d = deskDims(group);
  const w = d.w + (group.cols - 1) * (d.w + GAP_X);
  const last = group.rows - 1;
  const h =
    group.layout === "face"
      ? Math.floor(last / 2) * (2 * d.h + AISLE) + (last % 2) * d.h + d.h
      : d.h + last * (d.h + CHAIR);
  return { w, h };
}

const turned = (group: Pick<DeskGroup, "rotation">) => group.rotation === 90 || group.rotation === 270;

/** 묶음이 차지하는 폭·높이 (돌린 뒤, m) */
export function groupSize(group: GroupShape) {
  const s = localSize(group);
  return turned(group) ? { w: s.h, h: s.w } : s;
}

/** 좌석 하나가 도면에서 차지하는 폭·높이 (돌린 뒤, m) */
export function seatDims(group: GroupShape) {
  const d = deskDims(group);
  return turned(group) ? { w: d.h, h: d.w } : d;
}

/** 칸 하나의 중심(미터)과 의자 방향 (0 = 아래, 90 = 오른쪽, 180 = 위, 270 = 왼쪽) */
export function cellCenter(group: DeskGroup, row: number, col: number) {
  const d = deskDims(group);
  const lx = d.w / 2 + col * (d.w + GAP_X);
  const face = group.layout === "face";
  const ly = face ? d.h / 2 + Math.floor(row / 2) * (2 * d.h + AISLE) + (row % 2) * d.h : d.h / 2 + row * (d.h + CHAIR);
  const base = face && row % 2 === 0 ? 180 : 0;
  const { w, h } = localSize(group);
  const turn = group.rotation ?? 0;
  // 묶음을 돌린다: 돌린 뒤에도 (x, y)가 묶음이 차지하는 사각형의 왼쪽 위
  const [x, y] = { 0: [lx, ly], 90: [ly, w - lx], 180: [w - lx, h - ly], 270: [h - ly, lx] }[turn];
  const flip = group.cells[row * group.cols + col]?.flip ? 180 : 0;
  return { x: group.x + x, y: group.y + y, rotation: (base + turn + flip) % 360 };
}

/** 요소가 차지하는 사각형 (선 벽은 양 끝점을 감싸는 사각형) */
export function boxOf(el: PlanElement): PlanRect {
  if (el.type === "desk_group") return { x: el.x, y: el.y, ...groupSize(el) };
  if (el.type === "wall_line") {
    const x = Math.min(el.x, el.x2);
    const y = Math.min(el.y, el.y2);
    return { x, y, w: Math.abs(el.x2 - el.x), h: Math.abs(el.y2 - el.y) };
  }
  return { x: el.x, y: el.y, w: el.w, h: el.h };
}

/** 여러 요소를 감싸는 사각형 */
export function boxOfAll(els: PlanElement[]): PlanRect | null {
  if (els.length === 0) return null;
  const boxes = els.map(boxOf);
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return {
    x,
    y,
    w: Math.max(...boxes.map((b) => b.x + b.w)) - x,
    h: Math.max(...boxes.map((b) => b.y + b.h)) - y,
  };
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** 옮기기 (선 벽은 양 끝을 함께) */
export function moveElement(el: PlanElement, dx: number, dy: number): PlanElement {
  if (el.type === "wall_line") {
    return { ...el, x: r2(el.x + dx), y: r2(el.y + dy), x2: r2(el.x2 + dx), y2: r2(el.y2 + dy) };
  }
  return { ...el, x: r2(el.x + dx), y: r2(el.y + dy) };
}

/** 도면 크기를 바꾸면서 요소도 같은 비율로 늘리거나 줄인다. desks가 false면 책상 크기는 두고 묶음 가운데만 옮긴다 */
export function scaleElement(el: PlanElement, sx: number, sy: number, desks = true): PlanElement {
  if (el.type === "wall_line") {
    return { ...el, x: r2(el.x * sx), y: r2(el.y * sy), x2: r2(el.x2 * sx), y2: r2(el.y2 * sy) };
  }
  if (el.type === "desk_group" && !desks) {
    const s = groupSize(el);
    return { ...el, x: r2((el.x + s.w / 2) * sx - s.w / 2), y: r2((el.y + s.h / 2) * sy - s.h / 2) };
  }
  if (el.type === "desk_group") {
    const d = deskDims(el);
    // 돌린 묶음은 책상의 가로가 도면의 세로 방향이다
    const [kw, kh] = turned(el) ? [sy, sx] : [sx, sy];
    return {
      ...el,
      x: r2(el.x * sx),
      y: r2(el.y * sy),
      desk_w: r2(clamp(d.w * kw, DESK_RANGE.min, DESK_RANGE.max)),
      desk_h: r2(clamp(d.h * kh, DESK_RANGE.min, DESK_RANGE.max)),
    };
  }
  return { ...el, x: r2(el.x * sx), y: r2(el.y * sy), w: r2(el.w * sx), h: r2(el.h * sy) };
}

/** 책상 묶음 돌리기 (90도씩, 가운데는 그대로). 같은 칸이라 앉은 사람은 그대로다 */
export function rotateGroup(group: DeskGroup, clockwise: boolean): DeskGroup {
  const before = groupSize(group);
  // 의자 방향은 0 아래 → 90 오른쪽 순이라, 화면에서 시계 방향으로 돌리면 270을 더한다
  const rotation = (((group.rotation ?? 0) + (clockwise ? 270 : 90)) % 360) as NonNullable<DeskGroup["rotation"]>;
  const after = groupSize({ ...group, rotation });
  return {
    ...group,
    rotation,
    x: r2(group.x + before.w / 2 - after.w / 2),
    y: r2(group.y + before.h / 2 - after.h / 2),
  };
}

export const lineLength = (el: { x: number; y: number; x2: number; y2: number }) =>
  Math.hypot(el.x2 - el.x, el.y2 - el.y);

export type AlignMode = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom";

/** 줄 맞추기: 고른 요소 전체를 감싸는 사각형의 한쪽(또는 가운데)에 맞춘다 */
export function alignElements(els: PlanElement[], mode: AlignMode): PlanElement[] {
  const all = boxOfAll(els);
  if (!all) return els;
  return els.map((el) => {
    const b = boxOf(el);
    const dx = {
      left: all.x - b.x,
      hcenter: all.x + all.w / 2 - b.x - b.w / 2,
      right: all.x + all.w - b.x - b.w,
      top: 0,
      vcenter: 0,
      bottom: 0,
    }[mode];
    const dy = {
      left: 0,
      hcenter: 0,
      right: 0,
      top: all.y - b.y,
      vcenter: all.y + all.h / 2 - b.y - b.h / 2,
      bottom: all.y + all.h - b.y - b.h,
    }[mode];
    return moveElement(el, dx, dy);
  });
}

/** 간격 똑같이: 양 끝 요소는 두고 사이 요소를 같은 간격으로 (3개 이상) */
export function distributeElements(els: PlanElement[], axis: "x" | "y"): PlanElement[] {
  if (els.length < 3) return els;
  const len = axis === "x" ? "w" : "h";
  const sorted = [...els].sort((a, b) => boxOf(a)[axis] - boxOf(b)[axis]);
  const boxes = sorted.map(boxOf);
  const total = boxes.reduce((n, b) => n + b[len], 0);
  const last = boxes[boxes.length - 1];
  const gap = (last[axis] + last[len] - boxes[0][axis] - total) / (els.length - 1);
  let at = boxes[0][axis];
  const moved = new Map<string, PlanElement>();
  sorted.forEach((el, i) => {
    const d = at - boxes[i][axis];
    moved.set(el.id, axis === "x" ? moveElement(el, d, 0) : moveElement(el, 0, d));
    at += boxes[i][len] + gap;
  });
  return els.map((el) => moved.get(el.id) ?? el);
}

export const snapTo = (v: number, on: boolean) => (on ? Math.round(v / GRID_M) * GRID_M : Math.round(v * 100) / 100);

export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** 도면에 이미 쓰는 좌석 번호 */
export function usedCodes(geometry: PlanGeometry, except?: string): Set<string> {
  const codes = new Set<string>();
  for (const el of geometry.elements) {
    if (el.type !== "desk_group" || el.id === except) continue;
    for (const c of el.cells) if (c.desk && c.code) codes.add(c.code);
  }
  return codes;
}

/** 이 머리글자로 아직 안 쓴 번호를 차례로 (N-01, N-02 …) */
function codeMaker(prefix: string, used: Set<string>) {
  let n = 0;
  return () => {
    let code: string;
    do {
      n += 1;
      code = `${prefix}-${String(n).padStart(2, "0")}`;
    } while (used.has(code));
    used.add(code);
    return code;
  };
}

/** 새 책상 묶음 (칸은 모두 책상, 번호는 머리글자 N부터 안 쓴 것, 책상 크기는 도면의 기본 책상 크기) */
export function makeDeskGroup(
  x: number,
  y: number,
  preset: { layout: DeskGroup["layout"]; rows: number; cols: number },
  geometry: PlanGeometry,
  prefix = "N",
): DeskGroup {
  const id = newId("desks");
  const next = codeMaker(prefix, usedCodes(geometry));
  return {
    id,
    type: "desk_group",
    layout: preset.layout,
    rows: preset.rows,
    cols: preset.cols,
    x,
    y,
    ...(geometry.desk ? { desk_w: geometry.desk.w, desk_h: geometry.desk.h } : {}),
    cells: Array.from({ length: preset.rows * preset.cols }, (_, i) => ({
      id: `${id}.${i + 1}`,
      desk: true,
      code: next(),
    })),
  };
}

/** 이 도면에 넣을 복사본 (복제·다른 층에서 붙여넣기). 새 id, 좌석 번호가 이 도면과 겹치면 같은 머리글자로 새 번호 */
export function copyElement(el: PlanElement, geometry: PlanGeometry, dx: number, dy: number): PlanElement {
  const moved = moveElement(el, dx, dy);
  if (moved.type !== "desk_group") return { ...moved, id: newId(el.type) };
  const id = newId("desks");
  const used = usedCodes(geometry);
  const clash = moved.cells.some((c) => c.desk && used.has(c.code.trim()));
  const next = codeMaker(moved.cells.find((c) => c.desk && c.code)?.code.split("-")[0] || "N", used);
  return {
    ...moved,
    id,
    cells: moved.cells.map((c, i) => ({
      id: `${id}.${i + 1}`,
      desk: c.desk,
      code: c.desk ? (clash ? next() : c.code) : "",
      ...(c.flip ? { flip: true } : {}),
    })),
  };
}

/** 여러 요소의 복사본 (서로의 좌석 번호도 겹치지 않게 하나씩 넣어 가며 만든다) */
export function copyElements(els: PlanElement[], geometry: PlanGeometry, dx: number, dy: number): PlanElement[] {
  const out: PlanElement[] = [];
  for (const el of els) out.push(copyElement(el, { ...geometry, elements: [...geometry.elements, ...out] }, dx, dy));
  return out;
}

/** 줄·칸 수 바꾸기: 남는 자리의 칸(좌석)은 그대로 두고, 새 칸은 책상으로 만든다 */
export function resizeGroup(group: DeskGroup, rows: number, cols: number, geometry: PlanGeometry): DeskGroup {
  const prefix = group.cells.find((c) => c.desk && c.code)?.code.split("-")[0] || "N";
  const next = codeMaker(prefix, usedCodes(geometry));
  const cells: DeskGroup["cells"] = [];
  let serial = group.cells.length;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const old = r < group.rows && c < group.cols ? group.cells[r * group.cols + c] : undefined;
      if (old) cells.push(old);
      else {
        serial += 1;
        cells.push({ id: `${group.id}.n${serial}-${Date.now().toString(36).slice(-4)}`, desk: true, code: next() });
      }
    }
  }
  return { ...group, rows, cols, cells };
}

/** 책상 칸에 번호를 줄 순서로 다시 붙인다 (머리글자-시작 번호부터) */
export function renumber(group: DeskGroup, prefix: string, start: number): DeskGroup {
  let n = start;
  return {
    ...group,
    cells: group.cells.map((c) => (c.desk ? { ...c, code: `${prefix}-${String(n++).padStart(2, "0")}` } : c)),
  };
}

export type PlanProblem = { elementId: string; text: string };

/** 게시하면 안 되는 것 (서버도 다시 본다): 같은 좌석 번호, 번호 없는 책상, 이름 없는·같은 이름 회의실, 도면 밖 */
export function problemsOf(geometry: PlanGeometry, width: number, height: number): PlanProblem[] {
  const out: PlanProblem[] = [];
  const codes = new Map<string, string>();
  const names = new Set<string>();
  for (const el of geometry.elements) {
    const box = boxOf(el);
    if (box.x < -0.01 || box.y < -0.01 || box.x + box.w > width + 0.01 || box.y + box.h > height + 0.01) {
      out.push({ elementId: el.id, text: `${TYPE_LABEL[el.type]}: 도면 밖으로 나갔어요` });
    }
    if (el.type === "desk_group") {
      for (const c of el.cells) {
        if (!c.desk) continue;
        const code = c.code.trim();
        if (!code) out.push({ elementId: el.id, text: "번호가 없는 책상이 있어요" });
        else if (codes.has(code) && codes.get(code) !== c.id)
          out.push({ elementId: el.id, text: `좌석 번호가 두 번 나와요: ${code}` });
        else codes.set(code, c.id);
      }
    } else if (el.type === "room") {
      const name = el.name.trim();
      if (!name) out.push({ elementId: el.id, text: "이름이 없는 회의실이 있어요" });
      else if (names.has(name)) out.push({ elementId: el.id, text: `회의실 이름이 두 번 나와요: ${name}` });
      names.add(name);
    }
  }
  return out;
}

/** 요약: 책상(좌석)·회의실·출입구 수 */
export function countsOf(geometry: PlanGeometry) {
  let desks = 0;
  let rooms = 0;
  let entrances = 0;
  for (const el of geometry.elements) {
    if (el.type === "desk_group") desks += el.cells.filter((c) => c.desk).length;
    if (el.type === "room") rooms += 1;
    if (el.type === "entrance") entrances += 1;
  }
  return { desks, rooms, entrances };
}
