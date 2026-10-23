"use client";

import { useState } from "react";
import type { MyReservation } from "@/lib/api";
import { formatShortDay, kstDate } from "@/lib/dates";
import { hhmm } from "@/lib/rooms";
import styles from "./rooms.module.css";

type Props = {
  items: MyReservation[];
  today: string;
  onCancel: (id: number) => Promise<void>;
};

/** 내가 만들었거나 참석하는, 아직 끝나지 않은 예약. 만든 예약은 취소할 수 있다 (한 번 더 확인) */
export default function MyReservations({ items, today, onCancel }: Props) {
  const [confirming, setConfirming] = useState<number | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  async function cancel(id: number) {
    setBusy(id);
    try {
      await onCancel(id);
    } finally {
      setBusy(null);
      setConfirming(null);
    }
  }

  return (
    <section id="mine" className={styles.mine} aria-labelledby="mine-title">
      <h2 id="mine-title" className={styles.sectionTitle}>
        내 예약 <span className="mono">{items.length}</span>
      </h2>
      {items.length === 0 && <p className={styles.muted}>앞으로 잡힌 예약이 없어요.</p>}
      <ul className={styles.mineList}>
        {items.map((r) => {
          const day = kstDate(r.starts_at);
          return (
            <li key={r.id} className={styles.mineItem}>
              <div className={styles.mineHead}>
                <strong>{r.title}</strong>
                <span className={day === today ? styles.todayTag : `mono ${styles.muted}`}>
                  {day === today ? "오늘" : formatShortDay(day)}
                </span>
              </div>
              <span className={`mono ${styles.muted}`}>
                {r.floor} {r.room} · {hhmm.format(new Date(r.starts_at))}–{hhmm.format(new Date(r.ends_at))}
              </span>
              <span className={styles.mineTags}>
                {r.status === "PENDING_APPROVAL" && <span className={styles.tag}>승인 대기</span>}
                {r.series_id && <span className={styles.tag}>반복</span>}
                {!r.is_organizer && <span className={styles.tag}>참석</span>}
                {r.attendees > 0 && <span className={styles.muted}>참석자 {r.attendees}명</span>}
              </span>
              {r.is_organizer &&
                (confirming === r.id ? (
                  <div className={styles.mineActions} role="group" aria-label={`${r.title} 취소 확인`}>
                    <span>이 예약을 취소할까요?</span>
                    <button type="button" className={styles.dangerButton} disabled={busy === r.id} onClick={() => cancel(r.id)}>
                      {busy === r.id ? "취소하는 중…" : "예약 취소"}
                    </button>
                    <button type="button" className={styles.smallButton} onClick={() => setConfirming(null)}>
                      아니요
                    </button>
                  </div>
                ) : (
                  <div className={styles.mineActions}>
                    <button type="button" className={styles.smallButton} onClick={() => setConfirming(r.id)}>
                      취소
                    </button>
                  </div>
                ))}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
