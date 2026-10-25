// 선 벽 잇기: 그리거나 끝점을 끌 때 가까운 이음 자리에 붙이고(파워포인트의 연결점처럼), "선 정리"로 도면 전체의
// 삐뚤어진 선을 곧게 펴고 벌어진 끝점을 잇는다. 좌표는 미터

import type { PlanElement, WallLine } from "./api";
import { DEFAULT_LINE } from "./planGeometry";

export type Pt = { x: number; y: number };
export type Seg = { a: Pt; b: Pt };
/** 붙을 수 있는 자리: 점(선 벽 끝, 벽 모서리)과 선(선 벽, 벽 가운데 선) */
export type SnapTargets = { points: Pt[]; segs: Seg[] };
/** point: 끝점·모서리에 붙음, edge: 선 위에 붙음, axis: 다른 점과 가로·세로 줄을 맞춤 */
export type Snapped = Pt & { kind: "point" | "edge" | "axis" | "none"; guides: Seg[] };

const r2 = (v: number) => Math.round(v * 100) / 100;
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const SAME_M = 0.015; // 이만큼 가까우면 같은 점 (이어진 끝)

/** 벽(사각형) 띠의 가운데 선. 선 벽이 여기서 끝나면 네모 끝이 벽 밖으로 삐져나오지 않는다 */
function wallCenter(el: Extract<PlanElement, { type: "wall" }>): Pt[] {
  const t = Math.min(el.line_w ?? DEFAULT_LINE.wall ?? 0.3, el.w / 2, el.h / 2) / 2;
  const x1 = r2(el.x + t);
  const y1 = r2(el.y + t);
  const x2 = r2(el.x + el.w - t);
  const y2 = r2(el.y + el.h - t);
  return [
    { x: x1, y: y1 },
    { x: x2, y: y1 },
    { x: x2, y: y2 },
    { x: x1, y: y2 },
  ];
}

const ends = (l: WallLine): [Pt, Pt] => [
  { x: l.x, y: l.y },
  { x: l.x2, y: l.y2 },
];

/** 이음 자리 모으기. moving(id, 끝)이 참인 선 끝은 같이 움직이므로 빼고, 그 선도 붙을 선에서 뺀다 */
export function snapTargets(
  elements: PlanElement[],
  moving: (id: string, end: 1 | 2) => boolean = () => false,
): SnapTargets {
  const points: Pt[] = [];
  const segs: Seg[] = [];
  for (const el of elements) {
    if (el.type === "wall_line") {
      const [a, b] = ends(el);
      const ma = moving(el.id, 1);
      const mb = moving(el.id, 2);
      if (!ma) points.push(a);
      if (!mb) points.push(b);
      if (!ma && !mb) segs.push({ a, b });
    } else if (el.type === "wall") {
      const c = wallCenter(el);
      points.push(...c);
      for (let i = 0; i < 4; i++) segs.push({ a: c[i], b: c[(i + 1) % 4] });
    }
  }
  return { points, segs };
}

/** 선분 위에서 p에 가장 가까운 점 (선분 밖이면 null) */
function foot(p: Pt, s: Seg): Pt | null {
  const dx = s.b.x - s.a.x;
  const dy = s.b.y - s.a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-9) return null;
  const t = ((p.x - s.a.x) * dx + (p.y - s.a.y) * dy) / len2;
  if (t < 0 || t > 1) return null;
  return { x: s.a.x + t * dx, y: s.a.y + t * dy };
}

/** 선분이 가로줄 y(또는 세로줄 x)와 만나는 점 */
function crossAt(s: Seg, axis: "x" | "y", v: number): Pt | null {
  const [a, b] = [s.a, s.b];
  const other = axis === "y" ? "x" : "y";
  if (Math.abs(b[axis] - a[axis]) < 1e-9) return null;
  const t = (v - a[axis]) / (b[axis] - a[axis]);
  if (t < 0 || t > 1) return null;
  return { [axis]: v, [other]: a[other] + t * (b[other] - a[other]) } as Pt;
}

/**
 * p를 가까운 이음 자리에 붙인다. tol: 붙는 거리(m, 화면 몇 px를 미터로 바꾼 값).
 * 순서: 끝점·모서리 → 선 위(반대쪽 끝과 가로·세로가 맞으면 그 줄 위) → 다른 점과 가로·세로 줄 맞춤 → grid(칸 맞추기)
 */
export function snapPoint(
  p: Pt,
  targets: SnapTargets,
  tol: number,
  opts: { from?: Pt; grid: (v: number) => number },
): Snapped {
  let best: Pt | null = null;
  let bd = tol;
  for (const q of targets.points) {
    const d = dist(p, q);
    if (d <= bd) {
      bd = d;
      best = q;
    }
  }
  if (best) return { x: best.x, y: best.y, kind: "point", guides: [] };

  const { from } = opts;
  let edge: Pt | null = null;
  bd = tol;
  for (const s of targets.segs) {
    let f = foot(p, s);
    if (!f || dist(f, p) > bd) continue;
    // 반대쪽 끝과 거의 가로(세로)면 그 줄이 이 선과 만나는 점으로: 곧은 선이 벽에 딱 붙는다
    if (from && Math.abs(p.y - from.y) <= tol) f = crossAt(s, "y", from.y) ?? f;
    else if (from && Math.abs(p.x - from.x) <= tol) f = crossAt(s, "x", from.x) ?? f;
    bd = dist(f, p);
    edge = f;
  }
  if (edge) return { x: r2(edge.x), y: r2(edge.y), kind: "edge", guides: [] };

  // 가로·세로 줄 맞춤: 반대쪽 끝을 먼저 본다 (곧은 선)
  let rx: Pt | null = null;
  let ry: Pt | null = null;
  let bx = tol;
  let by = tol;
  for (const q of from ? [from, ...targets.points] : targets.points) {
    const ddx = Math.abs(q.x - p.x) * (q === from ? 0.5 : 1);
    const ddy = Math.abs(q.y - p.y) * (q === from ? 0.5 : 1);
    if (ddx < bx) {
      bx = ddx;
      rx = q;
    }
    if (ddy < by) {
      by = ddy;
      ry = q;
    }
  }
  const x = rx ? rx.x : opts.grid(p.x);
  const y = ry ? ry.y : opts.grid(p.y);
  const guides: Seg[] = [];
  if (rx) guides.push({ a: rx, b: { x, y } });
  if (ry) guides.push({ a: ry, b: { x, y } });
  return { x, y, kind: rx || ry ? "axis" : "none", guides };
}

/** 이 선 끝과 같은 자리에 있는 다른 선 벽의 끝 (끝점을 끌면 함께 움직여 벽이 이어진 채로 남는다) */
export function joinedEnds(elements: PlanElement[], line: WallLine, end: 1 | 2): { id: string; end: 1 | 2 }[] {
  const p = ends(line)[end - 1];
  const out: { id: string; end: 1 | 2 }[] = [];
  for (const el of elements) {
    if (el.type !== "wall_line" || el.id === line.id) continue;
    const [a, b] = ends(el);
    if (dist(a, p) <= SAME_M) out.push({ id: el.id, end: 1 });
    else if (dist(b, p) <= SAME_M) out.push({ id: el.id, end: 2 });
  }
  return out;
}

/** 선 벽 끝 하나를 p로 */
export const setEnd = (l: WallLine, end: 1 | 2, p: Pt): WallLine =>
  end === 1 ? { ...l, x: p.x, y: p.y } : { ...l, x2: p.x, y2: p.y };

/**
 * 고른 것을 통째로 옮길 때: 옮기는 선 벽의 끝 중 하나가 이음 자리에 가까우면 그만큼 더 옮겨 붙인다.
 * 돌려주는 값은 더 옮길 거리와 붙은 자리
 */
export function snapMove(
  moved: PlanElement[],
  targets: SnapTargets,
  tol: number,
): { dx: number; dy: number; at: Pt } | null {
  let best: { dx: number; dy: number; at: Pt } | null = null;
  let bd = tol;
  for (const el of moved) {
    if (el.type !== "wall_line") continue;
    for (const p of ends(el)) {
      for (const q of targets.points) {
        const d = dist(p, q);
        if (d <= bd) {
          bd = d;
          best = { dx: q.x - p.x, dy: q.y - p.y, at: q };
        }
      }
      for (const s of targets.segs) {
        const f = foot(p, s);
        if (f && dist(f, p) < bd) {
          bd = dist(f, p);
          best = { dx: f.x - p.x, dy: f.y - p.y, at: f };
        }
      }
    }
  }
  return best;
}

/** 가로·세로로 곧게: 시작점은 두고 더 가까운 축으로 */
export function straighten(l: WallLine): WallLine {
  return Math.abs(l.x2 - l.x) >= Math.abs(l.y2 - l.y) ? { ...l, y2: l.y } : { ...l, x2: l.x };
}

// 선 정리 ------------------------------------------------------------------------------------------

export type TidyOptions = {
  /** 이 각도(도) 안으로 기운 선은 가로·세로로 곧게 */
  straightenDeg: number;
  /** 이만큼(m) 가까운 끝점끼리, 또는 벽 가운데 선에 잇는다 */
  joinM: number;
  /** 정하면 선 벽 굵기를 모두 이 값(m)으로 */
  thickness: number | null;
  /** thickness를 벽(사각형)에도 */
  rectWalls: boolean;
  /** 이 선들만 (없으면 도면의 선 벽 모두) */
  only?: Set<string>;
};

export type TidyResult = {
  elements: PlanElement[];
  straightened: number; // 곧게 편 선
  joined: number; // 이은 끝점 자리
  moved: number; // 바뀐 선
  removed: number; // 너무 짧아져 지운 선
  thickened: number; // 굵기를 바꾼 요소
};

const MIN_LINE_M = 0.05; // 서버가 받는 가장 짧은 선

class UnionFind {
  parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]];
      i = this.parent[i];
    }
    return i;
  }
  union(a: number, b: number) {
    this.parent[this.find(a)] = this.find(b);
  }
}

/**
 * 선 정리. 1) 가까운 끝점을 한 점으로 모으고 2) 거의 가로·세로인 선의 양 끝을 같은 y(x)로 맞추고
 * 3) 벽(사각형)·범위 밖 선 벽 끝 가까이 있으면 거기에 붙이고 4) 다른 곧은 선 가운데에 닿을 듯한 끝은 그 선 위로(T자).
 * 선이 서로 이어진 채로 곧게 펴지도록, 같은 x(y)를 써야 하는 끝점을 묶어 한 값으로 정한다
 */
export function tidyWalls(elements: PlanElement[], opts: TidyOptions): TidyResult {
  const scope = elements.filter((e): e is WallLine => e.type === "wall_line" && (!opts.only || opts.only.has(e.id)));
  const inScope = new Set(scope.map((l) => l.id));
  const fixed = snapTargets(
    elements.filter((e) => e.type === "wall" || (e.type === "wall_line" && !inScope.has(e.id))),
  );
  const nodes = scope.flatMap((l) => ends(l));
  const n = nodes.length;

  // 1) 가까운 끝점 모으기
  const near = new UnionFind(n);
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) if (dist(nodes[i], nodes[j]) <= opts.joinM) near.union(i, j);
  const clusterOf = nodes.map((_, i) => near.find(i));
  const clusters = [...new Set(clusterOf)];
  const members = new Map(clusters.map((c) => [c, nodes.flatMap((_, i) => (clusterOf[i] === c ? [i] : []))]));
  const center = new Map(
    clusters.map((c) => {
      const m = members.get(c)!;
      return [
        c,
        { x: m.reduce((s, i) => s + nodes[i].x, 0) / m.length, y: m.reduce((s, i) => s + nodes[i].y, 0) / m.length },
      ];
    }),
  );
  let joined = 0;
  for (const c of clusters) {
    const m = members.get(c)!;
    if (m.length > 1 && m.some((i) => dist(nodes[i], nodes[m[0]]) > 0.005)) joined += 1;
  }

  // 3) 벽·범위 밖 선에 붙일 값 (끝점 자리마다 고정 x·y)
  const fx = new Map<number, number>();
  const fy = new Map<number, number>();
  for (const c of clusters) {
    const p = center.get(c)!;
    const q = fixed.points.find((pt) => dist(pt, p) <= opts.joinM);
    if (q) {
      fx.set(c, q.x);
      fy.set(c, q.y);
      continue;
    }
    for (const s of fixed.segs) {
      const f = foot(p, s);
      if (!f || dist(f, p) > opts.joinM) continue;
      if (Math.abs(s.a.x - s.b.x) < 1e-6) fx.set(c, s.a.x);
      else if (Math.abs(s.a.y - s.b.y) < 1e-6) fy.set(c, s.a.y);
      break;
    }
  }

  // 2) 곧게: 가로 선은 양 끝 자리가 같은 y, 세로 선은 같은 x
  const tan = Math.tan((opts.straightenDeg * Math.PI) / 180);
  const xs = new UnionFind(n);
  const ys = new UnionFind(n);
  const orient = new Map<string, "h" | "v" | null>();
  let straightened = 0;
  scope.forEach((l, k) => {
    const a = clusterOf[2 * k];
    const b = clusterOf[2 * k + 1];
    const dx = Math.abs(l.x2 - l.x);
    const dy = Math.abs(l.y2 - l.y);
    const o = dy <= dx * tan ? "h" : dx <= dy * tan ? "v" : null;
    orient.set(l.id, o);
    if (o === "h") ys.union(a, b);
    if (o === "v") xs.union(a, b);
    if (o && (o === "h" ? dy : dx) > 0.005) straightened += 1;
  });
  const value = (uf: UnionFind, fixedMap: Map<number, number>, axis: "x" | "y") => {
    const groups = new Map<number, number[]>();
    for (const c of clusters) groups.set(uf.find(c), [...(groups.get(uf.find(c)) ?? []), c]);
    const out = new Map<number, number>();
    for (const g of groups.values()) {
      const pinned = g.filter((c) => fixedMap.has(c)).map((c) => fixedMap.get(c)!);
      const v = pinned.length
        ? pinned.reduce((s, x) => s + x, 0) / pinned.length
        : g.reduce((s, c) => s + center.get(c)![axis], 0) / g.length;
      for (const c of g) out.set(c, r2(v));
    }
    return out;
  };
  const gx = value(xs, fx, "x");
  const gy = value(ys, fy, "y");
  const pos = new Map(clusters.map((c) => [c, { x: gx.get(c)!, y: gy.get(c)! }]));

  // 4) T자: 혼자인 끝이 다른 곧은 선 가운데에 닿을 듯하면 그 선 위로 (자기 선과 수직일 때만, 곧음이 깨지지 않게)
  const placed = scope.map((l, k) => ({ l, a: pos.get(clusterOf[2 * k])!, b: pos.get(clusterOf[2 * k + 1])! }));
  for (const c of clusters) {
    const m = members.get(c)!;
    if (m.length > 1 || fx.has(c) || fy.has(c)) continue;
    const own = orient.get(scope[Math.floor(m[0] / 2)].id);
    const p = pos.get(c)!;
    for (const other of placed) {
      if (other.l.id === scope[Math.floor(m[0] / 2)].id) continue;
      const o = orient.get(other.l.id);
      if (!o || o === own) continue;
      const f = foot(p, { a: other.a, b: other.b });
      if (!f || dist(f, p) > opts.joinM) continue;
      if (o === "h") p.y = other.a.y;
      else p.x = other.a.x;
      joined += 1;
      break;
    }
  }

  // 새 선
  let moved = 0;
  let removed = 0;
  const next = new Map<string, WallLine | null>();
  scope.forEach((l, k) => {
    const a = pos.get(clusterOf[2 * k])!;
    const b = pos.get(clusterOf[2 * k + 1])!;
    if (dist(a, b) < MIN_LINE_M) {
      next.set(l.id, null);
      removed += 1;
      return;
    }
    const changed = dist(a, { x: l.x, y: l.y }) > 0.004 || dist(b, { x: l.x2, y: l.y2 }) > 0.004;
    if (changed) moved += 1;
    next.set(l.id, { ...l, x: a.x, y: a.y, x2: b.x, y2: b.y });
  });

  let thickened = 0;
  const out: PlanElement[] = [];
  for (const el of elements) {
    let e: PlanElement | null = el;
    if (el.type === "wall_line" && next.has(el.id)) e = next.get(el.id)!;
    if (e && opts.thickness !== null) {
      const on = (e.type === "wall_line" && next.has(e.id)) || (opts.rectWalls && e.type === "wall");
      if (on && (e as { line_w?: number }).line_w !== opts.thickness) {
        e = { ...e, line_w: opts.thickness } as PlanElement;
        thickened += 1;
      }
    }
    if (e) out.push(e);
  }
  return { elements: out, straightened, joined, moved, removed, thickened };
}
