"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Dialog from "@/components/Dialog";
import type {
  Admin,
  DeskGroup,
  FloorEvent,
  PlanEditorData,
  PlanElement,
  PlanGeometry,
  PlanRect,
  SpaceKind,
} from "@/lib/api";
import { agoText, kstDate } from "@/lib/dates";
import { groupSize, makeDeskGroup, newId, problemsOf, snapTo, SPACE_KINDS, TYPE_LABEL } from "@/lib/planGeometry";
import { useNow } from "@/lib/useNow";
import ui from "../seating/seating.module.css";
import PlanCanvas, { type DrawTool, type Tool } from "./PlanCanvas";
import PlanPanel from "./PlanPanel";
import PublishDialog, { type PublishResult } from "./PublishDialog";
import styles from "./plans.module.css";

const EXPIRED = "/admin/login?reason=expired&next=/admin/plans";
const SAVE_DELAY_MS = 1500; // 마지막으로 바꾸고 이만큼 쉬면 자동 저장
const HEARTBEAT_MS = 30_000; // 편집 중 표시 (서버는 2분 소식이 없으면 잠금을 푼다)
const WATCH_MS = 15_000; // 보기만 할 때 다른 사람의 편집을 다시 읽는 간격
const COALESCE_MS = 1500; // 같은 칸을 이만큼 안에 이어서 고치면 되돌리기 한 번으로 묶는다
const HISTORY_MAX = 100;
const ZOOM_STEPS = [0.75, 1, 1.25, 1.5, 2, 3];
// 도구가 도면 옆에 있어야 편하므로 좌석 배치 화면보다 좁은 폭에서도 세 단으로 둔다 (왼쪽 단을 좁게)
const THREE_COLUMNS_PX = 1100;
const TWO_COLUMNS_PX = 760;
const json = { "content-type": "application/json" };

/** 누르기만 했을 때 놓이는 기본 크기 (m) */
const DEFAULT_SIZE: Record<DrawTool, { w: number; h: number }> = {
  wall: { w: 4, h: 0.3 },
  pillar: { w: 0.6, h: 0.6 },
  space: { w: 4, h: 3 },
  room: { w: 5, h: 4 },
};

const PRESETS: { key: string; label: string; layout: DeskGroup["layout"]; rows: number; cols: number }[] = [
  { key: "single", label: "1인 책상", layout: "one", rows: 1, cols: 1 },
  { key: "face", label: "마주보기 6석", layout: "face", rows: 2, cols: 3 },
  { key: "row", label: "한 방향 4석", layout: "one", rows: 1, cols: 4 },
  { key: "island", label: "팀 섬 12석", layout: "face", rows: 2, cols: 6 },
];

const HATCHED: SpaceKind[] = ["core", "restroom", "service", "restricted"];

type Toast = { text: string; tone?: "error" } | null;
type SaveState = { state: "clean" | "dirty" | "saving" | "saved" | "error"; message?: string; at?: string };
/** 잠김: 다른 사람이 편집 중(by) 이거나, 그 사람이 나가서 이어 받을 수 있음(by = null) */
type Lock = { by: string | null } | null;

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
      router.replace(EXPIRED);
      return null;
    }
    if (!res?.ok) return null;
    const fresh = (await res.json()) as PlanEditorData;
    setData(fresh);
    return fresh;
  }, [floorId, router]);

  const goFloor = useCallback((id: number) => router.push(`/admin/plans?floor=${id}`), [router]);

  return (
    <div className={ui.page}>
      {data.draft ? (
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
    </div>
  );
}

type ScreenProps = {
  admin: Admin;
  data: PlanEditorData;
  setData: (d: PlanEditorData) => void;
  reload: () => Promise<PlanEditorData | null>;
  showToast: (text: string, tone?: "error") => void;
  goFloor: (id: number) => void;
  notice: string | null;
};

function Header({
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

// 시작 화면 --------------------------------------------------------------------

function StartScreen({ admin, data, setData, reload, showToast, goFloor, notice }: ScreenProps) {
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState(String(data.sources[0]?.id ?? ""));
  const [archived, setArchived] = useState(String(data.archived[0]?.id ?? ""));
  const router = useRouter();
  const now = useNow();
  const { width_m: w, height_m: h } = data.size;
  const pub = data.published;

  async function create(body: { source: string; plan_id?: number; floor_id?: number }) {
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/floors/${data.floor.id}/plan/draft`, {
        method: "POST",
        headers: json,
        body: JSON.stringify(body),
      });
      if (res.status === 401) {
        router.replace(EXPIRED);
        return;
      }
      const out = await res.json().catch(() => null);
      if (!res.ok) {
        if (out?.detail?.code === "HAS_DRAFT") {
          showToast("그새 다른 관리자가 초안을 만들었어요. 그 초안을 열었어요");
          await reload();
        } else showToast("초안을 만들지 못했어요. 잠시 뒤 다시 시도하세요", "error");
        return;
      }
      setData(out as PlanEditorData);
      showToast("초안을 만들었어요. 게시하기 전까지 직원 화면에는 보이지 않아요");
    } catch {
      showToast("네트워크 오류로 초안을 만들지 못했어요", "error");
    } finally {
      setBusy(false);
    }
  }

  const versionText = (p: { version: number; published_at: string | null; published_by: string | null }) =>
    `v${p.version}${p.published_at ? ` · ${kstDate(p.published_at)}` : ""}${p.published_by ? ` · ${p.published_by}` : ""}`;

  return (
    <>
      <Header admin={admin} data={data} goFloor={goFloor} />
      <p className={ui.infoBar}>
        {data.floor.name}에는 편집 중인 초안이 없어요. 어디서 시작할지 고르세요. 초안은 게시하기 전까지 직원 화면에
        보이지 않고, 게시하면 좌석·회의실이 초안에 맞춰져요.
      </p>
      {notice && <p className={ui.notice}>{notice}</p>}
      <div className={styles.start}>
        <div className={styles.startGrid}>
          <section className={styles.startCard} data-main={pub ? true : undefined}>
            <h3>지금 게시본에서</h3>
            <p>
              {pub
                ? `${versionText(pub)}. 지금 도면을 그대로 가져와 고쳐요. 책상·회의실이 지금 좌석·예약과 이어져 있어, 옮기거나 번호를 바꿔도 앉은 사람은 그대로예요.`
                : "아직 게시한 도면이 없어요."}
            </p>
            <button
              type="button"
              className={`${ui.btn} ${ui.pri}`}
              disabled={!pub || busy}
              onClick={() => void create({ source: "published" })}
            >
              게시본으로 초안 만들기
            </button>
          </section>
          <section className={styles.startCard}>
            <h3>빈 도면</h3>
            <p>
              {w} × {h} m, 바깥 벽만 있어요.
              {pub && " 게시하면 지금 좌석은 모두 없어지고, 앉은 사람은 게시할 때 새 자리를 고르거나 미배치가 돼요."}
            </p>
            <button type="button" className={ui.btn} disabled={busy} onClick={() => void create({ source: "blank" })}>
              빈 도면으로 시작
            </button>
          </section>
          <section className={styles.startCard}>
            <h3>다른 층 복제</h3>
            <p>다른 층 게시본의 모양만 가져와요. 지금 좌석과는 이어지지 않아, 좌석 번호를 확인하고 게시하세요.</p>
            <select
              className={ui.select}
              aria-label="복제할 층"
              value={source}
              disabled={data.sources.length === 0}
              onChange={(e) => setSource(e.target.value)}
            >
              {data.sources.length === 0 && <option value="">복제할 층이 없어요</option>}
              {data.sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.site} {s.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className={ui.btn}
              disabled={!source || busy}
              onClick={() => void create({ source: "floor", floor_id: Number(source) })}
            >
              복제해서 시작
            </button>
          </section>
          <section className={styles.startCard}>
            <h3>보관본에서 다시 시작</h3>
            <p>예전에 게시했던 도면으로 돌아가요. 게시해야 직원 화면이 바뀌어요.</p>
            <select
              className={ui.select}
              aria-label="보관본"
              value={archived}
              disabled={data.archived.length === 0}
              onChange={(e) => setArchived(e.target.value)}
            >
              {data.archived.length === 0 && <option value="">보관본이 없어요</option>}
              {data.archived.map((p) => (
                <option key={p.id} value={p.id}>
                  {versionText(p)}
                  {p.note ? ` · ${p.note}` : ""}
                </option>
              ))}
            </select>
            <button
              type="button"
              className={ui.btn}
              disabled={!archived || busy}
              onClick={() => void create({ source: "archived", plan_id: Number(archived) })}
            >
              이 보관본으로 시작
            </button>
          </section>
        </div>

        {(pub || data.archived.length > 0) && (
          <section className={ui.card} aria-labelledby="plan-history">
            <h2 id="plan-history" className={ui.cardTitle}>
              게시 기록
            </h2>
            <ul className={styles.history}>
              {[
                ...(pub ? [{ ...pub, current: true }] : []),
                ...data.archived.map((p) => ({ ...p, current: false })),
              ].map((p) => (
                <li key={p.id}>
                  <strong>v{p.version}</strong>
                  <span>{p.current ? "지금 게시본" : "보관본"}</span>
                  <span className={ui.muted}>
                    {p.published_at ? `${kstDate(p.published_at)} (${agoText(p.published_at, now)})` : ""}
                    {p.published_by ? ` · ${p.published_by}` : ""}
                  </span>
                  {p.note && <span>“{p.note}”</span>}
                </li>
              ))}
            </ul>
            <p className={ui.hint}>보관본은 5년 동안 남아요.</p>
          </section>
        )}
      </div>
    </>
  );
}

// 초안 편집 --------------------------------------------------------------------

type History = { past: PlanGeometry[]; future: PlanGeometry[] };

function DraftEditor({ admin, data, reload, showToast, goFloor, notice }: ScreenProps) {
  const router = useRouter();
  const draft = data.draft!;
  const planId = draft.id;
  const { width_m: width, height_m: height } = data.size;
  const now = useNow();

  const [geometry, setGeometry] = useState<PlanGeometry>(draft.geometry);
  const [history, setHistory] = useState<History>({ past: [], future: [] });
  const [tool, setTool] = useState<Tool>("select");
  const [spaceKind, setSpaceKind] = useState<SpaceKind>("lounge");
  const [preset, setPreset] = useState(PRESETS[1].key);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [snap, setSnap] = useState(true);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [save, setSave] = useState<SaveState>({ state: "clean", at: draft.updated_at });
  const [lock, setLock] = useState<Lock>(() =>
    draft.editing && !draft.editing.mine ? { by: draft.editing.name } : null,
  );
  const [conflict, setConflict] = useState<{ revision: number } | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [discarding, setDiscarding] = useState(false);
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
  const geoRef = useRef(geometry);
  const revRef = useRef(draft.revision);
  const dirtyRef = useRef(false);
  const blockedRef = useRef(false); // 잠김·충돌 중에는 저장하지 않는다
  const lastEdit = useRef<{ key: string | null; at: number }>({ key: null, at: 0 });
  useEffect(() => {
    geoRef.current = geometry;
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
          body: JSON.stringify({ revision: revRef.current, geometry: geoRef.current }),
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
    setGeometry(fresh.draft.geometry);
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

  async function takeOver() {
    setBusy(true);
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
        const fresh = await reload();
        if (!fresh?.draft || fresh.draft.id !== planId) return;
        adopt(fresh);
        const editing = fresh.draft.editing;
        setLock(editing && !editing.mine ? { by: editing.name } : { by: null });
      }, WATCH_MS);
      return () => clearInterval(timer);
    }
    const first = setTimeout(() => void claim(false), 0);
    const timer = setInterval(() => void claim(false), HEARTBEAT_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [readOnly, claim, reload, adopt, planId]);

  // 다른 관리자가 이 층에 게시하거나 좌석을 바꾸면 다시 읽는다 (앉은 사람·예약 표시)
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  });
  useEffect(() => {
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const later = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void refreshRef.current(), 500);
    };
    source = new EventSource("/api/admin/stream");
    source.addEventListener("floor", (event) => {
      const change = JSON.parse((event as MessageEvent<string>).data) as FloorEvent;
      if (change.floor_id === data.floor.id && change.kind !== "requests") later();
    });
    return () => {
      clearTimeout(timer);
      source?.close();
    };
  }, [data.floor.id]);

  // 바꾸기 ---------------------------------------------------------------------

  const commit = useCallback(
    (next: PlanGeometry, key?: string) => {
      if (blockedRef.current) return;
      const at = Date.now();
      const coalesce = !!key && lastEdit.current.key === key && at - lastEdit.current.at < COALESCE_MS;
      lastEdit.current = { key: key ?? null, at };
      const prev = geoRef.current;
      setHistory((h) => ({ past: coalesce ? h.past : [...h.past.slice(-(HISTORY_MAX - 1)), prev], future: [] }));
      geoRef.current = next;
      setGeometry(next);
      markDirty();
    },
    [markDirty],
  );

  const replaceElement = useCallback(
    (el: PlanElement, key?: string) => {
      const g = geoRef.current;
      commit({ ...g, elements: g.elements.map((e) => (e.id === el.id ? el : e)) }, key);
    },
    [commit],
  );

  function addElement(el: PlanElement) {
    const g = geoRef.current;
    commit({ ...g, elements: [...g.elements, el] });
    setSelectedId(el.id);
    setTool("select");
  }

  const undo = useCallback(() => {
    if (blockedRef.current) return;
    setHistory((h) => {
      if (h.past.length === 0) return h;
      const prev = h.past[h.past.length - 1];
      const current = geoRef.current;
      geoRef.current = prev;
      setGeometry(prev);
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
      const current = geoRef.current;
      geoRef.current = next;
      setGeometry(next);
      return { past: [...h.past, current], future: rest };
    });
    lastEdit.current = { key: null, at: 0 };
    markDirty();
  }, [markDirty]);

  function nextRoomName(base = "회의실"): string {
    const names = new Set(geoRef.current.elements.flatMap((e) => (e.type === "room" ? [e.name] : [])));
    for (let n = 1; ; n++) {
      const name = `${base} ${n}`;
      if (!names.has(name)) return name;
    }
  }

  function onDraw(rect: PlanRect) {
    if (tool === "select" || tool === "desk") return;
    const tiny = rect.w < 0.3 && rect.h < 0.3;
    const r = tiny
      ? { x: rect.x, y: rect.y, ...DEFAULT_SIZE[tool] }
      : { ...rect, w: Math.max(rect.w, 0.2), h: Math.max(rect.h, 0.2) };
    if (tool === "wall") addElement({ id: newId("wall"), type: "wall", ...r });
    else if (tool === "pillar") addElement({ id: newId("pillar"), type: "pillar", ...r });
    else if (tool === "space") addElement({ id: newId("space"), type: "space", kind: spaceKind, label: "", ...r });
    else addElement({ id: newId("room"), type: "room", name: nextRoomName(), capacity: 6, equipment: [], ...r });
  }

  function onPlaceDesk(point: { x: number; y: number }) {
    const p = PRESETS.find((x) => x.key === preset) ?? PRESETS[0];
    const size = groupSize(p, width, height);
    const group = makeDeskGroup(
      snapTo(point.x - size.w / 2, snap),
      snapTo(point.y - size.h / 2, snap),
      p,
      geoRef.current,
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
    const g = geoRef.current;
    const el = g.elements.find((e) => e.id === selectedId);
    if (!el) return;
    commit({ ...g, elements: g.elements.filter((e) => e.id !== el.id) });
    setSelectedId(null);
    showToast(lossText(el) ?? `${TYPE_LABEL[el.type]}을 지웠어요 · 되돌리기 Ctrl+Z`);
  }, [selectedId, commit, lossText, showToast]);

  const duplicateSelected = useCallback(() => {
    const g = geoRef.current;
    const el = g.elements.find((e) => e.id === selectedId);
    if (!el) return;
    let copy: PlanElement;
    if (el.type === "desk_group") {
      const prefix = el.cells.find((c) => c.desk && c.code)?.code.split("-")[0] || "N";
      const made = makeDeskGroup(el.x + 1, el.y + 1, el, g, prefix);
      copy = { ...made, cells: made.cells.map((c, i) => ({ ...c, desk: el.cells[i].desk })) };
    } else if (el.type === "room") {
      copy = {
        ...el,
        id: newId("room"),
        x: el.x + 1,
        y: el.y + 1,
        name: nextRoomName(el.name.replace(/\s*\d+$/, "") || "회의실"),
      };
    } else {
      copy = { ...el, id: newId(el.type), x: el.x + 1, y: el.y + 1 };
    }
    addElement(copy);
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  // 키보드: Delete 지우기, 방향키 옮기기, Ctrl+Z/Y 되돌리기·다시, Ctrl+D 복제, Esc 놓기
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.target as Element).closest("input, textarea, select, dialog, [contenteditable]")) return;
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
        else setSelectedId(null);
        return;
      }
      if (readOnly || !selectedId) return;
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
      const arrows: Record<string, [number, number]> = {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
      };
      const dir = arrows[event.key];
      if (!dir) return;
      event.preventDefault();
      const el = geoRef.current.elements.find((e) => e.id === selectedId);
      if (!el) return;
      const step = event.shiftKey ? 1 : snap ? 0.5 : 0.1;
      replaceElement(
        { ...el, x: Math.round((el.x + dir[0] * step) * 100) / 100, y: Math.round((el.y + dir[1] * step) * 100) / 100 },
        `${el.id}:arrow`,
      );
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [tool, readOnly, selectedId, snap, undo, redo, deleteSelected, duplicateSelected, replaceElement]);

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
  const selected = geometry.elements.find((e) => e.id === selectedId) ?? null;

  let status: string;
  if (save.state === "error") status = save.message ?? "저장하지 못했어요";
  else if (save.state === "dirty" || save.state === "saving") status = "저장 중…";
  else if (save.at)
    status = `${save.state === "saved" ? "자동 저장됨" : "마지막 저장"} ${agoText(save.at, now)}`.trim();
  else status = "";
  const draftLabel = `초안 v${draft.version}${draft.base_version ? ` (v${draft.base_version}에서)` : ""}`;

  const pickTool = (next: Tool) => {
    setTool(next);
    if (next !== "select") setSelectedId(null);
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
      onChange={replaceElement}
      onDelete={deleteSelected}
      onDuplicate={duplicateSelected}
      onSelect={setSelectedId}
      onNotice={(text) => showToast(text)}
    />
  );

  const hint = readOnly
    ? "보기만 할 수 있어요. 요소를 누르면 속성을 볼 수 있어요."
    : tool === "select"
      ? "요소를 눌러 고르고 끌어서 옮겨요. 손잡이로 크기를 바꾸고, 방향키로 조금씩(Shift는 1m), Delete로 지워요."
      : tool === "desk"
        ? `도면을 누르면 ${PRESETS.find((p) => p.key === preset)?.label} 묶음이 놓여요. Esc로 그만 놓기`
        : `끌어서 ${tool === "space" ? SPACE_KINDS.find((k) => k.kind === spaceKind)?.label : TYPE_LABEL[tool]} 사각형을 그려요. 누르기만 하면 ${DEFAULT_SIZE[tool].w}×${DEFAULT_SIZE[tool].h}m로 놓여요.`;

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
            </div>
            <span className={styles.coords} aria-live="off">
              {cursor ? `x ${cursor.x.toFixed(1)} · y ${cursor.y.toFixed(1)} m` : `${width} × ${height} m`}
            </span>
            <label className={ui.check}>
              <input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} />
              0.5m 칸에 맞추기
            </label>
            <div className={ui.zoom} role="group" aria-label="확대·축소">
              <button
                type="button"
                aria-label="축소"
                disabled={zoom <= ZOOM_STEPS[0]}
                onClick={() => setZoom(ZOOM_STEPS[Math.max(0, ZOOM_STEPS.indexOf(zoom) - 1)])}
              >
                −
              </button>
              <button type="button" aria-label="원래 크기" onClick={() => setZoom(1)}>
                {Math.round(zoom * 100)}%
              </button>
              <button
                type="button"
                aria-label="확대"
                disabled={zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]}
                onClick={() => setZoom(ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, ZOOM_STEPS.indexOf(zoom) + 1)])}
              >
                +
              </button>
            </div>
          </div>
          <p className={ui.modeBar} data-tone={tool !== "select" && !readOnly ? "zone" : undefined}>
            {hint}
          </p>
          <div className={ui.canvasCard}>
            <PlanCanvas
              geometry={geometry}
              width={width}
              height={height}
              zoom={zoom}
              tool={tool}
              snap={snap}
              readOnly={readOnly}
              selectedId={selectedId}
              live={data.live}
              problemIds={problemIds}
              onSelect={setSelectedId}
              onDraw={onDraw}
              onPlaceDesk={onPlaceDesk}
              onChange={(el) => replaceElement(el)}
              onCursor={setCursor}
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
          onShowElement={(id) => {
            setPublishing(false);
            setTool("select");
            setSelectedId(id);
          }}
          onExpired={() => router.replace(EXPIRED)}
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
  desk,
  onClick,
}: {
  type: "select" | "wall" | "pillar" | "room" | "space" | "desk";
  label: string;
  active: boolean;
  disabled?: boolean;
  hatch?: boolean;
  desk?: { layout: DeskGroup["layout"]; rows: number; cols: number };
  onClick: () => void;
}) {
  return (
    <button type="button" className={styles.paletteItem} aria-pressed={active} disabled={disabled} onClick={onClick}>
      <span
        className={styles.glyph}
        data-type={type}
        data-hatch={hatch || undefined}
        style={desk ? { gridTemplateColumns: `repeat(${Math.min(desk.cols, 6)}, 1fr)` } : undefined}
        aria-hidden="true"
      >
        {desk && Array.from({ length: Math.min(desk.rows, 2) * Math.min(desk.cols, 6) }, (_, i) => <i key={i} />)}
      </span>
      {label}
    </button>
  );
}
