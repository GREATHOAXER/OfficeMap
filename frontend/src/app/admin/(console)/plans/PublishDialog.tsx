"use client";

import { useCallback, useEffect, useState } from "react";
import Dialog from "@/components/Dialog";
import type { PublishCheck } from "@/lib/api";
import { addDays, kstDate, shortDate } from "@/lib/dates";
import ui from "../seating/seating.module.css";
import styles from "./plans.module.css";

export type PublishResult = {
  version: number;
  added: number;
  removed: number;
  unassigned: number;
  reseated: number;
  rooms_removed: number;
  reservations_cancelled: number;
  reservations_moved: number;
};

type RoomChoice = { action: "CANCEL" | "MOVE"; to_key: string | null };
export type ScheduleResult = { version: number; effective_at: string };

const MAX_SCHEDULE_DAYS = 365; // 서버와 같다 (1년 안)
const todayKst = () => kstDate(new Date().toISOString());

type Props = {
  planId: number;
  floorName: string;
  /** 게시본이 없는 층 (처음 게시) */
  first: boolean;
  onClose: () => void;
  onPublished: (result: PublishResult) => void;
  /** 날짜를 정해 게시를 예약했다 */
  onScheduled: (result: ScheduleResult) => void;
  /** 도면에서 고칠 요소로 가기 */
  onShowElement: (id: string) => void;
  onExpired: () => void;
};

const UNASSIGNED = "";
const CANCEL = "__cancel__";

function problemText(p: PublishCheck["problems"][number]): string {
  switch (p.code) {
    case "SEAT_CODE_EMPTY":
      return "번호가 없는 책상이 있어요";
    case "SEAT_CODE_DUPLICATE":
      return `좌석 번호가 두 번 나와요: ${p.seat}`;
    case "ROOM_NAME_EMPTY":
      return "이름이 없는 회의실이 있어요";
    case "ROOM_NAME_DUPLICATE":
      return `회의실 이름이 두 번 나와요: ${p.name}`;
    case "OUTSIDE":
      return "도면 밖으로 나간 요소가 있어요";
    default:
      return "고쳐야 할 것이 있어요";
  }
}

function errorText(code: string | undefined): string {
  switch (code) {
    case "REVISION":
      return "그새 초안이 바뀌었어요. 바뀐 초안으로 다시 점검했어요";
    case "TARGET_TAKEN":
      return "고른 자리에 그새 다른 사람이 배정됐어요. 다시 점검했어요";
    case "PROBLEMS":
      return "게시 전에 고칠 것이 있어요";
    case "ROOMS_UNRESOLVED":
      return "예약이 남은 회의실을 어떻게 할지 골라 주세요";
    case "EDITING":
      return "다른 관리자가 이 초안을 편집 중이에요";
    case "BAD_DATE":
      return "게시 날짜는 내일부터 1년 안에서 고르세요";
    case "ROOM_TIME_TAKEN":
      return "옮길 회의실에 같은 시간 예약이 있어요. 다른 회의실을 고르거나 취소를 고르세요";
    case "SEAT_CODE_TAKEN":
    case "ROOM_NAME_TAKEN":
      return "좌석 번호·회의실 이름이 겹쳐요. 도면에서 고친 뒤 다시 게시하세요";
    default:
      return "게시하지 못했어요. 잠시 뒤 다시 시도하세요";
  }
}

/** 게시 전 점검: 바뀌는 것 요약, 자리가 없어지는 사람(기본 미배치)과 예약이 남은 회의실을 정하고 게시한다 */
export default function PublishDialog({
  planId,
  floorName,
  first,
  onClose,
  onPublished,
  onScheduled,
  onShowElement,
  onExpired,
}: Props) {
  const [check, setCheck] = useState<PublishCheck | null>(null);
  const [people, setPeople] = useState<Record<string, string>>({});
  const [rooms, setRooms] = useState<Record<number, RoomChoice | null>>({});
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [triedSubmit, setTriedSubmit] = useState(false);
  const [when, setWhen] = useState({ later: false, date: addDays(todayKst(), 1) });

  const load = useCallback(async () => {
    const res = await fetch(`/api/admin/plans/${planId}/check`).catch(() => null);
    if (res?.status === 401) {
      onExpired();
      return;
    }
    if (!res?.ok) {
      setError("점검하지 못했어요. 잠시 뒤 다시 시도하세요");
      return;
    }
    const data = (await res.json()) as PublishCheck;
    setCheck(data);
    // 고른 것은 아직 고를 수 있으면 그대로 둔다
    const targets = new Set(data.seat_targets.map((t) => t.key));
    setPeople((prev) =>
      Object.fromEntries(
        data.people.map((p) => [p.emp_no, targets.has(prev[p.emp_no] ?? "") ? prev[p.emp_no] : UNASSIGNED]),
      ),
    );
    const roomKeys = new Set(data.room_targets.map((t) => t.key));
    setRooms((prev) =>
      Object.fromEntries(
        data.rooms_removed.map((r) => {
          const old = prev[r.id];
          return [r.id, old && (old.action === "CANCEL" || roomKeys.has(old.to_key ?? "")) ? old : null];
        }),
      ),
    );
  }, [planId, onExpired]);

  useEffect(() => {
    // 열 때 한 번 서버에서 점검한다 (자동 저장이 끝난 초안 기준)
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  if (!check) {
    return (
      <Dialog open onClose={onClose} title={`${floorName} 도면 게시`}>
        <div className={ui.dialogBody}>
          <p className={ui.hint} role={error ? "alert" : "status"}>
            {error ?? "게시하면 바뀌는 것을 점검하고 있어요…"}
          </p>
        </div>
      </Dialog>
    );
  }

  const s = check.summary;
  const blocking = check.problems.length > 0;
  // 바로 게시하면 남은 예약이 있는 회의실만, 예약해 두면 그사이 예약이 생길 수 있어 없어지는 회의실 모두 정한다
  const roomsToDecide = check.rooms_removed.filter((r) => r.upcoming > 0 || when.later);
  const undecided = roomsToDecide.filter((r) => !rooms[r.id]);
  const chosen = new Map<string, string>(); // 자리 → 고른 사람
  for (const [emp, key] of Object.entries(people)) if (key) chosen.set(key, emp);
  const reseated = Object.values(people).filter(Boolean).length;
  const roomName = (key: string | null) => check.room_targets.find((t) => t.key === key)?.name ?? "";

  function suggestAll() {
    if (!check) return;
    const used = new Set(Object.values(people).filter(Boolean));
    const next = { ...people };
    for (const p of check.people) {
      if (next[p.emp_no] || !p.suggestion || used.has(p.suggestion.key)) continue;
      next[p.emp_no] = p.suggestion.key;
      used.add(p.suggestion.key);
    }
    setPeople(next);
  }

  async function publish() {
    if (!check) return;
    setTriedSubmit(true);
    if (blocking || undecided.length > 0) {
      setError(
        blocking
          ? "게시 전에 고칠 것이 있어요"
          : when.later
            ? "없어지는 회의실의 예약을 어떻게 할지 골라 주세요"
            : "예약이 남은 회의실을 어떻게 할지 골라 주세요",
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/plans/${planId}/publish`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          revision: check.revision,
          people: Object.entries(people)
            .filter(([, key]) => key)
            .map(([emp_no, to_key]) => ({ emp_no, to_key })),
          rooms: roomsToDecide.map((r) => ({ room_id: r.id, ...rooms[r.id]! })),
          note: note.trim() || null,
          effective_date: when.later ? when.date : null,
        }),
      });
      if (res.status === 401) {
        onExpired();
        return;
      }
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        const code = body?.detail?.code as string | undefined;
        setError(errorText(code));
        if (code === "REVISION" || code === "TARGET_TAKEN" || code === "PROBLEMS" || code === "ROOMS_UNRESOLVED") {
          await load();
        }
        return;
      }
      if (body.scheduled) onScheduled(body.scheduled as ScheduleResult);
      else onPublished(body.published as PublishResult);
    } catch {
      setError("네트워크 오류로 게시하지 못했어요");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      size="wide"
      title={`${floorName} 도면 게시`}
      footer={
        <>
          <button type="button" className={ui.btn} onClick={onClose}>
            더 고치기
          </button>
          <button
            type="button"
            className={`${ui.btn} ${ui.pri}`}
            disabled={busy || blocking}
            onClick={() => void publish()}
          >
            {busy ? "게시 중…" : when.later ? "게시 예약하기" : "게시하기"}
          </button>
        </>
      }
    >
      <div className={`${ui.dialogBody} ${styles.publish}`}>
        <section>
          <h3>바뀌는 것</h3>
          <ul className={styles.summary}>
            <li>
              좌석 {s.seats_before} → {s.seats_after}석
            </li>
            {s.added > 0 && <li>새 책상 {s.added}석</li>}
            {s.removed > 0 && <li>없어지는 좌석 {s.removed}석</li>}
            {s.moved > 0 && <li>옮긴 좌석 {s.moved}석</li>}
            {s.renamed.length > 0 && <li>번호 바뀜 {s.renamed.length}석</li>}
            {check.rooms_added.length > 0 && <li>새 회의실 {check.rooms_added.join(", ")}</li>}
            {check.rooms_changed.map((r) => (
              <li key={r.from}>{r.from === r.to ? `${r.to} 정원 ${r.capacity}명` : `${r.from} → ${r.to}`}</li>
            ))}
            {s.daily_ended > 0 && <li>오늘 자율석 사용 {s.daily_ended}건 끝남</li>}
          </ul>
          {s.renamed.length > 0 && (
            <p className={ui.hint}>
              {s.renamed
                .slice(0, 6)
                .map((r) => `${r.from} → ${r.to}`)
                .join(" · ")}
              {s.renamed.length > 6 && ` 외 ${s.renamed.length - 6}석`}. 앉은 사람은 그대로이고, 번호가 바뀐 사람에게
              알림이 가요.
            </p>
          )}
          <p className={ui.hint}>
            {first
              ? "이 층의 첫 도면이에요. 게시하면 직원 화면에 이 도면이 보여요."
              : "게시하면 지금 게시본은 보관본이 되고(5년 보관), 보고 있던 직원 화면에는 안내가 뜨고 5초 뒤 새 도면으로 바뀌어요."}
          </p>
        </section>

        {blocking && (
          <section>
            <h3>게시 전에 고칠 것</h3>
            <ul className={styles.problemList}>
              {check.problems.map((p, i) => (
                <li key={i}>
                  <button type="button" onClick={() => onShowElement(p.element)}>
                    {problemText(p)} · 도면에서 고치기
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {check.people.length > 0 && (
          <section>
            <div className={styles.sectionHead}>
              <h3>
                책상이 없어지는 사람 {check.people.length}명 · 새 자리 {reseated}명 · 미배치{" "}
                {check.people.length - reseated}명
              </h3>
              <button
                type="button"
                className={ui.btn}
                onClick={suggestAll}
                disabled={check.people.every((p) => !p.suggestion)}
              >
                모두 추천 자리로
              </button>
            </div>
            <ul className={styles.choices}>
              {check.people.map((p) => (
                <li key={p.emp_no}>
                  <span>
                    {p.name} {p.rank}
                    <small>
                      {p.department} · 지금 {p.seat_code}
                      {p.scheduled && " (예정된 배정)"}
                    </small>
                  </span>
                  <select
                    aria-label={`${p.name} 님 새 자리`}
                    value={people[p.emp_no] ?? UNASSIGNED}
                    onChange={(e) => setPeople({ ...people, [p.emp_no]: e.target.value })}
                  >
                    <option value={UNASSIGNED}>미배치로 두기</option>
                    {check.seat_targets
                      .filter((t) => !chosen.has(t.key) || chosen.get(t.key) === p.emp_no)
                      .map((t) => (
                        <option key={t.key} value={t.key}>
                          {t.code}
                          {p.suggestion?.key === t.key ? " (추천)" : ""}
                        </option>
                      ))}
                  </select>
                </li>
              ))}
            </ul>
            <p className={ui.hint}>
              미배치로 두면 각자 팀의 미배치 인원이 되고, 좌석 배치 화면에서 나중에 앉힐 수 있어요. 고를 수 있는 자리는
              게시한 뒤 비어 있을 고정석과 새 책상이에요.
            </p>
          </section>
        )}

        {check.rooms_removed.length > 0 && (
          <section>
            <h3>없어지는 회의실</h3>
            <ul className={styles.choices}>
              {check.rooms_removed.map((r) => {
                const choice = rooms[r.id];
                return (
                  <li key={r.id}>
                    <span>
                      {r.name}
                      <small>
                        {r.upcoming > 0
                          ? `남은 예약 ${r.upcoming}건${r.next_at ? ` · 다음 ${shortDate(r.next_at)}` : ""}`
                          : "남은 예약 없음"}
                      </small>
                    </span>
                    {(r.upcoming > 0 || when.later) && (
                      <select
                        aria-label={`${r.name} 예약`}
                        aria-invalid={(triedSubmit && !choice) || undefined}
                        value={choice ? (choice.action === "CANCEL" ? CANCEL : (choice.to_key ?? "")) : ""}
                        onChange={(e) =>
                          setRooms({
                            ...rooms,
                            [r.id]: !e.target.value
                              ? null
                              : e.target.value === CANCEL
                                ? { action: "CANCEL", to_key: null }
                                : { action: "MOVE", to_key: e.target.value },
                          })
                        }
                      >
                        <option value="">예약을 어떻게 할까요?</option>
                        {check.room_targets.map((t) => (
                          <option key={t.key} value={t.key}>
                            {t.name} ({t.capacity}인)로 옮기기
                          </option>
                        ))}
                        <option value={CANCEL}>예약 모두 취소</option>
                      </select>
                    )}
                  </li>
                );
              })}
            </ul>
            {roomsToDecide.length > 0 && (
              <p className={ui.hint}>
                {when.later
                  ? "그날 남아 있는 예약에 적용해요. 옮길 회의실에 같은 시간 예약이 있으면 그 예약만 취소돼요."
                  : "옮기면 같은 시간에 그 회의실로 바뀌어요 (겹치는 예약이 있으면 게시되지 않아요)."}{" "}
                어느 쪽이든 예약한 사람에게 알림이 가요.
                {roomsToDecide.some((r) => rooms[r.id]?.action === "MOVE") &&
                  ` 옮길 곳: ${roomsToDecide
                    .filter((r) => rooms[r.id]?.action === "MOVE")
                    .map((r) => `${r.name} → ${roomName(rooms[r.id]!.to_key)}`)
                    .join(", ")}`}
              </p>
            )}
          </section>
        )}

        <fieldset className={ui.when}>
          <legend>언제 게시할까요</legend>
          <label>
            <input
              type="radio"
              name="publish-when"
              checked={!when.later}
              onChange={() => setWhen({ ...when, later: false })}
            />
            지금
          </label>
          <label>
            <input
              type="radio"
              name="publish-when"
              checked={when.later}
              onChange={() => setWhen({ ...when, later: true })}
            />
            날짜 지정
            <input
              type="date"
              className={ui.dateInput}
              aria-label="게시 날짜"
              value={when.date}
              min={addDays(todayKst(), 1)}
              max={addDays(todayKst(), MAX_SCHEDULE_DAYS)}
              onChange={(e) => setWhen({ later: true, date: e.target.value })}
            />
            <span className={ui.muted}>그날 0시</span>
          </label>
          {when.later && (
            <p className={ui.hint}>
              그날 0시에 서버가 게시해요. 그때까지 초안은 고칠 수 없고(예약을 취소하면 다시 고쳐요), 그사이 고른 자리에
              다른 사람이 배정되면 그 사람은 미배치가 돼요. 이사·리모델링처럼 날이 정해진 변경에 써요.
            </p>
          )}
        </fieldset>

        <label className={ui.noteField}>
          <span>게시 메모 (보관본 목록에 남아요, 선택)</span>
          <input
            value={note}
            maxLength={200}
            placeholder="예: 4분기 조직 개편 반영"
            onChange={(e) => setNote(e.target.value)}
          />
        </label>

        {error && (
          <p className={ui.fieldError} role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
