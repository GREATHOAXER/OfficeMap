"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDownIcon, CloseIcon } from "@/components/icons";
import type { MyPresenceInfo } from "@/lib/api";
import { PRESENCE_LABEL } from "@/lib/presence";
import PresenceForm from "./PresenceForm";
import styles from "./office.module.css";

// 머리글의 "내 상태" 버튼과, 눌렀을 때 뜨는 상태 바꾸기 패널.
// 저장하면 서버 데이터를 다시 읽어서 도면의 내 자리 표시도 같이 바뀐다
export default function MyStatus({ info }: { info: MyPresenceInfo }) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);

  // 열면 고른 상태로, 닫으면 버튼으로 포커스를 옮긴다
  useEffect(() => {
    if (open) panelRef.current?.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.focus();
    else if (wasOpen.current) buttonRef.current?.focus();
    wasOpen.current = open;
  }, [open]);

  // 패널 밖을 누르면 닫는다 (자동 로그아웃 알림의 "계속 사용"을 누른 것은 빼고: 고르던 상태가 날아가지 않게)
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Element;
      if (!boxRef.current?.contains(target) && !target.closest?.("[role=alertdialog]")) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const current = info.presence?.status;

  return (
    <div
      ref={boxRef}
      className={styles.myStatus}
      onKeyDown={(event) => {
        if (event.key === "Escape") setOpen(false);
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        className={styles.myStatusButton}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="my-status-panel"
        onClick={() => setOpen((v) => !v)}
      >
        <span className={styles.myStatusCaption}>내 상태</span>
        {current && <span className="mk" data-status={current} aria-hidden="true" />}
        <strong>{current ? PRESENCE_LABEL[current] : "상태 정하기"}</strong>
        <ChevronDownIcon size={16} />
      </button>

      {/* 휴대폰: 아래에서 올라오는 시트 뒤를 어둡게 (누르면 닫힌다) */}
      {open && <div className={styles.statusBackdrop} aria-hidden="true" onClick={() => setOpen(false)} />}
      {open && (
        <div
          ref={panelRef}
          id="my-status-panel"
          role="dialog"
          aria-labelledby="my-status-title"
          className={styles.statusPanel}
        >
          <button type="button" className={styles.cardClose} aria-label="닫기" onClick={() => setOpen(false)}>
            <CloseIcon size={18} />
          </button>
          {/* 열 때마다 새로 그려서 지금 상태로 채운다 */}
          <PresenceForm
            info={info}
            heading="내 재실 상태"
            headingId="my-status-title"
            onSaved={() => setOpen(false)}
          />
        </div>
      )}
    </div>
  );
}
