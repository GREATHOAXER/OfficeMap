"use client";

import { forwardRef } from "react";
import { type DrawingSeat, type DrawingStyle, type FloorDrawing, teamColor } from "@/lib/floorDrawing";
import { DEFAULT_LINE, DESK } from "@/lib/planGeometry";
import { zonePieces, zoneTags } from "@/lib/zoneShape";

// 내보낸 그림에서도 같은 모양이 나오게 글꼴·색을 속성으로 직접 적는다 (CSS를 쓰지 않는다)
const FONT = "-apple-system, 'Apple SD Gothic Neo', 'Malgun Gothic', 'Noto Sans KR', 'Noto Sans CJK KR', sans-serif";
const INK = "#1c1c1c";
const MUTED = "#5e5e5a";
const LINK = "#1d4ed8";
const HEADER_M = 3.2; // 제목 줄 높이 (m)
const FOOTER_M = 2.2; // 축척 줄 높이 (m)
const NICE = [1, 2, 5, 10, 20, 50, 100];
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
  const bottom = title ? FOOTER_M : 0;
  const wallW = DEFAULT_LINE.wall ?? 0.3; // 벽(사각형) 기본 굵기 (m). 화면과 같다
  const k = (s: DrawingStyle) => (s.label_size ?? 100) / 100;
  const bold = (s: DrawingStyle) => (s.label_bold ? 700 : undefined);
  const scale = NICE.find((n) => n / d.width >= 0.08) ?? NICE[NICE.length - 1];
  return (
    <svg
      ref={ref}
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${d.width} ${d.height + top + bottom}`}
      className={className}
      role="img"
      aria-label={label}
      fontFamily={FONT}
    >
      <rect x={0} y={0} width={d.width} height={d.height + top + bottom} fill="#ffffff" />
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
              strokeWidth={s.line ?? 0.07}
              strokeDasharray={HATCHED.has(s.kind) ? undefined : "0.3 0.2"}
            />
            <text
              x={s.x + s.w / 2}
              y={s.y + s.h / 2 + 0.25 * k(s)}
              fontSize={0.7 * k(s)}
              fontWeight={bold(s)}
              fill={MUTED}
              textAnchor="middle"
            >
              {s.label}
            </text>
          </g>
        ))}
        {d.rooms.map((r, i) => (
          <g key={`room-${i}`}>
            <rect x={r.x} y={r.y} width={r.w} height={r.h} fill="#ffffff" stroke={INK} strokeWidth={r.line ?? 0.1} />
            <text
              x={r.x + r.w / 2}
              y={r.y + r.h / 2 + 0.3 * k(r)}
              fontSize={0.8 * k(r)}
              fontWeight={bold(r)}
              fill={INK}
              textAnchor="middle"
            >
              {r.name}
            </text>
          </g>
        ))}
        {d.walls.map((w, i) => {
          // 선 굵기만큼 안쪽으로 그려서 벽 바깥 둘레가 사각형 크기와 같게
          const line = Math.min(w.line ?? wallW, w.w / 2, w.h / 2);
          return (
            <rect
              key={`wall-${i}`}
              x={w.x + line / 2}
              y={w.y + line / 2}
              width={Math.max(w.w - line, 0.01)}
              height={Math.max(w.h - line, 0.01)}
              fill="none"
              stroke={INK}
              strokeWidth={line}
            />
          );
        })}
        {d.lines.map((l, i) => (
          <line
            key={`line-${i}`}
            x1={l.x1}
            y1={l.y1}
            x2={l.x2}
            y2={l.y2}
            stroke={INK}
            strokeWidth={l.line}
            strokeLinecap="square"
          />
        ))}
        {d.entrances.map((e, i) => (
          <g key={`entrance-${i}`}>
            <rect
              x={e.x}
              y={e.y}
              width={e.w}
              height={e.h}
              fill={e.main ? "#e8eefc" : "#ffffff"}
              stroke={LINK}
              strokeWidth={e.line ?? 0.1}
              strokeDasharray={e.main ? undefined : "0.3 0.2"}
            />
            <text
              x={e.x + e.w / 2}
              y={e.y + e.h / 2 + 0.22 * k(e)}
              fontSize={0.6 * k(e)}
              fontWeight={e.main ? 700 : bold(e)}
              fill={LINK}
              textAnchor="middle"
            >
              {e.label}
            </text>
          </g>
        ))}
        {d.pillars.map((p, i) => (
          <rect key={`pillar-${i}`} x={p.x} y={p.y} width={p.w} height={p.h} fill={INK} />
        ))}
        {/* 이름표: 조각마다 그 조각 안에 (화면과 같은 자리, lib/zoneShape.ts zoneTags. 여기 좌표는 m라 크기 1 × 1) */}
        {zoneTags(
          zonePieces(d.zones, (z) => z.rects),
          { width_m: 1, height_m: 1 },
        ).map(({ zone: z, x, y, maxW }, i) => {
          const full = `${z.name} · ${z.code}`;
          const fits = Math.max(1, Math.floor((maxW - 0.6) / 0.62)); // 글자 0.62 m, 양옆 여백 0.3 m
          const text = full.length > fits ? `${full.slice(0, Math.max(1, fits - 1))}…` : full;
          const w = Math.min(text.length * 0.62 + 0.6, maxW);
          return (
            <g key={`tag-${z.id}-${i}`}>
              <rect x={x} y={y} width={w} height={1.05} rx={0.2} fill={teamColor(z.color).line} />
              <text x={x + 0.3} y={y + 0.78} fontSize={0.7} fontWeight={600} fill="#ffffff">
                {text}
              </text>
            </g>
          );
        })}
        {d.seats.map((s) => (
          <SeatMark key={s.id} seat={s} showName={!!showNames} onClick={onSeatClick} title={seatTitle?.(s)} />
        ))}
      </g>
      {title && (
        <g transform={`translate(0.8 ${top + d.height + 0.6})`} aria-label={`축척 ${scale} m`}>
          <path d={`M0 0 V0.7 H${scale} V0`} fill="none" stroke={INK} strokeWidth={0.08} strokeLinejoin="miter" />
          <text x={scale + 0.5} y={0.75} fontSize={0.75} fill={MUTED}>
            {scale} m · 도면 {d.width} × {d.height} m
          </text>
        </g>
      )}
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
  const { w, h } = seat;
  const x = seat.x - w / 2;
  const y = seat.y - h / 2;
  // 세로로 놓인 책상은 글자도 세로로 (책상 긴 쪽을 따라), 책상 크기에 맞춰 글자 크기를 줄이거나 키운다
  const vertical = h > w;
  const long = Math.max(w, h);
  const short = Math.min(w, h);
  const f = Math.min(1.5, Math.max(0.4, Math.min(long / DESK.w, short / DESK.h)));
  const color = teamColor(seat.color);
  const target = seat.state === "target";
  const fill = target
    ? "#eef2ff"
    : seat.state === "flex"
      ? color.fill
      : seat.state === "off"
        ? "url(#floor-hatch)"
        : "#ffffff";
  // 의자 쪽 가장자리에 팀 색 줄
  const chair = {
    0: { x1: x + 0.1, x2: x + w - 0.1, y1: y + h, y2: y + h },
    90: { x1: x + w, x2: x + w, y1: y + 0.1, y2: y + h - 0.1 },
    180: { x1: x + 0.1, x2: x + w - 0.1, y1: y, y2: y },
    270: { x1: x, x2: x, y1: y + 0.1, y2: y + h - 0.1 },
  }[((seat.rotation % 360) + 360) % 360] ?? { x1: x + 0.1, x2: x + w - 0.1, y1: y + h, y2: y + h };
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
      <line {...chair} stroke={color.line} strokeWidth={0.22} />
      <g transform={vertical ? `rotate(-90 ${seat.x} ${seat.y})` : undefined}>
        <text
          x={seat.x}
          y={name ? seat.y - 0.12 * f : seat.y + 0.2 * f}
          fontSize={0.52 * f}
          fill={seat.state === "taken" || target ? INK : MUTED}
          textAnchor="middle"
          fontWeight={600}
        >
          {seat.code}
        </text>
        {name && (
          <text x={seat.x} y={seat.y + 0.55 * f} fontSize={0.55 * f} fill={target ? LINK : INK} textAnchor="middle">
            {name.length > 5 ? `${name.slice(0, 5)}…` : name}
          </text>
        )}
      </g>
    </g>
  );
}
