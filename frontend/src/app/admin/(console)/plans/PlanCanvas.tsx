"use client";

import {
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import office from "@/app/(app)/office.module.css";
import { labelStyle, wallLineStyle } from "@/app/(app)/PlanShapes";
import type { DeskGroup, PlanEditorData, PlanElement, PlanGeometry, PlanRect, WallLine } from "@/lib/api";
import {
  boxOf,
  boxOfAll,
  cellCenter,
  DEFAULT_LINE,
  groupSize,
  lineLength,
  lineOf,
  moveElement,
  seatDims,
  snapTo,
  SPACE_KINDS,
} from "@/lib/planGeometry";
import { joinedEnds, setEnd, type Snapped, snapMove, snapPoint, type SnapTargets, snapTargets } from "@/lib/wallSnap";
import ui from "../seating/seating.module.css";
import styles from "./plans.module.css";

export type DrawTool = "wall" | "wall_line" | "pillar" | "space" | "room" | "entrance";
export type Tool = "select" | DrawTool | "desk";
export type LinePoints = { x: number; y: number; x2: number; y2: number };

export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 6;
// − / + 버튼이 멈추는 배율 (핀치·Ctrl+휠은 그 사이 어디든)
const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6];
export const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 1000) / 1000));
const zoomStep = (zoom: number, dir: 1 | -1) =>
  dir > 0
    ? (ZOOM_STEPS.find((z) => z > zoom + 0.001) ?? ZOOM_MAX)
    : ([...ZOOM_STEPS].reverse().find((z) => z < zoom - 0.001) ?? ZOOM_MIN);

type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const MOVE_THRESHOLD_PX = 3;
const SNAP_PX = 10; // 선 벽 끝이 이음 자리에 붙는 거리 (화면 px)
const MIN_SIZE_M = 0.3;
const RULER_PX = 22; // 눈금자 두께
const MIN_CANVAS_PX = 620; // 100%일 때 도면 폭의 하한 (좁은 화면에서는 옆으로 밀어서 본다)
const RULER_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100];
const CHAIR_SIDE = { 0: "bottom", 90: "right", 180: "top", 270: "left" } as Record<number, string>;
const ORDER: Record<PlanElement["type"], number> = {
  space: 0,
  room: 1,
  wall: 2,
  wall_line: 3,
  entrance: 4,
  pillar: 5,
  desk_group: 6,
};

// Safari 트랙패드 핀치는 표준이 아닌 gesture* 이벤트로 온다
type GestureLike = Event & { scale: number; clientX: number; clientY: number };
type RectElement = Exclude<PlanElement, DeskGroup | WallLine>;
type Point = { x: number; y: number };

type Drag =
  | { kind: "draw"; start: Point; px: number; py: number; targets: SnapTargets }
  | {
      kind: "move";
      anchor: PlanElement;
      origs: PlanElement[];
      start: Point;
      px: number;
      py: number;
      moved: boolean;
      collapseTo: string | null;
      targets: SnapTargets | null; // 선 벽을 옮길 때 붙을 자리 (선 벽이 없으면 null)
    }
  | { kind: "resize"; orig: RectElement; handle: Handle; start: Point }
  // joined: 이 끝과 이어진 다른 선 벽 끝 (함께 움직인다)
  | { kind: "end"; orig: WallLine; end: 1 | 2; joined: { id: string; end: 1 | 2 }[]; targets: SnapTargets }
  | { kind: "marquee"; start: Point; px: number; py: number; additive: boolean };

type Props = {
  geometry: PlanGeometry;
  width: number;
  height: number;
  zoom: number;
  onZoom: (zoom: number) => void;
  tool: Tool;
  snap: boolean;
  readOnly: boolean;
  selectedIds: string[];
  live: PlanEditorData["live"];
  problemIds: Set<string>;
  /** 요소마다 크기(m)를 적어 보여 준다 */
  showDims: boolean;
  onSelect: (ids: string[]) => void;
  /** 그리기 도구로 끌어서 만든 사각형 (미터). 그냥 누르기만 했으면 그 점 (w = h = 0) */
  onDraw: (rect: PlanRect) => void;
  /** 선 벽 도구로 그린 선. 누르기만 했으면 시작점 = 끝점 */
  onDrawLine: (line: LinePoints) => void;
  onPlaceDesk: (point: Point) => void;
  /** 옮기거나 크기를 바꾼 요소들 (한 번에 되돌린다) */
  onChange: (els: PlanElement[]) => void;
  onCursor: (point: Point | null) => void;
  /** 고른 요소 위에 띄우는 도구 막대 (돌리기·복제·지우기 등) */
  toolbar?: (selected: PlanElement[]) => ReactNode;
};

const fmt = (v: number) => String(Math.round(v * 100) / 100);

/** 각도를 45도씩으로 맞춘다 (Shift). 가로·세로가 되면 남은 한 축은 칸에 맞춘다 */
function angleSnap(from: Point, to: Point, snap: boolean): Point {
  const len = Math.hypot(to.x - from.x, to.y - from.y);
  const step = Math.PI / 4;
  const angle = Math.round(Math.atan2(to.y - from.y, to.x - from.x) / step) * step;
  const x = Math.round((from.x + Math.cos(angle) * len) * 100) / 100;
  const y = Math.round((from.y + Math.sin(angle) * len) * 100) / 100;
  const deg = Math.round((angle * 180) / Math.PI);
  if (deg === 0 || deg === 180 || deg === -180) return { x: snapTo(x, snap), y: from.y };
  if (deg === 90 || deg === -90) return { x: from.x, y: snapTo(y, snap) };
  return { x, y };
}

/**
 * 편집 중인 도면. 미터 좌표를 도면 폭·높이 대비 %로 그린다 (직원 화면 도면과 같은 모양·크기).
 * 위·왼쪽 눈금자는 미터. 트랙패드 핀치·Ctrl+휠로 포인터 자리를 기준으로 확대·축소한다
 */
export default function PlanCanvas(props: Props) {
  const { geometry, width, height, zoom, onZoom, tool, snap, readOnly, selectedIds, live, problemIds } = props;
  const { showDims, onSelect, onDraw, onDrawLine, onPlaceDesk, onChange, onCursor, toolbar } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [previews, setPreviews] = useState<PlanElement[] | null>(null);
  const [drawRect, setDrawRect] = useState<PlanRect | null>(null);
  const [drawLine, setDrawLine] = useState<LinePoints | null>(null);
  const [marquee, setMarquee] = useState<PlanRect | null>(null);
  const [cursor, setCursor] = useState<Point | null>(null);
  const [snapHint, setSnapHint] = useState<Snapped | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  // 도구 막대가 도면 밖으로 잘리지 않게 옆으로 민다 (고른 것이 가장자리에 있을 때)
  useLayoutEffect(() => {
    const bar = barRef.current;
    const box = ref.current;
    if (!bar || !box) return;
    bar.style.marginLeft = "0px";
    const b = bar.getBoundingClientRect();
    const c = box.getBoundingClientRect();
    let shift = 0;
    if (b.right > c.right - 4) shift = c.right - 4 - b.right;
    if (b.left + shift < c.left + 4) shift = c.left + 4 - b.left;
    bar.style.marginLeft = `${shift}px`;
  });
  const [availPx, setAvailPx] = useState(900);

  // 배율 100% = 보이는 폭에 도면 폭을 맞춘다
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setAvailPx(el.clientWidth - RULER_PX));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const canvasW = Math.round(Math.max(availPx, MIN_CANVAS_PX) * zoom);
  const canvasH = Math.round((canvasW * height) / width);
  const pxPerM = canvasW / width;
  // 보이는 높이는 100%일 때의 도면 높이로 둔다: 확대하면 영역이 길어지는 대신 스크롤돼서 포인터 자리가 그대로 남는다
  const baseW = Math.max(availPx, MIN_CANVAS_PX);
  const viewH = Math.round((baseW * height) / width) + RULER_PX + (baseW > availPx ? 16 : 0);

  // 배율이 바뀌면 기준점(포인터 자리, 버튼이면 화면 가운데)이 제자리에 있도록 스크롤을 맞춘다
  const zoomRef = useRef(zoom);
  const prevZoom = useRef(zoom);
  const anchorRef = useRef<Point | null>(null);
  const onZoomRef = useRef(onZoom);
  useEffect(() => {
    onZoomRef.current = onZoom;
  });
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const prev = prevZoom.current;
    prevZoom.current = zoom;
    zoomRef.current = zoom;
    if (!el || prev === zoom) return;
    const anchor = anchorRef.current ?? { x: el.clientWidth / 2, y: el.clientHeight / 2 };
    anchorRef.current = null;
    const k = zoom / prev;
    el.scrollLeft = (el.scrollLeft + anchor.x - RULER_PX) * k + RULER_PX - anchor.x;
    el.scrollTop = (el.scrollTop + anchor.y - RULER_PX) * k + RULER_PX - anchor.y;
  }, [zoom]);

  // 트랙패드 핀치 (Chrome·Edge·Firefox는 ctrlKey가 붙은 wheel, Safari는 gesture*), Ctrl+마우스 휠.
  // 브라우저 화면 전체가 확대되지 않게 도면 영역에서만 막는다. 두 손가락 이동·휠은 그대로 스크롤
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let gestureBase: number | null = null;
    function zoomAt(next: number, clientX: number, clientY: number) {
      const rect = el!.getBoundingClientRect();
      anchorRef.current = { x: clientX - rect.left, y: clientY - rect.top };
      zoomRef.current = clampZoom(next);
      onZoomRef.current(zoomRef.current);
    }
    function onWheel(event: WheelEvent) {
      if (!(event.ctrlKey || event.metaKey) || gestureBase !== null) return;
      event.preventDefault();
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY; // 줄 단위면 픽셀로
      zoomAt(zoomRef.current * Math.exp(-Math.max(-50, Math.min(50, delta)) * 0.01), event.clientX, event.clientY);
    }
    function onGestureStart(event: Event) {
      event.preventDefault();
      gestureBase = zoomRef.current;
    }
    function onGestureChange(event: Event) {
      event.preventDefault();
      const g = event as GestureLike;
      if (gestureBase !== null) zoomAt(gestureBase * g.scale, g.clientX, g.clientY);
    }
    function onGestureEnd(event: Event) {
      event.preventDefault();
      gestureBase = null;
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("gesturestart", onGestureStart);
    el.addEventListener("gesturechange", onGestureChange);
    el.addEventListener("gestureend", onGestureEnd);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", onGestureStart);
      el.removeEventListener("gesturechange", onGestureChange);
      el.removeEventListener("gestureend", onGestureEnd);
    };
  }, []);

  const px = (v: number) => `${((v / width) * 100).toFixed(3)}%`;
  const py = (v: number) => `${((v / height) * 100).toFixed(3)}%`;
  const rectStyle = (r: PlanRect): CSSProperties => ({ left: px(r.x), top: py(r.y), width: px(r.w), height: py(r.h) });
  /** 미터 굵기 → 화면 굵기 (도면 폭이 100cqw) */
  const cq = (m: number) => `${((m / width) * 100).toFixed(4)}cqw`;
  const border = (line_w: number | undefined, min = 1): CSSProperties =>
    line_w
      ? ({ borderWidth: `max(${min}px, ${cq(line_w)})`, "--bw": `max(${min}px, ${cq(line_w)})` } as CSSProperties)
      : {};

  // 선 벽 끝 붙이기: 이음 자리(다른 선 끝·벽 모서리·벽 위·가로세로 줄)에. Shift는 45도씩, Alt는 붙이지 않고 칸에만
  const tol = SNAP_PX / pxPerM;
  const grid = (v: number) => snapTo(v, snap);
  function lineEnd(at: Point, from: Point | undefined, keys: { altKey: boolean; shiftKey: boolean }, t: SnapTargets) {
    if (from && keys.shiftKey) return { ...angleSnap(from, at, snap), kind: "none", guides: [] } as Snapped;
    if (keys.altKey) return { x: grid(at.x), y: grid(at.y), kind: "none", guides: [] } as Snapped;
    return snapPoint(at, t, tol, { from, grid });
  }

  function meters(event: PointerEvent): Point {
    const r = ref.current!.getBoundingClientRect();
    return { x: ((event.clientX - r.left) / r.width) * width, y: ((event.clientY - r.top) / r.height) * height };
  }

  const byId = (id: string) => geometry.elements.find((e) => e.id === id);
  const inside = (box: PlanRect) =>
    geometry.elements
      .filter((e) => {
        const b = boxOf(e);
        return b.x >= box.x && b.y >= box.y && b.x + b.w <= box.x + box.w && b.y + b.h <= box.y + box.h;
      })
      .map((e) => e.id);

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const at = meters(event);
    const target = event.target as Element;
    const elId = target.closest<HTMLElement>("[data-el]")?.dataset.el ?? null;
    const additive = event.ctrlKey || event.metaKey || event.shiftKey;
    const toggled = (id: string) =>
      selectedIds.includes(id) ? selectedIds.filter((s) => s !== id) : [...selectedIds, id];
    if (readOnly) {
      onSelect(elId ? (additive ? toggled(elId) : [elId]) : additive ? selectedIds : []);
      return;
    }
    if (tool === "desk") {
      onPlaceDesk({ x: snapTo(at.x, snap), y: snapTo(at.y, snap) });
      return;
    }
    ref.current!.setPointerCapture(event.pointerId);
    if (tool !== "select") {
      const targets = snapTargets(geometry.elements);
      const s = tool === "wall_line" ? lineEnd(at, undefined, event, targets) : null;
      const start = s ? { x: s.x, y: s.y } : { x: snapTo(at.x, snap), y: snapTo(at.y, snap) };
      setDrag({ kind: "draw", start, px: event.clientX, py: event.clientY, targets });
      if (tool === "wall_line") setDrawLine({ ...start, x2: start.x, y2: start.y });
      else setDrawRect({ ...start, w: 0, h: 0 });
      return;
    }
    const single = selectedIds.length === 1 ? byId(selectedIds[0]) : undefined;
    const handle = target.closest<HTMLElement>("[data-handle]")?.dataset.handle as Handle | undefined;
    if (handle && single && single.type !== "desk_group" && single.type !== "wall_line") {
      setDrag({ kind: "resize", orig: single, handle, start: at });
      return;
    }
    const end = target.closest<HTMLElement>("[data-end]")?.dataset.end;
    if (end && single?.type === "wall_line") {
      const which = end === "1" ? 1 : 2;
      // 같은 자리에 이어진 다른 선 벽 끝도 같이 옮긴다 (Alt를 누르고 끌면 이 선만 떼어 낸다)
      const joined = event.altKey ? [] : joinedEnds(geometry.elements, single, which);
      const moving = (id: string, e: 1 | 2) => id === single.id || joined.some((j) => j.id === id && j.end === e);
      setDrag({ kind: "end", orig: single, end: which, joined, targets: snapTargets(geometry.elements, moving) });
      return;
    }
    const el = elId ? byId(elId) : undefined;
    if (el && additive) {
      onSelect(toggled(el.id));
      return;
    }
    if (el) {
      const keep = selectedIds.includes(el.id);
      const ids = keep ? selectedIds : [el.id];
      if (!keep) onSelect(ids);
      const origs = geometry.elements.filter((e) => ids.includes(e.id));
      setDrag({
        kind: "move",
        anchor: el,
        origs,
        start: at,
        px: event.clientX,
        py: event.clientY,
        moved: false,
        collapseTo: keep && ids.length > 1 ? el.id : null,
        targets: origs.some((e) => e.type === "wall_line")
          ? snapTargets(geometry.elements.filter((e) => !ids.includes(e.id)))
          : null,
      });
      return;
    }
    // 빈 곳에서 끌면 사각형 안에 다 들어온 요소를 고른다 (Ctrl·Shift를 누르고 있으면 더한다)
    setDrag({ kind: "marquee", start: at, px: event.clientX, py: event.clientY, additive });
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const at = meters(event);
    setCursor(at);
    onCursor(at);
    if (!drag) {
      // 선 벽 도구: 누르기 전에도 시작점이 붙을 자리를 보여 준다
      if (tool === "wall_line" && !readOnly) setSnapHint(lineEnd(at, undefined, event, snapTargets(geometry.elements)));
      else if (snapHint) setSnapHint(null);
      return;
    }
    if (drag.kind === "draw") {
      if (tool === "wall_line") {
        const end = lineEnd(at, drag.start, event, drag.targets);
        setSnapHint(end);
        setDrawLine({ x: drag.start.x, y: drag.start.y, x2: end.x, y2: end.y });
        return;
      }
      const end = { x: snapTo(at.x, snap), y: snapTo(at.y, snap) };
      setDrawRect({
        x: Math.min(drag.start.x, end.x),
        y: Math.min(drag.start.y, end.y),
        w: Math.abs(end.x - drag.start.x),
        h: Math.abs(end.y - drag.start.y),
      });
    } else if (drag.kind === "move") {
      if (!drag.moved && Math.hypot(event.clientX - drag.px, event.clientY - drag.py) < MOVE_THRESHOLD_PX) return;
      if (!drag.moved) setDrag({ ...drag, moved: true });
      // 잡은 요소의 왼쪽 위를 칸에 맞추고, 함께 고른 요소는 같은 만큼 옮긴다
      const a = drag.anchor;
      let dx = snapTo(a.x + at.x - drag.start.x, snap) - a.x;
      let dy = snapTo(a.y + at.y - drag.start.y, snap) - a.y;
      // 선 벽 끝이 다른 벽에 가까우면 붙인다 (Alt: 붙이지 않음)
      const stick =
        drag.targets && !event.altKey
          ? snapMove(
              drag.origs.map((e) => moveElement(e, dx, dy)),
              drag.targets,
              tol,
            )
          : null;
      if (stick) {
        dx += stick.dx;
        dy += stick.dy;
      }
      setSnapHint(stick ? { ...stick.at, kind: "point", guides: [] } : null);
      setPreviews(drag.origs.map((e) => moveElement(e, dx, dy)));
    } else if (drag.kind === "resize") {
      setPreviews([resized(drag.orig, drag.handle, at.x - drag.start.x, at.y - drag.start.y, snap)]);
    } else if (drag.kind === "end") {
      const o = drag.orig;
      const fixed = drag.end === 1 ? { x: o.x2, y: o.y2 } : { x: o.x, y: o.y };
      const p = lineEnd(at, fixed, event, drag.targets);
      setSnapHint(p);
      const others = drag.joined.flatMap((j) => {
        const l = byId(j.id);
        return l?.type === "wall_line" ? [setEnd(l, j.end, p)] : [];
      });
      setPreviews([setEnd(o, drag.end, p), ...others]);
    } else {
      if (Math.hypot(event.clientX - drag.px, event.clientY - drag.py) < MOVE_THRESHOLD_PX) return;
      setMarquee({
        x: Math.min(drag.start.x, at.x),
        y: Math.min(drag.start.y, at.y),
        w: Math.abs(at.x - drag.start.x),
        h: Math.abs(at.y - drag.start.y),
      });
    }
  }

  function onPointerUp() {
    if (drag?.kind === "draw") {
      if (drawLine) onDrawLine(drawLine);
      else if (drawRect) onDraw(drawRect);
    } else if (drag?.kind === "move") {
      if (drag.moved && previews) onChange(previews);
      else if (drag.collapseTo) onSelect([drag.collapseTo]);
    } else if (drag?.kind === "marquee") {
      if (marquee) {
        const found = inside(marquee);
        onSelect(drag.additive ? [...new Set([...selectedIds, ...found])] : found);
      } else if (!drag.additive) onSelect([]);
    } else if (drag && previews) onChange(previews);
    setDrag(null);
    setPreviews(null);
    setDrawRect(null);
    setDrawLine(null);
    setMarquee(null);
    setSnapHint(null);
  }

  const previewOf = new Map((previews ?? []).map((e) => [e.id, e]));
  const shown = previews ? geometry.elements.map((e) => previewOf.get(e.id) ?? e) : geometry.elements;
  // 끄는 동안에는 사각형 안에 들어온 요소를 고른 것처럼 보여 준다
  const marked =
    drag?.kind === "marquee" && marquee
      ? new Set([...(drag.additive ? selectedIds : []), ...inside(marquee)])
      : new Set(selectedIds);
  const selected = shown.filter((e) => marked.has(e.id));
  const single = selected.length === 1 ? selected[0] : null;
  const all = boxOfAll(selected);
  // 이음 자리 점 (파워포인트 연결점처럼): 선 벽을 그리거나 끝을 끌거나 선 벽을 옮길 때
  let dots: { x: number; y: number }[] = [];
  if (!readOnly) {
    if (drag?.kind === "end") dots = drag.targets.points;
    else if (drag?.kind === "move" && drag.targets && drag.moved) dots = drag.targets.points;
    else if (tool === "wall_line" && (!drag || drag.kind === "draw"))
      dots = (drag?.kind === "draw" ? drag.targets : snapTargets(geometry.elements)).points;
  }
  const dotKeys = new Set<string>();

  return (
    <div
      ref={scrollRef}
      className={styles.canvasScroll}
      style={{ height: `min(${viewH}px, max(420px, calc(100vh - 230px)))` }}
    >
      <div
        className={styles.sheet}
        style={{ gridTemplateColumns: `${RULER_PX}px ${canvasW}px`, gridTemplateRows: `${RULER_PX}px ${canvasH}px` }}
      >
        <span className={styles.rulerCorner} aria-hidden="true">
          m
        </span>
        <Ruler axis="x" length={width} pxPerM={pxPerM} cursor={cursor?.x} band={all && [all.x, all.w]} />
        <Ruler axis="y" length={height} pxPerM={pxPerM} cursor={cursor?.y} band={all && [all.y, all.h]} />
        <div
          ref={ref}
          className={styles.canvas}
          data-tool={readOnly ? "read" : tool}
          style={
            {
              width: canvasW,
              height: canvasH,
              "--grid-x": `${(100 / width).toFixed(4)}%`,
              "--grid-y": `${(100 / height).toFixed(4)}%`,
            } as CSSProperties
          }
          role="application"
          aria-label="도면 편집 영역"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={() => {
            setCursor(null);
            onCursor(null);
            if (!drag) setSnapHint(null);
          }}
        >
          {[...shown]
            .sort((a, b) => ORDER[a.type] - ORDER[b.type])
            .map((el) => {
              const box = boxOf(el);
              const common = {
                "data-el": el.id,
                "data-selected": marked.has(el.id) || undefined,
                "data-problem": problemIds.has(el.id) || undefined,
              };
              if (el.type === "wall") {
                return (
                  <div
                    key={el.id}
                    {...common}
                    className={`${office.wall} ${styles.wall} ${styles.el}`}
                    style={{ ...rectStyle(box), ...border(el.line_w ?? DEFAULT_LINE.wall, 2) }}
                  >
                    {(["t", "r", "b", "l"] as const).map((edge) => (
                      <i key={edge} data-edge={edge} />
                    ))}
                  </div>
                );
              }
              if (el.type === "wall_line") {
                const thick = `max(2px, ${cq(lineOf(el))})`;
                return (
                  <div
                    key={el.id}
                    {...common}
                    className={`${office.wallLine} ${styles.lineEl} ${styles.el}`}
                    style={wallLineStyle(
                      px(el.x),
                      py(el.y),
                      px(lineLength(el)),
                      thick,
                      Math.atan2(el.y2 - el.y, el.x2 - el.x),
                    )}
                  >
                    <i aria-hidden="true" />
                  </div>
                );
              }
              if (el.type === "pillar")
                return (
                  <div key={el.id} {...common} className={`${office.pillar} ${styles.el}`} style={rectStyle(box)} />
                );
              if (el.type === "space") {
                return (
                  <div
                    key={el.id}
                    {...common}
                    className={`${office.space} ${styles.el}`}
                    data-kind={el.kind}
                    style={{ ...rectStyle(box), ...border(el.line_w) }}
                  >
                    <span style={labelStyle(el)}>{el.label || SPACE_KINDS.find((k) => k.kind === el.kind)?.label}</span>
                  </div>
                );
              }
              if (el.type === "entrance") {
                return (
                  <div
                    key={el.id}
                    {...common}
                    className={`${office.entrance} ${styles.el}`}
                    data-main={el.main}
                    style={{ ...rectStyle(box), ...border(el.line_w) }}
                  >
                    <span style={labelStyle(el)}>{el.label || (el.main ? "주 출입구" : "출입구")}</span>
                  </div>
                );
              }
              if (el.type === "room") {
                const upcoming = live.rooms[el.id]?.upcoming ?? 0;
                return (
                  <div
                    key={el.id}
                    {...common}
                    className={`${styles.room} ${styles.el}`}
                    style={{ ...rectStyle(box), ...border(el.line_w) }}
                  >
                    <span style={labelStyle(el)}>
                      {el.name || "이름 없는 회의실"}
                      <br />
                      <small>
                        {el.capacity}인{upcoming > 0 && ` · 예약 ${upcoming}`}
                      </small>
                    </span>
                  </div>
                );
              }
              const size = seatDims(el);
              return (
                <div key={el.id} {...common} className={`${styles.desks} ${styles.el}`} style={rectStyle(box)}>
                  {el.cells.map((cell, i) => {
                    const c = cellCenter(el, Math.floor(i / el.cols), i % el.cols);
                    const seat = live.seats[cell.id];
                    const style: CSSProperties = {
                      left: `${(((c.x - size.w / 2 - box.x) / box.w) * 100).toFixed(3)}%`,
                      top: `${(((c.y - size.h / 2 - box.y) / box.h) * 100).toFixed(3)}%`,
                      width: `${((size.w / box.w) * 100).toFixed(3)}%`,
                      height: `${((size.h / box.h) * 100).toFixed(3)}%`,
                    };
                    return (
                      <span
                        key={cell.id}
                        className={styles.desk}
                        data-blank={!cell.desk || undefined}
                        data-new={(cell.desk && !seat) || undefined}
                        data-chair={CHAIR_SIDE[c.rotation]}
                        data-vertical={size.h > size.w || undefined}
                        data-color={seat?.color_key ?? "t0"}
                        style={style}
                        title={
                          cell.desk
                            ? `${cell.code}${seat?.occupant ? ` · ${seat.occupant}` : seat ? " · 빈 자리" : " · 새 책상"}`
                            : "빈칸"
                        }
                      >
                        {cell.desk ? (
                          <>
                            {seat?.occupant && <i aria-hidden="true" />}
                            {cell.code}
                          </>
                        ) : (
                          "빈칸"
                        )}
                      </span>
                    );
                  })}
                </div>
              );
            })}

          {showDims &&
            shown.map((el) => {
              if (el.type === "pillar") return null;
              if (el.type === "wall_line") {
                return (
                  <span
                    key={`dim-${el.id}`}
                    className={styles.dimTag}
                    data-at="center"
                    style={{ left: px((el.x + el.x2) / 2), top: py((el.y + el.y2) / 2) }}
                  >
                    {fmt(lineLength(el))} m
                  </span>
                );
              }
              const b = el.type === "desk_group" ? { x: el.x, y: el.y, ...groupSize(el) } : boxOf(el);
              return (
                <span key={`dim-${el.id}`} className={styles.dimTag} style={{ left: px(b.x), top: py(b.y) }}>
                  {fmt(b.w)} × {fmt(b.h)}
                </span>
              );
            })}

          {selected
            .filter((e) => e.type !== "wall_line")
            .map((e) => (
              <div key={`sel-${e.id}`} className={styles.selection} style={rectStyle(boxOf(e))}>
                {!readOnly &&
                  single === e &&
                  e.type !== "desk_group" &&
                  HANDLES.map((h) => <span key={h} className={styles.handle} data-handle={h} aria-hidden="true" />)}
              </div>
            ))}
          {!readOnly && single?.type === "wall_line" && (
            <>
              <span className={styles.endHandle} data-end="1" style={{ left: px(single.x), top: py(single.y) }} />
              <span className={styles.endHandle} data-end="2" style={{ left: px(single.x2), top: py(single.y2) }} />
            </>
          )}
          {selected.length > 1 && all && <div className={styles.groupBox} style={rectStyle(all)} aria-hidden="true" />}
          {all && !drawRect && !drawLine && (
            <span
              className={styles.dimBadge}
              style={{ left: px(all.x), top: py(all.y + all.h) }}
              aria-label="고른 것의 크기"
            >
              {single?.type === "wall_line"
                ? `길이 ${fmt(lineLength(single))} m`
                : `${fmt(all.w)} × ${fmt(all.h)} m${selected.length > 1 ? ` · ${selected.length}개` : ""}`}
            </span>
          )}

          {drawRect && (drawRect.w > 0 || drawRect.h > 0) && (
            <div className={styles.drawing} style={rectStyle(drawRect)} aria-hidden="true">
              <span>
                {drawRect.w.toFixed(1)} × {drawRect.h.toFixed(1)} m
              </span>
            </div>
          )}
          {drawLine && lineLength(drawLine) > 0 && (
            <>
              <div
                className={styles.drawingLine}
                style={{
                  left: px(drawLine.x),
                  top: py(drawLine.y),
                  width: px(lineLength(drawLine)),
                  transform: `rotate(${Math.atan2(drawLine.y2 - drawLine.y, drawLine.x2 - drawLine.x).toFixed(5)}rad)`,
                }}
                aria-hidden="true"
              />
              <span className={styles.dimBadge} style={{ left: px(drawLine.x2), top: py(drawLine.y2) }}>
                {lineLength(drawLine).toFixed(2)} m
              </span>
            </>
          )}
          {marquee && <div className={styles.marquee} style={rectStyle(marquee)} aria-hidden="true" />}

          {dots.map((p) => {
            const key = `${p.x},${p.y}`;
            if (dotKeys.has(key)) return null;
            dotKeys.add(key);
            return (
              <span key={key} className={styles.connDot} style={{ left: px(p.x), top: py(p.y) }} aria-hidden="true" />
            );
          })}
          {snapHint?.guides.map((g, i) => (
            <span
              key={`guide-${i}`}
              className={styles.snapGuide}
              style={{
                left: px(Math.min(g.a.x, g.b.x)),
                top: py(Math.min(g.a.y, g.b.y)),
                width: px(Math.abs(g.b.x - g.a.x)),
                height: py(Math.abs(g.b.y - g.a.y)),
              }}
              aria-hidden="true"
            />
          ))}
          {snapHint && (snapHint.kind === "point" || snapHint.kind === "edge") && (
            <span
              className={styles.snapRing}
              data-kind={snapHint.kind}
              style={{ left: px(snapHint.x), top: py(snapHint.y) }}
              aria-hidden="true"
            />
          )}

          {toolbar && all && !drag && (
            <div
              ref={barRef}
              className={styles.floatBar}
              data-below={all.y < height * 0.12 || undefined}
              style={{ left: px(all.x + all.w / 2), top: py(all.y < height * 0.12 ? all.y + all.h : all.y) }}
              role="toolbar"
              aria-label="고른 요소 도구"
              onPointerDown={(event) => event.stopPropagation()}
            >
              {toolbar(selected)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** 눈금자: 큰 눈금 사이가 48px 이상이 되는 깔끔한 간격(m). 포인터 자리와 고른 것의 범위를 표시한다 */
function Ruler({
  axis,
  length,
  pxPerM,
  cursor,
  band,
}: {
  axis: "x" | "y";
  length: number;
  pxPerM: number;
  cursor?: number;
  band: [number, number] | null;
}) {
  const major = RULER_STEPS.find((s) => s * pxPerM >= 48) ?? RULER_STEPS[RULER_STEPS.length - 1];
  const minor = [major / 10, major / 5, major / 2].find((s) => s * pxPerM >= 6) ?? major;
  const count = Math.floor(length / minor + 1e-6);
  const pos = (m: number) => (axis === "x" ? { left: m * pxPerM } : { top: m * pxPerM });
  const ticks = [];
  for (let i = 0; i <= count; i++) {
    const m = Math.round(i * minor * 1000) / 1000;
    const isMajor = Math.abs(m / major - Math.round(m / major)) < 1e-6;
    ticks.push(<i key={i} data-major={isMajor || undefined} style={pos(m)} />);
    if (isMajor) {
      ticks.push(
        <span key={`l${i}`} style={pos(m)}>
          {major < 1 ? m.toFixed(1) : m}
        </span>,
      );
    }
  }
  return (
    <div className={styles.ruler} data-axis={axis} aria-hidden="true">
      {band && (
        <em
          style={
            axis === "x"
              ? { left: band[0] * pxPerM, width: band[1] * pxPerM }
              : { top: band[0] * pxPerM, height: band[1] * pxPerM }
          }
        />
      )}
      {ticks}
      {cursor !== undefined && cursor >= 0 && cursor <= length && <b style={pos(cursor)} />}
    </div>
  );
}

/** − / 배율 / + 단추 */
export function ZoomControls({ zoom, onZoom }: { zoom: number; onZoom: (zoom: number) => void }) {
  return (
    <div className={ui.zoom} role="group" aria-label="확대·축소" title="트랙패드 핀치나 Ctrl+휠로도 확대·축소해요">
      <button type="button" aria-label="축소" disabled={zoom <= ZOOM_MIN} onClick={() => onZoom(zoomStep(zoom, -1))}>
        −
      </button>
      <button type="button" aria-label="원래 크기" onClick={() => onZoom(1)}>
        {Math.round(zoom * 100)}%
      </button>
      <button type="button" aria-label="확대" disabled={zoom >= ZOOM_MAX} onClick={() => onZoom(zoomStep(zoom, 1))}>
        +
      </button>
    </div>
  );
}

/** 손잡이로 크기 바꾸기. 반대쪽 모서리는 그대로 두고, 너무 작아지지 않게 */
function resized(orig: RectElement, handle: Handle, dx: number, dy: number, snap: boolean): PlanElement {
  let { x, y, w, h } = orig;
  const right = x + w;
  const bottom = y + h;
  if (handle.includes("w")) x = Math.min(snapTo(orig.x + dx, snap), right - MIN_SIZE_M);
  if (handle.includes("e")) w = Math.max(snapTo(right + dx, snap) - x, MIN_SIZE_M);
  if (handle.includes("n")) y = Math.min(snapTo(orig.y + dy, snap), bottom - MIN_SIZE_M);
  if (handle.includes("s")) h = Math.max(snapTo(bottom + dy, snap) - y, MIN_SIZE_M);
  if (handle.includes("w")) w = right - x;
  if (handle.includes("n")) h = bottom - y;
  return { ...orig, x, y, w, h };
}
