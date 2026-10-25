// 도면 편집기(⑥)의 도면 모양 계산. 서버(server/app/plan_geometry.py)와 같은 규칙이다.
// 좌표는 미터, 모든 요소는 사각형(결정 8). 책상 칸 하나 = 좌석 하나 (칸 id가 좌석과 이어지는 열쇠)

import type { DeskGroup, PlanElement, PlanGeometry, PlanRect, SpaceKind } from "./api";

export const GRID_M = 0.5;

// 직원 화면의 좌석 크기(도면 대비 비율). 미터 = 비율 × 도면 폭(또는 높이)
const SEAT_W = 0.0533;
const SEAT_H = 0.0556;
const PITCH_X = 0.055;
const PAIR_PITCH = 0.145;
const ONE_PITCH = 0.0906;

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
  pillar: "기둥",
  space: "공간",
  room: "회의실",
  desk_group: "책상 묶음",
};

export function deskSize(width: number, height: number) {
  return { w: SEAT_W * width, h: SEAT_H * height };
}

/** 칸 하나의 중심(미터)과 의자 방향 (0 = 아래, 180 = 위) */
export function cellCenter(group: DeskGroup, row: number, col: number, width: number, height: number) {
  const desk = deskSize(width, height);
  const x = group.x + desk.w / 2 + col * PITCH_X * width;
  if (group.layout === "face") {
    const y = group.y + desk.h / 2 + Math.floor(row / 2) * PAIR_PITCH * height + (row % 2) * desk.h;
    return { x, y, rotation: row % 2 === 0 ? 180 : 0 };
  }
  return { x, y: group.y + desk.h / 2 + row * ONE_PITCH * height, rotation: 0 };
}

export function groupSize(group: Pick<DeskGroup, "layout" | "rows" | "cols">, width: number, height: number) {
  const desk = deskSize(width, height);
  const w = desk.w + (group.cols - 1) * PITCH_X * width;
  const last = group.rows - 1;
  const h =
    group.layout === "face"
      ? Math.floor(last / 2) * PAIR_PITCH * height + (last % 2) * desk.h + desk.h
      : desk.h + last * ONE_PITCH * height;
  return { w, h };
}

/** 요소가 차지하는 사각형 */
export function boxOf(el: PlanElement, width: number, height: number): PlanRect {
  if (el.type === "desk_group") return { x: el.x, y: el.y, ...groupSize(el, width, height) };
  return { x: el.x, y: el.y, w: el.w, h: el.h };
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

/** 새 책상 묶음 (칸은 모두 책상, 번호는 머리글자 N부터 안 쓴 것) */
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
    cells: Array.from({ length: preset.rows * preset.cols }, (_, i) => ({
      id: `${id}.${i + 1}`,
      desk: true,
      code: next(),
    })),
  };
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
    const box = boxOf(el, width, height);
    if (box.x < -0.01 || box.y < -0.01 || box.x + box.w > width + 0.01 || box.y + box.h > height + 0.01) {
      out.push({ elementId: el.id, text: `${TYPE_LABEL[el.type]}이 도면 밖으로 나갔어요` });
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

/** 요약: 책상(좌석)·회의실 수 */
export function countsOf(geometry: PlanGeometry) {
  let desks = 0;
  let rooms = 0;
  for (const el of geometry.elements) {
    if (el.type === "desk_group") desks += el.cells.filter((c) => c.desk).length;
    if (el.type === "room") rooms += 1;
  }
  return { desks, rooms };
}
