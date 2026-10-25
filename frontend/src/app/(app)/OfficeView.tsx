"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SparkleIcon } from "@/components/icons";
import type { EmployeeHit, FloorMap, FloorSummary, MyPresenceInfo } from "@/lib/api";
import { useLivePresence, useRefreshAtExpiry, withLiveMine, withLivePresence } from "@/lib/livePresence";
import { NO_STATUS_LABEL, PRESENCE_LABEL, STATUS_FILTERS, type StatusFilter } from "@/lib/presence";
import AiPanel from "./AiPanel";
import EmployeeSearch from "./EmployeeSearch";
import FloorPlan, { clampZoom, ZOOM_MAX, ZOOM_MIN, ZOOM_STEPS } from "./FloorPlan";
import MyStatus from "./MyStatus";
import SeatPanel from "./SeatPanel";
import { useFloorUpdates } from "./useFloorUpdates";
import styles from "./office.module.css";

type Props = {
  floors: FloorSummary[];
  myFloorId: number | null;
  /** 자리가 아직 없을 때 대신 연 우리 팀 층 */
  teamFloorId: number | null;
  myEmpNo: string;
  myPresence: MyPresenceInfo;
  map: FloorMap;
};

/** − / + 버튼: 지금 배율 다음(앞) 단계로. min: 가장 작은 배율 ("전체 보기"가 0.5보다 작으면 그만큼) */
const stepZoom = (zoom: number, dir: 1 | -1, min: number) =>
  dir > 0
    ? (ZOOM_STEPS.find((z) => z > zoom + 0.001) ?? ZOOM_MAX)
    : ([...ZOOM_STEPS].reverse().find((z) => z < zoom - 0.001 && z >= min - 0.001) ?? min);

export default function OfficeView({ floors, myFloorId, teamFloorId, myEmpNo, myPresence, map: fetchedMap }: Props) {
  // 관리자가 자리 배치를 바꾸거나 도면을 게시하면 다시 읽고 알려 준다
  const updates = useFloorUpdates(fetchedMap, myEmpNo);
  // 다른 사람이 상태를 바꾸면 새로고침 없이 바로 반영한다 (같은 연결로 배치 변경도 온다)
  const live = useLivePresence(updates.onFloor);
  const map = useMemo(() => withLivePresence(fetchedMap, live), [fetchedMap, live]);
  const mine = withLiveMine(myPresence.presence, live.get(myEmpNo), fetchedMap.fetched_at);
  useRefreshAtExpiry([mine?.expires_at, ...map.seats.map((s) => s.occupant?.presence?.expires_at)]);

  const floorId = map.floor.id;
  const [aiOpen, setAiOpen] = useState(false);
  // 배율은 층마다 100%에서 시작한다 (층마다 도면 크기가 달라 "전체 보기" 배율도 다르다)
  const [zoomState, setZoomState] = useState({ floorId, zoom: 1 });
  const setZoom = (zoom: number) => setZoomState({ floorId, zoom });
  // 도면 전체가 들어오는 배율. 사람이 많아 책상이 작은 층은 100%에서도 이름이 읽히게 도면이 영역보다 크다
  const [fitZoom, setFitZoom] = useState(1);
  const minZoom = Math.min(ZOOM_MIN, fitZoom);
  const zoom = clampZoom(zoomState.floorId === floorId ? zoomState.zoom : 1, minZoom);
  const [visible, setVisible] = useState<Set<StatusFilter>>(() => new Set(STATUS_FILTERS));
  const filtering = visible.size < STATUS_FILTERS.length;
  // 층을 바꾸면 고른 자리·강조한 팀은 의미가 없어서, 어느 층에서 고른 것인지 같이 기억한다.
  // pinned: 오른쪽 패널이 도면 아래로 내려간 좁은 화면에서는 자리 옆에 정보 카드를 고정해 띄운다
  const [picked, setPicked] = useState<{
    floorId: number;
    seatId: number | null;
    zoneId: number | null;
    pinned: boolean;
  }>({
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
  const floorsRef = useRef<HTMLElement>(null);

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

  // 층 버튼 줄이 화면보다 길면 지금 층 버튼이 보이게 옆으로 민다 (페이지는 위아래로 움직이지 않게)
  useEffect(() => {
    const nav = floorsRef.current;
    const current = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !current) return;
    nav.scrollTo({ left: current.offsetLeft - (nav.clientWidth - current.offsetWidth) / 2, behavior: "smooth" });
  }, [floorId]);

  // 오른쪽 패널에 고른 자리는 Esc로 해제한다 (입력 칸·팝업 안에서 누른 Esc는 그쪽이 처리)
  useEffect(() => {
    if (selectedSeatId === null || pinnedSeatId !== null) return;
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as Element;
      if (event.key !== "Escape" || target.closest("input, textarea, [role=dialog], [role=listbox]")) return;
      selectSeat(null);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [selectedSeatId, pinnedSeatId, selectSeat]);

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
  const hasSeats = map.seats.length > 0;
  const seatless = myFloorId === null;

  function toggleStatus(status: StatusFilter) {
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
          aria-label="AI 도우미 (준비 중)"
          onClick={() => setAiOpen((open) => !open)}
        >
          <SparkleIcon size={18} />
          <span className={styles.aiButtonText}>AI 도우미</span>
          <span className={styles.aiSoon}>준비 중</span>
        </button>
        <MyStatus info={{ ...myPresence, presence: mine }} />
      </header>

      {updates.planCountdown !== null && (
        <p className={styles.planBanner} role="status">
          {map.floor.name} 도면이 새로 게시됐어요 · {updates.planCountdown}초 뒤 새 도면으로 보여 드려요
          <button type="button" onClick={updates.showPlanNow}>
            지금 보기
          </button>
        </p>
      )}

      {seatless && (
        <p className={styles.seatless} role="status">
          아직 배정된 자리가 없어요. {teamFloorId === floorId ? "우리 팀 구역이 있는 층을 먼저 보여 드려요. " : ""}
          자리가 정해지면 이 화면이 내 자리가 있는 층으로 열립니다.
        </p>
      )}

      <div className={styles.body}>
        <main ref={mainRef} className={styles.main}>
          <nav ref={floorsRef} aria-label="층 선택" className={styles.floors}>
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
                    {seatless && floor.id === teamFloorId && <span className={styles.mine}>우리 팀</span>}
                  </strong>
                  <span>
                    {floor.description ?? (floor.teams.map((t) => t.replace(/팀$/, "")).join("·") || "공용 공간")}
                  </span>
                </Link>
              );
            })}
          </nav>

          <div className={styles.toolbar}>
            <span className={styles.crumb}>
              {map.floor.site.name} › <strong>{map.floor.name}</strong>
            </span>
            {map.zones.length > 0 && <span className={styles.sep} aria-hidden="true" />}
            <div role="group" aria-label="팀 구역 강조" className={styles.chips}>
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
            {hasSeats && (
              <div role="group" aria-label="도면 크기" className={styles.zoom}>
                <button
                  type="button"
                  aria-label="축소"
                  disabled={zoom <= minZoom + 0.001}
                  onClick={() => setZoom(clampZoom(stepZoom(zoom, -1, minZoom), minZoom))}
                >
                  −
                </button>
                <button
                  type="button"
                  aria-label={`기본 크기로 (지금 ${Math.round(zoom * 100)}%)`}
                  title={fitZoom < 0.999 ? "기본 크기 (이름이 읽히는 크기)" : "화면 폭에 맞추기"}
                  onClick={() => setZoom(1)}
                >
                  {Math.abs(zoom - 1) < 0.001 && fitZoom >= 0.999 ? (
                    "맞춤"
                  ) : (
                    <span className="mono">{Math.round(zoom * 100)}%</span>
                  )}
                </button>
                <button
                  type="button"
                  aria-label="확대"
                  disabled={zoom >= ZOOM_MAX - 0.001}
                  onClick={() => setZoom(clampZoom(stepZoom(zoom, 1, minZoom), minZoom))}
                >
                  +
                </button>
                {fitZoom < 0.999 && (
                  <button
                    type="button"
                    className={styles.zoomAll}
                    aria-pressed={Math.abs(zoom - fitZoom) < 0.005}
                    title="층 전체를 한 화면에 (이름은 작아지거나 숨겨져요)"
                    onClick={() => setZoom(fitZoom)}
                  >
                    전체 보기
                  </button>
                )}
              </div>
            )}
          </div>

          {filtering && (
            <p className={styles.filterNotice} role="status">
              재실 상태 필터 적용 중 · 고르지 않은 상태의 자리는 흐리게 보여요.
              <button type="button" onClick={() => setVisible(new Set(STATUS_FILTERS))}>
                모두 보기
              </button>
            </p>
          )}

          {hasSeats && (
            <a href="#floor-legend" className={styles.skip}>
              도면 건너뛰기
            </a>
          )}
          <div className={styles.planCard}>
            <FloorPlan
              map={map}
              myEmpNo={myEmpNo}
              zoom={zoom}
              onZoomChange={setZoom}
              onFitZoom={setFitZoom}
              focusZoneId={focusZoneId}
              visibleStatuses={visible}
              selectedSeatId={selectedSeatId}
              onSelectSeat={(seatId) => selectSeat(seatId === selectedSeatId ? null : seatId)}
              pinnedSeatId={pinnedSeatId}
              onUnpin={unpin}
            />
          </div>

          <div id="floor-legend" tabIndex={-1} className={styles.legend}>
            {hasSeats && (
              <fieldset className={styles.filter}>
                <legend>표시</legend>
                {STATUS_FILTERS.map((status) => (
                  <label key={status}>
                    <input type="checkbox" checked={visible.has(status)} onChange={() => toggleStatus(status)} />
                    {status === "NONE" ? (
                      <span className={styles.noStatusMark} aria-hidden="true" />
                    ) : (
                      <span className="mk" data-status={status} aria-hidden="true" />
                    )}
                    {status === "NONE" ? NO_STATUS_LABEL : PRESENCE_LABEL[status]}
                  </label>
                ))}
              </fieldset>
            )}
            <span className={styles.hatchLegend}>
              <span className={styles.hatchSample} aria-hidden="true" />
              빗금 = 출입 제한·공용 설비
            </span>
            {hasSeats && (
              <span className={styles.hint}>
                <span className={styles.hintMouse}>
                  Ctrl+휠(트랙패드 핀치)로 확대 · 확대하면 끌어서 이동 · 자리에 마우스를 올리면 정보 카드
                </span>
                <span className={styles.hintTouch}>두 손가락으로 확대 · 밀어서 이동 · 자리를 누르면 정보</span>
              </span>
            )}
          </div>
        </main>

        <div className={styles.liveNotices} aria-live="polite">
          {updates.seatNotice && <p className={styles.liveNotice}>{updates.seatNotice.text}</p>}
          {updates.mineNotice && (
            <p className={styles.liveNotice} data-mine="true">
              {updates.mineNotice.text}
              {updates.mineNotice.href && (
                <Link href={updates.mineNotice.href} scroll={false} onClick={updates.dismissMine}>
                  보기
                </Link>
              )}
              <button type="button" aria-label="안내 닫기" onClick={updates.dismissMine}>
                ×
              </button>
            </p>
          )}
        </div>

        <div ref={sideRef} className={styles.side}>
          {aiOpen ? (
            <AiPanel onClose={() => setAiOpen(false)} />
          ) : (
            <SeatPanel map={map} seat={selectedSeat} myEmpNo={myEmpNo} onClear={unpin} />
          )}
        </div>
      </div>
    </div>
  );
}
