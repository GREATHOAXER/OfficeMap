"use client";

import Link from "next/link";
import { useState } from "react";
import { GridIcon } from "@/components/icons";
import type { EmployeeHit, MyPresence, MyReservation, MyTeam, PresenceStatus } from "@/lib/api";
import { kstDate } from "@/lib/dates";
import { useLivePresence, useRefreshAtExpiry, withLiveMine } from "@/lib/livePresence";
import { PRESENCE_HINT, PRESENCE_LABEL, PRESENCE_ORDER } from "@/lib/presence";
import { hhmm, rangeText } from "@/lib/rooms";
import PresenceForm from "../PresenceForm";
import styles from "./presence.module.css";

type Props = {
  myEmpNo: string;
  presence: MyPresence;
  team: MyTeam;
  upcoming: MyReservation[];
  today: string;
};

/** 상태 순서 (상태 없음은 맨 뒤) */
const rank = (status: PresenceStatus | undefined) => (status ? PRESENCE_ORDER.indexOf(status) : PRESENCE_ORDER.length);

/**
 * 내 재실 상태 (초안). 디자인 시안의 "내 재실 상태"(상태 4가지·메시지·자동 해제)에
 * 지금 내 상태, 오늘 내 일정, 우리 팀 재실 현황을 붙였다. 팀 현황과 내 상태는 실시간으로 바뀐다
 */
export default function PresenceView({ myEmpNo, presence, team, upcoming, today }: Props) {
  const live = useLivePresence();
  const mine = withLiveMine(presence, live.get(myEmpNo), team.fetched_at);
  useRefreshAtExpiry([mine?.expires_at]);
  const [filter, setFilter] = useState<PresenceStatus | null>(null);

  // 팀 사람들에게도 읽은 뒤에 온 상태 변경을 덮어쓴다
  const fetchedAt = Date.parse(team.fetched_at);
  const members: EmployeeHit[] = team.members.map((m) => {
    const change = live.get(m.emp_no);
    if (!change || Date.parse(change.at) <= fetchedAt) return m;
    return { ...m, presence: change.presence && { status: change.presence.status, message: change.presence.message } };
  });
  const me = members.find((m) => m.is_me);
  const counts = PRESENCE_ORDER.map((status) => ({
    status,
    count: members.filter((m) => m.presence?.status === status).length,
  }));
  const shown = members
    .filter((m) => !filter || m.presence?.status === filter)
    .sort((a, b) => rank(a.presence?.status) - rank(b.presence?.status) || a.name.localeCompare(b.name, "ko"));

  const todays = upcoming.filter((r) => kstDate(r.starts_at) <= today && today <= kstDate(r.ends_at));

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>내 재실 상태</h1>
        {me?.seat && (
          <Link className={styles.secondary} href={`/?floor=${me.seat.floor_id}&seat=${me.seat.id}`}>
            <GridIcon size={16} />
            도면에서 내 자리 보기
          </Link>
        )}
      </header>

      <main className={styles.main}>
        <div className={styles.grid}>
          <div className={styles.column}>
            <section className={styles.card} aria-labelledby="now-title">
              <h2 id="now-title" className={styles.cardTitle}>
                지금 내 상태
              </h2>
              <div className={styles.now} data-status={mine?.status ?? "NONE"}>
                {mine ? (
                  <>
                    <span className={`mk ${styles.bigMark}`} data-status={mine.status} aria-hidden="true" />
                    <span className={styles.nowText}>
                      <strong>{PRESENCE_LABEL[mine.status]}</strong>
                      <span>{mine.message ?? PRESENCE_HINT[mine.status]}</span>
                    </span>
                  </>
                ) : (
                  <span className={styles.nowText}>
                    <strong>정하지 않음</strong>
                    <span>아래에서 상태를 고르면 동료들 도면에 바로 보여요.</span>
                  </span>
                )}
              </div>
              <dl className={styles.facts}>
                <dt>자동 해제</dt>
                <dd>
                  {!mine
                    ? "–"
                    : mine.expires_at
                      ? `${hhmm.format(new Date(mine.expires_at))}에 자동으로 풀려요`
                      : "직접 바꿀 때까지 유지"}
                </dd>
                <dt>내 자리</dt>
                <dd className="mono">
                  {me?.seat ? `${me.seat.site_name} ${me.seat.floor_name} · ${me.seat.code}` : "배정된 자리 없음"}
                </dd>
                <dt>바꾼 시각</dt>
                <dd className="mono">{mine ? hhmm.format(new Date(mine.updated_at)) : "–"}</dd>
              </dl>
            </section>

            <section className={styles.card} aria-labelledby="change-title">
              <PresenceForm
                key={mine?.updated_at ?? "none"} // 저장하거나 다른 곳에서 바뀌면 지금 상태로 다시 채운다
                presence={mine}
                heading="상태 바꾸기"
                headingId="change-title"
              />
              <p className={styles.note}>사무실 출입 기록·캘린더 일정으로 자동으로 바뀌는 기능은 연동 여부를 검토 중이에요.</p>
            </section>
          </div>

          <div className={styles.column}>
            <section className={styles.card} aria-labelledby="today-title">
              <div className={styles.cardHead}>
                <h2 id="today-title" className={styles.cardTitle}>
                  오늘 내 일정 <span>{todays.length}건</span>
                </h2>
                <Link className={styles.textLink} href="/reservations">
                  내 예약 전체 ›
                </Link>
              </div>
              {todays.length === 0 ? (
                <p className={styles.empty}>오늘 남은 회의가 없어요.</p>
              ) : (
                <ul className={styles.schedule}>
                  {todays.map((r) => (
                    <li key={r.id}>
                      <span className="mono">{rangeText(r.starts_at, r.ends_at)}</span>
                      <strong>{r.title}</strong>
                      <span className={styles.muted}>
                        {r.floor} {r.room}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {todays.length > 0 && <p className={styles.note}>회의에 들어가기 전에 ‘회의 중’으로 바꿔 두면 동료들이 알 수 있어요.</p>}
            </section>

            <section className={styles.card} aria-labelledby="team-title">
              <div className={styles.cardHead}>
                <h2 id="team-title" className={styles.cardTitle}>
                  우리 팀 재실 현황 <span>{team.team.name} {members.length}명</span>
                </h2>
                <span className={styles.liveTag}>실시간</span>
              </div>
              <div className={styles.counts} role="group" aria-label="상태로 거르기">
                {counts.map(({ status, count }) => (
                  <button
                    key={status}
                    type="button"
                    className={styles.count}
                    aria-pressed={filter === status}
                    onClick={() => setFilter(filter === status ? null : status)}
                  >
                    <span className="mk" data-status={status} aria-hidden="true" />
                    {PRESENCE_LABEL[status]}
                    <strong className="mono">{count}</strong>
                  </button>
                ))}
              </div>
              <ul className={styles.members}>
                {shown.map((m) => (
                  <li key={m.emp_no} className={styles.member}>
                    <span className={styles.markSlot}>
                      {m.presence && <span className="mk" data-status={m.presence.status} aria-hidden="true" />}
                    </span>
                    <span className={styles.memberMain}>
                      <span>
                        <strong>{m.name}</strong> {m.rank}
                        {m.is_me && <span className={styles.me}>나</span>}
                      </span>
                      <span className={styles.muted}>
                        {m.presence ? PRESENCE_LABEL[m.presence.status] : "상태 없음"}
                        {m.presence?.message && ` · ${m.presence.message}`}
                      </span>
                    </span>
                    <span className={`mono ${styles.seat}`}>
                      {m.seat ? `${m.seat.floor_name} ${m.seat.code}` : "자리 없음"}
                    </span>
                  </li>
                ))}
                {shown.length === 0 && <li className={styles.empty}>이 상태인 사람이 없어요.</li>}
              </ul>
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}
