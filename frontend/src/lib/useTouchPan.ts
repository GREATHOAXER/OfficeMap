import { type PointerEvent, type RefObject, useRef } from "react";

type Point = { x: number; y: number };

/**
 * 손가락 두 개로 스크롤 영역을 민다. 도면 편집처럼 한 손가락으로 그리고 옮기느라 touch-action: none을 건 곳은
 * 휴대폰에서 화면을 밀 방법이 없어서다. 두 번째 손가락이 닿으면 하던 일을 그만두고(onStart) 손가락들의 가운데를 따라
 * 밀고, 손가락을 다 뗄 때까지 민다 (한 손가락만 남아도 이어서). 확대·축소는 Safari gesture* 이벤트나 +/− 단추로.
 * 핸들러는 처리했으면 true: 그 이벤트는 그리기·옮기기에 넘기지 않는다
 */
export function useTouchPan(scrollRef: RefObject<HTMLElement | null>, onStart: () => void) {
  const points = useRef(new Map<number, Point>());
  const last = useRef<Point | null>(null); // 미는 중이면 지난번 가운데

  function center(): Point {
    let x = 0;
    let y = 0;
    for (const p of points.current.values()) {
      x += p.x;
      y += p.y;
    }
    return { x: x / points.current.size, y: y / points.current.size };
  }

  return {
    down(event: PointerEvent): boolean {
      if (event.pointerType !== "touch") return false;
      points.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (!last.current && points.current.size < 2) return false;
      if (!last.current) onStart();
      last.current = center();
      return true;
    },
    move(event: PointerEvent): boolean {
      if (event.pointerType !== "touch" || !points.current.has(event.pointerId)) return false;
      points.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (!last.current) return false;
      const c = center();
      const el = scrollRef.current;
      if (el) {
        el.scrollLeft -= c.x - last.current.x;
        el.scrollTop -= c.y - last.current.y;
      }
      last.current = c;
      return true;
    },
    up(event: PointerEvent): boolean {
      if (event.pointerType !== "touch") return false;
      points.current.delete(event.pointerId);
      if (!last.current) return false;
      // 손가락 수가 바뀌면 가운데가 튀지 않게 새 가운데부터 민다
      last.current = points.current.size ? center() : null;
      return true;
    },
  };
}
