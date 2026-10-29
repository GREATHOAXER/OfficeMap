"use client";

import { type PointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Dialog from "@/components/Dialog";
import type { PlanEditorData, PlanElement } from "@/lib/api";
import {
  type Box,
  DETECT_DEFAULTS,
  type DetectOptions,
  type DetectResult,
  detectPlan,
  floorName,
  type Gray,
} from "@/lib/planDetect";
import {
  ACCEPT,
  canvasFile,
  contentBox,
  cropGray,
  fitScale,
  freeCanvas,
  grayOf,
  MAX_RENDER_SIDE,
  openPlanFile,
  PlanFileError,
  type SourceFile,
  type SourcePage,
} from "@/lib/planFile";
import { cellCenter, MAX_SIZE, MIN_SIZE, newId, seatDims } from "@/lib/planGeometry";
import ui from "../seating/seating.module.css";
import { json } from "./shared";
import styles from "./plans.module.css";

// 도면 파일로 초안 만들기: 그림·PDF·엑셀을 읽어 쪽(시트)마다 층을 고르고, 도면 부분·실제 크기를 정하면
// 벽·기둥·공간·회의실·책상을 찾아 초안을 만든다. 그 쪽 그림은 층의 밑그림으로 올라가 편집 화면에서 깔린다.
// start: 초안이 없는 층들에 새 초안 / draft: 지금 초안에 밑그림을 깔고 (원하면) 찾은 요소를 더한다

const WORK_SIDE = 2400; // 찾기에 쓰는 그림 크기 (긴 쪽 px)
const PREVIEW_SIDE = 1400;
const THUMB_SIDE = 160;

export type Background = NonNullable<PlanEditorData["background"]>;

type Props = {
  mode: "start" | "draft";
  data: PlanEditorData;
  onClose: () => void;
  onExpired: () => void;
  /** start: 초안을 만든 층들 */
  onCreated?: (floors: { id: number; name: string }[]) => void;
  /** draft: 올린 밑그림과 더할 요소 (도면보다 크면 도면을 넓힌다) */
  onApply?: (r: { elements: PlanElement[]; widthM: number; heightM: number; background: Background }) => void;
};

type PageSet = {
  crop: Box; // 쪽 단위
  sizeBy: "width" | "scale";
  widthM: string;
  scaleN: string;
  options: DetectOptions;
  desk: { w: string; h: string };
};

type Work = { index: number; scale: number; gray: Gray; preview: string };
type Job = { state: "wait" | "working" | "done" | "error"; text?: string };
type Point = { x: number; y: number };

const r2 = (v: number) => Math.round(v * 100) / 100;

const ERROR_TEXT: Record<string, string> = {
  TYPE: "읽을 수 없는 파일이에요. PNG·JPG·WEBP 그림, PDF, 엑셀(.xlsx)을 올려 주세요",
  BIG: "파일이 너무 커요 (50MB까지)",
  PASSWORD: "암호가 걸린 PDF예요. 암호를 풀고 다시 올려 주세요",
  BROKEN: "파일이 깨졌거나 읽을 수 없어요",
  XLS: "엑셀 97-2003(.xls) 파일이에요. 엑셀에서 .xlsx로 다시 저장해 올려 주세요",
  EMPTY: "파일에 쪽(시트)이 없어요",
};

/** 고른 부분의 실제 크기 (m). 넣은 값이 틀렸으면 null */
function sizeOf(page: SourcePage, set: PageSet): { widthM: number; heightM: number } | null {
  const crop = set.crop;
  const widthM =
    set.sizeBy === "scale" && page.paperMm
      ? (((crop.w / page.width) * page.paperMm.w) / 1000) * Number(set.scaleN)
      : Number(set.widthM);
  if (!Number.isFinite(widthM) || widthM <= 0) return null;
  const heightM = (widthM * crop.h) / crop.w;
  if (widthM < 3 || heightM < 1 || widthM > MAX_SIZE || heightM > MAX_SIZE) return null;
  return { widthM: r2(widthM), heightM: r2(heightM) };
}

/** 이 쪽에서 요소 찾기 */
function detectPage(page: SourcePage, work: Work, set: PageSet, idPrefix: string): DetectResult | null {
  const size = sizeOf(page, set);
  if (!size) return null;
  const { crop } = set;
  const mPerUnit = size.widthM / crop.w;
  const toM = <T extends Box>(b: T): T => ({
    ...b,
    x: (b.x - crop.x) * mPerUnit,
    y: (b.y - crop.y) * mPerUnit,
    w: b.w * mPerUnit,
    h: b.h * mPerUnit,
  });
  const desk = { w: Number(set.desk.w) || 1.6, h: Number(set.desk.h) || 0.8 };
  const px = { x: crop.x * work.scale, y: crop.y * work.scale, w: crop.w * work.scale, h: crop.h * work.scale };
  return detectPlan({
    widthM: size.widthM,
    heightM: size.heightM,
    raster: page.vector ? undefined : { gray: cropGray(work.gray, px), mPerPx: size.widthM / Math.round(px.w) },
    vector: page.vector
      ? {
          edges: page.vector.edges.map((e) => ({
            ...e,
            x1: (e.x1 - crop.x) * mPerUnit,
            y1: (e.y1 - crop.y) * mPerUnit,
            x2: (e.x2 - crop.x) * mPerUnit,
            y2: (e.y2 - crop.y) * mPerUnit,
          })),
          fills: page.vector.fills.map(toM),
        }
      : undefined,
    texts: page.texts.map(toM),
    options: set.options,
    desk,
    idPrefix,
  });
}

function canvasPreview(canvas: HTMLCanvasElement, side: number) {
  const k = Math.min(1, side / Math.max(canvas.width, canvas.height));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(canvas.width * k));
  c.height = Math.max(1, Math.round(canvas.height * k));
  c.getContext("2d")!.drawImage(canvas, 0, 0, c.width, c.height);
  const url = c.toDataURL("image/jpeg", 0.85);
  freeCanvas(c);
  return url;
}

export default function ImportWizard({ mode, data, onClose, onExpired, onCreated, onApply }: Props) {
  const [file, setFile] = useState<SourceFile | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [thumbs, setThumbs] = useState<Record<number, string>>({});
  const [targets, setTargets] = useState<Record<number, number | "">>({});
  const [active, setActive] = useState(0);
  const [sets, setSets] = useState<Record<number, PageSet>>({});
  const [work, setWork] = useState<Work | null>(null);
  const [result, setResult] = useState<DetectResult | null>(null);
  const [jobs, setJobs] = useState<Record<number, Job> | null>(null);
  const [busy, setBusy] = useState(false);
  const [showFound, setShowFound] = useState(true);
  const [addFound, setAddFound] = useState(() => mode === "start" || (data.draft?.geometry.elements.length ?? 0) <= 1);
  const [measure, setMeasure] = useState<{ points: Point[]; length: string } | null>(null);
  const [drag, setDrag] = useState<{ start: Point; now: Point } | null>(null);
  const cache = useRef(new Map<number, Work>());
  const lastSet = useRef<PageSet | null>(null);
  const fileRef = useRef<SourceFile | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  const pages = file?.pages ?? [];
  const page = pages[active] as SourcePage | undefined;
  const set = page ? sets[page.index] : undefined;
  const siteFloors = useMemo(() => {
    const same = data.floors.filter((f) => f.site_id === data.floor.site.id);
    return same.length ? same : data.floors;
  }, [data.floors, data.floor.site.id]);

  useEffect(() => () => fileRef.current?.close(), []);

  /** 찾기용 그림 (쪽 전체를 긴 쪽 2400px로). 최근 세 쪽만 들고 있는다 */
  const ensureWork = useCallback(async (p: SourcePage): Promise<Work> => {
    const hit = cache.current.get(p.index);
    if (hit) return hit;
    const scale = fitScale(p, WORK_SIDE);
    const canvas = await p.render(scale);
    const w: Work = { index: p.index, scale, gray: grayOf(canvas), preview: canvasPreview(canvas, PREVIEW_SIDE) };
    freeCanvas(canvas); // 밝기 배열·미리보기만 들고 있는다
    cache.current.set(p.index, w);
    if (cache.current.size > 3) cache.current.delete(cache.current.keys().next().value!);
    return w;
  }, []);

  const defaultSet = useCallback(
    (p: SourcePage, w: Work): PageSet => {
      const prev = lastSet.current;
      const box = p.vector ? { x: 0, y: 0, w: p.width, h: p.height } : contentBox(w.gray);
      const crop = p.vector ? box : { x: box.x / w.scale, y: box.y / w.scale, w: box.w / w.scale, h: box.h / w.scale };
      const thick = p.vector?.edges.some((e) => e.weight >= 2);
      return {
        crop,
        sizeBy: p.paperMm && (p.scaleHint || prev?.sizeBy === "scale") ? "scale" : "width",
        widthM: prev?.widthM ?? String(data.size.width_m),
        scaleN: String(p.scaleHint ?? prev?.scaleN ?? 100),
        // 엑셀은 도곽이 없고 바깥 벽이 시트 가장자리에 붙어 있기 쉬워 테두리 빼기를 끈다
        options: prev
          ? { ...prev.options }
          : { ...DETECT_DEFAULTS, lines: p.vector && thick ? 2 : 1, frame: !p.vector },
        desk: prev ? { ...prev.desk } : { w: "1.6", h: "0.8" },
      };
    },
    [data.size.width_m],
  );

  // 고른 쪽의 그림을 준비한다 (처음 보는 쪽이면 도면 부분을 저절로 맞춘다)
  useEffect(() => {
    if (!page) return;
    let gone = false;
    ensureWork(page).then(
      (w) => {
        if (gone) return;
        setWork(w);
        setSets((s) => (s[page.index] ? s : { ...s, [page.index]: defaultSet(page, w) }));
      },
      () => {
        if (!gone) setError(`${page.label}을 그리지 못했어요. 쪽이 많으면 나눠서 올려 보세요`);
      },
    );
    return () => {
      gone = true;
    };
  }, [page, ensureWork, defaultSet]);

  // 설정이 바뀌면 조금 기다렸다가 다시 찾는다
  useEffect(() => {
    if (!page || !set || !work || work.index !== page.index) return;
    const timer = setTimeout(() => {
      lastSet.current = set;
      setResult(detectPage(page, work, set, "imp-"));
    }, 200);
    return () => clearTimeout(timer);
  }, [page, set, work]);

  // 쪽 그림 작게 (목록)
  useEffect(() => {
    if (!file) return;
    let gone = false;
    void (async () => {
      for (const p of file.pages) {
        if (gone) return;
        try {
          const c = await p.render(fitScale(p, THUMB_SIDE));
          const url = c.toDataURL("image/jpeg", 0.8);
          freeCanvas(c);
          if (!gone) setThumbs((t) => ({ ...t, [p.index]: url }));
        } catch {
          // 작은 그림이 없어도 고를 수 있다
        }
      }
    })();
    return () => {
      gone = true;
    };
  }, [file]);

  function autoTargets(f: SourceFile): Record<number, number | ""> {
    const out: Record<number, number | ""> = {};
    const free = (id: number) => id === data.floor.id || !data.floors.find((x) => x.id === id)?.drafting;
    for (const p of f.pages) {
      const floor = p.floorHint
        ? siteFloors.find((x) => (floorName(x.name) ?? x.name.toUpperCase()) === p.floorHint && free(x.id))
        : undefined;
      out[p.index] = floor?.id ?? "";
    }
    // 한 쪽짜리이거나 층 이름을 하나도 못 찾았으면 첫 쪽을 지금 층에 (찾은 층이 이미 초안 중이면 비워 둔다)
    if (f.pages.length === 1 || !f.pages.some((p) => p.floorHint)) out[0] = data.floor.id;
    return out;
  }

  async function pick(f: File | undefined) {
    if (!f) return;
    setError(null);
    setLoading("파일을 읽는 중…");
    try {
      const src = await openPlanFile(f, (done, total) => setLoading(`쪽을 읽는 중… ${done}/${total}`));
      fileRef.current?.close();
      fileRef.current = src;
      cache.current.clear();
      lastSet.current = null;
      setThumbs({});
      setSets({});
      setResult(null);
      setWork(null);
      setJobs(null);
      setFile(src);
      const auto = autoTargets(src);
      setTargets(auto);
      // 지금 층에 맞춘 쪽부터 보여 준다
      const first = src.pages.find((p) => auto[p.index] === data.floor.id) ?? src.pages[0];
      setActive(first.index);
    } catch (e) {
      setError(e instanceof PlanFileError ? ERROR_TEXT[e.code] : "파일을 읽지 못했어요");
    } finally {
      setLoading(null);
    }
  }

  /** 다른 쪽 보기 (찍던 두 점은 그 쪽 것이라 버린다) */
  const choosePage = (index: number) => {
    setActive(index);
    setMeasure(null);
    setDrag(null);
  };

  const updateSet = (patch: Partial<PageSet>) => {
    if (!page || !set) return;
    setSets((s) => ({ ...s, [page.index]: { ...set, ...patch } }));
  };
  const updateOptions = (patch: Partial<DetectOptions>) => set && updateSet({ options: { ...set.options, ...patch } });

  // 미리보기 위에서 끌어 도면 부분 고르기 / 두 점 찍어 길이 맞추기 (쪽 단위)
  const toPage = (e: PointerEvent): Point => {
    const r = stageRef.current!.getBoundingClientRect();
    return {
      x: Math.min(page!.width, Math.max(0, ((e.clientX - r.left) / r.width) * page!.width)),
      y: Math.min(page!.height, Math.max(0, ((e.clientY - r.top) / r.height) * page!.height)),
    };
  };
  function onDown(e: PointerEvent) {
    if (!page || !set || busy) return;
    const p = toPage(e);
    if (measure) {
      if (measure.points.length < 2) setMeasure({ ...measure, points: [...measure.points, p] });
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ start: p, now: p });
  }
  function onMove(e: PointerEvent) {
    if (drag) setDrag({ ...drag, now: toPage(e) });
  }
  function onUp() {
    if (!drag || !page) return;
    const box = {
      x: Math.min(drag.start.x, drag.now.x),
      y: Math.min(drag.start.y, drag.now.y),
      w: Math.abs(drag.now.x - drag.start.x),
      h: Math.abs(drag.now.y - drag.start.y),
    };
    setDrag(null);
    if (box.w > page.width * 0.03 && box.h > page.height * 0.03) setCrop(box);
  }
  /** 도면 부분 바꾸기. 크기를 가로 길이로 정했으면 같은 축척이 되게 가로 길이도 다시 센다 */
  function setCrop(box: Box) {
    if (!page || !set) return;
    const size = sizeOf(page, set);
    const keep = set.sizeBy !== "scale" && size ? { widthM: String(r2((size.widthM * box.w) / set.crop.w)) } : {};
    updateSet({ crop: box, ...keep });
  }
  function applyMeasure() {
    if (!measure || measure.points.length < 2 || !set) return;
    const [a, b] = measure.points;
    const len = Number(measure.length);
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    if (!(len > 0) || dist <= 0) return;
    updateSet({ sizeBy: "width", widthM: String(r2((set.crop.w * len) / dist)) });
    setMeasure(null);
  }

  // 만들기 ----------------------------------------------------------------------------------------

  const chosen = pages.filter((p) => targets[p.index]);
  const doubled = chosen.some((p, i) => chosen.findIndex((q) => targets[q.index] === targets[p.index]) !== i);
  const unseen = chosen.filter((p) => !sets[p.index]).length;

  async function prepare(p: SourcePage, prefix: string) {
    const w = await ensureWork(p);
    const s = sets[p.index] ?? defaultSet(p, w);
    const size = sizeOf(p, s);
    if (!size) throw new Error("크기를 확인하세요");
    const found = detectPage(p, w, s, prefix);
    // 밑그림: 고른 부분만, 긴 쪽 4096px 안 (그림 파일은 원래 크기보다 키우지 않는다)
    let scale = MAX_RENDER_SIDE / Math.max(s.crop.w, s.crop.h);
    if (file?.kind === "image") scale = Math.min(1, scale);
    if (file?.kind === "excel") scale = Math.min(3, scale);
    const canvas = await p.render(scale, s.crop);
    const blob = await canvasFile(canvas).finally(() => freeCanvas(canvas));
    // 이 쪽에서 정한 책상 크기를 초안의 "새 책상 기본 크기"로도 쓴다 (나중에 놓는 책상도 같은 크기)
    const desk = { w: Number(s.desk.w) || 1.6, h: Number(s.desk.h) || 0.8 };
    return { size, found, blob, desk };
  }

  async function upload(floorId: number, blob: Blob, size: { widthM: number; heightM: number }, name: string) {
    const q = new URLSearchParams({ w_m: String(size.widthM), h_m: String(size.heightM), name });
    const res = await fetch(`/api/admin/floors/${floorId}/plan/background?${q}`, {
      method: "PUT",
      headers: { "content-type": blob.type },
      body: blob,
    });
    if (res.status === 401) {
      onExpired();
      throw new Error("expired");
    }
    if (!res.ok) throw new Error("밑그림을 올리지 못했어요");
    return ((await res.json()) as { background: Background }).background;
  }

  async function createAll() {
    if (!file || chosen.length === 0 || doubled) return;
    setBusy(true);
    setJobs(Object.fromEntries(chosen.map((p) => [p.index, { state: "wait" } as Job])));
    const done: { id: number; name: string }[] = [];
    for (const p of chosen) {
      const floorId = targets[p.index] as number;
      const floor = data.floors.find((f) => f.id === floorId);
      setJobs((j) => ({ ...j, [p.index]: { state: "working" } }));
      try {
        const { size, found, blob, desk } = await prepare(p, "imp-");
        const res = await fetch(`/api/admin/floors/${floorId}/plan/draft`, {
          method: "POST",
          headers: json,
          body: JSON.stringify({
            source: "import",
            width_m: Math.max(MIN_SIZE, size.widthM),
            height_m: Math.max(MIN_SIZE, size.heightM),
            geometry: { schema: 1, grid_m: 0.1, desk, elements: found?.elements ?? [] },
          }),
        });
        if (res.status === 401) return onExpired();
        if (!res.ok) {
          const out = await res.json().catch(() => null);
          throw new Error(out?.detail?.code === "HAS_DRAFT" ? "그새 초안이 생겼어요" : "초안을 만들지 못했어요");
        }
        // 그림 파일은 쪽 이름이 파일 이름 그대로라 두 번 붙이지 않는다 (PDF는 "본사도면.pdf 3쪽")
        const name = p.label && p.label !== file.name ? `${file.name} ${p.label}` : file.name;
        await upload(floorId, blob, size, name.slice(0, 200));
        done.push({ id: floorId, name: floor?.name ?? "" });
        setJobs((j) => ({ ...j, [p.index]: { state: "done" } }));
      } catch (e) {
        if ((e as Error).message === "expired") return;
        setJobs((j) => ({ ...j, [p.index]: { state: "error", text: (e as Error).message } }));
      }
    }
    setBusy(false);
    if (done.length) onCreated?.(done);
  }

  async function applyToDraft() {
    if (!page) return;
    setBusy(true);
    setError(null);
    try {
      const { size, found, blob } = await prepare(page, `${newId("imp")}-`);
      const name = page.label === file!.name ? file!.name : `${file!.name} ${page.label}`;
      const background = await upload(data.floor.id, blob, size, name.slice(0, 200));
      onApply?.({ elements: addFound ? (found?.elements ?? []) : [], ...size, background });
    } catch (e) {
      if ((e as Error).message !== "expired") setError((e as Error).message || "밑그림을 깔지 못했어요");
    } finally {
      setBusy(false);
    }
  }

  // 화면 -------------------------------------------------------------------------------------------

  const size = page && set ? sizeOf(page, set) : null;
  const floorChoice = (p: SourcePage) => (
    <select
      className={ui.select}
      aria-label={`${p.label}을 쓸 층`}
      value={targets[p.index] ?? ""}
      disabled={busy}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setTargets({ ...targets, [p.index]: e.target.value ? Number(e.target.value) : "" })}
    >
      <option value="">쓰지 않음</option>
      {data.floors.map((f) => (
        <option key={f.id} value={f.id} disabled={f.drafting && f.id !== data.floor.id}>
          {f.site} {f.name}
          {f.id === data.floor.id ? " (지금 층)" : f.drafting ? " (초안 있음)" : ""}
        </option>
      ))}
    </select>
  );

  const footer = (
    <>
      {file && (
        <button
          type="button"
          className={ui.btn}
          style={{ marginRight: "auto" }}
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          다른 파일
        </button>
      )}
      <button type="button" className={ui.btn} onClick={onClose} disabled={busy && mode === "draft"}>
        {jobs && !busy ? "닫기" : "그만두기"}
      </button>
      {mode === "start" ? (
        <button
          type="button"
          className={`${ui.btn} ${ui.pri}`}
          disabled={!file || busy || chosen.length === 0 || doubled || (jobs !== null && !busy)}
          onClick={() => void createAll()}
        >
          {busy ? "만드는 중…" : `${chosen.length}개 층 초안 만들기`}
        </button>
      ) : (
        <button
          type="button"
          className={`${ui.btn} ${ui.pri}`}
          disabled={!file || !size || busy}
          onClick={() => void applyToDraft()}
        >
          {busy ? "까는 중…" : addFound ? "밑그림 깔고 요소 더하기" : "밑그림 깔기"}
        </button>
      )}
    </>
  );

  return (
    <Dialog
      open
      size="full"
      onClose={() => !busy && onClose()}
      title={mode === "start" ? "도면 파일로 초안 만들기" : "도면 파일 깔기"}
      footer={footer}
    >
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        hidden
        data-testid="plan-file"
        onChange={(e) => {
          void pick(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      {!file ? (
        <div className={ui.dialogBody}>
          <div
            className={styles.dropZone}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              void pick(e.dataTransfer.files[0]);
            }}
          >
            <p>
              <strong>도면 파일을 끌어 놓거나 고르세요</strong>
            </p>
            <p className={ui.hint}>
              그림(PNG·JPG·WEBP) · PDF(쪽마다 층 하나, 여러 층도 한 번에) · 엑셀 .xlsx(시트마다 층 하나) · 50MB까지
            </p>
            <button
              type="button"
              className={`${ui.btn} ${ui.pri}`}
              disabled={loading !== null}
              onClick={() => inputRef.current?.click()}
            >
              {loading ?? "파일 고르기…"}
            </button>
            {error && (
              <p className={ui.conflictText} role="alert">
                {error}
              </p>
            )}
          </div>
          <ul className={styles.importTips}>
            <li>파일은 이 브라우저 안에서만 읽어요. 서버에는 고른 부분의 그림(밑그림)과 찾은 요소만 올라가요.</li>
            <li>
              곧은 가로·세로 선을 벽으로, 꽉 찬 작은 네모를 기둥으로 찾아요. 글자가 있는 PDF·엑셀은 &ldquo;회의실&rdquo;
              &ldquo;탕비실&rdquo; 같은 이름으로 방을 찾고, 좌석 번호(A-01)나 엑셀 칸 글자로 책상을 놓아요.
            </li>
            <li>
              찾은 것은 초안일 뿐이에요. 밑그림이 깔린 편집 화면에서 고치고, 기운 선은 &ldquo;선 정리&rdquo;로 펴세요.
            </li>
          </ul>
        </div>
      ) : (
        <div className={styles.importLayout}>
          <aside className={styles.importPages} aria-label="쪽 목록">
            <p className={ui.hint}>
              {file.name} · {file.kind === "excel" ? "시트" : "쪽"} {pages.length}개
              {file.truncated && " (앞 60쪽만 읽었어요)"}
            </p>
            {mode === "start" && pages.length > 1 && (
              <div className={ui.rowButtons}>
                <button
                  type="button"
                  className={ui.btn}
                  disabled={busy}
                  onClick={() => {
                    // 낮은 층부터 쪽 순서대로 (지하 → 1층 → 위층)
                    const bottomUp = [...siteFloors].reverse();
                    setTargets(
                      Object.fromEntries(
                        pages.map((p, i) => {
                          const f = bottomUp[i];
                          return [p.index, f && (!f.drafting || f.id === data.floor.id) ? f.id : ""];
                        }),
                      ),
                    );
                  }}
                >
                  순서대로 층 맞추기
                </button>
                <button
                  type="button"
                  className={ui.btn}
                  disabled={busy}
                  onClick={() => setTargets({ [active]: data.floor.id })}
                >
                  이 쪽만 지금 층에
                </button>
              </div>
            )}
            <ul className={styles.pageList}>
              {pages.map((p) => {
                const job = jobs?.[p.index];
                const s = sets[p.index];
                const sz = s ? sizeOf(p, s) : null;
                return (
                  <li key={p.index}>
                    <div
                      role="button"
                      tabIndex={0}
                      className={styles.pageItem}
                      aria-current={p.index === active || undefined}
                      onClick={() => choosePage(p.index)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          choosePage(p.index);
                        }
                      }}
                    >
                      {thumbs[p.index] ? (
                        // eslint-disable-next-line @next/next/no-img-element -- 브라우저에서 그린 작은 그림
                        <img src={thumbs[p.index]} alt="" className={styles.thumb} />
                      ) : (
                        <span className={styles.thumb} />
                      )}
                      <span className={styles.pageText}>
                        <strong>{p.label}</strong>
                        {p.floorHint && <span className={ui.muted}>{p.floorHint}로 보여요</span>}
                        {mode === "start" && targets[p.index] ? (
                          <span className={ui.muted}>
                            {s ? (sz ? `${sz.widthM} × ${sz.heightM} m` : "크기를 확인하세요") : "앞 쪽 설정으로"}
                          </span>
                        ) : null}
                        {job && (
                          <span className={styles.jobState} data-state={job.state}>
                            {job.state === "wait"
                              ? "기다리는 중"
                              : job.state === "working"
                                ? "만드는 중…"
                                : job.state === "done"
                                  ? "초안을 만들었어요"
                                  : job.text}
                          </span>
                        )}
                      </span>
                    </div>
                    {mode === "start" && floorChoice(p)}
                  </li>
                );
              })}
            </ul>
            {mode === "start" && doubled && (
              <p className={ui.conflictText} role="alert">
                같은 층을 두 쪽에 골랐어요
              </p>
            )}
            {mode === "start" && unseen > 0 && !jobs && (
              <p className={ui.hint}>
                안 열어 본 쪽 {unseen}개는 마지막에 본 쪽의 크기·설정으로 만들어요. 눌러서 확인할 수 있어요.
              </p>
            )}
          </aside>

          <section className={styles.importMain} aria-label="고른 쪽">
            {page && set && work?.index === page.index ? (
              <>
                <div className={styles.importBar}>
                  <strong>{page.label}</strong>
                  <span className={ui.muted}>
                    {measure
                      ? measure.points.length < 2
                        ? `길이를 아는 두 점을 누르세요 (${measure.points.length}/2)`
                        : "두 점 사이 실제 길이를 넣으세요"
                      : "끌어서 도면 부분을 고르세요"}
                  </span>
                  <label className={ui.check}>
                    <input type="checkbox" checked={showFound} onChange={(e) => setShowFound(e.target.checked)} />
                    찾은 것 보기
                  </label>
                </div>
                <div
                  ref={stageRef}
                  className={styles.importStage}
                  data-measure={measure ? true : undefined}
                  onPointerDown={onDown}
                  onPointerMove={onMove}
                  onPointerUp={onUp}
                  onPointerCancel={() => setDrag(null)}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- 브라우저에서 그린 쪽 그림 */}
                  <img src={work.preview} alt={`${page.label} 미리보기`} draggable={false} />
                  <CropFrame page={page} crop={set.crop} />
                  {showFound && result && size && (
                    <FoundOverlay
                      page={page}
                      crop={set.crop}
                      widthM={size.widthM}
                      heightM={size.heightM}
                      result={result}
                    />
                  )}
                  {drag && (
                    <span
                      className={styles.importDrag}
                      style={{
                        left: `${(Math.min(drag.start.x, drag.now.x) / page.width) * 100}%`,
                        top: `${(Math.min(drag.start.y, drag.now.y) / page.height) * 100}%`,
                        width: `${(Math.abs(drag.now.x - drag.start.x) / page.width) * 100}%`,
                        height: `${(Math.abs(drag.now.y - drag.start.y) / page.height) * 100}%`,
                      }}
                    />
                  )}
                  {measure?.points.map((p, i) => (
                    <span
                      key={i}
                      className={styles.measureDot}
                      style={{ left: `${(p.x / page.width) * 100}%`, top: `${(p.y / page.height) * 100}%` }}
                    />
                  ))}
                </div>
                {result && (
                  <p className={styles.foundCounts} role="status">
                    찾은 것: 벽 {result.walls} · 기둥 {result.pillars} · 공간 {result.spaces} · 회의실 {result.rooms} ·
                    책상 {result.desks}
                    {result.guessed > 0 && ` · 방 크기를 못 찾은 이름 ${result.guessed}개는 글자 둘레에 놓았어요`}
                    {result.capped && " · 선이 너무 많아 긴 선만 남겼어요"}
                  </p>
                )}
              </>
            ) : (
              <p className={ui.hint}>쪽 그림을 그리는 중…</p>
            )}
          </section>

          <aside className={styles.importSettings} aria-label="설정">
            {page && set && (
              <>
                <fieldset className={ui.when}>
                  <legend>도면 부분</legend>
                  <div className={ui.rowButtons}>
                    <button
                      type="button"
                      className={ui.btn}
                      onClick={() => work && setCrop(defaultSet(page, work).crop)}
                    >
                      저절로 맞추기
                    </button>
                    <button
                      type="button"
                      className={ui.btn}
                      onClick={() => setCrop({ x: 0, y: 0, w: page.width, h: page.height })}
                    >
                      쪽 전체
                    </button>
                  </div>
                </fieldset>
                <fieldset className={ui.when}>
                  <legend>고른 부분의 실제 크기</legend>
                  {page.paperMm && (
                    <label>
                      <input
                        type="radio"
                        checked={set.sizeBy === "scale"}
                        onChange={() => updateSet({ sizeBy: "scale" })}
                      />{" "}
                      축척으로 1 :
                      <input
                        className={styles.smallNumber}
                        type="number"
                        inputMode="numeric"
                        min={10}
                        max={5000}
                        value={set.scaleN}
                        aria-label="축척"
                        onFocus={() => updateSet({ sizeBy: "scale" })}
                        onChange={(e) => updateSet({ scaleN: e.target.value, sizeBy: "scale" })}
                      />
                      {page.scaleHint && <span className={ui.muted}> (도면에 1:{page.scaleHint})</span>}
                    </label>
                  )}
                  <label>
                    <input
                      type="radio"
                      checked={set.sizeBy !== "scale"}
                      onChange={() => updateSet({ sizeBy: "width", widthM: String(size?.widthM ?? set.widthM) })}
                    />{" "}
                    가로 길이
                    <input
                      className={styles.smallNumber}
                      type="number"
                      inputMode="decimal"
                      min={3}
                      max={MAX_SIZE}
                      step={0.5}
                      value={set.sizeBy === "scale" ? String(size?.widthM ?? "") : set.widthM}
                      aria-label="가로 길이 (m)"
                      onFocus={() =>
                        set.sizeBy === "scale" && size && updateSet({ sizeBy: "width", widthM: String(size.widthM) })
                      }
                      onChange={(e) => updateSet({ widthM: e.target.value, sizeBy: "width" })}
                    />
                    m
                  </label>
                  {measure ? (
                    measure.points.length === 2 && (
                      <div className={ui.rowButtons}>
                        <input
                          className={styles.smallNumber}
                          type="number"
                          inputMode="decimal"
                          min={0.1}
                          step={0.1}
                          value={measure.length}
                          aria-label="두 점 사이 실제 길이 (m)"
                          autoFocus
                          onChange={(e) => setMeasure({ ...measure, length: e.target.value })}
                          onKeyDown={(e) => e.key === "Enter" && applyMeasure()}
                        />
                        m
                        <button type="button" className={`${ui.btn} ${ui.pri}`} onClick={applyMeasure}>
                          맞추기
                        </button>
                        <button type="button" className={ui.btn} onClick={() => setMeasure(null)}>
                          그만
                        </button>
                      </div>
                    )
                  ) : (
                    <button type="button" className={ui.btn} onClick={() => setMeasure({ points: [], length: "" })}>
                      아는 길이로 맞추기 (두 점 찍기)
                    </button>
                  )}
                  {size ? (
                    <p className={ui.hint}>
                      {size.widthM} × {size.heightM} m
                      {(size.widthM < MIN_SIZE || size.heightM < MIN_SIZE) &&
                        ` · 도면은 ${MIN_SIZE} m보다 작게 만들 수 없어 남는 곳은 비워 둬요`}
                    </p>
                  ) : (
                    <p className={ui.conflictText}>3~{MAX_SIZE} m 사이가 되게 넣으세요</p>
                  )}
                </fieldset>
                <fieldset className={ui.when}>
                  <legend>찾을 것</legend>
                  <label className={styles.inlineField}>
                    벽으로 볼 선
                    <select
                      className={ui.select}
                      value={set.options.lines}
                      onChange={(e) => updateOptions({ lines: Number(e.target.value) as 1 | 2 | 3 })}
                    >
                      <option value={1}>{page.vector ? "모든 테두리" : "모든 선"}</option>
                      <option value={2}>{page.vector ? "중간·굵은 테두리만" : "굵은 선만 (가는 선 무시)"}</option>
                      <option value={3}>{page.vector ? "굵은 테두리만" : "아주 굵은 선만"}</option>
                    </select>
                  </label>
                  <label className={styles.inlineField}>
                    이보다 짧은 선은 빼기
                    <select
                      className={ui.select}
                      value={set.options.minLenM}
                      onChange={(e) => updateOptions({ minLenM: Number(e.target.value) })}
                    >
                      {[0.3, 0.5, 1, 1.5, 2, 3].map((v) => (
                        <option key={v} value={v}>
                          {v} m
                        </option>
                      ))}
                    </select>
                  </label>
                  {!page.vector && (
                    <label className={styles.inlineField}>
                      선 진하기
                      <input
                        type="range"
                        min={0}
                        max={230}
                        step={10}
                        value={set.options.dark}
                        aria-valuetext={set.options.dark ? String(set.options.dark) : "저절로"}
                        onChange={(e) => updateOptions({ dark: Number(e.target.value) })}
                      />
                      <span className={ui.muted}>{set.options.dark ? set.options.dark : "저절로"}</span>
                    </label>
                  )}
                  {(
                    [
                      ["mergeDouble", "두 줄로 그린 벽을 하나로"],
                      ["pillars", "기둥 (꽉 찬 작은 네모)"],
                      ["spaces", "이름이 쓰인 방 → 공간·회의실"],
                      ["desks", page.vector ? "칸 글자 → 책상" : "좌석 번호(A-01) → 책상"],
                      ["frame", "쪽 둘레 테두리(도곽) 빼기"],
                    ] as const
                  ).map(([key, label]) => (
                    <label key={key}>
                      <input
                        type="checkbox"
                        checked={set.options[key]}
                        onChange={(e) => updateOptions({ [key]: e.target.checked })}
                      />{" "}
                      {label}
                    </label>
                  ))}
                  {set.options.desks && !page.vector && (
                    <label className={styles.inlineField}>
                      책상 크기
                      <input
                        className={styles.smallNumber}
                        type="number"
                        inputMode="decimal"
                        min={0.3}
                        max={6}
                        step={0.1}
                        value={set.desk.w}
                        aria-label="책상 가로 (m)"
                        onChange={(e) => updateSet({ desk: { ...set.desk, w: e.target.value } })}
                      />
                      ×
                      <input
                        className={styles.smallNumber}
                        type="number"
                        inputMode="decimal"
                        min={0.3}
                        max={6}
                        step={0.1}
                        value={set.desk.h}
                        aria-label="책상 세로 (m)"
                        onChange={(e) => updateSet({ desk: { ...set.desk, h: e.target.value } })}
                      />
                      m
                    </label>
                  )}
                  {!page.vector && page.texts.length === 0 && (
                    <p className={ui.hint}>이 쪽에는 글자 정보가 없어 방 이름·좌석 번호는 찾지 못해요.</p>
                  )}
                </fieldset>
                {mode === "draft" && (
                  <fieldset className={ui.when}>
                    <legend>지금 초안에</legend>
                    <label>
                      <input type="checkbox" checked={addFound} onChange={(e) => setAddFound(e.target.checked)} /> 찾은
                      요소도 더하기
                    </label>
                    <p className={ui.hint}>
                      밑그림은 도면 왼쪽 위(0, 0)에 실제 크기로 깔려요
                      {size && (size.widthM > data.size.width_m || size.heightM > data.size.height_m)
                        ? `. 도면(${data.size.width_m} × ${data.size.height_m} m)보다 커서 도면을 넓혀요`
                        : ""}
                      .
                    </p>
                  </fieldset>
                )}
                {error && (
                  <p className={ui.conflictText} role="alert">
                    {error}
                  </p>
                )}
              </>
            )}
          </aside>
        </div>
      )}
    </Dialog>
  );
}

/** 고른 부분 밖을 어둡게 */
function CropFrame({ page, crop }: { page: SourcePage; crop: Box }) {
  return (
    <span
      className={styles.importCrop}
      style={{
        left: `${(crop.x / page.width) * 100}%`,
        top: `${(crop.y / page.height) * 100}%`,
        width: `${(crop.w / page.width) * 100}%`,
        height: `${(crop.h / page.height) * 100}%`,
      }}
    />
  );
}

/** 찾은 요소를 쪽 그림 위에 겹쳐 그린다 (미터 좌표 그대로) */
function FoundOverlay({
  page,
  crop,
  widthM,
  heightM,
  result,
}: {
  page: SourcePage;
  crop: Box;
  widthM: number;
  heightM: number;
  result: DetectResult;
}) {
  const font = Math.max(0.3, widthM / 70);
  return (
    <svg
      className={styles.importFound}
      viewBox={`0 0 ${widthM} ${heightM}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      style={{
        left: `${(crop.x / page.width) * 100}%`,
        top: `${(crop.y / page.height) * 100}%`,
        width: `${(crop.w / page.width) * 100}%`,
        height: `${(crop.h / page.height) * 100}%`,
      }}
    >
      {result.elements.map((el) => {
        if (el.type === "wall_line")
          return (
            <line
              key={el.id}
              x1={el.x}
              y1={el.y}
              x2={el.x2}
              y2={el.y2}
              data-kind="wall"
              strokeWidth={el.line_w ?? 0.2}
              strokeLinecap="square"
            />
          );
        if (el.type === "pillar")
          return <rect key={el.id} data-kind="pillar" x={el.x} y={el.y} width={el.w} height={el.h} />;
        if (el.type === "room" || el.type === "space")
          return (
            <g key={el.id} data-kind={el.type}>
              <rect x={el.x} y={el.y} width={el.w} height={el.h} strokeWidth={font / 6} />
              <text
                x={el.x + el.w / 2}
                y={el.y + el.h / 2}
                fontSize={font}
                textAnchor="middle"
                dominantBaseline="middle"
              >
                {el.type === "room" ? el.name : el.label}
              </text>
            </g>
          );
        if (el.type === "desk_group") {
          const d = seatDims(el);
          return (
            <g key={el.id} data-kind="desk">
              {el.cells.map((c, i) => {
                const p = cellCenter(el, Math.floor(i / el.cols), i % el.cols);
                return (
                  <rect
                    key={c.id}
                    x={p.x - d.w / 2}
                    y={p.y - d.h / 2}
                    width={d.w}
                    height={d.h}
                    strokeWidth={font / 8}
                  />
                );
              })}
            </g>
          );
        }
        return null;
      })}
    </svg>
  );
}
