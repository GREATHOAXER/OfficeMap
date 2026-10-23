"use client";

import { CloseIcon } from "@/components/icons";
import type { FloorMap, Seat } from "@/lib/api";
import { PRESENCE_LABEL, PRESENCE_ORDER } from "@/lib/presence";
import { roomStatusText } from "@/lib/rooms";
import styles from "./office.module.css";

type Props = {
  map: FloorMap;
  seat: Seat | null;
  onClear: () => void;
};

// 오른쪽 패널: 자리를 고르면 앉은 사람 정보, 안 고르면 이 층 요약
export default function SeatPanel({ map, seat, onClear }: Props) {
  if (!seat) return <FloorSummaryCard map={map} />;

  const zone = map.zones.find((z) => z.id === seat.zone_id);
  const where = `${map.floor.site.name} ${map.floor.name} · ${seat.code}`;
  const { occupant } = seat;

  return (
    <section className={styles.card} aria-labelledby="seat-title" data-color={zone?.color_key ?? "t0"}>
      <button type="button" className={styles.cardClose} aria-label="선택 해제" onClick={onClear}>
        <CloseIcon size={18} />
      </button>

      {occupant ? (
        <>
          <div className={styles.person}>
            <span className={styles.personAvatar} aria-hidden="true">
              {occupant.name.slice(-2)}
            </span>
            <div>
              <h2 id="seat-title" className={styles.personName}>
                {occupant.name} {occupant.rank}
              </h2>
              <p className={styles.personTeam}>
                <span className={styles.swatch} aria-hidden="true" />
                {occupant.department}
              </p>
            </div>
          </div>
          <div className={styles.statusBox}>
            {occupant.presence ? (
              <>
                <strong>
                  <span className="mk" data-status={occupant.presence.status} aria-hidden="true" />
                  {PRESENCE_LABEL[occupant.presence.status]}
                </strong>
                {occupant.presence.message && <span>{occupant.presence.message}</span>}
              </>
            ) : (
              <span>재실 상태를 정하지 않았어요</span>
            )}
          </div>
          <dl className={styles.facts}>
            <dt>위치</dt>
            <dd>
              {where}
              {occupant.kind === "DAILY" && <span className={styles.tag}>오늘 자율석</span>}
            </dd>
            <dt>내선</dt>
            <dd className="mono">{occupant.extension ?? "—"}</dd>
            <dt>이메일</dt>
            <dd className="mono">
              {occupant.email ? <a href={`mailto:${occupant.email}`}>{occupant.email}</a> : "—"}
            </dd>
          </dl>
        </>
      ) : (
        <>
          <h2 id="seat-title" className={styles.personName}>
            {seat.status === "OUT_OF_SERVICE" ? "사용 중지 좌석" : seat.seat_type === "FLEX" ? "빈 자율석" : "빈 자리"}
          </h2>
          <dl className={styles.facts}>
            <dt>위치</dt>
            <dd>{where}</dd>
            <dt>구역</dt>
            <dd>{zone ? `${zone.name} · ${zone.code}` : "—"}</dd>
            <dt>유형</dt>
            <dd>{seat.seat_type === "FLEX" ? "자율석 (누구나 그날 앉을 수 있음)" : "고정석"}</dd>
          </dl>
        </>
      )}
    </section>
  );
}

function FloorSummaryCard({ map }: { map: FloorMap }) {
  if (map.seats.length === 0) return <SharedFloorCard map={map} />;
  const seated = map.seats.filter((s) => s.occupant);
  const flex = map.seats.filter((s) => s.seat_type === "FLEX").length;
  const counts = new Map(PRESENCE_ORDER.map((status) => [status, 0]));
  for (const seat of seated) {
    const status = seat.occupant?.presence?.status;
    if (status) counts.set(status, (counts.get(status) ?? 0) + 1);
  }

  return (
    <section className={styles.card} aria-labelledby="floor-summary-title">
      <h2 id="floor-summary-title" className={styles.cardTitle}>
        {map.floor.name} 한눈에
      </h2>
      <dl className={styles.stats}>
        <div>
          <dt>좌석</dt>
          <dd className="mono">{map.seats.length}</dd>
        </div>
        <div>
          <dt>앉은 사람</dt>
          <dd className="mono">{seated.length}</dd>
        </div>
        <div>
          <dt>빈 자리</dt>
          <dd className="mono">{map.seats.length - seated.length}</dd>
        </div>
      </dl>
      <ul className={styles.presenceList}>
        {PRESENCE_ORDER.map((status) => (
          <li key={status}>
            <span className="mk" data-status={status} aria-hidden="true" />
            {PRESENCE_LABEL[status]}
            <span className="mono">{counts.get(status)}</span>
          </li>
        ))}
      </ul>
      <p className={styles.cardHint}>
        자리를 누르면 앉은 사람의 재실 상태와 연락처가 여기에 보여요.
        {flex > 0 && ` 이 층에는 자율석이 ${flex}석 있어요.`}
      </p>
    </section>
  );
}

// 로비·대강당·식당처럼 개인 좌석이 없는 층: 회의실 현황을 보여 준다
function SharedFloorCard({ map }: { map: FloorMap }) {
  return (
    <section className={styles.card} aria-labelledby="floor-summary-title">
      <h2 id="floor-summary-title" className={styles.cardTitle}>
        {map.floor.name} 한눈에
      </h2>
      <p className={styles.cardHint}>이 층에는 개인 좌석이 없어요.</p>
      {map.rooms.length > 0 && (
        <ul className={styles.roomList}>
          {map.rooms.map((room) => (
            <li key={room.id}>
              <strong>
                {room.name}
              </strong>
              <span>
                최대 {room.capacity}명 · {roomStatusText(room)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
