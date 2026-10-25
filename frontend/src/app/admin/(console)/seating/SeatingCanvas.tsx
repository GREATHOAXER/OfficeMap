"use client";

import { type CSSProperties, type DragEvent, type PointerEvent, useEffect, useRef, useState } from "react";
import office from "@/app/(app)/office.module.css";
import PlanShapes, { labelStyle, lineStyle } from "@/app/(app)/PlanShapes";
import type { Rect, SeatingData, SeatingSeat, SeatingZone } from "@/lib/api";
import { shortDate } from "@/lib/dates";
import { seatRatio } from "@/lib/planGeometry";
import type { Layout, Person } from "@/lib/seating";
import { baseSeatFont, compactAt, minPlanWidth, seatBox, seatFont } from "@/lib/seatLabel";
import { zonePieces } from "@/lib/zoneShape";
import styles from "./seating.module.css";

// 직원 화면 도면과 같은 크기·좌표 (FloorPlan.tsx)
const pct = (v: number) => `${(v * 100).toFixed(3)}%`;
const rectStyle = (r: Rect): CSSProperties => ({ left: pct(r.x), top: pct(r.y), width: pct(r.w), height: pct(r.h) });
const BOX_THRESHOLD_PX = 5; // 이보다 적게 움직이면 네모 묶기가 아니라 누르기

/** 좌석 하나를 어떻게 그릴지 (편집 화면이 정한다) */
export type SeatView = {
  /** 이 좌석에 놓을 수 있나. 아니면 그 이유 */
  dropBlock: string | null;
  /** 끌어서 옮길 수 있는 사람 */
  draggable: string | null;
  changed: boolean;
  conflict: string | null;
  dimmed: boolean;
  /** 팀 구역에 다른 팀 사람이 앉아 있다 */
  otherTeam: boolean;
  /** 내가 사람·유형을 바꿀 수 있는 좌석 (구역 관리자는 내 구역) */
  editable: boolean;
};

type Props = {
  data: SeatingData;
  layout: Layout;
  people: Map<string, Person>;
  zoom: number;
  /** 미리보기·승인 대기·검토: 바뀐 표시만 보이고 손댈 수 없다 */
  readOnly: boolean;
  /** 직원 화면 미리보기: 바뀐 표시·잠김 표시 없이 직원이 볼 모습 그대로 */
  plain: boolean;
  viewOf: (seat: SeatingSeat) => SeatView;
  selectedSeatId: number | null;
  pickedSeatId: number | null;
  dragOverId: number | null;
  /** 구역 관리자: 내 구역만 강조 */
  focusZones: Set<number> | null;
  zoneOf: (seat: SeatingSeat) => number | null;
  /** 구역을 그릴 사각형 (구역 경계를 바꾸고 있으면 바뀔 모양) */
  rectsOf: (zone: SeatingZone) => Rect[];
  /** 팀 구역 지정: 끌어서 네모로 좌석을 묶는다 */
  boxSelect: boolean;
  onBoxSelect: (seatIds: number[]) => void;
  onSeatClick: (seat: SeatingSeat) => void;
  onDragStartPerson: (empNo: string, event: DragEvent) => void;
  onDragEnd: () => void;
  onDragOverSeat: (seatId: number | null) => void;
  onDropSeat: (seat: SeatingSeat) => void;
  /** 도면 전체가 영역에 들어오는 배율 (사람이 많아 책상이 작은 층은 1보다 작다) */
  onFitZoom?: (zoom: number) => void;
};

export default function SeatingCanvas(props: Props) {
  const { data, layout, people, zoom, readOnly, plain, viewOf, selectedSeatId, pickedSeatId, dragOverId } = props;
  const { focusZones, zoneOf, rectsOf, boxSelect, onBoxSelect } = props;
  const { onSeatClick, onDragStartPerson, onDragEnd, onDragOverSeat, onDropSeat, onFitZoom } = props;
  const canvasRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const boxStart = useRef<{ x: number; y: number; px: number; py: number; id: number } | null>(null);
  const suppressClick = useRef(false);
  const [box, setBox] = useState<Rect | null>(null);
  const plan = data.plan;
  // 좌석 이름 글자 크기와 도면 최소 폭은 직원 화면과 같은 규칙 (lib/seatLabel.ts)
  const aspect = plan ? plan.height_m / plan.width_m : 0.6;
  const seatSize = plan ? seatRatio(plan.width_m, plan.height_m) : { w: 0, h: 0 }; // 좌석 크기 (도면 대비)
  const boxOf = (seat: SeatingSeat) => seatBox(seat.w ?? seatSize.w, seat.h ?? seatSize.h, aspect);
  const baseFont = baseSeatFont(data.seats.map(boxOf));
  const live = useRef({ baseFont, zoom, fit: 1, onFitZoom });
  useEffect(() => {
    live.current = { ...live.current, baseFont, zoom, onFitZoom };
  });

  // 이름이 읽히지 않을 만큼 줄이면 이름을 숨기고, 도면 전체가 들어오는 배율을 알린다
  const hasPlan = plan !== null;
  useEffect(() => {
    const el = scrollRef.current;
    const canvas = canvasRef.current;
    if (!el || !canvas) return;
    const update = () => {
      const width = canvas.getBoundingClientRect().width;
      canvas.dataset.compact = String(compactAt(width, live.current.baseFont));
      const baseW = width / live.current.zoom;
      const baseH = (baseW * canvas.offsetHeight) / Math.max(1, canvas.offsetWidth);
      const maxH = parseFloat(getComputedStyle(el).maxHeight) || el.clientHeight;
      const fit = Math.min(1, el.clientWidth / baseW, maxH / baseH);
      if (Math.abs(fit - live.current.fit) > 0.005) {
        live.current.fit = fit;
        live.current.onFitZoom?.(fit);
      }
    };
    const observer = new ResizeObserver(update);
    observer.observe(el);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [hasPlan]);

  if (!plan)
    return <p className={office.noPlan}>{data.floor.name}에 게시된 도면이 아직 없어요. 도면을 먼저 게시하세요.</p>;
  const geometry = plan.geometry ?? {};
  const zones = new Map(data.zones.map((z) => [z.id, z]));

  // 팀 구역 지정: 도면 위를 끌어서 네모 안 좌석을 한 번에 고른다 (조금만 움직이면 좌석 누르기)
  const ratio = (event: PointerEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: (event.clientX - r.left) / r.width, y: (event.clientY - r.top) / r.height };
  };
  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!boxSelect || event.button !== 0) return;
    const at = ratio(event);
    boxStart.current = { ...at, px: event.clientX, py: event.clientY, id: event.pointerId };
  }
  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const start = boxStart.current;
    if (!start || event.pointerId !== start.id) return;
    if (!box && Math.hypot(event.clientX - start.px, event.clientY - start.py) < BOX_THRESHOLD_PX) return;
    if (!box) canvasRef.current?.setPointerCapture(event.pointerId);
    const at = ratio(event);
    setBox({
      x: Math.min(start.x, at.x),
      y: Math.min(start.y, at.y),
      w: Math.abs(at.x - start.x),
      h: Math.abs(at.y - start.y),
    });
  }
  function onPointerUp(event: PointerEvent<HTMLDivElement>) {
    const start = boxStart.current;
    boxStart.current = null;
    if (!start || event.pointerId !== start.id || !box) return;
    suppressClick.current = true; // 네모를 다 그리고 손을 뗀 자리의 좌석이 눌리지 않게
    const picked = data.seats.filter(
      (s) => s.x >= box.x && s.x <= box.x + box.w && s.y >= box.y && s.y <= box.y + box.h,
    );
    setBox(null);
    if (picked.length) onBoxSelect(picked.map((s) => s.id));
  }

  return (
    <div ref={scrollRef} className={styles.canvasScroll}>
      <div
        ref={canvasRef}
        className={styles.canvas}
        data-box-select={boxSelect || undefined}
        style={
          {
            aspectRatio: `${plan.width_m} / ${plan.height_m}`,
            "--zoom": zoom,
            "--min-w": `${minPlanWidth(baseFont)}px`,
          } as CSSProperties
        }
        role="group"
        aria-label={`${data.floor.site.name} ${data.floor.name} 좌석 배치 편집 도면`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          boxStart.current = null;
          setBox(null);
        }}
        onClickCapture={(event) => {
          if (!suppressClick.current) return;
          suppressClick.current = false;
          event.stopPropagation();
          event.preventDefault();
        }}
      >
        <PlanShapes geometry={geometry} width_m={plan.width_m} height_m={plan.height_m} />
        {data.rooms.map(
          (room) =>
            room.shape && (
              <div key={room.id} className={styles.room} style={{ ...rectStyle(room.shape), ...lineStyle(room.shape) }}>
                <span style={labelStyle(room.shape)}>{room.name}</span>
              </div>
            ),
        )}
        {zonePieces(data.zones, rectsOf).map(({ zone, rect }, i) => (
          <div
            key={`${zone.id}-${i}`}
            className={`${office.zone} ${focusZones && !focusZones.has(zone.id) ? styles.dim : ""}`}
            data-color={zone.color_key}
            data-shared={zone.department === null}
            style={rectStyle(rect)}
          />
        ))}
        {/* 이름표는 모든 구역을 칠한 뒤에 그려서 다른 구역 조각에 가려지지 않게 */}
        {zonePieces(data.zones, rectsOf)
          .filter((piece) => piece.tagged)
          .map(({ zone, rect }) => (
            <span
              key={`tag-${zone.id}`}
              className={`${office.zoneTag} ${focusZones && !focusZones.has(zone.id) ? styles.dim : ""}`}
              data-color={zone.color_key}
              style={{ left: pct(rect.x), top: pct(rect.y) }}
            >
              {zone.name} · {zone.code}
              {!zone.editable && !plain && " · 잠김"}
            </span>
          ))}
        {data.seats.map((seat) => {
          const view = viewOf(seat);
          const emp = layout.occupant(seat.id);
          const person = emp ? people.get(emp) : undefined;
          const mode = layout.mode(seat);
          const zoneId = zoneOf(seat);
          const zone = zoneId !== null ? zones.get(zoneId) : undefined;
          const daily = seat.occupant?.kind === "DAILY" ? seat.occupant : null;
          let text: string;
          if (person) text = person.name;
          else if (mode === "OUT_OF_SERVICE") text = "사용 중지";
          else if (mode === "FLEX") text = "자율석";
          else text = "빈 자리";
          const locked = !!seat.upcoming && !plain;
          const label = [
            seat.code,
            person ? `${person.name} ${person.department}` : text,
            mode === "FLEX" && daily ? `오늘 ${daily.name} 사용` : "",
            view.changed && !plain ? "바뀜" : "",
            locked ? `${shortDate(seat.upcoming!.at)} 변경 예정 · 잠김` : "",
            view.conflict && !plain ? `충돌: ${view.conflict}` : "",
            !view.editable && !plain ? "다른 구역" : "",
            view.otherTeam && !plain ? "다른 팀 구역에 앉음" : "",
          ]
            .filter(Boolean)
            .join(", ");
          const dropState = dragOverId === seat.id ? (view.dropBlock ? "bad" : "ok") : undefined;
          return (
            <button
              key={seat.id}
              type="button"
              className={styles.seat}
              data-color={zone?.color_key ?? "t0"}
              data-empty={!person || undefined}
              data-mode={mode}
              data-changed={(view.changed && !plain) || undefined}
              data-conflict={(!!view.conflict && !plain) || undefined}
              data-locked={locked || undefined}
              data-dim={view.dimmed || undefined}
              data-selected={seat.id === selectedSeatId || undefined}
              data-picked={seat.id === pickedSeatId || undefined}
              data-drop={dropState}
              data-seat-id={seat.id}
              style={{
                left: pct(seat.x - (seat.w ?? seatSize.w) / 2),
                top: pct(seat.y - (seat.h ?? seatSize.h) / 2),
                width: pct(seat.w ?? seatSize.w),
                height: pct(seat.h ?? seatSize.h),
                fontSize: `${seatFont(boxOf(seat), text, false, baseFont).toFixed(3)}cqw`,
              }}
              title={view.conflict && !plain ? `${seat.code} · ${view.conflict}` : `${seat.code} · ${text}`}
              aria-label={label}
              aria-pressed={seat.id === selectedSeatId}
              aria-disabled={readOnly || undefined}
              draggable={!readOnly && !!view.draggable}
              onClick={() => onSeatClick(seat)}
              onDragStart={(event) => view.draggable && onDragStartPerson(view.draggable, event)}
              onDragEnd={onDragEnd}
              onDragOver={(event) => {
                if (readOnly) return;
                // 놓을 수 없는 자리도 놓게 두고(빨간 테두리), 놓으면 이유를 알려 준다.
                // dropEffect를 none으로 하면 브라우저가 drop 자체를 보내지 않아 아무 안내 없이 끝난다
                event.preventDefault();
                if (dragOverId !== seat.id) onDragOverSeat(seat.id);
              }}
              onDragLeave={() => dragOverId === seat.id && onDragOverSeat(null)}
              onDrop={(event) => {
                event.preventDefault();
                onDropSeat(seat);
              }}
            >
              <span className={styles.seatName}>{text}</span>
              {view.changed && !plain && !view.conflict && (
                <span className={styles.seatTag} aria-hidden="true">
                  변경
                </span>
              )}
              {view.conflict && !plain && (
                <span className={styles.seatTag} data-tone="danger" aria-hidden="true">
                  !
                </span>
              )}
              {locked && (
                <span className={styles.seatTag} data-tone="muted" aria-hidden="true">
                  {shortDate(seat.upcoming!.at).replace(/\(.\)/, "")}
                </span>
              )}
              {view.otherTeam && !plain && !locked && !view.changed && !view.conflict && (
                <span className={styles.seatTag} data-tone="other" aria-hidden="true">
                  타팀
                </span>
              )}
            </button>
          );
        })}
        {box && <div className={styles.selectBox} style={rectStyle(box)} aria-hidden="true" />}
      </div>
    </div>
  );
}
