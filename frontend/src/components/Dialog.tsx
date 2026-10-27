"use client";

import { type ReactNode, useEffect, useId, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { CloseIcon } from "./icons";
import styles from "./Dialog.module.css";

type Props = {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** wide: 예약 폼처럼 넓은 화면에서 두 단으로 펼치는 팝업, narrow: 상세 보기, full: 화면 가득 (도면 파일 가져오기) */
  size?: "wide" | "narrow" | "full";
  children: ReactNode;
  footer?: ReactNode;
};

const noSubscribe = () => () => {};

/**
 * 팝업. 브라우저 기본 dialog라 포커스 가두기·Esc 닫기·뒤 화면 막기가 된다.
 * 폭은 화면에 맞춰 줄었다 늘었다 하고, 휴대폰에서는 화면 아래에서 올라오는 시트가 된다.
 * 문서 맨 끝(body)에 그린다: 표의 "편집" 칸처럼 연 곳의 글자 정렬·줄바꿈을 물려받지 않게.
 * React 이벤트는 그대로 연 곳의 부모로 전해진다
 */
export default function Dialog({ open, onClose, title, size = "narrow", children, footer }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  // 서버와 첫 화면(하이드레이션)에서는 그리지 않고, 브라우저에서만 body에 그린다
  const inBrowser = useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false,
  );

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      // 기본은 첫 버튼(닫기)에 포커스가 간다. 안에서 data-autofocus로 표시한 칸이 있으면 그리로
      dialog.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    }
    if (!open && dialog.open) dialog.close();
  }, [open, inBrowser]);

  if (!inBrowser) return null;
  return createPortal(
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
    </dialog>,
    document.body,
  );
}
