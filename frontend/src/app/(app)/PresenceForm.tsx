"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useId, useState } from "react";
import type { MyPresenceInfo, PresenceDuration, PresenceStatus } from "@/lib/api";
import { kstDate } from "@/lib/dates";
import { expiredLoginUrl } from "@/lib/loginRedirect";
import { PRESENCE_HINT, PRESENCE_LABEL, PRESENCE_ORDER, PRESENCE_PLACEHOLDER } from "@/lib/presence";
import { hhmm } from "@/lib/rooms";
import styles from "./office.module.css";

type Draft = { status: PresenceStatus | null; message: string; duration: PresenceDuration };

type Props = {
  info: MyPresenceInfo;
  heading: string;
  headingId: string;
  /** 저장하거나 지운 뒤 (머리글 패널은 닫는다) */
  onSaved?: () => void;
};

/** 해제 시각 문구: 오늘이면 "18:00", 다른 날이면 "내일 00:00" */
function releaseText(iso: string) {
  const time = hhmm.format(new Date(iso));
  if (time === "00:00") return "오늘 자정";
  return kstDate(iso) === kstDate(new Date().toISOString()) ? time : `내일 ${time}`;
}

/**
 * 내 재실 상태 바꾸기 폼: 상태 4가지, 메시지, 자동 해제.
 * 머리글의 "내 상태" 패널과 내 재실 상태 화면이 같이 쓴다. 저장하면 화면 데이터를 다시 읽는다.
 * 지금 저장된 상태로 채운다: 해제 시각이 걸려 있으면 "그대로"가 골라져 있어서, 메시지만 고쳐도 해제 시각이 바뀌지 않는다
 */
export default function PresenceForm({ info, heading, headingId, onSaved }: Props) {
  const { presence } = info;
  const router = useRouter();
  const name = useId(); // 한 화면에 폼이 둘 있어도 라디오 묶음이 섞이지 않게
  const savedMessage = presence?.message ?? "";
  const [draft, setDraft] = useState<Draft>(() => ({
    status: presence?.status ?? null, // 정하지 않았으면 아무것도 고르지 않은 채로
    message: savedMessage,
    duration: !presence ? "END_OF_DAY" : presence.expires_at ? "KEEP" : "NONE",
  }));
  const [pending, setPending] = useState<"save" | "clear" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const endOfDay = releaseText(info.end_of_day_at);
  const durations: { value: PresenceDuration; label: string; preview: string }[] = [
    ...(presence?.expires_at
      ? [
          {
            value: "KEEP" as const,
            label: `그대로 (${releaseText(presence.expires_at)})`,
            preview: `${releaseText(presence.expires_at)}에 자동으로 풀려요`,
          },
        ]
      : []),
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
  // ("편하게 찾아오세요"가 방해 금지에 그대로 붙지 않게). 원래 상태로 돌아오면 원래 메시지를 되살린다
  function pickStatus(status: PresenceStatus) {
    setDraft((d) => {
      const untouched = d.message === savedMessage || d.message === "";
      const message = untouched ? (status === presence?.status ? savedMessage : "") : d.message;
      return { ...d, status, message };
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
        body: method === "PUT" ? JSON.stringify(draft) : undefined,
      });
      if (res.status === 401) {
        router.replace(expiredLoginUrl());
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
        {PRESENCE_ORDER.map((status) => (
          <label key={status} className={styles.statusOption}>
            <input
              type="radio"
              name={`${name}-status`}
              value={status}
              checked={draft.status === status}
              onChange={() => pickStatus(status)}
            />
            <span className="mk" data-status={status} aria-hidden="true" />
            <span className={styles.statusOptionLabel}>{PRESENCE_LABEL[status]}</span>
            <span className={styles.statusOptionHint}>{PRESENCE_HINT[status]}</span>
          </label>
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
        <legend>자동 해제</legend>
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
