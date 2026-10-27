"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import Dialog from "@/components/Dialog";
import type {
  Admin,
  PersonnelDepartment,
  PersonnelMove,
  PersonnelMoveItem,
  PersonnelPreview,
  PersonnelRow,
} from "@/lib/api";
import { addDays, kstDate, shortDate } from "@/lib/dates";
import { adminExpiredUrl } from "@/lib/loginRedirect";
import {
  downloadTemplate,
  MAX_ROWS,
  type PersonnelFile,
  PersonnelFileError,
  readPersonnelFile,
} from "@/lib/personnelFile";
import ui from "../seating/seating.module.css";
import styles from "./personnel.module.css";

// 인사이동: 발령 엑셀 올리기 → 줄마다 확인(조직도와 맞춰 보기)과 자리 미리 보기 → 자리 배치 방식·반영 시점 → 반영(또는 예약).
// 아래에 지난 인사이동 기록 (예약 취소). 서버: server/app/routers/personnel.py

type SeatMode = "AUTO" | "UNASSIGN";
type Filter = "all" | "check" | "error";
type Done = { move: PersonnelMove; rows: PersonnelRow[]; departments: PersonnelDepartment[] };

const MAX_SCHEDULE_DAYS = 365;
const json = { "content-type": "application/json" };
const todayKst = () => kstDate(new Date().toISOString());

const FILE_ERROR: Record<PersonnelFileError["code"], string> = {
  TYPE: "엑셀(.xlsx) 또는 CSV 파일을 올려 주세요. 예전 엑셀(.xls)이면 .xlsx로 다시 저장해 주세요",
  BROKEN: "파일을 열 수 없어요. 엑셀에서 열리는지 확인해 주세요 (암호가 걸린 파일은 읽지 못해요)",
  NO_HEADER: "사번과 새 부서(또는 직급·직책) 열을 찾지 못했어요. 첫 줄 머리글을 양식처럼 적어 주세요",
  EMPTY: "머리글 아래에 발령 줄이 없어요",
  TOO_MANY: `한 번에 ${MAX_ROWS.toLocaleString()}줄까지 올릴 수 있어요. 나눠서 올려 주세요`,
};

const STATUS: Record<PersonnelRow["status"], string> = { OK: "반영", WARN: "확인", SAME: "그대로", ERROR: "빠짐" };
const MOVE_STATUS: Record<PersonnelMove["status"], string> = {
  SCHEDULED: "예약",
  APPLIED: "반영됨",
  CANCELLED: "취소됨",
  FAILED: "실패",
};

function errorText(code: string | undefined): string {
  switch (code) {
    case "BAD_DATE":
      return `반영 날짜는 내일부터 ${MAX_SCHEDULE_DAYS}일 안으로 골라 주세요`;
    case "NOTHING_TO_APPLY":
      return "반영할 줄이 없어요 (모두 빠지거나 이미 그 부서예요)";
    case "COMPANY_ONLY":
      return "인사이동은 최종·전사 관리자만 할 수 있어요";
    case "CONFLICTS":
      return "그사이 자리가 바뀌어 자동 배치가 겹쳤어요. 다시 확인한 뒤 반영해 주세요";
    case "NOT_SCHEDULED":
      return "이미 반영됐거나 취소된 인사이동이에요";
    default:
      return "처리하지 못했어요. 잠시 뒤 다시 해 보세요";
  }
}

/** 부서 칸: "재무팀 → 인사팀", 부서가 그대로면 지금 부서만 */
const deptText = (r: { from_department: string | null; to_department: string | null }) =>
  r.to_department ? `${r.from_department ?? "?"} → ${r.to_department}` : (r.from_department ?? "");

const titleOf = (fileName: string) => fileName.replace(/\.(xlsx|csv)$/i, "").slice(0, 100);

export default function PersonnelWizard({ admin, moves }: { admin: Admin; moves: PersonnelMove[] }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ name: string; data: PersonnelFile } | null>(null);
  const [reading, setReading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [seatMode, setSeatMode] = useState<SeatMode>("AUTO");
  const [preview, setPreview] = useState<PersonnelPreview | null>(null);
  const [checking, setChecking] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [when, setWhen] = useState({ later: false, date: addDays(todayKst(), 1) });
  const [title, setTitle] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);

  async function check(data: PersonnelFile, mode: SeatMode) {
    setChecking(true);
    setError(null);
    const res = await fetch("/api/admin/personnel/preview", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ rows: data.rows, seat_mode: mode }),
    }).catch(() => null);
    setChecking(false);
    if (res?.status === 401) {
      router.replace(adminExpiredUrl());
      return;
    }
    const out = res ? await res.json().catch(() => null) : null;
    if (!res?.ok) {
      setPreview(null);
      setError(res ? errorText(out?.detail?.code) : "네트워크 오류 · 다시 해 보세요");
      return;
    }
    setPreview(out as PersonnelPreview);
  }

  async function pick(picked: File | undefined) {
    if (!picked) return;
    setReading(true);
    setFileError(null);
    setPreview(null);
    setFilter("all");
    try {
      const data = await readPersonnelFile(picked);
      setFile({ name: picked.name, data });
      setTitle(titleOf(picked.name));
      await check(data, seatMode);
    } catch (e) {
      setFile(null);
      setFileError(e instanceof PersonnelFileError ? FILE_ERROR[e.code] : FILE_ERROR.BROKEN);
    } finally {
      setReading(false);
      if (inputRef.current) inputRef.current.value = ""; // 같은 파일을 고쳐 다시 올릴 수 있게
    }
  }

  function changeMode(mode: SeatMode) {
    setSeatMode(mode);
    if (file) void check(file.data, mode);
  }

  async function submit() {
    if (!file) return;
    setBusy(true);
    setError(null);
    const res = await fetch("/api/admin/personnel", {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        rows: file.data.rows,
        seat_mode: seatMode,
        title: title.trim() || titleOf(file.name),
        effective_date: when.later ? when.date : null,
      }),
    }).catch(() => null);
    setBusy(false);
    setConfirming(false);
    if (res?.status === 401) {
      router.replace(adminExpiredUrl());
      return;
    }
    const out = res ? await res.json().catch(() => null) : null;
    if (!res?.ok) {
      setError(res ? errorText(out?.detail?.code) : "네트워크 오류 · 다시 해 보세요");
      return;
    }
    setDone(out as Done);
    router.refresh(); // 아래 기록 목록
  }

  function reset() {
    setFile(null);
    setPreview(null);
    setDone(null);
    setError(null);
    setFileError(null);
    setTitle("");
    setWhen({ later: false, date: addDays(todayKst(), 1) });
  }

  const rows = preview?.rows ?? [];
  const count = (s: PersonnelRow["status"]) => rows.filter((r) => r.status === s).length;
  const todo = count("OK") + count("WARN");
  const shown = rows.filter((r) =>
    filter === "error" ? r.status === "ERROR" : filter === "check" ? r.status === "WARN" || r.status === "ERROR" : true,
  );
  const minDate = addDays(todayKst(), 1);
  const maxDate = addDays(todayKst(), MAX_SCHEDULE_DAYS);
  const dateOk = !when.later || (when.date >= minDate && when.date <= maxDate);

  return (
    <main className={ui.page}>
      <header className={ui.header}>
        <div className={ui.titleRow}>
          <h1 className={ui.title}>인사이동</h1>
          <span className={ui.roleChip}>
            <strong>{admin.role_label}</strong>
          </span>
        </div>
        <div className={ui.headerActions}>
          <button type="button" className={ui.btn} onClick={() => void downloadTemplate()}>
            발령 양식 받기
          </button>
        </div>
      </header>

      <div className={styles.body}>
        {done ? (
          <DoneView done={done} onNew={reset} />
        ) : (
          <>
            <section className={ui.card} aria-labelledby="step-file">
              <h2 id="step-file" className={ui.cardTitle}>
                1. 발령 엑셀 올리기
              </h2>
              <p className={ui.hint}>
                사번 · 이름 · 현 부서 · 새 부서가 있는 엑셀(.xlsx, CSV)을 올리면 조직도와 맞춰 보고 새 부서로 옮겨요.
                직급 · 직책 열이 있으면 바뀌는 사람만 함께 바꿔요. 머리글 이름이 조금 달라도(성명, 발령부서, 신소속 …)
                읽어요.
              </p>
              <label
                className={styles.drop}
                data-over={dragOver || undefined}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  void pick(e.dataTransfer.files[0]);
                }}
              >
                <input
                  ref={inputRef}
                  type="file"
                  accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
                  aria-label="발령 엑셀 파일"
                  onChange={(e) => void pick(e.target.files?.[0])}
                />
                <strong>{reading ? "읽는 중…" : file ? file.name : "엑셀 파일을 끌어다 놓거나 눌러서 고르세요"}</strong>
                {file && !reading && (
                  <span>
                    {file.data.sheet ? `"${file.data.sheet}" 시트 · ` : ""}
                    {file.data.rows.length}줄 · 찾은 열: {file.data.columns.join(", ")} · 다른 파일을 올리려면 다시
                    누르세요
                  </span>
                )}
              </label>
              {fileError && (
                <p className={ui.conflictText} role="alert">
                  {fileError}
                </p>
              )}
            </section>

            {(preview || checking) && (
              <section className={ui.card} aria-labelledby="step-check" aria-busy={checking || undefined}>
                <h2 id="step-check" className={ui.cardTitle}>
                  2. 확인
                </h2>
                {checking && !preview ? (
                  <p className={ui.hint}>조직도와 맞춰 보는 중…</p>
                ) : (
                  preview && (
                    <>
                      <ul className={styles.counts} aria-label="확인 결과">
                        <li>
                          <strong>{preview.summary.moved}</strong>명 부서 이동
                        </li>
                        {preview.summary.changed > preview.summary.moved && (
                          <li>
                            <strong>{preview.summary.changed - preview.summary.moved}</strong>명 직급·직책만
                          </li>
                        )}
                        {seatMode === "AUTO" && (
                          <li>
                            새 자리 <strong>{preview.summary.seated}</strong>명
                          </li>
                        )}
                        <li data-tone={preview.summary.unseated ? "warn" : undefined}>
                          미배치 <strong>{preview.summary.unseated}</strong>명
                        </li>
                        {count("WARN") > 0 && (
                          <li data-tone="warn">
                            확인 필요 <strong>{count("WARN")}</strong>줄
                          </li>
                        )}
                        {count("ERROR") > 0 && (
                          <li data-tone="error">
                            빠지는 줄 <strong>{count("ERROR")}</strong>
                          </li>
                        )}
                        {count("SAME") > 0 && (
                          <li>
                            바뀌는 것 없음 <strong>{count("SAME")}</strong>줄
                          </li>
                        )}
                      </ul>
                      {preview.departments.length > 0 && <DepartmentTable departments={preview.departments} />}
                      <div className={styles.filters} role="group" aria-label="보기">
                        {(
                          [
                            ["all", `전체 ${rows.length}`],
                            ["check", `확인·빠짐 ${count("WARN") + count("ERROR")}`],
                            ["error", `빠지는 줄 ${count("ERROR")}`],
                          ] as const
                        ).map(([key, label]) => (
                          <button key={key} type="button" aria-pressed={filter === key} onClick={() => setFilter(key)}>
                            {label}
                          </button>
                        ))}
                      </div>
                      <RowTable rows={shown} seatMode={seatMode} />
                      <p className={ui.hint}>
                        &ldquo;빠짐&rdquo; 줄은 반영하지 않아요. 엑셀을 고쳐 다시 올리거나, 나머지만 먼저 반영하고 고친
                        줄만 따로 올려도 돼요. 새 자리는 지금 빈 자리로 정한 미리 보기예요.
                      </p>
                    </>
                  )
                )}
              </section>
            )}

            {preview && (
              <section className={ui.card} aria-labelledby="step-apply">
                <h2 id="step-apply" className={ui.cardTitle}>
                  3. 자리와 반영 시점
                </h2>
                <fieldset className={ui.when}>
                  <legend>자리 배치</legend>
                  <label>
                    <input
                      type="radio"
                      name="seat-mode"
                      checked={seatMode === "AUTO"}
                      onChange={() => changeMode("AUTO")}
                    />{" "}
                    새 팀 구역의 빈 자리에 자동으로 앉히기
                    <span className={ui.hint}>
                      엑셀 순서대로 앉혀요. 나가는 사람의 자리도 쓰고, 모자라거나 팀 구역이 없으면 미배치로 남겨요
                    </span>
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="seat-mode"
                      checked={seatMode === "UNASSIGN"}
                      onChange={() => changeMode("UNASSIGN")}
                    />{" "}
                    모두 미배치로 두기
                    <span className={ui.hint}>새 팀의 좌석 배치 편집에서 직접 자리를 정해요</span>
                  </label>
                </fieldset>
                <fieldset className={ui.when}>
                  <legend>반영 시점</legend>
                  <label>
                    <input
                      type="radio"
                      name="when"
                      checked={!when.later}
                      onChange={() => setWhen({ ...when, later: false })}
                    />{" "}
                    지금 바로
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="when"
                      checked={when.later}
                      onChange={() => setWhen({ ...when, later: true })}
                    />{" "}
                    발령일 0시에
                    <input
                      type="date"
                      className={ui.dateInput}
                      aria-label="발령일"
                      min={minDate}
                      max={maxDate}
                      value={when.date}
                      disabled={!when.later}
                      aria-invalid={!dateOk || undefined}
                      onChange={(e) => setWhen({ later: true, date: e.target.value })}
                    />
                  </label>
                  {when.later && (
                    <span className={ui.hint}>
                      {dateOk
                        ? `${shortDate(`${when.date}T00:00:00+09:00`)} 0시에 서버가 반영해요. 자리는 그때의 빈 자리로 다시 정하고, 그 전에는 아래 기록에서 취소할 수 있어요`
                        : `내일부터 ${MAX_SCHEDULE_DAYS}일 안의 날짜를 골라 주세요`}
                    </span>
                  )}
                </fieldset>
                <label className={ui.field}>
                  <span>이름 (기록에 남아요)</span>
                  <input
                    className={ui.textInput}
                    maxLength={100}
                    value={title}
                    placeholder="예: 2026 하반기 정기 인사"
                    onChange={(e) => setTitle(e.target.value)}
                  />
                </label>
                {error && (
                  <p className={ui.conflictText} role="alert">
                    {error}
                  </p>
                )}
                <div className={ui.rowButtons}>
                  <button
                    type="button"
                    className={`${ui.btn} ${ui.pri}`}
                    disabled={todo === 0 || checking || !dateOk}
                    onClick={() => setConfirming(true)}
                  >
                    {when.later ? `${todo}명 인사이동 예약` : `${todo}명 인사이동 반영`}
                  </button>
                  <button type="button" className={ui.btn} onClick={reset}>
                    처음부터
                  </button>
                </div>
              </section>
            )}
            {!preview && error && (
              <p className={ui.conflictText} role="alert">
                {error}
              </p>
            )}
          </>
        )}

        <History moves={moves} />
      </div>

      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title={when.later ? "인사이동을 예약할까요?" : "인사이동을 반영할까요?"}
        footer={
          <>
            <button type="button" className={ui.btn} onClick={() => setConfirming(false)}>
              취소
            </button>
            <button type="button" className={`${ui.btn} ${ui.pri}`} disabled={busy} onClick={() => void submit()}>
              {busy ? "반영하는 중…" : when.later ? "예약하기" : "반영하기"}
            </button>
          </>
        }
      >
        {preview && (
          <div className={ui.dialogBody}>
            {when.later ? (
              <p>
                {shortDate(`${when.date}T00:00:00+09:00`)} 0시에 {todo}명의 소속
                {preview.summary.changed > preview.summary.moved ? "·직급·직책" : ""}을 바꿔요.{" "}
                {seatMode === "AUTO"
                  ? "자리는 그때 새 팀 구역의 빈 자리로 정해요."
                  : "자리는 비우고 새 팀의 미배치 인원이 돼요."}{" "}
                그 전에는 기록에서 취소할 수 있어요.
              </p>
            ) : (
              <p>
                {todo}명의 소속{preview.summary.changed > preview.summary.moved ? "·직급·직책" : ""}을 바로 바꿔요. 원래
                자리는 비워지고{" "}
                {seatMode === "AUTO"
                  ? `${preview.summary.seated}명은 새 팀 구역의 빈 자리에 앉아요 (미배치 ${preview.summary.unseated}명).`
                  : "모두 새 팀의 미배치 인원이 돼요."}{" "}
                직원 화면에도 바로 보여요.
              </p>
            )}
            {count("ERROR") > 0 && <p className={ui.hint}>빠지는 줄 {count("ERROR")}줄은 반영하지 않아요.</p>}
          </div>
        )}
      </Dialog>
    </main>
  );
}

function DepartmentTable({ departments }: { departments: PersonnelDepartment[] }) {
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <caption className="visually-hidden">부서별 들고 나는 사람</caption>
        <thead>
          <tr>
            <th scope="col">부서</th>
            <th scope="col">들어옴</th>
            <th scope="col">나감</th>
            <th scope="col">새 자리</th>
            <th scope="col">미배치</th>
          </tr>
        </thead>
        <tbody>
          {departments.map((d) => (
            <tr key={d.name}>
              <th scope="row">
                {d.name}
                {!d.has_zone && d.incoming > 0 && <small> 팀 구역 없음</small>}
              </th>
              <td>{d.incoming}</td>
              <td>{d.outgoing}</td>
              <td>{d.seated}</td>
              <td data-tone={d.unseated ? "warn" : undefined}>{d.unseated}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RowTable({ rows, seatMode }: { rows: PersonnelRow[]; seatMode: SeatMode }) {
  if (rows.length === 0) return <p className={ui.hint}>해당하는 줄이 없어요.</p>;
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <caption className="visually-hidden">발령 줄마다 확인 결과</caption>
        <thead>
          <tr>
            <th scope="col">행</th>
            <th scope="col">사람</th>
            <th scope="col">부서</th>
            <th scope="col">직급 · 직책</th>
            <th scope="col">{seatMode === "AUTO" ? "새 자리 (미리 보기)" : "자리"}</th>
            <th scope="col">확인</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.line}-${r.emp_no}`} data-status={r.status}>
              <td className="mono">{r.line}</td>
              <td>
                <strong>{r.name ?? r.excel_name ?? "?"}</strong> <span className="mono">{r.emp_no}</span>
              </td>
              <td>{deptText(r)}</td>
              <td>
                {[
                  r.rank && `직급 ${r.rank.from ?? "없음"} → ${r.rank.to}`,
                  r.position && `직책 ${r.position.from ?? "없음"} → ${r.position.to}`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </td>
              <td>{r.result ? (r.result.seat ?? <span className={styles.note}>{r.result.note}</span>) : ""}</td>
              <td>
                <span className={styles.chip} data-status={r.status}>
                  {STATUS[r.status]}
                </span>
                {r.messages.map((m) => (
                  <span key={m} className={styles.message}>
                    {m}
                  </span>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DoneView({ done, onNew }: { done: Done; onNew: () => void }) {
  const { move } = done;
  const applied = done.rows.filter((r) => r.result?.status === "APPLIED");
  return (
    <section className={`${ui.card} ${styles.done}`} aria-labelledby="done-title" role="status">
      <h2 id="done-title" className={ui.cardTitle}>
        {move.status === "SCHEDULED"
          ? `예약했어요 · ${shortDate(move.effective_at)} 0시 · ${move.title}`
          : `반영했어요 · ${move.title}`}
      </h2>
      {move.status === "SCHEDULED" ? (
        <p className={ui.hint}>
          {move.people}명의 인사이동을 예약했어요. 그날 0시에 서버가 반영하고, 그 전에는 아래 기록에서 취소할 수 있어요.
        </p>
      ) : (
        <>
          <ul className={styles.counts}>
            <li>
              <strong>{move.summary?.moved ?? 0}</strong>명 부서 이동
            </li>
            <li>
              새 자리 <strong>{move.summary?.seated ?? 0}</strong>명
            </li>
            <li data-tone={move.summary?.unseated ? "warn" : undefined}>
              미배치 <strong>{move.summary?.unseated ?? 0}</strong>명
            </li>
          </ul>
          {done.departments.length > 0 && <DepartmentTable departments={done.departments} />}
          <RowTable rows={applied} seatMode={move.seat_mode} />
          <p className={ui.hint}>
            새 자리에 앉은 사람에게는 자리 알림이 가요. 미배치 인원은 새 팀의 좌석 배치 편집 &ldquo;미배치 인원&rdquo;에
            있어요.
          </p>
        </>
      )}
      <div className={ui.rowButtons}>
        {move.status !== "SCHEDULED" && (
          <Link className={`${ui.btn} ${ui.pri}`} href="/admin/seating">
            좌석 배치 편집으로
          </Link>
        )}
        <button type="button" className={ui.btn} onClick={onNew}>
          새 인사이동
        </button>
      </div>
    </section>
  );
}

/** 지난 인사이동과 예약: 누르면 사람마다 결과, 예약은 취소 */
function History({ moves }: { moves: PersonnelMove[] }) {
  const router = useRouter();
  const [openId, setOpenId] = useState<number | null>(null);
  const [items, setItems] = useState<PersonnelMoveItem[] | null>(null);
  const [cancelId, setCancelId] = useState<number | null>(null);
  const [message, setMessage] = useState<{ id: number; text: string } | null>(null);

  async function toggle(id: number) {
    if (openId === id) {
      setOpenId(null);
      return;
    }
    setOpenId(id);
    setItems(null);
    const res = await fetch(`/api/admin/personnel/${id}`, { cache: "no-store" }).catch(() => null);
    if (res?.status === 401) {
      router.replace(adminExpiredUrl());
      return;
    }
    if (res?.ok) setItems(((await res.json()) as { items: PersonnelMoveItem[] }).items);
    else setMessage({ id, text: "불러오지 못했어요" });
  }

  async function cancel(id: number) {
    const res = await fetch(`/api/admin/personnel/${id}/cancel`, { method: "POST" }).catch(() => null);
    setCancelId(null);
    if (res?.status === 401) {
      router.replace(adminExpiredUrl());
      return;
    }
    const out = res ? await res.json().catch(() => null) : null;
    setMessage({ id, text: res?.ok ? "예약을 취소했어요" : errorText(out?.detail?.code) });
    router.refresh();
  }

  return (
    <section className={ui.card} aria-labelledby="history-title">
      <h2 id="history-title" className={ui.cardTitle}>
        인사이동 기록
      </h2>
      {moves.length === 0 ? (
        <p className={ui.hint}>아직 인사이동 기록이 없어요.</p>
      ) : (
        <ul className={styles.history}>
          {moves.map((m) => (
            <li key={m.id} data-status={m.status}>
              <div className={styles.historyHead}>
                <strong>{m.title}</strong>
                <span className={ui.statusChip}>
                  {MOVE_STATUS[m.status]}
                  {m.status === "SCHEDULED" && ` · ${shortDate(m.effective_at)} 0시`}
                </span>
                <span className={ui.hint}>
                  {m.people}명
                  {m.summary && m.status === "APPLIED"
                    ? ` · 부서 이동 ${m.summary.moved} · 새 자리 ${m.summary.seated} · 미배치 ${m.summary.unseated}`
                    : ""}
                  {m.seat_mode === "UNASSIGN" ? " · 모두 미배치로" : ""} · {m.created_by}{" "}
                  {kstDate(m.status === "APPLIED" && m.applied_at ? m.applied_at : m.created_at).slice(5)}
                  {m.status === "CANCELLED" && m.cancelled_by ? ` · 취소 ${m.cancelled_by}` : ""}
                </span>
              </div>
              {m.status === "FAILED" && (
                <p className={ui.conflictText}>
                  예약한 날 반영하지 못했어요 (아무것도 바뀌지 않았어요). 확인한 뒤 엑셀을 다시 올려 주세요.
                </p>
              )}
              <div className={ui.rowButtons}>
                <button
                  type="button"
                  className={ui.btn}
                  aria-expanded={openId === m.id}
                  onClick={() => void toggle(m.id)}
                >
                  {openId === m.id ? "접기" : "사람별 결과"}
                </button>
                {m.status === "SCHEDULED" &&
                  (cancelId === m.id ? (
                    <>
                      <button type="button" className={`${ui.btn} ${ui.danger}`} onClick={() => void cancel(m.id)}>
                        예약 취소하기
                      </button>
                      <button type="button" className={ui.btn} onClick={() => setCancelId(null)}>
                        그대로 두기
                      </button>
                    </>
                  ) : (
                    <button type="button" className={ui.btn} onClick={() => setCancelId(m.id)}>
                      예약 취소
                    </button>
                  ))}
              </div>
              {message?.id === m.id && (
                <p className={ui.hint} role="status">
                  {message.text}
                </p>
              )}
              {openId === m.id &&
                (items ? (
                  <div className={styles.tableWrap}>
                    <table className={styles.table}>
                      <caption className="visually-hidden">{m.title} 사람별 결과</caption>
                      <thead>
                        <tr>
                          <th scope="col">행</th>
                          <th scope="col">사람</th>
                          <th scope="col">부서</th>
                          <th scope="col">직급 · 직책</th>
                          <th scope="col">결과</th>
                        </tr>
                      </thead>
                      <tbody>
                        {items.map((i) => (
                          <tr key={i.emp_no} data-status={i.status === "SKIPPED" ? "ERROR" : undefined}>
                            <td className="mono">{i.line}</td>
                            <td>
                              <strong>{i.name}</strong> <span className="mono">{i.emp_no}</span>
                            </td>
                            <td>{deptText(i)}</td>
                            <td>
                              {[i.rank && `직급 ${i.rank}`, i.position && `직책 ${i.position}`]
                                .filter(Boolean)
                                .join(" · ")}
                            </td>
                            <td>
                              {i.status === "PENDING"
                                ? "예정"
                                : (i.seat ?? <span className={styles.note}>{i.note ?? "미배치"}</span>)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className={ui.hint}>불러오는 중…</p>
                ))}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
