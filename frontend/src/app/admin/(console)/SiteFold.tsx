"use client";

import { type MouseEvent, type ReactNode, useState } from "react";
import { ChevronDownIcon } from "@/components/icons";
import styles from "./SiteFold.module.css";

/**
 * 사업장 하나를 접었다 펼친다 (관리자 첫 화면, 도면 편집 첫 화면). 사업장 이름을 누르면 그 사업장의 층이 펼쳐진다.
 * 사업장이 여럿이면 접힌 채로 시작해 한눈에 사업장만 보이고, 하나뿐이면 펼친 채로 시작한다(defaultOpen).
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
  const [open, setOpen] = useState(defaultOpen);

  function onHeadClick(event: MouseEvent) {
    // 이름 단추는 스스로, 다른 단추·링크·팝업은 제 할 일만 (React 트리로 올라오는 팝업 안 클릭도 거른다)
    if ((event.target as Element).closest("button, a, input, select, textarea, dialog, [role=dialog]")) return;
    setOpen((v) => !v);
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
            onClick={() => setOpen((v) => !v)}
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
