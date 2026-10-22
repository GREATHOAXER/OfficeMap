"use client";

import type { CSSProperties } from "react";
import type { FloorMap, PresenceStatus, Rect, Room, Seat, Zone } from "@/lib/api";
import { PRESENCE_LABEL } from "@/lib/presence";
import styles from "./office.module.css";

// 좌석 하나의 크기 (도면 너비·높이 대비). 좌석 좌표는 중심점이다
const SEAT_W = 0.0533;
const SEAT_H = 0.0556;

const pct = (v: number) => `${(v * 100).toFixed(3)}%`;
const rectStyle = (r: Rect): CSSProperties => ({ left: pct(r.x), top: pct(r.y), width: pct(r.w), height: pct(r.h) });

const hhmm = new Intl.DateTimeFormat("ko-KR", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "Asia/Seoul",
});

type Props = {
  map: FloorMap;
  zoom: number;
  focusZoneId: number | null;
  visibleStatuses: Set<PresenceStatus>;
  selectedSeatId: number | null;
  onSelectSeat: (seatId: number) => void;
};

export default function FloorPlan({ map, zoom, focusZoneId, visibleStatuses, selectedSeatId, onSelectSeat }: Props) {
  const { plan } = map;
  if (!plan) {
    return <p className={styles.noPlan}>{map.floor.name}에 게시된 도면이 아직 없습니다.</p>;
  }
  const geometry = plan.geometry ?? {};
  const zones = new Map(map.zones.map((z) => [z.id, z]));

  return (
    <div className={styles.planScroll}>
      <div
        className={styles.plan}
        style={{ aspectRatio: `${plan.width_m} / ${plan.height_m}`, width: `${zoom * 100}%` }}
        role="group"
        aria-label={`${map.floor.site.name} ${map.floor.name} 좌석 배치도`}
      >
        {geometry.walls?.map((wall, i) => (
          <div key={`wall-${i}`} className={styles.wall} style={rectStyle(wall)} />
        ))}
        {geometry.spaces?.map((space, i) => (
          <div key={`space-${i}`} className={styles.space} data-kind={space.kind} style={rectStyle(space)}>
            <span>{space.label}</span>
          </div>
        ))}
        {geometry.pillars?.map((p, i) => (
          <div key={`pillar-${i}`} className={styles.pillar} style={{ left: pct(p.x - 0.0075), top: pct(p.y - 0.0125) }} />
        ))}
        {map.rooms.map((room) => room.shape && <RoomBox key={room.id} room={room} shape={room.shape} />)}
        {map.zones.map((zone) => (
          <div
            key={zone.id}
            className={`${styles.zone} ${focusZoneId && focusZoneId !== zone.id ? styles.dim : ""} ${
              focusZoneId === zone.id ? styles.zoneFocus : ""
            }`}
            data-color={zone.color_key}
            data-shared={zone.department === null}
            style={rectStyle(zone.shape)}
          >
            <span className={styles.zoneTag}>
              {zone.name} · {zone.code}
            </span>
          </div>
        ))}
        {map.seats.map((seat) => (
          <SeatButton
            key={seat.id}
            seat={seat}
            zone={seat.zone_id ? zones.get(seat.zone_id) : undefined}
            dimmed={
              (focusZoneId !== null && seat.zone_id !== focusZoneId) ||
              (!!seat.occupant?.presence && !visibleStatuses.has(seat.occupant.presence.status))
            }
            selected={seat.id === selectedSeatId}
            onSelect={onSelectSeat}
          />
        ))}
      </div>
    </div>
  );
}

function RoomBox({ room, shape }: { room: Room; shape: Rect }) {
  let status: string;
  if (room.busy_until) status = `● 사용 중 ~${hhmm.format(new Date(room.busy_until))}`;
  else if (room.next_start) status = `○ 비어 있음 · ${hhmm.format(new Date(room.next_start))}까지`;
  else status = "○ 비어 있음";

  return (
    <div className={styles.room} style={rectStyle(shape)} data-busy={!!room.busy_until}>
      <span>
        {room.name}
        {room.requires_approval && <em className={styles.approval}>승인제</em>}
        <br />
        <span className={styles.roomStatus}>{status}</span>
      </span>
    </div>
  );
}

type SeatProps = {
  seat: Seat;
  zone: Zone | undefined;
  dimmed: boolean;
  selected: boolean;
  onSelect: (seatId: number) => void;
};

function SeatButton({ seat, zone, dimmed, selected, onSelect }: SeatProps) {
  const { occupant } = seat;
  const presence = occupant?.presence?.status;
  const outOfService = seat.status === "OUT_OF_SERVICE";

  let text: string;
  let label: string;
  if (occupant) {
    text = occupant.name;
    label = `${occupant.name}, ${occupant.department} ${seat.code}${presence ? `, ${PRESENCE_LABEL[presence]}` : ""}`;
  } else if (outOfService) {
    text = "사용 중지";
    label = `사용 중지 좌석 ${seat.code}`;
  } else {
    text = seat.seat_type === "FLEX" ? "자율석" : "빈 자리";
    label = `${text} ${seat.code}${zone ? `, ${zone.name}` : ""}`;
  }

  const chair = { 0: styles.chairBottom, 90: styles.chairRight, 180: styles.chairTop, 270: styles.chairLeft }[seat.rotation];
  const className = [
    styles.seat,
    occupant ? "" : styles.seatEmpty,
    outOfService ? styles.seatOff : "",
    presence === "AWAY" ? styles.seatAway : "",
    dimmed ? styles.dim : "",
    selected ? styles.seatSelected : "",
  ].join(" ");

  return (
    <button
      type="button"
      className={className}
      data-color={zone?.color_key ?? "t0"}
      style={{
        left: pct(seat.x - SEAT_W / 2),
        top: pct(seat.y - SEAT_H / 2),
        width: pct(SEAT_W),
        height: pct(SEAT_H),
      }}
      title={seat.code}
      aria-label={label}
      aria-pressed={selected}
      onClick={() => onSelect(seat.id)}
    >
      <span className={`${styles.chair} ${chair}`} aria-hidden="true" />
      {presence && <span className={`mk ${styles.seatMark}`} data-status={presence} aria-hidden="true" />}
      <span className={styles.seatName}>{text}</span>
    </button>
  );
}
