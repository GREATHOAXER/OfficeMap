"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useId, useState } from "react";
import type { MyPresence, PresenceDuration, PresenceStatus } from "@/lib/api";
import { PRESENCE_HINT, PRESENCE_LABEL, PRESENCE_ORDER } from "@/lib/presence";
import { hhmm } from "@/lib/rooms";
import styles from "./office.module.css";

const DURATIONS: { value: PresenceDuration; label: string }[] = [
  { value: "NONE", label: "계속" },
  { value: "30M", label: "30분" },
  { value: "1H", label: "1시간" },
  { value: "END_OF_DAY", label: "퇴근 시" },
];

type Draft = { status: PresenceStatus; message: string; duration: PresenceDuration };

type Props = {
  presence: MyPresence;
  heading: string;
  headingId: string;
  /** 저장하거나 지운 뒤 (머리글 패널은 닫는다) */
  onSaved?: () => void;
};

/**
 * 내 재실 상태 바꾸기 폼: 상태 4가지, 메시지, 자동 해제.
 * 머리글의 "내 상태" 패널과 내 재실 상태 화면이 같이 쓴다. 저장하면 화면 데이터를 다시 읽는다
 */
export default function PresenceForm({ presence, heading, headingId, onSaved }: Props) {
  const router = useRouter();
  const name = useId(); // 한 화면에 폼이 둘 있어도 라디오 묶음이 섞이지 않게
  const [draft, setDraft] = useState<Draft>(() => ({
    status: presence?.status ?? "AVAILABLE",
    message: presence?.message ?? "",
    duration: presence && presence.expires_at === null ? "NONE" : "END_OF_DAY",
  }));
  const [pending, setPending] = useState<"save" | "clear" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send(method: "PUT" | "DELETE") {
    setPending(method === "PUT" ? "save" : "clear");
    setError(null);
    try {
      const res = await fetch("/api/presence/me", {
        method,
        headers: method === "PUT" ? { "content-type": "application/json" } : undefined,
        body: method === "PUT" ? JSON.stringify(draft) : undefined,
      });
      if (res.status === 401) {
        router.replace("/login");
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
              onChange={() => setDraft((d) => ({ ...d, status }))}
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
          placeholder="예: 15시까지 집중 업무"
          onChange={(event) => setDraft((d) => ({ ...d, message: event.target.value }))}
        />
      </label>

      <fieldset className={styles.durations}>
        <legend>자동 해제</legend>
        <div>
          {DURATIONS.map((option) => (
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

      {presence?.expires_at && (
        <p className={styles.statusNote}>지금 상태는 {hhmm.format(new Date(presence.expires_at))}에 자동으로 풀려요.</p>
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
