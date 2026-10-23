"use client";

import { type FormEvent, useId } from "react";
import DatePicker from "@/components/DatePicker";
import { SparkleIcon } from "@/components/icons";
import type { RoomsDay } from "@/lib/api";
import { addDays, formatShortDay, minToHHMM } from "@/lib/dates";
import AttendeePicker from "./AttendeePicker";
import { canStartAt, type Draft, isPast, latestEnd, type Repeat, slotStarts } from "./slots";
import styles from "./rooms.module.css";

const REPEATS: { value: Repeat; label: string }[] = [
  { value: "NONE", label: "반복 안 함" },
  { value: "WEEKLY", label: "매주 같은 요일" },
  { value: "WEEKDAYS", label: "매일 (평일)" },
];

const EQUIPMENT_LABEL: Record<string, string> = { VIDEO: "화상", TV: "TV", PROJECTOR: "빔" };
export const equipmentText = (equipment: string[]) => equipment.map((e) => EQUIPMENT_LABEL[e] ?? e).join("·");

type Props = {
  day: RoomsDay;
  draft: Draft;
  onDraftChange: (update: (draft: Draft) => Draft) => void;
  onDateChange: (iso: string) => void;
  onSubmit: () => void;
  submitting: boolean;
  error: string | null;
};

/**
 * 예약하기 폼. 넓은 화면에서는 오른쪽 패널, 좁은 화면에서는 팝업 안에 같은 폼이 뜬다.
 * 입력값(draft)은 화면(RoomsView)이 들고 있어서 화면 폭이 바뀌어 자리를 옮겨도 그대로 남는다.
 */
export default function ReservationForm({ day, draft, onDraftChange, onDateChange, onSubmit, submitting, error }: Props) {
  const ids = useId();
  const room = day.rooms.find((r) => r.id === draft.roomId) ?? null;
  const set = (patch: Partial<Draft>) => onDraftChange((d) => ({ ...d, ...patch }));
  const slot = day.policy.slot;

  const starts = room ? slotStarts(day).filter((s) => canStartAt(day, room, s) || s === draft.start) : [];
  const maxEnd = room && draft.start !== null ? latestEnd(day, room, draft.start) : null;
  const ends: number[] = [];
  if (draft.start !== null && maxEnd !== null) for (let e = draft.start + slot; e <= maxEnd; e += slot) ends.push(e);

  const ready = !!room && draft.start !== null && draft.end !== null && draft.title.trim() !== "";
  const when =
    draft.start !== null && draft.end !== null ? { date: day.date, start_min: draft.start, end_min: draft.end } : null;
  const overCapacity = room && draft.attendees.length + 1 > room.capacity;

  function changeRoom(roomId: number) {
    const next = day.rooms.find((r) => r.id === roomId);
    onDraftChange((d) => {
      if (!next || d.start === null) return { ...d, roomId };
      // 새 회의실에서도 같은 시간이 비어 있으면 그대로 두고, 아니면 시간을 다시 고르게 한다
      const keep = canStartAt(day, next, d.start) && d.end !== null && d.end <= latestEnd(day, next, d.start);
      return keep ? { ...d, roomId } : { ...d, roomId, start: null, end: null };
    });
  }

  function changeStart(start: number) {
    onDraftChange((d) => {
      if (!room) return d;
      const length = d.start !== null && d.end !== null ? d.end - d.start : 60;
      return { ...d, start, end: Math.min(start + length, latestEnd(day, room, start)) };
    });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (ready && !submitting) onSubmit();
  }

  return (
    <form className={styles.form} onSubmit={submit} aria-labelledby={`${ids}-title`}>
      <h2 id={`${ids}-title`} className={styles.formTitle}>
        예약하기
      </h2>

      <section className={styles.ai} aria-labelledby={`${ids}-ai`}>
        <div id={`${ids}-ai`} className={styles.aiHead}>
          <SparkleIcon size={14} /> AI 추천 <span className={styles.soon}>준비 중</span>
        </div>
        <label className={styles.aiField}>
          <span className="visually-hidden">AI에게 회의 조건 말하기</span>
          <input placeholder="예: 김민준·이서연이랑 오늘 1시간 회의" disabled />
        </label>
        <p className={styles.aiNote}>참석자 일정과 빈 회의실을 보고 시간을 골라 주는 기능을 만들고 있어요.</p>
      </section>

      <div className={styles.summary} aria-live="polite">
        {room && draft.start !== null && draft.end !== null ? (
          <>
            <strong>{room.name}</strong>
            <span className="mono">
              {formatShortDay(day.date)} {minToHHMM(draft.start)} – {minToHHMM(draft.end)}
            </span>
            <span className={styles.muted}>
              {room.floor.name} · 최대 {room.capacity}인{room.equipment.length ? ` · ${equipmentText(room.equipment)}` : ""}
              {room.requires_approval && " · 승인 후 확정"}
            </span>
          </>
        ) : (
          <span className={styles.muted}>예약 현황표에서 빈 칸을 누르거나, 아래에서 회의실과 시간을 고르세요.</span>
        )}
      </div>

      <label className={styles.field}>
        회의실
        <select value={draft.roomId ?? ""} onChange={(event) => changeRoom(Number(event.target.value))} required>
          <option value="" disabled>
            회의실 고르기
          </option>
          {day.rooms.map((r) => (
            <option key={r.id} value={r.id}>
              {r.floor.name} {r.name} · {r.capacity}인{r.requires_approval ? " · 승인제" : ""}
            </option>
          ))}
        </select>
      </label>

      <div className={styles.field}>
        <span id={`${ids}-date`}>날짜</span>
        <DatePicker label="예약 날짜" value={day.date} today={day.today} onChange={onDateChange} />
      </div>

      <div className={styles.fieldRow}>
        <label className={styles.field}>
          시작
          <select
            value={draft.start ?? ""}
            disabled={!room}
            onChange={(event) => changeStart(Number(event.target.value))}
            required
          >
            <option value="" disabled>
              {room ? (starts.length ? "시작 시각" : "빈 시간 없음") : "회의실 먼저"}
            </option>
            {starts.map((s) => (
              <option key={s} value={s} disabled={!!room && isPast(day, s)}>
                {minToHHMM(s)}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          종료
          <select
            value={draft.end ?? ""}
            disabled={draft.start === null}
            onChange={(event) => set({ end: Number(event.target.value) })}
            required
          >
            <option value="" disabled>
              종료 시각
            </option>
            {ends.map((e) => (
              <option key={e} value={e}>
                {minToHHMM(e)} ({e - (draft.start ?? 0)}분)
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className={styles.field}>
        회의 제목
        <input
          value={draft.title}
          maxLength={200}
          placeholder="예: 주간 업무 점검"
          onChange={(event) => set({ title: event.target.value })}
          required
        />
      </label>

      <div className={styles.field}>
        <span>
          참석자 {draft.attendees.length > 0 && `${draft.attendees.length}명`}
          {overCapacity && <span className={styles.warn}> · 나를 포함해 {room.capacity}인실 정원을 넘어요</span>}
        </span>
        <AttendeePicker value={draft.attendees} onChange={(attendees) => set({ attendees })} when={when} />
      </div>

      <div className={styles.fieldRow}>
        <label className={styles.field}>
          반복
          <select
            value={draft.repeat}
            onChange={(event) => {
              const repeat = event.target.value as Repeat;
              set({ repeat, repeatUntil: repeat === "NONE" ? null : (draft.repeatUntil ?? addDays(day.date, 27)) });
            }}
          >
            {REPEATS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        {draft.repeat !== "NONE" && (
          <div className={styles.field}>
            <span>반복 종료일</span>
            <DatePicker
              label="반복 종료일"
              value={draft.repeatUntil ?? day.date}
              today={day.today}
              min={day.date}
              align="end"
              onChange={(repeatUntil) => set({ repeatUntil })}
            />
          </div>
        )}
      </div>

      <label className={styles.check}>
        <input type="checkbox" checked={draft.notify} onChange={(event) => set({ notify: event.target.checked })} />
        참석자에게 알림 보내기
      </label>

      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}

      <button type="submit" className={styles.submit} disabled={!ready || submitting}>
        {submitting ? "예약하는 중…" : room?.requires_approval ? "승인 요청하기" : "예약 확정"}
      </button>
      <p className={styles.policy}>
        {slot}분 단위 · 1회 최대 {day.policy.max / 60}시간 · {minToHHMM(day.policy.open_start)}–
        {minToHHMM(day.policy.open_end)} · 승인제 회의실(임원 회의실·대강당)은 승인 후 확정
      </p>
    </form>
  );
}
