"use client";

import Link from "next/link";
import Avatar from "@/components/Avatar";
import { CloseIcon } from "@/components/icons";
import type { EmployeeHit, FloorMap, Occupant, Seat } from "@/lib/api";
import { agoText } from "@/lib/dates";
import { NO_STATUS_LABEL, PRESENCE_LABEL, PRESENCE_ORDER, presenceMessage } from "@/lib/presence";
import { hhmm, roomStatusText } from "@/lib/rooms";
import { useNow } from "@/lib/useNow";
import styles from "./office.module.css";
import { zoneColorVars } from "@/lib/zoneColors";

type Props = {
  map: FloorMap;
  seat: Seat | null;
  myEmpNo: string;
  onClear: () => void;
};

// 오른쪽 패널: 자리를 고르면 앉은 사람 정보, 안 고르면 이 층 요약
export default function SeatPanel({ map, seat, myEmpNo, onClear }: Props) {
  if (!seat) return <FloorSummaryCard map={map} />;

  const zone = map.zones.find((z) => z.id === seat.zone_id);
  const where = `${map.floor.site.name} ${map.floor.name} · ${seat.code}`;
  const { occupant } = seat;
  const mine = occupant?.emp_no === myEmpNo;

  return (
    <section
      className={styles.card}
      aria-labelledby="seat-title"
      data-color={zone?.color_key ?? "t0"}
      style={zoneColorVars(zone?.color_key)}
    >
      <button type="button" className={styles.cardClose} aria-label="선택 해제" onClick={onClear}>
        <CloseIcon size={18} />
      </button>

      {occupant ? (
        <>
          <div className={styles.person}>
            <span className={styles.personAvatar} aria-hidden="true">
              <Avatar name={occupant.name} photo={occupant.photo} size={52} />
            </span>
            <div>
              <h2 id="seat-title" className={styles.personName}>
                {occupant.name} {occupant.rank}
                {occupant.display_name && <span className={styles.personAlias}>{occupant.display_name}</span>}
                {mine && <span className={styles.tag}>내 자리</span>}
              </h2>
              <p className={styles.personTeam}>
                <span className={styles.swatch} aria-hidden="true" />
                {occupant.department}
              </p>
              {occupant.headline && <p className={styles.personHeadline}>{occupant.headline}</p>}
            </div>
          </div>
          <div className={styles.statusBox}>
            {occupant.presence ? (
              <>
                <strong>
                  <span className="mk" data-status={occupant.presence.status} aria-hidden="true" />
                  {PRESENCE_LABEL[occupant.presence.status]}
                </strong>
                {presenceMessage(occupant.presence) && <span>{presenceMessage(occupant.presence)}</span>}
              </>
            ) : (
              <span>재실 상태를 정하지 않았어요</span>
            )}
            <Freshness presence={occupant.presence} />
          </div>
          {mine && (
            <Link href="/presence" className={styles.cardLink}>
              내 재실 상태 바꾸기 ›
            </Link>
          )}
          {(occupant.duties || occupant.skills.length > 0) && (
            <div className={styles.duties}>
              <h3>하는 일</h3>
              {occupant.duties && <p>{occupant.duties}</p>}
              {occupant.skills.length > 0 && (
                <ul aria-label="업무 키워드">
                  {occupant.skills.map((s) => (
                    <li key={s}>#{s}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {mine && (
            <Link href="/profile" className={styles.cardLink}>
              {occupant.duties || occupant.photo ? "내 정보 고치기 ›" : "내 정보에 사진·하는 일 적기 ›"}
            </Link>
          )}
          <dl className={styles.facts}>
            <dt>위치</dt>
            <dd>
              {where}
              {occupant.kind === "DAILY" && <span className={styles.tag}>오늘 자율석</span>}
            </dd>
            <dt>내선</dt>
            <dd className="mono">{occupant.extension ?? "—"}</dd>
            <dt>이메일</dt>
            <dd className="mono">{occupant.email ? <a href={`mailto:${occupant.email}`}>{occupant.email}</a> : "—"}</dd>
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
  // 사용 중지 좌석은 빈 자리로 세지 않는다
  const offline = map.seats.filter((s) => s.status === "OUT_OF_SERVICE" && !s.occupant).length;
  const counts = new Map(PRESENCE_ORDER.map((status) => [status, 0]));
  let noStatus = 0;
  for (const seat of seated) {
    const status = seat.occupant?.presence?.status;
    if (status) counts.set(status, (counts.get(status) ?? 0) + 1);
    else noStatus += 1;
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
          <dt>배정 인원</dt>
          <dd className="mono">{seated.length}</dd>
        </div>
        <div>
          <dt>빈 자리</dt>
          <dd className="mono">{map.seats.length - seated.length - offline}</dd>
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
        <li>
          <span className={styles.noStatusMark} aria-hidden="true" />
          {NO_STATUS_LABEL}
          <span className="mono">{noStatus}</span>
        </li>
      </ul>
      <p className={styles.cardHint}>
        자리를 누르면 앉은 사람의 재실 상태와 연락처가 여기에 보여요.
        {flex > 0 && ` 이 층에는 자율석이 ${flex}석 있어요.`}
        {offline > 0 && ` 사용 중지 좌석 ${offline}석은 빈 자리에 넣지 않았어요.`}
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
          {/* 도면의 회의실처럼 누르면 이 층 예약 현황으로 */}
          {map.rooms.map((room) => (
            <li key={room.id}>
              <Link href={`/rooms?floor=${map.floor.id}`} aria-label={`${room.name}, ${roomStatusText(room)}. 예약 현황 보기`}>
                <strong>{room.name}</strong>
                <span>
                  최대 {room.capacity}명 · {roomStatusText(room)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** 언제 바꾼 상태인지, 언제 풀리는지. 오래된 상태(예: 어제 정한 "방문 가능")를 알아보게 */
function Freshness({ presence }: { presence: Occupant["presence"] }) {
  const now = useNow();
  if (!presence) return null;
  const ago = presence.updated_at ? agoText(presence.updated_at, now) : "";
  if (!ago && !presence.expires_at) return null;
  return (
    <span className={styles.freshness}>
      {ago && `${ago} 변경`}
      {ago && " · "}
      {presence.expires_at ? `${hhmm.format(new Date(presence.expires_at))}에 자동 해제` : "직접 바꿀 때까지 유지"}
    </span>
  );
}

/** 검색에서 고른, 아직 자리가 없는 사람 (도면에서 보여 줄 곳이 없어 연락처를 대신 보여 준다) */
export function NoSeatCard({ hit, onClose }: { hit: EmployeeHit; onClose: () => void }) {
  const message = presenceMessage(hit.presence);
  return (
    <section className={styles.card} aria-labelledby="noseat-title">
      <button type="button" className={styles.cardClose} aria-label="닫기" onClick={onClose}>
        <CloseIcon size={18} />
      </button>
      <div className={styles.person}>
        <span className={styles.personAvatar} aria-hidden="true">
          <Avatar name={hit.name} photo={hit.photo} size={52} />
        </span>
        <div>
          <h2 id="noseat-title" className={styles.personName}>
            {hit.name} {hit.rank}
            {hit.display_name && <span className={styles.personAlias}>{hit.display_name}</span>}
          </h2>
          <p className={styles.personTeam}>{hit.division ? `${hit.division} ${hit.department}` : hit.department}</p>
          {hit.headline && <p className={styles.personHeadline}>{hit.headline}</p>}
        </div>
      </div>
      <div className={styles.statusBox}>
        {hit.presence ? (
          <strong>
            <span className="mk" data-status={hit.presence.status} aria-hidden="true" />
            {PRESENCE_LABEL[hit.presence.status]}
          </strong>
        ) : (
          <span>{NO_STATUS_LABEL}</span>
        )}
        {message && <span>{message}</span>}
      </div>
      <dl className={styles.facts}>
        <dt>위치</dt>
        <dd>아직 배정된 자리가 없어요</dd>
        <dt>내선</dt>
        <dd className="mono">{hit.extension ?? "—"}</dd>
        <dt>이메일</dt>
        <dd className="mono">{hit.email ? <a href={`mailto:${hit.email}`}>{hit.email}</a> : "—"}</dd>
      </dl>
    </section>
  );
}
