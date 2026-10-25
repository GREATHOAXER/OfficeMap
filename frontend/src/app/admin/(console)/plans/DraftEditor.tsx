"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Dialog from "@/components/Dialog";
import FloorExportDialog from "@/components/FloorExportDialog";
import type { DeskGroup, PlanEditorData, PlanElement, PlanGeometry, PlanRect, SpaceKind } from "@/lib/api";
import { agoText, shortDate } from "@/lib/dates";
import { drawingFromPlan } from "@/lib/floorDrawing";
import {
  type AlignMode,
  alignElements,
  boxOfAll,
  copyElements,
  groupSize,
  makeDeskGroup,
  MAX_SIZE,
  moveElement,
  newId,
  problemsOf,
  rotateElements,
  scaleElement,
  snapTo,
  SPACE_KINDS,
  TYPE_LABEL,
} from "@/lib/planGeometry";
import { useNow } from "@/lib/useNow";
import { straighten, type TidyResult } from "@/lib/wallSnap";
import ui from "../seating/seating.module.css";
import BackgroundDialog from "./BackgroundDialog";
import ImportWizard, { type Background } from "./ImportWizard";
import PlanCanvas, { type DrawTool, type LinePoints, type Tool, ZoomControls } from "./PlanCanvas";
import PlanPanel from "./PlanPanel";
import PublishDialog, { type PublishResult, type ScheduleResult } from "./PublishDialog";
import ResizeDialog from "./ResizeDialog";
import SelectionToolbar from "./SelectionToolbar";
import TidyDialog from "./TidyDialog";
import { EXPIRED, Header, json, type ScreenProps, useFloorChanges } from "./shared";
import styles from "./plans.module.css";

const SAVE_DELAY_MS = 1500; // 마지막으로 바꾸고 이만큼 쉬면 자동 저장
const HEARTBEAT_MS = 30_000; // 편집 중 표시 (서버는 2분 소식이 없으면 잠금을 푼다)
const WATCH_MS = 15_000; // 보기만 할 때 다른 사람의 편집을 다시 읽는 간격
const COALESCE_MS = 1500; // 같은 칸을 이만큼 안에 이어서 고치면 되돌리기 한 번으로 묶는다
const HISTORY_MAX = 100;
// 도구가 도면 옆에 있어야 편하므로 좌석 배치 화면보다 좁은 폭에서도 세 단으로 둔다 (왼쪽 단을 좁게)
const THREE_COLUMNS_PX = 1100;
const TWO_COLUMNS_PX = 760;

/** 누르기만 했을 때 놓이는 기본 크기 (m). 선 벽은 길이만 */
const DEFAULT_SIZE: Record<DrawTool, { w: number; h: number }> = {
  wall: { w: 4, h: 0.3 },
  wall_line: { w: 4, h: 0 },
  pillar: { w: 0.6, h: 0.6 },
  space: { w: 4, h: 3 },
  room: { w: 5, h: 4 },
  entrance: { w: 1.8, h: 0.6 },
};

const PRESETS: { key: string; label: string; layout: DeskGroup["layout"]; rows: number; cols: number }[] = [
  { key: "single", label: "1인 책상", layout: "one", rows: 1, cols: 1 },
  { key: "face", label: "마주보기 6석", layout: "face", rows: 2, cols: 3 },
  { key: "row", label: "한 방향 4석", layout: "one", rows: 1, cols: 4 },
  { key: "island", label: "팀 섬 12석", layout: "face", rows: 2, cols: 6 },
];

const HATCHED: SpaceKind[] = ["core", "restroom", "service", "restricted"];

/** 복사한 요소들 (층 사이 붙여넣기) */
type Clip = { elements: PlanElement[]; floorId: number; floor: string };
const CLIP_KEY = "officemap.plan.clipboard";

function readClip(): Clip | null {
  try {
    const raw = localStorage.getItem(CLIP_KEY);
    const clip = raw ? (JSON.parse(raw) as Clip & { element?: PlanElement }) : null;
    if (!clip) return null;
    // 예전 형식 (요소 하나)
    const elements = clip.elements ?? (clip.element ? [clip.element] : []);
    return elements.length && elements.every((e) => e?.type) ? { ...clip, elements } : null;
  } catch {
    return null;
  }
}

const clipText = (els: PlanElement[]) => (els.length === 1 ? TYPE_LABEL[els[0].type] : `요소 ${els.length}개`);

type SaveState = { state: "clean" | "dirty" | "saving" | "saved" | "error"; message?: string; at?: string };
/** 잠김: 다른 사람이 편집 중(by) 이거나, 그 사람이 나가서 이어 받을 수 있음(by = null) */
type Lock = { by: string | null } | null;

// 초안 편집 --------------------------------------------------------------------

/** 되돌리기 단위: 도면 모양과 크기 (m) */
type Doc = { geometry: PlanGeometry; width: number; height: number };
type History = { past: Doc[]; future: Doc[] };

export default function DraftEditor({ admin, data, reload, showToast, goFloor, notice }: ScreenProps) {
  const router = useRouter();
  const draft = data.draft!;
  const planId = draft.id;
  const now = useNow();

  const [doc, setDoc] = useState<Doc>(() => ({
    geometry: draft.geometry,
    width: data.size.width_m,
    height: data.size.height_m,
  }));
  const { geometry, width, height } = doc;
  const [history, setHistory] = useState<History>({ past: [], future: [] });
  const [tool, setTool] = useState<Tool>("select");
  const [spaceKind, setSpaceKind] = useState<SpaceKind>("lounge");
  const [preset, setPreset] = useState(PRESETS[1].key);
  const [entranceMain, setEntranceMain] = useState(true);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [zoom, setZoom] = useState(1);
  const [snap, setSnap] = useState(true);
  const [showDims, setShowDims] = useState(false);
  const [resizing, setResizing] = useState(false);
  const [tidying, setTidying] = useState(false);
  // 밑그림 (층마다 하나, 초안과 따로 저장된다)
  const [background, setBackground] = useState(data.background);
  const [importing, setImporting] = useState(false);
  const [bgEditing, setBgEditing] = useState(false);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [save, setSave] = useState<SaveState>({ state: "clean", at: draft.updated_at });
  const [lock, setLock] = useState<Lock>(() =>
    draft.editing && !draft.editing.mine ? { by: draft.editing.name } : null,
  );
  const [conflict, setConflict] = useState<{ revision: number } | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [busy, setBusy] = useState(false);
  const pageRef = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState<1 | 2 | 3>(2);
  const readOnly = lock !== null;

  useEffect(() => {
    const el = pageRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width;
      setCols(w >= THREE_COLUMNS_PX ? 3 : w >= TWO_COLUMNS_PX ? 2 : 1);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // 저장·이벤트 처리에서 읽는 최신 값
  const docRef = useRef(doc);
  const revRef = useRef(draft.revision);
  const dirtyRef = useRef(false);
  const blockedRef = useRef(false); // 잠김·충돌 중에는 저장하지 않는다
  const lastEdit = useRef<{ key: string | null; at: number }>({ key: null, at: 0 });
  useEffect(() => {
    docRef.current = doc;
    blockedRef.current = readOnly || conflict !== null;
  });

  // 자동 저장 ------------------------------------------------------------------
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const inflight = useRef<Promise<boolean> | null>(null);

  const refresh = useCallback(async () => {
    const fresh = await reload();
    if (fresh && fresh.draft?.id !== planId) {
      showToast(fresh.draft ? "다른 초안이 열려 있어 그 초안으로 바꿨어요" : "초안이 게시되었거나 버려졌어요");
    }
    return fresh;
  }, [reload, planId, showToast]);

  const flush = useCallback(async (): Promise<boolean> => {
    clearTimeout(saveTimer.current);
    if (inflight.current) await inflight.current;
    if (!dirtyRef.current) return true;
    if (blockedRef.current) return false;
    dirtyRef.current = false;
    setSave({ state: "saving" });
    const run = (async () => {
      try {
        const res = await fetch(`/api/admin/plans/${planId}`, {
          method: "PUT",
          headers: json,
          body: JSON.stringify({
            revision: revRef.current,
            geometry: docRef.current.geometry,
            width_m: docRef.current.width,
            height_m: docRef.current.height,
          }),
        });
        if (res.status === 401) {
          router.replace(EXPIRED);
          return false;
        }
        const out = await res.json().catch(() => null);
        if (!res.ok) {
          dirtyRef.current = true;
          const code = out?.detail?.code;
          if (code === "REVISION") {
            setConflict({ revision: out.detail.revision });
            setSave({ state: "error", message: "저장 충돌 · 아래에서 고르세요" });
          } else if (code === "EDITING") {
            setLock({ by: out.detail.by ?? null });
            setSave({ state: "error", message: "다른 관리자가 편집 중이라 저장하지 못했어요" });
          } else if (code === "DRAFT_NOT_FOUND") {
            dirtyRef.current = false;
            await refresh();
          } else if (code === "BAD_GEOMETRY") {
            setSave({ state: "error", message: `저장할 수 없는 모양이 있어요 (${out.detail.where})` });
          } else setSave({ state: "error", message: "저장하지 못했어요" });
          return false;
        }
        revRef.current = out.revision;
        setSave({ state: "saved", at: out.updated_at });
        return true;
      } catch {
        dirtyRef.current = true;
        setSave({ state: "error", message: "네트워크 오류 · 저장하지 못했어요" });
        return false;
      }
    })();
    inflight.current = run;
    const ok = await run;
    inflight.current = null;
    return ok;
  }, [planId, router, refresh]);

  const markDirty = useCallback(() => {
    dirtyRef.current = true;
    setSave({ state: "dirty" });
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void flush(), SAVE_DELAY_MS);
  }, [flush]);

  useEffect(() => () => clearTimeout(saveTimer.current), []);

  useEffect(() => {
    function onBeforeUnload(event: BeforeUnloadEvent) {
      if (dirtyRef.current || inflight.current) event.preventDefault();
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  /** 서버의 초안으로 화면을 다시 맞춘다 (넘겨받기·충돌에서 다시 불러오기·보기 전용 새로 읽기) */
  const adopt = useCallback((fresh: PlanEditorData) => {
    if (!fresh.draft) return;
    revRef.current = fresh.draft.revision;
    dirtyRef.current = false;
    const next = { geometry: fresh.draft.geometry, width: fresh.size.width_m, height: fresh.size.height_m };
    docRef.current = next;
    setDoc(next);
    setSave({ state: "clean", at: fresh.draft.updated_at });
  }, []);

  // 편집 잠금 ------------------------------------------------------------------
  const claim = useCallback(
    async (takeOver: boolean): Promise<boolean> => {
      const res = await fetch(`/api/admin/plans/${planId}/heartbeat`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({ take_over: takeOver }),
      }).catch(() => null);
      if (res?.status === 401) {
        router.replace(EXPIRED);
        return false;
      }
      if (res?.status === 404) {
        await refresh();
        return false;
      }
      if (res?.status === 423) {
        const out = await res.json().catch(() => null);
        setLock({ by: out?.detail?.by ?? null });
        return false;
      }
      return !!res?.ok;
    },
    [planId, router, refresh],
  );

  // 보기 전용으로 다시 읽던 요청이 넘겨받은 뒤에 도착하면 버린다 (넘겨받기 전 상태로 잠금을 되돌리지 않게)
  const watchGen = useRef(0);

  async function takeOver() {
    setBusy(true);
    watchGen.current += 1;
    const ok = await claim(true);
    const fresh = ok ? await reload() : null;
    setBusy(false);
    if (!ok || !fresh?.draft) return;
    adopt(fresh);
    setHistory({ past: [], future: [] });
    setLock(null);
    setConflict(null);
    showToast("편집을 넘겨받았어요. 이제 이 화면에서 고칠 수 있어요");
  }

  // 편집 중이면 30초마다 편집 중 표시를 이어 가고, 보기만 할 때는 15초마다 다시 읽는다
  useEffect(() => {
    if (readOnly) {
      const timer = setInterval(async () => {
        const gen = watchGen.current;
        const fresh = await reload();
        if (gen !== watchGen.current || !fresh?.draft || fresh.draft.id !== planId) return;
        adopt(fresh);
        const editing = fresh.draft.editing;
        setLock(editing && !editing.mine ? { by: editing.name } : { by: null });
      }, WATCH_MS);
      return () => {
        clearInterval(timer);
        watchGen.current += 1;
      };
    }
    const first = setTimeout(() => void claim(false), 0);
    const timer = setInterval(() => void claim(false), HEARTBEAT_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [readOnly, claim, reload, adopt, planId]);

  // 다른 관리자가 이 층에 게시하거나 좌석을 바꾸면 다시 읽는다 (앉은 사람·예약 표시)
  useFloorChanges(data.floor.id, refresh);

  // 바꾸기 ---------------------------------------------------------------------

  const commit = useCallback(
    (next: Doc, key?: string) => {
      if (blockedRef.current) return;
      const at = Date.now();
      const coalesce = !!key && lastEdit.current.key === key && at - lastEdit.current.at < COALESCE_MS;
      lastEdit.current = { key: key ?? null, at };
      const prev = docRef.current;
      setHistory((h) => ({ past: coalesce ? h.past : [...h.past.slice(-(HISTORY_MAX - 1)), prev], future: [] }));
      docRef.current = next;
      setDoc(next);
      markDirty();
    },
    [markDirty],
  );

  const commitGeometry = useCallback(
    (geometry: PlanGeometry, key?: string) => commit({ ...docRef.current, geometry }, key),
    [commit],
  );

  /** 고친 요소들로 바꾼다 (여러 개를 한 번에 되돌린다) */
  const replaceElements = useCallback(
    (els: PlanElement[], key?: string) => {
      const g = docRef.current.geometry;
      const next = new Map(els.map((e) => [e.id, e]));
      commitGeometry({ ...g, elements: g.elements.map((e) => next.get(e.id) ?? e) }, key);
    },
    [commitGeometry],
  );

  /** 도면 크기 바꾸기: 요소는 그 자리(m)에 두고 도면만 넓히거나 줄인다 (밖으로 나간 요소는 "고칠 것"에 뜬다) */
  const resizePlan = useCallback(
    (size: { width: number; height: number }) => commit({ ...docRef.current, ...size }, "plan-size"),
    [commit],
  );

  /** 크기 바꾸기 대화상자: scale이면 요소도 같은 비율로 (desks가 false면 책상 크기는 그대로) */
  function resizeScaled(size: { width: number; height: number }, scale: boolean, desks: boolean) {
    const cur = docRef.current;
    const sx = size.width / cur.width;
    const sy = size.height / cur.height;
    const geometry = scale
      ? { ...cur.geometry, elements: cur.geometry.elements.map((e) => scaleElement(e, sx, sy, desks)) }
      : cur.geometry;
    commit({ geometry, ...size });
    setResizing(false);
    showToast(
      `도면 크기를 ${size.width} × ${size.height} m로 바꿨어요${scale ? " · 요소도 같은 비율로" : ""} (되돌리기 Ctrl+Z)`,
    );
  }

  function addElements(els: PlanElement[]) {
    const g = docRef.current.geometry;
    commitGeometry({ ...g, elements: [...g.elements, ...els] });
    setSelectedIds(els.map((e) => e.id));
    setTool("select");
  }
  const addElement = (el: PlanElement) => addElements([el]);

  /** 도면 파일 깔기: 밑그림이 도면보다 크면 도면을 넓히고, 찾은 요소를 더한다 (되돌리기 한 번) */
  function applyImport(r: { elements: PlanElement[]; widthM: number; heightM: number; background: Background }) {
    const cur = docRef.current;
    const fit = (v: number, now: number) => Math.max(now, Math.min(MAX_SIZE, Math.ceil(v * 2) / 2));
    const room = 2000 - cur.geometry.elements.length;
    const els = r.elements.length <= room ? r.elements : [];
    const size = { width: fit(r.widthM, cur.width), height: fit(r.heightM, cur.height) };
    if (els.length || size.width !== cur.width || size.height !== cur.height)
      commit({ geometry: { ...cur.geometry, elements: [...cur.geometry.elements, ...els] }, ...size });
    setBackground(r.background);
    setImporting(false);
    if (els.length) setSelectedIds([]);
    showToast(
      r.elements.length > room
        ? "밑그림을 깔았어요. 찾은 요소가 너무 많아(도면 요소 2000개까지) 더하지 않았어요"
        : els.length
          ? `밑그림을 깔고 요소 ${els.length}개를 더했어요 (되돌리기 Ctrl+Z)`
          : "밑그림을 깔았어요",
    );
  }

  /** 밑그림 보이기·숨기기 (다음에 열 때도 그대로) */
  async function toggleBackground(visible: boolean) {
    if (!background) return;
    setBackground({ ...background, visible });
    try {
      const res = await fetch(`/api/admin/floors/${data.floor.id}/plan/background`, {
        method: "PATCH",
        headers: json,
        body: JSON.stringify({ visible }),
      });
      if (res.status === 401) router.replace(EXPIRED);
    } catch {
      // 화면에서는 이미 바뀌었다. 다음에 열 때 예전 값이면 다시 고르면 된다
    }
  }

  const undo = useCallback(() => {
    if (blockedRef.current) return;
    setHistory((h) => {
      if (h.past.length === 0) return h;
      const prev = h.past[h.past.length - 1];
      const current = docRef.current;
      docRef.current = prev;
      setDoc(prev);
      return { past: h.past.slice(0, -1), future: [current, ...h.future] };
    });
    lastEdit.current = { key: null, at: 0 };
    markDirty();
  }, [markDirty]);

  const redo = useCallback(() => {
    if (blockedRef.current) return;
    setHistory((h) => {
      if (h.future.length === 0) return h;
      const [next, ...rest] = h.future;
      const current = docRef.current;
      docRef.current = next;
      setDoc(next);
      return { past: [...h.past, current], future: rest };
    });
    lastEdit.current = { key: null, at: 0 };
    markDirty();
  }, [markDirty]);

  function nextRoomName(base = "회의실"): string {
    const names = new Set(docRef.current.geometry.elements.flatMap((e) => (e.type === "room" ? [e.name] : [])));
    for (let n = 1; ; n++) {
      const name = `${base} ${n}`;
      if (!names.has(name)) return name;
    }
  }

  function onDraw(rect: PlanRect) {
    if (tool === "select" || tool === "desk" || tool === "wall_line") return;
    const tiny = rect.w < 0.3 && rect.h < 0.3;
    const r = tiny
      ? { x: rect.x, y: rect.y, ...DEFAULT_SIZE[tool] }
      : { ...rect, w: Math.max(rect.w, 0.2), h: Math.max(rect.h, 0.2) };
    if (tool === "wall") addElement({ id: newId("wall"), type: "wall", ...r });
    else if (tool === "pillar") addElement({ id: newId("pillar"), type: "pillar", ...r });
    else if (tool === "space") addElement({ id: newId("space"), type: "space", kind: spaceKind, label: "", ...r });
    else if (tool === "entrance")
      addElement({ id: newId("entrance"), type: "entrance", label: "", main: entranceMain, ...r });
    else addElement({ id: newId("room"), type: "room", name: nextRoomName(), capacity: 6, equipment: [], ...r });
  }

  function onDrawLine(line: LinePoints) {
    // 누르기만 했으면 오른쪽으로 기본 길이
    const short = Math.hypot(line.x2 - line.x, line.y2 - line.y) < 0.3;
    const end = short ? { x2: line.x + DEFAULT_SIZE.wall_line.w, y2: line.y } : { x2: line.x2, y2: line.y2 };
    addElement({ id: newId("wall_line"), type: "wall_line", x: line.x, y: line.y, ...end });
  }

  function onPlaceDesk(point: { x: number; y: number }) {
    const p = PRESETS.find((x) => x.key === preset) ?? PRESETS[0];
    const size = groupSize(p);
    const group = makeDeskGroup(
      snapTo(point.x - size.w / 2, snap),
      snapTo(point.y - size.h / 2, snap),
      p,
      docRef.current.geometry,
    );
    addElement(group);
    showToast(`책상 ${group.cells.length}석을 놓았어요 (${group.cells[0].code}부터). 오른쪽에서 번호를 고칠 수 있어요`);
  }

  /** 지우면 영향 받는 것: 앉은 사람, 남은 예약 */
  const lossText = useCallback(
    (el: PlanElement): string | null => {
      if (el.type === "desk_group") {
        const names = el.cells.flatMap((c) =>
          c.desk && data.live.seats[c.id]?.occupant ? [data.live.seats[c.id].occupant!] : [],
        );
        return names.length
          ? `${names.slice(0, 3).join(", ")}${names.length > 3 ? ` 외 ${names.length - 3}명` : ""} 님의 책상을 지웠어요 · 게시할 때 새 자리를 고를 수 있어요`
          : null;
      }
      if (el.type === "room" && data.live.rooms[el.id]?.upcoming) {
        return `회의실 ${data.live.rooms[el.id].name}: 지웠어요 · 남은 예약 ${data.live.rooms[el.id].upcoming}건은 게시할 때 옮기거나 취소해요`;
      }
      return null;
    },
    [data.live],
  );

  const deleteSelected = useCallback(() => {
    const g = docRef.current.geometry;
    const gone = g.elements.filter((e) => selectedIds.includes(e.id));
    if (gone.length === 0) return;
    commitGeometry({ ...g, elements: g.elements.filter((e) => !selectedIds.includes(e.id)) });
    setSelectedIds([]);
    const losses = gone.flatMap((el) => lossText(el) ?? []);
    showToast(
      losses.length
        ? losses.join(" · ")
        : `${gone.length === 1 ? `${TYPE_LABEL[gone[0].type]}을` : `${gone.length}개를`} 지웠어요 · 되돌리기 Ctrl+Z`,
    );
  }, [selectedIds, commitGeometry, lossText, showToast]);

  /** 복사본을 넣는다. 회의실 이름이 겹치면 번호를 붙인다 */
  function placeCopies(els: PlanElement[], dx: number, dy: number) {
    const g = docRef.current.geometry;
    const copies = copyElements(els, g, dx, dy);
    const names = new Set(g.elements.flatMap((e) => (e.type === "room" ? [e.name] : [])));
    for (const copy of copies) {
      if (copy.type !== "room") continue;
      if (names.has(copy.name)) {
        const base = copy.name.replace(/\s*\d+$/, "") || "회의실";
        for (let n = 1; ; n++) {
          if (!names.has(`${base} ${n}`)) {
            copy.name = `${base} ${n}`;
            break;
          }
        }
      }
      names.add(copy.name);
    }
    addElements(copies);
    return copies;
  }

  const duplicateSelected = useCallback(() => {
    const els = docRef.current.geometry.elements.filter((e) => selectedIds.includes(e.id));
    if (els.length) placeCopies(els, 1, 1);
  }, [selectedIds]); // eslint-disable-line react-hooks/exhaustive-deps

  // 층 사이 복사·붙여넣기: 이 브라우저의 다른 층 도면 편집 화면에서도 붙여 넣을 수 있게 localStorage에 둔다
  const [clip, setClip] = useState<Clip | null>(null);
  useEffect(() => {
    const read = () => setClip(readClip());
    read();
    window.addEventListener("storage", read);
    return () => window.removeEventListener("storage", read);
  }, []);

  const copySelected = useCallback(() => {
    const els = docRef.current.geometry.elements.filter((e) => selectedIds.includes(e.id));
    if (els.length === 0) return;
    const next: Clip = { elements: els, floorId: data.floor.id, floor: data.floor.name };
    try {
      localStorage.setItem(CLIP_KEY, JSON.stringify(next));
    } catch {
      // 저장소를 못 쓰면 이 화면 안에서만 붙여 넣는다
    }
    setClip(next);
    showToast(`복사했어요: ${clipText(els)} · 다른 층 도면에서도 Ctrl+V로 붙여 넣을 수 있어요`);
  }, [selectedIds, data.floor.id, data.floor.name, showToast]);

  const paste = useCallback(() => {
    const c = readClip() ?? clip;
    if (!c || blockedRef.current) return;
    // 같은 층이면 옆으로 1 m, 다른 층이면 같은 자리 (도면 밖으로 나가면 안으로 당긴다)
    const offset = c.floorId === data.floor.id ? 1 : 0;
    const box = boxOfAll(c.elements)!;
    const { width: W, height: H } = docRef.current;
    const x = Math.min(Math.max(box.x + offset, 0), Math.max(W - box.w, 0));
    const y = Math.min(Math.max(box.y + offset, 0), Math.max(H - box.h, 0));
    const copies = placeCopies(c.elements, x - box.x, y - box.y);
    showToast(`붙여 넣었어요: ${clipText(copies)}${c.floorId !== data.floor.id ? ` (${c.floor}에서)` : ""}`);
  }, [clip, data.floor.id, showToast]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 고른 것 90도 돌리기 (R 오른쪽, Shift+R 왼쪽): 책상은 방향, 사각형은 폭·높이, 여러 개면 함께 */
  const rotateSelected = useCallback(
    (clockwise: boolean) => {
      const els = docRef.current.geometry.elements.filter((e) => selectedIds.includes(e.id));
      if (els.length) replaceElements(rotateElements(els, clockwise));
    },
    [selectedIds, replaceElements],
  );

  const alignSelected = (mode: AlignMode) =>
    replaceElements(
      alignElements(
        docRef.current.geometry.elements.filter((e) => selectedIds.includes(e.id)),
        mode,
      ),
    );

  const straightenSelected = () => {
    const el = docRef.current.geometry.elements.find((e) => selectedIds.includes(e.id));
    if (el?.type === "wall_line") replaceElements([straighten(el)]);
  };

  /** 선 정리 결과를 한 번에 (되돌리기 한 번) */
  function applyTidy(result: TidyResult) {
    commitGeometry({ ...docRef.current.geometry, elements: result.elements });
    setSelectedIds((ids) => ids.filter((id) => result.elements.some((e) => e.id === id)));
    setTidying(false);
    showToast(
      `선 정리: 선 ${result.moved}개를 고쳤어요${result.removed ? ` · 짧은 선 ${result.removed}개 지움` : ""}${
        result.thickened ? ` · 굵기 ${result.thickened}개` : ""
      } (되돌리기 Ctrl+Z)`,
    );
  }

  // 키보드: Delete 지우기, 방향키 옮기기, Ctrl+Z/Y 되돌리기·다시, Ctrl+D 복제, Esc 놓기
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      // 글자를 넣는 칸에서는 브라우저 기본 동작 (체크 상자·단추에 초점이 있어도 단축키는 된다)
      const typing = "input:not([type=checkbox]):not([type=radio]), textarea, select, dialog, [contenteditable]";
      if ((event.target as Element).closest(typing)) return;
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (mod && key === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && key === "y") {
        event.preventDefault();
        redo();
        return;
      }
      if (event.key === "Escape") {
        if (tool !== "select") setTool("select");
        else setSelectedIds([]);
        return;
      }
      if (mod && key === "a") {
        event.preventDefault();
        setTool("select");
        setSelectedIds(docRef.current.geometry.elements.map((e) => e.id));
        return;
      }
      if (!readOnly && mod && key === "v") {
        event.preventDefault();
        paste();
        return;
      }
      // 복사는 보기만 할 때도 된다 (바꾸는 것이 없다)
      if (selectedIds.length && mod && key === "c") {
        event.preventDefault();
        copySelected();
        return;
      }
      if (readOnly || selectedIds.length === 0) return;
      if (mod && key === "d") {
        event.preventDefault();
        duplicateSelected();
        return;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        deleteSelected();
        return;
      }
      if (!mod && key === "r") {
        event.preventDefault();
        rotateSelected(!event.shiftKey);
        return;
      }
      const arrows: Record<string, [number, number]> = {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
      };
      const dir = arrows[event.key];
      if (!dir) return;
      event.preventDefault();
      const els = docRef.current.geometry.elements.filter((e) => selectedIds.includes(e.id));
      if (els.length === 0) return;
      const step = event.shiftKey ? 1 : snap ? 0.5 : 0.1;
      replaceElements(
        els.map((el) => moveElement(el, dir[0] * step, dir[1] * step)),
        `${selectedIds.join(",")}:arrow`,
      );
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [
    tool,
    readOnly,
    selectedIds,
    snap,
    undo,
    redo,
    deleteSelected,
    duplicateSelected,
    copySelected,
    paste,
    rotateSelected,
    replaceElements,
  ]);

  // 게시 · 버리기 ---------------------------------------------------------------

  async function openPublish() {
    if (!(await flush())) {
      showToast("저장하지 못한 변경이 있어 게시를 점검할 수 없어요", "error");
      return;
    }
    setPublishing(true);
  }

  async function onPublished(result: PublishResult) {
    setPublishing(false);
    dirtyRef.current = false;
    const parts = [
      result.reseated && `새 자리 ${result.reseated}명`,
      result.unassigned && `미배치 ${result.unassigned}명`,
      result.reservations_moved && `예약 옮김 ${result.reservations_moved}건`,
      result.reservations_cancelled && `예약 취소 ${result.reservations_cancelled}건`,
    ].filter(Boolean);
    showToast(
      `${data.floor.name} 도면을 게시했어요 (v${result.version})${parts.length ? ` · ${parts.join(" · ")}` : ""}`,
    );
    await reload();
  }

  async function onScheduled(result: ScheduleResult) {
    setPublishing(false);
    dirtyRef.current = false;
    showToast(
      `${data.floor.name} 도면 게시를 예약했어요: ${shortDate(result.effective_at)} 0시 (v${result.version}). 그때까지 직원 화면은 그대로예요`,
    );
    await reload();
  }

  async function discard() {
    setBusy(true);
    clearTimeout(saveTimer.current);
    const res = await fetch(`/api/admin/plans/${planId}`, { method: "DELETE" }).catch(() => null);
    setBusy(false);
    setDiscarding(false);
    if (res?.status === 401) {
      router.replace(EXPIRED);
      return;
    }
    if (res?.status === 423) {
      setLock({ by: (await res.json().catch(() => null))?.detail?.by ?? null });
      showToast("다른 관리자가 편집 중이라 버리지 못했어요", "error");
      return;
    }
    if (!res?.ok && res?.status !== 404) {
      showToast("초안을 버리지 못했어요. 잠시 뒤 다시 시도하세요", "error");
      return;
    }
    dirtyRef.current = false;
    showToast(`초안을 버렸어요 (v${draft.version}). 직원 화면은 그대로예요`);
    await reload();
  }

  async function overwriteMine() {
    if (!conflict) return;
    revRef.current = conflict.revision;
    setConflict(null);
    blockedRef.current = readOnly;
    dirtyRef.current = true;
    await flush();
  }

  async function reloadTheirs() {
    const fresh = await reload();
    if (fresh?.draft?.id === planId) {
      adopt(fresh);
      setHistory({ past: [], future: [] });
    }
    setConflict(null);
  }

  // 화면 -----------------------------------------------------------------------

  const problems = useMemo(() => problemsOf(geometry, width, height), [geometry, width, height]);
  const problemIds = useMemo(() => new Set(problems.map((p) => p.elementId)), [problems]);
  const selected = useMemo(() => geometry.elements.filter((e) => selectedIds.includes(e.id)), [geometry, selectedIds]);

  let status: string;
  if (save.state === "error") status = save.message ?? "저장하지 못했어요";
  else if (save.state === "dirty" || save.state === "saving") status = "저장 중…";
  else if (save.at)
    status = `${save.state === "saved" ? "자동 저장됨" : "마지막 저장"} ${agoText(save.at, now)}`.trim();
  else status = "";
  const draftLabel = `초안 v${draft.version}${draft.base_version ? ` (v${draft.base_version}에서)` : ""}`;

  const pickTool = (next: Tool) => {
    setTool(next);
    if (next !== "select") setSelectedIds([]);
  };

  const palette = (
    <section className={ui.card} aria-labelledby="palette-title">
      <h2 id="palette-title" className={ui.cardTitle}>
        그리기
      </h2>
      <div className={styles.palette}>
        <div className={styles.paletteGrid}>
          <PaletteItem type="select" label="선택·이동" active={tool === "select"} onClick={() => pickTool("select")} />
          <PaletteItem
            type="wall"
            label="벽"
            active={tool === "wall"}
            disabled={readOnly}
            onClick={() => pickTool("wall")}
          />
          <PaletteItem
            type="wall_line"
            label="선 벽"
            active={tool === "wall_line"}
            disabled={readOnly}
            onClick={() => pickTool("wall_line")}
          />
          <PaletteItem
            type="pillar"
            label="기둥"
            active={tool === "pillar"}
            disabled={readOnly}
            onClick={() => pickTool("pillar")}
          />
          <PaletteItem
            type="room"
            label="회의실"
            active={tool === "room"}
            disabled={readOnly}
            onClick={() => pickTool("room")}
          />
        </div>
        <h3>출입구</h3>
        <div className={styles.paletteGrid}>
          <PaletteItem
            type="entrance"
            main
            label="주 출입구"
            active={tool === "entrance" && entranceMain}
            disabled={readOnly}
            onClick={() => {
              setEntranceMain(true);
              pickTool("entrance");
            }}
          />
          <PaletteItem
            type="entrance"
            label="출입구"
            active={tool === "entrance" && !entranceMain}
            disabled={readOnly}
            onClick={() => {
              setEntranceMain(false);
              pickTool("entrance");
            }}
          />
        </div>
        <h3>공간</h3>
        <div className={styles.paletteGrid}>
          {SPACE_KINDS.map((k) => (
            <PaletteItem
              key={k.kind}
              type="space"
              hatch={HATCHED.includes(k.kind)}
              label={k.label}
              active={tool === "space" && spaceKind === k.kind}
              disabled={readOnly}
              onClick={() => {
                setSpaceKind(k.kind);
                pickTool("space");
              }}
            />
          ))}
        </div>
        <h3>책상 (칸 하나 = 좌석 하나)</h3>
        <div className={styles.paletteGrid}>
          {PRESETS.map((p) => (
            <PaletteItem
              key={p.key}
              type="desk"
              desk={p}
              label={p.label}
              active={tool === "desk" && preset === p.key}
              disabled={readOnly}
              onClick={() => {
                setPreset(p.key);
                pickTool("desk");
              }}
            />
          ))}
        </div>
      </div>
    </section>
  );

  const panel = (
    <PlanPanel
      geometry={geometry}
      selected={selected}
      width={width}
      height={height}
      live={data.live}
      readOnly={readOnly}
      problems={problems}
      onChange={replaceElements}
      onGeometry={commitGeometry}
      onDelete={deleteSelected}
      onDuplicate={duplicateSelected}
      onCopy={copySelected}
      onSelect={(id) => setSelectedIds(id ? [id] : [])}
      onResize={resizePlan}
      onResizeDialog={() => setResizing(true)}
      onNotice={(text) => showToast(text)}
    />
  );

  const hint = readOnly
    ? "보기만 할 수 있어요. 요소를 누르면 속성을 볼 수 있어요."
    : tool === "select"
      ? "요소를 누르면 바로 위에 도구 막대(돌리기·복제·지우기 등)가 떠요. 끌어서 옮기고, Ctrl(⌘)·Shift+누르기나 빈 곳에서 끌어 여러 개를 골라요. 선 벽 끝은 가까운 벽·선 끝에 저절로 붙어요."
      : tool === "desk"
        ? `도면을 누르면 ${PRESETS.find((p) => p.key === preset)?.label} 묶음이 놓여요. Esc로 그만 놓기`
        : tool === "wall_line"
          ? `끌어서 선 벽을 그려요. 동그라미(다른 선 끝·벽 모서리)나 벽 가까이 가면 초록 표시와 함께 붙고, 가로·세로가 맞으면 안내선이 떠요. Shift: 45도씩 · Alt: 붙이지 않기. 누르기만 하면 ${DEFAULT_SIZE.wall_line.w}m 가로 선이 놓여요.`
          : `끌어서 ${tool === "space" ? SPACE_KINDS.find((k) => k.kind === spaceKind)?.label : tool === "entrance" ? (entranceMain ? "주 출입구" : "출입구") : TYPE_LABEL[tool]} 사각형을 그려요. 누르기만 하면 ${DEFAULT_SIZE[tool].w}×${DEFAULT_SIZE[tool].h}m로 놓여요.`;

  return (
    <>
      <Header
        admin={admin}
        data={data}
        goFloor={async (id) => {
          await flush();
          goFloor(id);
        }}
        status={
          <span className={ui.status} role="status" data-tone={save.state === "error" ? "error" : undefined}>
            {draftLabel}
            {status && ` · ${status}`}
            {save.state === "error" && !conflict && !readOnly && (
              <button type="button" className={ui.linkButton} onClick={() => void flush()}>
                다시 저장
              </button>
            )}
          </span>
        }
      >
        <button type="button" className={ui.btn} onClick={() => setExporting(true)}>
          내보내기
        </button>
        <button type="button" className={ui.btn} disabled={readOnly || busy} onClick={() => setDiscarding(true)}>
          초안 버리기
        </button>
        <button
          type="button"
          className={`${ui.btn} ${ui.pri}`}
          disabled={readOnly || busy || conflict !== null}
          onClick={() => void openPublish()}
        >
          도면 게시…
        </button>
      </Header>

      {lock && (
        <p className={styles.banner} role="status">
          {lock.by
            ? `${lock.by} 님이 이 초안을 편집 중이에요. 보기만 할 수 있어요.`
            : "편집하던 관리자가 나갔어요. 이어서 편집할 수 있어요."}
          <button type="button" disabled={busy} onClick={() => void takeOver()}>
            {lock.by ? "편집 넘겨받기" : "이어서 편집"}
          </button>
          {lock.by && (save.state === "dirty" || save.state === "error") && (
            <span>(이 화면에서 저장 못 한 변경은 버려져요)</span>
          )}
        </p>
      )}
      {conflict && (
        <p className={styles.banner} data-tone="error" role="alert">
          다른 화면에서 이 초안을 먼저 저장했어요. 내 마지막 변경은 아직 저장되지 않았어요.
          <button type="button" onClick={() => void reloadTheirs()}>
            저장된 초안 다시 불러오기
          </button>
          <button type="button" onClick={() => void overwriteMine()}>
            내 것으로 덮어쓰기
          </button>
        </p>
      )}
      {!lock && !conflict && (
        <p className={ui.infoBar}>
          초안은 게시하기 전까지 직원 화면에 보이지 않아요. 책상 칸 하나가 좌석 하나이고, 지금 좌석과 이어진 책상은
          옮기거나 번호를 바꿔도 앉은 사람이 그대로예요.
        </p>
      )}
      {notice && <p className={ui.notice}>{notice}</p>}

      <div ref={pageRef} className={`${ui.body} ${styles.body}`} data-cols={cols}>
        {cols === 3 && <aside className={ui.left}>{palette}</aside>}
        <div className={ui.center}>
          <div className={ui.toolbar}>
            <div className={ui.rowButtons} style={{ flex: "none" }}>
              <button
                type="button"
                className={ui.btn}
                onClick={undo}
                disabled={readOnly || history.past.length === 0}
                title="되돌리기 (Ctrl+Z)"
              >
                되돌리기
              </button>
              <button
                type="button"
                className={ui.btn}
                onClick={redo}
                disabled={readOnly || history.future.length === 0}
                title="다시 하기 (Ctrl+Shift+Z)"
              >
                다시 하기
              </button>
              <button
                type="button"
                className={ui.btn}
                onClick={paste}
                disabled={readOnly || !clip}
                title={clip ? `붙여넣기 (Ctrl+V): ${clip.floor} ${clipText(clip.elements)}` : "복사한 요소가 없어요"}
              >
                붙여넣기
              </button>
            </div>
            <span className={styles.coords} aria-live="off">
              {cursor ? `x ${cursor.x.toFixed(2)} · y ${cursor.y.toFixed(2)} m` : ""}
            </span>
            <button
              type="button"
              className={`${ui.btn} mono`}
              disabled={readOnly}
              onClick={() => setResizing(true)}
              title="사무실(도면) 크기 바꾸기"
            >
              {width} × {height} m
            </button>
            <label className={ui.check}>
              <input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} />
              0.5m 칸에 맞추기
            </label>
            <label className={ui.check}>
              <input type="checkbox" checked={showDims} onChange={(e) => setShowDims(e.target.checked)} />
              치수 보기
            </label>
            <button
              type="button"
              className={ui.btn}
              disabled={readOnly || !geometry.elements.some((e) => e.type === "wall_line")}
              onClick={() => setTidying(true)}
              title="기운 선 벽을 곧게 펴고 벌어진 끝을 이어요"
            >
              선 정리…
            </button>
            {background ? (
              <span className={styles.bgControls}>
                <label className={ui.check}>
                  <input
                    type="checkbox"
                    checked={background.visible}
                    onChange={(e) => void toggleBackground(e.target.checked)}
                  />
                  밑그림
                </label>
                <button type="button" className={ui.btn} onClick={() => setBgEditing(true)} title="밑그림 자리·진하기">
                  밑그림…
                </button>
              </span>
            ) : (
              <button
                type="button"
                className={ui.btn}
                disabled={readOnly}
                onClick={() => setImporting(true)}
                title="도면 그림·PDF·엑셀을 밑그림으로 깔고 벽·방·책상을 찾아 더해요"
              >
                도면 파일 깔기…
              </button>
            )}
            <ZoomControls zoom={zoom} onZoom={setZoom} />
          </div>
          <p
            className={`${ui.modeBar} ${styles.hintBar}`}
            data-tone={tool !== "select" && !readOnly ? "zone" : undefined}
          >
            {hint}
          </p>
          <div className={ui.canvasCard}>
            <PlanCanvas
              geometry={geometry}
              width={width}
              height={height}
              zoom={zoom}
              onZoom={setZoom}
              tool={tool}
              snap={snap}
              readOnly={readOnly}
              selectedIds={selectedIds}
              live={data.live}
              problemIds={problemIds}
              showDims={showDims}
              onSelect={setSelectedIds}
              onDraw={onDraw}
              onDrawLine={onDrawLine}
              onPlaceDesk={onPlaceDesk}
              onChange={(els) => replaceElements(els)}
              onCursor={setCursor}
              underlay={
                background?.visible
                  ? {
                      url: background.url,
                      x: background.x_m,
                      y: background.y_m,
                      w: background.w_m,
                      h: background.h_m,
                      opacity: background.opacity,
                    }
                  : null
              }
              toolbar={(sel) => (
                <SelectionToolbar
                  selected={sel}
                  readOnly={readOnly}
                  onRotate={rotateSelected}
                  onStraighten={straightenSelected}
                  onTidy={() => setTidying(true)}
                  onAlign={alignSelected}
                  onDuplicate={duplicateSelected}
                  onCopy={copySelected}
                  onDelete={deleteSelected}
                />
              )}
            />
          </div>
          <p className={ui.hint}>
            ● 앉은 사람이 있는 책상 · 파란 점선 = 새 책상(게시하면 좌석이 생겨요) · 빨간 테두리 = 게시 전에 고칠 것
          </p>
        </div>
        <aside className={ui.right}>
          {panel}
          {cols !== 3 && palette}
        </aside>
      </div>

      {publishing && (
        <PublishDialog
          planId={planId}
          floorName={`${data.floor.site.name} ${data.floor.name}`}
          first={!data.published}
          onClose={() => setPublishing(false)}
          onPublished={(r) => void onPublished(r)}
          onScheduled={(r) => void onScheduled(r)}
          onShowElement={(id) => {
            setPublishing(false);
            setTool("select");
            setSelectedIds([id]);
          }}
          onExpired={() => router.replace(EXPIRED)}
        />
      )}

      {tidying && (
        <TidyDialog
          elements={geometry.elements}
          selectedLines={selected.filter((e) => e.type === "wall_line").map((e) => e.id)}
          onClose={() => setTidying(false)}
          onApply={applyTidy}
        />
      )}

      {importing && (
        <ImportWizard
          mode="draft"
          data={{ ...data, size: { width_m: width, height_m: height } }}
          onClose={() => setImporting(false)}
          onExpired={() => router.replace(EXPIRED)}
          onApply={applyImport}
        />
      )}

      {bgEditing && background && (
        <BackgroundDialog
          floorId={data.floor.id}
          background={background}
          readOnly={readOnly}
          onClose={() => setBgEditing(false)}
          onChange={setBackground}
          onReplace={() => {
            setBgEditing(false);
            setImporting(true);
          }}
          onExpired={() => router.replace(EXPIRED)}
        />
      )}

      {resizing && (
        <ResizeDialog
          width={width}
          height={height}
          onClose={() => setResizing(false)}
          onApply={(size, scale, desks) => resizeScaled(size, scale, desks)}
        />
      )}

      {exporting && (
        <FloorExportDialog
          drawing={drawingFromPlan(geometry, width, height, data.live)}
          title={`${data.floor.site.name} ${data.floor.name} 도면 초안 v${draft.version}`}
          fileBase={`${data.floor.name}-도면초안-v${draft.version}`}
          onClose={() => setExporting(false)}
        />
      )}

      <Dialog
        open={discarding}
        onClose={() => setDiscarding(false)}
        title={`초안 v${draft.version} 버리기`}
        footer={
          <>
            <button type="button" className={ui.btn} onClick={() => setDiscarding(false)}>
              그대로 두기
            </button>
            <button type="button" className={`${ui.btn} ${ui.danger}`} disabled={busy} onClick={() => void discard()}>
              초안 버리기
            </button>
          </>
        }
      >
        <div className={ui.dialogBody}>
          <p>
            게시하지 않은 초안이라 지우면 되돌릴 수 없어요. 직원 화면과 지금 게시본
            {data.published ? ` v${data.published.version}` : ""}은 그대로예요.
          </p>
        </div>
      </Dialog>
    </>
  );
}

function PaletteItem({
  type,
  label,
  active,
  disabled,
  hatch,
  main,
  desk,
  onClick,
}: {
  type: Tool;
  label: string;
  active: boolean;
  disabled?: boolean;
  hatch?: boolean;
  main?: boolean;
  desk?: { layout: DeskGroup["layout"]; rows: number; cols: number };
  onClick: () => void;
}) {
  return (
    <button type="button" className={styles.paletteItem} aria-pressed={active} disabled={disabled} onClick={onClick}>
      <span
        className={styles.glyph}
        data-type={type}
        data-hatch={hatch || undefined}
        data-main={main || undefined}
        style={desk ? { gridTemplateColumns: `repeat(${Math.min(desk.cols, 6)}, 1fr)` } : undefined}
        aria-hidden="true"
      >
        {desk && Array.from({ length: Math.min(desk.rows, 2) * Math.min(desk.cols, 6) }, (_, i) => <i key={i} />)}
      </span>
      {label}
    </button>
  );
}
