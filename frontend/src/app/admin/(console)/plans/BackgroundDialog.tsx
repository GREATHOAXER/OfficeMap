"use client";

import { useState } from "react";
import Dialog from "@/components/Dialog";
import type { PlanEditorData } from "@/lib/api";
import { MAX_SIZE } from "@/lib/planGeometry";
import ui from "../seating/seating.module.css";
import { json } from "./shared";
import styles from "./plans.module.css";

type Background = NonNullable<PlanEditorData["background"]>;

type Props = {
  floorId: number;
  background: Background;
  readOnly: boolean;
  onClose: () => void;
  onChange: (background: Background | null) => void;
  onReplace: () => void;
  onExpired: () => void;
};

const mb = (bytes: number) =>
  bytes < 1_000_000 ? `${Math.max(1, Math.round(bytes / 1000))}KB` : `${(bytes / 1_000_000).toFixed(1)}MB`;

/** 밑그림 자리·크기·진하기 고치기, 다른 파일로 바꾸기, 지우기 */
export default function BackgroundDialog({
  floorId,
  background,
  readOnly,
  onClose,
  onChange,
  onReplace,
  onExpired,
}: Props) {
  const [x, setX] = useState(String(background.x_m));
  const [y, setY] = useState(String(background.y_m));
  const [w, setW] = useState(String(background.w_m));
  const [h, setH] = useState(String(background.h_m));
  const [keepRatio, setKeepRatio] = useState(true);
  const [opacity, setOpacity] = useState(background.opacity);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const ratio = background.h_m / background.w_m;
  const nums = [Number(x), Number(y), Number(w), Number(h)];
  const ok =
    nums.every(Number.isFinite) &&
    nums[2] >= 0.5 &&
    nums[3] >= 0.5 &&
    nums[2] <= MAX_SIZE * 2 &&
    nums[3] <= MAX_SIZE * 2;
  const r2 = (v: number) => String(Math.round(v * 100) / 100);
  const url = `/api/admin/floors/${floorId}/plan/background`;

  async function send(method: "PATCH" | "DELETE", body?: unknown) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, { method, headers: json, body: body ? JSON.stringify(body) : undefined });
      if (res.status === 401) return onExpired();
      if (!res.ok) throw new Error();
      onChange(method === "DELETE" ? null : ((await res.json()) as { background: Background }).background);
      onClose();
    } catch {
      setError("저장하지 못했어요. 잠시 뒤 다시 해 보세요");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="밑그림"
      footer={
        <>
          {!readOnly && (
            <button
              type="button"
              className={`${ui.btn} ${ui.ghost}`}
              style={{ marginRight: "auto" }}
              disabled={busy}
              onClick={() => (removing ? void send("DELETE") : setRemoving(true))}
            >
              {removing ? "정말 지우기" : "밑그림 지우기"}
            </button>
          )}
          <button type="button" className={ui.btn} onClick={onClose}>
            닫기
          </button>
          {!readOnly && (
            <button
              type="button"
              className={`${ui.btn} ${ui.pri}`}
              disabled={busy || !ok}
              onClick={() =>
                void send("PATCH", { x_m: nums[0], y_m: nums[1], w_m: nums[2], h_m: nums[3], opacity, visible: true })
              }
            >
              저장
            </button>
          )}
        </>
      }
    >
      <div className={ui.dialogBody}>
        <p>
          {background.name ?? "도면 파일"} · {mb(background.bytes)}. 편집 화면에서만 요소 밑에 깔리고 직원 화면에는
          나오지 않아요.
        </p>
        <div className={styles.numbers}>
          <label>
            왼쪽 (m)
            <input
              type="number"
              inputMode="decimal"
              step={0.1}
              value={x}
              disabled={readOnly}
              onChange={(e) => setX(e.target.value)}
            />
          </label>
          <label>
            위 (m)
            <input
              type="number"
              inputMode="decimal"
              step={0.1}
              value={y}
              disabled={readOnly}
              onChange={(e) => setY(e.target.value)}
            />
          </label>
        </div>
        <div className={styles.numbers}>
          <label>
            폭 (m)
            <input
              type="number"
              inputMode="decimal"
              step={0.1}
              min={0.5}
              value={w}
              disabled={readOnly}
              aria-invalid={!ok || undefined}
              onChange={(e) => {
                setW(e.target.value);
                const v = Number(e.target.value);
                if (keepRatio && v > 0) setH(r2(v * ratio));
              }}
            />
          </label>
          <label>
            높이 (m)
            <input
              type="number"
              inputMode="decimal"
              step={0.1}
              min={0.5}
              value={h}
              disabled={readOnly}
              aria-invalid={!ok || undefined}
              onChange={(e) => {
                setH(e.target.value);
                const v = Number(e.target.value);
                if (keepRatio && v > 0) setW(r2(v / ratio));
              }}
            />
          </label>
        </div>
        {!ok && (
          <p className={ui.conflictText} role="alert">
            왼쪽·위는 숫자로, 폭·높이는 0.5~{MAX_SIZE * 2} m 사이로 넣어 주세요
          </p>
        )}
        <label className={ui.check}>
          <input
            type="checkbox"
            checked={keepRatio}
            disabled={readOnly}
            onChange={(e) => setKeepRatio(e.target.checked)}
          />
          가로·세로 비율 그대로
        </label>
        <label className={styles.inlineField}>
          진하기
          <input
            type="range"
            min={0.05}
            max={1}
            step={0.05}
            value={opacity}
            disabled={readOnly}
            onChange={(e) => setOpacity(Number(e.target.value))}
          />
          <span className={ui.muted}>{Math.round(opacity * 100)}%</span>
        </label>
        {!readOnly && (
          <button type="button" className={ui.btn} disabled={busy} onClick={onReplace}>
            다른 도면 파일로 바꾸기…
          </button>
        )}
        {error && (
          <p className={ui.conflictText} role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
