"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { PlusIcon } from "@/components/icons";
import ReservationDetail from "@/components/ReservationDetail";
import type { MyReservation } from "@/lib/api";
import { addDays, formatShortDay, kstDate } from "@/lib/dates";
import { hhmm, spanDays } from "@/lib/rooms";
import styles from "./reservations.module.css";

type Tab = "upcoming" | "past";
type Role = "all" | "organizer" | "attendee";

const ROLES: { value: Role; label: string }[] = [
  { value: "all", label: "전체" },
  { value: "organizer", label: "내가 예약한" },
  { value: "attendee", label: "초대받은" },
];

const STATUS_TAG = { CANCELLED: "취소됨", RELEASED: "자동 반납" } as const;

type Props = { upcoming: MyReservation[]; past: MyReservation[]; today: string };

/** 내 예약 (초안). 예정·지난 예약을 날짜별로 묶어 보여 주고, 누르면 자세히 보기 팝업 (만든 사람은 거기서 취소) */
export default function ReservationsView({ upcoming, past, today }: Props) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("upcoming");
  const [role, setRole] = useState<Role>("all");
  const [detailId, setDetailId] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  const weekEnd = addDays(today, 7);
  // 요약 숫자에는 취소된 회의를 넣지 않는다 (목록에는 "취소됨"으로 며칠 남겨 둔다)
  const confirmed = upcoming.filter((r) => r.status === "CONFIRMED");
  const stats = [
    // 회의 수는 내가 실제로 들어가는 회의만 (예약만 해 준 회의는 빼고)
    { label: "오늘 남은 회의", value: confirmed.filter((r) => r.attending && kstDate(r.starts_at) === today).length },
    { label: "7일 안에", value: confirmed.filter((r) => r.attending && kstDate(r.starts_at) < weekEnd).length },
    { label: "내가 예약한", value: confirmed.filter((r) => r.is_organizer).length },
  ];

  const list = (tab === "upcoming" ? upcoming : past).filter(
    (r) => role === "all" || (role === "organizer" ? r.is_organizer : !r.is_organizer),
  );
  const groups = new Map<string, MyReservation[]>();
  for (const r of list) {
    const day = kstDate(r.starts_at);
    groups.set(day, [...(groups.get(day) ?? []), r]);
  }

  function dayTitle(day: string) {
    if (day === today) return `오늘 · ${formatShortDay(day)}`;
    if (day === addDays(today, 1)) return `내일 · ${formatShortDay(day)}`;
    if (day === addDays(today, -1)) return `어제 · ${formatShortDay(day)}`;
    return formatShortDay(day);
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>내 예약</h1>
        <Link className={styles.primary} href="/rooms">
          <PlusIcon size={18} />
          회의실 예약하기
        </Link>
      </header>

      <p className={styles.notice} role="status">
        {notice}
      </p>

      <main className={styles.main}>
        <ul className={styles.stats} aria-label="요약">
          {stats.map((s) => (
            <li key={s.label} className={styles.stat}>
              <span>{s.label}</span>
              <strong className="mono">{s.value}</strong>
            </li>
          ))}
        </ul>

        <div className={styles.toolbar}>
          <div className={styles.seg} role="group" aria-label="기간">
            <button type="button" aria-pressed={tab === "upcoming"} onClick={() => setTab("upcoming")}>
              예정 <span className="mono">{confirmed.length}</span>
            </button>
            <button type="button" aria-pressed={tab === "past"} onClick={() => setTab("past")}>
              지난 예약 (30일) <span className="mono">{past.length}</span>
            </button>
          </div>
          <div className={styles.chips} role="group" aria-label="내 역할">
            {ROLES.map((r) => (
              <button
                key={r.value}
                type="button"
                className={styles.chip}
                aria-pressed={role === r.value}
                onClick={() => setRole(r.value)}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        {groups.size === 0 && (
          <div className={styles.empty}>
            <p>{tab === "upcoming" ? "앞으로 잡힌 예약이 없어요." : "최근 30일 동안 지난 예약이 없어요."}</p>
            {tab === "upcoming" && (
              <Link className={styles.secondary} href="/rooms">
                회의실 예약 현황 보기
              </Link>
            )}
          </div>
        )}

        {[...groups.entries()].map(([day, items]) => (
          <section key={day} className={styles.day} aria-labelledby={`day-${day}`}>
            <h2 id={`day-${day}`} data-today={day === today || undefined}>
              {dayTitle(day)} <span>{items.length}건</span>
            </h2>
            <ul className={styles.list}>
              {items.map((r) => {
                const days = spanDays(r.starts_at, r.ends_at);
                return (
                  <li key={r.id}>
                    <button
                      type="button"
                      className={styles.item}
                      data-status={r.status}
                      aria-haspopup="dialog"
                      onClick={() => setDetailId(r.id)}
                    >
                      <span className={`mono ${styles.time}`}>
                        <strong>{hhmm.format(new Date(r.starts_at))}</strong>
                        {days ? (
                          <span>
                            ~{kstDate(r.ends_at).slice(5)}
                            <br />
                            {hhmm.format(new Date(r.ends_at))}
                          </span>
                        ) : (
                          <span>~{hhmm.format(new Date(r.ends_at))}</span>
                        )}
                      </span>
                      <span className={styles.body}>
                        <span className={styles.head}>
                          <strong>{r.title}</strong>
                          <span className={styles.tags}>
                            <span className={styles.tag} data-tone={r.is_organizer ? "dark" : undefined}>
                              {r.is_organizer ? (r.attending ? "예약·참석" : "예약만") : "참석"}
                            </span>
                            {days && <span className={styles.tag}>{days}일</span>}
                            {r.series_id && <span className={styles.tag}>반복</span>}
                            {r.status !== "CONFIRMED" && (
                              <span className={styles.tag} data-tone="danger">
                                {STATUS_TAG[r.status]}
                              </span>
                            )}
                          </span>
                        </span>
                        <span className={styles.meta}>
                          {r.floor} {r.room} · {r.attendees}명 참석
                          {!r.is_organizer && ` · 예약 ${r.organizer_department} ${r.organizer}`}
                          {r.is_organizer && !r.attending && " · 나는 예약만 (회의에는 안 들어감)"}
                          {r.status === "CANCELLED" && r.cancelled_at && " · 예약한 사람이 취소했어요"}
                        </span>
                      </span>
                      <span className={styles.more} aria-hidden="true">
                        자세히 ›
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </main>

      <ReservationDetail
        reservationId={detailId}
        onClose={() => setDetailId(null)}
        onCancelled={(title, count) => {
          setDetailId(null);
          setNotice(count > 1 ? `‘${title}’ 예약 ${count}회를 취소했어요.` : `‘${title}’ 예약을 취소했어요.`);
          router.refresh();
        }}
        showTimetableLink
      />
    </div>
  );
}
