"use client";

import { useEffect, useRef, useState } from "react";
import { BuildingIcon, ChevronDownIcon } from "@/components/icons";
import styles from "./SiteFloorPicker.module.css";

type FloorChoice = { id: number; name: string; site: string; site_id: number; note?: string };

/**
 * 사업장 | 층 두 칸 목록 (좌석 배치 편집 옆 칸, 도면 편집 머리줄의 SiteFloorMenu).
 * 왼쪽에서 사업장을 누르면 오른쪽에 그 사업장의 층이 나오고, 층을 누르면 그 층으로 간다.
 * 사업장만 눌러서는 옮기지 않는다 (둘러보다가 다른 사업장의 층을 고르게)
 */
export default function SiteFloorPicker({
  floors,
  value,
  onChange,
}: {
  floors: FloorChoice[];
  value: number;
  onChange: (floorId: number) => void;
}) {
  const current = floors.find((f) => f.id === value) ?? floors[0];
  const sites = [...new Map(floors.map((f) => [f.site_id, f.site])).entries()];
  const [viewSite, setViewSite] = useState(current?.site_id);
  // 다른 곳에서 층이 바뀌면(주소 이동 등) 그 층의 사업장을 다시 보여 준다
  const [shownFor, setShownFor] = useState(value);
  if (shownFor !== value) {
    setShownFor(value);
    setViewSite(current?.site_id);
  }
  if (!current) return null;
  const shownSite = sites.some(([id]) => id === viewSite) ? viewSite : current.site_id;
  const siteFloors = floors.filter((f) => f.site_id === shownSite);
  const shownName = sites.find(([id]) => id === shownSite)?.[1] ?? "";

  return (
    <div className={styles.picker}>
      <div className={styles.col} role="group" aria-label="사업장">
        <span className={styles.colHead} aria-hidden="true">
          사업장
        </span>
        <ul className={styles.list}>
          {sites.map(([id, name]) => (
            <li key={id}>
              <button
                type="button"
                className={`${styles.item} ${styles.siteItem}`}
                aria-pressed={id === shownSite}
                onClick={() => setViewSite(id)}
              >
                <span className={styles.label}>{name}</span>
                <span className={styles.note}>{floors.filter((f) => f.site_id === id).length}개 층</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className={styles.col} role="group" aria-label={`${shownName} 층`}>
        <span className={styles.colHead} aria-hidden="true">
          층
        </span>
        <ul className={styles.list}>
          {siteFloors.map((f) => (
            <li key={f.id}>
              <button
                type="button"
                className={styles.item}
                aria-pressed={f.id === current.id}
                aria-current={f.id === current.id ? "page" : undefined}
                onClick={() => f.id !== current.id && onChange(f.id)}
              >
                <strong className={styles.label}>{f.name}</strong>
                {f.note && <span className={styles.note}>{f.note.replace(/^[\s·(]+|[)\s]+$/g, "")}</span>}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** 머리줄처럼 자리가 좁은 곳: "서울 본사 · 7F ▾" 단추를 누르면 사업장 | 층 목록이 아래로 펼쳐진다 */
export function SiteFloorMenu(props: { floors: FloorChoice[]; value: number; onChange: (floorId: number) => void }) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const current = props.floors.find((f) => f.id === props.value) ?? props.floors[0];

  // 밖을 누르거나 Esc면 닫는다
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !boxRef.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!current) return null;
  return (
    <div ref={boxRef} className={styles.menu}>
      <button
        type="button"
        className={styles.menuButton}
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen((v) => !v)}
      >
        <BuildingIcon size={15} />
        {current.site} · <strong>{current.name}</strong>
        <ChevronDownIcon size={16} />
      </button>
      {open && (
        <div className={styles.menuPanel}>
          <SiteFloorPicker
            {...props}
            onChange={(id) => {
              setOpen(false);
              props.onChange(id);
            }}
          />
        </div>
      )}
    </div>
  );
}
