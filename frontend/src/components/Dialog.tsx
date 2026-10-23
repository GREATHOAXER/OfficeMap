"use client";

import { type ReactNode, useEffect, useId, useRef } from "react";
import { CloseIcon } from "./icons";
import styles from "./Dialog.module.css";

type Props = {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** wide: 예약 폼처럼 넓은 화면에서 두 단으로 펼치는 팝업, narrow: 상세 보기 */
  size?: "wide" | "narrow";
  children: ReactNode;
  footer?: ReactNode;
};

/**
 * 팝업. 브라우저 기본 dialog라 포커스 가두기·Esc 닫기·뒤 화면 막기가 된다.
 * 폭은 화면에 맞춰 줄었다 늘었다 하고, 휴대폰에서는 화면 아래에서 올라오는 시트가 된다.
 */
export default function Dialog({ open, onClose, title, size = "narrow", children, footer }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      data-size={size}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose(); // 바깥 어두운 곳을 누르면 닫는다
      }}
    >
      <header className={styles.head}>
        <h2 id={titleId}>{title}</h2>
        <button type="button" className={styles.close} aria-label="닫기" onClick={onClose}>
          <CloseIcon size={20} />
        </button>
      </header>
      <div className={styles.body}>{children}</div>
      {footer && <footer className={styles.foot}>{footer}</footer>}
    </dialog>
  );
}
