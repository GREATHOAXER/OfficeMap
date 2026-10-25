"use client";

import type { CSSProperties, DragEvent } from "react";
import office from "@/app/(app)/office.module.css";
import type { Rect, SeatingData, SeatingSeat } from "@/lib/api";
import { shortDate } from "@/lib/dates";
import type { Layout, Person } from "@/lib/seating";
import styles from "./seating.module.css";

// 직원 화면 도면과 같은 크기·좌표 (FloorPlan.tsx)
const SEAT_W = 0.0533;
const SEAT_H = 0.0556;
const pct = (v: number) => `${(v * 100).toFixed(3)}%`;
const rectStyle = (r: Rect): CSSProperties => ({ left: pct(r.x), top: pct(r.y), width: pct(r.w), height: pct(r.h) });

/** 좌석 하나를 어떻게 그릴지 (편집 화면이 정한다) */
export type SeatView = {
  /** 이 좌석에 놓을 수 있나. 아니면 그 이유 */
  dropBlock: string | null;
  /** 끌어서 옮길 수 있는 사람 */
  draggable: string | null;
  changed: boolean;
  conflict: string | null;
  dimmed: boolean;
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
  onSeatClick: (seat: SeatingSeat) => void;
  onDragStartPerson: (empNo: string, event: DragEvent) => void;
  onDragEnd: () => void;
  onDragOverSeat: (seatId: number | null) => void;
  onDropSeat: (seat: SeatingSeat) => void;
};

export default function SeatingCanvas(props: Props) {
  const { data, layout, people, zoom, readOnly, plain, viewOf, selectedSeatId, pickedSeatId, dragOverId } = props;
  const { focusZones, zoneOf, onSeatClick, onDragStartPerson, onDragEnd, onDragOverSeat, onDropSeat } = props;
  const plan = data.plan;
  if (!plan) return <p className={office.noPlan}>{data.floor.name}에 게시된 도면이 아직 없어요. 도면을 먼저 게시하세요.</p>;
  const geometry = plan.geometry ?? {};
  const zones = new Map(data.zones.map((z) => [z.id, z]));

  return (
    <div className={styles.canvasScroll}>
      <div
        className={styles.canvas}
        style={{ aspectRatio: `${plan.width_m} / ${plan.height_m}`, "--zoom": zoom } as CSSProperties}
        role="group"
        aria-label={`${data.floor.site.name} ${data.floor.name} 좌석 배치 편집 도면`}
      >
        {geometry.walls?.map((wall, i) => <div key={`wall-${i}`} className={office.wall} style={rectStyle(wall)} />)}
        {geometry.spaces?.map((space, i) => (
          <div key={`space-${i}`} className={office.space} data-kind={space.kind} style={rectStyle(space)}>
            <span>{space.label}</span>
          </div>
        ))}
        {geometry.pillars?.map((p, i) => (
          <div key={`pillar-${i}`} className={office.pillar} style={{ left: pct(p.x - 0.0075), top: pct(p.y - 0.0125) }} />
        ))}
        {data.rooms.map(
          (room) =>
            room.shape && (
              <div key={room.id} className={styles.room} style={rectStyle(room.shape)}>
                <span>{room.name}</span>
              </div>
            ),
        )}
        {data.zones.map((zone) => {
          const locked = !zone.editable;
          return (
            <div
              key={zone.id}
              className={`${office.zone} ${focusZones && !focusZones.has(zone.id) ? styles.dim : ""}`}
              data-color={zone.color_key}
              data-shared={zone.department === null}
              style={rectStyle(zone.shape)}
            >
              <span className={office.zoneTag}>
                {zone.name} · {zone.code}
                {locked && !plain && " · 잠김"}
              </span>
            </div>
          );
        })}
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
            !seat.editable && !plain ? "다른 구역" : "",
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
                left: pct(seat.x - SEAT_W / 2),
                top: pct(seat.y - SEAT_H / 2),
                width: pct(SEAT_W),
                height: pct(SEAT_H),
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
            </button>
          );
        })}
      </div>
    </div>
  );
}
