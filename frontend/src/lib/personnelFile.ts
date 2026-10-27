// 인사이동 발령 엑셀(.xlsx)·CSV 읽기와 양식 만들기. 브라우저에서 읽어 줄마다 서버로 보낸다
// (서버가 사번·이름·부서를 조직도와 맞춰 본다: server/app/routers/personnel.py)
//
// 머리글 이름으로 열을 찾는다 (빈칸·괄호 안 글자는 무시): 사번, 이름, 현 부서, 새 부서, 직급, 직책.
// "부서"(또는 "소속") 열이 하나만 있으면 새 부서로 본다. 머리글은 위에서 20줄 안에 있으면 된다

import type { Workbook, Worksheet } from "exceljs";

export type PersonnelRowIn = {
  line: number; // 엑셀 행 번호
  emp_no: string;
  name?: string;
  from_department?: string;
  to_department?: string;
  rank?: string;
  position?: string;
};
type Field = Exclude<keyof PersonnelRowIn, "line">;

export type PersonnelFile = {
  rows: PersonnelRowIn[];
  sheet: string | null; // 읽은 시트 (CSV면 null)
  columns: string[]; // 찾은 열 (사람이 읽는 이름)
};

export class PersonnelFileError extends Error {
  constructor(public code: "TYPE" | "BROKEN" | "NO_HEADER" | "EMPTY" | "TOO_MANY") {
    super(code);
  }
}

export const MAX_ROWS = 2000; // 서버와 같다
const HEADER_ROWS = 20;

const FIELD_LABEL: Record<Field, string> = {
  emp_no: "사번",
  name: "이름",
  from_department: "현 부서",
  to_department: "새 부서",
  rank: "직급",
  position: "직책",
};

// 머리글로 쓰는 이름 (빈칸 없이 소문자). 위에서부터 먼저 맞는 것
const ALIASES: [Field, string[]][] = [
  ["emp_no", ["사번", "직원번호", "사원번호", "개인번호", "empno", "employeeid", "id"]],
  ["name", ["이름", "성명", "직원명", "사원명", "name"]],
  [
    "from_department",
    [
      "현부서",
      "현소속",
      "현재부서",
      "현재소속",
      "전부서",
      "전소속",
      "이전부서",
      "이전소속",
      "기존부서",
      "기존소속",
      "원부서",
      "원소속",
      "from",
    ],
  ],
  [
    "to_department",
    ["새부서", "새소속", "신부서", "신소속", "발령부서", "발령소속", "이동부서", "변경부서", "전보부서", "to"],
  ],
  ["rank", ["직급", "새직급", "신직급", "발령직급", "직위"]],
  ["position", ["직책", "새직책", "신직책", "발령직책"]],
];

const norm = (text: string) =>
  text
    .replace(/\(.*?\)|\[.*?\]/g, "")
    .replace(/[\s*:·._-]/g, "")
    .toLowerCase();

/** 머리글 한 줄에서 열 찾기: 필드 → 열 번호 (0부터) */
function findColumns(cells: string[]): Map<Field, number> | null {
  const found = new Map<Field, number>();
  const keys = cells.map(norm);
  for (const [field, names] of ALIASES) {
    const col = keys.findIndex((k, i) => names.includes(k) && ![...found.values()].includes(i));
    if (col >= 0) found.set(field, col);
  }
  // "부서"·"소속" 하나만 있으면 새 부서
  if (!found.has("to_department")) {
    const col = keys.findIndex(
      (k, i) => (k === "부서" || k === "소속" || k === "부서명") && ![...found.values()].includes(i),
    );
    if (col >= 0) found.set("to_department", col);
  }
  const usable = found.has("emp_no") && (found.has("to_department") || found.has("rank") || found.has("position"));
  return usable ? found : null;
}

function toRows(table: string[][], startLine: number): Omit<PersonnelFile, "sheet"> | null {
  for (let h = 0; h < Math.min(table.length, HEADER_ROWS); h++) {
    const cols = findColumns(table[h]);
    if (!cols) continue;
    const rows: PersonnelRowIn[] = [];
    for (let r = h + 1; r < table.length; r++) {
      const get = (f: Field) => {
        const col = cols.get(f);
        const value = col === undefined ? "" : (table[r][col] ?? "").trim();
        return value || undefined;
      };
      const row: PersonnelRowIn = { line: startLine + r, emp_no: get("emp_no") ?? "" };
      for (const f of ["name", "from_department", "to_department", "rank", "position"] as const) {
        const v = get(f);
        if (v) row[f] = v;
      }
      if (!row.emp_no && !row.to_department) continue; // 빈 줄·합계 줄 (사번도 새 부서도 없음)
      rows.push(row);
    }
    if (rows.length === 0) throw new PersonnelFileError("EMPTY");
    if (rows.length > MAX_ROWS) throw new PersonnelFileError("TOO_MANY");
    const order: Field[] = ["emp_no", "name", "from_department", "to_department", "rank", "position"];
    return { rows, columns: order.filter((f) => cols.has(f)).map((f) => FIELD_LABEL[f]) };
  }
  return null;
}

/** 칸 값을 글자로 (수식은 결과, 서식 있는 글자는 이어 붙임). 사번이 숫자로 들어 있어도 그대로 */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const v = value as { richText?: { text: string }[]; text?: unknown; result?: unknown; error?: unknown };
  if (v.richText) return v.richText.map((t) => t.text).join("");
  if (v.text !== undefined) return cellText(v.text);
  if (v.result !== undefined) return cellText(v.result);
  return "";
}

async function loadExcel(): Promise<{ Workbook: new () => Workbook }> {
  const mod = (await import("exceljs")) as unknown as { default?: unknown; Workbook?: unknown };
  return (mod.Workbook ? mod : mod.default) as { Workbook: new () => Workbook };
}

function sheetTable(ws: Worksheet): string[][] {
  const table: string[][] = [];
  for (let r = 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const cells: string[] = [];
    for (let c = 1; c <= row.cellCount; c++) cells.push(cellText(row.getCell(c).value).trim());
    table.push(cells);
  }
  return table;
}

/** CSV 한 줄씩: 따옴표 안의 쉼표·줄바꿈은 칸 안의 글자 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell || row.length) rows.push([...row, cell]);
  return rows;
}

/** 엑셀이 만든 CSV는 한국어 윈도우에서 EUC-KR인 경우가 많다: UTF-8로 깨지면 EUC-KR로 다시 읽는다 */
function decodeCsv(buffer: ArrayBuffer): string {
  const utf8 = new TextDecoder("utf-8").decode(buffer).replace(/^﻿/, "");
  if (!utf8.includes("�")) return utf8;
  try {
    return new TextDecoder("euc-kr").decode(buffer);
  } catch {
    return utf8;
  }
}

export async function readPersonnelFile(file: File): Promise<PersonnelFile> {
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".csv")) {
    const found = toRows(parseCsv(decodeCsv(await file.arrayBuffer())), 1);
    if (!found) throw new PersonnelFileError("NO_HEADER");
    return { ...found, sheet: null };
  }
  if (!lower.endsWith(".xlsx")) throw new PersonnelFileError("TYPE");
  const ExcelJS = await loadExcel();
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(await file.arrayBuffer());
  } catch {
    throw new PersonnelFileError("BROKEN");
  }
  // 숨긴 시트는 건너뛰고, 머리글(사번 + 새 부서)이 있는 첫 시트
  for (const ws of wb.worksheets) {
    if (ws.state && ws.state !== "visible") continue;
    const found = toRows(sheetTable(ws), 1);
    if (found) return { ...found, sheet: ws.name };
  }
  throw new PersonnelFileError("NO_HEADER");
}

/** 발령 양식 (.xlsx): "발령" 시트에 머리글만, "안내" 시트에 쓰는 법과 예시 */
export async function downloadTemplate(): Promise<void> {
  const ExcelJS = await loadExcel();
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("발령");
  ws.columns = [
    { header: "사번", width: 12 },
    { header: "이름", width: 10 },
    { header: "현 부서", width: 16 },
    { header: "새 부서", width: 16 },
    { header: "직급(바뀔 때만)", width: 16 },
    { header: "직책(바뀔 때만)", width: 16 },
  ];
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFEFEC" } };
  ws.getColumn(1).numFmt = "@"; // 사번 앞자리 0이 사라지지 않게 글자로
  ws.views = [{ state: "frozen", ySplit: 1 }];
  const guide = wb.addWorksheet("안내");
  guide.columns = [{ width: 18 }, { width: 70 }];
  [
    ["열", "쓰는 법"],
    ["사번 (필수)", "조직도의 사번. 이 열로 사람을 찾아요"],
    ["이름", "적으면 사번과 맞는지 확인해요 (다르면 그 줄은 빼고 알려 줘요)"],
    ["현 부서", "적으면 지금 부서와 맞는지 확인만 해요 (달라도 새 부서로 옮겨요)"],
    ["새 부서", "조직도의 부서 이름이나 부서코드. 비우면 부서는 그대로 (직급·직책만 바꿀 때)"],
    ["직급 · 직책", "바뀌는 사람만 적어요. 비우면 그대로"],
    ["", ""],
    ["예시", "20150004 | 오서연 | 재무팀 | 인사팀 | 차장 | 팀장"],
    ["", "다른 머리글 이름도 읽어요: 성명, 현소속, 발령부서, 신부서, 직위 등"],
  ].forEach((r, i) => {
    const row = guide.addRow(r);
    if (i === 0) row.font = { bold: true };
  });
  const buffer = await wb.xlsx.writeBuffer();
  const url = URL.createObjectURL(
    new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = "인사이동_발령_양식.xlsx";
  document.body.appendChild(a); // 문서에 붙여야 파일 이름(download)이 지켜진다
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
