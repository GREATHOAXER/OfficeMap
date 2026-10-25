"use client";

import { useRouter } from "next/navigation";
import { type DragEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Dialog from "@/components/Dialog";
import PendingButton from "@/components/PendingButton";
import { SearchIcon } from "@/components/icons";
import type {
  Admin,
  ChangeRequestRow,
  ChangeSet,
  FloorEvent,
  SeatMode,
  SeatingData,
  SeatingSearchHit,
  SeatingSeat,
  SeatingZone,
  UnassignedPerson,
} from "@/lib/api";
import { addDays, kstDate, shortDate } from "@/lib/dates";
import { useNow } from "@/lib/useNow";
import { autoRects, zoneRects } from "@/lib/zoneShape";
import {
  baseMode,
  baseOccupant,
  type Change,
  changesOf,
  conflictText,
  conflictsOf,
  draftFromChangeSet,
  layoutOf,
  MODE_LABEL,
  moveZone,
  type Person,
  payloadOf,
  place,
  type SeatDraft,
  setMode,
  swap,
  toPanel,
  unassign,
} from "@/lib/seating";
import SeatingCanvas, { type SeatView } from "./SeatingCanvas";
import ZoneDialog, { type ZoneDialogState } from "./ZoneDialog";
import styles from "./seating.module.css";

type Tool = "move" | "swap" | "clear" | "zone";
/** 눌러서 옮기기: 집어 든 사람(미배치 칸·옮기기 버튼) 또는 교환할 첫 좌석 */
type Pick = { kind: "person"; emp: string } | { kind: "seat"; seatId: number } | null;
type SaveState = { state: "clean" | "dirty" | "saving" | "saved" | "error"; message?: string };
type Confirm = { title: string; body: string; action: string; danger?: boolean; run: () => Promise<void> };
type Toast = { text: string; tone?: "error" } | null;
type ServerConflict = { seat_id: number; reason: string; current?: string | null; name?: string };
type Applied = { id: number; effective_at: string; scheduled: boolean; changed: number };
type ApiResult = {
  ok: boolean;
  status: number;
  data: { detail?: { code?: string; conflicts?: ServerConflict[] }; applied?: Applied } | null;
};

const ZOOM_STEPS = [0.75, 1, 1.25, 1.5, 2];
const SAVE_DELAY_MS = 800; // 마지막으로 바꾸고 이만큼 쉬면 자동 저장
const HISTORY_MAX = 50;
const MAX_SCHEDULE_DAYS = 365;
const EXPIRED = "/admin/login?reason=expired&next=/admin/seating";
// 화면 폭(왼쪽 메뉴를 뺀 본문)에 따라 단 수를 정한다. 세 단: 도구·미배치 | 도면 | 좌석·변경,
// 두 단: 도면 | 좌석·미배치·변경·도구 (미배치 인원이 도면 옆에 오게), 한 단: 위에서 아래로
const THREE_COLUMNS_PX = 1240;
const TWO_COLUMNS_PX = 760;

const todayKst = () => kstDate(new Date().toISOString());
const json = { "content-type": "application/json" };

type Effective = { on: boolean; date: string };
const effectiveOf = (cs: ChangeSet | null): Effective =>
  cs?.effective_at ? { on: true, date: kstDate(cs.effective_at) } : { on: false, date: addDays(todayKst(), 1) };

function noteOf(p: UnassignedPerson): string {
  if (p.new_hire) return "신규 입사";
  if (p.released_at) return `자리 해제 ${kstDate(p.released_at).slice(5)}`;
  return "자리 없음";
}

type Props = { admin: Admin; initial: SeatingData; notice: string | null };

/** ⑤ 좌석 배치 편집: 끌어다 놓아 배치하고, 작업 묶음으로 모아 한 번에 반영(또는 승인 요청)한다 */
export default function SeatingEditor({ admin, initial, notice }: Props) {
  const router = useRouter();
  const [data, setData] = useState(initial);
  const floorId = data.floor.id;
  const perms = data.permissions;
  const pending = data.draft?.status === "PENDING";

  const [draft, setDraft] = useState<SeatDraft>(() => draftFromChangeSet(initial.draft, initial.seats));
  const [history, setHistory] = useState<SeatDraft[]>([]);
  const [draftId, setDraftId] = useState<number | null>(initial.draft?.id ?? null);
  const [effective, setEffective] = useState<Effective>(() => effectiveOf(initial.draft));
  const [note, setNote] = useState(initial.draft?.note ?? "");
  const [save, setSave] = useState<SaveState>({ state: initial.draft ? "saved" : "clean" });
  const [serverConflicts, setServerConflicts] = useState<Map<number, string>>(() => new Map());

  const [tool, setTool] = useState<Tool>("move");
  // 팀 구역 지정: 좌석을 넣을 구역 (null = 구역 없음으로 빼기)
  const [zoneTarget, setZoneTarget] = useState<number | null>(() => initial.zones.find((z) => z.editable)?.id ?? null);
  const [zoneDialog, setZoneDialog] = useState<ZoneDialogState | null>(null);
  const [pick, setPick] = useState<Pick>(null);
  const [selectedSeatId, setSelectedSeatId] = useState<number | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<number | null>(null);
  const [panelOver, setPanelOver] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [preview, setPreview] = useState(false);
  const [focusMine, setFocusMine] = useState(true);
  const [review, setReview] = useState<ChangeSet | null>(null);
  const [staged, setStaged] = useState<Person[]>([]);
  const [toast, setToast] = useState<Toast>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [rejecting, setRejecting] = useState<{ id: number; comment: string; error: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const pageRef = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState<1 | 2 | 3>(2);
  const wide = cols === 3;

  useEffect(() => {
    const el = pageRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      setCols(width >= THREE_COLUMNS_PX ? 3 : width >= TWO_COLUMNS_PX ? 2 : 1);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // 이벤트 처리·자동 저장에서 읽는 최신 값
  const latest = useRef({ draft, effective, note, seats: data.seats, data });
  useEffect(() => {
    latest.current = { draft, effective, note, seats: data.seats, data };
  });

  const showToast = useCallback((text: string, tone?: "error") => setToast({ text, tone }), []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), toast.tone === "error" ? 6000 : 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  // 사람 목록: 지금 앉은 사람, 미배치 인원, 묶음에 나오는 사람, 찾아서 더한 사람
  const people = useMemo(() => {
    const map = new Map<string, Person>();
    for (const seat of data.seats) {
      if (seat.occupant?.kind !== "FIXED") continue;
      map.set(seat.occupant.emp_no, {
        ...seat.occupant,
        locked: !!seat.upcoming,
        lockText: seat.upcoming ? `${shortDate(seat.upcoming.at)} 자리 변경이 예정돼 있어요` : undefined,
      });
    }
    for (const p of data.unassigned) {
      map.set(p.emp_no, {
        ...p,
        note: noteOf(p),
        locked: !!p.upcoming,
        lockText: p.upcoming ? `${shortDate(p.upcoming.at)}부터 ${p.upcoming.seat}` : undefined,
      });
    }
    for (const cs of [data.draft, review]) {
      for (const p of Object.values(cs?.people ?? {})) if (!map.has(p.emp_no)) map.set(p.emp_no, p);
    }
    for (const p of staged) if (!map.has(p.emp_no)) map.set(p.emp_no, p);
    return map;
  }, [data, review, staged]);

  const allowedDepts = useMemo(
    () =>
      perms.mode === "FLOOR"
        ? null
        : new Set(
            data.zones.filter((z) => perms.zones?.includes(z.id) && z.department_id).map((z) => z.department_id!),
          ),
    [data.zones, perms],
  );
  const canMove = useCallback(
    (p: Person | undefined) => !!p && !p.locked && (!allowedDepts || allowedDepts.has(p.department_id)),
    [allowedDepts],
  );

  // 화면에 보여 줄 묶음: 검토 중이면 그 요청, 아니면 내 묶음
  const reviewDraft = useMemo(() => (review ? draftFromChangeSet(review, data.seats) : null), [review, data.seats]);
  const shown = reviewDraft ?? draft;
  const layout = useMemo(() => layoutOf(data.seats, shown), [data.seats, shown]);
  const zoneOf = layout.zoneOf;
  const readOnly = preview || pending || !!review;
  // 구역 경계를 바꾸면 반영 전에 바뀔 모양을 미리 계산해서 그린다 (서버도 같은 방법으로 저장한다)
  const zoneMoved = Object.keys(shown.zones).length > 0;
  const autoShapes = useMemo(() => {
    if (!zoneMoved) return null;
    const members = new Map<number, { x: number; y: number }[]>();
    for (const seat of data.seats) {
      const zoneId = layout.zoneOf(seat);
      if (zoneId !== null) members.set(zoneId, [...(members.get(zoneId) ?? []), seat]);
    }
    return new Map([...members].map(([zoneId, seats]) => [zoneId, autoRects(seats)]));
  }, [zoneMoved, data.seats, layout]);
  const rectsOf = useCallback(
    (zone: SeatingZone) => (autoShapes ? (autoShapes.get(zone.id) ?? []) : zoneRects(zone.shape)),
    [autoShapes],
  );

  const changes = useMemo(() => changesOf(shown, data.seats, people), [shown, data.seats, people]);
  const conflicts = useMemo(() => {
    const map = conflictsOf(shown, data.seats, people);
    if (!review) for (const [seatId, text] of serverConflicts) map.set(seatId, text);
    return map;
  }, [shown, data.seats, people, review, serverConflicts]);
  const changedSeats = useMemo(() => new Set(changes.map((c) => c.seatId)), [changes]);
  const myZones = useMemo(() => (perms.mode === "ZONE" ? new Set(perms.zones ?? []) : null), [perms]);
  const focusZones = myZones && focusMine && !preview ? myZones : null;
  // 좌석 유형·구역 변경은 날짜를 정할 수 없다 (좌석에는 날짜가 없어서 바로 바뀐다)
  const hasTypes = Object.keys(draft.modes).length > 0 || Object.keys(draft.zones).length > 0;
  const changeCount = changes.length;
  // 구역 관리자가 구역 경계를 바꾸면 언제나 층 관리자 승인 후 반영
  const needsApproval =
    perms.apply === "NEEDS_APPROVAL" || (perms.mode === "ZONE" && Object.keys(draft.zones).length > 0);
  /** 이 좌석에 사람·유형을 바꿀 수 있나: 층 관리자 이상은 어디든, 구역 관리자는 (반영하면) 내 구역인 좌석 */
  const editable = useCallback(
    (seat: SeatingSeat) => perms.mode === "FLOOR" || (myZones?.has(layout.zoneOf(seat) ?? -1) ?? false),
    [perms.mode, myZones, layout],
  );
  const zoneName = useCallback(
    (zoneId: number | null) => {
      const zone = data.zones.find((z) => z.id === zoneId);
      return zone ? `${zone.name} · ${zone.code}구역` : "구역 없음";
    },
    [data.zones],
  );

  // 자동 저장 ------------------------------------------------------------------
  const dirtyRef = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const inflight = useRef<Promise<boolean> | null>(null);

  const flush = useCallback(async (): Promise<boolean> => {
    clearTimeout(saveTimer.current);
    if (inflight.current) await inflight.current;
    if (!dirtyRef.current) return true;
    dirtyRef.current = false;
    const { draft: d, effective: eff, note: memo, seats } = latest.current;
    setSave({ state: "saving" });
    const run = (async () => {
      try {
        const res = await fetch(`/api/admin/floors/${floorId}/change-set`, {
          method: "PUT",
          headers: json,
          body: JSON.stringify({
            ...payloadOf(d, seats),
            effective_date: eff.on ? eff.date : null,
            note: memo.trim() || null,
          }),
        });
        if (res.status === 401) {
          router.replace(EXPIRED);
          return false;
        }
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          dirtyRef.current = true;
          setSave({ state: "error", message: saveErrorText(body?.detail?.code) });
          return false;
        }
        const out = await res.json();
        setDraftId(out.draft?.id ?? null);
        setSave({ state: out.draft ? "saved" : "clean" });
        return true;
      } catch {
        dirtyRef.current = true;
        setSave({ state: "error", message: "네트워크 오류" });
        return false;
      }
    })();
    inflight.current = run;
    const ok = await run;
    inflight.current = null;
    return ok;
  }, [floorId, router]);

  const markDirty = useCallback(() => {
    dirtyRef.current = true;
    setSave({ state: "dirty" });
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void flush(), SAVE_DELAY_MS);
  }, [flush]);

  useEffect(() => () => clearTimeout(saveTimer.current), []);

  // 저장 안 된 변경이 있으면 창을 닫기 전에 묻는다
  useEffect(() => {
    function onBeforeUnload(event: BeforeUnloadEvent) {
      if (dirtyRef.current || inflight.current) event.preventDefault();
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  function commit(next: SeatDraft) {
    if (next === draft) return;
    setHistory((h) => [...h.slice(-(HISTORY_MAX - 1)), draft]);
    setDraft(next);
    setServerConflicts(new Map());
    // 유형·구역 변경이 생기면 날짜 지정을 쓸 수 없다
    if ((Object.keys(next.modes).length > 0 || Object.keys(next.zones).length > 0) && effective.on) {
      setEffective((e) => ({ ...e, on: false }));
    }
    markDirty();
  }

  function undo() {
    const prev = history.at(-1);
    if (!prev) return;
    setHistory((h) => h.slice(0, -1));
    setDraft(prev);
    setServerConflicts(new Map());
    markDirty();
    showToast("방금 바꾼 것을 되돌렸어요");
  }

  // 서버에서 다시 읽기 --------------------------------------------------------
  const resetFrom = useCallback((next: SeatingData) => {
    setDraft(draftFromChangeSet(next.draft, next.seats));
    setHistory([]);
    setDraftId(next.draft?.id ?? null);
    setEffective(effectiveOf(next.draft));
    setNote(next.draft?.note ?? "");
    dirtyRef.current = false;
    clearTimeout(saveTimer.current);
    setSave({ state: next.draft ? "saved" : "clean" });
    setServerConflicts(new Map());
    setPick(null);
  }, []);

  const reload = useCallback(
    async (reset: boolean) => {
      const res = await fetch(`/api/admin/floors/${floorId}/seating`, { cache: "no-store" });
      if (res.status === 401) {
        router.replace(EXPIRED);
        return;
      }
      if (!res.ok) return;
      const next = (await res.json()) as SeatingData;
      const wasPending = latest.current.data.draft?.status === "PENDING";
      setData(next);
      // 다른 탭에서 승인 요청을 했거나, 요청이 승인·반려됐으면 내 화면도 그 상태로
      if (reset || wasPending !== (next.draft?.status === "PENDING") || (wasPending && !next.draft)) {
        resetFrom(next);
        return;
      }
      // 없어진 구역으로 옮기던 좌석은 묶음에서 뺀다
      const alive = new Set(next.zones.map((z) => z.id));
      const stale = Object.entries(latest.current.draft.zones).filter(([, z]) => z !== null && !alive.has(z));
      if (stale.length) {
        const zones = { ...latest.current.draft.zones };
        for (const [seatId] of stale) delete zones[Number(seatId)];
        setDraft({ ...latest.current.draft, zones });
        markDirtyRef.current();
      }
      setZoneTarget((t) => (t === null || alive.has(t) ? t : null));
    },
    [floorId, router, resetFrom],
  );
  const markDirtyRef = useRef(markDirty);
  useEffect(() => {
    markDirtyRef.current = markDirty;
  });
  const reloadRef = useRef(reload);
  useEffect(() => {
    reloadRef.current = reload;
  });

  // 다른 관리자가 이 층에 반영하면 바로 다시 읽는다 (내 묶음은 그대로 두고, 겹치면 충돌로 표시)
  useEffect(() => {
    let source: EventSource | null = null;
    let refetchTimer: ReturnType<typeof setTimeout> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const refetch = () => {
      clearTimeout(refetchTimer);
      refetchTimer = setTimeout(() => void reloadRef.current(false), 300);
    };
    function connect() {
      source = new EventSource("/api/admin/stream");
      source.addEventListener("floor", (event) => {
        const change = JSON.parse((event as MessageEvent<string>).data) as FloorEvent;
        if (change.floor_id === floorId) refetch();
      });
      source.addEventListener("resync", refetch);
      source.addEventListener("error", () => {
        if (source?.readyState === EventSource.CLOSED) void retry();
      });
    }
    async function retry() {
      const res = await fetch("/api/admin/auth/session").catch(() => null);
      if (stopped) return;
      if (res?.status === 401) {
        router.replace(EXPIRED);
        return;
      }
      retryTimer = setTimeout(() => {
        connect();
        refetch();
      }, 5000);
    }
    connect();
    return () => {
      stopped = true;
      clearTimeout(refetchTimer);
      clearTimeout(retryTimer);
      source?.close();
    };
  }, [floorId, router]);

  // 키보드: Esc로 집어 든 것·고른 좌석을 놓는다
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || (event.target as Element).closest("input, textarea, select, dialog")) return;
      if (pick) setPick(null);
      else setSelectedSeatId(null);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [pick]);

  // 놓기 ----------------------------------------------------------------------

  /** 이 좌석에 사람을 놓을 수 없는 이유 */
  function blockReason(seat: SeatingSeat, emp: string | null): string | null {
    if (!editable(seat)) return "다른 구역이에요 · 층 관리자에게 요청하세요";
    if (seat.upcoming) return `${shortDate(seat.upcoming.at)} 변경이 예정된 자리라 그날까지 바꿀 수 없어요`;
    const mode = layout.mode(seat);
    if (mode === "FLEX") return "자율석에는 배정하지 않아요 · 오른쪽에서 고정석으로 바꾼 뒤 놓으세요";
    if (mode === "OUT_OF_SERVICE") return "사용 중지된 자리예요";
    const there = layout.occupant(seat.id);
    if (emp && there && there !== emp && layout.seatOf(emp) !== undefined && !canMove(people.get(there))) {
      return `${people.get(there)?.name ?? there} 님은 옮길 수 없어서 자리를 바꿀 수 없어요`;
    }
    return null;
  }

  function placeOn(seat: SeatingSeat, emp: string) {
    const reason = blockReason(seat, emp);
    if (reason) {
      showToast(reason, "error");
      return;
    }
    const there = layout.occupant(seat.id);
    const from = layout.seatOf(emp);
    commit(place(draft, data.seats, emp, seat.id));
    const name = (e: string) => people.get(e)?.name ?? e;
    if (there && there !== emp) {
      showToast(
        from !== undefined
          ? `${name(emp)} ↔ ${name(there)} 자리를 바꿨어요`
          : `${name(there)} 님은 미배치 인원으로 옮겼어요`,
      );
    }
  }

  function clearSeat(seat: SeatingSeat) {
    if (!editable(seat) || seat.upcoming) {
      showToast(blockReason(seat, null) ?? "바꿀 수 없는 자리예요", "error");
      return;
    }
    const emp = layout.occupant(seat.id);
    if (!emp) return;
    commit(unassign(draft, data.seats, seat.id));
    showToast(`${people.get(emp)?.name ?? emp} 님을 미배치 인원으로 옮겼어요`);
  }

  function onSeatClick(seat: SeatingSeat) {
    if (readOnly) {
      setSelectedSeatId(seat.id);
      return;
    }
    if (pick?.kind === "person") {
      placeOn(seat, pick.emp);
      setPick(null);
      setSelectedSeatId(seat.id);
      return;
    }
    if (tool === "clear") {
      setSelectedSeatId(seat.id);
      clearSeat(seat);
      return;
    }
    if (tool === "zone") {
      setSelectedSeatId(seat.id);
      intoZone([seat.id]);
      return;
    }
    if (tool === "swap") {
      if (pick?.kind === "seat") {
        if (pick.seatId !== seat.id) swapSeats(pick.seatId, seat.id);
        setPick(null);
      } else if (!editable(seat) || seat.upcoming || layout.mode(seat) !== "FIXED") {
        showToast(blockReason(seat, null) ?? "고정석끼리만 바꿀 수 있어요", "error");
      } else {
        setPick({ kind: "seat", seatId: seat.id });
      }
      setSelectedSeatId(seat.id);
      return;
    }
    setSelectedSeatId(seat.id === selectedSeatId ? null : seat.id);
  }

  function swapSeats(a: number, b: number) {
    const seatB = data.seats.find((s) => s.id === b)!;
    const reason =
      !editable(seatB) || seatB.upcoming || layout.mode(seatB) !== "FIXED" ? blockReason(seatB, null) : null;
    const movers = [layout.occupant(a), layout.occupant(b)].filter((e): e is string => !!e);
    const stuck = movers.find((e) => !canMove(people.get(e)));
    if (reason || stuck) {
      showToast(reason ?? `${people.get(stuck!)?.name ?? stuck} 님은 옮길 수 없어요`, "error");
      return;
    }
    if (movers.length === 0) return;
    commit(swap(draft, data.seats, a, b));
    const codes = data.seats.filter((s) => s.id === a || s.id === b).map((s) => s.code);
    showToast(`${codes.join(" ↔ ")} 자리를 바꿨어요`);
  }

  /** 팀 구역 지정: 좌석들을 고른 구역에 넣는다. 구역 관리자는 내 구역으로 넣거나 내 구역에서 빼는 것만 */
  function intoZone(seatIds: number[]) {
    const target = zoneTarget;
    const seats = data.seats.filter((s) => seatIds.includes(s.id) && layout.zoneOf(s) !== target);
    const allowed = seats.filter(
      (s) =>
        perms.mode === "FLOOR" || myZones?.has(layout.zoneOf(s) ?? -1) || (target !== null && myZones?.has(target)),
    );
    if (allowed.length === 0) {
      showToast(
        seats.length ? "내 구역에 넣거나 내 구역에서 빼는 좌석만 고를 수 있어요" : `이미 ${zoneName(target)}이에요`,
        seats.length ? "error" : undefined,
      );
      return;
    }
    commit(
      moveZone(
        draft,
        data.seats,
        allowed.map((s) => s.id),
        target,
      ),
    );
    const skipped = seats.length - allowed.length;
    showToast(
      `${allowed.length === 1 ? allowed[0].code : `${allowed.length}석`} → ${zoneName(target)}${
        skipped ? ` (다른 구역끼리 옮기는 ${skipped}석은 뺐어요)` : ""
      }`,
    );
  }

  function onDragStartPerson(emp: string, event: DragEvent) {
    event.dataTransfer.setData("text/plain", emp);
    event.dataTransfer.effectAllowed = "move";
    setDragging(emp);
    setPick(null);
  }
  function endDrag() {
    setDragging(null);
    setDragOverId(null);
    setPanelOver(false);
  }

  // 미배치 칸 ------------------------------------------------------------------

  const baseSeatCode = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of data.seats) {
      const b = baseOccupant(s);
      if (b) map.set(b, s.code);
    }
    return map;
  }, [data.seats]);
  const panel = useMemo(() => {
    const out: (Person & { tag: string })[] = [];
    const seen = new Set<string>();
    const push = (p: Person | undefined, tag: string) => {
      if (!p || seen.has(p.emp_no) || layout.seatOf(p.emp_no) !== undefined) return;
      seen.add(p.emp_no);
      out.push({ ...p, tag });
    };
    for (const p of data.unassigned) push(people.get(p.emp_no), people.get(p.emp_no)?.note ?? "");
    for (const [emp, code] of baseSeatCode) push(people.get(emp), `${code}에서 뺌`);
    for (const p of staged) push(people.get(p.emp_no), p.seat ? `지금 ${p.seat.floor} ${p.seat.code}` : "자리 없음");
    return out;
  }, [data.unassigned, people, baseSeatCode, staged, layout]);

  function onPanelDrop() {
    const emp = dragging;
    endDrag();
    const from = emp ? layout.seatOf(emp) : undefined;
    if (!emp || from === undefined) return;
    const seat = data.seats.find((s) => s.id === from)!;
    if (!editable(seat) || seat.upcoming) {
      showToast(blockReason(seat, null) ?? "바꿀 수 없는 자리예요", "error");
      return;
    }
    const { draft: next, restored } = toPanel(draft, data.seats, emp);
    commit(next);
    const name = (e: string) => people.get(e)?.name ?? e;
    showToast(
      restored
        ? `${name(emp)} 님을 미배치 인원으로 옮기고, ${seat.code} 자리는 원래대로 ${name(restored)} 님 자리로 돌렸어요`
        : `${name(emp)} 님을 미배치 인원으로 옮겼어요`,
    );
  }

  // 반영 · 승인 흐름 ------------------------------------------------------------

  async function post(path: string, body?: unknown): Promise<ApiResult> {
    const res = await fetch(path, {
      method: "POST",
      headers: body === undefined ? undefined : json,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401) router.replace(EXPIRED);
    return { ok: res.ok, status: res.status, data: await res.json().catch(() => null) };
  }

  function conflictMap(detail: { conflicts?: ServerConflict[] } | undefined): Map<number, string> {
    const map = new Map<number, string>();
    for (const c of detail?.conflicts ?? []) map.set(c.seat_id, conflictText(c.reason, c));
    return map;
  }

  async function applyNow() {
    if (changeCount === 0) {
      showToast("바꾼 것이 없어요. 사람을 끌어 자리에 놓아 보세요", "error");
      return;
    }
    if (conflicts.size > 0) {
      showToast(`충돌 ${conflicts.size}건이 있어요 · 빨간 표시 자리를 먼저 정리하세요`, "error");
      return;
    }
    setBusy(true);
    try {
      if (!(await flush()) || !draftId) {
        showToast("저장하지 못해서 반영하지 않았어요. 다시 시도하세요", "error");
        return;
      }
      const verb = needsApproval ? "submit" : "apply";
      const res = await post(`/api/admin/change-sets/${draftId}/${verb}`);
      if (res.ok && verb === "submit") {
        showToast(`승인을 요청했어요 · 층 관리자가 승인하면 반영돼요`);
        await reload(true);
      } else if (res.ok) {
        const applied = res.data!.applied!;
        showToast(
          applied.scheduled
            ? `${shortDate(applied.effective_at)}부터 바뀌어요 · 그 전에는 요청 목록에서 취소할 수 있어요`
            : `반영했어요 · 직원 화면에 바로 보여요 (${applied.changed}건)`,
        );
        setSelectedSeatId(null);
        await reload(true);
      } else if (res.data?.detail?.code === "CONFLICTS") {
        const map = conflictMap(res.data.detail);
        setServerConflicts(map);
        showToast(
          map.size
            ? `충돌 ${map.size}건 때문에 반영하지 않았어요 · 빨간 표시 자리를 확인하세요`
            : "그사이 다른 변경이 겹쳐 반영하지 않았어요 · 화면을 다시 불러왔어요",
          "error",
        );
        await reload(false);
      } else {
        showToast(actionErrorText(res.data?.detail?.code), "error");
      }
    } finally {
      setBusy(false);
    }
  }

  async function withdraw() {
    if (!draftId) return;
    setBusy(true);
    const res = await post(`/api/admin/change-sets/${draftId}/withdraw`);
    setBusy(false);
    if (res.ok) showToast("승인 요청을 거뒀어요 · 고친 뒤 다시 요청하세요");
    else showToast(actionErrorText(res.data?.detail?.code), "error");
    await reload(true);
  }

  function discard() {
    setConfirm({
      title: "바꾼 내용을 모두 버릴까요?",
      body: `미반영 변경 ${changeCount}건이 없어지고, 지금 배치 그대로 돌아가요.`,
      action: "모두 버리기",
      danger: true,
      run: async () => {
        clearTimeout(saveTimer.current);
        dirtyRef.current = false;
        await fetch(`/api/admin/floors/${floorId}/change-set`, { method: "DELETE" });
        await reload(true);
        showToast("바꾼 내용을 버렸어요");
      },
    });
  }

  async function openReview(row: ChangeRequestRow) {
    const res = await fetch(`/api/admin/change-sets/${row.id}`, { cache: "no-store" });
    if (res.status === 401) {
      router.replace(EXPIRED);
      return;
    }
    if (!res.ok) {
      showToast("요청을 불러오지 못했어요", "error");
      return;
    }
    setPick(null);
    setPreview(false);
    setServerConflicts(new Map());
    setReview((await res.json()) as ChangeSet);
  }

  async function approve() {
    if (!review) return;
    setBusy(true);
    const res = await post(`/api/admin/change-sets/${review.id}/approve`);
    setBusy(false);
    if (res.ok) {
      const applied = res.data!.applied!;
      showToast(
        applied.scheduled
          ? `승인했어요 · ${shortDate(applied.effective_at)}부터 바뀌어요`
          : `승인하고 반영했어요 · 직원 화면에 바로 보여요`,
      );
      setReview(null);
      await reload(false);
    } else if (res.data?.detail?.code === "CONFLICTS") {
      const map = conflictMap(res.data.detail);
      setServerConflicts(map);
      showToast(`충돌 ${map.size}건 때문에 승인하지 못했어요 · 반려하고 다시 요청받으세요`, "error");
    } else {
      showToast(actionErrorText(res.data?.detail?.code), "error");
      setReview(null);
      await reload(false);
    }
  }

  async function reject() {
    if (!rejecting) return;
    const comment = rejecting.comment.trim();
    if (!comment) {
      setRejecting({ ...rejecting, error: "반려 사유를 적어 주세요. 요청한 사람에게 그대로 보여요" });
      return;
    }
    setBusy(true);
    const res = await post(`/api/admin/change-sets/${rejecting.id}/reject`, { comment });
    setBusy(false);
    if (!res.ok) {
      setRejecting({ ...rejecting, error: actionErrorText(res.data?.detail?.code) });
      return;
    }
    setRejecting(null);
    setReview(null);
    showToast("반려했어요 · 요청한 사람이 사유를 보고 고쳐서 다시 요청할 수 있어요");
    await reload(false);
  }

  async function reopen(row: ChangeRequestRow) {
    setBusy(true);
    const res = await post(`/api/admin/change-sets/${row.id}/reopen`);
    setBusy(false);
    if (res.ok) {
      showToast("반려된 요청을 다시 고칠 수 있게 불러왔어요");
      await reload(true);
    } else {
      showToast(
        res.data?.detail?.code === "HAS_OPEN"
          ? "작성 중인 변경이 있어요 · 먼저 반영(요청)하거나 버린 뒤 다시 누르세요"
          : actionErrorText(res.data?.detail?.code),
        "error",
      );
    }
  }

  function cancelScheduled(row: ChangeRequestRow) {
    setConfirm({
      title: "예정된 변경을 취소할까요?",
      body: `${row.effective_at ? shortDate(row.effective_at) : ""}부터 바뀌기로 한 ${row.item_count}건이 없던 일이 되고, 지금 자리가 그대로 유지돼요.`,
      action: "예정 취소",
      danger: true,
      run: async () => {
        const res = await post(`/api/admin/change-sets/${row.id}/cancel`);
        if (res.ok) showToast("예정된 변경을 취소했어요");
        else showToast(actionErrorText(res.data?.detail?.code), "error");
        await reload(false);
      },
    });
  }

  function chooseTool(next: Tool) {
    setTool(next);
    setPick(null);
    if (next === "zone" && perms.mode === "ZONE") setZoneTarget(perms.zones?.[0] ?? null);
  }

  async function goFloor(id: number) {
    await flush();
    router.push(`/admin/seating?floor=${id}`);
  }

  function addStaged(hit: SeatingSearchHit) {
    const onThisFloor = layout.seatOf(hit.emp_no);
    if (onThisFloor !== undefined) {
      setSelectedSeatId(onThisFloor);
      document.querySelector(`[data-seat-id="${onThisFloor}"]`)?.scrollIntoView({ block: "center", inline: "center" });
      showToast(`${hit.name} 님은 이 층 ${data.seats.find((s) => s.id === onThisFloor)?.code}에 있어요`);
      return;
    }
    if (hit.locked) {
      showToast(`${hit.name} 님은 날짜를 정해 둔 자리 변경이 있어 그날까지 옮길 수 없어요`, "error");
      return;
    }
    if (!people.has(hit.emp_no) || !panel.some((p) => p.emp_no === hit.emp_no)) {
      setStaged((list) => [...list.filter((p) => p.emp_no !== hit.emp_no), { ...hit }]);
    }
    setTool("move");
    setPick({ kind: "person", emp: hit.emp_no });
  }

  // 화면 ----------------------------------------------------------------------

  const zoneDept = new Map(data.zones.map((z) => [z.id, z.department_id]));
  const viewOf = (seat: SeatingSeat): SeatView => {
    const emp = layout.occupant(seat.id);
    const person = emp ? people.get(emp) : undefined;
    const zoneId = zoneOf(seat);
    const zoneDepartment = zoneId !== null ? zoneDept.get(zoneId) : null;
    return {
      dropBlock:
        dragging || pick?.kind === "person" ? blockReason(seat, dragging ?? (pick as { emp: string }).emp) : null,
      draggable: tool !== "zone" && editable(seat) && !seat.upcoming && emp && canMove(person) ? emp : null,
      changed: changedSeats.has(seat.id),
      conflict: conflicts.get(seat.id) ?? null,
      dimmed: tool !== "zone" && !!focusZones && (zoneId === null || !focusZones.has(zoneId)),
      // 팀 구역에 다른 팀 사람이 앉아 있다 (구역을 옮겼거나 부서를 옮긴 사람)
      otherTeam: !!person && !!zoneDepartment && person.department_id !== zoneDepartment,
      editable: editable(seat),
    };
  };
  /** 구역마다 반영하면 될 좌석 수·앉은 사람 수 */
  const zoneStats = (zoneId: number) => {
    const seats = data.seats.filter((s) => layout.zoneOf(s) === zoneId);
    return { seats: seats.length, people: seats.filter((s) => layout.occupant(s.id)).length };
  };

  const selectedSeat = data.seats.find((s) => s.id === selectedSeatId) ?? null;
  const zoneNames = data.zones.filter((z) => myZones?.has(z.id)).map((z) => `${z.name} ${z.code}구역`);
  const teamNames = [
    ...new Set(data.zones.filter((z) => myZones?.has(z.id) && z.department).map((z) => z.department!)),
  ];
  const roleChip = `${data.floor.site.name} ${data.floor.name}${zoneNames.length ? ` · ${zoneNames.join(", ")}` : ""}`;
  const scheduledLabel = effective.on && !hasTypes ? `${shortDate(`${effective.date}T00:00:00+09:00`)}부터 ` : "";
  const primaryLabel = needsApproval ? "층 관리자에게 승인 요청" : `${scheduledLabel}반영하기`;

  let status: string;
  if (review) status = `검토 중 · ${review.requester}의 요청`;
  else if (pending) status = `승인 대기 중 · 변경 ${changeCount}건`;
  else if (save.state === "error") status = `저장하지 못했어요 (${save.message})`;
  else if (save.state === "dirty" || save.state === "saving") status = "저장 중…";
  else status = changeCount ? `미반영 변경 ${changeCount}건 · 자동 저장됨` : "변경 없음";

  const floorCard = data.floors.length > 1 && (
    <section className={styles.card}>
      <label className={styles.cardTitle} htmlFor="seating-floor">
        층
      </label>
      <select
        id="seating-floor"
        className={styles.select}
        value={floorId}
        onChange={(event) => void goFloor(Number(event.target.value))}
      >
        {data.floors.map((f) => (
          <option key={f.id} value={f.id}>
            {f.site} {f.name}
            {f.mode === "ZONE" ? " (내 구역)" : ""}
          </option>
        ))}
      </select>
    </section>
  );
  const toolChoices: [Tool, string][] = [
    ["move", "선택·이동"],
    ["swap", "자리 교환"],
    ["clear", "배정 해제"],
    ...(perms.mode === "FLOOR" ? [["zone", "팀 구역 지정"] as [Tool, string]] : []),
  ];
  const toolsCard = (
    <section className={styles.card} aria-labelledby="tools-title">
      <h2 id="tools-title" className={styles.cardTitle}>
        배치 도구
      </h2>
      <div className={styles.tools} role="radiogroup" aria-label="배치 도구">
        {toolChoices.map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={tool === value}
            className={styles.tool}
            disabled={readOnly}
            onClick={() => chooseTool(value)}
          >
            {label}
          </button>
        ))}
        {perms.mode === "FLOOR" ? (
          <>
            <PendingButton label="좌석 추가" className={styles.toolPending} />
            <PendingButton label="도면 수정" className={styles.toolPending} />
          </>
        ) : (
          ["팀 구역 지정", "좌석 추가", "도면 수정"].map((label) => (
            <button key={label} type="button" className={styles.tool} disabled title="층 관리자 이상만 사용">
              {label}
            </button>
          ))
        )}
      </div>
      <p className={styles.hint}>
        {tool === "move" && "사람을 끌어 놓거나, 미배치 인원을 누른 뒤 자리를 누르세요."}
        {tool === "swap" && "바꿀 두 자리를 차례로 누르세요."}
        {tool === "clear" && "비울 자리를 누르면 그 사람은 미배치 인원으로 가요."}
        {tool === "zone" && "아래에서 구역을 고르고, 좌석을 누르거나 끌어서 네모로 묶으세요."}{" "}
        {perms.mode === "FLOOR"
          ? "좌석 추가·도면 수정은 도면 편집에서 해요."
          : "잠긴 도구는 층 관리자 이상만 써요. 구역을 넓히려면 요청 목록의 \u201c구역 확장·변경 요청\u201d을 누르세요."}
      </p>
    </section>
  );
  const choosingZone = tool === "zone" && !readOnly;
  const zonesCard = (
    <section className={styles.card} aria-labelledby="zones-title">
      <div className={styles.cardHead}>
        <h2 id="zones-title" className={styles.cardTitle}>
          {data.floor.name} 팀 구역 · 관리자
        </h2>
        {perms.mode === "FLOOR" && !readOnly && (
          <button type="button" className={styles.linkButton} onClick={() => setZoneDialog({ mode: "create" })}>
            + 팀 구역 추가
          </button>
        )}
      </div>
      {choosingZone && <p className={styles.pickNote}>좌석을 넣을 구역을 고르세요</p>}
      <ul
        className={styles.zoneList}
        role={choosingZone ? "radiogroup" : undefined}
        aria-label={choosingZone ? "좌석을 넣을 구역" : undefined}
      >
        {data.zones.map((z) => {
          const stat = zoneStats(z.id);
          const choosable = choosingZone && (perms.mode === "FLOOR" || !!myZones?.has(z.id));
          const body = (
            <>
              <span className={styles.swatch} aria-hidden="true" />
              <span className={styles.zoneName}>
                <strong>
                  {z.name} · {z.code}
                </strong>
                <span>
                  좌석 {stat.seats} · {stat.people}명 · {z.managers.length ? z.managers.join(", ") : "구역 관리자 없음"}
                </span>
                {!z.department_active && <span className={styles.conflictText}>조직도에서 없어진 부서의 구역</span>}
              </span>
            </>
          );
          return (
            <li
              key={z.id}
              data-color={z.color_key}
              data-locked={(!z.editable && !choosable) || undefined}
              data-chosen={(choosable && zoneTarget === z.id) || undefined}
            >
              {choosable ? (
                <button
                  type="button"
                  role="radio"
                  aria-checked={zoneTarget === z.id}
                  className={styles.zoneChoose}
                  onClick={() => setZoneTarget(z.id)}
                >
                  {body}
                </button>
              ) : (
                body
              )}
              {perms.mode === "FLOOR" && !choosingZone && !readOnly ? (
                <button
                  type="button"
                  className={styles.linkButton}
                  onClick={() => setZoneDialog({ mode: "edit", zone: z })}
                  aria-label={`${z.name} ${z.code}구역 고치기`}
                >
                  고치기
                </button>
              ) : (
                <span className={styles.zoneRight}>{myZones?.has(z.id) ? "내 구역" : z.editable ? "" : "잠김"}</span>
              )}
            </li>
          );
        })}
        {choosingZone && (
          <li data-color="t0" data-chosen={zoneTarget === null || undefined}>
            <button
              type="button"
              role="radio"
              aria-checked={zoneTarget === null}
              className={styles.zoneChoose}
              onClick={() => setZoneTarget(null)}
            >
              <span className={styles.swatch} aria-hidden="true" />
              <span className={styles.zoneName}>
                <strong>구역 없음</strong>
                <span>{perms.mode === "FLOOR" ? "구역에서 빼기" : "내 구역에서 빼기"}</span>
              </span>
            </button>
          </li>
        )}
      </ul>
      {data.zones.length === 0 && <p className={styles.empty}>이 층에는 팀 구역이 아직 없어요.</p>}
    </section>
  );
  const peopleCard = (
    <section
      className={styles.card}
      aria-labelledby="unassigned-title"
      data-drop={panelOver || undefined}
      onDragOver={(event) => {
        if (!dragging || layout.seatOf(dragging) === undefined) return;
        event.preventDefault();
        setPanelOver(true);
      }}
      onDragLeave={() => setPanelOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        onPanelDrop();
      }}
    >
      <h2 id="unassigned-title" className={styles.cardTitle}>
        {teamNames.length ? `${teamNames.join(" · ")} ` : ""}미배치 인원 <span className="mono">{panel.length}</span>
      </h2>
      {pick?.kind === "person" && (
        <p className={styles.pickNote} role="status">
          <strong>{people.get(pick.emp)?.name}</strong> 님을 놓을 자리를 누르세요 ·{" "}
          <button type="button" className={styles.linkButton} onClick={() => setPick(null)}>
            그만두기
          </button>
        </p>
      )}
      {panel.length === 0 ? (
        <p className={styles.empty}>미배치 인원이 없어요{dragging ? " · 여기에 놓으면 배정 해제" : ""}</p>
      ) : (
        <ul className={styles.people}>
          {panel.map((p) => {
            const movable = canMove(p) && !readOnly;
            return (
              <li key={p.emp_no}>
                <button
                  type="button"
                  className={styles.person}
                  draggable={movable}
                  aria-pressed={pick?.kind === "person" && pick.emp === p.emp_no}
                  aria-disabled={!movable || undefined}
                  onDragStart={(event) => movable && onDragStartPerson(p.emp_no, event)}
                  onDragEnd={endDrag}
                  onClick={() => {
                    if (!movable) {
                      showToast(
                        readOnly ? "지금은 바꿀 수 없어요" : (p.lockText ?? `${p.name} 님은 옮길 수 없어요`),
                        "error",
                      );
                      return;
                    }
                    setTool("move");
                    setPick(
                      pick?.kind === "person" && pick.emp === p.emp_no ? null : { kind: "person", emp: p.emp_no },
                    );
                  }}
                >
                  <span className={styles.grip} aria-hidden="true" />
                  <span className={styles.personName}>
                    <b>
                      <strong>{p.name}</strong> {p.rank}
                    </b>
                    <span>
                      {p.department} · {p.locked ? p.lockText : p.tag}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {!readOnly && <PeopleSearch floorId={floorId} zoneOnly={perms.mode === "ZONE"} onPick={addStaged} />}
      <p className={styles.hint}>
        {perms.mode === "ZONE"
          ? "조직도 기준 우리 팀 인원만 보여요."
          : "이 층에 구역이 있는 팀의 인원이에요. 다른 층·다른 팀 사람은 찾아서 더하세요."}
      </p>
    </section>
  );
  const sideTop = review ? (
    <ReviewPanel
      review={review}
      changes={changes}
      zoneName={zoneName}
      people={people}
      conflicts={conflicts}
      busy={busy}
      onApprove={() => void approve()}
      onReject={() => setRejecting({ id: review.id, comment: "", error: null })}
      onClose={() => {
        setReview(null);
        setServerConflicts(new Map());
      }}
    />
  ) : selectedSeat ? (
    <SeatDetails
      seat={selectedSeat}
      zoneName={zoneName(layout.zoneOf(selectedSeat))}
      editable={editable(selectedSeat)}
      zoneId={layout.zoneOf(selectedSeat)}
      zoneChoices={
        perms.mode === "FLOOR"
          ? [
              ...data.zones.map((z) => ({ id: z.id as number | null, label: `${z.name} · ${z.code}` })),
              { id: null, label: "구역 없음" },
            ]
          : null
      }
      onZone={(zoneId) => {
        commit(moveZone(draft, data.seats, [selectedSeat.id], zoneId));
        showToast(`${selectedSeat.code} → ${zoneName(zoneId)}`);
      }}
      occupant={layout.occupant(selectedSeat.id)}
      mode={layout.mode(selectedSeat)}
      people={people}
      candidates={panel.filter((p) => canMove(p))}
      conflict={conflicts.get(selectedSeat.id) ?? null}
      readOnly={readOnly}
      scheduled={effective.on}
      canMoveOccupant={canMove(people.get(layout.occupant(selectedSeat.id) ?? ""))}
      onAssign={(emp) => (emp ? placeOn(selectedSeat, emp) : clearSeat(selectedSeat))}
      onMode={(mode) => {
        if (!selectedSeat.editable || selectedSeat.upcoming) {
          showToast(blockReason(selectedSeat, null) ?? "바꿀 수 없는 자리예요", "error");
          return;
        }
        const emp = layout.occupant(selectedSeat.id);
        commit(setMode(draft, data.seats, selectedSeat.id, mode));
        if (mode !== "FIXED" && emp) showToast(`${people.get(emp)?.name ?? emp} 님은 미배치 인원으로 옮겼어요`);
      }}
      onSwap={() => {
        setTool("swap");
        setPick({ kind: "seat", seatId: selectedSeat.id });
      }}
      onMove={() => {
        const emp = layout.occupant(selectedSeat.id);
        if (emp) {
          setTool("move");
          setPick({ kind: "person", emp });
        }
      }}
      onClear={() => clearSeat(selectedSeat)}
      onClose={() => setSelectedSeatId(null)}
    />
  ) : null;
  const changesCard = !review && (
    <section className={styles.card} aria-labelledby="changes-title">
      <h2 id="changes-title" className={styles.cardTitle}>
        변경 내용 {changeCount > 0 && <span className="mono">{changeCount}</span>}
      </h2>
      {changes.length === 0 ? (
        <p className={styles.empty}>
          아직 바꾼 것이 없어요. 반영하기 전에는 직원 화면에 보이지 않고, 바꾼 내용은 자동 저장돼요.
        </p>
      ) : (
        <ChangeList
          changes={changes}
          people={people}
          conflicts={conflicts}
          zoneName={zoneName}
          zoneNote={perms.mode === "ZONE" ? "구역 경계 · 층 관리자 승인 후 반영" : "구역 경계 · 바로 반영"}
        />
      )}
      {perms.mode === "ZONE" && Object.keys(draft.zones).length > 0 && perms.apply === "IMMEDIATE" && !pending && (
        <p className={styles.hint}>구역 경계를 바꾸는 묶음은 층 관리자 승인을 거쳐 반영돼요.</p>
      )}
      {!pending && (
        <>
          <fieldset className={styles.when} disabled={preview}>
            <legend>반영 시점</legend>
            <label>
              <input
                type="radio"
                name="when"
                checked={!effective.on}
                onChange={() => {
                  setEffective((e) => ({ ...e, on: false }));
                  markDirty();
                }}
              />
              {perms.apply === "IMMEDIATE" ? "반영하는 즉시" : "승인되는 즉시"}
            </label>
            <label>
              <input
                type="radio"
                name="when"
                checked={effective.on}
                disabled={hasTypes}
                onChange={() => {
                  setEffective((e) => ({ ...e, on: true }));
                  markDirty();
                }}
              />
              날짜 지정
              <input
                type="date"
                className={styles.dateInput}
                value={effective.date}
                min={addDays(todayKst(), 1)}
                max={addDays(todayKst(), MAX_SCHEDULE_DAYS)}
                disabled={hasTypes}
                aria-label="반영할 날짜"
                onChange={(event) => {
                  if (!event.target.value) return;
                  setEffective({ on: true, date: event.target.value });
                  markDirty();
                }}
              />
            </label>
            <p className={styles.hint}>
              {hasTypes
                ? "좌석 유형·구역 변경이 있으면 날짜를 정할 수 없어요 (바로 바뀌어요)."
                : effective.on
                  ? "그날 0시부터 직원 화면에 바뀐 자리가 보여요. 그때까지 바꾼 자리·사람은 잠기고, 그 전에는 취소할 수 있어요."
                  : "이사·입사일처럼 정해진 날이 있으면 날짜를 지정하세요."}
            </p>
          </fieldset>
          <label className={styles.noteField}>
            <span>메모 (선택)</span>
            <input
              value={note}
              maxLength={200}
              placeholder="예: 신규 입사자 배치"
              disabled={preview}
              onChange={(event) => {
                setNote(event.target.value);
                markDirty();
              }}
            />
          </label>
          {changeCount > 0 && (
            <button type="button" className={`${styles.btn} ${styles.ghost}`} onClick={discard} disabled={busy}>
              모두 버리기
            </button>
          )}
        </>
      )}
    </section>
  );
  const requestsCard = (
    <RequestList
      requests={data.requests}
      reviewingId={review?.id ?? null}
      onReview={(row) => void openReview(row)}
      onCancel={cancelScheduled}
      onReopen={(row) => void reopen(row)}
      onExpandZone={perms.mode === "ZONE" && !readOnly ? () => chooseTool("zone") : null}
    />
  );

  return (
    <div ref={pageRef} className={styles.page}>
      <header className={styles.header}>
        <div className={styles.titleRow}>
          <h1 className={styles.title}>좌석 배치 편집</h1>
          <span className={styles.roleChip}>
            <strong>{admin.role_label}</strong> · {roleChip}
          </span>
          <span className={styles.status} role="status" data-tone={save.state === "error" ? "error" : undefined}>
            {status}
            {save.state === "error" && !review && (
              <button type="button" className={styles.linkButton} onClick={() => void flush()}>
                다시 저장
              </button>
            )}
          </span>
        </div>
        <div className={styles.headerActions}>
          {!review && !pending && (
            <button type="button" className={styles.btn} onClick={undo} disabled={history.length === 0 || preview}>
              되돌리기
            </button>
          )}
          {!review && (
            <button type="button" className={styles.btn} aria-pressed={preview} onClick={() => setPreview((p) => !p)}>
              {preview ? "미리보기 끄기" : "직원 화면 미리보기"}
            </button>
          )}
          {!review &&
            (pending ? (
              <button type="button" className={styles.btn} onClick={() => void withdraw()} disabled={busy}>
                요청 거두고 고치기
              </button>
            ) : (
              <button
                type="button"
                className={`${styles.btn} ${styles.pri}`}
                onClick={() => void applyNow()}
                aria-disabled={busy || preview || undefined}
                disabled={busy || preview}
              >
                {busy ? "처리 중…" : primaryLabel}
              </button>
            ))}
        </div>
      </header>

      <p className={styles.infoBar}>
        {perms.mode === "ZONE"
          ? `내 구역(${data.zones
              .filter((z) => myZones?.has(z.id))
              .map((z) => z.code)
              .join(", ")}) 안에서만 배치·교환할 수 있어요. 다른 구역은 잠겨 있고, ${
              perms.apply === "IMMEDIATE"
                ? "반영하기를 누르면 바로 직원 화면에 보여요."
                : "바꾼 내용은 층 관리자가 승인하면 반영돼요."
            }`
          : "사람을 끌어 자리에 놓고(사람 위에 놓으면 자리 교환), 모아서 한 번에 반영해요. 반영하기 전에는 직원 화면에 보이지 않아요."}
      </p>
      {notice && <p className={styles.notice}>{notice}</p>}

      <div className={styles.body} data-cols={cols}>
        {wide && (
          <aside className={styles.left} aria-label="배치 도구와 미배치 인원">
            {floorCard}
            {toolsCard}
            {zonesCard}
            {peopleCard}
          </aside>
        )}
        <main className={styles.center}>
          <div className={styles.toolbar}>
            <span className={styles.crumb}>
              {data.floor.site.name} › <strong>{data.floor.name}</strong>
            </span>
            {myZones && (
              <label className={styles.check}>
                <input type="checkbox" checked={focusMine} onChange={(e) => setFocusMine(e.target.checked)} />내 구역만
                강조
              </label>
            )}
            <div role="group" aria-label="도면 크기" className={styles.zoom}>
              <button
                type="button"
                aria-label="축소"
                disabled={zoom <= ZOOM_STEPS[0]}
                onClick={() => setZoom([...ZOOM_STEPS].reverse().find((z) => z < zoom) ?? zoom)}
              >
                −
              </button>
              <button
                type="button"
                onClick={() => setZoom(1)}
                aria-label={`화면 폭에 맞추기 (지금 ${Math.round(zoom * 100)}%)`}
              >
                {zoom === 1 ? "맞춤" : <span className="mono">{Math.round(zoom * 100)}%</span>}
              </button>
              <button
                type="button"
                aria-label="확대"
                disabled={zoom >= ZOOM_STEPS.at(-1)!}
                onClick={() => setZoom(ZOOM_STEPS.find((z) => z > zoom) ?? zoom)}
              >
                +
              </button>
            </div>
          </div>
          {review && (
            <p className={styles.modeBar} data-tone="review">
              검토 중: {review.requester}의 요청을 반영한 모습이에요. 바뀌는 자리는 파란 테두리예요.
            </p>
          )}
          {pending && !review && (
            <p className={styles.modeBar}>
              승인을 기다리는 중이에요{perms.floor_admins.length ? ` (층 관리자 ${perms.floor_admins.join(", ")})` : ""}
              . 고치려면 위의 &lsquo;요청 거두고 고치기&rsquo;를 누르세요.
            </p>
          )}
          {preview && !review && <p className={styles.modeBar}>직원 화면 미리보기: 반영하면 직원에게 이렇게 보여요.</p>}
          {tool === "zone" && !readOnly && (
            <p className={styles.modeBar} data-tone="zone" role="status">
              팀 구역 지정: <strong>{zoneName(zoneTarget)}</strong>
              {zoneTarget === null ? "으로 뺄" : "에 넣을"} 좌석을 누르거나 끌어서 네모로 묶으세요
              {perms.mode === "ZONE" && " · 층 관리자 승인 후 반영돼요"} ·{" "}
              <button type="button" className={styles.linkButton} onClick={() => chooseTool("move")}>
                끝내기
              </button>
            </p>
          )}
          {tool === "swap" && pick?.kind === "seat" && (
            <p className={styles.modeBar} role="status">
              {data.seats.find((s) => s.id === pick.seatId)?.code}와 바꿀 자리를 누르세요 ·{" "}
              <button type="button" className={styles.linkButton} onClick={() => setPick(null)}>
                그만두기
              </button>
            </p>
          )}
          <div className={styles.canvasCard}>
            <SeatingCanvas
              data={data}
              layout={layout}
              people={people}
              zoom={zoom}
              readOnly={readOnly}
              plain={preview}
              viewOf={viewOf}
              selectedSeatId={selectedSeatId}
              pickedSeatId={pick?.kind === "seat" ? pick.seatId : null}
              dragOverId={dragOverId}
              focusZones={tool === "zone" ? null : focusZones}
              zoneOf={zoneOf}
              rectsOf={rectsOf}
              boxSelect={tool === "zone" && !readOnly}
              onBoxSelect={intoZone}
              onSeatClick={onSeatClick}
              onDragStartPerson={onDragStartPerson}
              onDragEnd={endDrag}
              onDragOverSeat={setDragOverId}
              onDropSeat={(seat) => {
                const emp = dragging;
                endDrag();
                if (emp) placeOn(seat, emp);
              }}
            />
          </div>
          <p className={styles.legend}>
            <span className={styles.legendChanged}>변경</span> 바뀐 자리 ·{" "}
            <span className={styles.legendConflict}>!</span> 충돌 · <span className={styles.legendLocked}>11/2</span>{" "}
            날짜를 정한 변경이 있어 그날까지 잠김
            {perms.mode === "ZONE" && " · 잠긴 구역 위에 놓으면 “다른 구역 · 층 관리자에게 요청” 안내가 떠요"}
          </p>
        </main>
        <aside className={styles.right} aria-label="선택한 좌석, 미배치 인원과 변경 내용">
          {!wide && floorCard}
          {/* 팀 구역 지정 중에는 구역 고르기가 도면 바로 옆에 오게 */}
          {!wide && choosingZone && zonesCard}
          {sideTop}
          {!wide && peopleCard}
          {changesCard}
          {requestsCard}
          {!wide && toolsCard}
          {!wide && !choosingZone && zonesCard}
        </aside>
      </div>

      {toast && (
        <div className={styles.toast} role={toast.tone === "error" ? "alert" : "status"} data-tone={toast.tone}>
          {toast.text}
        </div>
      )}

      <Dialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title={confirm?.title}
        footer={
          <>
            <button type="button" className={styles.btn} onClick={() => setConfirm(null)}>
              그대로 두기
            </button>
            <button
              type="button"
              className={`${styles.btn} ${confirm?.danger ? styles.danger : styles.pri}`}
              disabled={busy}
              onClick={async () => {
                if (!confirm) return;
                setBusy(true);
                await confirm.run();
                setBusy(false);
                setConfirm(null);
              }}
            >
              {confirm?.action}
            </button>
          </>
        }
      >
        <div className={styles.dialogBody}>
          <p>{confirm?.body}</p>
        </div>
      </Dialog>

      {zoneDialog && (
        <ZoneDialog
          state={zoneDialog}
          floorId={floorId}
          floorName={data.floor.name}
          zones={data.zones}
          departments={data.departments}
          statsOf={zoneStats}
          onClose={() => setZoneDialog(null)}
          onExpired={() => router.replace(EXPIRED)}
          onDone={async ({ message, zoneId }) => {
            setZoneDialog(null);
            showToast(message);
            await reload(false);
            if (zoneId !== undefined) {
              setZoneTarget(zoneId);
              setTool("zone");
              setPick(null);
            }
          }}
        />
      )}

      <Dialog
        open={!!rejecting}
        onClose={() => setRejecting(null)}
        title="요청 반려"
        footer={
          <>
            <button type="button" className={styles.btn} onClick={() => setRejecting(null)}>
              취소
            </button>
            <button
              type="button"
              className={`${styles.btn} ${styles.danger}`}
              disabled={busy}
              onClick={() => void reject()}
            >
              반려하기
            </button>
          </>
        }
      >
        <div className={styles.dialogBody}>
          <label className={styles.noteField}>
            <span>반려 사유 (요청한 사람에게 보여요)</span>
            <textarea
              data-autofocus
              rows={3}
              maxLength={200}
              value={rejecting?.comment ?? ""}
              aria-invalid={!!rejecting?.error || undefined}
              aria-describedby="reject-error"
              onChange={(event) =>
                rejecting && setRejecting({ ...rejecting, comment: event.target.value, error: null })
              }
            />
          </label>
          {rejecting?.error && (
            <p id="reject-error" className={styles.fieldError} role="alert">
              {rejecting.error}
            </p>
          )}
        </div>
      </Dialog>
    </div>
  );
}

function saveErrorText(code: string | undefined): string {
  switch (code) {
    case "PENDING":
      return "승인 대기 중이라 고칠 수 없어요";
    case "SEAT_LOCKED":
      return "내 구역이 아닌 좌석이 있어요";
    case "ZONE_NOT_FOUND":
      return "없어진 구역으로 옮기는 좌석이 있어요";
    case "PERSON_OUT_OF_SCOPE":
      return "우리 팀원이 아닌 사람이 있어요";
    case "PERSON_INACTIVE":
      return "재직 중이 아닌 사람이 있어요";
    case "BAD_DATE":
      return "날짜는 내일부터 1년 안으로 정하세요";
    case "SCHEDULE_WITH_TYPES":
      return "유형·구역 변경이 있으면 날짜를 정할 수 없어요";
    default:
      return "잠시 뒤 다시 시도하세요";
  }
}

function actionErrorText(code: string | undefined): string {
  switch (code) {
    case "NOT_DRAFT":
    case "NOT_PENDING":
      return "그사이 상태가 바뀌었어요 · 화면을 다시 불러왔어요";
    case "NEEDS_APPROVAL":
      return "이 층은 층 관리자 승인 후 반영돼요";
    case "NOT_SCHEDULED":
      return "이미 반영됐거나 취소된 변경이에요";
    case "SCHEDULE_WITH_TYPES":
      return "유형·구역 변경이 있으면 날짜를 정할 수 없어요";
    case "EMPTY":
      return "바꾼 것이 없어요";
    default:
      return "처리하지 못했어요 · 잠시 뒤 다시 시도하세요";
  }
}

// 선택한 좌석 ---------------------------------------------------------------------

type DetailsProps = {
  seat: SeatingSeat;
  zoneName: string;
  editable: boolean;
  zoneId: number | null;
  /** 층 관리자 이상: 이 좌석의 구역 고르기 */
  zoneChoices: { id: number | null; label: string }[] | null;
  onZone: (zoneId: number | null) => void;
  occupant: string | null;
  mode: SeatMode;
  people: Map<string, Person>;
  candidates: Person[];
  conflict: string | null;
  readOnly: boolean;
  scheduled: boolean;
  canMoveOccupant: boolean;
  onAssign: (emp: string | null) => void;
  onMode: (mode: SeatMode) => void;
  onSwap: () => void;
  onMove: () => void;
  onClear: () => void;
  onClose: () => void;
};

function SeatDetails(props: DetailsProps) {
  const { seat, zoneName, occupant, mode, people, candidates, conflict, readOnly, scheduled, canMoveOccupant } = props;
  const locked = !props.editable || !!seat.upcoming;
  const disabled = readOnly || locked;
  const base = baseOccupant(seat);
  const person = occupant ? people.get(occupant) : undefined;
  const daily = seat.occupant?.kind === "DAILY" ? seat.occupant : null;
  return (
    <section className={`${styles.card} ${styles.selected}`} aria-labelledby="seat-title">
      <div className={styles.cardHead}>
        <h2 id="seat-title" className={styles.cardTitle}>
          선택한 좌석 · <span className="mono">{seat.code}</span>
        </h2>
        <button type="button" className={styles.linkButton} onClick={props.onClose}>
          닫기
        </button>
      </div>
      {props.zoneChoices ? (
        <label className={styles.field}>
          <span>구역</span>
          <select
            className={styles.select}
            value={props.zoneId ?? ""}
            disabled={readOnly || scheduled}
            onChange={(event) => props.onZone(event.target.value ? Number(event.target.value) : null)}
          >
            {props.zoneChoices.map((z) => (
              <option key={z.id ?? "none"} value={z.id ?? ""}>
                {z.label}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className={styles.muted}>{zoneName}</p>
      )}
      {!props.editable && <p className={styles.lockNote}>다른 구역이에요 · 바꾸려면 층 관리자에게 요청하세요</p>}
      {seat.upcoming && (
        <p className={styles.lockNote}>
          {shortDate(seat.upcoming.at)}부터{" "}
          {seat.upcoming.occupant ? `${seat.upcoming.occupant.name} ${seat.upcoming.occupant.rank ?? ""}` : "빈 자리"}로
          바뀌기로 해서 그날까지 잠겨 있어요. 취소는 아래 요청 목록에서 해요.
        </p>
      )}
      {conflict && <p className={styles.conflictNote}>{conflict}</p>}

      <label className={styles.field}>
        <span>배정 직원</span>
        <select
          className={styles.select}
          value={occupant ?? ""}
          disabled={disabled || mode !== "FIXED" || (!!occupant && !canMoveOccupant && !candidates.length)}
          onChange={(event) => props.onAssign(event.target.value || null)}
        >
          <option value="">(비워 두기)</option>
          {occupant && (
            <option value={occupant}>
              {person?.name ?? occupant} {person?.rank ?? ""} · {person?.department ?? ""}
            </option>
          )}
          {candidates
            .filter((p) => p.emp_no !== occupant)
            .map((p) => (
              <option key={p.emp_no} value={p.emp_no}>
                {p.name} {p.rank ?? ""} · {p.department} (미배치)
              </option>
            ))}
        </select>
      </label>
      {base !== occupant && <p className={styles.muted}>원래: {base ? (people.get(base)?.name ?? base) : "빈 자리"}</p>}
      {daily && (
        <p className={styles.muted}>
          오늘 자율석 사용: {daily.name} {daily.rank ?? ""}
        </p>
      )}

      <fieldset className={styles.modes} disabled={disabled}>
        <legend>좌석 유형</legend>
        {(["FIXED", "FLEX", "OUT_OF_SERVICE"] as const).map((m) => (
          <label key={m}>
            <input
              type="radio"
              name={`mode-${seat.id}`}
              checked={mode === m}
              disabled={scheduled && m !== baseMode(seat)}
              onChange={() => props.onMode(m)}
            />
            {MODE_LABEL[m]}
            {m === "OUT_OF_SERVICE" && " (고장·수리)"}
          </label>
        ))}
        {scheduled && <p className={styles.hint}>날짜를 정한 묶음에는 유형 변경을 넣을 수 없어요.</p>}
      </fieldset>

      <div className={styles.rowButtons}>
        <button type="button" className={styles.btn} disabled={disabled || mode !== "FIXED"} onClick={props.onSwap}>
          자리 교환
        </button>
        <button
          type="button"
          className={styles.btn}
          disabled={disabled || !occupant || !canMoveOccupant}
          onClick={props.onMove}
        >
          옮기기
        </button>
        <button type="button" className={styles.btn} disabled={disabled || !occupant} onClick={props.onClear}>
          배정 해제
        </button>
      </div>
    </section>
  );
}

// 변경 내용 · 요청 ----------------------------------------------------------------

function ChangeList({
  changes,
  people,
  conflicts,
  zoneName,
  zoneNote,
}: {
  changes: Change[];
  people: Map<string, Person>;
  conflicts: Map<number, string>;
  zoneName: (zoneId: number | null) => string;
  /** 구역 경계 변경의 반영 방식 안내 */
  zoneNote: string;
}) {
  const name = (emp: string | null) => (emp ? (people.get(emp)?.name ?? emp) : "");
  return (
    <ul className={styles.changes}>
      {changes.map((c) => {
        let main: ReactNode;
        let sub: string;
        if (c.kind === "assign") {
          main = (
            <>
              <strong>{name(c.emp)}</strong> → <span className="mono">{c.code}</span>
            </>
          );
          sub = `${c.from}에서${c.prev && c.prev !== c.emp ? ` · ${name(c.prev)} 자리` : ""}`;
        } else if (c.kind === "clear") {
          main = (
            <>
              <span className="mono">{c.code}</span> 비우기
            </>
          );
          sub = c.prev ? `${name(c.prev)} → 미배치` : "";
        } else if (c.kind === "mode") {
          main = (
            <>
              <span className="mono">{c.code}</span> → {MODE_LABEL[c.mode]}
            </>
          );
          sub = "좌석 유형 · 바로 반영";
        } else {
          main = (
            <>
              <span className="mono">{c.code}</span> → {zoneName(c.zoneId)}
            </>
          );
          sub = zoneNote;
        }
        const conflict = conflicts.get(c.seatId);
        return (
          <li key={`${c.kind}-${c.seatId}`} data-conflict={!!conflict || undefined}>
            <span>{main}</span>
            {sub && <span className={styles.muted}>{sub}</span>}
            {conflict && <span className={styles.conflictText}>{conflict}</span>}
          </li>
        );
      })}
    </ul>
  );
}

const STATUS_LABEL: Record<string, string> = {
  PENDING: "승인 대기",
  APPROVED: "반영됨",
  REJECTED: "반려",
  CANCELLED: "취소됨",
};

function RequestList({
  requests,
  reviewingId,
  onReview,
  onCancel,
  onReopen,
  onExpandZone,
}: {
  requests: ChangeRequestRow[];
  reviewingId: number | null;
  onReview: (row: ChangeRequestRow) => void;
  onCancel: (row: ChangeRequestRow) => void;
  onReopen: (row: ChangeRequestRow) => void;
  /** 구역 관리자: 구역 확장·변경 요청 (팀 구역 지정 도구를 내 구역 범위로 연다) */
  onExpandZone: (() => void) | null;
}) {
  return (
    <section className={styles.card} aria-labelledby="requests-title">
      <h2 id="requests-title" className={styles.cardTitle}>
        요청 · 승인 현황
      </h2>
      {requests.length === 0 ? (
        <p className={styles.empty}>최근 30일 동안의 요청·반영 내역이 없어요.</p>
      ) : (
        <ul className={styles.requests}>
          {requests.map((r) => {
            const label = r.scheduled ? `예정 · ${shortDate(r.effective_at!)}` : STATUS_LABEL[r.status];
            return (
              <li
                key={r.id}
                data-status={r.scheduled ? "SCHEDULED" : r.status}
                data-active={r.id === reviewingId || undefined}
              >
                <div className={styles.requestHead}>
                  <strong>
                    {r.type === "ZONE_CHANGE"
                      ? "구역 변경 요청"
                      : r.note || (r.zone_moves ? "구역 경계 변경" : "좌석 배치")}
                  </strong>
                  <span className={styles.statusChip}>{label}</span>
                </div>
                <span className={styles.requestSummary}>
                  {r.summary.slice(0, 3).join(" · ")}
                  {r.summary.length > 3 && ` 외 ${r.summary.length - 3}건`}
                </span>
                <span className={styles.muted}>
                  {r.mine ? "내 요청" : r.requester}
                  {r.reviewer &&
                    r.status !== "PENDING" &&
                    ` · ${r.status === "REJECTED" ? "반려" : "처리"} ${r.reviewer}`}
                  {(r.reviewed_at ?? r.submitted_at) && ` · ${kstDate((r.reviewed_at ?? r.submitted_at)!).slice(5)}`}
                </span>
                {r.status === "REJECTED" && r.review_comment && (
                  <span className={styles.rejectNote}>사유: {r.review_comment}</span>
                )}
                {(r.can_review || r.can_cancel || (r.mine && r.status === "REJECTED")) && (
                  <div className={styles.rowButtons}>
                    {r.can_review && (
                      <button type="button" className={`${styles.btn} ${styles.pri}`} onClick={() => onReview(r)}>
                        {r.id === reviewingId ? "검토 중" : "검토"}
                      </button>
                    )}
                    {r.can_cancel && (
                      <button type="button" className={styles.btn} onClick={() => onCancel(r)}>
                        예정 취소
                      </button>
                    )}
                    {r.mine && r.status === "REJECTED" && r.type === "SEAT_ASSIGNMENT" && (
                      <button type="button" className={styles.btn} onClick={() => onReopen(r)}>
                        다시 고치기
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {onExpandZone && (
        <button type="button" className={styles.btn} onClick={onExpandZone}>
          + 구역 확장·변경 요청
        </button>
      )}
    </section>
  );
}

function ReviewPanel({
  review,
  changes,
  zoneName,
  people,
  conflicts,
  busy,
  onApprove,
  onReject,
  onClose,
}: {
  review: ChangeSet;
  changes: Change[];
  zoneName: (zoneId: number | null) => string;
  people: Map<string, Person>;
  conflicts: Map<number, string>;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
  onClose: () => void;
}) {
  const now = useNow();
  const late = !!review.effective_at && now > 0 && Date.parse(review.effective_at) <= now;
  return (
    <section className={`${styles.card} ${styles.selected}`} aria-labelledby="review-title">
      <div className={styles.cardHead}>
        <h2 id="review-title" className={styles.cardTitle}>
          검토 · {review.type === "ZONE_CHANGE" ? "구역 변경 요청" : "좌석 배치 요청"}
        </h2>
        <button type="button" className={styles.linkButton} onClick={onClose}>
          닫기
        </button>
      </div>
      <p className={styles.muted}>
        {review.requester}
        {review.submitted_at && ` · ${kstDate(review.submitted_at).slice(5)} 요청`}
        {review.note && ` · ${review.note}`}
      </p>
      <p className={styles.muted}>
        반영 시점:{" "}
        {review.effective_at
          ? late
            ? "정한 날짜가 지나서 승인하면 바로 반영돼요"
            : `${shortDate(review.effective_at)}부터`
          : "승인하는 즉시"}
      </p>
      <ChangeList
        changes={changes}
        people={people}
        conflicts={conflicts}
        zoneName={zoneName}
        zoneNote="구역 경계 · 승인하면 바로 반영"
      />
      {conflicts.size > 0 && (
        <p className={styles.conflictNote}>
          충돌 {conflicts.size}건: 요청 뒤에 자리가 바뀌었어요. 반려하고 다시 요청받으세요.
        </p>
      )}
      <div className={styles.rowButtons}>
        <button type="button" className={`${styles.btn} ${styles.pri}`} disabled={busy} onClick={onApprove}>
          승인하고 반영
        </button>
        <button type="button" className={styles.btn} disabled={busy} onClick={onReject}>
          반려
        </button>
      </div>
    </section>
  );
}

// 사람 찾기 (다른 층·다른 팀) ---------------------------------------------------------

function PeopleSearch({
  floorId,
  zoneOnly,
  onPick,
}: {
  floorId: number;
  zoneOnly: boolean;
  onPick: (hit: SeatingSearchHit) => void;
}) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SeatingSearchHit[] | null>(null);
  const q = query.trim();

  useEffect(() => {
    if (!q) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/admin/seating/people?floor_id=${floorId}&q=${encodeURIComponent(q)}`, {
          signal: controller.signal,
        });
        if (res.ok) setHits(((await res.json()) as { people: SeatingSearchHit[] }).people);
      } catch {
        // 입력이 바뀌어 취소됐다
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [q, floorId]);

  return (
    <div className={styles.search}>
      <label className={styles.searchField}>
        <SearchIcon size={16} />
        <span className="visually-hidden">사람 찾기</span>
        <input
          value={query}
          placeholder={zoneOnly ? "우리 팀원 찾기 (이름·사번)" : "다른 사람 찾기 (이름·사번)"}
          onChange={(event) => {
            setQuery(event.target.value);
            if (!event.target.value.trim()) setHits(null);
          }}
        />
      </label>
      {q && hits && (
        <ul className={styles.hits} aria-label="찾은 사람">
          {hits.length === 0 && <li className={styles.empty}>찾는 사람이 없어요</li>}
          {hits.map((h) => (
            <li key={h.emp_no}>
              <button
                type="button"
                onClick={() => {
                  onPick(h);
                  setQuery("");
                  setHits(null);
                }}
              >
                <strong>{h.name}</strong> {h.rank}
                <span>
                  {h.department} · {h.seat ? `${h.seat.floor} ${h.seat.code}` : "자리 없음"}
                  {h.locked && " · 변경 예정"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
