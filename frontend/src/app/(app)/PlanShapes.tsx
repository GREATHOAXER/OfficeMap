import type { CSSProperties } from "react";
import type { FloorMap, Rect, ShapeStyle } from "@/lib/api";
import { DEFAULT_LINE, SPACE_KINDS } from "@/lib/planGeometry";
import { zoneColorVars } from "@/lib/zoneColors";
import { zoneOutline } from "@/lib/zoneShape";
import styles from "./office.module.css";

// 직원 화면 도면(FloorPlan)과 관리자 배치 화면(SeatingCanvas)이 같이 그리는 도면 바탕:
// 벽(사각형·선), 공간, 출입구, 기둥, 축척 막대, 팀 구역. 좌표는 도면 너비·높이 대비 비율(0~1)

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

/** 가로(h)·세로(v) 선인지. 좌표는 도면 너비·높이 대비 비율 */
export function lineAxis(x1: number, y1: number, x2: number, y2: number): "h" | "v" | null {
  if (Math.abs(y2 - y1) < 1e-7) return "h";
  if (Math.abs(x2 - x1) < 1e-7) return "v";
  return null;
}

/**
 * 선 벽 막대. 양 끝을 굵기 절반씩 늘려(네모 끝) 모서리에서 다른 벽과 빈틈 없이 만난다.
 * 가로·세로 선은 돌리지 않은 사각형으로 그린다: 90도 돌린 막대는 브라우저가 경계를 흐리게 칠해서
 * 옆의 가로선·벽과 1px쯤 어긋나 보인다. 비스듬한 선만 시작점을 기준으로 돌린다.
 * 좌표는 도면 너비·높이 대비 비율(0~1), width_m·height_m은 도면 크기(m), thick은 화면 굵기
 */
export function wallLineStyle(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  width_m: number,
  height_m: number,
  thick: string,
): CSSProperties {
  const half = `(${thick} / 2)`;
  const axis = lineAxis(x1, y1, x2, y2);
  if (axis === "h")
    return {
      left: `calc(${pct(Math.min(x1, x2))} - ${half})`,
      top: `calc(${pct(y1)} - ${half})`,
      width: `calc(${pct(Math.abs(x2 - x1))} + ${thick})`,
      height: thick,
    };
  if (axis === "v")
    return {
      left: `calc(${pct(x1)} - ${half})`,
      top: `calc(${pct(Math.min(y1, y2))} - ${half})`,
      width: thick,
      height: `calc(${pct(Math.abs(y2 - y1))} + ${thick})`,
    };
  // 도면 비율이 실제 비율과 같아서, 미터로 바꿔 길이(도면 폭 대비)·각도를 구하면 화면에서도 맞는다
  const dx = (x2 - x1) * width_m;
  const dy = (y2 - y1) * height_m;
  return {
    left: `calc(${pct(x1)} - ${half})`,
    top: pct(y1),
    width: `calc(${pct(Math.hypot(dx, dy) / width_m)} + ${thick})`,
    height: thick,
    marginTop: `calc(${thick} / -2)`,
    transformOrigin: `calc(${half}) 50%`,
    transform: `rotate(${Math.atan2(dy, dx).toFixed(5)}rad)`,
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
      {geometry.lines?.map((l, i) => (
        <div
          key={`line-${i}`}
          className={styles.wallLine}
          style={wallLineStyle(l.x1, l.y1, l.x2, l.y2, width_m, height_m, `max(2px, ${cqw(l.line)})`)}
        />
      ))}
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

/**
 * 팀 구역 한 곳: 조각(사각형)들을 칠하고 바깥 테두리만 긋는다 (맞닿거나 겹친 조각 사이에 선이 생기지 않게).
 * 흐리게·강조는 구역 전체에 한 번 (겹친 조각이 더 진해지지 않게). 구역끼리는 겹치지 않게 모양을 계산한다 (lib/zoneShape.ts)
 */
export function ZoneArea({
  zone,
  rects,
  title,
  className,
  focused,
}: {
  zone: { color_key: string; department: string | null };
  rects: Rect[];
  title: string;
  className?: string;
  focused?: boolean;
}) {
  return (
    <div
      className={`${styles.zoneArea} ${className ?? ""}`}
      data-color={zone.color_key}
      data-shared={zone.department === null}
      data-focus={focused || undefined}
      style={zoneColorVars(zone.color_key)}
    >
      {rects.map((r, i) => (
        <div key={i} className={styles.zoneFill} style={rectStyle(r)} title={title} />
      ))}
      {/* 선은 경계 한가운데에, 양 끝을 선 굵기 반씩 늘려 모서리가 비지 않게 */}
      {zoneOutline(rects).map((e, i) => (
        <span
          key={`edge-${i}`}
          className={styles.zoneEdge}
          data-dir={e.dir}
          style={
            e.dir === "h"
              ? { left: `calc(${pct(e.x)} - var(--edge) / 2)`, top: pct(e.y), width: `calc(${pct(e.len)} + var(--edge))` }
              : { left: pct(e.x), top: `calc(${pct(e.y)} - var(--edge) / 2)`, height: `calc(${pct(e.len)} + var(--edge))` }
          }
        />
      ))}
    </div>
  );
}

const NICE = [1, 2, 5, 10, 20, 50, 100];
const SCALE_MIN_PX = 44; // 축척 막대가 이보다 짧으면 다음 길이로

/** 축척 막대: 도면 아래 범례 줄에 두고(도면 위에 겹쳐 그리지 않는다), 지금 배율에서 1 m가 pxPerMeter px일 때
 *  44 px 이상이 되는 가장 짧은 깔끔한 길이(1·2·5·10… m)를 그린다. 확대·축소하면 길이가 따라 바뀐다 */
export function ScaleLegend({ pxPerMeter }: { pxPerMeter: number }) {
  const meters = NICE.find((n) => n * pxPerMeter >= SCALE_MIN_PX) ?? NICE[NICE.length - 1];
  return (
    <span className={styles.scaleLegend} aria-label={`축척: 막대 하나 ${meters} m`}>
      <i style={{ width: Math.round(meters * pxPerMeter) }} aria-hidden="true" />
      {meters} m
    </span>
  );
}
