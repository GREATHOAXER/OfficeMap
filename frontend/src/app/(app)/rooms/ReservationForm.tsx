"use client";

import { type FormEvent, useEffect, useId, useRef } from "react";
import DatePicker from "@/components/DatePicker";
import type { AiProposal } from "@/lib/ai";
import type { RoomsDay } from "@/lib/api";
import { addDays, daysBetween, formatDuration, formatShortDay, minToHHMM } from "@/lib/dates";
import { rangeText } from "@/lib/rooms";
import AiSuggest from "./AiSuggest";
import AttendeePicker from "./AttendeePicker";
import {
  defaultRepeatUntil,
  type Draft,
  headcount,
  isFree,
  isPast,
  latestEnd,
  lengthOf,
  maxEndDays,
  occurrenceCount,
  type Repeat,
  slotStarts,
  suggestRooms,
  timeIsFree,
  whenOf,
} from "./slots";
import type { Conflict } from "./useConflicts";
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
  /** 여러 날 예약일 때 그 기간에 이미 잡힌 예약 (서버에 물어본 결과) */
  conflicts: Conflict[];
  checking: boolean;
  /** 이미 있는 예약을 고치는 중 (반복은 못 바꾼다) */
  editing: boolean;
  /** 고치는 예약이 반복 예약의 한 회차인가 */
  editingSeries: boolean;
  /** 고치는 예약의 ID (참석자 일정 확인에서 자기 자신과는 겹치지 않게) */
  editingId: number | null;
  /** 반복 예약 중 겹치는 날이 있을 때: 그날만 빼고 예약하기 */
  skipDates: string[] | null;
  onSkipConflicts: () => void;
  /** 다른 탭·창에서 먼저 고쳐서 저장하지 못했을 때: 최신 내용 다시 불러오기 */
  onReloadEdit: (() => void) | null;
  /** AI 추천 후보를 골랐을 때: 폼을 그 내용으로 채운다 (날짜·사업장이 다르면 그리로 옮긴다) */
  onAiPick: (proposal: AiProposal) => void;
};

/** 예약 폼이 다 채워졌나 (팝업 아래 "예약 확정" 버튼을 켜고 끈다) */
export const isReady = (draft: Draft) =>
  draft.roomId !== null && draft.start !== null && draft.end !== null && draft.title.trim() !== "";

/**
 * 예약하기 폼 (팝업 안). 팝업이 넓으면 왼쪽에 회의실·시간·제목, 오른쪽에 AI 추천·참석자 두 단으로,
 * 좁으면 한 단으로 쌓인다. 입력값(draft)은 회의실 화면이 들고 있어서 팝업을 닫았다 열어도 남는다.
 */
export default function ReservationForm(props: Props) {
  const { formId, day, draft, onDraftChange, onDateChange, onSubmit, error, conflicts, checking } = props;
  const { editing, editingSeries, editingId, skipDates, onSkipConflicts, onReloadEdit, onAiPick } = props;
  const ids = useId();
  const roomRef = useRef<HTMLSelectElement>(null);
  const startRef = useRef<HTMLSelectElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  // 오류는 폼 맨 아래에 나온다: 휴대폰처럼 화면이 작으면 보이는 곳까지 내려 준다 ("예약 확정"을 눌러도 아무 일 없는 것처럼 보이지 않게)
  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [error]);
  const room = day.rooms.find((r) => r.id === draft.roomId) ?? null;
  const set = (patch: Partial<Draft>) => onDraftChange((d) => ({ ...d, ...patch }));
  const { slot, open_start: open, open_end: close } = day.policy;
  const endDate = addDays(day.date, draft.endDays);
  const multiDay = draft.endDays > 0;

  // 시작·끝 시각 목록: 차 있거나 지난 시각도 보여 주되 고를 수 없게 (왜 빠졌는지 알 수 있게)
  const starts = room
    ? slotStarts(day).map((s) => ({
        value: s,
        note: isPast(day, s) ? "지남" : isFree(room, s, s + slot) ? null : "예약 있음",
      }))
    : [];
  const ends = room ? endChoices() : [];
  const freeStarts = starts.filter((s) => !s.note).length;
  // 오늘이 마감인지: 고를 수 있는 시작 칸(지나지 않은 칸, 진행 중인 칸 포함)이 하나도 없으면
  const dayClosed = day.past || slotStarts(day).every((s) => isPast(day, s));
  const when = whenOf(day, draft);
  const people = headcount(draft); // 실제로 회의에 들어가는 사람 (나도 참석하면 나까지)
  const overCapacity = room && people > room.capacity;
  const taken = room !== null && !timeIsFree(day, room, draft);
  const alternatives = taken ? suggestRooms(day, draft, people).slice(0, 4) : [];
  const occurrences = occurrenceCount(day.date, draft.repeat, draft.repeatUntil);
  const timeChosen = room !== null && draft.start !== null && draft.end !== null;

  /** 끝 시각 목록. 같은 날이면 다음 예약 뒤 시각은 "예약 있음"으로 막는다 */
  function endChoices(): { value: number; note: string | null }[] {
    if (!room || draft.start === null) return [];
    const list: { value: number; note: string | null }[] = [];
    if (draft.endDays === 0) {
      const limit = latestEnd(day, room, draft.start);
      for (let e = draft.start + slot; e <= close; e += slot)
        list.push({ value: e, note: e > limit ? "예약 있음" : null });
    } else {
      for (let e = open; e <= close; e += slot) {
        if (draft.endDays * 1440 + e - draft.start <= day.policy.max) list.push({ value: e, note: null });
      }
    }
    return list;
  }

  /** 회의실을 바꿔도 고른 시간은 그대로 둔다. 새 회의실에서 그 시간이 차 있으면 아래에 알려 주고 빈 회의실을 권한다 */
  function changeRoom(roomId: number) {
    onDraftChange((d) => ({ ...d, roomId }));
  }

  function changeStart(start: number) {
    onDraftChange((d) => {
      if (!room) return d;
      if (d.endDays > 0) return { ...d, start }; // 여러 날 예약은 끝 시각을 그대로 둔다
      const length = d.start !== null && d.end !== null ? d.end - d.start : 60;
      return { ...d, start, end: Math.max(start + slot, Math.min(start + length, latestEnd(day, room, start))) };
    });
  }

  /** 끝나는 날을 바꾼다. 여러 날 예약은 반복할 수 없어서 반복을 끈다 */
  function changeEndDate(iso: string) {
    const endDays = Math.max(0, daysBetween(day.date, iso));
    onDraftChange((d) => {
      const next: Draft = { ...d, endDays, ...(endDays > 0 ? { repeat: "NONE", repeatUntil: null } : {}) };
      if (!room || d.start === null) return next;
      const options = endChoicesFor(next);
      if (d.end !== null && options.includes(d.end)) return next;
      // 지금 끝 시각을 그날 쓸 수 없으면: 같은 날이면 시작 1시간 뒤(또는 가장 늦은 칸), 다른 날이면 시작과 같은 시각
      const fallback = endDays === 0 ? Math.min(d.start + 60, options.at(-1) ?? d.start + slot) : d.start;
      return { ...next, end: options.includes(fallback) ? fallback : (options[0] ?? null) };
    });
  }

  /** 끝나는 날을 바꿀 때 쓸 수 있는 끝 시각 (endChoices와 같은 규칙, 바뀔 draft 기준) */
  function endChoicesFor(next: Draft): number[] {
    if (!room || next.start === null) return [];
    const result: number[] = [];
    if (next.endDays === 0) {
      for (let e = next.start + slot; e <= latestEnd(day, room, next.start); e += slot) result.push(e);
    } else {
      for (let e = open; e <= close; e += slot)
        if (next.endDays * 1440 + e - next.start <= day.policy.max) result.push(e);
    }
    return result;
  }

  // 빠진 칸이 있어도 버튼을 막지 않고, 누르면 무엇이 빠졌는지 알려 준다 (화면이 판단).
  // 빠진 칸이 있으면 오류 문구와 같은 순서로 첫 칸에 포커스를 옮긴다
  function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit();
    const missing = !room
      ? roomRef
      : draft.start === null || draft.end === null
        ? startRef
        : !draft.title.trim()
          ? titleRef
          : null;
    missing?.current?.focus();
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
                  {formatShortDay(day.date)} {minToHHMM(draft.start)} – {multiDay && `${formatShortDay(endDate)} `}
                  {minToHHMM(draft.end)}
                </span>
                {/* 여러 날 예약은 현황표·내 예약과 같이 "n일간" */}
                <span className={styles.muted}>
                  {multiDay ? `${draft.endDays + 1}일간` : formatDuration(lengthOf(draft))}
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
            <select
              ref={roomRef}
              value={draft.roomId ?? ""}
              onChange={(event) => changeRoom(Number(event.target.value))}
              data-autofocus={!timeChosen || undefined}
            >
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
            <legend className="visually-hidden">시작</legend>
            <div className={styles.whenRow}>
              <span className={styles.whenLabel} aria-hidden="true">
                시작
              </span>
              <DatePicker label="시작 날짜" value={day.date} today={day.today} onChange={onDateChange} />
              <label className={styles.timeField}>
                <span className="visually-hidden">시작 시각</span>
                <select
                  ref={startRef}
                  value={draft.start ?? ""}
                  disabled={!room}
                  onChange={(event) => changeStart(Number(event.target.value))}
                  required
                >
                  {/* 좁은 휴대폰(이 칸 약 100px, 글자 16px)에서도 잘리지 않게 두 글자로. 회의실을 안 골랐으면 칸이 꺼져 있고,
                      마감이면 아래 안내가 따로 뜬다 */}
                  <option value="" disabled>
                    {room && dayClosed ? "마감" : room && !freeStarts ? "꽉 참" : "시각"}
                  </option>
                  {starts.map((s) => (
                    <option key={s.value} value={s.value} disabled={!!s.note}>
                      {minToHHMM(s.value)}
                      {s.note ? ` (${s.note})` : ""}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </fieldset>
          <fieldset className={styles.when}>
            <legend className="visually-hidden">종료</legend>
            <div className={styles.whenRow}>
              <span className={styles.whenLabel} aria-hidden="true">
                종료
              </span>
              <DatePicker
                label="종료 날짜"
                value={endDate}
                today={day.today}
                min={day.date}
                max={addDays(day.date, maxEndDays(day))}
                onChange={changeEndDate}
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
                    <option key={e.value} value={e.value} disabled={!!e.note}>
                      {minToHHMM(e.value)}
                      {e.note ? ` (${e.note})` : ""}
                    </option>
                  ))}
                  {draft.end !== null && !ends.some((e) => e.value === draft.end) && (
                    <option value={draft.end} disabled>
                      {minToHHMM(draft.end)}
                    </option>
                  )}
                </select>
              </label>
            </div>
          </fieldset>
          {dayClosed && (
            <p className={styles.closedNote}>
              이날({formatShortDay(day.date)})은 더 예약할 수 있는 시간이 없어요 (운영 {minToHHMM(open)}–
              {minToHHMM(close)}).
              <button
                type="button"
                // 지난 날짜면 오늘로 (오늘도 마감이면 거기서 한 번 더 누르면 다음 날)
                onClick={() => onDateChange(day.date < day.today ? day.today : addDays(day.date, 1))}
              >
                다음 날로
              </button>
            </p>
          )}
          {taken && (
            <div className={styles.conflictBox} data-ok={false} role="status">
              <strong>이 시간에 {room.name}에 이미 예약이 있어요. 시간을 바꾸거나 다른 회의실을 고르세요.</strong>
              {alternatives.length > 0 && (
                <span className={styles.alternatives}>
                  이 시간에 비어 있는 곳:
                  {alternatives.map((r) => (
                    <button key={r.id} type="button" onClick={() => changeRoom(r.id)}>
                      {r.floor.name} {r.name} · {r.capacity}인
                    </button>
                  ))}
                </span>
              )}
            </div>
          )}
          <p id={`${ids}-end-note`} className={styles.policy}>
            여러 날에 걸쳐 잡을 수 있어요 (최대 {maxEndDays(day)}일) · 시작·끝 시각은 {minToHHMM(open)}–
            {minToHHMM(close)} 사이 · {slot}분 단위
          </p>
          {multiDay && room && draft.start !== null && draft.end !== null && (
            <div className={styles.conflictBox} data-ok={!checking && conflicts.length === 0} role="status">
              {checking ? (
                "이 기간에 겹치는 예약을 확인하는 중…"
              ) : conflicts.length === 0 ? (
                `${formatShortDay(day.date)} ~ ${formatShortDay(endDate)} 동안 ${room.name}에 다른 예약이 없어요.`
              ) : (
                <>
                  <strong>이 기간에 이미 잡힌 예약이 있어요 ({conflicts.length}건)</strong>
                  <ul>
                    {conflicts.map((c) => (
                      <li key={c.id}>
                        {c.title} · <span className="mono">{rangeText(c.starts_at, c.ends_at)}</span> · {c.department}{" "}
                        {c.organizer}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}

          <label className={styles.field}>
            <span>
              회의 제목 <span className={styles.required}>(필수)</span>
            </span>
            <input
              ref={titleRef}
              value={draft.title}
              maxLength={200}
              placeholder="예: 주간 업무 점검"
              onChange={(event) => set({ title: event.target.value })}
              data-autofocus={timeChosen || undefined}
            />
          </label>

          {editing ? (
            editingSeries && (
              <p className={styles.policy}>반복 예약은 고치면 이 회차만 바뀌어요. 반복 설정은 바꿀 수 없어요.</p>
            )
          ) : (
            <div className={styles.fieldRow}>
              <label className={styles.field}>
                반복
                <select
                  value={draft.repeat}
                  disabled={multiDay}
                  aria-describedby={multiDay ? `${ids}-repeat-note` : undefined}
                  onChange={(event) => {
                    const repeat = event.target.value as Repeat;
                    set({ repeat, repeatUntil: repeat === "NONE" ? null : defaultRepeatUntil(day.date, repeat) });
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
              {draft.repeat !== "NONE" && (
                <p className={styles.occurrences} aria-live="polite">
                  총 <strong className="mono">{occurrences}</strong>회
                </p>
              )}
            </div>
          )}

          {multiDay && !editing && (
            <p id={`${ids}-repeat-note`} className={styles.policy}>
              여러 날에 걸친 예약은 반복할 수 없어요.
            </p>
          )}

          <label className={styles.check}>
            <input
              type="checkbox"
              checked={draft.notify}
              onChange={(event) => set({ notify: event.target.checked })}
              aria-describedby={`${ids}-notify-note`}
            />
            참석자에게 메신저 알림 보내기
          </label>
          <p id={`${ids}-notify-note`} className={styles.policy}>
            사내 메신저 연동 전이라 지금은 참석자의 ‘내 예약’에 바로 보이는 것으로 알려요.
          </p>
        </div>

        <div className={styles.formCol}>
          <AiSuggest day={day} onPick={onAiPick} />

          <div className={styles.field}>
            <span>
              참석자 {people}명{!draft.meAttends && <span className={styles.muted}> · 나는 예약만</span>}
              {overCapacity && <span className={styles.warn}> · {room.capacity}인실 정원을 넘어요</span>}
            </span>
            <AttendeePicker
              people={draft.attendees}
              onPeopleChange={(attendees) => set({ attendees })}
              meAttends={draft.meAttends}
              onMeAttendsChange={(meAttends) => set({ meAttends })}
              when={when}
              exclude={editingId}
            />
          </div>
        </div>
      </div>

      {error && (
        <div ref={errorRef} role="alert" className={styles.error}>
          {error}
          {skipDates && skipDates.length > 0 && (
            <button type="button" className={styles.skipButton} onClick={onSkipConflicts}>
              겹치는 날 {skipDates.length}일 빼고 예약
            </button>
          )}
          {onReloadEdit && (
            <button type="button" className={styles.skipButton} onClick={onReloadEdit}>
              최신 내용 불러오기
            </button>
          )}
        </div>
      )}
    </form>
  );
}
