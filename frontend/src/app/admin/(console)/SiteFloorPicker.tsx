"use client";

import { BuildingIcon } from "@/components/icons";
import styles from "./SiteFloorPicker.module.css";

type FloorChoice = { id: number; name: string; site: string; site_id: number; note?: string };

/**
 * 사업장(서울 본사 · 분당 센터 …)을 먼저 고르고, 그 오른쪽에서 그 사업장의 층을 고른다 (도면 편집·좌석 배치 편집).
 * 사업장은 서로 떨어진 버튼이라 다른 사업장의 층이 한 목록에 섞이지 않는다. 사업장을 바꾸면 그 사업장의 첫 층을 연다.
 * 사업장이 하나뿐이면 층만 고른다.
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
  const siteFloors = floors.filter((f) => f.site_id === current?.site_id);
  if (!current) return null;
  return (
    <div className={styles.picker}>
      {sites.length > 1 && (
        <div className={styles.sites} role="group" aria-label="사업장">
          {sites.map(([id, name]) => (
            <button
              key={id}
              type="button"
              className={styles.site}
              aria-pressed={id === current.site_id}
              onClick={() => {
                const first = floors.find((f) => f.site_id === id);
                if (first && id !== current.site_id) onChange(first.id);
              }}
            >
              <BuildingIcon size={15} />
              {name}
            </button>
          ))}
        </div>
      )}
      {siteFloors.length > 1 ? (
        <select
          className={styles.floor}
          aria-label={`${current.site} 층 고르기`}
          value={current.id}
          onChange={(e) => onChange(Number(e.target.value))}
        >
          {siteFloors.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
              {f.note ?? ""}
            </option>
          ))}
        </select>
      ) : (
        <span className={styles.only}>
          {current.name}
          {current.note ?? ""}
        </span>
      )}
    </div>
  );
}
