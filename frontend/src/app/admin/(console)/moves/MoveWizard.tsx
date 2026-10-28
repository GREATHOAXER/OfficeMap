"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import FloorSvg from "@/components/FloorSvg";
import type { Admin, MoveOptions, SeatingData, SeatingSeat, TeamMember } from "@/lib/api";
import { placeOf } from "../place";
import { addDays, kstDate, shortDate } from "@/lib/dates";
import { type DrawingSeat, drawingFromSeating } from "@/lib/floorDrawing";
import { adminExpiredUrl } from "@/lib/loginRedirect";
import ui from "../seating/seating.module.css";
import styles from "./moves.module.css";
import { zoneColorVars } from "@/lib/zoneColors";

const MAX_SCHEDULE_DAYS = 365;
const STAY = "stay"; // 옮기지 않음
const UNASSIGN = "unassign"; // 미배치로 (지금 자리만 끝낸다)
const todayKst = () => kstDate(new Date().toISOString());
const json = { "content-type": "application/json" };

type Result = {
  id: number;
  department: string;
  to_floor: string;
  effective_at: string;
  scheduled: boolean;
  moved: number;
  unassigned: number;
};
type Conflict = { seat_id: number; code: string; reason: string };

/** 비어 있어 옮겨 갈 수 있는 자리: 고정석·사용 중·앉은 사람 없음·날짜를 정한 변경 없음 */
const isFree = (s: SeatingSeat) => s.seat_type === "FIXED" && s.status === "ACTIVE" && !s.occupant && !s.upcoming;
const byCode = (a: { code: string }, b: { code: string }) => a.code.localeCompare(b.code, "ko", { numeric: true });
/** 자리 있는 사람 먼저 (층·좌석 번호 순), 미배치는 이름 순 */
const bySeat = (a: TeamMember, b: TeamMember) =>
  (a.seat ? 0 : 1) - (b.seat ? 0 : 1) ||
  (a.seat && b.seat ? a.seat.floor.localeCompare(b.seat.floor) || byCode(a.seat, b.seat) : 0) ||
  a.name.localeCompare(b.name, "ko");

type Props = { admin: Admin; options: MoveOptions };

/** 팀 이사 도우미: 팀 고르기 → 목적지 층·자리 고르기 → 사람과 자리 맞추기 → 언제 → 반영(또는 예약) */
export default function MoveWizard({ admin, options }: Props) {
  const router = useRouter();
  const [deptId, setDeptId] = useState("");
  const [members, setMembers] = useState<TeamMember[] | null>(null);
  const [floorId, setFloorId] = useState("");
  const [dest, setDest] = useState<SeatingData | null>(null);
  const [targets, setTargets] = useState<number[]>([]);
  const [plan, setPlan] = useState<Record<string, string>>({});
  const [when, setWhen] = useState({ later: false, date: addDays(todayKst(), 1) });
  const [note, setNote] = useState("");
  const [zoneIds, setZoneIds] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [result, setResult] = useState<Result | null>(null);

  const dept = options.departments.find((d) => String(d.id) === deptId) ?? null;

  async function get<T>(path: string): Promise<T | null> {
    const res = await fetch(path, { cache: "no-store" }).catch(() => null);
    if (res?.status === 401) {
      router.replace(adminExpiredUrl());
      return null;
    }
    if (!res?.ok) {
      setError("불러오지 못했어요. 잠시 뒤 다시 시도하세요");
      return null;
    }
    return (await res.json()) as T;
  }

  async function chooseTeam(id: string) {
    setDeptId(id);
    setMembers(null);
    setPlan({});
    setResult(null);
    setError(null);
    if (!id) return;
    const out = await get<{ members: TeamMember[] }>(`/api/admin/moves/team?department_id=${id}`);
    if (out) setMembers(out.members);
  }

  /** 고른 것은 그대로 두고 팀·목적지를 다시 읽는다 (그새 바뀐 자리를 보여 주려고) */
  async function refresh(team: number, floor: number) {
    const [t, d] = await Promise.all([
      get<{ members: TeamMember[] }>(`/api/admin/moves/team?department_id=${team}`),
      get<SeatingData>(`/api/admin/floors/${floor}/seating`),
    ]);
    if (t) setMembers(t.members);
    if (d) setDest(d);
  }

  async function chooseFloor(id: string) {
    setFloorId(id);
    setResult(null);
    setError(null);
    setTargets([]);
    setPlan({});
    setZoneIds([]);
    setDest(null);
    if (!id) return;
    const out = await get<SeatingData>(`/api/admin/floors/${id}/seating`);
    if (out) setDest(out);
  }

  // 사업장마다 같은 이름의 층(1F·7F 등)이 있을 수 있어 사업장 이름을 붙인다
  const destName = dest ? `${dest.floor.site.name} ${dest.floor.name}` : (result?.to_floor ?? "");
  const seatById = useMemo(() => new Map((dest?.seats ?? []).map((s) => [s.id, s])), [dest]);
  const freeSeats = useMemo(() => (dest?.seats ?? []).filter(isFree).sort(byCode), [dest]);
  const movable = useMemo(() => (members ?? []).filter((m) => !m.locked).sort(bySeat), [members]);
  const choiceOf = (emp: string) => plan[emp] ?? STAY;
  // 고른 자리 → 그 자리에 맞춘 사람
  const whoSits = useMemo(
    () =>
      new Map(
        Object.entries(plan)
          .filter(([, v]) => v !== STAY && v !== UNASSIGN)
          .map(([emp, v]) => [Number(v), emp]),
      ),
    [plan],
  );
  const nameOf = useMemo(() => new Map((members ?? []).map((m) => [m.emp_no, m.name])), [members]);

  function toggleSeat(seatId: number) {
    if (targets.includes(seatId)) {
      setTargets(targets.filter((id) => id !== seatId));
      const emp = whoSits.get(seatId);
      if (emp) setPlan({ ...plan, [emp]: STAY });
    } else {
      setTargets([...targets, seatId]);
    }
    setConflicts([]);
  }

  /** 순서대로: 지금 자리 번호 순(미배치는 이름 순)으로 고른 자리 번호 순에 하나씩 */
  function autoMatch(seatIds = targets) {
    const seats = seatIds
      .map((id) => seatById.get(id))
      .filter((s): s is SeatingSeat => !!s)
      .sort(byCode);
    const next: Record<string, string> = {};
    movable.forEach((m, i) => {
      next[m.emp_no] = seats[i] ? String(seats[i].id) : STAY;
    });
    setPlan(next);
  }

  function takeZone(zoneId: number | null) {
    const ids = freeSeats.filter((s) => s.zone_id === zoneId).map((s) => s.id);
    setTargets(ids);
    autoMatch(ids);
    setConflicts([]);
  }

  const moving = movable.filter((m) => choiceOf(m.emp_no) !== STAY);
  const toSeat = moving.filter((m) => choiceOf(m.emp_no) !== UNASSIGN);
  const toUnassigned = moving.filter((m) => choiceOf(m.emp_no) === UNASSIGN);
  // 고른 자리의 구역 중 이 팀 구역이 아닌 곳: 이 팀 구역으로 바꿀지 고른다
  const otherZones = (dest?.zones ?? []).filter(
    (z) =>
      z.department_id !== dept?.id && toSeat.some((m) => seatById.get(Number(choiceOf(m.emp_no)))?.zone_id === z.id),
  );

  const drawing = useMemo(() => {
    if (!dest) return null;
    const d = drawingFromSeating(dest);
    if (!d) return null;
    return {
      ...d,
      seats: d.seats.map((s): DrawingSeat => {
        if (!targets.includes(Number(s.id))) return s;
        const emp = whoSits.get(Number(s.id));
        return { ...s, state: "target", name: emp ? (nameOf.get(emp) ?? null) : "빈 자리" };
      }),
    };
  }, [dest, targets, whoSits, nameOf]);

  async function submit() {
    if (!dept || !dest) return;
    if (moving.length === 0) {
      setError("옮길 사람이 없어요. 자리를 고르고 사람과 맞추세요");
      return;
    }
    setBusy(true);
    setError(null);
    setConflicts([]);
    try {
      const res = await fetch("/api/admin/moves", {
        method: "POST",
        headers: json,
        body: JSON.stringify({
          department_id: dept.id,
          to_floor_id: dest.floor.id,
          moves: moving.map((m) => ({
            emp_no: m.emp_no,
            seat_id: choiceOf(m.emp_no) === UNASSIGN ? null : Number(choiceOf(m.emp_no)),
          })),
          effective_date: when.later ? when.date : null,
          note: note.trim() || null,
          zone_ids: zoneIds.filter((id) => otherZones.some((z) => z.id === id)),
        }),
      });
      if (res.status === 401) {
        router.replace(adminExpiredUrl());
        return;
      }
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        const code = body?.detail?.code as string | undefined;
        if (code === "CONFLICTS") setConflicts(body.detail.conflicts ?? []);
        setError(errorText(code, body?.detail));
        if (code === "CONFLICTS") await refresh(dept.id, dest.floor.id);
        return;
      }
      setResult(body.move as Result);
    } catch {
      setError("네트워크 오류로 반영하지 못했어요");
    } finally {
      setBusy(false);
    }
  }

  const sources = [...new Set(moving.flatMap((m) => (m.seat ? [m.seat.floor_id] : [])))];

  return (
    <main className={ui.page}>
      <header className={ui.header}>
        <div className={ui.titleRow}>
          <h1 className={ui.title}>팀 이사</h1>
          <span className={ui.roleChip}>
            <strong>{admin.role_label}</strong> · 목적지 {options.floors.length}개 층
          </span>
        </div>
      </header>
      <p className={ui.infoBar}>
        한 팀을 다른 층(또는 같은 층의 다른 자리)으로 한 번에 옮겨요. 날짜를 정하면 그날 0시에 모두 함께 바뀌고, 그
        전에는 배치 화면의 요청 목록에서 &lsquo;예정 취소&rsquo;로 되돌릴 수 있어요.
      </p>

      {result ? (
        <div className={styles.done}>
          <section className={`${ui.card} ${ui.selected}`} aria-live="polite">
            <h2 className={ui.cardTitle}>
              {result.department} → {destName}:{" "}
              {result.scheduled ? `${shortDate(result.effective_at)} 0시에 옮겨요` : "옮겼어요"}
            </h2>
            <p className={ui.hint}>
              새 자리 {result.moved}명{result.unassigned > 0 && ` · 미배치 ${result.unassigned}명`}. 자리가 바뀌는
              사람에게 알림이 가요.
              {result.scheduled && " 그 전에 취소하려면 목적지 층 배치 화면의 요청 목록에서 '예정 취소'를 누르세요."}
            </p>
            <div className={ui.rowButtons}>
              <Link className={`${ui.btn} ${ui.pri}`} href={`/admin/seating?floor=${dest?.floor.id ?? ""}`}>
                {destName} 배치 화면으로
              </Link>
              {sources
                .filter((id) => id !== dest?.floor.id)
                .map((id) => {
                  const m = moving.find((x) => x.seat?.floor_id === id);
                  return (
                    <Link key={id} className={ui.btn} href={`/admin/seating?floor=${id}`}>
                      {m?.seat?.floor} 배치 화면 (옛 구역 정리)
                    </Link>
                  );
                })}
              <button type="button" className={ui.btn} onClick={() => void chooseTeam("")}>
                다른 팀 옮기기
              </button>
            </div>
          </section>
        </div>
      ) : (
        <div className={styles.body}>
          <div className={styles.steps}>
            <section className={ui.card} aria-labelledby="step-team">
              <h2 id="step-team" className={ui.cardTitle}>
                1. 옮길 팀
              </h2>
              <select
                className={ui.select}
                aria-label="옮길 팀"
                value={deptId}
                onChange={(e) => void chooseTeam(e.target.value)}
              >
                <option value="">팀을 고르세요</option>
                {[...new Set(options.departments.map((d) => d.parent ?? ""))].map((parent) => (
                  <optgroup key={parent} label={parent || "본부"}>
                    {options.departments
                      .filter((d) => (d.parent ?? "") === parent)
                      .map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name} ({d.members}명)
                        </option>
                      ))}
                  </optgroup>
                ))}
              </select>
              {members && (
                <p className={ui.hint}>
                  지금 자리 있음 {members.filter((m) => m.seat).length}명 · 미배치{" "}
                  {members.filter((m) => !m.seat).length}명
                  {members.some((m) => m.locked) &&
                    ` · 날짜를 정한 변경이 걸려 옮길 수 없음 ${members.filter((m) => m.locked).length}명`}
                </p>
              )}
            </section>

            <section className={ui.card} aria-labelledby="step-floor">
              <h2 id="step-floor" className={ui.cardTitle}>
                2. 옮길 곳
              </h2>
              <select
                className={ui.select}
                aria-label="옮길 층"
                value={floorId}
                onChange={(e) => void chooseFloor(e.target.value)}
              >
                <option value="">층을 고르세요</option>
                {options.floors.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.site} {f.name}
                  </option>
                ))}
              </select>
              {dest && (
                <>
                  <p className={ui.hint}>
                    빈 고정석 {freeSeats.length}석 · 고른 자리 {targets.length}석. 구역을 누르면 그 구역의 빈 자리를
                    모두 고르고, 도면에서 자리를 눌러 더하거나 뺄 수 있어요.
                  </p>
                  <ul className={styles.zoneChips}>
                    {[...dest.zones, null].map((z) => {
                      const zoneFree = freeSeats.filter((s) => s.zone_id === (z?.id ?? null));
                      const free = zoneFree.length;
                      if (!z && free === 0) return null;
                      // 이 구역의 빈 자리를 그대로 고른 상태면 눌린 칩 (화면 낭독기에도 알린다)
                      const picked = free > 0 && free === targets.length && zoneFree.every((s) => targets.includes(s.id));
                      return (
                        <li key={z?.id ?? "none"}>
                          <button
                            type="button"
                            data-color={z?.color_key ?? "t0"}
                            style={zoneColorVars(z?.color_key)}
                            aria-pressed={picked}
                            disabled={free === 0}
                            onClick={() => takeZone(z?.id ?? null)}
                          >
                            <span className={ui.swatch} aria-hidden="true" />
                            {z ? `${z.name} · ${z.code}` : "구역 없는 자리"}
                            <small>빈 자리 {free}</small>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </section>

            {members && dest && (
              <section className={ui.card} aria-labelledby="step-match">
                <div className={ui.cardHead}>
                  <h2 id="step-match" className={ui.cardTitle}>
                    3. 사람과 자리 맞추기
                  </h2>
                  <button type="button" className={ui.btn} disabled={targets.length === 0} onClick={() => autoMatch()}>
                    순서대로 맞추기
                  </button>
                </div>
                <ul className={styles.people}>
                  {(members ?? []).map((m) => {
                    const value = choiceOf(m.emp_no);
                    const conflict = conflicts.find((c) => String(c.seat_id) === value);
                    return (
                      <li key={m.emp_no} data-locked={m.locked || undefined}>
                        <span>
                          {m.name} {m.rank}
                          <small>
                            지금 {m.seat ? placeOf(m.seat, dest?.floor.site.name) : "미배치"}
                            {m.locked && " · 날짜를 정한 변경이 있어 옮길 수 없어요"}
                          </small>
                        </span>
                        <select
                          aria-label={`${m.name} 님 새 자리`}
                          value={value}
                          disabled={m.locked}
                          aria-invalid={!!conflict || undefined}
                          onChange={(e) => {
                            setPlan({ ...plan, [m.emp_no]: e.target.value });
                            setConflicts([]);
                          }}
                        >
                          <option value={STAY}>옮기지 않음</option>
                          {m.seat && <option value={UNASSIGN}>미배치로 (지금 자리만 비우기)</option>}
                          {targets
                            .map((id) => seatById.get(id))
                            .filter((s): s is SeatingSeat => !!s)
                            .sort(byCode)
                            .map((s) => {
                              const taken = whoSits.get(s.id);
                              return (
                                <option key={s.id} value={s.id} disabled={!!taken && taken !== m.emp_no}>
                                  {dest.floor.name} {s.code}
                                  {taken && taken !== m.emp_no ? ` (${nameOf.get(taken)})` : ""}
                                </option>
                              );
                            })}
                        </select>
                      </li>
                    );
                  })}
                </ul>
                <p className={ui.hint}>
                  새 자리 {toSeat.length}명 · 미배치로 {toUnassigned.length}명 · 그대로{" "}
                  {(members?.length ?? 0) - moving.length}명. 새 자리에 앉으면 지금 자리는 같은 시각에 비워져요.
                </p>
              </section>
            )}

            {members && dest && (
              <section className={ui.card} aria-labelledby="step-when">
                <h2 id="step-when" className={ui.cardTitle}>
                  4. 언제
                </h2>
                <fieldset className={ui.when}>
                  <legend>옮기는 날</legend>
                  <label>
                    <input
                      type="radio"
                      name="move-when"
                      checked={!when.later}
                      onChange={() => setWhen({ ...when, later: false })}
                    />
                    지금 바로
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="move-when"
                      checked={when.later}
                      onChange={() => setWhen({ ...when, later: true })}
                    />
                    날짜 지정
                    <input
                      type="date"
                      className={ui.dateInput}
                      aria-label="옮기는 날"
                      value={when.date}
                      min={addDays(todayKst(), 1)}
                      max={addDays(todayKst(), MAX_SCHEDULE_DAYS)}
                      onChange={(e) => setWhen({ later: true, date: e.target.value })}
                      // 날짜 칸에 들어가면 "날짜 지정"을 고른 것 (보이는 날짜 그대로 쓰려는 사람도 있다)
                      onFocus={() => !when.later && setWhen({ ...when, later: true })}
                    />
                    <span className={ui.muted}>그날 0시</span>
                  </label>
                </fieldset>
                {otherZones.length > 0 && (
                  <fieldset className={ui.when}>
                    <legend>구역 이름표</legend>
                    {otherZones.map((z) => (
                      <label key={z.id}>
                        <input
                          type="checkbox"
                          checked={zoneIds.includes(z.id)}
                          onChange={(e) =>
                            setZoneIds(e.target.checked ? [...zoneIds, z.id] : zoneIds.filter((id) => id !== z.id))
                          }
                        />
                        {z.name} · {z.code}구역을 {dept?.name} 구역으로 바꾸기 (바로)
                      </label>
                    ))}
                    <p className={ui.hint}>
                      바꾸지 않으면 옮긴 사람 자리에 &lsquo;타팀&rsquo;이 붙어요. 다른 팀 사람이 앉아 있는 구역은 바꿀
                      수 없어요.
                    </p>
                  </fieldset>
                )}
                <label className={ui.noteField}>
                  <span>메모 (요청 목록에 남아요, 선택)</span>
                  <input
                    value={note}
                    maxLength={200}
                    placeholder="예: 11월 조직 개편"
                    onChange={(e) => setNote(e.target.value)}
                  />
                </label>
                {error && (
                  <p className={ui.fieldError} role="alert">
                    {error}
                  </p>
                )}
                <button
                  type="button"
                  className={`${ui.btn} ${ui.pri}`}
                  disabled={busy || moving.length === 0}
                  onClick={() => void submit()}
                >
                  {busy
                    ? "반영 중…"
                    : when.later
                      ? `${shortDate(`${when.date}T00:00:00+09:00`)} 이사 예약하기 (${moving.length}명)`
                      : `지금 옮기기 (${moving.length}명)`}
                </button>
              </section>
            )}
            {!members && !error && deptId && <p className={ui.hint}>불러오는 중…</p>}
            {error && !(members && dest) && (
              <p className={ui.fieldError} role="alert">
                {error}
              </p>
            )}
          </div>

          <section className={`${ui.card} ${styles.mapCard}`} aria-label="옮길 곳 도면">
            {drawing && dest ? (
              <>
                <h2 className={ui.cardTitle}>
                  {dest.floor.site.name} {dest.floor.name}
                </h2>
                <FloorSvg
                  drawing={drawing}
                  className={styles.map}
                  label={`${dest.floor.name} 도면. 빈 자리를 누르면 고른 자리에 넣거나 뺍니다`}
                  onSeatClick={(seat) => {
                    const s = seatById.get(Number(seat.id));
                    if (s && (isFree(s) || targets.includes(s.id))) toggleSeat(s.id);
                  }}
                  seatTitle={(seat) =>
                    seat.state === "target"
                      ? `${seat.code} · ${seat.name ?? ""} (누르면 빼기)`
                      : seat.state === "free"
                        ? `${seat.code} · 빈 자리 (누르면 고르기)`
                        : `${seat.code}${seat.name ? ` · ${seat.name}` : ""}`
                  }
                />
                <p className={ui.hint}>
                  파란 테두리 = 고른 자리(맞춘 사람 이름), 점선 = 빈 고정석. 회색 자리는 이미 사람이 있거나 자율석·사용
                  중지예요.
                </p>
              </>
            ) : (
              <p className={ui.hint}>옮길 층을 고르면 여기에 도면이 보여요.</p>
            )}
          </section>
        </div>
      )}
    </main>
  );
}

function errorText(code: string | undefined, detail: { floor?: string; zone?: string } | undefined): string {
  switch (code) {
    case "CONFLICTS":
      return "그새 고른 자리 중 찬 곳이 있거나 날짜를 정한 변경이 걸렸어요. 다시 불러왔으니 확인하세요";
    case "FLOOR_ADMIN_ONLY":
      return `${detail?.floor ?? "그 층"}의 층 관리자 권한이 없어요. 미배치로 보내려면 그 사람이 앉은 층의 권한도 필요해요`;
    case "ZONE_OCCUPIED":
      return `${detail?.zone ?? "그 구역"}에는 다른 팀 사람이 앉아 있어 구역을 바꿀 수 없어요`;
    case "NOT_IN_TEAM":
      return "그새 팀이 바뀐 사람이 있어요. 팀을 다시 고르세요";
    case "SEAT_NOT_AVAILABLE":
      return "고정석이 아니거나 사용 중지된 자리가 있어요";
    case "BAD_DATE":
      return "날짜는 내일부터 1년 안에서 고르세요";
    default:
      return "반영하지 못했어요. 잠시 뒤 다시 시도하세요";
  }
}
