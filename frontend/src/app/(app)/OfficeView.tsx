"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { SparkleIcon } from "@/components/icons";
import type { FloorMap, FloorSummary, MyPresence, PresenceStatus } from "@/lib/api";
import { PRESENCE_LABEL, PRESENCE_ORDER } from "@/lib/presence";
import AiPanel from "./AiPanel";
import FloorPlan, { clampZoom, ZOOM_MAX, ZOOM_MIN } from "./FloorPlan";
import MyStatus from "./MyStatus";
import SeatPanel from "./SeatPanel";
import styles from "./office.module.css";

const ZOOM_STEP = 1.25; // − / + 버튼 한 번에 바뀌는 배율

type Props = {
  floors: FloorSummary[];
  myFloorId: number | null;
  myPresence: MyPresence;
  map: FloorMap;
};

export default function OfficeView({ floors, myFloorId, myPresence, map }: Props) {
  const floorId = map.floor.id;
  const [aiOpen, setAiOpen] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [visible, setVisible] = useState<Set<PresenceStatus>>(() => new Set(PRESENCE_ORDER));
  // 층을 바꾸면 고른 자리·강조한 팀은 의미가 없어서, 어느 층에서 고른 것인지 같이 기억한다
  const [picked, setPicked] = useState<{ floorId: number; seatId: number | null; zoneId: number | null }>({
    floorId,
    seatId: null,
    zoneId: null,
  });
  const selectedSeatId = picked.floorId === floorId ? picked.seatId : null;
  const focusZoneId = picked.floorId === floorId ? picked.zoneId : null;

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
        <MyStatus presence={myPresence} />
      </header>

      <div className={styles.body}>
        <main className={styles.main}>
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
                    onClick={() => setPicked({ floorId, seatId: selectedSeatId, zoneId: on ? null : zone.id })}
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
              onSelectSeat={(seatId) =>
                setPicked({ floorId, zoneId: focusZoneId, seatId: seatId === selectedSeatId ? null : seatId })
              }
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
              트랙패드 핀치(Ctrl+휠)로 확대·축소 · 팀 칩을 누르면 그 팀만 강조 · 자리를 누르면 오른쪽에 정보
            </span>
          </div>
        </main>

        <div className={styles.side}>
          {aiOpen ? (
            <AiPanel onClose={() => setAiOpen(false)} />
          ) : (
            <SeatPanel
              map={map}
              seat={selectedSeat}
              onClear={() => setPicked({ floorId, zoneId: focusZoneId, seatId: null })}
            />
          )}
        </div>
      </div>
    </div>
  );
}
