"use client";

import { useEffect, useRef } from "react";
import { CloseIcon, SendIcon, SparkleIcon } from "@/components/icons";
import styles from "./office.module.css";

// AI 도우미 패널. 지금은 틀만 있고 대화 내용은 비어 있다 (다음 단계에서 연결)
export default function AiPanel({ onClose }: { onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);

  // 열리면 패널 안으로 포커스를 옮긴다
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  return (
    <aside
      id="ai-panel"
      className={styles.ai}
      aria-labelledby="ai-title"
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <div className={styles.aiHead}>
        <span className={styles.aiIcon}>
          <SparkleIcon size={18} />
        </span>
        <div>
          <h2 id="ai-title">AI 도우미</h2>
          <p>사내 구축 모델 · 외부 전송 없음</p>
        </div>
        <button ref={closeRef} type="button" className={styles.aiClose} aria-label="AI 도우미 닫기" onClick={onClose}>
          <CloseIcon size={18} />
        </button>
      </div>

      <div className={styles.aiBody}>
        <div className={styles.aiEmpty}>
          <span className={styles.aiSoon}>준비 중</span>
          <strong>AI 도우미는 아직 준비 중이에요</strong>
          <p>다음 단계에서 이런 질문에 답하게 됩니다. 사내 구축 모델을 쓰고, 질문은 외부로 보내지 않아요.</p>
          <ul>
            <li>“지금 7층에서 비어 있는 회의실 알려줘”</li>
            <li>“재무팀 조시우 대리 지금 자리에 있어?”</li>
            <li>“내일 10시에 6명 회의할 곳 잡아줘”</li>
          </ul>
        </div>
      </div>

      <form className={styles.aiForm} onSubmit={(event) => event.preventDefault()}>
        <label className={styles.aiInput}>
          <span className="visually-hidden">AI에게 질문</span>
          <textarea rows={2} placeholder="준비 중이라 아직 질문할 수 없어요" disabled />
        </label>
        <button type="submit" className={styles.aiSend} aria-label="보내기" disabled>
          <SendIcon size={18} />
        </button>
      </form>
    </aside>
  );
}
