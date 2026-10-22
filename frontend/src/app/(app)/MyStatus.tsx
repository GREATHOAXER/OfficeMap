"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { ChevronDownIcon } from "@/components/icons";
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

// 머리글의 "내 상태" 버튼과, 눌렀을 때 뜨는 상태 바꾸기 패널.
// 저장하면 서버 데이터를 다시 읽어서 도면의 내 자리 표시도 같이 바뀐다
export default function MyStatus({ presence }: { presence: MyPresence }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>({ status: "AVAILABLE", message: "", duration: "END_OF_DAY" });
  const [pending, setPending] = useState<"save" | "clear" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);

  // 열면 고른 상태로, 닫으면 버튼으로 포커스를 옮긴다
  useEffect(() => {
    if (open) panelRef.current?.querySelector<HTMLInputElement>('input[name="status"]:checked')?.focus();
    else if (wasOpen.current) buttonRef.current?.focus();
    wasOpen.current = open;
  }, [open]);

  // 패널 밖을 누르면 닫는다
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function openPanel() {
    setDraft({
      status: presence?.status ?? "AVAILABLE",
      message: presence?.message ?? "",
      duration: presence && presence.expires_at === null ? "NONE" : "END_OF_DAY",
    });
    setError(null);
    setOpen(true);
  }

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
      setOpen(false);
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

  const current = presence?.status;

  return (
    <div
      ref={boxRef}
      className={styles.myStatus}
      onKeyDown={(event) => {
        if (event.key === "Escape") setOpen(false);
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        className={styles.myStatusButton}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="my-status-panel"
        onClick={() => (open ? setOpen(false) : openPanel())}
      >
        <span className={styles.myStatusCaption}>내 상태</span>
        {current && <span className="mk" data-status={current} aria-hidden="true" />}
        <strong>{current ? PRESENCE_LABEL[current] : "정하지 않음"}</strong>
        <ChevronDownIcon size={16} />
      </button>

      {open && (
        <div
          ref={panelRef}
          id="my-status-panel"
          role="dialog"
          aria-labelledby="my-status-title"
          className={styles.statusPanel}
        >
          <form onSubmit={onSubmit} className={styles.statusForm}>
            <h2 id="my-status-title">내 재실 상태</h2>

            <fieldset className={styles.statusOptions}>
              <legend className="visually-hidden">상태</legend>
              {PRESENCE_ORDER.map((status) => (
                <label key={status} className={styles.statusOption}>
                  <input
                    type="radio"
                    name="status"
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
                      name="duration"
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
              <p className={styles.statusNote}>
                지금 상태는 {hhmm.format(new Date(presence.expires_at))}에 자동으로 풀려요.
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
        </div>
      )}
    </div>
  );
}
