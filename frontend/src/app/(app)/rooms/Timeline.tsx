"use client";

import { type CSSProperties, type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { RoomDay, RoomsDay } from "@/lib/api";
import { minToHHMM } from "@/lib/dates";
import { rangeText, spanDays } from "@/lib/rooms";
import { equipmentText } from "./ReservationForm";
import { type Draft, dragRange, isPast, slotStarts } from "./slots";
import styles from "./rooms.module.css";

type Props = {
  day: RoomsDay;
  rooms: RoomDay[]; // 필터를 거친 회의실
  draft: Draft;
  onPick: (room: RoomDay, start: number) => void;
  /** 빈 칸을 끌어서 고른 시간 (마우스, 터치는 꾹 누른 채 끌기) */
  onPickRange: (room: RoomDay, start: number, end: number) => void;
  onOpenBooking: (reservationId: number) => void;
};

/** 표 안에서 방향키로 옮겨 다닐 칸: 행·시작 열·칸 수 */
type NavCell = { el: HTMLElement; r: number; c: number; span: number };

const EDGE_PX = 48; // 끄는 동안 손이 표의 왼쪽·오른쪽 끝에서 이만큼 안에 들어오면 표를 그쪽으로 민다
const HOLD_MS = 400; // 터치: 빈 칸을 이만큼 누르고 있으면 끌어서 고르기 시작 (그 전에 밀면 표가 옆으로 넘어간다)
const HOLD_SLOP_PX = 10; // 누르고 있는 동안 이만큼 넘게 움직이면 표를 미는 것으로 본다

/**
 * 예약 현황표. 회의실마다 한 줄, 칸 하나 = 30분. 빈 칸을 누르면 그 시간부터 1시간, 마우스로 끌면 끈 만큼 고른다
 * (휴대폰은 손가락으로 밀면 표가 옆으로 넘어가야 해서, 칸을 꾹 누른 채 끌어야 고른다).
 * 예약은 칸 여러 개를 이어 붙인 블록 하나로 그리고, 누르면 자세한 내용을 띄운다
 * (내가 예약했거나 참석하는 회의는 검정. 글자로 "내 예약"과 "참석"을 구별한다).
 * 키보드: 표 전체가 Tab 한 번이고, 안에서는 방향키·Home·End로 옮긴다 (칸 수백 개를 Tab으로 지나가지 않게)
 */
export default function Timeline({ day, rooms, draft, onPick, onPickRange, onOpenBooking }: Props) {
  const { open_start: open, open_end: close, slot } = day.policy;
  const starts = slotStarts(day);
  const col = (minute: number) => 2 + Math.round((Math.min(Math.max(minute, open), close) - open) / slot);
  const hours = starts.filter((s) => s % 60 === 0);
  const nowVisible = day.now_min !== null && day.now_min >= open && day.now_min < close;
  const scrollRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  // 끌어서 시간 고르기: 누른 칸(from)부터 지금 손이 있는 칸(to)까지, 같은 회의실 줄 안에서만
  const [drag, setDrag] = useState<{ room: RoomDay; from: number; to: number } | null>(null);
  const dragRef = useRef(drag);
  const roomsRef = useRef(rooms);
  const suppressClick = useRef(false);
  const dragSel = drag ? dragRange(day, drag.room, drag.from, drag.to) : null;

  // 손을 떼면(표 밖에서 떼도) 고른 시간으로 예약 팝업을 연다. 한 칸에서 누르고 떼기만 했으면 그 칸부터 1시간
  function finishDrag() {
    const d = dragRef.current;
    dragRef.current = null; // 마우스 pointerup과 터치 touchend가 같이 와도 한 번만 연다
    setDrag(null);
    if (!d) return;
    suppressClick.current = true; // 뒤따르는 click으로 한 번 더 열리지 않게
    setTimeout(() => (suppressClick.current = false), 0);
    if (d.to === d.from) onPick(d.room, d.from);
    else {
      const r = dragRange(day, d.room, d.from, d.to);
      onPickRange(d.room, r.start, r.end);
    }
  }
  const finishRef = useRef(finishDrag);

  useEffect(() => {
    dragRef.current = drag;
    roomsRef.current = rooms;
    finishRef.current = finishDrag;
  });

  // Esc는 그만두기
  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;
    const finish = () => finishRef.current();
    function onKey(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") setDrag(null);
    }
    window.addEventListener("pointerup", finish);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("keydown", onKey);
    };
  }, [dragging]);

  // 터치로 끌어서 고르기: 빈 칸을 꾹(0.4초) 누르고 있으면 시작하고, 그때부터는 손가락이 표를 밀지 않고 시간을 늘린다.
  // 터치는 누른 칸에 붙어 있어서(다른 칸에 pointerenter가 오지 않음) 손가락 밑의 칸을 직접 찾는다
  useEffect(() => {
    const grid = gridRef.current;
    const scroller = scrollRef.current;
    if (!grid || !scroller) return;
    let hold: ReturnType<typeof setTimeout> | undefined;
    let pressed: { x: number; y: number } | null = null;
    function cancelHold() {
      clearTimeout(hold);
      pressed = null;
    }
    function onTouchStart(event: TouchEvent) {
      cancelHold();
      const cell = (event.target as Element).closest<HTMLElement>(`.${styles.ttCell}[data-nav]`);
      const room = cell && roomsRef.current[Number(cell.dataset.r)];
      if (event.touches.length !== 1 || !cell || !room) return;
      const start = open + (Number(cell.dataset.c) - 2) * slot;
      pressed = { x: event.touches[0].clientX, y: event.touches[0].clientY };
      hold = setTimeout(() => {
        pressed = null;
        setDrag({ room, from: start, to: start });
      }, HOLD_MS);
    }
    function onTouchMove(event: TouchEvent) {
      const t = event.touches[0];
      if (!t) return;
      if (pressed && Math.hypot(t.clientX - pressed.x, t.clientY - pressed.y) > HOLD_SLOP_PX) cancelHold();
      const d = dragRef.current;
      if (!d) return;
      if (event.cancelable) event.preventDefault(); // 끄는 동안은 표·화면이 밀리지 않게
      const target = document.elementFromPoint(t.clientX, t.clientY);
      const cell = target instanceof Element ? target.closest<HTMLElement>(`.${styles.ttCell}`) : null;
      if (cell && Number(cell.dataset.r) === roomsRef.current.findIndex((x) => x.id === d.room.id)) {
        const s = open + (Number(cell.dataset.c) - 2) * slot;
        if (s !== d.to) setDrag({ ...d, to: s });
      }
    }
    function onTouchEnd(event: TouchEvent) {
      cancelHold();
      if (!dragRef.current) return;
      if (event.cancelable) event.preventDefault(); // 손을 뗀 칸에 click이 한 번 더 가지 않게
      finishRef.current();
    }
    function onTouchCancel() {
      cancelHold();
      setDrag(null);
    }
    grid.addEventListener("touchstart", onTouchStart, { passive: true });
    grid.addEventListener("touchmove", onTouchMove, { passive: false });
    grid.addEventListener("touchend", onTouchEnd);
    grid.addEventListener("touchcancel", onTouchCancel);
    scroller.addEventListener("scroll", cancelHold, { passive: true }); // 누르는 사이 표가 밀리기 시작했으면 고르지 않는다
    return () => {
      cancelHold();
      grid.removeEventListener("touchstart", onTouchStart);
      grid.removeEventListener("touchmove", onTouchMove);
      grid.removeEventListener("touchend", onTouchEnd);
      grid.removeEventListener("touchcancel", onTouchCancel);
      scroller.removeEventListener("scroll", cancelHold);
    };
  }, [open, slot]);

  // 끄는 동안 손이 표의 왼쪽·오른쪽 끝에 가면 표를 그쪽으로 밀어서, 지금 보이는 시간 밖까지 끌 수 있게 한다.
  // 표가 손 밑에서 움직이면 칸의 pointerenter가 오지 않으므로, 민 다음 손 위치의 칸을 직접 찾아 끈 범위를 늘린다
  useEffect(() => {
    if (!dragging) return;
    let pointerX = -1;
    let frame = 0;
    function track(event: PointerEvent | TouchEvent) {
      pointerX = "touches" in event ? (event.touches[0]?.clientX ?? pointerX) : event.clientX;
    }
    function tick() {
      const el = scrollRef.current;
      const d = dragRef.current;
      if (el && d && pointerX >= 0) {
        const rect = el.getBoundingClientRect();
        const left = rect.left + (el.querySelector<HTMLElement>(`.${styles.ttCorner}`)?.offsetWidth ?? 0);
        const speed =
          pointerX > rect.right - EDGE_PX
            ? Math.ceil((pointerX - (rect.right - EDGE_PX)) / 4)
            : pointerX < left + EDGE_PX
              ? -Math.ceil((left + EDGE_PX - pointerX) / 4)
              : 0;
        const before = el.scrollLeft;
        if (speed) el.scrollLeft += speed;
        if (el.scrollLeft !== before) {
          const r = roomsRef.current.findIndex((x) => x.id === d.room.id);
          const rowCell = gridRef.current?.querySelector<HTMLElement>(`[data-r="${r}"]`)?.getBoundingClientRect();
          const x = Math.min(Math.max(pointerX, left + 1), rect.right - 1);
          const target = rowCell && document.elementFromPoint(x, rowCell.top + rowCell.height / 2);
          const cell = target instanceof Element ? target.closest<HTMLElement>("[data-c]") : null;
          if (cell && Number(cell.dataset.r) === r) {
            const s = open + (Number(cell.dataset.c) - 2) * slot;
            if (s !== d.to) setDrag({ ...d, to: s });
          }
        }
      }
      frame = requestAnimationFrame(tick);
    }
    window.addEventListener("pointermove", track);
    window.addEventListener("touchmove", track, { passive: true });
    frame = requestAnimationFrame(tick);
    return () => {
      window.removeEventListener("pointermove", track);
      window.removeEventListener("touchmove", track);
      cancelAnimationFrame(frame);
    };
  }, [dragging, open, slot]);

  // 표가 옆으로 넘치면 알려 주고, 오늘이면 지금 시각이 보이게 처음에 옆으로 밀어 둔다
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setOverflowing(el.scrollWidth > el.clientWidth + 1));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const el = scrollRef.current;
    const now = el?.querySelector<HTMLElement>(`.${styles.ttNow}`);
    const corner = el?.querySelector<HTMLElement>(`.${styles.ttCorner}`);
    if (el && now && corner) el.scrollLeft = Math.max(0, now.offsetLeft - corner.offsetWidth - 60);
  }, [day.date]);

  // 방향키로 옮길 수 있는 칸 (지난 칸은 고를 수 없어서 빠진다)
  function navCells(): NavCell[] {
    return [...(gridRef.current?.querySelectorAll<HTMLElement>("[data-nav]") ?? [])].map((el) => ({
      el,
      r: Number(el.dataset.r),
      c: Number(el.dataset.c),
      span: Number(el.dataset.span),
    }));
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (
      !target.dataset.nav ||
      !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)
    ) {
      return;
    }
    const cells = navCells();
    const cur = cells.find((x) => x.el === target);
    if (!cur) return;
    const row = (r: number) => cells.filter((x) => x.r === r).sort((a, b) => a.c - b.c);
    let next: NavCell | undefined;
    if (event.key === "ArrowRight") next = row(cur.r).find((x) => x.c >= cur.c + cur.span);
    else if (event.key === "ArrowLeft")
      next = row(cur.r)
        .filter((x) => x.c < cur.c)
        .at(-1);
    else if (event.key === "Home") next = row(cur.r)[0];
    else if (event.key === "End") next = row(cur.r).at(-1);
    else {
      const step = event.key === "ArrowDown" ? 1 : -1;
      for (let r = cur.r + step; !next && r >= 0 && r < rooms.length; r += step) {
        const candidates = row(r);
        next =
          candidates.find((x) => x.c <= cur.c && cur.c < x.c + x.span) ??
          candidates.sort((a, b) => Math.abs(a.c - cur.c) - Math.abs(b.c - cur.c))[0];
      }
    }
    event.preventDefault();
    if (next) {
      next.el.focus();
      next.el.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }

  // Tab으로 들어올 칸: 마지막에 머문 칸, 없으면 고른 칸, 없으면 맨 위 줄의 첫 빈 칸
  const firstFree = rooms
    .flatMap((room, r) => starts.filter((s) => !isPast(day, s)).map((s) => ({ r, s, room })))
    .find(({ s, room }) => !room.bookings.some((b) => b.start_min <= s && b.end_min > s));
  const selectedKey =
    draft.roomId !== null && draft.start !== null
      ? `${rooms.findIndex((r) => r.id === draft.roomId)}:${col(draft.start)}`
      : null;
  const tabKey = activeKey ?? selectedKey ?? (firstFree ? `${firstFree.r}:${col(firstFree.s)}` : null);

  return (
    <>
      {overflowing && (
        <p className={styles.scrollHint}>표를 옆으로 밀면 다른 시간이 보여요 · 칸에서 방향키로도 옮길 수 있어요</p>
      )}
      <p className={styles.dragStatus} aria-live="polite">
        {drag && dragSel
          ? `${drag.room.name} ${minToHHMM(dragSel.start)}–${minToHHMM(dragSel.end)} · 손을 떼면 예약 (Esc: 그만두기)`
          : ""}
      </p>
      <div ref={scrollRef} className={styles.ttScroll}>
        <div
          ref={gridRef}
          className={styles.tt}
          data-dragging={dragging || undefined}
          style={{ "--slots": starts.length, "--rows": rooms.length } as CSSProperties}
          role="grid"
          aria-label="예약 현황표"
          aria-rowcount={rooms.length + 1}
          onKeyDown={onKeyDown}
          onFocus={(event) => {
            const el = event.target as HTMLElement;
            if (el.dataset.nav) setActiveKey(`${el.dataset.r}:${el.dataset.c}`);
          }}
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
                  {room.floor.name} · {room.capacity}인
                  {room.equipment.length ? ` · ${equipmentText(room.equipment)}` : ""}
                </span>
              </div>
              {starts.map((s) => {
                if (room.bookings.some((b) => b.start_min <= s && b.end_min > s)) return null; // 예약 블록이 덮는 칸
                const past = isPast(day, s);
                // 여러 날 예약을 고르면 시작 날에는 시작 칸부터 문 닫을 때까지 칠한다. 끄는 중이면 끈 만큼
                const selected = dragSel
                  ? drag!.room.id === room.id && s >= dragSel.start && s < dragSel.end
                  : draft.roomId === room.id &&
                    draft.start !== null &&
                    draft.end !== null &&
                    s >= draft.start &&
                    (draft.endDays > 0 || s < draft.end);
                const key = `${r}:${col(s)}`;
                return (
                  <button
                    key={s}
                    type="button"
                    role="gridcell"
                    className={styles.ttCell}
                    data-hour={s % 60 === 0 || undefined}
                    data-past={past || undefined}
                    data-selected={selected || undefined}
                    data-nav={past ? undefined : true}
                    data-r={r}
                    data-c={col(s)}
                    data-span={1}
                    tabIndex={key === tabKey ? 0 : -1}
                    style={{ gridColumn: col(s) }}
                    disabled={past}
                    aria-selected={selected}
                    aria-label={`${room.name} ${minToHHMM(s)}–${minToHHMM(s + slot)} ${past ? "지난 시간" : "비어 있음"}`}
                    onPointerDown={(event) => {
                      // 마우스는 누르자마자 끌기. 터치는 꾹 누른 뒤에 (위의 touchstart: 손가락으로 밀면 표가 옆으로 넘어가야 한다)
                      if (event.pointerType === "touch" || event.button !== 0 || past) return;
                      event.preventDefault();
                      setDrag({ room, from: s, to: s });
                    }}
                    onPointerEnter={() => {
                      if (drag && drag.room.id === room.id && drag.to !== s) setDrag({ ...drag, to: s });
                    }}
                    onClick={() => {
                      if (!suppressClick.current) onPick(room, s); // 키보드(Enter·Space)·터치
                    }}
                  />
                );
              })}
              {room.bookings.map((b) => {
                const days = spanDays(b.starts_at, b.ends_at);
                const when = days
                  ? `${rangeText(b.starts_at, b.ends_at)} (${days}일)`
                  : `${minToHHMM(b.start_min)}–${minToHHMM(b.end_min)}`;
                const c = col(b.start_min);
                return (
                  <button
                    key={b.id}
                    type="button"
                    role="gridcell"
                    className={styles.ttBooking}
                    data-mine={b.mine || undefined}
                    data-nav
                    data-r={r}
                    data-c={c}
                    data-span={Math.max(1, col(b.end_min) - c)}
                    tabIndex={`${r}:${c}` === tabKey ? 0 : -1}
                    style={{ gridColumn: `${c} / ${col(b.end_min)}` }}
                    title={`${b.title} · ${b.department} ${b.organizer} · ${when}`}
                    aria-haspopup="dialog"
                    aria-label={`${room.name} ${when} ${b.title}, ${b.department} ${b.organizer}${
                      b.organized ? ", 내 예약" : b.mine ? ", 내가 참석하는 회의" : ""
                    }. 누르면 자세히`}
                    onClick={() => onOpenBooking(b.id)}
                  >
                    <strong>{b.title}</strong>
                    <span>
                      {days ? `${days}일 예약 · ` : ""}
                      {b.organized ? "내 예약" : b.mine ? `참석 · ${b.department}` : b.department}
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
    </>
  );
}
