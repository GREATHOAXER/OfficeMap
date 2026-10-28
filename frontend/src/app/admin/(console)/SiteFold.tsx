"use client";

import { type MouseEvent, type ReactNode, useSyncExternalStore } from "react";
import { ChevronDownIcon } from "@/components/icons";
import styles from "./SiteFold.module.css";

// 펼친 사업장을 이 브라우저에 기억한다: 도면 편집 등 다른 화면에 갔다 돌아와도 직전에 펼쳐 둔 그대로
const STORE_PREFIX = "officemap:fold:";
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
function readFold(id: string): "1" | "0" | null {
  try {
    const v = localStorage.getItem(STORE_PREFIX + id);
    return v === "1" || v === "0" ? v : null;
  } catch {
    return null; // 저장소를 못 쓰는 브라우저(개인 정보 보호 모드 등)는 기본값으로
  }
}
function writeFold(id: string, open: boolean) {
  try {
    localStorage.setItem(STORE_PREFIX + id, open ? "1" : "0");
  } catch {
    // 못 쓰면 이번 화면에서만
  }
  listeners.forEach((fn) => fn());
}

/**
 * 사업장 하나를 접었다 펼친다 (관리자 첫 화면, 도면 편집 첫 화면). 사업장 이름을 누르면 그 사업장의 층이 펼쳐진다.
 * 처음에는 사업장이 여럿이면 접힌 채로, 하나뿐이면 펼친 채로 시작하고(defaultOpen), 그 뒤로는 마지막에 둔 상태로 연다.
 * head: 이름 옆에 붙는 것 (주소·숫자·사업장 수정 단추 등). 머리줄의 빈 곳을 눌러도 펼쳐지고, 그 안의 단추·링크는 제 할 일만 한다
 */
export default function SiteFold({
  id,
  title,
  head,
  defaultOpen,
  className,
  headClassName,
  children,
}: {
  id: string;
  title: ReactNode;
  head?: ReactNode;
  defaultOpen: boolean;
  className?: string;
  headClassName?: string;
  children: ReactNode;
}) {
  // 서버에서 그릴 때는 기본값, 브라우저에서는 기억한 값 (useSyncExternalStore가 둘을 맞춰 준다)
  const stored = useSyncExternalStore(
    subscribe,
    () => readFold(id),
    () => null,
  );
  const open = stored === null ? defaultOpen : stored === "1";
  const toggle = () => writeFold(id, !open);

  function onHeadClick(event: MouseEvent) {
    // 이름 단추는 스스로, 다른 단추·링크·팝업은 제 할 일만 (React 트리로 올라오는 팝업 안 클릭도 거른다)
    if ((event.target as Element).closest("button, a, input, select, textarea, dialog, [role=dialog]")) return;
    toggle();
  }

  return (
    <section className={`${styles.fold} ${className ?? ""}`} data-open={open} aria-labelledby={`${id}-title`}>
      <div className={`${styles.head} ${headClassName ?? ""}`} onClick={onHeadClick}>
        <h2 id={`${id}-title`} className={styles.title}>
          <button
            type="button"
            className={styles.toggle}
            aria-expanded={open}
            aria-controls={`${id}-body`}
            onClick={toggle}
          >
            <span className={styles.chevron}>
              <ChevronDownIcon size={18} />
            </span>
            {title}
          </button>
        </h2>
        {head}
      </div>
      <div id={`${id}-body`} hidden={!open}>
        {children}
      </div>
    </section>
  );
}
