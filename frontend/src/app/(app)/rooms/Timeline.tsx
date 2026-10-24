"use client";

import type { CSSProperties } from "react";
import type { RoomDay, RoomsDay } from "@/lib/api";
import { minToHHMM } from "@/lib/dates";
import { rangeText, spanDays } from "@/lib/rooms";
import { equipmentText } from "./ReservationForm";
import { type Draft, isPast, slotStarts } from "./slots";
import styles from "./rooms.module.css";

type Props = {
  day: RoomsDay;
  rooms: RoomDay[]; // 필터를 거친 회의실
  draft: Draft;
  onPick: (room: RoomDay, start: number) => void;
  onOpenBooking: (reservationId: number) => void;
};

/**
 * 예약 현황표. 회의실마다 한 줄, 칸 하나 = 30분. 빈 칸을 누르면 그 시간을 고른다.
 * 예약은 칸 여러 개를 이어 붙인 블록 하나로 그리고, 누르면 자세한 내용을 띄운다 (내 예약은 검정).
 */
export default function Timeline({ day, rooms, draft, onPick, onOpenBooking }: Props) {
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
              </span>
            </div>
            {starts.map((s) => {
              if (room.bookings.some((b) => b.start_min <= s && b.end_min > s)) return null; // 예약 블록이 덮는 칸
              const past = isPast(day, s);
              // 여러 날 예약을 고르면 시작 날에는 시작 칸부터 문 닫을 때까지 칠한다
              const selected =
                draft.roomId === room.id &&
                draft.start !== null &&
                draft.end !== null &&
                s >= draft.start &&
                (draft.endDays > 0 || s < draft.end);
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
            {room.bookings.map((b) => {
              const days = spanDays(b.starts_at, b.ends_at);
              const when = days
                ? `${rangeText(b.starts_at, b.ends_at)} (${days}일)`
                : `${minToHHMM(b.start_min)}–${minToHHMM(b.end_min)}`;
              return (
                <button
                  key={b.id}
                  type="button"
                  role="gridcell"
                  className={styles.ttBooking}
                  data-mine={b.mine || undefined}
                  style={{ gridColumn: `${col(b.start_min)} / ${col(b.end_min)}` }}
                  title={`${b.title} · ${b.department} ${b.organizer} · ${when}`}
                  aria-haspopup="dialog"
                  aria-label={`${room.name} ${when} ${b.title}, ${b.department} ${b.organizer}${
                    b.mine ? ", 내 예약" : ""
                  }. 누르면 자세히`}
                  onClick={() => onOpenBooking(b.id)}
                >
                  <strong>{b.title}</strong>
                  <span>
                    {days ? `${days}일 예약 · ` : ""}
                    {b.mine ? "내 예약" : b.department}
                  </span>
                </button>
              );
            })}
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
