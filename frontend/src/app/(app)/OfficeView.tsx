"use client";

import Link, { useLinkStatus } from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, SparkleIcon } from "@/components/icons";
import type { EmployeeHit, FloorMap, FloorSummary, MyPresenceInfo } from "@/lib/api";
import { useLivePresence, withLiveMine, withLivePresence } from "@/lib/livePresence";
import { useRefreshAt } from "@/lib/useRefreshAt";
import { NO_STATUS_LABEL, PRESENCE_LABEL, STATUS_FILTERS, type StatusFilter } from "@/lib/presence";
import AiPanel from "./AiPanel";
import EmployeeSearch from "./EmployeeSearch";
import FloorPlan, { clampZoom, ZOOM_MAX, ZOOM_MIN, ZOOM_STEPS } from "./FloorPlan";
import MyStatus from "./MyStatus";
import { ScaleLegend } from "./PlanShapes";
import SeatPanel, { NoSeatCard } from "./SeatPanel";
import { useFloorUpdates } from "./useFloorUpdates";
import styles from "./office.module.css";
import { zoneColorVars } from "@/lib/zoneColors";

// 도면(.main)과 오른쪽 패널(.side)의 최소 폭 (office.module.css flex-basis와 같게)
const MAIN_MIN_PX = 560;
const SIDE_MIN_PX = 280;

type Props = {
  floors: FloorSummary[];
  myFloorId: number | null;
  /** 자리가 아직 없을 때 대신 연 우리 팀 층 */
  teamFloorId: number | null;
  myEmpNo: string;
  myPresence: MyPresenceInfo;
  map: FloorMap;
};

/** 화면을 다시 그리지 않고 주소의 물음표 뒤만 바꾼다 (null이면 지운다). Next.js가 useSearchParams에 반영한다 */
/** 층 탭을 누른 뒤 그 층을 받아 오는 동안 탭 아래에 움직이는 줄 (느린 망에서도 눌린 것을 바로 알게) */
function FloorPending() {
  const { pending } = useLinkStatus();
  return <span aria-hidden="true" className={styles.floorPending} data-pending={pending || undefined} />;
}

function replaceQuery(changes: Record<string, string | null>) {
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) url.searchParams.delete(key);
    else url.searchParams.set(key, value);
  }
  if (url.href !== window.location.href) window.history.replaceState(null, "", url);
}

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
  // 화면의 상태가 바뀌는 시각에 다시 읽는다: 재실 상태 자동 해제(알림이 따로 오지 않는다), 회의실 사용 끝·다음 예약 시작, 자정
  useRefreshAt([
    mine?.expires_at,
    ...map.seats.map((s) => s.occupant?.presence?.expires_at),
    ...map.rooms.flatMap((r) => [r.busy_until, r.next_start]),
  ]);

  const floorId = map.floor.id;
  const searchParams = useSearchParams();
  // AI 도우미: 머리글 단추로 연다
  const [aiOpen, setAiOpen] = useState(false);
  // 배율은 층을 바꿀 때마다(뒤로 가기 포함) 100%에서 시작한다 (층마다 도면 크기가 달라 "전체 보기" 배율도 다르다)
  const [zoomState, setZoomState] = useState({ floorId, zoom: 1 });
  if (zoomState.floorId !== floorId) setZoomState({ floorId, zoom: 1 });
  const setZoom = (zoom: number) => setZoomState({ floorId, zoom });
  // 도면 전체가 들어오는 배율. 사람이 많아 책상이 작은 층은 100%에서도 이름이 읽히게 도면이 영역보다 크다
  const [fitZoom, setFitZoom] = useState(1);
  const [pxPerMeter, setPxPerMeter] = useState(0); // 도면 1 m가 지금 몇 px인지 (범례의 축척 막대)
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
  // 팀 칩에 마우스를 올리면 그 구역을 미리 진하게 (누르지 않아도 어느 색이 어디인지 바로 보인다)
  const [hoverZoneId, setHoverZoneId] = useState<number | null>(null);
  const pinnedSeatId = picked.pinned ? selectedSeatId : null;

  const router = useRouter();
  const seatParam = Number(searchParams.get("seat")) || null;
  // 검색에서 고른, 자리가 아직 없는 사람 (오른쪽 패널에 연락처를 보여 준다)
  const [noSeatHit, setNoSeatHit] = useState<EmployeeHit | null>(null);
  const mainRef = useRef<HTMLElement>(null);
  const sideRef = useRef<HTMLDivElement>(null);
  const floorsRef = useRef<HTMLElement>(null);

  /** 오른쪽 패널이 도면 옆이 아니라 아래에 있나 (좁은 화면) */
  const sideIsBelow = useCallback(() => {
    const main = mainRef.current;
    const side = sideRef.current;
    return !!main && !!side && side.offsetTop > main.offsetTop + 8;
  }, []);

  // 본문 폭이 도면(560px)과 패널(280px)을 나란히 둘 만큼 안 되면 패널이 도면 아래로 내려간다 (휴대폰·태블릿 세로).
  // 그때 AI 도우미를 열면 도면 화면 대신 AI 화면만 보인다 (office.module.css .page[data-ai][data-stacked]).
  // 폭으로 정한다: AI 화면에서는 도면이 숨어 있어 패널 자리로는 알 수 없다.
  // 여백은 지금 값이 아니라 평소 값(--body-pad)으로 뺀다. AI 화면은 여백이 0이라 지금 값으로 재면 넓어진 것으로 보여
  // 도면 화면으로 돌아가고, 그러면 다시 좁아져 AI 화면이 되는 것을 되풀이했다 (아이패드 가로에서 AI가 도면 아래로 밀림)
  const bodyRef = useRef<HTMLDivElement>(null);
  const [stacked, setStacked] = useState(false);
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const observer = new ResizeObserver(() => {
      const cs = getComputedStyle(body);
      const inner = body.clientWidth - 2 * (parseFloat(cs.getPropertyValue("--body-pad")) || 0);
      setStacked(inner < MAIN_MIN_PX + SIDE_MIN_PX + parseFloat(cs.columnGap || "0"));
    });
    observer.observe(body);
    return () => observer.disconnect();
  }, []);

  const selectSeat = useCallback(
    (seatId: number | null) => {
      if (seatId !== null) setNoSeatHit(null);
      setPicked((p) => ({
        floorId,
        zoneId: p.floorId === floorId ? p.zoneId : null,
        seatId,
        pinned: seatId !== null && sideIsBelow(),
      }));
    },
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

  // 주소의 ?seat= 는 지금 고른 자리를 따라간다 (새로 고치거나 주소를 보내면 같은 자리가 열린다).
  // 다른 자리를 누르거나 Esc로 풀면 바꾸거나 지운다. 화면을 다시 그리지 않게 주소만 바꾼다
  useEffect(() => {
    const pending = seatParam && fetchedMap.seats.some((s) => s.id === seatParam);
    if (pending && revealedRef.current !== `${floorId}:${seatParam}`) return; // 주소의 자리를 아직 보여 주기 전
    if (seatParam === selectedSeatId) return;
    if (selectedSeatId) revealedRef.current = `${floorId}:${selectedSeatId}`; // 이미 보고 있는 자리라 다시 옮기지 않는다
    replaceQuery({ seat: selectedSeatId ? String(selectedSeatId) : null });
  }, [selectedSeatId, seatParam, floorId, fetchedMap]);

  // 층 버튼 줄이 화면보다 길면 지금 층 버튼이 보이게 옆으로 민다 (페이지는 위아래로 움직이지 않게)
  useEffect(() => {
    const nav = floorsRef.current;
    const current = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !current) return;
    nav.scrollTo({ left: current.offsetLeft - (nav.clientWidth - current.offsetWidth) / 2, behavior: "smooth" });
  }, [floorId]);

  // 층 버튼 줄이 넘치면 양 끝에 ‹ › 를 보여 준다 (아직 안 보이는 층이 있다는 표시이자 넘기는 단추)
  const [floorsMore, setFloorsMore] = useState({ left: false, right: false });
  useEffect(() => {
    const nav = floorsRef.current;
    if (!nav) return;
    const update = () => {
      const left = nav.scrollLeft > 1;
      const right = nav.scrollLeft + nav.clientWidth < nav.scrollWidth - 1;
      setFloorsMore((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
    };
    update();
    nav.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(nav);
    return () => {
      nav.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, []);
  const scrollFloors = (dir: 1 | -1) =>
    floorsRef.current?.scrollBy({ left: dir * floorsRef.current.clientWidth * 0.6, behavior: "smooth" });

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
    if (!hit.seat) {
      // 도면에 보여 줄 곳이 없으니 오른쪽 패널에 연락처를 보여 준다 (패널이 도면 아래면 거기로 내려 보여 준다)
      selectSeat(null);
      setNoSeatHit(hit);
      requestAnimationFrame(() => {
        if (sideIsBelow()) sideRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
      });
      return;
    }
    setNoSeatHit(null);
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

  // 휴대폰: 자리를 누르면 화면 아래 시트가 뜨고, 도면 아래(패널 자리)에도 같은 사람 카드가 있다.
  // 스크롤해서 그 카드가 화면에 들어오면 시트를 숨겨 둘이 겹치지 않게 한다 (다시 도면으로 올라가면 시트가 돌아온다)
  const [sideInView, setSideInView] = useState(false);
  useEffect(() => {
    const side = sideRef.current;
    if (!side || !stacked) return;
    const observer = new IntersectionObserver(([entry]) => setSideInView(entry.isIntersecting));
    observer.observe(side);
    return () => {
      observer.disconnect();
      setSideInView(false);
    };
  }, [stacked]);

  const selectedSeat = map.seats.find((s) => s.id === selectedSeatId) ?? null;
  const personShown = selectedSeat !== null || noSeatHit !== null;
  // AI 도우미를 연 채 자리를 고르거나 사람을 찾으면: 넓은 화면은 AI 아래에 사람 카드를 붙이고(AI가 줄어 둘 다 보인다),
  // 패널이 도면 아래로 내려가는 좁은 화면(AI가 화면 전체)은 그 정보를 AI 대신 보여 준다.
  // AI 대화는 그대로 두고, 자리 선택을 풀면(✕·Esc) 다시 AI만 보인다
  const infoOverAi = aiOpen && stacked && personShown;
  const aiShown = aiOpen && !infoOverAi;
  const cardUnderAi = aiShown && personShown;
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
    <div className={styles.page} data-ai={aiShown || undefined} data-stacked={stacked || undefined}>
      <header className={styles.header}>
        <h1 className={styles.title}>자리·재실 현황</h1>
        <EmployeeSearch onPick={goToPerson} />
        <button
          ref={aiButtonRef}
          type="button"
          className={styles.aiButton}
          aria-expanded={aiShown}
          aria-controls="ai-panel"
          aria-label="AI 도우미"
          onClick={() => {
            if (!aiOpen || infoOverAi) {
              // 보고 있던 사람 카드는 닫고 AI를 앞으로 (카드에 가려 AI가 안 열린 것처럼 보이지 않게)
              selectSeat(null);
              setNoSeatHit(null);
              setAiOpen(true);
            } else setAiOpen(false);
          }}
        >
          <SparkleIcon size={18} />
          <span className={styles.aiButtonText}>AI 도우미</span>
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

      <div ref={bodyRef} className={styles.body}>
        <main ref={mainRef} className={styles.main}>
          <div className={styles.floorsWrap} data-more-left={floorsMore.left} data-more-right={floorsMore.right}>
            {/* 마우스용 넘기기 단추. 키보드는 층 링크를 차례로 지나가면 저절로 보이게 밀린다 */}
            <button
              type="button"
              className={styles.floorsMore}
              data-side="left"
              tabIndex={-1}
              aria-hidden="true"
              onClick={() => scrollFloors(-1)}
            >
              <ChevronLeftIcon size={18} />
            </button>
            <nav ref={floorsRef} aria-label="층 선택" className={styles.floors}>
              {[...floors].reverse().map((floor) => {
                const current = floor.id === floorId;
                // 층 버튼 아래 작은 글씨: 용도(로비 등) 또는 입주 팀. 둘 다 없으면 도면이 없는 층만 알린다
                const caption =
                  floor.description ??
                  (floor.teams.map((t) => t.replace(/팀$/, "")).join("·") || (floor.has_plan ? "" : "도면 없음"));
                return (
                  <Link
                    key={floor.id}
                    href={`/?floor=${floor.id}`}
                    // 층마다 그때의 자리·재실을 서버가 그려야 해서 미리 받아 둘 것이 없다 (미리 받기 요청만 층 수만큼 늘어난다)
                    prefetch={false}
                    className={`${styles.floor} ${current ? styles.floorOn : ""}`}
                    aria-current={current ? "page" : undefined}
                    scroll={false}
                  >
                    <strong className="mono">
                      {floor.name}
                      {floor.id === myFloorId && <span className={styles.mine}>내 자리</span>}
                      {seatless && floor.id === teamFloorId && <span className={styles.mine}>우리 팀</span>}
                    </strong>
                    <span title={caption || undefined}>{caption || "\u00a0"}</span>
                    <FloorPending />
                  </Link>
                );
              })}
            </nav>
            <button
              type="button"
              className={styles.floorsMore}
              data-side="right"
              tabIndex={-1}
              aria-hidden="true"
              onClick={() => scrollFloors(1)}
            >
              <ChevronRightIcon size={18} />
            </button>
          </div>

          <div className={styles.toolbar}>
            <span className={styles.crumb}>
              {map.floor.site.name} › <strong>{map.floor.name}</strong>
            </span>
            {map.zones.length > 0 && <span className={styles.sep} aria-hidden="true" />}
            {/* 도면에는 구역 이름을 쓰지 않는다: 이 칩이 범례. 칩이 도면의 구역과 같은 색·테두리라 색만 보고 안다 */}
            <div role="group" aria-label="팀 구역 (누르면 도면에서 그 구역만 진하게)" className={styles.chips}>
              {map.zones.map((zone) => {
                const on = focusZoneId === zone.id;
                // 한 팀 구역이 이 층에 둘 이상이면 이름이 같다: 구역 기호를 붙여 구분한다
                const twin = map.zones.some((z) => z.id !== zone.id && z.name === zone.name);
                return (
                  <button
                    key={zone.id}
                    type="button"
                    className={`${styles.chip} ${on ? styles.chipOn : ""}`}
                    data-color={zone.color_key}
                    data-shared={zone.department === null}
                    style={zoneColorVars(zone.color_key)}
                    aria-pressed={on}
                    onPointerEnter={(event) => event.pointerType === "mouse" && setHoverZoneId(zone.id)}
                    onPointerLeave={() => setHoverZoneId(null)}
                    onClick={() =>
                      setPicked({ floorId, seatId: selectedSeatId, zoneId: on ? null : zone.id, pinned: picked.pinned })
                    }
                  >
                    {on ? <CheckIcon size={15} /> : <span className={styles.chipSeat} aria-hidden="true" />}
                    {zone.name}
                    {twin && <span className={styles.chipCode}>{zone.code}</span>}
                  </button>
                );
              })}
            </div>
            {map.plan && (
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
              onScale={setPxPerMeter}
              focusZoneId={map.zones.some((z) => z.id === hoverZoneId) ? hoverZoneId : focusZoneId}
              visibleStatuses={visible}
              selectedSeatId={selectedSeatId}
              onSelectSeat={(seatId) => selectSeat(seatId === selectedSeatId ? null : seatId)}
              pinnedSeatId={pinnedSeatId}
              onUnpin={unpin}
              hideSheet={stacked && sideInView}
            />
          </div>

          <div id="floor-legend" tabIndex={-1} className={styles.legend}>
            {hasSeats && (
              <fieldset className={styles.filter}>
                {/* 보이는 이름은 span: Safari는 legend를 옆에 띄우지 않고 한 줄을 따로 차지한다 */}
                <legend className="visually-hidden">표시</legend>
                <span className={styles.filterLabel} aria-hidden="true">
                  표시
                </span>
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
            {map.plan && pxPerMeter > 0 && <ScaleLegend pxPerMeter={pxPerMeter} />}
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

        <div ref={sideRef} className={styles.side} data-ai-card={cardUnderAi || undefined}>
          {aiOpen && <AiPanel onClose={() => setAiOpen(false)} asPage={stacked} hidden={!aiShown} />}
          {(!aiShown || cardUnderAi) && (
            <div className={cardUnderAi ? styles.aiCard : undefined}>
              {noSeatHit && !selectedSeat ? (
                <NoSeatCard hit={noSeatHit} onClose={() => setNoSeatHit(null)} />
              ) : (
                <SeatPanel map={map} seat={selectedSeat} myEmpNo={myEmpNo} onClear={unpin} />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
