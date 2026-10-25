"use client";

import { type CSSProperties, type PointerEvent, useRef, useState } from "react";
import office from "@/app/(app)/office.module.css";
import type { PlanEditorData, PlanElement, PlanGeometry, PlanRect } from "@/lib/api";
import { boxOf, cellCenter, DESK, snapTo, SPACE_KINDS } from "@/lib/planGeometry";
import styles from "./plans.module.css";

export type DrawTool = "wall" | "pillar" | "space" | "room";
export type Tool = "select" | DrawTool | "desk";

type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const MOVE_THRESHOLD_PX = 3;
const MIN_SIZE_M = 0.3;

type Drag =
  | { kind: "draw"; start: { x: number; y: number }; px: number; py: number }
  | { kind: "move"; orig: PlanElement; start: { x: number; y: number }; px: number; py: number; moved: boolean }
  | { kind: "resize"; orig: PlanElement & PlanRect; handle: Handle; start: { x: number; y: number } };

type Props = {
  geometry: PlanGeometry;
  width: number;
  height: number;
  zoom: number;
  tool: Tool;
  snap: boolean;
  readOnly: boolean;
  selectedId: string | null;
  live: PlanEditorData["live"];
  problemIds: Set<string>;
  onSelect: (id: string | null) => void;
  /** 그리기 도구로 끌어서 만든 사각형 (미터). 그냥 누르기만 했으면 그 점 (w = h = 0) */
  onDraw: (rect: PlanRect) => void;
  onPlaceDesk: (point: { x: number; y: number }) => void;
  onChange: (el: PlanElement) => void;
  onCursor: (point: { x: number; y: number } | null) => void;
};

/** 편집 중인 도면. 미터 좌표를 도면 폭·높이 대비 %로 그린다 (직원 화면 도면과 같은 모양·크기) */
export default function PlanCanvas(props: Props) {
  const { geometry, width, height, zoom, tool, snap, readOnly, selectedId, live, problemIds } = props;
  const { onSelect, onDraw, onPlaceDesk, onChange, onCursor } = props;
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [preview, setPreview] = useState<PlanElement | null>(null);
  const [drawRect, setDrawRect] = useState<PlanRect | null>(null);

  const px = (v: number) => `${((v / width) * 100).toFixed(3)}%`;
  const py = (v: number) => `${((v / height) * 100).toFixed(3)}%`;
  const rectStyle = (r: PlanRect): CSSProperties => ({ left: px(r.x), top: py(r.y), width: px(r.w), height: py(r.h) });

  function meters(event: PointerEvent): { x: number; y: number } {
    const r = ref.current!.getBoundingClientRect();
    return { x: ((event.clientX - r.left) / r.width) * width, y: ((event.clientY - r.top) / r.height) * height };
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const at = meters(event);
    const target = event.target as Element;
    const elId = target.closest<HTMLElement>("[data-el]")?.dataset.el ?? null;
    if (readOnly) {
      onSelect(elId);
      return;
    }
    if (tool === "desk") {
      onPlaceDesk({ x: snapTo(at.x, snap), y: snapTo(at.y, snap) });
      return;
    }
    ref.current!.setPointerCapture(event.pointerId);
    if (tool !== "select") {
      const start = { x: snapTo(at.x, snap), y: snapTo(at.y, snap) };
      setDrag({ kind: "draw", start, px: event.clientX, py: event.clientY });
      setDrawRect({ ...start, w: 0, h: 0 });
      return;
    }
    const handle = target.closest<HTMLElement>("[data-handle]")?.dataset.handle as Handle | undefined;
    const selected = geometry.elements.find((e) => e.id === selectedId);
    if (handle && selected && selected.type !== "desk_group") {
      setDrag({ kind: "resize", orig: selected, handle, start: at });
      return;
    }
    const el = geometry.elements.find((e) => e.id === elId);
    onSelect(el?.id ?? null);
    if (el) setDrag({ kind: "move", orig: el, start: at, px: event.clientX, py: event.clientY, moved: false });
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const at = meters(event);
    onCursor({ x: at.x, y: at.y });
    if (!drag) return;
    if (drag.kind === "draw") {
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
      setPreview({
        ...drag.orig,
        x: snapTo(drag.orig.x + at.x - drag.start.x, snap),
        y: snapTo(drag.orig.y + at.y - drag.start.y, snap),
      });
    } else {
      setPreview(resized(drag.orig, drag.handle, at.x - drag.start.x, at.y - drag.start.y, snap));
    }
  }

  function onPointerUp() {
    if (drag?.kind === "draw" && drawRect) onDraw(drawRect);
    else if (drag && drag.kind !== "draw" && preview) onChange(preview);
    setDrag(null);
    setPreview(null);
    setDrawRect(null);
  }

  const shown = preview ? geometry.elements.map((e) => (e.id === preview.id ? preview : e)) : geometry.elements;
  const selected = shown.find((e) => e.id === selectedId) ?? null;
  const order = { space: 0, room: 1, wall: 2, pillar: 3, desk_group: 4 } as const;

  return (
    <div className={styles.canvasScroll}>
      <div
        ref={ref}
        className={styles.canvas}
        data-tool={readOnly ? "read" : tool}
        style={
          {
            aspectRatio: `${width} / ${height}`,
            "--zoom": zoom,
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
        onPointerLeave={() => onCursor(null)}
      >
        {[...shown]
          .sort((a, b) => order[a.type] - order[b.type])
          .map((el) => {
            const box = boxOf(el);
            const common = {
              "data-el": el.id,
              "data-selected": el.id === selectedId || undefined,
              "data-problem": problemIds.has(el.id) || undefined,
            };
            if (el.type === "wall") {
              return (
                <div
                  key={el.id}
                  {...common}
                  className={`${office.wall} ${styles.wall} ${styles.el}`}
                  style={rectStyle(box)}
                >
                  {(["t", "r", "b", "l"] as const).map((edge) => (
                    <i key={edge} data-edge={edge} />
                  ))}
                </div>
              );
            }
            if (el.type === "pillar")
              return <div key={el.id} {...common} className={`${office.pillar} ${styles.el}`} style={rectStyle(box)} />;
            if (el.type === "space") {
              return (
                <div
                  key={el.id}
                  {...common}
                  className={`${office.space} ${styles.el}`}
                  data-kind={el.kind}
                  style={rectStyle(box)}
                >
                  <span>{el.label || SPACE_KINDS.find((k) => k.kind === el.kind)?.label}</span>
                </div>
              );
            }
            if (el.type === "room") {
              const upcoming = live.rooms[el.id]?.upcoming ?? 0;
              return (
                <div key={el.id} {...common} className={`${styles.room} ${styles.el}`} style={rectStyle(box)}>
                  <span>
                    {el.name || "이름 없는 회의실"}
                    <br />
                    <small>
                      {el.capacity}인{upcoming > 0 && ` · 예약 ${upcoming}`}
                    </small>
                  </span>
                </div>
              );
            }
            return (
              <div key={el.id} {...common} className={`${styles.desks} ${styles.el}`} style={rectStyle(box)}>
                {el.cells.map((cell, i) => {
                  const c = cellCenter(el, Math.floor(i / el.cols), i % el.cols);
                  const seat = live.seats[cell.id];
                  const style: CSSProperties = {
                    left: `${(((c.x - DESK.w / 2 - box.x) / box.w) * 100).toFixed(3)}%`,
                    top: `${(((c.y - DESK.h / 2 - box.y) / box.h) * 100).toFixed(3)}%`,
                    width: `${((DESK.w / box.w) * 100).toFixed(3)}%`,
                    height: `${((DESK.h / box.h) * 100).toFixed(3)}%`,
                  };
                  return (
                    <span
                      key={cell.id}
                      className={styles.desk}
                      data-blank={!cell.desk || undefined}
                      data-new={(cell.desk && !seat) || undefined}
                      data-chair={c.rotation === 180 ? "top" : "bottom"}
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
        {selected && (
          <div className={styles.selection} style={rectStyle(boxOf(selected))}>
            {!readOnly &&
              selected.type !== "desk_group" &&
              HANDLES.map((h) => <span key={h} className={styles.handle} data-handle={h} aria-hidden="true" />)}
          </div>
        )}
        {drawRect && (drawRect.w > 0 || drawRect.h > 0) && (
          <div className={styles.drawing} style={rectStyle(drawRect)} aria-hidden="true">
            <span>
              {drawRect.w.toFixed(1)} × {drawRect.h.toFixed(1)} m
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/** 손잡이로 크기 바꾸기. 반대쪽 모서리는 그대로 두고, 너무 작아지지 않게 */
function resized(orig: PlanElement & PlanRect, handle: Handle, dx: number, dy: number, snap: boolean): PlanElement {
  let { x, y, w, h } = orig;
  const right = x + w;
  const bottom = y + h;
  if (handle.includes("w")) x = Math.min(snapTo(orig.x + dx, snap), right - MIN_SIZE_M);
  if (handle.includes("e")) w = Math.max(snapTo(right + dx, snap) - x, MIN_SIZE_M);
  if (handle.includes("n")) y = Math.min(snapTo(orig.y + dy, snap), bottom - MIN_SIZE_M);
  if (handle.includes("s")) h = Math.max(snapTo(bottom + dy, snap) - y, MIN_SIZE_M);
  if (handle.includes("w")) w = right - x;
  if (handle.includes("n")) h = bottom - y;
  return { ...orig, x, y, w, h } as PlanElement;
}
