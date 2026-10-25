"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import DatePicker from "@/components/DatePicker";
import Dialog from "@/components/Dialog";
import { ChevronLeftIcon, ChevronRightIcon, PlusIcon } from "@/components/icons";
import ReservationDetail from "@/components/ReservationDetail";
import type { ReservationDetail as Detail, RoomDay, RoomsDay } from "@/lib/api";
import { addDays, daysBetween, formatShortDay, kstDate, minToHHMM } from "@/lib/dates";
import { expiredLoginUrl } from "@/lib/loginRedirect";
import { hhmm } from "@/lib/rooms";
import { ROOMS_FLOOR_COOKIE } from "@/lib/roomsFloor";
import { useNow } from "@/lib/useNow";
import { saveDraft, takeDraft } from "./draftStore";
import ReservationForm, { equipmentText } from "./ReservationForm";
import {
  type Attendee,
  defaultRange,
  type Draft,
  EMPTY_DRAFT,
  headcount,
  liveDay,
  timeIsFree,
  withoutBooking,
} from "./slots";
import Timeline from "./Timeline";
import { useConflicts } from "./useConflicts";
import styles from "./rooms.module.css";

const CAPACITY_FILTERS = [
  { value: 0, label: "제한 없음" },
  { value: 4, label: "4명 이상" },
  { value: 8, label: "8명 이상" },
  { value: 12, label: "12명 이상" },
];

type Props = {
  day: RoomsDay;
  /** 마지막으로 고른 층 (쿠키). 처음이면 "all" */
  initialFloor: number | "all";
  /** ?edit=예약ID: 그 예약을 고치는 폼을 바로 연다 (예약 자세히 보기의 "수정") */
  editId: number | null;
};

/** 분 단위 시각 (서울 기준 그날 0시부터) */
const minutesOf = (iso: string) => {
  const [h, m] = hhmm.format(new Date(iso)).split(":").map(Number);
  return h * 60 + m;
};

export default function RoomsView({ day: fetchedDay, initialFloor, editId }: Props) {
  const router = useRouter();
  const formId = useId();
  const [floor, setFloor] = useState<number | "all">(initialFloor);
  const [minCapacity, setMinCapacity] = useState(0);
  const [needVideo, setNeedVideo] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [formOpen, setFormOpen] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // 고치는 예약. updatedAt: 폼을 채울 때 읽은 버전 (그사이 다른 탭·창에서 고쳤으면 서버가 저장을 막는다)
  const [editing, setEditing] = useState<{ id: number; title: string; updatedAt: string } | null>(null);
  const [staleEdit, setStaleEdit] = useState(false); // 다른 곳에서 먼저 고쳐서 저장하지 못했다 (다시 불러오기)
  const [skipDates, setSkipDates] = useState<string[] | null>(null);
  const [capacityOk, setCapacityOk] = useState(false); // 정원 초과를 알고도 예약하겠다고 한 번 더 눌렀다
  // 화면을 열어 둔 동안에도 지난 칸·"지금" 선·오늘이 시계를 따라간다 (서버가 읽어 온 때에 멈춰 있지 않게)
  const now = useNow();
  const live = useMemo(() => liveDay(fetchedDay, now), [fetchedDay, now]);
  // 고치는 예약은 빈 시간 계산에서 뺀다 (자기 자리와 겹친다고 막지 않게)
  const editingId = editing?.id ?? null;
  const day = useMemo(() => withoutBooking(live, editingId), [live, editingId]);
  const restoredEdit = useRef<number | null>(null); // 로그인이 끊겨 맡겨 둔 내용으로 채운 고치기 (서버 내용으로 덮지 않게)

  // 자정이 지나면 새 날의 예약 현황을 다시 읽는다 (주소에 날짜가 없으면 새 "오늘"을 보여 준다)
  const lastToday = useRef(fetchedDay.today);
  useEffect(() => {
    if (live.today === lastToday.current) return;
    lastToday.current = live.today;
    router.refresh();
  }, [live.today, router]);

  // 날짜를 바꾸거나 데이터를 다시 읽으면, 작성 중인 예약의 회의실이 그날에도 있는지 다시 본다.
  // 시간이 차 있으면 지우지 않고 폼이 알려 준다
  const [checkedDay, setCheckedDay] = useState(fetchedDay);
  if (checkedDay !== fetchedDay) {
    setCheckedDay(fetchedDay);
    setDraft((d) => keepRoomIfExists(d, fetchedDay));
  }

  // 예약을 확정하다가 로그인이 끊겼으면, 다시 로그인하고 돌아왔을 때 쓰던 내용을 그대로 채운다.
  // 화면이 붙은 뒤에 꺼낸다 (서버가 그린 빈 폼과 어긋나지 않게. 개발 모드에서 효과가 두 번 돌아도 한 번만 꺼내게)
  useEffect(() => {
    const timer = setTimeout(() => {
      const saved = takeDraft();
      if (!saved) return;
      if (saved.edit) {
        restoredEdit.current = saved.edit.id;
        setEditing(saved.edit);
      }
      setDraft(saved.draft);
      setFormOpen(true);
      setNotice("로그인이 끊겨 저장하지 못한 예약을 다시 채웠어요. 확인하고 다시 확정하세요.");
      if (saved.date !== fetchedDay.date || saved.siteId !== fetchedDay.site.id) {
        const edit = saved.edit ? `&edit=${saved.edit.id}` : "";
        router.replace(`/rooms?date=${saved.date}&site=${saved.siteId}${edit}`, { scroll: false });
      }
    }, 0);
    return () => clearTimeout(timer);
    // 처음 열 때 한 번만
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ?edit=예약ID 로 들어오면 그 예약을 불러와 폼을 채운다. 고칠 수 없는 예약(다른 사람 것, 끝난 것)이면
  // 그 예약을 자세히 보기로 열고 왜 못 고치는지 알려 준다
  useEffect(() => {
    if (!editId) return;
    const controller = new AbortController();
    fetch(`/api/reservations/${editId}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const detail = (await res.json()) as Detail;
        if (!detail.can_cancel) {
          setNotice(
            detail.is_organizer
              ? "이 예약은 이미 끝났거나 취소돼서 고칠 수 없어요."
              : "다른 사람이 만든 예약이라 고칠 수 없어요. 예약한 사람에게 부탁하세요.",
          );
          setDetailId(detail.id);
          router.replace(`/rooms?date=${kstDate(detail.starts_at)}&site=${detail.room.site_id}`, { scroll: false });
          return;
        }
        if (restoredEdit.current === detail.id) return; // 맡겨 둔 내용으로 이미 채웠다
        setEditing({ id: detail.id, title: detail.title, updatedAt: detail.updated_at });
        setDraft(draftOf(detail));
        setError(null);
        setFormOpen(true);
      })
      .catch(() => {
        if (!controller.signal.aborted) setNotice("고칠 예약을 찾지 못했어요. 이미 지워졌거나 잘못된 주소예요.");
      });
    return () => controller.abort();
  }, [editId, router]);

  /** 다른 곳에서 먼저 고친 예약: 최신 내용으로 폼을 다시 채운다 (지금 고친 것은 버린다) */
  async function reloadEdit() {
    if (!editing) return;
    try {
      const res = await fetch(`/api/reservations/${editing.id}`);
      if (!res.ok) throw new Error(String(res.status));
      const detail = (await res.json()) as Detail;
      if (!detail.can_cancel) {
        closeForm();
        setNotice("그사이 이 예약이 끝났거나 취소됐어요.");
        router.refresh();
        return;
      }
      setEditing({ id: detail.id, title: detail.title, updatedAt: detail.updated_at });
      setDraft(draftOf(detail));
      setError(null);
      setStaleEdit(false);
      // 다른 곳에서 날짜·사업장을 옮겼으면 그 날로, 아니면 현황표만 다시 읽는다
      const date = kstDate(detail.starts_at);
      if (date !== day.date || detail.room.site_id !== day.site.id) {
        router.replace(`/rooms?date=${date}&site=${detail.room.site_id}&edit=${detail.id}`, { scroll: false });
      } else router.refresh();
    } catch {
      setError("최신 내용을 불러오지 못했어요. 잠시 후 다시 시도하세요.");
    }
  }

  const { conflicts, checking } = useConflicts(day, draft, editing?.id ?? null);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  const floors = [...new Map(day.rooms.map((r) => [r.floor.id, r.floor])).values()];
  const floorFilter = floors.some((f) => f.id === floor) ? floor : "all";
  const filtered = floorFilter !== "all" || minCapacity > 0 || needVideo;
  const rooms = day.rooms.filter(
    (r) =>
      (floorFilter === "all" || r.floor.id === floorFilter) &&
      r.capacity >= minCapacity &&
      (!needVideo || r.equipment.includes("VIDEO")),
  );

  /** 층을 고르면 쿠키에 남겨서, 다음에 들어와도 그 층으로 연다 */
  function chooseFloor(next: number | "all") {
    setFloor(next);
    document.cookie = `${ROOMS_FLOOR_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
  }

  function resetFilters() {
    chooseFloor("all");
    setMinCapacity(0);
    setNeedVideo(false);
  }

  function goToDate(iso: string) {
    router.push(`/rooms?date=${iso}&site=${day.site.id}`, { scroll: false });
  }

  function openForm() {
    setError(null);
    setSkipDates(null);
    setStaleEdit(false);
    setFormOpen(true);
  }

  /** 새로 쓰기: 제목·참석자는 비우고, 방금 고른 회의실·시간은 남긴다. 고치던 중이면 그만둔다 */
  function startOver() {
    setDraft((d) =>
      editing ? EMPTY_DRAFT : { ...EMPTY_DRAFT, roomId: d.roomId, start: d.start, endDays: d.endDays, end: d.end },
    );
    setError(null);
    setSkipDates(null);
    setStaleEdit(false);
    setCapacityOk(false);
    if (editing) {
      setEditing(null);
      router.replace(`/rooms?date=${day.date}&site=${day.site.id}`, { scroll: false });
    }
  }

  /** 빈 칸을 누르면 그 칸부터 1시간으로 예약 팝업을 연다 */
  function pickSlot(room: RoomDay, start: number) {
    setDraft({ ...EMPTY_DRAFT, roomId: room.id, ...defaultRange(day, room, start) });
    openForm();
  }

  /** 빈 칸을 끌어서 고른 시간으로 예약 팝업을 연다 */
  function pickRange(room: RoomDay, start: number, end: number) {
    setDraft({ ...EMPTY_DRAFT, roomId: room.id, start, endDays: 0, end });
    openForm();
  }

  /** 예약하지 않고 팝업을 닫으면 고른 칸·쓰던 내용을 모두 비운다 (다음에 열면 빈 폼). 고치던 중이면 그만둔다 */
  function closeForm() {
    setFormOpen(false);
    setDraft(EMPTY_DRAFT);
    setError(null);
    setSkipDates(null);
    setStaleEdit(false);
    setCapacityOk(false);
    if (editing) {
      setEditing(null);
      router.replace(`/rooms?date=${day.date}&site=${day.site.id}`, { scroll: false });
    }
  }

  /** 예약 확정을 눌렀을 때 빠진 것: 버튼을 막아 두지 않고 무엇을 채워야 하는지 알려 준다 */
  function problemsOf(): string[] {
    const room = day.rooms.find((r) => r.id === draft.roomId);
    const problems: string[] = [];
    if (!room) problems.push("회의실을 고르세요.");
    if (draft.start === null || draft.end === null) problems.push("시작·종료 시각을 고르세요.");
    else if (room && !timeIsFree(day, room, draft)) problems.push(`이 시간에 ${room.name}에 이미 예약이 있어요.`);
    if (conflicts.length > 0) problems.push("이 기간에 이미 잡힌 예약이 있어요.");
    if (headcount(draft) === 0) problems.push("참석자가 없어요. 나도 들어가지 않으면 회의에 들어갈 사람을 넣으세요.");
    if (!draft.title.trim()) problems.push("회의 제목을 적어 주세요.");
    return problems;
  }

  async function submit(skipConflicts = false) {
    if (submitting || checking) return;
    const problems = problemsOf();
    if (problems.length > 0) {
      setError(problems.join(" "));
      return;
    }
    const room = day.rooms.find((r) => r.id === draft.roomId)!;
    const people = headcount(draft);
    if (people > room.capacity && !capacityOk) {
      setCapacityOk(true);
      setError(
        `정원 ${room.capacity}명인 ${room.name}에 ${people}명이 참석해요. 그래도 예약하려면 ‘예약 확정’을 한 번 더 누르세요.`,
      );
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(editing ? `/api/reservations/${editing.id}` : "/api/reservations", {
        method: editing ? "PUT" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          room_id: draft.roomId,
          date: day.date,
          start_min: draft.start,
          end_date: addDays(day.date, draft.endDays),
          end_min: draft.end,
          title: draft.title,
          attendees: draft.attendees.map((a) => a.emp_no),
          organizer_attends: draft.meAttends,
          repeat: editing ? "NONE" : draft.repeat,
          repeat_until: editing || draft.repeat === "NONE" ? null : draft.repeatUntil,
          skip_conflicts: skipConflicts,
          notify: draft.notify,
          expected_updated_at: editing?.updatedAt ?? null,
        }),
      });
      if (res.status === 401) {
        // 로그인이 끊겼다: 쓰던 내용을 맡겨 두고, 다시 로그인하고 돌아오면 그대로 채운다
        saveDraft({ date: day.date, siteId: day.site.id, draft, edit: editing });
        router.replace(expiredLoginUrl());
        return;
      }
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(errorText(data?.detail));
        setStaleEdit(data?.detail?.code === "CHANGED_ELSEWHERE");
        // 반복 예약 중 몇 날만 겹치면 그날만 빼고 예약할 수 있게 한다
        const dates: string[] = data?.detail?.dates ?? [];
        setSkipDates(
          data?.detail?.code === "TIME_TAKEN" && draft.repeat !== "NONE" && !editing && dates.length ? dates : null,
        );
        if (res.status === 409) router.refresh(); // 먼저 잡힌 예약을 현황표에 보여 준다
        return;
      }
      const start = `${formatShortDay(day.date)} ${minToHHMM(draft.start!)}`;
      const time =
        draft.endDays > 0
          ? `${start} – ${formatShortDay(addDays(day.date, draft.endDays))} ${minToHHMM(draft.end!)}`
          : `${start}–${minToHHMM(draft.end!)}`;
      const skipped: string[] = data.skipped ?? [];
      setNotice(
        editing
          ? `‘${draft.title.trim()}’ 예약을 고쳤어요: ${data.room} ${time}`
          : `${data.room} ${time}${data.count > 1 ? ` (${data.count}회)` : ""} 예약했어요.${
              skipped.length ? ` 겹치는 날(${skipped.map(formatShortDay).join(", ")})은 뺐어요.` : ""
            }`,
      );
      setDraft(EMPTY_DRAFT);
      setSkipDates(null);
      setCapacityOk(false);
      setFormOpen(false);
      if (editing) {
        setEditing(null);
        router.replace(`/rooms?date=${day.date}&site=${day.site.id}`, { scroll: false });
      }
      router.refresh();
    } catch {
      setError("예약하지 못했어요. 네트워크를 확인하고 다시 시도하세요.");
    } finally {
      setSubmitting(false);
    }
  }

  const hasDraft = draft.roomId !== null || draft.title !== "" || draft.attendees.length > 0 || !draft.meAttends;

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>회의실 확인·예약</h1>
        <div className={styles.dateNav} role="group" aria-label="날짜">
          <button
            type="button"
            className={styles.iconButton}
            aria-label="이전 날"
            onClick={() => goToDate(addDays(day.date, -1))}
          >
            <ChevronLeftIcon size={18} />
          </button>
          <DatePicker label="보는 날짜" value={day.date} today={day.today} onChange={goToDate} />
          <button
            type="button"
            className={styles.iconButton}
            aria-label="다음 날"
            onClick={() => goToDate(addDays(day.date, 1))}
          >
            <ChevronRightIcon size={18} />
          </button>
          <button
            type="button"
            className={styles.textButton}
            disabled={day.date === day.today}
            onClick={() => goToDate(day.today)}
          >
            오늘
          </button>
        </div>
        <button type="button" className={styles.openForm} aria-haspopup="dialog" onClick={openForm}>
          <PlusIcon size={18} />
          예약하기
        </button>
      </header>

      <div className={styles.filters}>
        <div className={styles.seg} role="group" aria-label="층">
          <button type="button" aria-pressed={floorFilter === "all"} onClick={() => chooseFloor("all")}>
            전체 층
          </button>
          {floors.map((f) => (
            <button key={f.id} type="button" aria-pressed={floorFilter === f.id} onClick={() => chooseFloor(f.id)}>
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

      <main className={styles.main}>
        {day.now_min !== null && rooms.length > 0 && (
          <NowCards day={day} rooms={rooms} onNextDay={() => goToDate(addDays(day.date, 1))} />
        )}

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
              <span className={styles.lgMine} aria-hidden="true" />내 회의 (예약·참석)
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
            <span className={styles.legend}>
              <span className={styles.lgPast} aria-hidden="true" />
              지난 시간·운영 시간 밖
            </span>
            <span className={styles.ttHint}>빈 칸을 누르거나 끌어서 예약 · 예약을 누르면 자세히</span>
          </div>
          {day.past && <p className={styles.pastNote}>지난 날짜예요. 예약 현황만 볼 수 있어요.</p>}
          {day.rooms.length === 0 ? (
            <p className={styles.empty}>{day.site.name}에는 예약할 수 있는 회의실이 아직 없어요.</p>
          ) : rooms.length === 0 ? (
            <p className={styles.empty}>
              조건에 맞는 회의실이 없어요.
              {filtered && (
                <button type="button" className={styles.textButton} onClick={resetFilters}>
                  조건 초기화
                </button>
              )}
            </p>
          ) : (
            <Timeline
              day={day}
              rooms={rooms}
              draft={draft}
              onPick={pickSlot}
              onPickRange={pickRange}
              onOpenBooking={setDetailId}
            />
          )}
        </section>
      </main>

      <Dialog
        open={formOpen}
        onClose={closeForm}
        title={editing ? `예약 고치기 · ${editing.title}` : "예약하기"}
        size="wide"
        footer={
          <>
            {(hasDraft || editing) && (
              <button type="button" className={styles.textButton} onClick={startOver}>
                {editing ? "고치기 그만두기" : "새로 쓰기"}
              </button>
            )}
            <span className={styles.spacer} />
            <button type="button" className={styles.textButton} onClick={closeForm}>
              닫기
            </button>
            <button type="submit" form={formId} className={styles.submit} disabled={submitting || checking}>
              {submitting ? "저장하는 중…" : checking ? "겹치는지 확인 중…" : editing ? "고친 내용 저장" : "예약 확정"}
            </button>
          </>
        }
      >
        <ReservationForm
          formId={formId}
          day={day}
          draft={draft}
          onDraftChange={(update) => {
            // 고치기 시작하면 지난번 확정 때 보여 준 오류는 내린다 (다시 누르면 다시 확인)
            setDraft(update);
            setError(null);
            setSkipDates(null);
            setStaleEdit(false);
            setCapacityOk(false);
          }}
          onDateChange={goToDate}
          onSubmit={() => void submit()}
          error={error}
          conflicts={conflicts}
          checking={checking}
          editing={editing !== null}
          editingId={editing?.id ?? null}
          skipDates={skipDates}
          onSkipConflicts={() => void submit(true)}
          onReloadEdit={staleEdit ? () => void reloadEdit() : null}
        />
      </Dialog>

      <ReservationDetail
        reservationId={detailId}
        onClose={() => setDetailId(null)}
        onCancelled={(title, count) => {
          setDetailId(null);
          setNotice(count > 1 ? `‘${title}’ 예약 ${count}회를 취소했어요.` : `‘${title}’ 예약을 취소했어요.`);
          router.refresh();
        }}
      />
    </div>
  );
}

/** 다른 날(사업장)로 가서 그 회의실이 없으면 회의실·시간만 비운다 (제목·참석자는 남긴다) */
function keepRoomIfExists(d: Draft, day: RoomsDay): Draft {
  if (d.roomId === null || day.rooms.some((r) => r.id === d.roomId)) return d;
  return { ...d, roomId: null, start: null, end: null };
}

/** 고칠 예약으로 폼을 채운다 */
function draftOf(detail: Detail): Draft {
  const startDay = kstDate(detail.starts_at);
  const endMin = minutesOf(detail.ends_at);
  const endDay = kstDate(detail.ends_at);
  // 자정에 끝나면 그 전날 24:00
  const endDays = endMin === 0 && endDay > startDay ? daysBetween(startDay, endDay) - 1 : daysBetween(startDay, endDay);
  return {
    ...EMPTY_DRAFT,
    roomId: detail.room.id,
    start: minutesOf(detail.starts_at),
    endDays,
    end: endMin === 0 && endDay > startDay ? 1440 : endMin,
    title: detail.title,
    // 고치는 사람은 예약한 사람이다. 나는 "나" 칩으로, 나머지는 한 사람씩
    meAttends: detail.organizer.attends,
    attendees: detail.attendees
      .filter((a) => !a.is_organizer)
      .map(
        (a) =>
          ({
            emp_no: a.emp_no,
            name: a.name,
            rank: a.rank,
            department: a.department,
            is_me: a.is_me,
            seat: a.color_key ? { color_key: a.color_key } : null,
            presence: a.presence ? { status: a.presence, message: null } : null,
          }) as unknown as Attendee,
      ),
  };
}

type ErrorDetail = { code?: string; dates?: string[]; max?: number; max_days?: number } | undefined;

const maxText = (minutes: number) => (minutes >= 1440 ? `${Math.floor(minutes / 1440)}일` : `${minutes / 60}시간`);

function errorText(detail: ErrorDetail): string {
  switch (detail?.code) {
    case "CHANGED_ELSEWHERE":
      return "다른 탭이나 창에서 이 예약을 먼저 고쳤어요. 덮어쓰지 않으려고 저장하지 않았어요. 최신 내용을 불러와 다시 고쳐 주세요.";
    case "NOT_EDITABLE":
      return "이 예약은 이미 끝났거나 취소돼서 고칠 수 없어요.";
    case "TIME_TAKEN":
      return detail.dates?.length
        ? `그 시간에 이미 예약이 있어요: ${detail.dates.map(formatShortDay).join(", ")}`
        : "방금 다른 사람이 먼저 예약했어요. 현황표를 다시 확인하세요.";
    case "TOO_LONG":
      return `한 번에 최대 ${maxText(detail.max ?? 10080)}까지 예약할 수 있어요.`;
    case "INVALID_TIME":
      return "예약할 수 없는 시간이에요. 시작·끝 시각은 운영 시간 안에서 30분 단위로, 끝은 시작보다 뒤로 골라 주세요.";
    case "REPEAT_SINGLE_DAY":
      return "여러 날에 걸친 예약은 반복할 수 없어요.";
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
    case "NO_ATTENDEES":
      return "참석자가 없어요. 나도 들어가지 않으면 회의에 들어갈 사람을 넣으세요.";
    case "ROOM_NOT_FOUND":
      return "지금은 쓸 수 없는 회의실이에요.";
    default:
      return "예약하지 못했어요. 잠시 후 다시 시도하세요.";
  }
}

/** 오늘을 볼 때만: 지금 각 회의실이 비었는지. 운영 시간 밖이면 카드 대신 한 줄로 */
function NowCards({ day, rooms, onNextDay }: { day: RoomsDay; rooms: RoomDay[]; onNextDay: () => void }) {
  const now = day.now_min!;
  const closed = now >= day.policy.open_end || now < day.policy.open_start;
  const busyNow = rooms.some((r) => r.bookings.some((b) => b.start_min <= now && b.end_min > now));
  if (closed && !busyNow) {
    return (
      <p className={styles.closedLine}>
        지금({minToHHMM(now)})은 회의실 운영 시간({minToHHMM(day.policy.open_start)}–{minToHHMM(day.policy.open_end)})이
        아니에요.
        {now >= day.policy.open_end && (
          <button type="button" className={styles.textButton} onClick={onNextDay}>
            다음 날 예약 현황 보기
          </button>
        )}
      </p>
    );
  }
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
            // 여러 날 예약이면 끝나는 날짜까지
            const until =
              current.end_min >= 1440
                ? `${formatShortDay(kstDate(current.ends_at))} ${hhmm.format(new Date(current.ends_at))}`
                : minToHHMM(current.end_min);
            text = `사용 중 · ~${until}`;
          } else if (now >= day.policy.open_end || now < day.policy.open_start) {
            state = "closed";
            text = "운영 시간 아님";
          } else {
            state = "free";
            text = next ? `비어 있음 · ${minToHHMM(next.start_min)}까지` : "비어 있음 · 종일";
          }
          return (
            <li key={room.id} className={styles.nowCard} data-state={state}>
              <span className={styles.nowName}>
                <span className={styles.nowDot} aria-hidden="true" />
                <strong>{room.name}</strong>
              </span>
              <span>{text}</span>
              <span className={`mono ${styles.muted}`}>
                {room.floor.name} · {room.capacity}인
                {room.equipment.length ? ` · ${equipmentText(room.equipment)}` : ""}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
