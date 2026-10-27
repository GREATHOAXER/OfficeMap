// 도면 파일 읽기 (도면 파일로 초안 만들기): 그림(PNG·JPG·WEBP), PDF(쪽마다), 엑셀 .xlsx(시트마다)를
// 쪽 목록으로 바꾼다. 쪽마다 크기·글자(자리 포함)·층 이름·축척을 알려 주고, 원하는 크기로 그림을 그린다.
// PDF는 pdf.js(호환 빌드), 엑셀은 ExcelJS를 쓰는데 무거워서 파일을 고를 때 불러온다. pdf.js 일꾼·글꼴 파일은
// public/pdfjs/ (npm run dev·build 전에 scripts/copy-pdfjs.mjs가 node_modules에서 복사)

import { type Box, type Edge, type Fill, findFloorHint, findScaleHint, type Gray, type TextBox } from "./planDetect";

export type SourcePage = {
  index: number;
  label: string; // "3쪽", "시트 1층", 그림이면 파일 이름
  /** 쪽 크기 (쪽 단위: PDF는 pt, 그림·엑셀은 px) */
  width: number;
  height: number;
  /** PDF 쪽의 종이 크기 (mm). 축척(1:N)을 알면 실제 크기를 셀 수 있다 */
  paperMm: { w: number; h: number } | null;
  floorHint: string | null; // 글자에서 찾은 층 이름 (예: 3F, B1)
  scaleHint: number | null; // 글자에서 찾은 축척 1:N의 N
  texts: TextBox[]; // 쪽 단위
  /** 엑셀 테두리·칠한 칸 (쪽 단위). 그림·PDF는 null */
  vector: { edges: Edge[]; fills: Fill[] } | null;
  /** 쪽 단위 × scale 픽셀 그림 (바탕은 흰색). crop(쪽 단위)을 주면 그 부분만 */
  render: (scale: number, crop?: Box) => Promise<HTMLCanvasElement>;
};

export type SourceFile = {
  name: string;
  kind: "image" | "pdf" | "excel";
  pages: SourcePage[];
  /** 쪽이 너무 많아 앞쪽만 읽었다 */
  truncated: boolean;
  close: () => void;
};

export type PlanFileErrorCode = "TYPE" | "BIG" | "PASSWORD" | "BROKEN" | "XLS" | "EMPTY";

export class PlanFileError extends Error {
  constructor(public code: PlanFileErrorCode) {
    super(code);
  }
}

export const ACCEPT =
  ".png,.jpg,.jpeg,.webp,.pdf,.xlsx,image/png,image/jpeg,image/webp,application/pdf," +
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_RENDER_SIDE = 4096; // 브라우저 그림판(canvas) 한계 안
const MAX_PAGES = 60;
const MAX_CELLS = 300; // 엑셀 시트에서 읽는 줄·칸 수
const PDFJS = "/pdfjs";

/** 다 쓴 그림판(canvas)을 바로 돌려준다. iPhone Safari는 한 화면이 쓸 수 있는 그림판 메모리 총량이 정해져 있어서
 *  쪽 여러 장을 읽다 보면 새 그림판을 못 만든다 (getContext가 null). 크기를 0으로 줄이면 그 자리에서 풀린다 */
export function freeCanvas(canvas: HTMLCanvasElement) {
  canvas.width = 0;
  canvas.height = 0;
}

function blank(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, c.width, c.height);
  return c;
}

/** 이 크기까지 그릴 수 있는 배율 */
export const fitScale = (page: Pick<SourcePage, "width" | "height">, side: number) =>
  Math.min(side, MAX_RENDER_SIDE) / Math.max(page.width, page.height);

const fileFloorHint = (name: string) =>
  findFloorHint(
    name
      .replace(/\.[a-z0-9]+$/i, "")
      .split(/[_\-.\s]+/)
      .map((text) => ({ text, h: 1 })),
  );

export async function openPlanFile(file: File, onProgress?: (done: number, total: number) => void) {
  if (file.size > MAX_FILE_BYTES) throw new PlanFileError("BIG");
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const starts = (...bytes: number[]) => bytes.every((b, i) => head[i] === b);
  if (starts(0x25, 0x50, 0x44, 0x46)) return openPdf(file, onProgress); // %PDF
  if (starts(0x50, 0x4b, 0x03, 0x04)) return openExcel(file); // zip (.xlsx)
  if (starts(0xd0, 0xcf, 0x11, 0xe0)) throw new PlanFileError("XLS"); // 엑셀 97-2003
  if (
    starts(0x89, 0x50, 0x4e, 0x47) ||
    starts(0xff, 0xd8, 0xff) ||
    (starts(0x52, 0x49, 0x46, 0x46) && String.fromCharCode(...head.slice(8, 12)) === "WEBP")
  )
    return openImage(file);
  throw new PlanFileError("TYPE");
}

// 그림 -------------------------------------------------------------------------------------------

async function openImage(file: File): Promise<SourceFile> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new PlanFileError("BROKEN");
  }
  const page: SourcePage = {
    index: 0,
    label: file.name,
    width: bitmap.width,
    height: bitmap.height,
    paperMm: null,
    floorHint: fileFloorHint(file.name),
    scaleHint: null,
    texts: [],
    vector: null,
    render: async (scale, crop = { x: 0, y: 0, w: bitmap.width, h: bitmap.height }) => {
      const c = blank(crop.w * scale, crop.h * scale);
      const ctx = c.getContext("2d")!;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(bitmap, crop.x, crop.y, crop.w, crop.h, 0, 0, c.width, c.height);
      return c;
    },
  };
  return { name: file.name, kind: "image", pages: [page], truncated: false, close: () => bitmap.close() };
}

// PDF --------------------------------------------------------------------------------------------

/** 같은 줄에 붙어 있는 글자 조각(한 글자씩 놓인 CAD 글자 등)을 한 덩어리로 */
export function joinTexts(items: TextBox[]): TextBox[] {
  const sorted = [...items].sort((a, b) => a.y + a.h - (b.y + b.h) || a.x - b.x);
  const out: TextBox[] = [];
  for (const t of sorted) {
    const prev = out.findLast(
      (o) =>
        Math.abs(o.y + o.h - (t.y + t.h)) < Math.min(o.h, t.h) * 0.3 &&
        Math.abs(o.h - t.h) < Math.max(o.h, t.h) * 0.4 &&
        t.x - (o.x + o.w) < Math.max(o.h, t.h) * 0.8 &&
        t.x - (o.x + o.w) > -Math.max(o.h, t.h) * 0.3,
    );
    if (!prev) {
      out.push({ ...t });
      continue;
    }
    const gap = t.x - (prev.x + prev.w);
    prev.text = `${prev.text}${gap > prev.h * 0.25 ? " " : ""}${t.text}`;
    const right = Math.max(prev.x + prev.w, t.x + t.w);
    const top = Math.min(prev.y, t.y);
    prev.h = Math.max(prev.y + prev.h, t.y + t.h) - top;
    prev.y = top;
    prev.w = right - prev.x;
  }
  return out;
}

async function openPdf(file: File, onProgress?: (done: number, total: number) => void): Promise<SourceFile> {
  // 호환 빌드: 사내 PC의 조금 오래된 브라우저에서도 돈다 (일꾼도 같은 빌드, scripts/copy-pdfjs.mjs).
  // 그래도 빠진 기능(iPhone Safari 17.3 이하 등)은 먼저 채운다. 일꾼은 같은 것을 붙인 worker.mjs로 띄운다
  await import("./pdfjsPolyfills.js");
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = `${PDFJS}/worker.mjs`;
  const task = pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    cMapUrl: `${PDFJS}/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${PDFJS}/standard_fonts/`,
    wasmUrl: `${PDFJS}/wasm/`,
  });
  let doc: Awaited<typeof task.promise>;
  try {
    doc = await task.promise;
  } catch (error) {
    void task.destroy();
    throw new PlanFileError((error as { name?: string })?.name === "PasswordException" ? "PASSWORD" : "BROKEN");
  }
  const total = Math.min(doc.numPages, MAX_PAGES);
  const pages: SourcePage[] = [];
  for (let n = 1; n <= total; n++) {
    const page = await doc.getPage(n);
    const viewport = page.getViewport({ scale: 1 });
    const items: TextBox[] = [];
    try {
      const content = await page.getTextContent();
      for (const item of content.items) {
        if (!("str" in item) || !item.str.trim()) continue;
        const m = pdfjs.Util.transform(viewport.transform, item.transform) as number[];
        const size = Math.hypot(m[2], m[3]);
        const vertical = Math.abs(m[1]) > Math.abs(m[0]);
        const len = item.width * viewport.scale;
        // 세로로 쓴 글자는 자리만 맞춘다 (방 이름 찾기에는 가운데만 쓴다)
        items.push(
          vertical
            ? { text: item.str, x: m[4] - size, y: m[5] - len, w: size, h: len }
            : { text: item.str, x: m[4], y: m[5] - size, w: len, h: size },
        );
      }
    } catch {
      // 글자를 못 읽어도 그림은 쓴다
    }
    const texts = joinTexts(items);
    const ptToMm = 25.4 / 72;
    pages.push({
      index: n - 1,
      label: `${n}쪽`,
      width: viewport.width,
      height: viewport.height,
      paperMm: { w: viewport.width * ptToMm * page.userUnit, h: viewport.height * ptToMm * page.userUnit },
      floorHint: findFloorHint(texts) ?? (doc.numPages === 1 ? fileFloorHint(file.name) : null),
      scaleHint: findScaleHint(texts),
      texts,
      vector: null,
      render: async (scale, crop = { x: 0, y: 0, w: viewport.width, h: viewport.height }) => {
        const vp = page.getViewport({ scale, offsetX: -crop.x * scale, offsetY: -crop.y * scale });
        // 흰 바탕에 바로 그린다 (그림판을 하나만 써서 iPhone 그림판 메모리를 아낀다)
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(crop.w * scale));
        c.height = Math.max(1, Math.round(crop.h * scale));
        await page.render({ canvas: c, viewport: vp, background: "#fff" }).promise;
        return c;
      },
    });
    onProgress?.(n, total);
  }
  if (pages.length === 0) {
    void task.destroy();
    throw new PlanFileError("EMPTY");
  }
  return {
    name: file.name,
    kind: "pdf",
    pages,
    truncated: doc.numPages > MAX_PAGES,
    close: () => void task.destroy(),
  };
}

// 엑셀 -------------------------------------------------------------------------------------------

type XBorder = { style?: string } | undefined;
type XColor = { argb?: string; theme?: number; tint?: number };
type XCell = {
  text?: string;
  border?: { top?: XBorder; bottom?: XBorder; left?: XBorder; right?: XBorder };
  fill?: { type?: string; pattern?: string; fgColor?: XColor };
  font?: { size?: number; bold?: boolean; color?: XColor };
};
type XRow = { hidden?: boolean; height?: number; cellCount: number; getCell: (c: number) => XCell };
type XSheet = {
  name: string;
  state?: string;
  rowCount: number;
  properties: { defaultRowHeight?: number; defaultColWidth?: number };
  getRow: (r: number) => XRow;
  getColumn: (c: number) => { hidden?: boolean; width?: number };
  _merges?: Record<string, { top: number; left: number; bottom: number; right: number }>;
};

const WEIGHT: Record<string, 1 | 2 | 3> = {
  hair: 1,
  thin: 1,
  dotted: 1,
  dashed: 1,
  dashDot: 1,
  dashDotDot: 1,
  medium: 2,
  mediumDashed: 2,
  mediumDashDot: 2,
  mediumDashDotDot: 2,
  slantDashDot: 2,
  thick: 3,
  double: 3,
};

// 엑셀 기본 테마 색 (배경 1, 텍스트 1, 배경 2, 텍스트 2, 강조 1~6). 테마 색으로 칠한 칸도 읽는다
const THEME = ["FFFFFF", "000000", "E7E6E6", "44546A", "4472C4", "ED7D31", "A5A5A5", "FFC000", "5B9BD5", "70AD47"];

/** 칸 색 → "#rrggbb"와 밝기 (0~255). 모르는 색이면 null */
function colorOf(c: XColor | undefined): { css: string; lum: number } | null {
  let hex = c?.argb && c.argb.length >= 6 ? c.argb.slice(-6) : c?.theme !== undefined ? THEME[c.theme] : undefined;
  if (!hex) return null;
  let [r, g, b] = [0, 2, 4].map((i) => parseInt(hex!.slice(i, i + 2), 16));
  if ([r, g, b].some(Number.isNaN)) return null;
  const tint = c?.tint ?? 0;
  if (tint) {
    // 밝게(+)·어둡게(-) 한 테마 색
    const t = (v: number) => Math.round(tint > 0 ? v + (255 - v) * tint : v * (1 + tint));
    [r, g, b] = [t(r), t(g), t(b)];
    hex = [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
  }
  return { css: `#${hex}`, lum: 0.299 * r + 0.587 * g + 0.114 * b };
}

async function openExcel(file: File): Promise<SourceFile> {
  const mod = (await import("exceljs")) as unknown as { default?: unknown; Workbook?: unknown };
  const ExcelJS = (mod.Workbook ? mod : mod.default) as {
    Workbook: new () => { xlsx: { load: (b: ArrayBuffer) => Promise<unknown> }; worksheets: XSheet[] };
  };
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(await file.arrayBuffer());
  } catch {
    throw new PlanFileError("BROKEN");
  }
  const pages: SourcePage[] = [];
  for (const ws of wb.worksheets) {
    if (ws.state && ws.state !== "visible") continue;
    const page = sheetPage(ws, pages.length);
    if (page) pages.push(page);
  }
  if (pages.length === 0) throw new PlanFileError("EMPTY");
  return { name: file.name, kind: "excel", pages, truncated: false, close: () => {} };
}

function sheetPage(ws: XSheet, index: number): SourcePage | null {
  const rows = Math.min(ws.rowCount, MAX_CELLS);
  let cols = 0;
  for (let r = 1; r <= rows; r++) cols = Math.max(cols, ws.getRow(r).cellCount);
  cols = Math.min(cols, MAX_CELLS);
  if (!rows || !cols) return null;

  // 칸 경계 (px, 100% 배율). 열 너비는 글자 수 단위, 행 높이는 pt
  const colX = [0];
  for (let c = 1; c <= cols; c++) {
    const col = ws.getColumn(c);
    colX.push(colX[c - 1] + (col.hidden ? 0 : (col.width ?? ws.properties.defaultColWidth ?? 9) * 7 + 5));
  }
  const rowY = [0];
  for (let r = 1; r <= rows; r++) {
    const row = ws.getRow(r);
    rowY.push(rowY[r - 1] + (row.hidden ? 0 : ((row.height ?? ws.properties.defaultRowHeight ?? 15) * 4) / 3));
  }
  const box = (top: number, left: number, bottom: number, right: number) => ({
    x: colX[left - 1],
    y: rowY[top - 1],
    w: colX[Math.min(right, cols)] - colX[left - 1],
    h: rowY[Math.min(bottom, rows)] - rowY[top - 1],
  });

  // 합친 칸: 칸마다 어느 합친 칸인지
  const mergeOf = new Map<string, { top: number; left: number; bottom: number; right: number }>();
  for (const m of Object.values(ws._merges ?? {})) {
    if (m.top > rows || m.left > cols) continue;
    for (let r = m.top; r <= Math.min(m.bottom, rows); r++)
      for (let c = m.left; c <= Math.min(m.right, cols); c++) mergeOf.set(`${r},${c}`, m);
  }
  const sameMerge = (r1: number, c1: number, r2: number, c2: number) => {
    const a = mergeOf.get(`${r1},${c1}`);
    return a !== undefined && a === mergeOf.get(`${r2},${c2}`);
  };

  const edges: Edge[] = [];
  const fills: Fill[] = [];
  const texts: (TextBox & { size: number; bold: boolean; color: string })[] = [];
  const fillDraw: (Fill & { color: string })[] = [];
  for (let r = 1; r <= rows; r++) {
    const row = ws.getRow(r);
    const n = Math.min(row.cellCount, cols);
    for (let c = 1; c <= n; c++) {
      const cell = row.getCell(c);
      const merge = mergeOf.get(`${r},${c}`);
      const master = !merge || (merge.top === r && merge.left === c);
      const b = cell.border;
      const add = (side: "top" | "bottom" | "left" | "right") => {
        const weight = WEIGHT[b?.[side]?.style ?? ""];
        if (!weight) return;
        // 합친 칸 안쪽 경계는 보이지 않는다
        if (side === "top" && sameMerge(r, c, r - 1, c)) return;
        if (side === "bottom" && sameMerge(r, c, r + 1, c)) return;
        if (side === "left" && sameMerge(r, c, r, c - 1)) return;
        if (side === "right" && sameMerge(r, c, r, c + 1)) return;
        const x0 = colX[c - 1];
        const x1 = colX[c];
        const y0 = rowY[r - 1];
        const y1 = rowY[r];
        if (side === "top" || side === "bottom") {
          const y = side === "top" ? y0 : y1;
          if (x1 > x0) edges.push({ x1: x0, y1: y, x2: x1, y2: y, t: 1, weight });
        } else {
          const x = side === "left" ? x0 : x1;
          if (y1 > y0) edges.push({ x1: x, y1: y0, x2: x, y2: y1, t: 1, weight });
        }
      };
      if (b) (["top", "bottom", "left", "right"] as const).forEach(add);
      if (!master) continue;
      const area = merge ? box(merge.top, merge.left, merge.bottom, merge.right) : box(r, c, r, c);
      if (area.w <= 0 || area.h <= 0) continue;
      const fill = cell.fill?.type === "pattern" && cell.fill.pattern === "solid" ? colorOf(cell.fill.fgColor) : null;
      if (fill && fill.lum < 250) {
        fills.push({ ...area, lum: fill.lum });
        fillDraw.push({ ...area, lum: fill.lum, color: fill.css });
      }
      const text = (cell.text ?? "").trim();
      if (text)
        texts.push({
          text,
          ...area,
          cell: true,
          size: ((cell.font?.size ?? 11) * 4) / 3,
          bold: Boolean(cell.font?.bold),
          color: colorOf(cell.font?.color)?.css ?? "#222",
        });
    }
  }
  const width = colX[cols];
  const height = rowY[rows];
  if (width <= 0 || height <= 0) return null;
  return {
    index,
    label: `시트 ${ws.name}`,
    width,
    height,
    paperMm: null,
    floorHint: findFloorHint([{ text: ws.name, h: 1000 }, ...texts]),
    scaleHint: null,
    texts: texts.map(({ text, x, y, w, h, cell }) => ({ text, x, y, w, h, cell })),
    vector: { edges, fills },
    render: async (scale, crop = { x: 0, y: 0, w: width, h: height }) => {
      const c = blank(crop.w * scale, crop.h * scale);
      const ctx = c.getContext("2d")!;
      ctx.scale(scale, scale);
      ctx.translate(-crop.x, -crop.y);
      for (const f of fillDraw) {
        ctx.fillStyle = f.color;
        ctx.fillRect(f.x, f.y, f.w, f.h);
      }
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (const t of texts) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(t.x, t.y, t.w, t.h);
        ctx.clip();
        ctx.fillStyle = t.color;
        ctx.font = `${t.bold ? "bold " : ""}${t.size}px sans-serif`;
        ctx.fillText(t.text, t.x + t.w / 2, t.y + t.h / 2, t.w);
        ctx.restore();
      }
      ctx.strokeStyle = "#111";
      ctx.lineCap = "square";
      for (const e of edges) {
        ctx.lineWidth = e.weight;
        ctx.beginPath();
        ctx.moveTo(e.x1, e.y1);
        ctx.lineTo(e.x2, e.y2);
        ctx.stroke();
      }
      return c;
    },
  };
}

// 그림 → 밝기 · 올릴 파일 -------------------------------------------------------------------------

/** 그림의 밝기 배열 */
export function grayOf(canvas: HTMLCanvasElement) {
  const { data } = canvas
    .getContext("2d", { willReadFrequently: true })!
    .getImageData(0, 0, canvas.width, canvas.height);
  const gray = new Uint8Array(canvas.width * canvas.height);
  for (let i = 0, j = 0; i < gray.length; i++, j += 4)
    gray[i] = (data[j] * 299 + data[j + 1] * 587 + data[j + 2] * 114) / 1000;
  return { width: canvas.width, height: canvas.height, data: gray };
}

/** 밝기 배열의 일부 (px) */
export function cropGray(g: Gray, r: Box): Gray {
  const x = Math.max(0, Math.round(r.x));
  const y = Math.max(0, Math.round(r.y));
  const w = Math.max(1, Math.min(g.width - x, Math.round(r.w)));
  const h = Math.max(1, Math.min(g.height - y, Math.round(r.h)));
  const data = new Uint8Array(w * h);
  for (let row = 0; row < h; row++)
    data.set(g.data.subarray((y + row) * g.width + x, (y + row) * g.width + x + w), row * w);
  return { width: w, height: h, data };
}

/** 그림의 일부 (px) */
export function cropCanvas(canvas: HTMLCanvasElement, r: { x: number; y: number; w: number; h: number }) {
  const out = blank(r.w, r.h);
  out.getContext("2d")!.drawImage(canvas, r.x, r.y, r.w, r.h, 0, 0, out.width, out.height);
  return out;
}

/** 밑그림으로 올릴 파일: PNG가 6MB를 넘으면 JPEG */
export async function canvasFile(canvas: HTMLCanvasElement): Promise<Blob> {
  const blob = (type: string, quality?: number) =>
    new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob"))), type, quality),
    );
  const png = await blob("image/png");
  if (png.size <= 6_000_000) return png;
  for (const q of [0.85, 0.7, 0.55]) {
    const jpeg = await blob("image/jpeg", q);
    if (jpeg.size <= 7_500_000) return jpeg;
  }
  throw new PlanFileError("BIG");
}

/** 이 사각형 안에서 어두운 곳을 감싸는 사각형 (px, 끝 포함). 없으면 null */
function inkBox(gray: Gray, r: { x0: number; y0: number; x1: number; y1: number }, dark: number) {
  const { width: W, data } = gray;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -1;
  let y1 = -1;
  for (let y = r.y0; y <= r.y1; y++)
    for (let x = r.x0; x <= r.x1; x++)
      if (data[y * W + x] < dark) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

/** 사각형 테두리를 따라 어두운 줄이 이어져 있나 (도곽) */
function framed(gray: Gray, b: { x0: number; y0: number; x1: number; y1: number }, dark: number, k: number) {
  const { width: W, data } = gray;
  const row = (y: number) => {
    let n = 0;
    for (let x = b.x0; x <= b.x1; x++) n += data[y * W + x] < dark ? 1 : 0;
    return n;
  };
  const col = (x: number) => {
    let n = 0;
    for (let y = b.y0; y <= b.y1; y++) n += data[y * W + x] < dark ? 1 : 0;
    return n;
  };
  const near = (from: number, to: number, f: (v: number) => number, len: number) => {
    for (let v = from; from <= to ? v <= to : v >= to; v += from <= to ? 1 : -1) if (f(v) >= 0.85 * len) return true;
    return false;
  };
  const w = b.x1 - b.x0 + 1;
  const h = b.y1 - b.y0 + 1;
  return (
    near(b.y0, b.y0 + k, row, w) &&
    near(b.y1, b.y1 - k, row, w) &&
    near(b.x0, b.x0 + k, col, h) &&
    near(b.x1, b.x1 - k, col, h)
  );
}

/**
 * 바탕(흰색)이 아닌 곳을 감싸는 사각형 (px). 거의 다 비어 있으면 전체.
 * 쪽 둘레에 도곽(테두리)이 있고 그 안의 도면이 테두리에 닿지 않으면 테두리 안쪽만
 */
export function contentBox(gray: Gray, dark = 200) {
  const { width: W, height: H } = gray;
  let box = inkBox(gray, { x0: 0, y0: 0, x1: W - 1, y1: H - 1 }, dark);
  if (!box) return { x: 0, y: 0, w: W, h: H };
  for (let round = 0; round < 2; round++) {
    const k = Math.max(3, Math.round(Math.max(W, H) * 0.006)); // 테두리 굵기로 볼 만큼
    if (!framed(gray, box, dark, k)) break;
    const inner = inkBox(
      gray,
      { x0: box.x0 + k + 1, y0: box.y0 + k + 1, x1: box.x1 - k - 1, y1: box.y1 - k - 1 },
      dark,
    );
    const gap = Math.max(W, H) * 0.012;
    if (
      !inner ||
      inner.x0 - box.x0 < gap ||
      inner.y0 - box.y0 < gap ||
      box.x1 - inner.x1 < gap ||
      box.y1 - inner.y1 < gap
    )
      break;
    box = inner;
  }
  const pad = Math.round(Math.max(W, H) * 0.01);
  const x = Math.max(0, box.x0 - pad);
  const y = Math.max(0, box.y0 - pad);
  return { x, y, w: Math.min(W, box.x1 + pad + 1) - x, h: Math.min(H, box.y1 + pad + 1) - y };
}
