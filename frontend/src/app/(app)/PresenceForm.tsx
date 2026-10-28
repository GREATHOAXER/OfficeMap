"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useId, useState } from "react";
import DatePicker from "@/components/DatePicker";
import type { MyPresenceInfo, PresenceDuration, PresenceStatus } from "@/lib/api";
import { addDays, kstDate } from "@/lib/dates";
import { sessionEndUrl } from "@/lib/loginRedirect";
import {
  MULTI_DAY,
  PRESENCE_HINT,
  PRESENCE_IN,
  PRESENCE_LABEL,
  PRESENCE_OUT,
  PRESENCE_PLACEHOLDER,
  presenceUntil,
} from "@/lib/presence";
import { hhmm } from "@/lib/rooms";
import styles from "./office.module.css";

/** until: "그날까지"의 마지막 날 (YYYY-MM-DD, 그날 포함) */
type Draft = { status: PresenceStatus | null; message: string; duration: PresenceDuration; until: string };

const GROUPS = [
  { label: "자리에 있어요", statuses: PRESENCE_IN },
  { label: "자리에 없어요", statuses: PRESENCE_OUT },
];
const MAX_UNTIL_DAYS = 366; // 서버와 같다 (presence.py MAX_UNTIL_DAYS)
const isOut = (status: PresenceStatus | null) => status !== null && PRESENCE_OUT.includes(status);

type Props = {
  info: MyPresenceInfo;
  heading: string;
  headingId: string;
  /** 저장하거나 지운 뒤 (머리글 패널은 닫는다) */
  onSaved?: () => void;
};

/** 걸려 있는 해제 시각의 마지막 날 (다른 날 0시에 풀리면 그 전날, 지난 날이면 오늘) */
function lastDayOf(expiresAt: string, today: string) {
  const last = kstDate(new Date(Date.parse(expiresAt) - 60_000).toISOString());
  return last < today ? today : last;
}

/** 해제 시각 문구: 오늘이면 "18:00", 다른 날이면 "내일 00:00" */
function releaseText(iso: string) {
  const time = hhmm.format(new Date(iso));
  if (time === "00:00") return "오늘 자정";
  return kstDate(iso) === kstDate(new Date().toISOString()) ? time : `내일 ${time}`;
}

/**
 * 내 재실 상태 바꾸기 폼: 상태(자리에 있음 4가지 · 자리에 없음 6가지), 메시지, 자동 해제.
 * 휴가·출장·교육은 "그날까지"(마지막 날)를 먼저 권한다: 자리를 누른 동료에게 "10/31(금)까지"로 보인다.
 * 머리글의 "내 상태" 패널과 내 재실 상태 화면이 같이 쓴다. 저장하면 화면 데이터를 다시 읽는다.
 * 지금 저장된 상태로 채운다: 해제 시각이 걸려 있으면 "그대로"가 골라져 있어서, 메시지만 고쳐도 해제 시각이 바뀌지 않는다
 */
export default function PresenceForm({ info, heading, headingId, onSaved }: Props) {
  const { presence } = info;
  const router = useRouter();
  const name = useId(); // 한 화면에 폼이 둘 있어도 라디오 묶음이 섞이지 않게
  const savedMessage = presence?.message ?? "";
  // 폼을 연 때의 오늘과 밤늦은지 (그리는 동안 바뀌지 않게 처음 한 번만 잰다)
  const [{ today, lateNight }] = useState(() => ({
    today: kstDate(new Date().toISOString()),
    // 새로 정할 때는 퇴근 시(밤이면 자정)에 풀리게. 그때까지 1시간도 안 남았으면(밤늦게) 1시간 뒤로
    lateNight: Date.parse(info.end_of_day_at) - Date.now() < 60 * 60_000,
  }));
  // 휴가·출장·교육은 마지막 날을 고르게
  const fresh = (status: PresenceStatus | null): PresenceDuration =>
    status && MULTI_DAY.has(status) ? "UNTIL_DATE" : lateNight && !isOut(status) ? "1H" : "END_OF_DAY";
  const [draft, setDraft] = useState<Draft>(() => ({
    status: presence?.status ?? null, // 정하지 않았으면 아무것도 고르지 않은 채로
    message: savedMessage,
    duration: !presence ? fresh(null) : presence.expires_at ? "KEEP" : "NONE",
    // 지금 걸린 해제 시각이 다른 날 0시면 그 전날을 마지막 날로 (휴가를 하루 늘릴 때 그대로 시작)
    until: presence?.expires_at ? lastDayOf(presence.expires_at, today) : today,
  }));
  const [pending, setPending] = useState<"save" | "clear" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const endOfDay = releaseText(info.end_of_day_at);
  const keep = presence?.expires_at
    ? [
        {
          value: "KEEP" as const,
          label: `그대로 (${presenceUntil(presence.expires_at)})`,
          preview: `${presenceUntil(presence.expires_at)} 유지되고 그 뒤 자동으로 풀려요`,
        },
      ]
    : [];
  const untilDay = presenceUntil(`${addDays(draft.until, 1)}T00:00:00+09:00`) ?? "";
  // 자리에 있는 상태는 몇 시간 단위, 자리에 없는 상태(외근·휴가 등)는 날짜 단위로 고른다
  const durations: { value: PresenceDuration; label: string; preview: string }[] = isOut(draft.status)
    ? [
        ...keep,
        {
          value: "END_OF_DAY",
          label: endOfDay === "오늘 자정" ? "오늘까지" : `오늘 퇴근 시 (${endOfDay})`,
          preview: `${endOfDay}에 자동으로 풀려요`,
        },
        { value: "UNTIL_DATE", label: "마지막 날 고르기", preview: `${untilDay} 유지되고 그다음 날 0시에 풀려요` },
        { value: "NONE", label: "해제 안 함", preview: "직접 바꾸거나 지울 때까지 유지돼요" },
      ]
    : [
        ...keep,
        { value: "NONE", label: "해제 안 함", preview: "직접 바꾸거나 지울 때까지 유지돼요" },
        { value: "30M", label: "30분", preview: "30분 뒤에 풀려요" },
        { value: "1H", label: "1시간", preview: "1시간 뒤에 풀려요" },
        {
          value: "END_OF_DAY",
          label: endOfDay === "오늘 자정" ? "오늘 자정" : `퇴근 시 (${endOfDay})`,
          preview: `${endOfDay}에 자동으로 풀려요`,
        },
      ];
  const preview = durations.find((d) => d.value === draft.duration)?.preview;

  // 상태를 바꾸면, 메시지를 손대지 않았을 때는 앞 상태의 메시지를 비운다
  // ("오늘은 7F 자율석에 있어요"가 휴가에 그대로 붙지 않게). 원래 상태로 돌아오면 원래 메시지를 되살린다
  // 자리에 있음 ↔ 없음을 오가면 고를 수 있는 해제 방법이 달라서, 없는 방법이면 그 상태의 기본으로.
  // 휴가·출장·교육으로 바꾸면 마지막 날 고르기가 먼저
  function pickStatus(status: PresenceStatus) {
    setDraft((d) => {
      const untouched = d.message === savedMessage || d.message === "";
      const message = untouched ? (status === presence?.status ? savedMessage : "") : d.message;
      const allowed: PresenceDuration[] = isOut(status)
        ? ["KEEP", "END_OF_DAY", "UNTIL_DATE", "NONE"]
        : ["KEEP", "NONE", "30M", "1H", "END_OF_DAY"];
      const multiDay = MULTI_DAY.has(status) && d.duration !== "KEEP";
      const duration = multiDay || !allowed.includes(d.duration) ? fresh(status) : d.duration;
      return { ...d, status, message, duration };
    });
    setError(null);
  }

  async function send(method: "PUT" | "DELETE") {
    if (method === "PUT" && !draft.status) {
      setError("상태를 하나 고르세요.");
      return;
    }
    setPending(method === "PUT" ? "save" : "clear");
    setError(null);
    try {
      const res = await fetch("/api/presence/me", {
        method,
        headers: method === "PUT" ? { "content-type": "application/json" } : undefined,
        body:
          method === "PUT"
            ? JSON.stringify({ ...draft, until: draft.duration === "UNTIL_DATE" ? draft.until : null })
            : undefined,
      });
      if (res.status === 401) {
        router.replace(await sessionEndUrl());
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      onSaved?.();
      router.refresh();
    } catch {
      setError("저장하지 못했습니다. 잠시 후 다시 시도하세요.");
    } finally {
      setPending(null);
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void send("PUT");
  }

  return (
    <form onSubmit={onSubmit} className={styles.statusForm}>
      <h2 id={headingId}>{heading}</h2>

      <fieldset className={styles.statusOptions}>
        <legend className="visually-hidden">상태</legend>
        {GROUPS.map((group) => (
          <div key={group.label} className={styles.statusGroup} role="group" aria-label={group.label}>
            <span className={styles.statusGroupLabel} aria-hidden="true">
              {group.label}
            </span>
            {group.statuses.map((status) => (
              <label key={status} className={styles.statusOption}>
                <input
                  type="radio"
                  name={`${name}-status`}
                  value={status}
                  checked={draft.status === status}
                  onChange={() => pickStatus(status)}
                />
                <span className="mk" data-status={status} aria-hidden="true" />
                <span className={styles.statusOptionText}>
                  <span className={styles.statusOptionLabel}>{PRESENCE_LABEL[status]}</span>
                  <span className={styles.statusOptionHint}>{PRESENCE_HINT[status]}</span>
                </span>
              </label>
            ))}
          </div>
        ))}
      </fieldset>

      <label className={styles.statusField}>
        상태 메시지 (선택)
        <input
          value={draft.message}
          maxLength={100}
          placeholder={PRESENCE_PLACEHOLDER[draft.status ?? "AVAILABLE"]}
          onChange={(event) => setDraft((d) => ({ ...d, message: event.target.value }))}
        />
      </label>

      <fieldset className={styles.durations}>
        {/* 보이는 이름은 span: Safari는 fieldset의 legend 아래에 빈 줄을 더 그린다 */}
        <legend className="visually-hidden">자동 해제</legend>
        <span className={styles.durationsLabel} aria-hidden="true">
          자동 해제
        </span>
        <div>
          {durations.map((option) => (
            <label key={option.value}>
              <input
                type="radio"
                name={`${name}-duration`}
                value={option.value}
                checked={draft.duration === option.value}
                onChange={() => setDraft((d) => ({ ...d, duration: option.value }))}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {draft.duration === "UNTIL_DATE" && (
        <div className={styles.untilRow}>
          <span className={styles.durationsLabel}>마지막 날</span>
          <DatePicker
            label="마지막 날"
            value={draft.until}
            today={today}
            min={today}
            max={addDays(today, MAX_UNTIL_DAYS)}
            onChange={(iso) => setDraft((d) => ({ ...d, until: iso }))}
          />
        </div>
      )}
      {preview && (
        <p className={styles.statusNote} aria-live="polite">
          저장하면 {preview}.
        </p>
      )}
      {error && (
        <p role="alert" className={styles.statusError}>
          {error}
        </p>
      )}

      <div className={styles.statusActions}>
        {presence && (
          <button
            type="button"
            className={styles.statusClear}
            disabled={pending !== null}
            onClick={() => void send("DELETE")}
          >
            {pending === "clear" ? "지우는 중…" : "상태 지우기"}
          </button>
        )}
        <button type="submit" className={styles.statusSave} disabled={pending !== null}>
          {pending === "save" ? "저장 중…" : "상태 저장"}
        </button>
      </div>
    </form>
  );
}
