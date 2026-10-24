"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { ReservationDetail as Detail } from "@/lib/api";
import { formatDuration, formatShortDay, kstDate } from "@/lib/dates";
import { PRESENCE_LABEL } from "@/lib/presence";
import { rangeText } from "@/lib/rooms";
import Dialog from "./Dialog";
import styles from "./ReservationDetail.module.css";

const EQUIPMENT_LABEL: Record<string, string> = { VIDEO: "화상회의", TV: "TV", PROJECTOR: "빔 프로젝터" };
const REPEAT_LABEL = { WEEKLY: "매주 같은 요일", WEEKDAYS: "매일 (평일)" } as const;
const STATUS_LABEL = { CANCELLED: "취소된 예약", RELEASED: "체크인이 없어 자동 반납된 예약" } as const;

type Props = {
  /** 보여 줄 예약. null이면 닫혀 있다 */
  reservationId: number | null;
  onClose: () => void;
  /** 취소했을 때 (목록·현황표를 다시 읽는다) */
  onCancelled: (title: string) => void;
  /** 예약 현황표 링크를 보여 줄지 (내 예약 화면에서) */
  showTimetableLink?: boolean;
};

type Loaded = { id: number; detail: Detail | null; failed: boolean };

/** 예약 한 건 자세히 보기 팝업: 일시, 장소, 만든 사람, 참석자(재실 상태), 반복 규칙. 만든 사람은 여기서 취소할 수 있다 */
export default function ReservationDetail({ reservationId, onClose, onCancelled, showTimetableLink }: Props) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  useEffect(() => {
    if (reservationId === null) return;
    const controller = new AbortController();
    fetch(`/api/reservations/${reservationId}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        setLoaded({ id: reservationId, detail: (await res.json()) as Detail, failed: false });
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoaded({ id: reservationId, detail: null, failed: true });
      });
    return () => controller.abort();
  }, [reservationId]);

  const current = loaded && loaded.id === reservationId ? loaded : null;
  const detail = current?.detail ?? null;

  function close() {
    setConfirming(false);
    setCancelError(null);
    onClose();
  }

  async function cancel() {
    if (!detail) return;
    setCancelling(true);
    setCancelError(null);
    try {
      const res = await fetch(`/api/reservations/${detail.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(String(res.status));
      setConfirming(false);
      onCancelled(detail.title);
    } catch {
      setCancelError("취소하지 못했어요. 이미 끝났거나 취소된 예약일 수 있어요.");
    } finally {
      setCancelling(false);
    }
  }

  let body;
  if (!current) body = <p className={styles.state}>불러오는 중…</p>;
  else if (!detail) body = <p className={styles.state}>예약 정보를 불러오지 못했어요.</p>;
  else {
    const minutes = Math.round((Date.parse(detail.ends_at) - Date.parse(detail.starts_at)) / 60_000);
    const byTeam = new Map<string, Detail["attendees"]>();
    for (const a of detail.attendees) byTeam.set(a.department, [...(byTeam.get(a.department) ?? []), a]);
    body = (
      <div className={styles.detail}>
        {detail.status !== "CONFIRMED" ? (
          <p className={styles.badge} data-tone="danger">
            {STATUS_LABEL[detail.status]}
          </p>
        ) : (
          detail.ended && <p className={styles.badge}>끝난 회의</p>
        )}
        <dl className={styles.facts}>
          <dt>일시</dt>
          <dd>
            <span className="mono">{rangeText(detail.starts_at, detail.ends_at)}</span>
            <span className={styles.sub}>{formatDuration(minutes)}</span>
            {detail.series && (
              <span className={styles.sub}>
                {REPEAT_LABEL[detail.series.repeat]} 반복 · {formatShortDay(detail.series.first_date)} ~{" "}
                {formatShortDay(detail.series.last_date)}
              </span>
            )}
          </dd>
          <dt>장소</dt>
          <dd>
            {detail.room.site} {detail.room.floor} {detail.room.name}
            <span className={styles.sub}>
              최대 {detail.room.capacity}인
              {detail.room.equipment.length > 0 && ` · ${detail.room.equipment.map((e) => EQUIPMENT_LABEL[e] ?? e).join(", ")}`}
            </span>
          </dd>
          <dt>만든 사람</dt>
          <dd>
            <span>
              {detail.organizer.name} {detail.organizer.rank}
              {detail.is_organizer && <span className={styles.me}>나</span>}
            </span>
            <span className={styles.sub}>
              {detail.organizer.department}
              {detail.organizer.extension && ` · 내선 ${detail.organizer.extension}`}
            </span>
          </dd>
        </dl>

        <section className={styles.attendees} aria-labelledby="detail-attendees">
          <h3 id="detail-attendees">참석자 {detail.attendees.length}명</h3>
          {detail.attendees.length === 0 && <p className={styles.sub}>따로 초대한 사람이 없어요.</p>}
          {[...byTeam.entries()].map(([team, people]) => (
            <div key={team} className={styles.team}>
              <h4>
                {team} <span>{people.length}명</span>
              </h4>
              <ul>
                {people.map((p) => (
                  <li key={p.emp_no}>
                    <span className={styles.markSlot}>
                      {p.presence && <span className="mk" data-status={p.presence} aria-hidden="true" />}
                    </span>
                    {p.name} {p.rank}
                    {p.is_me && <span className={styles.me}>나</span>}
                    {p.presence && <span className={styles.presence}>{PRESENCE_LABEL[p.presence]}</span>}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>

        {cancelError && (
          <p role="alert" className={styles.error}>
            {cancelError}
          </p>
        )}
      </div>
    );
  }

  const footer = detail && (
    <>
      <Link className={styles.link} href={`/?floor=${detail.room.floor_id}`}>
        도면에서 보기
      </Link>
      {showTimetableLink && (
        <Link className={styles.link} href={`/rooms?date=${kstDate(detail.starts_at)}`}>
          예약 현황표에서 보기
        </Link>
      )}
      <span className={styles.spacer} />
      {detail.can_cancel &&
        (confirming ? (
          <span className={styles.confirm} role="group" aria-label="예약 취소 확인">
            <span>이 회의를 취소할까요?{detail.series ? " (이 회차만)" : ""}</span>
            <button type="button" className={styles.danger} disabled={cancelling} onClick={cancel}>
              {cancelling ? "취소하는 중…" : "취소하기"}
            </button>
            <button type="button" className={styles.secondary} onClick={() => setConfirming(false)}>
              아니요
            </button>
          </span>
        ) : (
          <button type="button" className={styles.secondary} onClick={() => setConfirming(true)}>
            예약 취소
          </button>
        ))}
    </>
  );

  return (
    <Dialog open={reservationId !== null} onClose={close} title={detail?.title ?? "예약 정보"} footer={footer}>
      {body}
    </Dialog>
  );
}
