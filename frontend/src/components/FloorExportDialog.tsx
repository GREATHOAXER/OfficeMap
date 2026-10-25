"use client";

import { useRef, useState } from "react";
import { kstDate } from "@/lib/dates";
import type { FloorDrawing } from "@/lib/floorDrawing";
import Dialog from "./Dialog";
import FloorSvg from "./FloorSvg";
import styles from "./FloorExportDialog.module.css";

const PNG_WIDTH_PX = 2400; // 내보내는 그림 폭 (A3로 뽑아도 글자가 깨지지 않을 만큼)

type Props = {
  drawing: FloorDrawing;
  title: string; // 그림 위 제목 (예: 서울 본사 7F 좌석 배치도)
  fileBase: string; // 파일 이름 앞부분 (예: 7F-좌석배치)
  /** 이름을 쓸 수 있는 그림인가 (도면 초안은 지금 앉은 사람 기준) */
  names?: boolean;
  onClose: () => void;
};

/** 도면 내보내기: PNG 그림 파일, PDF(브라우저 인쇄 창에서 "PDF로 저장") */
export default function FloorExportDialog({ drawing, title, fileBase, names = true, onClose }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [showNames, setShowNames] = useState(names);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const today = kstDate(new Date().toISOString());
  const subtitle = `${today} 기준`;

  async function savePng() {
    const svg = svgRef.current;
    if (!svg) return;
    setBusy(true);
    setError(null);
    try {
      const blob = await svgToPng(svg);
      download(blob, `${fileBase}-${today}.png`);
    } catch {
      setError("그림을 만들지 못했어요. 다른 브라우저에서 다시 해 보세요");
    } finally {
      setBusy(false);
    }
  }

  function printPdf() {
    const svg = svgRef.current;
    if (!svg) return;
    printSvg(svg, `${fileBase}-${today}`);
  }

  return (
    <Dialog
      open
      onClose={onClose}
      size="wide"
      title="도면 내보내기"
      footer={
        <>
          <button type="button" className={styles.btn} onClick={onClose}>
            닫기
          </button>
          <button type="button" className={styles.btn} onClick={printPdf}>
            PDF로 인쇄…
          </button>
          <button
            type="button"
            className={`${styles.btn} ${styles.pri}`}
            disabled={busy}
            onClick={() => void savePng()}
          >
            {busy ? "만드는 중…" : "PNG로 저장"}
          </button>
        </>
      }
    >
      <div className={styles.body}>
        {names && (
          <label className={styles.check}>
            <input type="checkbox" checked={showNames} onChange={(e) => setShowNames(e.target.checked)} />
            앉은 사람 이름 표시 (끄면 좌석 번호만)
          </label>
        )}
        <FloorSvg
          ref={svgRef}
          drawing={drawing}
          title={title}
          subtitle={subtitle}
          showNames={showNames}
          className={styles.preview}
          label={`${title} 미리보기`}
        />
        <p className={styles.hint}>
          PNG는 폭 {PNG_WIDTH_PX}px 그림 파일로 저장돼요. PDF는 인쇄 창에서 대상(프린터)을 &lsquo;PDF로 저장&rsquo;으로
          고르세요 (A4 가로).
        </p>
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

function serialize(svg: SVGSVGElement): string {
  return new XMLSerializer().serializeToString(svg);
}

/** SVG → PNG. 그림 안 글꼴은 이 컴퓨터의 한글 글꼴로 그려진다 */
async function svgToPng(svg: SVGSVGElement): Promise<Blob> {
  const box = svg.viewBox.baseVal;
  const scale = PNG_WIDTH_PX / box.width;
  const url = URL.createObjectURL(new Blob([serialize(svg)], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("svg load"));
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = PNG_WIDTH_PX;
    canvas.height = Math.round(box.height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("png"))), "image/png"),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** 보이지 않는 틀에 그림만 넣고 인쇄 창을 연다 (팝업 차단에 걸리지 않게 새 창 대신) */
function printSvg(svg: SVGSVGElement, title: string) {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
  const escaped = title.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  frame.srcdoc = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${escaped}</title>
<style>@page{size:A4 landscape;margin:10mm}html,body{margin:0}svg{display:block;width:100%;height:auto;max-height:190mm}</style>
</head><body>${serialize(svg)}</body></html>`;
  frame.onload = () => {
    const win = frame.contentWindow;
    if (!win) return;
    const cleanup = () => setTimeout(() => frame.remove(), 500);
    win.addEventListener("afterprint", cleanup);
    setTimeout(() => frame.remove(), 120_000); // 인쇄 창을 닫지 않고 둔 경우
    win.focus();
    win.print();
  };
  document.body.appendChild(frame);
}
