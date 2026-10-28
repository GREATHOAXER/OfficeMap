// 팀 구역 색. 기본 색(키 t0~t11, globals.css의 [data-color])과 관리자가 직접 고른 색(#rrggbb, DB zones.color_key)
// 기본 색의 선(line)은 모두 흰 글자가 읽히는 진하기(흰색과 4.5:1 이상)다. 구역 이름표가 선 색 바탕에 흰 글자라서
import type { CSSProperties } from "react";

export const ZONE_PALETTE: { key: string; label: string; line: string; fill: string }[] = [
  { key: "t1", label: "파랑", line: "#3b5b92", fill: "#e3eaf6" },
  { key: "t2", label: "갈색", line: "#9a5b1e", fill: "#f7e9d7" },
  { key: "t3", label: "초록", line: "#4c7a34", fill: "#e5f0dc" },
  { key: "t4", label: "보라", line: "#6e4a86", fill: "#eee4f4" },
  { key: "t5", label: "빨강", line: "#b0303a", fill: "#f8e3e4" },
  { key: "t6", label: "청록", line: "#17766f", fill: "#dcefed" },
  { key: "t7", label: "주황", line: "#b45309", fill: "#fbe9d9" },
  { key: "t8", label: "분홍", line: "#a8336f", fill: "#f7e2ed" },
  { key: "t9", label: "올리브", line: "#5f6b12", fill: "#ecefd9" },
  { key: "t10", label: "하늘", line: "#1f6a99", fill: "#dcebf5" },
  { key: "t11", label: "겨자", line: "#866300", fill: "#f5edd3" },
  { key: "t0", label: "회색 (공용)", line: "#6e6e69", fill: "#efefec" },
];

const BY_KEY = new Map(ZONE_PALETTE.map((c) => [c.key, c]));
const HEX = /^#[0-9a-f]{6}$/i;

/** 관리자가 직접 고른 색(#rrggbb)인가 */
export const isCustomColor = (key: string | null | undefined): key is string => !!key && HEX.test(key);

const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (rgb: number[]) => `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;
function luminance(rgb: number[]) {
  const [r, g, b] = rgb.map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const customCache = new Map<string, { line: string; fill: string }>();

/** 직접 고른 색으로 선·채움을 만든다. 선은 흰 글자가 읽히게(4.5:1) 필요하면 조금씩 어둡게, 채움은 그 색을 연하게 */
function customColor(hex: string) {
  const key = hex.toLowerCase();
  const cached = customCache.get(key);
  if (cached) return cached;
  const base = channels(key);
  let line = base;
  while (1.05 / (luminance(line) + 0.05) < 4.5) line = line.map((c) => c * 0.92);
  const out = { line: toHex(line), fill: toHex(base.map((c) => c * 0.16 + 255 * 0.84)) };
  customCache.set(key, out);
  return out;
}

/** 구역 색의 선·채움 (모르는 키는 회색). 내보내기 그림(SVG)처럼 CSS를 못 쓰는 곳에서 쓴다 */
export function zoneColor(key: string | null | undefined): { line: string; fill: string } {
  if (isCustomColor(key)) return customColor(key);
  return BY_KEY.get(key ?? "t0") ?? BY_KEY.get("t0")!;
}

/** data-color와 같이 붙이는 style: 직접 고른 색이면 --tc(선)·--tf(채움)를 넣는다. 기본 색은 globals.css가 맡는다 */
export function zoneColorVars(key: string | null | undefined): CSSProperties | undefined {
  if (!isCustomColor(key)) return undefined;
  const { line, fill } = customColor(key);
  return { "--tc": line, "--tf": fill } as CSSProperties;
}
