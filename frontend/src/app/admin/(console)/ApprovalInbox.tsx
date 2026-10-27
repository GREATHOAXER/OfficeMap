"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ApprovalRow } from "@/lib/api";
import { kstDate, shortDate } from "@/lib/dates";
import { adminExpiredUrl } from "@/lib/loginRedirect";
import styles from "./admin.module.css";

// 관리자 첫 화면의 승인함: 구역 관리자("층 관리자 승인 후")가 올린 좌석 배치 요청을 그 층의 층 관리자 이상
// (층·사업장·전사·최종 관리자)이 여기서 바로 승인·반려한다. 자리별로 따져 보려면 배치도에서 검토한다
// (서버 server/app/routers/seating.py의 /approvals, /change-sets/{id}/approve·reject)

type Open = { id: number; kind: "approve" | "reject"; comment: string; error: string | null } | null;
type Result = { text: string; tone?: "error" } | null;

const json = { "content-type": "application/json" };

function errorText(code: string | undefined, conflicts: number): string {
  switch (code) {
    case "CONFLICTS":
      return `그사이 바뀐 자리 ${conflicts}건과 겹쳐서 승인하지 못했어요. 배치도에서 확인하고 반려해 주세요`;
    case "NOT_PENDING":
      return "그사이 상태가 바뀌었어요 (요청을 거뒀거나 다른 관리자가 처리했어요)";
    case "NOT_REVIEWER":
    case "NOT_IN_SCOPE":
      return "이 층의 요청을 처리할 권한이 없어요";
    default:
      return "처리하지 못했어요 · 잠시 뒤 다시 해 보세요";
  }
}

const title = (r: ApprovalRow) =>
  r.type === "ZONE_CHANGE" ? "구역 변경 요청" : r.note || (r.zone_moves ? "구역 경계 변경" : "좌석 배치 변경");

export default function ApprovalInbox({ requests, reviewer }: { requests: ApprovalRow[]; reviewer: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState<Open>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result>(null);
  const toReview = requests.filter((r) => r.can_review).length;

  async function send(row: ApprovalRow, kind: "approve" | "reject", comment = "") {
    if (kind === "reject" && !comment.trim()) {
      setOpen({ id: row.id, kind, comment, error: "반려 사유를 적어 주세요. 요청한 사람에게 그대로 보여요" });
      return;
    }
    setBusy(true);
    const res = await fetch(`/api/admin/change-sets/${row.id}/${kind}`, {
      method: "POST",
      headers: json,
      body: kind === "reject" ? JSON.stringify({ comment: comment.trim() }) : undefined,
    }).catch(() => null);
    const out = res ? await res.json().catch(() => null) : null;
    setBusy(false);
    if (res?.status === 401) {
      router.replace(adminExpiredUrl());
      return;
    }
    if (!res?.ok) {
      const detail = out?.detail;
      const text = res ? errorText(detail?.code, detail?.conflicts?.length ?? 0) : "네트워크 오류 · 다시 해 보세요";
      setOpen({ id: row.id, kind, comment, error: text });
      if (detail?.code === "NOT_PENDING") router.refresh();
      return;
    }
    setOpen(null);
    const who = `${row.floor.site} ${row.floor.name} · ${row.requester}`;
    if (kind === "reject") setResult({ text: `반려했어요 (${who}) · 요청한 사람이 사유를 보고 고쳐서 다시 올려요` });
    else {
      const applied = out?.applied;
      setResult({
        text: applied?.scheduled
          ? `승인했어요 (${who}) · ${shortDate(applied.effective_at)}부터 바뀌어요`
          : `승인하고 반영했어요 (${who}) · 직원 화면에 바로 보여요`,
      });
    }
    router.refresh();
  }

  return (
    <section className={styles.section} id="approvals" aria-labelledby="approvals-title">
      <div className={styles.sectionHead}>
        <h2 id="approvals-title">{reviewer ? "승인 요청" : "승인을 기다리는 내 요청"}</h2>
        <span className={styles.muted}>
          {reviewer
            ? "구역 관리자가 “층 관리자 승인 후”로 올린 좌석 배치 변경 · 그 층의 층 관리자 이상이 승인·반려해요"
            : "층 관리자 이상이 승인하면 반영돼요"}
        </span>
        {toReview > 0 && <span className={styles.countTag}>{toReview}건 대기</span>}
      </div>
      {result && (
        <p className={styles.approvalResult} role="status" data-tone={result.tone}>
          {result.text}
        </p>
      )}
      {requests.length === 0 ? (
        <p className={styles.approvalEmpty}>
          {reviewer ? "지금 승인할 요청이 없어요." : "승인을 기다리는 요청이 없어요."}
        </p>
      ) : (
        <ul className={styles.approvals}>
          {requests.map((r) => {
            const opened = open?.id === r.id ? open : null;
            return (
              <li key={r.id} className={styles.approval}>
                <div className={styles.approvalHead}>
                  <strong>{title(r)}</strong>
                  <span className={styles.chip}>
                    {r.floor.site} · {r.floor.name}
                  </span>
                  <span className={styles.muted}>
                    {r.mine ? "내 요청" : r.requester}
                    {r.submitted_at && ` · ${kstDate(r.submitted_at).slice(5)} 요청`}
                    {` · 반영: ${r.effective_at ? `${shortDate(r.effective_at)}부터` : "승인하면 바로"}`}
                  </span>
                </div>
                <p className={styles.approvalSummary}>
                  {r.summary.slice(0, 6).join(" · ")}
                  {r.summary.length > 6 && ` 외 ${r.summary.length - 6}건`}
                </p>
                <div className={styles.approvalActions}>
                  {r.can_review && !opened && (
                    <>
                      <button
                        type="button"
                        className={`${styles.btn} ${styles.pri}`}
                        onClick={() => setOpen({ id: r.id, kind: "approve", comment: "", error: null })}
                      >
                        승인
                      </button>
                      <button
                        type="button"
                        className={styles.btn}
                        onClick={() => setOpen({ id: r.id, kind: "reject", comment: "", error: null })}
                      >
                        반려
                      </button>
                    </>
                  )}
                  <Link className={styles.btn} href={`/admin/seating?floor=${r.floor.id}&review=${r.id}`}>
                    배치도에서 {r.can_review ? "검토" : "보기"}
                  </Link>
                </div>
                {opened?.kind === "approve" && (
                  <div className={styles.approvalConfirm}>
                    <p>
                      {r.effective_at
                        ? `승인하면 ${shortDate(r.effective_at)}부터 이대로 바뀌어요.`
                        : "승인하면 바로 반영돼서 직원 화면에도 보여요."}{" "}
                      변경 {r.item_count}건
                    </p>
                    <div className={styles.approvalActions}>
                      <button
                        type="button"
                        className={`${styles.btn} ${styles.pri}`}
                        disabled={busy}
                        onClick={() => void send(r, "approve")}
                      >
                        {busy ? "승인하는 중…" : "승인하고 반영"}
                      </button>
                      <button type="button" className={styles.btn} disabled={busy} onClick={() => setOpen(null)}>
                        취소
                      </button>
                    </div>
                  </div>
                )}
                {opened?.kind === "reject" && (
                  <div className={styles.approvalConfirm}>
                    <label className={styles.rejectField}>
                      <span>반려 사유 (요청한 사람에게 그대로 보여요)</span>
                      <textarea
                        rows={2}
                        maxLength={200}
                        value={opened.comment}
                        aria-invalid={!!opened.error || undefined}
                        onChange={(e) => setOpen({ ...opened, comment: e.target.value, error: null })}
                        autoFocus
                      />
                    </label>
                    <div className={styles.approvalActions}>
                      <button
                        type="button"
                        className={`${styles.btn} ${styles.pri}`}
                        disabled={busy}
                        onClick={() => void send(r, "reject", opened.comment)}
                      >
                        {busy ? "반려하는 중…" : "반려하기"}
                      </button>
                      <button type="button" className={styles.btn} disabled={busy} onClick={() => setOpen(null)}>
                        취소
                      </button>
                    </div>
                  </div>
                )}
                {opened?.error && (
                  <p className={styles.approvalError} role="alert">
                    {opened.error}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
