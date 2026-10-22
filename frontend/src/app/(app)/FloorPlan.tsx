"use client";

import { type CSSProperties, useEffect, useLayoutEffect, useRef } from "react";
import type { FloorMap, PresenceStatus, Rect, Room, Seat, Zone } from "@/lib/api";
import { PRESENCE_LABEL } from "@/lib/presence";
import { roomStatusText } from "@/lib/rooms";
import styles from "./office.module.css";

// 좌석 하나의 크기 (도면 너비·높이 대비). 좌석 좌표는 중심점이다
const SEAT_W = 0.0533;
const SEAT_H = 0.0556;

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 3;
export const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

const pct = (v: number) => `${(v * 100).toFixed(3)}%`;
const rectStyle = (r: Rect): CSSProperties => ({ left: pct(r.x), top: pct(r.y), width: pct(r.w), height: pct(r.h) });

// Safari 트랙패드 핀치는 표준이 아닌 gesture* 이벤트로 온다
type GestureLike = Event & { scale: number; clientX: number; clientY: number };

type Props = {
  map: FloorMap;
  zoom: number;
  onZoomChange: (zoom: number) => void;
  focusZoneId: number | null;
  visibleStatuses: Set<PresenceStatus>;
  selectedSeatId: number | null;
  onSelectSeat: (seatId: number) => void;
};

export default function FloorPlan(props: Props) {
  const { map, zoom, onZoomChange, focusZoneId, visibleStatuses, selectedSeatId, onSelectSeat } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(zoom); // 이벤트 처리 중에 읽는 최신 배율
  const prevZoomRef = useRef(zoom);
  const anchorRef = useRef<{ x: number; y: number } | null>(null); // 확대 기준점 (스크롤 영역 안 좌표)
  const onZoomRef = useRef(onZoomChange);
  const hasPlan = map.plan !== null;

  useEffect(() => {
    onZoomRef.current = onZoomChange;
  });

  // 배율이 바뀌면 기준점(손가락·포인터 위치, 버튼이면 화면 가운데)이 제자리에 있도록 스크롤을 맞춘다
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const prev = prevZoomRef.current;
    prevZoomRef.current = zoom;
    zoomRef.current = zoom;
    if (!el || prev === zoom) return;
    const anchor = anchorRef.current ?? { x: el.clientWidth / 2, y: el.clientHeight / 2 };
    anchorRef.current = null;
    const k = zoom / prev;
    el.scrollLeft = (el.scrollLeft + anchor.x) * k - anchor.x;
    el.scrollTop = (el.scrollTop + anchor.y) * k - anchor.y;
  }, [zoom]);

  // 트랙패드 핀치 확대·축소
  // - Chrome·Edge·Firefox: 핀치가 ctrlKey가 붙은 wheel 이벤트로 온다 (Ctrl+마우스 휠도 같은 이벤트)
  // - Safari: gesturestart/gesturechange 의 scale 로 온다
  // 브라우저 화면 전체가 확대되지 않도록 도면 영역에서만 막는다. 두 손가락 이동은 그대로 스크롤
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
      if (!event.ctrlKey || gestureBase !== null) return;
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
  }, [hasPlan]);

  const { plan } = map;
  if (!plan) {
    return <p className={styles.noPlan}>{map.floor.name}에 게시된 도면이 아직 없습니다.</p>;
  }
  const geometry = plan.geometry ?? {};
  const zones = new Map(map.zones.map((z) => [z.id, z]));

  return (
    <div ref={scrollRef} className={styles.planScroll}>
      <div
        className={styles.plan}
        style={{ aspectRatio: `${plan.width_m} / ${plan.height_m}`, "--zoom": zoom } as CSSProperties}
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
  return (
    <div className={styles.room} style={rectStyle(shape)} data-busy={!!room.busy_until}>
      <span>
        {room.name}
        {room.requires_approval && <em className={styles.approval}>승인제</em>}
        <br />
        <span className={styles.roomStatus}>{roomStatusText(room)}</span>
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
