"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDownIcon } from "@/components/icons";
import type { MyPresence } from "@/lib/api";
import { PRESENCE_LABEL } from "@/lib/presence";
import PresenceForm from "./PresenceForm";
import styles from "./office.module.css";

// 머리글의 "내 상태" 버튼과, 눌렀을 때 뜨는 상태 바꾸기 패널.
// 저장하면 서버 데이터를 다시 읽어서 도면의 내 자리 표시도 같이 바뀐다
export default function MyStatus({ presence }: { presence: MyPresence }) {
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

  // 패널 밖을 누르면 닫는다
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const current = presence?.status;

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
        <strong>{current ? PRESENCE_LABEL[current] : "정하지 않음"}</strong>
        <ChevronDownIcon size={16} />
      </button>

      {open && (
        <div
          ref={panelRef}
          id="my-status-panel"
          role="dialog"
          aria-labelledby="my-status-title"
          className={styles.statusPanel}
        >
          {/* 열 때마다 새로 그려서 지금 상태로 채운다 */}
          <PresenceForm
            presence={presence}
            heading="내 재실 상태"
            headingId="my-status-title"
            onSaved={() => setOpen(false)}
          />
        </div>
      )}
    </div>
  );
}
