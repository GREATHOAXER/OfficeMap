"use client";

import { type CSSProperties, type FocusEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { CloseIcon } from "@/components/icons";
import type { FloorMap, PresenceStatus, Rect, Room, Seat, Zone } from "@/lib/api";
import { PRESENCE_LABEL } from "@/lib/presence";
import { roomStatusText } from "@/lib/rooms";
import styles from "./office.module.css";

// 좌석 하나의 크기 (도면 너비·높이 대비). 좌석 좌표는 중심점이다
const SEAT_W = 0.0533;
const SEAT_H = 0.0556;

const HOVER_DELAY_MS = 700; // 자리에 마우스를 이만큼(0.7초) 올려 두면 정보 카드가 뜬다
const DRAG_THRESHOLD_PX = 5; // 이보다 적게 움직이면 끌기가 아니라 누르기

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
  /** 눌러서 고정한 정보 카드 (좁은 화면에서는 오른쪽 패널 대신 이걸 띄운다) */
  pinnedSeatId: number | null;
  onUnpin: () => void;
};

export default function FloorPlan(props: Props) {
  const { map, zoom, onZoomChange, focusZoneId, visibleStatuses, selectedSeatId, onSelectSeat } = props;
  const { pinnedSeatId, onUnpin } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const planRef = useRef<HTMLDivElement>(null);
  const [hoverSeatId, setHoverSeatId] = useState<number | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const panningRef = useRef(false);
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

  // 도면이 영역보다 크면(확대 등) 손 모양 커서를 보여 준다
  useEffect(() => {
    const el = scrollRef.current;
    const plan = planRef.current;
    if (!el || !plan) return;
    const update = () => {
      el.dataset.pannable = String(el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1);
    };
    const observer = new ResizeObserver(update);
    observer.observe(el);
    observer.observe(plan);
    return () => observer.disconnect();
  }, [hasPlan]);

  // 고정한 정보 카드: Esc나 카드·자리 밖을 누르면 닫는다
  useEffect(() => {
    if (pinnedSeatId === null) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onUnpin();
    }
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Element;
      if (!target.closest(`.${styles.popover}, .${styles.seat}`)) onUnpin();
    }
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [pinnedSeatId, onUnpin]);

  useEffect(() => () => clearTimeout(hoverTimer.current), []);

  function startHover(seatId: number) {
    clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => {
      if (!panningRef.current) setHoverSeatId(seatId);
    }, HOVER_DELAY_MS);
  }
  function endHover() {
    clearTimeout(hoverTimer.current);
    setHoverSeatId(null);
  }

  // 트랙패드 핀치 확대·축소
  // - Chrome·Edge·Firefox: 핀치가 ctrlKey가 붙은 wheel 이벤트로 온다 (Ctrl+마우스 휠도 같은 이벤트)
  // - Safari: gesturestart/gesturechange 의 scale 로 온다
  // 브라우저 화면 전체가 확대되지 않도록 도면 영역에서만 막는다. 두 손가락 이동은 그대로 스크롤
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let gestureBase: number | null = null;
    let drag: { id: number; x: number; y: number; left: number; top: number; moved: boolean } | null = null;
    let suppressClick = false;

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


    // 마우스로 도면을 잡고 끌어서 옮기기. 터치는 브라우저가 원래 손가락으로 밀어 스크롤한다.
    // 조금(5px) 움직여야 끌기로 보고, 그 전에 떼면 자리 누르기 그대로 동작한다
    function onPointerDown(event: PointerEvent) {
      suppressClick = false;
      if (event.pointerType !== "mouse" || event.button !== 0 || el!.dataset.pannable !== "true") return;
      if ((event.target as Element).closest(`.${styles.popover}`)) return;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: el!.scrollLeft, top: el!.scrollTop, moved: false };
    }
    function onPointerMove(event: PointerEvent) {
      if (!drag || event.pointerId !== drag.id) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!drag.moved) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        drag.moved = true;
        panningRef.current = true;
        el!.setPointerCapture(event.pointerId);
        el!.dataset.panning = "true";
        clearTimeout(hoverTimer.current);
        setHoverSeatId(null);
      }
      el!.scrollLeft = drag.left - dx;
      el!.scrollTop = drag.top - dy;
    }
    function onPointerUp(event: PointerEvent) {
      if (!drag || event.pointerId !== drag.id) return;
      suppressClick = drag.moved; // 끌고 나서 손을 뗀 자리가 눌리지 않게
      drag = null;
      panningRef.current = false;
      delete el!.dataset.panning;
    }
    function onClickCapture(event: MouseEvent) {
      if (!suppressClick) return;
      suppressClick = false;
      event.stopPropagation();
      event.preventDefault();
    }

    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("gesturestart", onGestureStart);
    el.addEventListener("gesturechange", onGestureChange);
    el.addEventListener("gestureend", onGestureEnd);
    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", onPointerUp);
    el.addEventListener("pointercancel", onPointerUp);
    el.addEventListener("click", onClickCapture, true);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", onGestureStart);
      el.removeEventListener("gesturechange", onGestureChange);
      el.removeEventListener("gestureend", onGestureEnd);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("pointercancel", onPointerUp);
      el.removeEventListener("click", onClickCapture, true);
    };
  }, [hasPlan]);

  const { plan } = map;
  if (!plan) {
    return <p className={styles.noPlan}>{map.floor.name}에 게시된 도면이 아직 없습니다.</p>;
  }
  const geometry = plan.geometry ?? {};
  const zones = new Map(map.zones.map((z) => [z.id, z]));
  // 고정한 카드가 먼저. 마우스를 올려 띄운 카드는 그 자리가 고정 카드가 아닐 때만
  const cardSeatId = pinnedSeatId ?? hoverSeatId;
  const cardSeat = map.seats.find((s) => s.id === cardSeatId && s.occupant);

  return (
    <div ref={scrollRef} className={styles.planScroll}>
      <div
        ref={planRef}
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
            onHoverStart={startHover}
            onHoverEnd={endHover}
          />
        ))}
        {cardSeat && (
          <SeatCard
            key={cardSeat.id}
            seat={cardSeat}
            zone={cardSeat.zone_id ? zones.get(cardSeat.zone_id) : undefined}
            floorName={map.floor.name}
            pinned={cardSeat.id === pinnedSeatId}
            onClose={onUnpin}
          />
        )}
      </div>
    </div>
  );
}

function RoomBox({ room, shape }: { room: Room; shape: Rect }) {
  return (
    <div className={styles.room} style={rectStyle(shape)} data-busy={!!room.busy_until}>
      <span>
        {room.name}
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
  onHoverStart: (seatId: number) => void;
  onHoverEnd: () => void;
};

function SeatButton({ seat, zone, dimmed, selected, onSelect, onHoverStart, onHoverEnd }: SeatProps) {
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
      data-seat-id={seat.id}
      onClick={() => onSelect(seat.id)}
      onPointerEnter={(event) => event.pointerType === "mouse" && occupant && onHoverStart(seat.id)}
      onPointerLeave={onHoverEnd}
      onPointerDown={onHoverEnd}
      onFocus={(event: FocusEvent<HTMLButtonElement>) =>
        occupant && event.currentTarget.matches(":focus-visible") && onHoverStart(seat.id)
      }
      onBlur={onHoverEnd}
    >
      <span className={`${styles.chair} ${chair}`} aria-hidden="true" />
      {presence && <span className={`mk ${styles.seatMark}`} data-status={presence} aria-hidden="true" />}
      <span className={styles.seatName}>{text}</span>
    </button>
  );
}

type CardProps = {
  seat: Seat;
  zone: Zone | undefined;
  floorName: string;
  pinned: boolean;
  onClose: () => void;
};

/** 자리 위(위쪽 자리면 아래)에 뜨는 사람 정보 카드. 글자 크기는 배율과 상관없이 같다 */
function SeatCard({ seat, zone, floorName, pinned, onClose }: CardProps) {
  const occupant = seat.occupant!;
  const presence = occupant.presence;
  const below = seat.y < 0.3;
  const align = seat.x < 0.2 ? "start" : seat.x > 0.8 ? "end" : "center";
  const left = align === "start" ? seat.x - SEAT_W / 2 : align === "end" ? seat.x + SEAT_W / 2 : seat.x;
  return (
    <div
      className={styles.popover}
      data-place={below ? "below" : "above"}
      data-align={align}
      data-pinned={pinned}
      style={{ left: pct(left), top: pct(below ? seat.y + SEAT_H / 2 : seat.y - SEAT_H / 2) }}
      role={pinned ? "dialog" : "tooltip"}
      aria-label={`${occupant.name} 정보`}
    >
      <div className={styles.popoverHead}>
        <strong>
          {occupant.name} <span>{occupant.rank}</span>
        </strong>
        {pinned && (
          <button type="button" className={styles.popoverClose} aria-label="닫기" onClick={onClose}>
            <CloseIcon size={16} />
          </button>
        )}
      </div>
      <span className={styles.popoverTeam} data-color={zone?.color_key ?? "t0"}>
        <span className={styles.swatch} aria-hidden="true" />
        {occupant.department}
      </span>
      <span className={styles.popoverStatus}>
        {presence ? (
          <>
            <span className="mk" data-status={presence.status} aria-hidden="true" />
            <strong>{PRESENCE_LABEL[presence.status]}</strong>
            {presence.message && <span>· {presence.message}</span>}
          </>
        ) : (
          <span className={styles.popoverMuted}>상태 정보 없음</span>
        )}
      </span>
      <span className={`mono ${styles.popoverMuted}`}>
        {floorName} {seat.code}
        {occupant.extension && ` · 내선 ${occupant.extension}`}
        {occupant.kind === "DAILY" && " · 오늘만 이 자리"}
      </span>
    </div>
  );
}
