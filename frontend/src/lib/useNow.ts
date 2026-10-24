import { useSyncExternalStore } from "react";

// 1분마다 바뀌는 지금 시각(ms). "5분 전 변경" 같은 글에 쓴다.
// 서버에서 그릴 때는 0이라 그런 글은 브라우저에서만 보인다 (서버와 브라우저 시각이 달라 생기는 불일치를 피한다)
let now = 0;
let timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!timer) {
    timer = setInterval(() => {
      now = Date.now();
      listeners.forEach((l) => l());
    }, 60_000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

function getSnapshot() {
  if (!now) now = Date.now();
  return now;
}

export function useNow(): number {
  return useSyncExternalStore(subscribe, getSnapshot, () => 0);
}
