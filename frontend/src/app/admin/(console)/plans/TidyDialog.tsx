"use client";

import { useMemo, useState } from "react";
import Dialog from "@/components/Dialog";
import type { PlanElement } from "@/lib/api";
import { type TidyResult, tidyWalls } from "@/lib/wallSnap";
import ui from "../seating/seating.module.css";
import styles from "./plans.module.css";

type Props = {
  elements: PlanElement[];
  /** 고른 선 벽 (있으면 "고른 것만"을 기본으로) */
  selectedLines: string[];
  onClose: () => void;
  onApply: (result: TidyResult) => void;
};

const num = (text: string, min: number, max: number) => {
  const v = Number(text);
  return Number.isFinite(v) && v >= min && v <= max ? v : null;
};

/** 선 정리: 기운 선을 곧게, 벌어진 끝을 잇고, 굵기를 맞춘다. 바뀌는 수를 미리 보여 주고 한 번에 되돌릴 수 있다 */
export default function TidyDialog({ elements, selectedLines, onClose, onApply }: Props) {
  const total = elements.filter((e) => e.type === "wall_line").length;
  const [scope, setScope] = useState<"selected" | "all">(selectedLines.length ? "selected" : "all");
  const [straight, setStraight] = useState(true);
  const [deg, setDeg] = useState("5");
  const [join, setJoin] = useState(true);
  const [joinCm, setJoinCm] = useState("30");
  const [thick, setThick] = useState(false);
  const [thickCm, setThickCm] = useState("20");
  const [rectWalls, setRectWalls] = useState(false);

  const degV = num(deg, 1, 20);
  const joinV = num(joinCm, 1, 100);
  const thickV = num(thickCm, 1, 200);
  const valid = (!straight || degV !== null) && (!join || joinV !== null) && (!thick || thickV !== null);
  const result = useMemo(
    () =>
      valid
        ? tidyWalls(elements, {
            straightenDeg: straight ? degV! : 0,
            joinM: join ? joinV! / 100 : 0,
            thickness: thick ? thickV! / 100 : null,
            rectWalls: thick && rectWalls,
            only: scope === "selected" ? new Set(selectedLines) : undefined,
          })
        : null,
    [elements, valid, straight, degV, join, joinV, thick, thickV, rectWalls, scope, selectedLines],
  );
  const changes = result ? result.moved + result.removed + result.thickened : 0;

  return (
    <Dialog
      open
      onClose={onClose}
      size="narrow"
      title="선 정리"
      footer={
        <>
          <button type="button" className={ui.btn} onClick={onClose}>
            닫기
          </button>
          <button
            type="button"
            className={`${ui.btn} ${ui.pri}`}
            disabled={!result || changes === 0}
            onClick={() => result && onApply(result)}
          >
            정리하기
          </button>
        </>
      }
    >
      <div className={ui.dialogBody}>
        <p>삐뚤게 그린 선 벽을 곧게 펴고, 벌어진 끝을 서로(또는 벽에) 이어요. 정리한 뒤에도 되돌릴 수 있어요.</p>
        {selectedLines.length > 0 && (
          <fieldset className={ui.when}>
            <legend>어느 선을</legend>
            <label>
              <input type="radio" checked={scope === "selected"} onChange={() => setScope("selected")} /> 고른 선 벽{" "}
              {selectedLines.length}개
            </label>
            <label>
              <input type="radio" checked={scope === "all"} onChange={() => setScope("all")} /> 도면의 선 벽 모두{" "}
              {total}개
            </label>
          </fieldset>
        )}
        <div className={styles.tidyRows}>
          <label>
            <input type="checkbox" checked={straight} onChange={(e) => setStraight(e.target.checked)} />
            기운 선을 가로·세로로 곧게
            <span>
              <input
                type="number"
                min={1}
                max={20}
                value={deg}
                disabled={!straight}
                aria-label="곧게 펼 기울기 (도)"
                aria-invalid={(straight && degV === null) || undefined}
                onChange={(e) => setDeg(e.target.value)}
              />
              도 이내
            </span>
          </label>
          <label>
            <input type="checkbox" checked={join} onChange={(e) => setJoin(e.target.checked)} />
            가까운 끝을 잇기 (선 끝·벽)
            <span>
              <input
                type="number"
                min={1}
                max={100}
                value={joinCm}
                disabled={!join}
                aria-label="이을 거리 (cm)"
                aria-invalid={(join && joinV === null) || undefined}
                onChange={(e) => setJoinCm(e.target.value)}
              />
              cm 이내
            </span>
          </label>
          <label>
            <input type="checkbox" checked={thick} onChange={(e) => setThick(e.target.checked)} />선 벽 굵기를 모두
            <span>
              <input
                type="number"
                min={1}
                max={200}
                value={thickCm}
                disabled={!thick}
                aria-label="맞출 굵기 (cm)"
                aria-invalid={(thick && thickV === null) || undefined}
                onChange={(e) => setThickCm(e.target.value)}
              />
              cm로
            </span>
          </label>
          <label data-sub>
            <input
              type="checkbox"
              checked={rectWalls}
              disabled={!thick}
              onChange={(e) => setRectWalls(e.target.checked)}
            />
            벽(사각형)도 같은 굵기로
          </label>
        </div>
        <p className={ui.hint} role="status">
          {!result
            ? "숫자를 확인하세요"
            : changes === 0
              ? "고칠 선이 없어요."
              : [
                  `선 ${result.moved}개를 고쳐요`,
                  result.straightened && `곧게 ${result.straightened}`,
                  result.joined && `이음 ${result.joined}곳`,
                  result.removed && `짧아져 지움 ${result.removed}`,
                  result.thickened && `굵기 ${result.thickened}`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
        </p>
      </div>
    </Dialog>
  );
}
