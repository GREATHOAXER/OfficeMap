// 로그인 화면 왼쪽의 장식용 평면도 그림 (디자인의 "[서비스 소개 이미지 · 도면 일러스트]" 자리)
// 팀 구역 색과 재실 표시(채운 원 = 방문 가능, 링 = 방해 금지, 회색 네모 = 회의 중, 점선 = 부재)를 그대로 쓴다

type Status = "ok" | "dnd" | "mtg" | "off";

const ZONES = [
  { x: 24, y: 24, w: 132, h: 96, color: "var(--t1)" },
  { x: 168, y: 24, w: 156, h: 96, color: "var(--t2)" },
  { x: 24, y: 132, w: 300, h: 100, color: "var(--t4)" },
];

const SEATS: { x: number; y: number; s: Status }[] = [
  // 위 왼쪽 구역 2×3
  ...[0, 1, 2].flatMap((c) => [
    { x: 44 + c * 36, y: 48, s: (["ok", "dnd", "ok"] as const)[c] },
    { x: 44 + c * 36, y: 84, s: (["off", "ok", "mtg"] as const)[c] },
  ]),
  // 위 오른쪽 구역 2×4
  ...[0, 1, 2, 3].flatMap((c) => [
    { x: 188 + c * 34, y: 48, s: (["ok", "ok", "mtg", "ok"] as const)[c] },
    { x: 188 + c * 34, y: 84, s: (["dnd", "off", "ok", "ok"] as const)[c] },
  ]),
  // 아래 구역 2×8
  ...[0, 1, 2, 3, 4, 5, 6, 7].flatMap((c) => [
    { x: 46 + c * 36, y: 158, s: (["ok", "mtg", "ok", "ok", "off", "ok", "dnd", "ok"] as const)[c] },
    { x: 46 + c * 36, y: 200, s: (["ok", "ok", "dnd", "off", "ok", "mtg", "ok", "ok"] as const)[c] },
  ]),
];

export default function FloorIllustration({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 480 256" className={className} aria-hidden="true" focusable="false">
      <rect x="8" y="8" width="464" height="240" rx="6" fill="none" stroke="#6e6e69" strokeWidth="1.5" />
      {ZONES.map((z, i) => (
        <rect key={i} x={z.x} y={z.y} width={z.w} height={z.h} rx="4" fill={z.color} fillOpacity="0.28" stroke={z.color} strokeWidth="1.5" />
      ))}
      {/* 회의실 */}
      <rect x="340" y="24" width="116" height="96" rx="4" fill="none" stroke="#6e6e69" strokeDasharray="4 4" />
      <rect x="370" y="56" width="56" height="32" rx="16" fill="none" stroke="#a8a8a3" />
      {/* 코어(EV·계단) */}
      <rect x="340" y="132" width="116" height="100" rx="4" fill="#2a2a29" stroke="#6e6e69" />
      {SEATS.map((seat, i) => (
        <Seat key={i} {...seat} />
      ))}
    </svg>
  );
}

function Seat({ x, y, s }: { x: number; y: number; s: Status }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect x="-12" y="-10" width="24" height="20" rx="3" fill="#2a2a29" stroke="#6e6e69" />
      {s === "ok" && <circle r="4.5" fill="#f4f4f2" />}
      {s === "dnd" && (
        <>
          <circle r="4" fill="none" stroke="#f4f4f2" strokeWidth="1.5" />
          <path d="M-4 0h8" stroke="#f4f4f2" strokeWidth="1.5" />
        </>
      )}
      {s === "mtg" && <rect x="-4" y="-4" width="8" height="8" rx="1.5" fill="#8a8a85" />}
      {s === "off" && <circle r="4" fill="none" stroke="#a8a8a3" strokeDasharray="2 2" />}
    </g>
  );
}
