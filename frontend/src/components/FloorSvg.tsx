"use client";

import { forwardRef } from "react";
import { type DrawingSeat, type FloorDrawing, teamColor } from "@/lib/floorDrawing";
import { DESK } from "@/lib/planGeometry";

// 내보낸 그림에서도 같은 모양이 나오게 글꼴·색을 속성으로 직접 적는다 (CSS를 쓰지 않는다)
const FONT = "'IBM Plex Sans KR', 'Apple SD Gothic Neo', 'Malgun Gothic', 'Noto Sans KR', sans-serif";
const INK = "#1c1c1c";
const MUTED = "#5e5e5a";
const LINK = "#1d4ed8";
const HEADER_M = 3.2; // 제목 줄 높이 (m)
const HATCHED = new Set(["core", "restroom", "service", "restricted"]);

type Props = {
  drawing: FloorDrawing;
  /** 그림 위 제목 (내보내기). 없으면 도면만 */
  title?: string;
  subtitle?: string;
  /** 좌석에 앉은 사람 이름을 쓴다 */
  showNames?: boolean;
  /** 좌석을 누를 수 있게 (이사 도우미) */
  onSeatClick?: (seat: DrawingSeat) => void;
  seatTitle?: (seat: DrawingSeat) => string;
  className?: string;
  label: string;
};

/** 층 도면 그림 (SVG, 1 = 1 m). 미니 도면과 내보내기에 같이 쓴다 */
const FloorSvg = forwardRef<SVGSVGElement, Props>(function FloorSvg(props, ref) {
  const { drawing: d, title, subtitle, showNames, onSeatClick, seatTitle, className, label } = props;
  const top = title ? HEADER_M : 0;
  const wallW = Math.max(0.15, d.width / 250);
  return (
    <svg
      ref={ref}
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${d.width} ${d.height + top}`}
      className={className}
      role="img"
      aria-label={label}
      fontFamily={FONT}
    >
      <rect x={0} y={0} width={d.width} height={d.height + top} fill="#ffffff" />
      {title && (
        <g>
          <text x={0.8} y={1.7} fontSize={1.3} fontWeight={700} fill={INK}>
            {title}
          </text>
          {subtitle && (
            <text x={d.width - 0.8} y={1.7} fontSize={0.8} fill={MUTED} textAnchor="end">
              {subtitle}
            </text>
          )}
          <line x1={0.8} x2={d.width - 0.8} y1={2.6} y2={2.6} stroke="#d4d4d0" strokeWidth={0.06} />
        </g>
      )}
      <g transform={`translate(0 ${top})`}>
        <defs>
          <pattern
            id="floor-hatch"
            width={0.6}
            height={0.6}
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <line x1={0} y1={0} x2={0} y2={0.6} stroke="#d4d4d0" strokeWidth={0.08} />
          </pattern>
        </defs>
        {d.zones.flatMap((z) =>
          z.rects.map((r, i) => (
            <rect
              key={`zone-${z.id}-${i}`}
              x={r.x}
              y={r.y}
              width={r.w}
              height={r.h}
              rx={0.25}
              fill={teamColor(z.color).fill}
              stroke={teamColor(z.color).line}
              strokeWidth={0.06}
            />
          )),
        )}
        {d.spaces.map((s, i) => (
          <g key={`space-${i}`}>
            <rect
              x={s.x}
              y={s.y}
              width={s.w}
              height={s.h}
              fill={HATCHED.has(s.kind) ? "url(#floor-hatch)" : "none"}
              stroke={HATCHED.has(s.kind) ? INK : "#6e6e69"}
              strokeWidth={0.07}
              strokeDasharray={HATCHED.has(s.kind) ? undefined : "0.3 0.2"}
            />
            <text x={s.x + s.w / 2} y={s.y + s.h / 2 + 0.25} fontSize={0.7} fill={MUTED} textAnchor="middle">
              {s.label}
            </text>
          </g>
        ))}
        {d.rooms.map((r, i) => (
          <g key={`room-${i}`}>
            <rect x={r.x} y={r.y} width={r.w} height={r.h} fill="#ffffff" stroke={INK} strokeWidth={0.1} />
            <text x={r.x + r.w / 2} y={r.y + r.h / 2 + 0.3} fontSize={0.8} fill={INK} textAnchor="middle">
              {r.name}
            </text>
          </g>
        ))}
        {d.walls.map((w, i) => (
          <rect
            key={`wall-${i}`}
            x={w.x + wallW / 2}
            y={w.y + wallW / 2}
            width={Math.max(w.w - wallW, 0.01)}
            height={Math.max(w.h - wallW, 0.01)}
            fill="none"
            stroke={INK}
            strokeWidth={wallW}
          />
        ))}
        {d.pillars.map((p, i) => (
          <rect key={`pillar-${i}`} x={p.x} y={p.y} width={p.w} height={p.h} fill={INK} />
        ))}
        {d.zones.map((z) => {
          const r = [...z.rects].sort((a, b) => b.w * b.h - a.w * a.h)[0];
          if (!r) return null;
          const text = `${z.name} · ${z.code}`;
          const w = Math.min(text.length * 0.62 + 0.6, r.w);
          return (
            <g key={`tag-${z.id}`}>
              <rect x={r.x} y={r.y} width={w} height={1.05} rx={0.2} fill={teamColor(z.color).line} />
              <text x={r.x + 0.3} y={r.y + 0.78} fontSize={0.7} fontWeight={600} fill="#ffffff">
                {text}
              </text>
            </g>
          );
        })}
        {d.seats.map((s) => (
          <SeatMark key={s.id} seat={s} showName={!!showNames} onClick={onSeatClick} title={seatTitle?.(s)} />
        ))}
      </g>
    </svg>
  );
});

export default FloorSvg;

function SeatMark({
  seat,
  showName,
  onClick,
  title,
}: {
  seat: DrawingSeat;
  showName: boolean;
  onClick?: (seat: DrawingSeat) => void;
  title?: string;
}) {
  const { w, h } = DESK;
  const x = seat.x - w / 2;
  const y = seat.y - h / 2;
  const color = teamColor(seat.color);
  const target = seat.state === "target";
  const fill = target
    ? "#eef2ff"
    : seat.state === "flex"
      ? color.fill
      : seat.state === "off"
        ? "url(#floor-hatch)"
        : "#ffffff";
  const chairY = seat.rotation === 180 ? y : y + h;
  const name = showName || target ? seat.name : null;
  const clickable = !!onClick;
  return (
    <g
      onClick={onClick ? () => onClick(seat) : undefined}
      style={clickable ? { cursor: "pointer" } : undefined}
      data-seat={seat.code}
      data-state={seat.state}
    >
      {title && <title>{title}</title>}
      <rect
        x={x + 0.05}
        y={y + 0.05}
        width={w - 0.1}
        height={h - 0.1}
        rx={0.15}
        fill={fill}
        stroke={target ? LINK : seat.state === "new" ? LINK : "#bdbdb8"}
        strokeWidth={target ? 0.16 : 0.05}
        strokeDasharray={seat.state === "free" || seat.state === "new" ? "0.25 0.15" : undefined}
      />
      <line x1={x + 0.1} x2={x + w - 0.1} y1={chairY} y2={chairY} stroke={color.line} strokeWidth={0.22} />
      <text
        x={seat.x}
        y={name ? seat.y - 0.12 : seat.y + 0.2}
        fontSize={0.52}
        fill={seat.state === "taken" || target ? INK : MUTED}
        textAnchor="middle"
        fontWeight={600}
      >
        {seat.code}
      </text>
      {name && (
        <text x={seat.x} y={seat.y + 0.55} fontSize={0.55} fill={target ? LINK : INK} textAnchor="middle">
          {name.length > 5 ? `${name.slice(0, 5)}…` : name}
        </text>
      )}
    </g>
  );
}
