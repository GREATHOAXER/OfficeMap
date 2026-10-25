"use client";

import { useState } from "react";
import Dialog from "@/components/Dialog";
import { MAX_SIZE, MIN_SIZE } from "@/lib/planGeometry";
import ui from "../seating/seating.module.css";
import styles from "./plans.module.css";

type Props = {
  width: number;
  height: number;
  onClose: () => void;
  /** scale: 그린 요소도 같은 비율로. desks: 책상 크기도 같은 비율로 (끄면 책상 크기는 두고 자리만 옮긴다) */
  onApply: (size: { width: number; height: number }, scale: boolean, desks: boolean) => void;
};

/** 사무실(도면) 크기 바꾸기. 실제 크기를 넣으면 책상·회의실이 그 크기에 맞는 비율로 그려진다 */
export default function ResizeDialog({ width, height, onClose, onApply }: Props) {
  const [w, setW] = useState(String(width));
  const [h, setH] = useState(String(height));
  const [keepRatio, setKeepRatio] = useState(false);
  const [scale, setScale] = useState(false);
  const [desks, setDesks] = useState(false);
  const W = Number(w);
  const H = Number(h);
  const ok = [W, H].every((v) => Number.isFinite(v) && v >= MIN_SIZE && v <= MAX_SIZE);
  const changed = ok && (W !== width || H !== height);
  const r2 = (v: number) => String(Math.round(v * 100) / 100);

  return (
    <Dialog
      open
      onClose={onClose}
      size="narrow"
      title="사무실 크기 바꾸기"
      footer={
        <>
          <button type="button" className={ui.btn} onClick={onClose}>
            닫기
          </button>
          <button
            type="button"
            className={`${ui.btn} ${ui.pri}`}
            disabled={!changed}
            onClick={() => onApply({ width: W, height: H }, scale, scale && desks)}
          >
            바꾸기
          </button>
        </>
      }
    >
      <div className={ui.dialogBody}>
        <p>
          지금 {width} × {height} m ({r2(width * height)} m²). 실제 사무실의 바깥 크기를 미터로 넣으세요.
        </p>
        <div className={styles.numbers}>
          <label>
            폭 (m)
            <input
              type="number"
              inputMode="decimal"
              min={MIN_SIZE}
              max={MAX_SIZE}
              step={0.5}
              value={w}
              aria-invalid={!ok || undefined}
              onChange={(e) => {
                setW(e.target.value);
                const v = Number(e.target.value);
                if (keepRatio && v > 0) setH(r2((v * height) / width));
              }}
            />
          </label>
          <label>
            높이 (m)
            <input
              type="number"
              inputMode="decimal"
              min={MIN_SIZE}
              max={MAX_SIZE}
              step={0.5}
              value={h}
              aria-invalid={!ok || undefined}
              onChange={(e) => {
                setH(e.target.value);
                const v = Number(e.target.value);
                if (keepRatio && v > 0) setW(r2((v * width) / height));
              }}
            />
          </label>
        </div>
        {!ok && (
          <p className={ui.conflictText}>
            {MIN_SIZE}~{MAX_SIZE} m 사이로 넣으세요
          </p>
        )}
        <div className={styles.checks} style={{ flexDirection: "column" }}>
          <label>
            <input type="checkbox" checked={keepRatio} onChange={(e) => setKeepRatio(e.target.checked)} />
            가로·세로 비율 그대로
          </label>
          <label>
            <input type="checkbox" checked={scale} onChange={(e) => setScale(e.target.checked)} />
            그린 벽·회의실·공간도 같은 비율로 늘리거나 줄이기
          </label>
          <label style={{ paddingLeft: 22 }}>
            <input type="checkbox" checked={desks} disabled={!scale} onChange={(e) => setDesks(e.target.checked)} />
            책상 크기도 같은 비율로 (끄면 책상은 실제 크기 그대로 두고 자리만 옮겨요)
          </label>
        </div>
        <p className={ui.hint}>
          {scale
            ? "도면을 다른 축척으로 그렸을 때 쓰세요. 앉은 사람·예약은 그대로예요."
            : "요소는 그 자리(m)에 그대로 두고 도면만 넓히거나 줄여요. 밖으로 나간 요소는 '게시 전에 고칠 것'에 떠요."}
        </p>
      </div>
    </Dialog>
  );
}
