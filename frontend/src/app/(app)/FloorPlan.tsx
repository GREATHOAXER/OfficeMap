"use client";

import Link from "next/link";
import { type CSSProperties, type FocusEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Avatar from "@/components/Avatar";
import { CloseIcon } from "@/components/icons";
import type { FloorMap, Occupant, Rect, Room, Seat, ShapeStyle, Zone } from "@/lib/api";
import { agoText } from "@/lib/dates";
import { NO_STATUS_LABEL, PRESENCE_LABEL, type StatusFilter } from "@/lib/presence";
import { hhmm, roomStatusText } from "@/lib/rooms";
import { useMediaQuery } from "@/lib/useMediaQuery";
import { seatRatio } from "@/lib/planGeometry";
import { baseSeatFont, compactAt, minPlanWidth, type SeatBox, seatBox, seatFont } from "@/lib/seatLabel";
import { useNow } from "@/lib/useNow";
import { zonePieces, zoneRects } from "@/lib/zoneShape";
import styles from "./office.module.css";
import PlanShapes, { labelStyle, lineStyle, ScaleBar } from "./PlanShapes";

const HOVER_DELAY_MS = 700; // 자리에 마우스를 이만큼(0.7초) 올려 두면 정보 카드가 뜬다
const DRAG_THRESHOLD_PX = 5; // 이보다 적게 움직이면 끌기가 아니라 누르기

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 3;
/** min: 가장 작은 배율. 화면보다 큰 층(사람이 많은 층)은 "전체 보기" 배율까지 줄일 수 있다 */
export const clampZoom = (z: number, min = ZOOM_MIN) => Math.min(ZOOM_MAX, Math.max(Math.min(ZOOM_MIN, min), z));
// − / + 버튼이 멈추는 배율 (핀치·Ctrl+휠은 그 사이 어디든)
export const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3];

const pct = (v: number) => `${(v * 100).toFixed(3)}%`;
const rectStyle = (r: Rect): CSSProperties => ({ left: pct(r.x), top: pct(r.y), width: pct(r.w), height: pct(r.h) });

// Safari 트랙패드 핀치는 표준이 아닌 gesture* 이벤트로 온다
type GestureLike = Event & { scale: number; clientX: number; clientY: number };

type Props = {
  map: FloorMap;
  myEmpNo: string;
  zoom: number;
  onZoomChange: (zoom: number) => void;
  /** 도면 전체가 영역에 들어오는 배율 (1보다 작으면 100%일 때 도면이 영역보다 크다) */
  onFitZoom?: (zoom: number) => void;
  focusZoneId: number | null;
  visibleStatuses: Set<StatusFilter>;
  selectedSeatId: number | null;
  onSelectSeat: (seatId: number) => void;
  /** 눌러서 고정한 정보 카드 (좁은 화면에서는 오른쪽 패널 대신 이걸 띄운다) */
  pinnedSeatId: number | null;
  onUnpin: () => void;
};

export default function FloorPlan(props: Props) {
  const { map, myEmpNo, zoom, onZoomChange, focusZoneId, visibleStatuses, selectedSeatId, onSelectSeat } = props;
  const { pinnedSeatId, onUnpin, onFitZoom } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const planRef = useRef<HTMLDivElement>(null);
  const [hoverSeatId, setHoverSeatId] = useState<number | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const panningRef = useRef(false);
  const zoomRef = useRef(zoom); // 이벤트 처리 중에 읽는 최신 배율
  const prevZoomRef = useRef(zoom);
  const anchorRef = useRef<{ x: number; y: number } | null>(null); // 확대 기준점 (스크롤 영역 안 좌표)
  const onZoomRef = useRef(onZoomChange);
  const fitRef = useRef({ zoom: 1, report: onFitZoom });
  const hasPlan = map.plan !== null;
  // 좌석 이름 글자 크기 (cqw): 층의 보통 책상에 "● 가나다"가 들어가는 크기. 도면은 이 글자가 읽히는 폭보다 작아지지 않는다
  const aspect = map.plan ? map.plan.height_m / map.plan.width_m : 0.6;
  const seatSize = map.plan ? seatRatio(map.plan.width_m, map.plan.height_m) : { w: 0, h: 0 };
  const boxOf = (seat: Seat): SeatBox => seatBox(seat.w ?? seatSize.w, seat.h ?? seatSize.h, aspect);
  const baseFont = baseSeatFont(map.seats.map(boxOf));
  const baseFontRef = useRef(baseFont);

  useEffect(() => {
    onZoomRef.current = onZoomChange;
    baseFontRef.current = baseFont;
    fitRef.current.report = onFitZoom;
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

  // 도면이 영역보다 크면(확대·사람이 많은 층) 손 모양 커서를 보여 준다.
  // 도면 전체가 들어오는 배율을 알려 주고, 이름이 읽히지 않을 만큼 작으면 이름을 숨긴다(재실 표시만)
  useEffect(() => {
    const el = scrollRef.current;
    const plan = planRef.current;
    if (!el || !plan) return;
    const update = () => {
      el.dataset.pannable = String(el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1);
      const width = plan.getBoundingClientRect().width;
      plan.dataset.compact = String(compactAt(width, baseFontRef.current));
      const baseW = width / zoomRef.current;
      const baseH = (baseW * plan.offsetHeight) / Math.max(1, plan.offsetWidth);
      const maxH = parseFloat(getComputedStyle(el).maxHeight) || el.clientHeight;
      const fit = Math.min(1, el.clientWidth / baseW, maxH / baseH);
      if (Math.abs(fit - fitRef.current.zoom) > 0.005) {
        fitRef.current.zoom = fit;
        fitRef.current.report?.(fit);
      }
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
      if (!target.closest(`.${styles.popover}, .${styles.sheet}, .${styles.seat}`)) onUnpin();
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

  // 핀치 확대·축소
  // - 트랙패드 (Chrome·Edge·Firefox): 핀치가 ctrlKey가 붙은 wheel 이벤트로 온다 (Ctrl+마우스 휠도 같은 이벤트)
  // - 트랙패드 (Safari): gesturestart/gesturechange 의 scale 로 온다
  // - 휴대폰·태블릿: 두 손가락 터치. 손가락 사이가 벌어진 비율만큼 키우고, 두 손가락을 같이 움직이면 도면을 옮긴다
  // 브라우저 화면 전체가 확대되지 않도록 도면 영역에서만 막는다 (CSS touch-action). 한 손가락은 원래대로 스크롤
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let gestureBase: number | null = null;
    let drag: { id: number; x: number; y: number; left: number; top: number; moved: boolean } | null = null;
    let suppressClick = false;
    let pinch: { dist: number; zoom: number; x: number; y: number } | null = null;
    let pinchEndedAt = 0;

    function zoomAt(next: number, clientX: number, clientY: number) {
      const zoom = clampZoom(next, fitRef.current.zoom);
      if (zoom === zoomRef.current) return;
      const rect = el!.getBoundingClientRect();
      anchorRef.current = { x: clientX - rect.left, y: clientY - rect.top };
      zoomRef.current = zoom;
      onZoomRef.current(zoom);
    }
    function onWheel(event: WheelEvent) {
      if (!event.ctrlKey || gestureBase !== null) return;
      event.preventDefault();
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY; // 줄 단위면 픽셀로
      zoomAt(zoomRef.current * Math.exp(-Math.max(-50, Math.min(50, delta)) * 0.01), event.clientX, event.clientY);
    }
    // iPhone·iPad Safari는 두 손가락 터치에도 gesture* 이벤트를 같이 보낸다: 터치로 처리 중이면 두 번 키우지 않는다
    function onGestureStart(event: Event) {
      event.preventDefault();
      gestureBase = pinch ? null : zoomRef.current;
    }
    function onGestureChange(event: Event) {
      event.preventDefault();
      const g = event as GestureLike;
      if (gestureBase !== null && !pinch) zoomAt(gestureBase * g.scale, g.clientX, g.clientY);
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
      drag = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        left: el!.scrollLeft,
        top: el!.scrollTop,
        moved: false,
      };
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
      // 끌기를 마친 손, 핀치를 마치고 남은 손가락이 떨어질 때 그 아래 자리가 눌리지 않게
      if (!suppressClick && Date.now() - pinchEndedAt > 400) return;
      suppressClick = false;
      event.stopPropagation();
      event.preventDefault();
    }

    /** 도면 위에 있는 두 손가락의 가운데와 사이 거리 */
    function twoFingers(event: TouchEvent) {
      const [a, b] = Array.from(event.touches).filter((t) => el!.contains(t.target as Node));
      if (!a || !b || event.touches.length !== 2) return null;
      return {
        x: (a.clientX + b.clientX) / 2,
        y: (a.clientY + b.clientY) / 2,
        dist: Math.max(1, Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)),
      };
    }
    function onTouchStart(event: TouchEvent) {
      const f = twoFingers(event);
      if (!f) return;
      pinch = { dist: f.dist, zoom: zoomRef.current, x: f.x, y: f.y };
      clearTimeout(hoverTimer.current);
    }
    function onTouchMove(event: TouchEvent) {
      const f = pinch && twoFingers(event);
      if (!pinch || !f) return;
      // 브라우저가 두 손가락 스크롤을 하지 않게 막고, 가운데가 움직인 만큼 직접 옮긴다
      // (이미 스크롤 중이라 막을 수 없으면 브라우저가 옮기니 두 번 옮기지 않는다)
      if (event.cancelable) {
        event.preventDefault();
        el!.scrollLeft -= f.x - pinch.x;
        el!.scrollTop -= f.y - pinch.y;
      }
      pinch.x = f.x;
      pinch.y = f.y;
      zoomAt(pinch.zoom * (f.dist / pinch.dist), f.x, f.y);
    }
    function onTouchEnd(event: TouchEvent) {
      if (!pinch || event.touches.length >= 2) return;
      pinch = null;
      pinchEndedAt = Date.now();
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
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd);
    el.addEventListener("touchcancel", onTouchEnd);
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
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
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
        style={
          {
            aspectRatio: `${plan.width_m} / ${plan.height_m}`,
            "--zoom": zoom,
            "--min-w": `${minPlanWidth(baseFont)}px`,
          } as CSSProperties
        }
        role="group"
        aria-label={`${map.floor.site.name} ${map.floor.name} 좌석 배치도`}
      >
        <PlanShapes geometry={geometry} width_m={plan.width_m} height_m={plan.height_m} />
        {map.rooms.map(
          (room) => room.shape && <RoomBox key={room.id} room={room} shape={room.shape} floorId={map.floor.id} />,
        )}
        {zonePieces(map.zones, (zone) => zoneRects(zone.shape)).map(({ zone, rect }, i) => (
          <div
            key={`${zone.id}-${i}`}
            className={`${styles.zone} ${focusZoneId && focusZoneId !== zone.id ? styles.dim : ""} ${
              focusZoneId === zone.id ? styles.zoneFocus : ""
            }`}
            data-color={zone.color_key}
            data-shared={zone.department === null}
            style={rectStyle(rect)}
          />
        ))}
        {/* 이름표는 모든 구역을 칠한 뒤에 그려서 다른 구역 조각에 가려지지 않게 */}
        {zonePieces(map.zones, (zone) => zoneRects(zone.shape))
          .filter((piece) => piece.tagged)
          .map(({ zone, rect }) => (
            <span
              key={`tag-${zone.id}`}
              className={`${styles.zoneTag} ${focusZoneId && focusZoneId !== zone.id ? styles.dim : ""}`}
              data-color={zone.color_key}
              style={{ left: pct(rect.x), top: pct(rect.y) }}
            >
              {zone.name} · {zone.code}
            </span>
          ))}
        {map.seats.map((seat) => (
          <SeatButton
            key={seat.id}
            seat={seat}
            size={seatSize}
            box={boxOf(seat)}
            baseFont={baseFont}
            zone={seat.zone_id ? zones.get(seat.zone_id) : undefined}
            dimmed={
              (focusZoneId !== null && seat.zone_id !== focusZoneId) ||
              (!!seat.occupant && !visibleStatuses.has(seat.occupant.presence?.status ?? "NONE"))
            }
            mine={seat.occupant?.emp_no === myEmpNo}
            selected={seat.id === selectedSeatId}
            onSelect={onSelectSeat}
            onHoverStart={startHover}
            onHoverEnd={endHover}
          />
        ))}
        <ScaleBar width_m={plan.width_m} height_m={plan.height_m} />
        {cardSeat && (
          <SeatCard
            key={cardSeat.id}
            seat={cardSeat}
            size={seatSize}
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

/** 도면 위 회의실. 누르면 회의실 화면에서 이 층 예약 현황을 연다 */
function RoomBox({ room, shape, floorId }: { room: Room; shape: Rect & ShapeStyle; floorId: number }) {
  const status = roomStatusText(room);
  return (
    <Link
      href={`/rooms?floor=${floorId}`}
      className={styles.room}
      style={{ ...rectStyle(shape), ...lineStyle(shape) }}
      data-busy={!!room.busy_until}
      aria-label={`${room.name}, ${status}. 예약 현황 보기`}
      title="예약 현황 보기"
    >
      <span style={labelStyle(shape)}>
        {room.name}
        <br />
        <span className={styles.roomStatus}>{status}</span>
      </span>
    </Link>
  );
}

type SeatSize = { w: number; h: number };

type SeatProps = {
  seat: Seat;
  size: SeatSize;
  /** 좌석 폭·높이 (cqw)와 층 기본 글자 크기 */
  box: SeatBox;
  baseFont: number;
  zone: Zone | undefined;
  dimmed: boolean;
  mine: boolean;
  selected: boolean;
  onSelect: (seatId: number) => void;
  onHoverStart: (seatId: number) => void;
  onHoverEnd: () => void;
};

function SeatButton(props: SeatProps) {
  const { seat, size: base, box, baseFont, zone, dimmed, mine, selected, onSelect, onHoverStart, onHoverEnd } = props;
  const { occupant } = seat;
  const size = { w: seat.w ?? base.w, h: seat.h ?? base.h };
  const presence = occupant?.presence?.status;
  const outOfService = seat.status === "OUT_OF_SERVICE";

  let text: string;
  let label: string;
  if (occupant) {
    text = occupant.name;
    label = `${mine ? "내 자리, " : ""}${occupant.name}, ${occupant.department} ${seat.code}, ${
      presence ? PRESENCE_LABEL[presence] : NO_STATUS_LABEL
    }`;
  } else if (outOfService) {
    text = "사용 중지";
    label = `사용 중지 좌석 ${seat.code}`;
  } else {
    text = seat.seat_type === "FLEX" ? "자율석" : "빈 자리";
    label = `${text} ${seat.code}${zone ? `, ${zone.name}` : ""}`;
  }

  const chair = { 0: styles.chairBottom, 90: styles.chairRight, 180: styles.chairTop, 270: styles.chairLeft }[
    seat.rotation
  ];
  const className = [
    styles.seat,
    occupant ? "" : styles.seatEmpty,
    outOfService ? styles.seatOff : "",
    presence === "AWAY" ? styles.seatAway : "",
    dimmed ? styles.dim : "",
    selected ? styles.seatSelected : "",
    mine ? styles.seatMine : "",
  ].join(" ");

  return (
    <button
      type="button"
      className={className}
      data-color={zone?.color_key ?? "t0"}
      style={{
        left: pct(seat.x - size.w / 2),
        top: pct(seat.y - size.h / 2),
        width: pct(size.w),
        height: pct(size.h),
        // 이름이 좌석에 다 들어가는 크기 (재실 표시 자리 포함). 의자는 책상 깊이에 맞춘다
        fontSize: `${seatFont(box, text, !!presence, baseFont).toFixed(3)}cqw`,
        ...({ "--d": `${Math.min(box.w, box.h).toFixed(3)}cqw` } as CSSProperties),
      }}
      title={seat.code}
      aria-label={label}
      aria-pressed={selected}
      data-seat-id={seat.id}
      data-vertical={seat.rotation === 90 || seat.rotation === 270 || undefined}
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
      {mine && (
        <span className={styles.seatMeTag} aria-hidden="true">
          나
        </span>
      )}
    </button>
  );
}

type CardProps = {
  seat: Seat;
  size: SeatSize;
  zone: Zone | undefined;
  floorName: string;
  pinned: boolean;
  onClose: () => void;
};

/**
 * 자리 위(위쪽 자리면 아래)에 뜨는 사람 정보 카드. 글자 크기는 배율과 상관없이 같다.
 * 휴대폰에서 눌러 고정한 카드는 도면 밖, 화면 아래에서 올라오는 시트로 띄운다 (도면 가장자리에서 잘리지 않게)
 */
function SeatCard({ seat, size: base, zone, floorName, pinned, onClose }: CardProps) {
  const size = { w: seat.w ?? base.w, h: seat.h ?? base.h };
  const phone = useMediaQuery("(max-width: 720px)");
  const occupant = seat.occupant!;
  const body = (
    <>
      <div className={styles.popoverHead}>
        {occupant.photo && (
          <span className={styles.popoverAvatar} aria-hidden="true">
            <Avatar name={occupant.name} photo={occupant.photo} size={32} />
          </span>
        )}
        <strong>
          {occupant.name} <span>{occupant.rank}</span>
          {occupant.display_name && <span className={styles.popoverMuted}> · {occupant.display_name}</span>}
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
      {occupant.headline && <span className={styles.popoverHeadline}>{occupant.headline}</span>}
      <PresenceLine occupant={occupant} />
      {occupant.skills.length > 0 && (
        <span className={styles.popoverSkills}>
          {occupant.skills.slice(0, 4).map((s) => (
            <span key={s}>#{s}</span>
          ))}
        </span>
      )}
      <span className={`mono ${styles.popoverMuted}`}>
        {floorName} {seat.code}
        {occupant.extension && ` · 내선 ${occupant.extension}`}
        {occupant.kind === "DAILY" && " · 오늘만 이 자리"}
      </span>
    </>
  );

  if (pinned && phone) {
    return createPortal(
      <div className={styles.sheet} role="dialog" aria-label={`${occupant.name} 정보`}>
        {body}
      </div>,
      document.body,
    );
  }

  const below = seat.y < 0.3;
  const align = seat.x < 0.2 ? "start" : seat.x > 0.8 ? "end" : "center";
  const left = align === "start" ? seat.x - size.w / 2 : align === "end" ? seat.x + size.w / 2 : seat.x;
  return (
    <div
      className={styles.popover}
      data-place={below ? "below" : "above"}
      data-align={align}
      data-pinned={pinned}
      style={{ left: pct(left), top: pct(below ? seat.y + size.h / 2 : seat.y - size.h / 2) }}
      role={pinned ? "dialog" : "tooltip"}
      aria-label={`${occupant.name} 정보`}
    >
      {body}
    </div>
  );
}

/** 재실 상태 한 줄 + 언제 바꿨는지·언제 풀리는지 (오래된 상태를 알아보게) */
export function PresenceLine({ occupant }: { occupant: Occupant }) {
  const now = useNow();
  const presence = occupant.presence;
  if (!presence) {
    return (
      <span className={styles.popoverStatus}>
        <span className={styles.popoverMuted}>{NO_STATUS_LABEL}</span>
      </span>
    );
  }
  const ago = presence.updated_at ? agoText(presence.updated_at, now) : "";
  return (
    <>
      <span className={styles.popoverStatus}>
        <span className="mk" data-status={presence.status} aria-hidden="true" />
        <strong>{PRESENCE_LABEL[presence.status]}</strong>
        {presence.message && <span>· {presence.message}</span>}
      </span>
      {(ago || presence.expires_at) && (
        <span className={styles.popoverMuted}>
          {ago && `${ago} 변경`}
          {ago && presence.expires_at && " · "}
          {presence.expires_at && `${hhmm.format(new Date(presence.expires_at))}에 자동 해제`}
        </span>
      )}
    </>
  );
}
