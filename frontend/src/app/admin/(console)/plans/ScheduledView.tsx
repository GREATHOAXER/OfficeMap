"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { PlanEditorData, PublishCheck } from "@/lib/api";
import { shortDate } from "@/lib/dates";
import { problemsOf } from "@/lib/planGeometry";
import { adminExpiredUrl } from "@/lib/loginRedirect";
import ui from "../seating/seating.module.css";
import PlanCanvas, { ZoomControls } from "./PlanCanvas";
import PlanPanel from "./PlanPanel";
import { Header, type ScreenProps, useFloorChanges } from "./shared";
import styles from "./plans.module.css";

// 게시 예약 --------------------------------------------------------------------

/** 게시를 예약한 초안: 고칠 수 없고 보기만. 예약을 취소하면 다시 초안이 된다 */
export default function ScheduledView({ admin, data, setData, reload, showToast, goFloor, notice }: ScreenProps) {
  const router = useRouter();
  const draft = data.draft!;
  const { width_m: width, height_m: height } = data.size;
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [zoom, setZoom] = useState(1);
  const [busy, setBusy] = useState(false);
  const [check, setCheck] = useState<PublishCheck | null>(null);
  useFloorChanges(data.floor.id, reload);

  useEffect(() => {
    let alive = true;
    void fetch(`/api/admin/plans/${draft.id}/check`)
      .then((res) => (res.ok ? (res.json() as Promise<PublishCheck>) : null))
      .then((c) => alive && setCheck(c))
      .catch(() => null);
    return () => {
      alive = false;
    };
  }, [draft.id, draft.revision]);

  async function unschedule() {
    setBusy(true);
    const res = await fetch(`/api/admin/plans/${draft.id}/unschedule`, { method: "POST" }).catch(() => null);
    setBusy(false);
    if (res?.status === 401) {
      router.replace(adminExpiredUrl());
      return;
    }
    if (!res?.ok) {
      showToast("예약을 취소하지 못했어요. 이미 게시됐는지 확인하세요", "error");
      await reload();
      return;
    }
    setData((await res.json()) as PlanEditorData);
    showToast("게시 예약을 취소했어요. 다시 고칠 수 있어요");
  }

  const codeOf = new Map(
    draft.geometry.elements.flatMap((el) => (el.type === "desk_group" ? el.cells.map((c) => [c.id, c.code]) : [])),
  );
  const roomNameOf = new Map(
    draft.geometry.elements.flatMap((el) => (el.type === "room" ? [[el.id, el.name] as const] : [])),
  );
  const chosen = new Map((draft.options?.people ?? []).map((p) => [p.emp_no, p.to_key]));
  const roomChoice = new Map((draft.options?.rooms ?? []).map((r) => [r.room_id, r]));
  const problems = problemsOf(draft.geometry, width, height);
  const when = draft.effective_at ? `${shortDate(draft.effective_at)} 0시` : "";

  return (
    <>
      <Header
        admin={admin}
        data={data}
        goFloor={goFloor}
        status={
          <span className={ui.status} role="status">
            초안 v{draft.version} · 게시 예약 {when}
          </span>
        }
      >
        <button type="button" className={`${ui.btn} ${ui.pri}`} disabled={busy} onClick={() => void unschedule()}>
          예약 취소하고 고치기
        </button>
      </Header>
      <p className={styles.banner} role="status">
        이 도면은 {when}에 게시돼요{draft.scheduled_by ? ` (${draft.scheduled_by} 님이 예약)` : ""}. 그때까지 직원
        화면은 지금 도면 그대로이고, 이 초안은 고칠 수 없어요.
      </p>
      {notice && <p className={ui.notice}>{notice}</p>}
      <div className={`${ui.body} ${styles.body}`} data-cols={2}>
        <div className={ui.center}>
          <div className={ui.toolbar}>
            <span className={styles.coords}>
              {width} × {height} m
            </span>
            <ZoomControls zoom={zoom} onZoom={setZoom} />
          </div>
          <div className={ui.canvasCard}>
            <PlanCanvas
              geometry={draft.geometry}
              width={width}
              height={height}
              zoom={zoom}
              onZoom={setZoom}
              tool="select"
              snap
              readOnly
              selectedIds={selectedIds}
              live={data.live}
              problemIds={new Set(problems.map((p) => p.elementId))}
              showDims={false}
              onSelect={setSelectedIds}
              onDraw={() => undefined}
              onDrawLine={() => undefined}
              onPlaceDesk={() => undefined}
              onChange={() => undefined}
              onCursor={() => undefined}
            />
          </div>
        </div>
        <aside className={ui.right}>
          <section className={`${ui.card} ${ui.selected}`} aria-labelledby="scheduled-title">
            <h2 id="scheduled-title" className={ui.cardTitle}>
              게시 예약 · {when}
            </h2>
            <dl className={styles.stats}>
              <dt>예약한 사람</dt>
              <dd>{draft.scheduled_by ?? "—"}</dd>
              <dt>메모</dt>
              <dd>{draft.note ?? "—"}</dd>
              {check && (
                <>
                  <dt>좌석</dt>
                  <dd>
                    {check.summary.seats_before} → {check.summary.seats_after}석
                  </dd>
                </>
              )}
            </dl>
          </section>
          {check && check.people.length > 0 && (
            <section className={ui.card} aria-labelledby="scheduled-people">
              <h2 id="scheduled-people" className={ui.cardTitle}>
                그날 책상이 없어지는 사람 (지금 기준)
              </h2>
              <ul className={styles.problemList}>
                {check.people.map((p) => {
                  const key = chosen.get(p.emp_no);
                  return (
                    <li key={p.emp_no} className={ui.hint}>
                      {p.name} {p.rank} · {p.seat_code} → {key ? (codeOf.get(key) ?? "새 자리") : "미배치"}
                    </li>
                  );
                })}
              </ul>
              <p className={ui.hint}>그사이 고른 자리에 다른 사람이 배정되면 그 사람은 미배치가 돼요.</p>
            </section>
          )}
          {check && check.rooms_removed.length > 0 && (
            <section className={ui.card} aria-labelledby="scheduled-rooms">
              <h2 id="scheduled-rooms" className={ui.cardTitle}>
                그날 없어지는 회의실
              </h2>
              <ul className={styles.problemList}>
                {check.rooms_removed.map((r) => {
                  const c = roomChoice.get(r.id);
                  return (
                    <li key={r.id} className={ui.hint}>
                      {r.name} · 남은 예약 {r.upcoming}건 →{" "}
                      {c?.action === "MOVE" ? `${roomNameOf.get(c.to_key ?? "") ?? "새 회의실"}로 옮기기` : "예약 취소"}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          <PlanPanel
            geometry={draft.geometry}
            selected={draft.geometry.elements.filter((e) => selectedIds.includes(e.id))}
            width={width}
            height={height}
            live={data.live}
            readOnly
            problems={problems}
            onChange={() => undefined}
            onDelete={() => undefined}
            onDuplicate={() => undefined}
            onSelect={(id) => setSelectedIds(id ? [id] : [])}
            onResize={() => undefined}
            onNotice={() => undefined}
          />
        </aside>
      </div>
    </>
  );
}
