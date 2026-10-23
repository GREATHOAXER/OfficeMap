"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SparkleIcon } from "@/components/icons";
import type { EmployeeHit, FloorMap, FloorSummary, MyPresence, PresenceStatus } from "@/lib/api";
import { useLivePresence, useRefreshAtExpiry, withLiveMine, withLivePresence } from "@/lib/livePresence";
import { PRESENCE_LABEL, PRESENCE_ORDER } from "@/lib/presence";
import AiPanel from "./AiPanel";
import EmployeeSearch from "./EmployeeSearch";
import FloorPlan, { clampZoom, ZOOM_MAX, ZOOM_MIN } from "./FloorPlan";
import MyStatus from "./MyStatus";
import SeatPanel from "./SeatPanel";
import styles from "./office.module.css";

const ZOOM_STEP = 1.25; // − / + 버튼 한 번에 바뀌는 배율

type Props = {
  floors: FloorSummary[];
  myFloorId: number | null;
  myEmpNo: string;
  myPresence: MyPresence;
  map: FloorMap;
};

export default function OfficeView({ floors, myFloorId, myEmpNo, myPresence, map: fetchedMap }: Props) {
  // 다른 사람이 상태를 바꾸면 새로고침 없이 바로 반영한다
  const live = useLivePresence();
  const map = useMemo(() => withLivePresence(fetchedMap, live), [fetchedMap, live]);
  const mine = withLiveMine(myPresence, live.get(myEmpNo), fetchedMap.fetched_at);
  useRefreshAtExpiry(map, mine);

  const floorId = map.floor.id;
  const [aiOpen, setAiOpen] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [visible, setVisible] = useState<Set<PresenceStatus>>(() => new Set(PRESENCE_ORDER));
  // 층을 바꾸면 고른 자리·강조한 팀은 의미가 없어서, 어느 층에서 고른 것인지 같이 기억한다.
  // pinned: 오른쪽 패널이 도면 아래로 내려간 좁은 화면에서는 자리 옆에 정보 카드를 고정해 띄운다
  const [picked, setPicked] = useState<{ floorId: number; seatId: number | null; zoneId: number | null; pinned: boolean }>({
    floorId,
    seatId: null,
    zoneId: null,
    pinned: false,
  });
  const selectedSeatId = picked.floorId === floorId ? picked.seatId : null;
  const focusZoneId = picked.floorId === floorId ? picked.zoneId : null;
  const pinnedSeatId = picked.pinned ? selectedSeatId : null;

  const router = useRouter();
  const seatParam = Number(useSearchParams().get("seat")) || null;
  const mainRef = useRef<HTMLElement>(null);
  const sideRef = useRef<HTMLDivElement>(null);

  /** 오른쪽 패널이 도면 옆이 아니라 아래에 있나 (좁은 화면) */
  const sideIsBelow = useCallback(() => {
    const main = mainRef.current;
    const side = sideRef.current;
    return !!main && !!side && side.offsetTop > main.offsetTop + 8;
  }, []);

  const selectSeat = useCallback(
    (seatId: number | null) =>
      setPicked((p) => ({
        floorId,
        zoneId: p.floorId === floorId ? p.zoneId : null,
        seatId,
        pinned: seatId !== null && sideIsBelow(),
      })),
    [floorId, sideIsBelow],
  );
  const unpin = useCallback(() => selectSeat(null), [selectSeat]);

  /** 자리를 골라서 도면 가운데로 가져온다 (검색, ?seat= 주소) */
  const revealSeat = useCallback(
    (seatId: number) => {
      selectSeat(seatId);
      document
        .querySelector(`[data-seat-id="${seatId}"]`)
        ?.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
    },
    [selectSeat],
  );

  // 주소에 ?seat=자리ID 가 있으면 그 자리를 보여 준다 (다른 층 사람을 검색해서 넘어왔을 때).
  // 새 층이 그려진 다음 프레임에 옮기고, 데이터를 다시 읽을 때마다 다시 옮기지 않게 한 번만 한다
  const revealedRef = useRef<string | null>(null);
  useEffect(() => {
    const key = `${floorId}:${seatParam}`;
    if (!seatParam || revealedRef.current === key || !fetchedMap.seats.some((s) => s.id === seatParam)) return;
    const frame = requestAnimationFrame(() => {
      revealedRef.current = key;
      revealSeat(seatParam);
    });
    return () => cancelAnimationFrame(frame);
  }, [seatParam, floorId, fetchedMap, revealSeat]);

  function goToPerson(hit: EmployeeHit) {
    if (!hit.seat) return;
    if (hit.seat.floor_id === floorId) revealSeat(hit.seat.id);
    else router.push(`/?floor=${hit.seat.floor_id}&seat=${hit.seat.id}`, { scroll: false });
  }

  const aiButtonRef = useRef<HTMLButtonElement>(null);
  const wasAiOpen = useRef(false);
  // AI 패널을 닫으면 여는 버튼으로 포커스를 돌려준다
  useEffect(() => {
    if (wasAiOpen.current && !aiOpen) aiButtonRef.current?.focus();
    wasAiOpen.current = aiOpen;
  }, [aiOpen]);

  const selectedSeat = map.seats.find((s) => s.id === selectedSeatId) ?? null;

  function toggleStatus(status: PresenceStatus) {
    setVisible((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>자리·재실 현황</h1>
        <EmployeeSearch onPick={goToPerson} />
        <button
          ref={aiButtonRef}
          type="button"
          className={styles.aiButton}
          aria-expanded={aiOpen}
          aria-controls="ai-panel"
          onClick={() => setAiOpen((open) => !open)}
        >
          <SparkleIcon size={18} />
          AI에게 묻기
        </button>
        <MyStatus presence={mine} />
      </header>

      <div className={styles.body}>
        <main ref={mainRef} className={styles.main}>
          <nav aria-label="층 선택" className={styles.floors}>
            {[...floors].reverse().map((floor) => {
              const current = floor.id === floorId;
              return (
                <Link
                  key={floor.id}
                  href={`/?floor=${floor.id}`}
                  className={`${styles.floor} ${current ? styles.floorOn : ""}`}
                  aria-current={current ? "page" : undefined}
                  scroll={false}
                >
                  <strong className="mono">
                    {floor.name}
                    {floor.id === myFloorId && <span className={styles.mine}>내 자리</span>}
                  </strong>
                  <span>{floor.description ?? (floor.teams.map((t) => t.replace(/팀$/, "")).join("·") || "공용 공간")}</span>
                </Link>
              );
            })}
          </nav>

          <div className={styles.toolbar}>
            <span className={styles.crumb}>
              {map.floor.site.name} › <strong>{map.floor.name}</strong>
            </span>
            <span className={styles.sep} aria-hidden="true" />
            <div role="group" aria-label="팀 강조" className={styles.chips}>
              {map.zones.map((zone) => {
                const on = focusZoneId === zone.id;
                return (
                  <button
                    key={zone.id}
                    type="button"
                    className={`${styles.chip} ${on ? styles.chipOn : ""}`}
                    data-color={zone.color_key}
                    aria-pressed={on}
                    onClick={() =>
                      setPicked({ floorId, seatId: selectedSeatId, zoneId: on ? null : zone.id, pinned: picked.pinned })
                    }
                  >
                    <span className={styles.swatch} aria-hidden="true" />
                    {zone.name}
                  </button>
                );
              })}
            </div>
            <div role="group" aria-label="도면 크기" className={styles.zoom}>
              <button
                type="button"
                aria-label="축소"
                disabled={zoom <= ZOOM_MIN + 0.001}
                onClick={() => setZoom(clampZoom(zoom / ZOOM_STEP))}
              >
                −
              </button>
              <button type="button" className="mono" aria-label="화면에 맞춤" onClick={() => setZoom(1)}>
                {Math.round(zoom * 100)}%
              </button>
              <button
                type="button"
                aria-label="확대"
                disabled={zoom >= ZOOM_MAX - 0.001}
                onClick={() => setZoom(clampZoom(zoom * ZOOM_STEP))}
              >
                +
              </button>
            </div>
          </div>

          <div className={styles.planCard}>
            <FloorPlan
              map={map}
              zoom={zoom}
              onZoomChange={setZoom}
              focusZoneId={focusZoneId}
              visibleStatuses={visible}
              selectedSeatId={selectedSeatId}
              onSelectSeat={(seatId) => selectSeat(seatId === selectedSeatId ? null : seatId)}
              pinnedSeatId={pinnedSeatId}
              onUnpin={unpin}
            />
          </div>

          <div className={styles.legend}>
            <fieldset className={styles.filter}>
              <legend>표시</legend>
              {PRESENCE_ORDER.map((status) => (
                <label key={status}>
                  <input type="checkbox" checked={visible.has(status)} onChange={() => toggleStatus(status)} />
                  <span className="mk" data-status={status} aria-hidden="true" />
                  {PRESENCE_LABEL[status]}
                </label>
              ))}
            </fieldset>
            <span className={styles.chairLegend}>
              <span className={styles.chairSample} aria-hidden="true">
                <span />
              </span>
              반원 = 의자 (앉는 쪽)
            </span>
            <span className={styles.hint}>
              트랙패드 핀치(Ctrl+휠)로 확대·축소 · 확대하면 끌어서 이동 · 자리에 마우스를 올리면 정보 카드
            </span>
          </div>
        </main>

        <div ref={sideRef} className={styles.side}>
          {aiOpen ? (
            <AiPanel onClose={() => setAiOpen(false)} />
          ) : (
            <SeatPanel
              map={map}
              seat={selectedSeat}
              onClear={unpin}
            />
          )}
        </div>
      </div>
    </div>
  );
}
