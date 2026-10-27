"use client";

import { useEffect, useState } from "react";
import { copyText } from "@/lib/clipboard";

/** 누르면 text를 복사하고 잠깐 결과를 보여 준다 (http로 연 서버·iPhone에서도: lib/clipboard.ts) */
export default function CopyButton({ text, className }: { text: string; className?: string }) {
  const [result, setResult] = useState<"copied" | "failed" | null>(null);
  useEffect(() => {
    if (!result) return;
    const timer = setTimeout(() => setResult(null), 2500);
    return () => clearTimeout(timer);
  }, [result]);
  return (
    <button
      type="button"
      className={className}
      onClick={(event) => void copyText(text, event.currentTarget).then((ok) => setResult(ok ? "copied" : "failed"))}
    >
      {result === "copied" ? "복사했어요" : result === "failed" ? "길게 눌러 직접 복사하세요" : "복사"}
    </button>
  );
}
