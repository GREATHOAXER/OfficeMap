"use client";

import { type FormEvent, useId } from "react";
import DatePicker from "@/components/DatePicker";
import { SparkleIcon } from "@/components/icons";
import type { RoomsDay } from "@/lib/api";
import { addDays, formatShortDay, minToHHMM } from "@/lib/dates";
import AttendeePicker from "./AttendeePicker";
import { allAttendees, canStartAt, type Draft, isPast, latestEnd, type Repeat, slotStarts } from "./slots";
import styles from "./rooms.module.css";

const REPEATS: { value: Repeat; label: string }[] = [
  { value: "NONE", label: "반복 안 함" },
  { value: "WEEKLY", label: "매주 같은 요일" },
  { value: "WEEKDAYS", label: "매일 (평일)" },
];

const EQUIPMENT_LABEL: Record<string, string> = { VIDEO: "화상", TV: "TV", PROJECTOR: "빔" };
export const equipmentText = (equipment: string[]) => equipment.map((e) => EQUIPMENT_LABEL[e] ?? e).join("·");

type Props = {
  formId: string;
  day: RoomsDay;
  draft: Draft;
  onDraftChange: (update: (draft: Draft) => Draft) => void;
  onDateChange: (iso: string) => void;
  onSubmit: () => void;
  error: string | null;
};

/** 예약 폼이 다 채워졌나 (팝업 아래 "예약 확정" 버튼을 켜고 끈다) */
export const isReady = (draft: Draft) =>
  draft.roomId !== null && draft.start !== null && draft.end !== null && draft.title.trim() !== "";

/**
 * 예약하기 폼 (팝업 안). 팝업이 넓으면 왼쪽에 회의실·시간·제목, 오른쪽에 AI 추천·참석자 두 단으로,
 * 좁으면 한 단으로 쌓인다. 입력값(draft)은 회의실 화면이 들고 있어서 팝업을 닫았다 열어도 남는다.
 */
export default function ReservationForm({ formId, day, draft, onDraftChange, onDateChange, onSubmit, error }: Props) {
  const ids = useId();
  const room = day.rooms.find((r) => r.id === draft.roomId) ?? null;
  const set = (patch: Partial<Draft>) => onDraftChange((d) => ({ ...d, ...patch }));
  const slot = day.policy.slot;

  const starts = room ? slotStarts(day).filter((s) => canStartAt(day, room, s) || s === draft.start) : [];
  const maxEnd = room && draft.start !== null ? latestEnd(day, room, draft.start) : null;
  const ends: number[] = [];
  if (draft.start !== null && maxEnd !== null) for (let e = draft.start + slot; e <= maxEnd; e += slot) ends.push(e);

  const when =
    draft.start !== null && draft.end !== null ? { date: day.date, start_min: draft.start, end_min: draft.end } : null;
  const invited = allAttendees(draft).length;
  const overCapacity = room && invited + 1 > room.capacity;

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
    if (isReady(draft)) onSubmit();
  }

  return (
    <form id={formId} className={styles.form} onSubmit={submit}>
      <div className={styles.formCols}>
        <div className={styles.formCol}>
          <div className={styles.summary} aria-live="polite">
            {room && draft.start !== null && draft.end !== null ? (
              <>
                <strong>{room.name}</strong>
                <span className="mono">
                  {formatShortDay(day.date)} {minToHHMM(draft.start)} – {minToHHMM(draft.end)} ({draft.end - draft.start}분)
                </span>
                <span className={styles.muted}>
                  {room.floor.name} · 최대 {room.capacity}인
                  {room.equipment.length ? ` · ${equipmentText(room.equipment)}` : ""}
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
                  {r.floor.name} {r.name} · {r.capacity}인
                </option>
              ))}
            </select>
          </label>

          {/* 시작 일시 / 종료 일시 */}
          <fieldset className={styles.when}>
            <legend>시작</legend>
            <DatePicker label="시작 날짜" value={day.date} today={day.today} onChange={onDateChange} />
            <label className={styles.timeField}>
              <span className="visually-hidden">시작 시각</span>
              <select
                value={draft.start ?? ""}
                disabled={!room}
                onChange={(event) => changeStart(Number(event.target.value))}
                required
              >
                <option value="" disabled>
                  {room ? (starts.length ? "시각" : "빈 시간 없음") : "회의실 먼저"}
                </option>
                {starts.map((s) => (
                  <option key={s} value={s} disabled={!!room && isPast(day, s)}>
                    {minToHHMM(s)}
                  </option>
                ))}
              </select>
            </label>
          </fieldset>
          <fieldset className={styles.when}>
            <legend>종료</legend>
            <DatePicker
              label="종료 날짜"
              value={day.date}
              today={day.today}
              onChange={onDateChange}
              disabled
              describedBy={`${ids}-end-note`}
            />
            <label className={styles.timeField}>
              <span className="visually-hidden">종료 시각</span>
              <select
                value={draft.end ?? ""}
                disabled={draft.start === null}
                onChange={(event) => set({ end: Number(event.target.value) })}
                required
              >
                <option value="" disabled>
                  시각
                </option>
                {ends.map((e) => (
                  <option key={e} value={e}>
                    {minToHHMM(e)}
                  </option>
                ))}
              </select>
            </label>
          </fieldset>
          <p id={`${ids}-end-note`} className={styles.policy}>
            회의는 하루 안에서 잡아요(종료일 = 시작일) · {slot}분 단위 · 1회 최대 {day.policy.max / 60}시간 ·{" "}
            {minToHHMM(day.policy.open_start)}–{minToHHMM(day.policy.open_end)}
          </p>

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
        </div>

        <div className={styles.formCol}>
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

          <div className={styles.field}>
            <span>
              참석자 {invited > 0 && `${invited}명`}
              {overCapacity && <span className={styles.warn}> · 나를 포함해 {room.capacity}인실 정원을 넘어요</span>}
            </span>
            <AttendeePicker
              people={draft.attendees}
              teams={draft.teams}
              onPeopleChange={(attendees) => set({ attendees })}
              onTeamsChange={(teams) => set({ teams })}
              when={when}
            />
          </div>
        </div>
      </div>

      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
    </form>
  );
}
