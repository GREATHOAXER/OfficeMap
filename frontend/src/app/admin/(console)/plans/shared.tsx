"use client";

import Link from "next/link";
import { type ReactNode, useEffect, useRef } from "react";
import type { Admin, FloorEvent, PlanEditorData } from "@/lib/api";
import ui from "../seating/seating.module.css";

// 도면 편집 화면들(시작·초안 편집·게시 예약)이 같이 쓰는 것

export const EXPIRED = "/admin/login?reason=expired&next=/admin/plans";
export const json = { "content-type": "application/json" };

export type ScreenProps = {
  admin: Admin;
  data: PlanEditorData;
  setData: (d: PlanEditorData) => void;
  reload: () => Promise<PlanEditorData | null>;
  showToast: (text: string, tone?: "error") => void;
  goFloor: (id: number) => void;
  notice: string | null;
};

export function Header({
  admin,
  data,
  goFloor,
  status,
  children,
}: {
  admin: Admin;
  data: PlanEditorData;
  goFloor: (id: number) => void;
  status?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className={ui.header}>
      <div className={ui.titleRow}>
        <h1 className={ui.title}>도면 편집</h1>
        <span className={ui.roleChip}>
          <strong>{admin.role_label}</strong> · {data.floor.site.name} {data.floor.name}
        </span>
        {data.floors.length > 1 && (
          <select
            className={ui.select}
            style={{ width: "auto", height: 32 }}
            aria-label="층 고르기"
            value={data.floor.id}
            onChange={(e) => goFloor(Number(e.target.value))}
          >
            {data.floors.map((f) => (
              <option key={f.id} value={f.id}>
                {f.site} {f.name}
                {f.drafting ? " · 초안 있음" : !f.published ? " · 도면 없음" : ""}
              </option>
            ))}
          </select>
        )}
        {status}
      </div>
      <div className={ui.headerActions}>
        <Link className={ui.btn} href={`/admin/seating?floor=${data.floor.id}`}>
          좌석 배치로 →
        </Link>
        {children}
      </div>
    </header>
  );
}

/** 이 층에 게시·좌석 변경이 생기면 (조금 모았다가) 다시 읽는다. 관리자 화면 알림(/api/admin/stream)을 쓴다 */
export function useFloorChanges(floorId: number, onChange: () => unknown) {
  const latest = useRef(onChange);
  useEffect(() => {
    latest.current = onChange;
  });
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const source = new EventSource("/api/admin/stream");
    source.addEventListener("floor", (event) => {
      const change = JSON.parse((event as MessageEvent<string>).data) as FloorEvent;
      if (change.floor_id !== floorId || change.kind === "requests") return;
      clearTimeout(timer);
      timer = setTimeout(() => void latest.current(), 500);
    });
    return () => {
      clearTimeout(timer);
      source.close();
    };
  }, [floorId]);
}
