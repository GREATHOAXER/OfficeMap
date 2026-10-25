// 도면 파일로 초안 만들기: 도면 그림·엑셀 칸에서 벽·기둥·공간·회의실·책상을 찾아 편집기 요소로 바꾼다.
// 좌표는 모두 미터이고 고른 부분(자르기)의 왼쪽 위가 (0, 0). 그림은 밝기 배열만 받아 DOM 없이 돈다.
// 찾는 것은 초안일 뿐이라, 화면은 밑그림 위에 겹쳐 보여 주고 관리자가 고친다.

import type { DeskGroup, PlanElement, SpaceKind } from "./api";
import { cellCenter, DESK_RANGE, groupSize } from "./planGeometry";
import { tidyWalls } from "./wallSnap";

export type Gray = { width: number; height: number; data: Uint8Array | Uint8ClampedArray }; // 밝기 0~255
/** 가로 또는 세로 선 (x1 ≤ x2, y1 ≤ y2). t: 굵기 */
export type Line = { x1: number; y1: number; x2: number; y2: number; t: number };
export type Box = { x: number; y: number; w: number; h: number };
/** 글자와 그 자리. cell: 엑셀 칸(합친 칸이면 합친 크기)이라 자리가 곧 칸 크기 */
export type TextBox = Box & { text: string; cell?: boolean };
/** 엑셀 테두리 (weight 1 가는 선, 2 중간, 3 굵은 선·두 줄) */
export type Edge = Line & { weight: 1 | 2 | 3 };
/** 엑셀에서 색을 칠한 칸 (lum: 밝기 0~255) */
export type Fill = Box & { lum: number };

export type DetectOptions = {
  /** 벽으로 볼 선: 1 모든 선, 2 굵은 선만, 3 아주 굵은 선만 (엑셀은 테두리 굵기) */
  lines: 1 | 2 | 3;
  /** 이보다 짧은 선은 벽이 아니다 (m) */
  minLenM: number;
  /** 0.45 m 안으로 나란한 두 줄을 벽 하나로 */
  mergeDouble: boolean;
  /** 꽉 찬 작은 네모를 기둥으로 */
  pillars: boolean;
  /** 이름(회의실·화장실·탕비실…)이 쓰인 방을 공간·회의실로 */
  spaces: boolean;
  /** 엑셀 칸 글자·도면의 좌석 번호를 책상으로 */
  desks: boolean;
  /** 쪽 둘레의 긴 테두리(도곽)는 빼기 */
  frame: boolean;
  /** 이보다 어두우면 선 (0 = 그림에 맞춰 자동) */
  dark: number;
};

export const DETECT_DEFAULTS: DetectOptions = {
  lines: 1,
  minLenM: 1,
  mergeDouble: true,
  pillars: true,
  spaces: true,
  desks: true,
  frame: true,
  dark: 0,
};

export type DetectInput = {
  widthM: number;
  heightM: number;
  /** 고른 부분 그림 (그림·PDF). mPerPx: 그림 한 칸이 몇 m */
  raster?: { gray: Gray; mPerPx: number };
  /** 엑셀 테두리·칠한 칸 */
  vector?: { edges: Edge[]; fills: Fill[] };
  texts: TextBox[];
  options: DetectOptions;
  /** 좌석 번호만 있는 도면(PDF)에서 놓을 책상 크기 (m) */
  desk: { w: number; h: number };
  /** 요소 ID 머리 (지금 초안에 더할 때 겹치지 않게) */
  idPrefix: string;
};

export type DetectResult = {
  elements: PlanElement[];
  walls: number;
  pillars: number;
  spaces: number;
  rooms: number;
  desks: number;
  /** 방 크기를 못 찾아 글자 둘레에 기본 크기로 놓은 공간·회의실 */
  guessed: number;
  /** 선이 너무 많아 긴 것만 남겼다 */
  capped: boolean;
};

const MAX_WALLS = 1500; // 서버가 받는 요소 수(2000) 안에서 공간·책상 자리를 남긴다
const DOUBLE_GAP_M = 0.45; // 두 줄 벽으로 볼 간격
const CLOSE_M = 0.45; // 방 찾기: 이 반지름으로 벽을 두껍게 그려 문(0.9 m까지) 틈을 막는다
const GRID_CELL_M = 0.1; // 방 찾기 칸 크기
const PILLAR_M = { min: 0.3, max: 1.6 };
const SEAT_CODE = /^[A-Z]{1,3}-?\d{1,3}$/;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const r2 = (v: number) => Math.round(v * 100) / 100;

// 글자 읽기 ----------------------------------------------------------------------------------------

const SPACE_WORDS: [SpaceKind, RegExp][] = [
  ["restricted", /서버실|전산실|금고|보안실|통제|출입\s*제한|기록물/i],
  ["restroom", /화장실|wc\b|toilet|파우더/i],
  ["pantry", /탕비|캔틴|pantry|kitchen|주방|급탕/i],
  ["core", /e\/?v\b|엘리베이터|승강기|계단|stair|코어|core\b|lift/i],
  ["lounge", /라운지|휴게|lounge|카페|cafe|수유/i],
  ["storage", /창고|문서고|보관|storage|포커스|폰\s*부스|락커|사물함/i],
  ["service", /전기실|기계실|설비|복합기|프린터|출력|eps|tps|pit|공조/i],
];
const ROOM_WORDS = /회의|미팅|meeting|conference|접견|세미나|교육장|화상|강당/i;

export type TextKind = { kind: "room" } | { kind: "space"; space: SpaceKind } | { kind: "code" } | { kind: "other" };

/** 글자가 무엇을 가리키나 (회의실·공간 이름·좌석 번호·그 밖) */
export function classifyText(raw: string): TextKind {
  const text = raw.trim();
  if (!text || text.length > 30) return { kind: "other" };
  if (ROOM_WORDS.test(text)) return { kind: "room" };
  for (const [space, re] of SPACE_WORDS) if (re.test(text)) return { kind: "space", space };
  if (SEAT_CODE.test(text)) return { kind: "code" };
  return { kind: "other" };
}

/** "B1", "지하 1층", "3F", "3층" → 층 이름 꼴 ("B1", "3F"). 아니면 null */
export function floorName(raw: string): string | null {
  const t = raw.replace(/\s+/g, "").toUpperCase();
  let m = t.match(/^(?:B|지하)(\d{1,2})(?:F|층)?$/);
  if (m) return `B${Number(m[1])}`;
  m = t.match(/^(?:지상)?(\d{1,3})(?:F|층)$/);
  if (m) return `${Number(m[1])}F`;
  return null;
}

/** 글자들에서 층 이름 찾기 (가장 큰 글자를 믿는다) */
export function findFloorHint(texts: { text: string; h: number }[]): string | null {
  let best: { name: string; h: number } | null = null;
  for (const t of texts) {
    for (const word of t.text.split(/[\s,()[\]·:]+/)) {
      const name = floorName(word) ?? floorName(word.replace(/(평면도|배치도|도면)$/, ""));
      if (name && (!best || t.h > best.h)) best = { name, h: t.h };
    }
  }
  return best?.name ?? null;
}

/** 글자들에서 축척 찾기 ("S=1/200", "SCALE 1:100", "축척 1/300"). 1:N의 N */
export function findScaleHint(texts: { text: string }[]): number | null {
  const all = texts.map((t) => t.text).join(" ");
  const marked = all.match(/(?:S\s*=|SCALE\s*:?|축척\s*:?)\s*1\s*[:/]\s*(\d{2,4})/i);
  const n = Number(marked?.[1] ?? all.match(/\b1\s*:\s*(\d{2,4})\b/)?.[1]);
  return Number.isFinite(n) && n >= 20 && n <= 2000 ? n : null;
}

// 그림에서 선 찾기 --------------------------------------------------------------------------------

/** 밝기 히스토그램으로 선과 바탕을 가르는 값 (오츠) */
export function autoDark(g: Gray): number {
  const hist = new Float64Array(256);
  for (let i = 0; i < g.data.length; i++) hist[g.data[i]] += 1;
  const total = g.data.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let bestT = 160;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const between = wB * wF * (sumB / wB - (sum - sumB) / wF) ** 2;
    if (between > best) {
      best = between;
      bestT = t;
    }
  }
  return Math.min(210, Math.max(70, bestT));
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/**
 * 가로(또는 세로)로 길게 이어진 어두운 줄을 찾아, 위아래로 맞닿은 줄을 묶어 선 하나로.
 * maxThick보다 두꺼운 묶음은 꽉 찬 면(칠한 곳)이라 선이 아니다
 */
function bands(mask: Uint8Array, W: number, H: number, minLen: number, maxThick: number, horizontal: boolean): Line[] {
  const lines = horizontal ? H : W;
  const length = horizontal ? W : H;
  const at = horizontal ? (i: number, j: number) => mask[i * W + j] : (i: number, j: number) => mask[j * W + i];
  type Band = { s: number; e: number; starts: number[]; ends: number[]; first: number; last: number };
  const out: Line[] = [];
  let open: Band[] = [];
  const close = (b: Band) => {
    const thick = b.last - b.first + 1;
    if (thick > maxThick) return;
    const s = median(b.starts);
    const e = median(b.ends) + 1;
    const c = (b.first + b.last + 1) / 2;
    out.push(horizontal ? { x1: s, y1: c, x2: e, y2: c, t: thick } : { x1: c, y1: s, x2: c, y2: e, t: thick });
  };
  for (let i = 0; i <= lines; i++) {
    const runs: [number, number][] = [];
    if (i < lines) {
      let j = 0;
      while (j < length) {
        if (!at(i, j)) {
          j += 1;
          continue;
        }
        // 1칸 끊김(흐린 점)은 이어진 것으로
        let end = j;
        let k = j + 1;
        while (k < length && (at(i, k) || (k + 1 < length && at(i, k + 1)))) {
          if (at(i, k)) end = k;
          k += 1;
        }
        if (end - j + 1 >= minLen) runs.push([j, end]);
        j = k;
      }
    }
    const used = new Set<Band>();
    const next: Band[] = [];
    for (const [s, e] of runs) {
      let best: Band | null = null;
      let bestOverlap = 0;
      for (const b of open) {
        if (used.has(b)) continue;
        const overlap = Math.min(e, b.e) - Math.max(s, b.s) + 1;
        if (overlap > bestOverlap && overlap >= 0.7 * Math.min(e - s + 1, b.e - b.s + 1)) {
          best = b;
          bestOverlap = overlap;
        }
      }
      if (best) {
        used.add(best);
        best.s = s;
        best.e = e;
        best.starts.push(s);
        best.ends.push(e);
        best.last = i;
        next.push(best);
      } else next.push({ s, e, starts: [s], ends: [e], first: i, last: i });
    }
    for (const b of open) if (!used.has(b)) close(b);
    open = next;
  }
  return out;
}

/** 꽉 찬 작은 네모 (기둥). k × k 칸이 모두 어두운 곳을 이어 붙여 둘레를 잰다 */
function solidBoxes(mask: Uint8Array, W: number, H: number, k: number, maxSide: number): Box[] {
  const sum = new Int32Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) {
      row += mask[y * W + x];
      sum[(y + 1) * (W + 1) + x + 1] = sum[y * (W + 1) + x + 1] + row;
    }
  }
  const area = (x0: number, y0: number, x1: number, y1: number) =>
    sum[y1 * (W + 1) + x1] - sum[y0 * (W + 1) + x1] - sum[y1 * (W + 1) + x0] + sum[y0 * (W + 1) + x0];
  const solid = new Uint8Array(W * H);
  for (let y = 0; y + k <= H; y++)
    for (let x = 0; x + k <= W; x++) if (area(x, y, x + k, y + k) === k * k) solid[y * W + x] = 1;
  const seen = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  const out: Box[] = [];
  for (let start = 0; start < W * H; start++) {
    if (!solid[start] || seen[start]) continue;
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    let x0 = W;
    let y0 = H;
    let x1 = 0;
    let y1 = 0;
    while (top) {
      const p = stack[--top];
      const x = p % W;
      const y = (p - x) / W;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
      for (const q of [p - 1, p + 1, p - W, p + W]) {
        if (q < 0 || q >= W * H || seen[q] || !solid[q]) continue;
        if ((q === p - 1 && x === 0) || (q === p + 1 && x === W - 1)) continue;
        seen[q] = 1;
        stack[top++] = q;
      }
    }
    // 찾은 칸은 k × k 창의 왼쪽 위라 창 크기만큼 넓힌다
    const w = x1 - x0 + k;
    const h = y1 - y0 + k;
    if (w > maxSide || h > maxSide || Math.max(w, h) > 2.5 * Math.min(w, h)) continue;
    if (area(x0, y0, Math.min(W, x0 + w), Math.min(H, y0 + h)) < 0.6 * w * h) continue;
    out.push({ x: x0, y: y0, w, h });
  }
  return out;
}

/** 그림에서 선과 기둥 (단위: 그림 칸) */
export function rasterLines(
  g: Gray,
  opts: { dark: number; minLen: number; maxThick: number; minThick: number; pillarMin: number; pillarMax: number },
): { lines: Line[]; pillars: Box[] } {
  const W = g.width;
  const H = g.height;
  const mask = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) mask[i] = g.data[i] < opts.dark ? 1 : 0;
  const lines = [
    ...bands(mask, W, H, opts.minLen, opts.maxThick, true),
    ...bands(mask, W, H, opts.minLen, opts.maxThick, false),
  ].filter((l) => l.t >= opts.minThick);
  const pillars = opts.pillarMin > 0 ? solidBoxes(mask, W, H, Math.max(2, opts.pillarMin), opts.pillarMax) : [];
  return { lines, pillars };
}

// 선 다듬기 (m) -------------------------------------------------------------------------------------

const isH = (l: Line) => l.y1 === l.y2;
const lenOf = (l: Line) => (isH(l) ? l.x2 - l.x1 : l.y2 - l.y1);

type Axis = { c: number; a: number; b: number; t: number }; // c: 선이 놓인 자리, a~b: 길이 방향
const toAxis = (l: Line): Axis =>
  isH(l) ? { c: l.y1, a: l.x1, b: l.x2, t: l.t } : { c: l.x1, a: l.y1, b: l.y2, t: l.t };
const fromAxis = (s: Axis, horizontal: boolean): Line =>
  horizontal ? { x1: s.a, y1: s.c, x2: s.b, y2: s.c, t: s.t } : { x1: s.c, y1: s.a, x2: s.c, y2: s.b, t: s.t };

/** 한 줄 위에 이어지거나 겹친 선을 하나로 (gap까지 떨어진 것도). tol: 이만큼 어긋난 것도 같은 줄 (살짝 기운 스캔) */
export function mergeCollinear(lines: Line[], gap: number, tol = 0): Line[] {
  const out: Line[] = [];
  for (const horizontal of [true, false]) {
    const items = lines
      .filter((l) => isH(l) === horizontal)
      .map(toAxis)
      .sort((p, q) => p.c - q.c);
    let row: Axis[] = [];
    const flush = () => {
      row.sort((p, q) => p.a - q.a);
      let cur: (Axis & { sum: number; len: number }) | null = null;
      for (const s of row) {
        const len = s.b - s.a;
        if (cur && s.a <= cur.b + gap) {
          cur.b = Math.max(cur.b, s.b);
          cur.t = Math.max(cur.t, s.t);
          cur.sum += s.c * len;
          cur.len += len;
          continue;
        }
        if (cur) out.push(fromAxis({ ...cur, c: cur.len > 0 ? cur.sum / cur.len : cur.c }, horizontal));
        cur = { ...s, sum: s.c * len, len };
      }
      if (cur) out.push(fromAxis({ ...cur, c: cur.len > 0 ? cur.sum / cur.len : cur.c }, horizontal));
      row = [];
    };
    // 앞 선과 놓인 자리 차이가 굵기 반 안이면 같은 줄
    for (const s of items) {
      const last = row[row.length - 1];
      if (last && s.c - last.c > Math.max(1e-6, tol, Math.min(s.t, last.t) / 2)) flush();
      row.push(s);
    }
    flush();
  }
  return out;
}

/** 나란한 두 줄(벽의 양쪽 면)을 가운데 선 하나로. 굵기는 두 줄 바깥까지 */
export function mergeDoubleLines(lines: Line[], maxGap: number): Line[] {
  const out: Line[] = [];
  for (const horizontal of [true, false]) {
    const group = lines
      .filter((l) => isH(l) === horizontal)
      .map(toAxis)
      .sort((p, q) => p.c - q.c);
    const used = new Uint8Array(group.length);
    for (let i = 0; i < group.length; i++) {
      if (used[i]) continue;
      const p = group[i];
      let pick = -1;
      for (let j = i + 1; j < group.length; j++) {
        const q = group[j];
        if (q.c - p.c > maxGap) break;
        if (used[j] || q.c - p.c < 1e-6) continue;
        const overlap = Math.min(p.b, q.b) - Math.max(p.a, q.a);
        if (overlap >= 0.6 * Math.min(p.b - p.a, q.b - q.a)) {
          pick = j;
          break;
        }
      }
      used[i] = 1;
      if (pick < 0) {
        out.push(fromAxis(p, horizontal));
        continue;
      }
      used[pick] = 1;
      const q = group[pick];
      const merged = {
        c: (p.c + q.c) / 2,
        a: Math.min(p.a, q.a),
        b: Math.max(p.b, q.b),
        t: q.c - p.c + (p.t + q.t) / 2,
      };
      out.push(fromAxis(merged, horizontal));
    }
  }
  return out;
}

/** 끝이 수직인 다른 선 위(그 선 굵기 안)에 있으면 그 선의 가운데 선으로 옮긴다 (모서리·T자가 딱 맞게) */
export function snapEnds(lines: Line[]): Line[] {
  const hs = lines.filter(isH);
  const vs = lines.filter((l) => !isH(l));
  const snap = (v: number, along: number, others: Line[], horizontal: boolean, own: number) => {
    let best = v;
    let bestD = Infinity;
    for (const o of others) {
      const c = horizontal ? o.x1 : o.y1; // 수직인 선의 자리
      const lo = (horizontal ? o.y1 : o.x1) - own / 2 - 1e-6;
      const hi = (horizontal ? o.y2 : o.x2) + own / 2 + 1e-6;
      if (along < lo || along > hi) continue;
      const d = Math.abs(c - v);
      if (d <= o.t / 2 + own / 2 + 1e-6 && d < bestD) {
        best = c;
        bestD = d;
      }
    }
    return best;
  };
  return [
    ...hs.map((l) => ({ ...l, x1: snap(l.x1, l.y1, vs, true, l.t), x2: snap(l.x2, l.y1, vs, true, l.t) })),
    ...vs.map((l) => ({ ...l, y1: snap(l.y1, l.x1, hs, false, l.t), y2: snap(l.y2, l.x1, hs, false, l.t) })),
  ].filter((l) => lenOf(l) > 0.05);
}

// 방 찾기 ------------------------------------------------------------------------------------------

type Grid = { cols: number; rows: number; wall: Uint8Array };

/** 벽을 CLOSE_M만큼 두껍게 그린 칸 지도 (문 틈이 막힌다) */
function wallGrid(lines: Line[], widthM: number, heightM: number): Grid {
  const cols = Math.max(1, Math.ceil(widthM / GRID_CELL_M));
  const rows = Math.max(1, Math.ceil(heightM / GRID_CELL_M));
  const wall = new Uint8Array(cols * rows);
  for (const l of lines) {
    const pad = l.t / 2 + CLOSE_M;
    const x0 = Math.max(0, Math.floor((l.x1 - pad) / GRID_CELL_M));
    const x1 = Math.min(cols - 1, Math.floor((l.x2 + pad) / GRID_CELL_M));
    const y0 = Math.max(0, Math.floor((l.y1 - pad) / GRID_CELL_M));
    const y1 = Math.min(rows - 1, Math.floor((l.y2 + pad) / GRID_CELL_M));
    for (let y = y0; y <= y1; y++) wall.fill(1, y * cols + x0, y * cols + x1 + 1);
  }
  return { cols, rows, wall };
}

/** (x, y)에서 벽에 막힐 때까지 넓힌 방의 사각형 (벽 안쪽 면까지). 바깥으로 새거나 너무 크면 null */
function roomAt(grid: Grid, x: number, y: number, maxCells: number): Box | null {
  const { cols, rows, wall } = grid;
  let cx = Math.floor(x / GRID_CELL_M);
  let cy = Math.floor(y / GRID_CELL_M);
  if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) return null;
  if (wall[cy * cols + cx]) {
    // 글자가 두껍게 그린 벽 위에 걸렸으면 가까운 빈 칸에서
    let found = false;
    for (let r = 1; r <= 4 && !found; r++)
      for (let dy = -r; dy <= r && !found; dy++)
        for (let dx = -r; dx <= r && !found; dx++) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx >= 0 && ny >= 0 && nx < cols && ny < rows && !wall[ny * cols + nx]) {
            cx = nx;
            cy = ny;
            found = true;
          }
        }
    if (!found) return null;
  }
  const seen = new Uint8Array(cols * rows);
  const stack = [cy * cols + cx];
  seen[stack[0]] = 1;
  let x0 = cx;
  let y0 = cy;
  let x1 = cx;
  let y1 = cy;
  let count = 0;
  while (stack.length) {
    const p = stack.pop()!;
    const px = p % cols;
    const py = (p - px) / cols;
    if (px === 0 || py === 0 || px === cols - 1 || py === rows - 1) return null; // 바깥으로 샌다
    if (++count > maxCells) return null;
    if (px < x0) x0 = px;
    if (py < y0) y0 = py;
    if (px > x1) x1 = px;
    if (py > y1) y1 = py;
    for (const q of [p - 1, p + 1, p - cols, p + cols]) {
      if (!seen[q] && !wall[q]) {
        seen[q] = 1;
        stack.push(q);
      }
    }
  }
  return {
    x: x0 * GRID_CELL_M - CLOSE_M,
    y: y0 * GRID_CELL_M - CLOSE_M,
    w: (x1 - x0 + 1) * GRID_CELL_M + 2 * CLOSE_M,
    h: (y1 - y0 + 1) * GRID_CELL_M + 2 * CLOSE_M,
  };
}

// 책상 묶기 ----------------------------------------------------------------------------------------

type Desk = { cx: number; cy: number; w: number; h: number; code: string | null };

/**
 * 책상 칸들을 책상 묶음으로: 같은 줄에 붙어 있는 책상은 한 줄 묶음, 바로 아래 같은 모양 줄이 붙어 있으면
 * 마주보기 두 줄 묶음. 세로로 긴 책상은 돌린(90도) 묶음
 */
export function groupDesks(desks: Desk[], idPrefix: string): DeskGroup[] {
  const groups: DeskGroup[] = [];
  let n = 0;
  for (const vertical of [false, true]) {
    // 세로 책상은 x·y를 바꿔 가로처럼 묶은 뒤 되돌린다
    const items = desks
      .filter((d) => d.h > d.w === vertical)
      .map((d) => (vertical ? { ...d, cx: d.cy, cy: d.cx, w: d.h, h: d.w } : d))
      .sort((a, b) => a.cy - b.cy || a.cx - b.cx);
    const rows: Desk[][] = [];
    for (const d of items) {
      const row = rows.find((r) => Math.abs(r[0].cy - d.cy) < r[0].h * 0.4 && Math.abs(r[0].h - d.h) < r[0].h * 0.4);
      if (row) row.push(d);
      else rows.push([d]);
    }
    const runs: Desk[][] = [];
    for (const row of rows) {
      row.sort((a, b) => a.cx - b.cx);
      let run: Desk[] = [];
      for (const d of row) {
        const last = run[run.length - 1];
        if (last && (d.cx - last.cx > Math.max(last.w, d.w) * 1.5 || run.length >= 20)) {
          runs.push(run);
          run = [];
        }
        run.push(d);
      }
      if (run.length) runs.push(run);
    }
    const paired = new Set<Desk[]>();
    for (const run of runs) {
      if (paired.has(run)) continue;
      const w = median(run.map((d) => d.w));
      const h = median(run.map((d) => d.h));
      const left = run[0].cx - run[0].w / 2;
      const top = Math.min(...run.map((d) => d.cy - d.h / 2));
      // 바로 아래에 같은 칸 수로 붙은 줄 → 마주보기
      const below = runs.find(
        (o) =>
          o !== run &&
          !paired.has(o) &&
          o.length === run.length &&
          Math.abs(o[0].cx - o[0].w / 2 - left) < w * 0.5 &&
          Math.abs(o[0].cy - run[0].cy - h) < h * 0.5,
      );
      paired.add(run);
      if (below) paired.add(below);
      const members = below ? [...run, ...below] : run;
      const deskW = Math.min(DESK_RANGE.max, Math.max(DESK_RANGE.min, r3(w)));
      const deskH = Math.min(DESK_RANGE.max, Math.max(DESK_RANGE.min, r3(h)));
      const id = `${idPrefix}d${++n}`;
      let group: DeskGroup = {
        id,
        type: "desk_group",
        layout: below ? "face" : "one",
        rows: below ? 2 : 1,
        cols: run.length,
        x: r3(left),
        y: r3(top),
        desk_w: deskW,
        desk_h: deskH,
        cells: Array.from({ length: (below ? 2 : 1) * run.length }, (_, i) => ({
          id: `${id}-c${i + 1}`,
          desk: true,
          code: "",
        })),
      };
      // 바꿨던 x·y를 되돌린다: 가로로 묶은 것을 90도 돌린 묶음
      if (vertical) group = { ...group, x: r3(top), y: r3(left), rotation: 90 };
      // 칸마다 가장 가까운 책상의 번호
      const real = members.map((d) => (vertical ? { ...d, cx: d.cy, cy: d.cx } : d));
      group.cells = group.cells.map((cell, i) => {
        const c = cellCenter(group, Math.floor(i / group.cols), i % group.cols);
        let best: Desk | null = null;
        let bestD = Infinity;
        for (const d of real) {
          const dd = Math.hypot(d.cx - c.x, d.cy - c.y);
          if (dd < bestD) {
            best = d;
            bestD = dd;
          }
        }
        return { ...cell, code: best?.code ?? "" };
      });
      groups.push(group);
    }
  }
  // 번호: 좌석 번호 꼴이고 겹치지 않으면 그대로, 아니면 N-01부터
  const used = new Set<string>();
  for (const g of groups)
    for (const c of g.cells) {
      if (c.code && !used.has(c.code)) used.add(c.code);
      else c.code = "";
    }
  let k = 0;
  for (const g of groups)
    for (const c of g.cells) {
      if (c.code) continue;
      let code: string;
      do code = `N-${String(++k).padStart(2, "0")}`;
      while (used.has(code));
      used.add(code);
      c.code = code;
    }
  return groups;
}

// 전체 ---------------------------------------------------------------------------------------------

const inside = (p: { x: number; y: number }, b: Box, pad = 0) =>
  p.x >= b.x - pad && p.x <= b.x + b.w + pad && p.y >= b.y - pad && p.y <= b.y + b.h + pad;

const clampBox = (b: Box, W: number, H: number): Box => {
  const x = Math.max(0, Math.min(b.x, W - 0.1));
  const y = Math.max(0, Math.min(b.y, H - 0.1));
  return {
    x: r3(x),
    y: r3(y),
    w: r3(Math.max(0.1, Math.min(b.x + b.w, W) - x)),
    h: r3(Math.max(0.1, Math.min(b.y + b.h, H) - y)),
  };
};

/** 도면 파일의 한 부분에서 요소 찾기 */
export function detectPlan(input: DetectInput): DetectResult {
  const { widthM: W, heightM: H, options: o, idPrefix } = input;
  let lines: Line[] = [];
  let pillarBoxes: Box[] = [];

  if (input.raster) {
    const { gray, mPerPx } = input.raster;
    const px = (m: number) => m / mPerPx;
    const found = rasterLines(gray, {
      dark: o.dark || autoDark(gray),
      minLen: Math.max(4, Math.round(px(o.minLenM) * 0.8)),
      maxThick: Math.max(3, Math.round(px(0.6))),
      minThick: { 1: 1, 2: 3, 3: 5 }[o.lines],
      pillarMin: o.pillars ? Math.max(3, Math.round(px(PILLAR_M.min))) : 0,
      pillarMax: Math.round(px(PILLAR_M.max)),
    });
    const m = (l: Line): Line => ({
      x1: l.x1 * mPerPx,
      y1: l.y1 * mPerPx,
      x2: l.x2 * mPerPx,
      y2: l.y2 * mPerPx,
      t: l.t * mPerPx,
    });
    lines = found.lines.map(m);
    pillarBoxes = found.pillars.map((b) => ({ x: b.x * mPerPx, y: b.y * mPerPx, w: b.w * mPerPx, h: b.h * mPerPx }));
    lines = mergeCollinear(lines, 2 * mPerPx, 1.5 * mPerPx);
  }
  if (input.vector) {
    const picked = input.vector.edges.filter((e) => e.weight >= o.lines);
    lines = lines.concat(
      mergeCollinear(
        picked.map((e) => ({ ...e, t: 0.02 })),
        0.02,
      ),
    );
    if (o.pillars)
      pillarBoxes = pillarBoxes.concat(
        input.vector.fills.filter(
          (f) =>
            f.lum < 110 &&
            Math.max(f.w, f.h) <= PILLAR_M.max &&
            Math.min(f.w, f.h) >= PILLAR_M.min * 0.6 &&
            Math.max(f.w, f.h) <= 2.5 * Math.min(f.w, f.h),
        ),
      );
  }

  // 기둥 둘레·도곽·짧은 선 빼기
  lines = lines.filter(
    (l) => !pillarBoxes.some((b) => inside({ x: l.x1, y: l.y1 }, b, 0.05) && inside({ x: l.x2, y: l.y2 }, b, 0.05)),
  );
  if (o.frame) {
    // 도곽: 고른 부분 네 가장자리를 따라 길게 지나가고 끝 말고는 아무 선도 닿지 않는 네 선.
    // 네 변이 다 있어야 뺀다 (건물 바깥 벽은 어딘가에 안쪽 벽이 닿는다)
    const sides = new Map<string, Line[]>();
    for (const l of lines) {
      const horizontal = isH(l);
      const c = horizontal ? l.y1 : l.x1;
      const span = horizontal ? W : H;
      const across = horizontal ? H : W;
      if (lenOf(l) < 0.85 * span || Math.min(c, across - c) > 0.06 * across) continue;
      const a = horizontal ? l.x1 : l.y1;
      const b = horizontal ? l.x2 : l.y2;
      const touched = lines.some((o) => {
        if (o === l || isH(o) === horizontal) return false;
        const at = horizontal ? o.x1 : o.y1; // 수직인 선이 지나는 자리
        if (at < a + 0.5 || at > b - 0.5) return false;
        const ends = horizontal ? [o.y1, o.y2] : [o.x1, o.x2];
        return ends.some((e) => Math.abs(e - c) <= 0.3);
      });
      if (touched) continue;
      const side = horizontal ? (c < H / 2 ? "top" : "bottom") : c < W / 2 ? "left" : "right";
      sides.set(side, [...(sides.get(side) ?? []), l]);
    }
    if (sides.size === 4) {
      const frame = new Set([...sides.values()].flat());
      lines = lines.filter((l) => !frame.has(l));
    }
  }
  // 글자 획(제목·치수 글자)이 벽으로 잡히지 않게: PDF 글자 자리 안에 들어간 선은 뺀다
  const glyphs = input.texts.filter((t) => !t.cell);
  if (glyphs.length)
    lines = lines.filter(
      (l) =>
        !glyphs.some((t) => inside({ x: l.x1, y: l.y1 }, t, t.h * 0.3) && inside({ x: l.x2, y: l.y2 }, t, t.h * 0.3)),
    );
  if (o.mergeDouble) lines = mergeDoubleLines(lines, DOUBLE_GAP_M);
  lines = mergeCollinear(lines, 0.05).filter((l) => lenOf(l) >= o.minLenM * 0.95);

  // 책상
  let groups: DeskGroup[] = [];
  if (o.desks) {
    const desks: Desk[] = [];
    for (const t of input.texts) {
      const kind = classifyText(t.text);
      if (kind.kind === "room" || kind.kind === "space") continue;
      const text = t.text.trim();
      if (t.cell) {
        if (!text || text.length > 12 || floorName(text)) continue;
        if (t.w < 0.4 || t.h < 0.4 || t.w > 4 || t.h > 4) continue;
        desks.push({ cx: t.x + t.w / 2, cy: t.y + t.h / 2, w: t.w, h: t.h, code: kind.kind === "code" ? text : null });
      } else if (kind.kind === "code") {
        desks.push({ cx: t.x + t.w / 2, cy: t.y + t.h / 2, w: input.desk.w, h: input.desk.h, code: text });
      }
    }
    groups = groupDesks(
      desks.filter((d) => d.cx > 0 && d.cy > 0 && d.cx < W && d.cy < H),
      idPrefix,
    );
    // 책상 테두리를 벽으로 잡지 않게
    const boxes = groups.map((g) => ({ x: g.x, y: g.y, ...groupSize(g) }));
    lines = lines.filter(
      (l) => !boxes.some((b) => inside({ x: l.x1, y: l.y1 }, b, 0.06) && inside({ x: l.x2, y: l.y2 }, b, 0.06)),
    );
  }

  let capped = false;
  if (lines.length > MAX_WALLS) {
    lines = [...lines].sort((a, b) => lenOf(b) - lenOf(a)).slice(0, MAX_WALLS);
    capped = true;
  }
  lines = snapEnds(lines);

  // 선 벽 요소 → 끝점 잇기·곧게 (편집기의 선 정리와 같은 규칙)
  let elements: PlanElement[] = lines.map((l, i) => ({
    id: `${idPrefix}w${i + 1}`,
    type: "wall_line" as const,
    x: r3(l.x1),
    y: r3(l.y1),
    x2: r3(l.x2),
    y2: r3(l.y2),
    ...(l.t >= 0.15 ? { line_w: r2(Math.min(0.6, l.t)) } : {}),
  }));
  elements = tidyWalls(elements, { straightenDeg: 3, joinM: 0.3, thickness: null, rectWalls: false }).elements;
  const walls = elements.length;

  const pillars: PlanElement[] = pillarBoxes
    .filter((b) => b.x + b.w > 0 && b.y + b.h > 0 && b.x < W && b.y < H)
    .map((b, i) => ({ id: `${idPrefix}p${i + 1}`, type: "pillar" as const, ...clampBox(b, W, H) }));

  // 공간·회의실: 이름이 쓰인 방
  let spaces = 0;
  let rooms = 0;
  let guessed = 0;
  const named: PlanElement[] = [];
  if (o.spaces) {
    const grid = wallGrid(lines, W, H);
    const maxCells = Math.min(0.3 * W * H, 600) / (GRID_CELL_M * GRID_CELL_M);
    const taken: Box[] = [];
    const roomNames = new Map<string, number>();
    for (const t of input.texts) {
      const kind = classifyText(t.text);
      if (kind.kind !== "room" && kind.kind !== "space") continue;
      const center = { x: t.x + t.w / 2, y: t.y + t.h / 2 };
      if (center.x < 0 || center.y < 0 || center.x > W || center.y > H) continue;
      if (taken.some((b) => inside(center, b))) continue; // 같은 방의 두 번째 이름
      // 벽으로 둘러싸인 방 → (엑셀) 이름을 쓴 합친 칸 → 글자 둘레
      let box = roomAt(grid, center.x, center.y, maxCells);
      if (!box && t.cell && t.w >= 1.2 && t.h >= 1.2) box = { x: t.x, y: t.y, w: t.w, h: t.h };
      if (!box) {
        guessed += 1;
        const w = Math.max(t.w + 0.6, kind.kind === "room" ? 4 : 2.4);
        const h = Math.max(t.h + 0.6, kind.kind === "room" ? 3 : 1.6);
        box = { x: center.x - w / 2, y: center.y - h / 2, w, h };
      }
      const rect = clampBox(box, W, H);
      taken.push(rect);
      const label = t.text.trim().replace(/\s+/g, " ").slice(0, 50);
      if (kind.kind === "room") {
        const count = (roomNames.get(label) ?? 0) + 1;
        roomNames.set(label, count);
        // 그 방에 "8인" 같은 글자가 있으면 수용 인원
        const cap = input.texts
          .filter((x) => inside({ x: x.x + x.w / 2, y: x.y + x.h / 2 }, rect))
          .map((x) => x.text.match(/(\d{1,3})\s*(?:인|명|석|p\b|pax)/i)?.[1])
          .find(Boolean);
        const area = rect.w * rect.h;
        named.push({
          id: `${idPrefix}r${named.length + 1}`,
          type: "room",
          name: label,
          capacity: Math.min(999, Math.max(1, cap ? Number(cap) : Math.round(area / 2.5) || 4)),
          equipment: [],
          ...rect,
        });
        rooms += 1;
      } else {
        named.push({ id: `${idPrefix}s${named.length + 1}`, type: "space", kind: kind.space, label, ...rect });
        spaces += 1;
      }
    }
    // 같은 이름의 회의실은 번호를 붙인다 (게시하려면 이름이 달라야 한다)
    const seen = new Map<string, number>();
    for (const el of named) {
      if (el.type !== "room" || (roomNames.get(el.name) ?? 0) < 2) continue;
      const k = (seen.get(el.name) ?? 0) + 1;
      seen.set(el.name, k);
      el.name = `${el.name} ${k}`.slice(0, 100);
    }
  }

  const desks = groups.reduce((s, g) => s + g.cells.length, 0);
  return {
    elements: [...elements, ...pillars, ...named, ...groups],
    walls,
    pillars: pillars.length,
    spaces,
    rooms,
    desks,
    guessed,
    capped,
  };
}
