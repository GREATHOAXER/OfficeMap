"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import DatePicker from "@/components/DatePicker";
import { ChevronLeftIcon, ChevronRightIcon, CloseIcon } from "@/components/icons";
import type { MyReservation, RoomDay, RoomsDay } from "@/lib/api";
import { addDays, formatShortDay, minToHHMM } from "@/lib/dates";
import MyReservations from "./MyReservations";
import ReservationForm, { equipmentText } from "./ReservationForm";
import { canStartAt, defaultRange, type Draft, EMPTY_DRAFT, latestEnd } from "./slots";
import Timeline from "./Timeline";
import styles from "./rooms.module.css";

/** 본문 폭이 이보다 넓으면 예약 폼을 오른쪽에 두고, 좁으면 팝업으로 띄운다 (CSS의 @container 값과 같아야 한다) */
const WIDE_MIN = 980;

const CAPACITY_FILTERS = [
  { value: 0, label: "제한 없음" },
  { value: 4, label: "4명 이상" },
  { value: 8, label: "8명 이상" },
  { value: 12, label: "12명 이상" },
];

type Props = { day: RoomsDay; mine: MyReservation[] };

export default function RoomsView({ day, mine }: Props) {
  const router = useRouter();
  const [floor, setFloor] = useState<number | "all">("all");
  const [minCapacity, setMinCapacity] = useState(0);
  const [needVideo, setNeedVideo] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [wide, setWide] = useState(true);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // 날짜를 바꾸거나 데이터를 다시 읽으면, 작성 중인 예약의 시간이 그날에도 비어 있는지 다시 본다
  const [checkedDay, setCheckedDay] = useState(day);
  if (checkedDay !== day) {
    setCheckedDay(day);
    setDraft((d) => keepIfStillFree(d, day));
  }

  // 본문 폭을 재서 예약 폼을 오른쪽에 둘지 팝업으로 띄울지 정한다. 폼 입력값은 이 화면이 들고 있어서 옮겨도 남는다
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const isWide = entry.contentRect.width >= WIDE_MIN;
      setWide(isWide);
      // 넓어지면 팝업은 닫고 오른쪽 폼으로 이어 쓴다. 다시 좁아져도 저절로 열지는 않는다 ("작성 중인 예약 이어서")
      if (isWide) setSheetOpen(false);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  const floors = [...new Map(day.rooms.map((r) => [r.floor.id, r.floor])).values()];
  const floorFilter = floors.some((f) => f.id === floor) ? floor : "all";
  const rooms = day.rooms.filter(
    (r) =>
      (floorFilter === "all" || r.floor.id === floorFilter) &&
      r.capacity >= minCapacity &&
      (!needVideo || r.equipment.includes("VIDEO")),
  );

  function goToDate(iso: string) {
    router.push(`/rooms?date=${iso}&site=${day.site.id}`, { scroll: false });
  }

  function pickSlot(room: RoomDay, start: number) {
    const slot = day.policy.slot;
    setDraft((d) => {
      // 같은 회의실에서 고른 시작보다 뒤 칸을 누르면 끝 시각을 거기까지 옮긴다
      if (d.roomId === room.id && d.start !== null && start > d.start && start + slot <= latestEnd(day, room, d.start)) {
        return { ...d, end: start + slot };
      }
      return { ...d, roomId: room.id, ...defaultRange(day, room, start) };
    });
    setError(null);
    if (!wide) setSheetOpen(true);
  }

  async function submit() {
    if (draft.roomId === null || draft.start === null || draft.end === null) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/reservations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          room_id: draft.roomId,
          date: day.date,
          start_min: draft.start,
          end_min: draft.end,
          title: draft.title,
          attendees: draft.attendees.map((a) => a.emp_no),
          repeat: draft.repeat,
          repeat_until: draft.repeat === "NONE" ? null : draft.repeatUntil,
          notify: draft.notify,
        }),
      });
      if (res.status === 401) {
        router.replace("/login");
        return;
      }
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(errorText(data?.detail));
        if (res.status === 409) router.refresh(); // 먼저 잡힌 예약을 현황표에 보여 준다
        return;
      }
      const time = `${formatShortDay(day.date)} ${minToHHMM(draft.start)}–${minToHHMM(draft.end)}`;
      const repeat = data.count > 1 ? ` (${data.count}회)` : "";
      setNotice(
        data.status === "PENDING_APPROVAL"
          ? `${data.room} ${time}${repeat} 승인을 요청했어요. 승인되면 확정돼요.`
          : `${data.room} ${time}${repeat} 예약했어요.`,
      );
      setDraft(EMPTY_DRAFT);
      setSheetOpen(false);
      router.refresh();
    } catch {
      setError("예약하지 못했어요. 네트워크를 확인하고 다시 시도하세요.");
    } finally {
      setSubmitting(false);
    }
  }

  async function cancel(id: number) {
    const res = await fetch(`/api/reservations/${id}`, { method: "DELETE" });
    if (res.status === 401) {
      router.replace("/login");
      return;
    }
    setNotice(res.ok ? "예약을 취소했어요." : "취소하지 못했어요. 이미 끝났거나 취소된 예약일 수 있어요.");
    router.refresh();
  }

  const hasDraft = draft.roomId !== null || draft.title !== "" || draft.attendees.length > 0;
  const form = (
    <ReservationForm
      day={day}
      draft={draft}
      onDraftChange={setDraft}
      onDateChange={goToDate}
      onSubmit={submit}
      submitting={submitting}
      error={error}
    />
  );

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>회의실 확인·예약</h1>
        <div className={styles.dateNav} role="group" aria-label="날짜">
          <button type="button" className={styles.iconButton} aria-label="이전 날" onClick={() => goToDate(addDays(day.date, -1))}>
            <ChevronLeftIcon size={18} />
          </button>
          <DatePicker label="보는 날짜" value={day.date} today={day.today} onChange={goToDate} />
          <button type="button" className={styles.iconButton} aria-label="다음 날" onClick={() => goToDate(addDays(day.date, 1))}>
            <ChevronRightIcon size={18} />
          </button>
          <button type="button" className={styles.textButton} disabled={day.date === day.today} onClick={() => goToDate(day.today)}>
            오늘
          </button>
        </div>
        {!wide && (
          <button
            type="button"
            className={styles.openSheet}
            aria-haspopup="dialog"
            onClick={() => {
              setError(null);
              setSheetOpen(true);
            }}
          >
            {hasDraft ? "작성 중인 예약 이어서" : "예약하기"}
          </button>
        )}
      </header>

      <div className={styles.filters}>
        <div className={styles.seg} role="group" aria-label="층">
          <button type="button" aria-pressed={floorFilter === "all"} onClick={() => setFloor("all")}>
            전체 층
          </button>
          {floors.map((f) => (
            <button key={f.id} type="button" aria-pressed={floorFilter === f.id} onClick={() => setFloor(f.id)}>
              {f.name}
            </button>
          ))}
        </div>
        <label className={styles.inlineField}>
          인원
          <select value={minCapacity} onChange={(event) => setMinCapacity(Number(event.target.value))}>
            {CAPACITY_FILTERS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.inlineCheck}>
          <input type="checkbox" checked={needVideo} onChange={(event) => setNeedVideo(event.target.checked)} />
          화상회의 장비
        </label>
        {floorFilter !== "all" && (
          <Link className={styles.textButton} href={`/?floor=${floorFilter}`}>
            도면에서 보기
          </Link>
        )}
      </div>

      <p className={styles.notice} role="status">
        {notice}
      </p>

      <div ref={bodyRef} className={styles.body}>
        <div className={styles.layout} data-wide={wide}>
          <main className={styles.main}>
            {day.now_min !== null && <NowCards day={day} rooms={rooms} />}

            <section className={styles.ttCard} aria-labelledby="tt-title">
              <div className={styles.ttTop}>
                <h2 id="tt-title">
                  예약 현황표 <span className="mono">{formatShortDay(day.date)}</span>
                </h2>
                <span className={styles.legend}>
                  <span className={styles.lgBooked} aria-hidden="true" />
                  예약됨
                </span>
                <span className={styles.legend}>
                  <span className={styles.lgPending} aria-hidden="true" />
                  승인 대기
                </span>
                <span className={styles.legend}>
                  <span className={styles.lgMine} aria-hidden="true" />내 예약
                </span>
                <span className={styles.legend}>
                  <span className={styles.lgSelected} aria-hidden="true" />
                  선택
                </span>
                {day.now_min !== null && (
                  <span className={styles.legend}>
                    <span className={styles.lgNow} aria-hidden="true" />
                    지금
                  </span>
                )}
                <span className={styles.ttHint}>빈 칸을 눌러 시간 선택 · 뒤 칸을 누르면 거기까지 늘어나요</span>
              </div>
              {day.past && <p className={styles.pastNote}>지난 날짜예요. 예약 현황만 볼 수 있어요.</p>}
              {rooms.length === 0 ? (
                <p className={styles.empty}>조건에 맞는 회의실이 없어요.</p>
              ) : (
                <Timeline day={day} rooms={rooms} draft={draft} onPick={pickSlot} />
              )}
            </section>
          </main>

          <aside className={styles.side}>
            {wide && <div className={styles.formCard}>{form}</div>}
            <MyReservations items={mine} today={day.today} onCancel={cancel} />
          </aside>
        </div>
      </div>

      {!wide && (
        <Sheet open={sheetOpen} onClose={() => setSheetOpen(false)}>
          {form}
        </Sheet>
      )}
    </div>
  );
}

/** 그날 기준으로 다시 봤을 때 회의실이 없거나 시간이 차 있으면 시간만 비운다 (제목·참석자는 남긴다) */
function keepIfStillFree(d: Draft, day: RoomsDay): Draft {
  const room = day.rooms.find((r) => r.id === d.roomId);
  if (!room) return d.roomId === null ? d : { ...d, roomId: null, start: null, end: null };
  if (d.start === null || d.end === null) return d;
  const ok = canStartAt(day, room, d.start) && d.end <= latestEnd(day, room, d.start);
  return ok ? d : { ...d, start: null, end: null };
}

type ErrorDetail = { code?: string; dates?: string[]; max?: number; max_days?: number } | undefined;

function errorText(detail: ErrorDetail): string {
  switch (detail?.code) {
    case "TIME_TAKEN":
      return detail.dates?.length
        ? `그 시간에 이미 예약이 있어요: ${detail.dates.map(formatShortDay).join(", ")}`
        : "방금 다른 사람이 먼저 예약했어요. 현황표를 다시 확인하세요.";
    case "TOO_LONG":
      return `한 번에 최대 ${(detail.max ?? 120) / 60}시간까지 예약할 수 있어요.`;
    case "INVALID_TIME":
      return "예약할 수 없는 시간이에요. 운영 시간 안에서 30분 단위로 골라 주세요.";
    case "IN_PAST":
      return "지난 시간은 예약할 수 없어요.";
    case "TITLE_REQUIRED":
      return "회의 제목을 적어 주세요.";
    case "INVALID_REPEAT":
      return "반복 종료일을 확인하세요. 평일 반복은 기간 안에 평일이 있어야 해요.";
    case "REPEAT_TOO_LONG":
      return `반복 예약은 ${detail.max_days ?? 92}일 안에서만 할 수 있어요.`;
    case "UNKNOWN_ATTENDEE":
      return "참석자 중 퇴사·휴직한 사람이 있어요. 다시 골라 주세요.";
    case "ROOM_NOT_FOUND":
      return "지금은 쓸 수 없는 회의실이에요.";
    default:
      return "예약하지 못했어요. 잠시 후 다시 시도하세요.";
  }
}

/** 오늘을 볼 때만: 지금 각 회의실이 비었는지 */
function NowCards({ day, rooms }: { day: RoomsDay; rooms: RoomDay[] }) {
  const now = day.now_min!;
  return (
    <section aria-labelledby="now-title">
      <h2 id="now-title" className={styles.sectionTitle}>
        지금 ({minToHHMM(now)}) 회의실 상태
      </h2>
      <ul className={styles.nowGrid}>
        {rooms.map((room) => {
          const current = room.bookings.find((b) => b.start_min <= now && b.end_min > now);
          const next = room.bookings.find((b) => b.start_min > now);
          let state: "busy" | "free" | "closed";
          let text: string;
          if (current) {
            state = "busy";
            text = `사용 중 · ~${minToHHMM(current.end_min)}`;
          } else if (now >= day.policy.open_end || now < day.policy.open_start) {
            state = "closed";
            text = "운영 시간 아님";
          } else {
            state = "free";
            text = next ? `비어 있음 · ${minToHHMM(next.start_min)}까지` : "비어 있음 · 종일";
          }
          return (
            <li key={room.id} className={styles.nowCard} data-state={state} data-approval={room.requires_approval || undefined}>
              <span className={styles.nowName}>
                <span className={styles.nowDot} aria-hidden="true" />
                <strong>{room.name}</strong>
              </span>
              <span>
                {room.requires_approval ? "승인 필요 · " : ""}
                {text}
              </span>
              <span className={`mono ${styles.muted}`}>
                {room.floor.name} · {room.capacity}인{room.equipment.length ? ` · ${equipmentText(room.equipment)}` : ""}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** 좁은 화면의 예약 팝업. 브라우저 기본 dialog라 포커스 가두기·Esc·배경 막기가 된다 */
function Sheet({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={styles.sheet}
      aria-label="예약하기"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose(); // 바깥 어두운 곳을 누르면 닫는다
      }}
    >
      <button type="button" className={styles.sheetClose} aria-label="예약 창 닫기" onClick={onClose}>
        <CloseIcon size={20} />
      </button>
      <div className={styles.sheetBody}>{children}</div>
    </dialog>
  );
}
