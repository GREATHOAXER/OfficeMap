import type { CSSProperties } from "react";
import type { FloorMap, Rect, ShapeStyle } from "@/lib/api";
import { DEFAULT_LINE, SPACE_KINDS } from "@/lib/planGeometry";
import styles from "./office.module.css";

// 직원 화면 도면(FloorPlan)과 관리자 배치 화면(SeatingCanvas)이 같이 그리는 도면 바탕:
// 벽(사각형·선), 공간, 출입구, 기둥, 축척 막대. 좌표는 도면 너비·높이 대비 비율(0~1)

type Geometry = NonNullable<NonNullable<FloorMap["plan"]>["geometry"]>;

const pct = (v: number) => `${(v * 100).toFixed(3)}%`;
const rectStyle = (r: Rect): CSSProperties => ({ left: pct(r.x), top: pct(r.y), width: pct(r.w), height: pct(r.h) });
/** 선 굵기(도면 폭 대비)를 화면 굵기로. 도면 컨테이너 폭이 cqw 기준이다 */
const cqw = (ratio: number) => `${(ratio * 100).toFixed(4)}cqw`;

/** 선 굵기를 정한 요소의 테두리 굵기 (없으면 CSS 기본) */
export const lineStyle = (s: ShapeStyle): CSSProperties => (s.line ? { borderWidth: `max(1px, ${cqw(s.line)})` } : {});

/** 벽(사각형) 테두리 굵기. line은 도면 폭 대비 비율, 없으면 기본 굵기(m)를 도면 폭에 맞춰 그린다 (선 벽과 같은 기준) */
export const wallBorder = (line: number | undefined, width_m: number): CSSProperties => ({
  borderWidth: `max(2px, ${cqw(line ?? (DEFAULT_LINE.wall ?? 0.3) / width_m)})`,
});

/**
 * 선 벽 막대 (돌린 div). 양 끝을 굵기 절반씩 늘려(네모 끝) 모서리에서 다른 벽과 빈틈 없이 만난다.
 * left·top은 시작점, length는 길이(도면 폭 대비 %), thick은 화면 굵기
 */
export function wallLineStyle(left: string, top: string, length: string, thick: string, angle: number): CSSProperties {
  const half = `(${thick} / 2)`;
  return {
    left: `calc(${left} - ${half})`,
    top,
    width: `calc(${length} + ${thick})`,
    height: thick,
    marginTop: `calc(${thick} / -2)`,
    transformOrigin: `calc(${half}) 50%`,
    transform: `rotate(${angle.toFixed(5)}rad)`,
  };
}

/** 이름표 글자 크기(%)·굵게. 기본 글자 크기는 max(9px, 1cqw) */
export function labelStyle(s: ShapeStyle): CSSProperties {
  const k = (s.label_size ?? 100) / 100;
  return {
    ...(k !== 1 ? { fontSize: `max(${(9 * k).toFixed(1)}px, ${k.toFixed(2)}cqw)` } : {}),
    ...(s.label_bold ? { fontWeight: 700 } : {}),
  };
}

/** 직원 화면·좌석 배치의 이름표: 크기(%)는 --k로 넘기고, 칸보다 크면 CSS(.fitLabel)가 칸에 맞게 줄인다 */
export function fitLabelStyle(s: ShapeStyle): CSSProperties {
  return {
    ...({ "--k": ((s.label_size ?? 100) / 100).toFixed(2) } as CSSProperties),
    ...(s.label_bold ? { fontWeight: 700 } : {}),
  };
}

type Props = { geometry: Geometry; width_m: number; height_m: number };

export default function PlanShapes({ geometry, width_m, height_m }: Props) {
  return (
    <>
      {geometry.walls?.map((wall, i) => (
        <div
          key={`wall-${i}`}
          className={styles.wall}
          style={{ ...rectStyle(wall), ...wallBorder(wall.line, width_m) }}
        />
      ))}
      {geometry.lines?.map((l, i) => {
        // 도면 비율이 실제 비율과 같아서, 미터로 바꿔 길이·각도를 구하면 화면에서도 맞는다
        const dx = (l.x2 - l.x1) * width_m;
        const dy = (l.y2 - l.y1) * height_m;
        const thick = `max(2px, ${cqw(l.line)})`;
        return (
          <div
            key={`line-${i}`}
            className={styles.wallLine}
            style={wallLineStyle(pct(l.x1), pct(l.y1), pct(Math.hypot(dx, dy) / width_m), thick, Math.atan2(dy, dx))}
          />
        );
      })}
      {geometry.spaces?.map((space, i) => (
        <div
          key={`space-${i}`}
          className={`${styles.space} ${styles.fitLabel}`}
          data-kind={space.kind}
          style={{ ...rectStyle(space), ...lineStyle(space) }}
        >
          {/* 이름표를 비워 두면 종류 이름 (도면 편집기와 같다) */}
          <span style={fitLabelStyle(space)}>
            {space.label || SPACE_KINDS.find((k) => k.kind === space.kind)?.label}
          </span>
        </div>
      ))}
      {geometry.entrances?.map((e, i) => (
        <div
          key={`entrance-${i}`}
          className={styles.entrance}
          data-main={e.main}
          style={{ ...rectStyle(e), ...lineStyle(e) }}
          aria-label={e.label}
        >
          <span style={labelStyle(e)}>{e.label}</span>
        </div>
      ))}
      {geometry.pillars?.map((p, i) => {
        const w = p.w ?? 0.015;
        const h = p.h ?? 0.025;
        return (
          <div
            key={`pillar-${i}`}
            className={styles.pillar}
            style={{ left: pct(p.x - w / 2), top: pct(p.y - h / 2), width: pct(w), height: pct(h) }}
          />
        );
      })}
    </>
  );
}

const NICE = [1, 2, 5, 10, 20, 50, 100];

/** 축척 막대: 도면 폭의 10~20% 안팎인 깔끔한 길이 (예: 5 m)와 도면 전체 크기 */
export function ScaleBar({ width_m, height_m }: { width_m: number; height_m: number }) {
  const length = NICE.find((n) => n / width_m >= 0.08) ?? NICE[NICE.length - 1];
  return (
    <div className={styles.scaleBar} aria-label={`축척: 막대 하나 ${length} m, 도면 ${width_m} × ${height_m} m`}>
      <i style={{ width: cqw(length / width_m) }} aria-hidden="true" />
      <span>
        {length} m · 도면 {width_m} × {height_m} m
      </span>
    </div>
  );
}
