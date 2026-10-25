"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Admin, PlanEditorData } from "@/lib/api";
import { adminExpiredUrl } from "@/lib/loginRedirect";
import ui from "../seating/seating.module.css";
import DraftEditor from "./DraftEditor";
import ScheduledView from "./ScheduledView";
import StartScreen from "./StartScreen";

type Toast = { text: string; tone?: "error" } | null;
type Props = { admin: Admin; initial: PlanEditorData; notice: string | null };

/** ⑥ 도면 편집: 층마다 초안 하나를 그려 고치고, 점검한 뒤 게시한다. 초안은 게시 전까지 직원 화면에 보이지 않는다 */
export default function PlanEditor({ admin, initial, notice }: Props) {
  const router = useRouter();
  const [data, setData] = useState(initial);
  const [toast, setToast] = useState<Toast>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const floorId = data.floor.id;

  const showToast = useCallback((text: string, tone?: "error") => {
    clearTimeout(toastTimer.current);
    setToast({ text, tone });
    toastTimer.current = setTimeout(() => setToast(null), tone === "error" ? 6000 : 4500);
  }, []);
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  const reload = useCallback(async (): Promise<PlanEditorData | null> => {
    const res = await fetch(`/api/admin/floors/${floorId}/plan`, { cache: "no-store" }).catch(() => null);
    if (res?.status === 401) {
      router.replace(adminExpiredUrl());
      return null;
    }
    if (!res?.ok) return null;
    const fresh = (await res.json()) as PlanEditorData;
    setData(fresh);
    return fresh;
  }, [floorId, router]);

  const goFloor = useCallback((id: number) => router.push(`/admin/plans?floor=${id}`), [router]);

  return (
    <main className={ui.page}>
      {data.draft?.status === "SCHEDULED" ? (
        <ScheduledView
          key={`scheduled-${data.draft.id}`}
          admin={admin}
          data={data}
          setData={setData}
          reload={reload}
          showToast={showToast}
          goFloor={goFloor}
          notice={notice}
        />
      ) : data.draft ? (
        <DraftEditor
          key={data.draft.id}
          admin={admin}
          data={data}
          setData={setData}
          reload={reload}
          showToast={showToast}
          goFloor={goFloor}
          notice={notice}
        />
      ) : (
        <StartScreen
          admin={admin}
          data={data}
          setData={setData}
          reload={reload}
          showToast={showToast}
          goFloor={goFloor}
          notice={notice}
        />
      )}
      {toast && (
        <div className={ui.toast} role={toast.tone === "error" ? "alert" : "status"} data-tone={toast.tone}>
          {toast.text}
        </div>
      )}
    </main>
  );
}
