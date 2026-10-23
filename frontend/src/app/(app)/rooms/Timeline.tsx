"use client";

import type { CSSProperties } from "react";
import type { RoomDay, RoomsDay } from "@/lib/api";
import { minToHHMM } from "@/lib/dates";
import { equipmentText } from "./ReservationForm";
import { type Draft, isPast, slotStarts } from "./slots";
import styles from "./rooms.module.css";

type Props = {
  day: RoomsDay;
  rooms: RoomDay[]; // 필터를 거친 회의실
  draft: Draft;
  onPick: (room: RoomDay, start: number) => void;
};

/**
 * 예약 현황표. 회의실마다 한 줄, 칸 하나 = 30분. 빈 칸을 누르면 그 시간을 고른다.
 * 예약은 칸 여러 개를 이어 붙인 블록 하나로 그린다 (내 예약은 검정, 승인 대기는 빗금).
 */
export default function Timeline({ day, rooms, draft, onPick }: Props) {
  const { open_start: open, open_end: close, slot } = day.policy;
  const starts = slotStarts(day);
  const col = (minute: number) => 2 + Math.round((Math.min(Math.max(minute, open), close) - open) / slot);
  const hours = starts.filter((s) => s % 60 === 0);
  const nowVisible = day.now_min !== null && day.now_min >= open && day.now_min < close;

  return (
    <div className={styles.ttScroll}>
      <div
        className={styles.tt}
        style={{ "--slots": starts.length, "--rows": rooms.length } as CSSProperties}
        role="grid"
        aria-label="예약 현황표"
        aria-rowcount={rooms.length + 1}
      >
        <div role="row" className={styles.ttRow} style={{ "--row": 1 } as CSSProperties}>
          <div role="columnheader" className={`${styles.ttHead} ${styles.ttCorner}`}>
            회의실
          </div>
          {hours.map((h) => (
            <div
              key={h}
              role="columnheader"
              className={`${styles.ttHead} mono`}
              style={{ gridColumn: `${col(h)} / span ${60 / slot}` }}
            >
              {String(h / 60).padStart(2, "0")}
            </div>
          ))}
        </div>

        {rooms.map((room, r) => (
          <div key={room.id} role="row" className={styles.ttRow} style={{ "--row": r + 2 } as CSSProperties}>
            <div role="rowheader" className={styles.ttRoom}>
              <strong>{room.name}</strong>
              <span className="mono">
                {room.floor.name} · {room.capacity}인{room.equipment.length ? ` · ${equipmentText(room.equipment)}` : ""}
                {room.requires_approval && " · 승인제"}
              </span>
            </div>
            {starts.map((s) => {
              if (room.bookings.some((b) => b.start_min <= s && b.end_min > s)) return null; // 예약 블록이 덮는 칸
              const past = isPast(day, s);
              const selected = draft.roomId === room.id && draft.start !== null && draft.end !== null && s >= draft.start && s < draft.end;
              return (
                <button
                  key={s}
                  type="button"
                  role="gridcell"
                  className={styles.ttCell}
                  data-hour={s % 60 === 0 || undefined}
                  data-past={past || undefined}
                  data-selected={selected || undefined}
                  style={{ gridColumn: col(s) }}
                  disabled={past}
                  aria-selected={selected}
                  aria-label={`${room.name} ${minToHHMM(s)}–${minToHHMM(s + slot)} ${past ? "지난 시간" : "비어 있음"}`}
                  onClick={() => onPick(room, s)}
                />
              );
            })}
            {room.bookings.map((b) => (
              <div
                key={b.id}
                role="gridcell"
                className={styles.ttBooking}
                data-mine={b.mine || undefined}
                data-pending={b.status === "PENDING_APPROVAL" || undefined}
                style={{ gridColumn: `${col(b.start_min)} / ${col(b.end_min)}` }}
                title={`${b.title} · ${b.department} ${b.organizer} · ${minToHHMM(b.start_min)}–${minToHHMM(b.end_min)}`}
                aria-label={`${room.name} ${minToHHMM(b.start_min)}–${minToHHMM(b.end_min)} ${b.title}, ${b.department} ${b.organizer}${
                  b.status === "PENDING_APPROVAL" ? ", 승인 대기" : ""
                }${b.mine ? ", 내 예약" : ""}`}
              >
                <strong>{b.title}</strong>
                <span>
                  {b.status === "PENDING_APPROVAL" ? "승인 대기 · " : ""}
                  {b.mine ? "내 예약" : b.department}
                </span>
              </div>
            ))}
          </div>
        ))}

        {nowVisible && (
          <div
            className={styles.ttNow}
            style={
              {
                gridColumn: col(day.now_min! - (day.now_min! % slot)),
                "--now": `${((day.now_min! % slot) / slot) * 100}%`,
              } as CSSProperties
            }
            aria-hidden="true"
          />
        )}
      </div>
    </div>
  );
}
