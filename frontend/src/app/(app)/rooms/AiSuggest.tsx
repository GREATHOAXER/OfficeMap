"use client";

import { useEffect, useRef, useState } from "react";
import { SparkleIcon } from "@/components/icons";
import { AiRejected, type AiProposal, type AiStatus, askAi, fetchAiStatus } from "@/lib/ai";
import type { RoomsDay } from "@/lib/api";
import { formatShortDay, minToHHMM } from "@/lib/dates";
import styles from "./rooms.module.css";

/**
 * 예약 폼의 "AI 추천": 조건을 말하면(예: "김민준·이서연이랑 오늘 1시간 회의") 참석자 일정과 빈 회의실을 보고
 * 후보를 몇 개 보여 준다. 후보를 누르면 폼(회의실·시간·참석자, 비어 있으면 제목)을 채운다. 예약은 폼에서 확정한다.
 */
export default function AiSuggest({ day, onPick }: { day: RoomsDay; onPick: (proposal: AiProposal) => void }) {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [proposals, setProposals] = useState<AiProposal[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const conversation = useRef<number | null>(null); // 폼을 연 동안은 이어서 묻는다 ("다른 시간은?")
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let live = true;
    fetchAiStatus()
      .then((s) => live && setStatus(s))
      .catch(() => live && setStatus({ enabled: false, reason: "OFF" }));
    return () => {
      live = false;
      abortRef.current?.abort();
    };
  }, []);

  const enabled = status?.enabled === true;

  async function ask() {
    const question = input.trim();
    if (!question || busy || !enabled) return;
    setBusy(true);
    setWorking("생각하고 있어요");
    setAnswer("");
    setError(null);
    setProposals([]);
    setPicked(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await askAi(
        {
          message: question,
          conversation_id: conversation.current,
          source: "ROOMS",
          site_id: day.site.id,
          date: day.date,
        },
        (event) => {
          if (event.type === "start") conversation.current = event.conversation_id;
          else if (event.type === "text") {
            setAnswer((a) => a + event.text);
            setWorking(null);
          } else if (event.type === "tool") setWorking(event.label || "확인하고 있어요");
          else if (event.type === "proposal") setProposals((all) => [...all, event]);
          else if (event.type === "error") setError(event.message);
        },
        controller.signal,
      );
    } catch (e) {
      if (!controller.signal.aborted) {
        if (e instanceof AiRejected && (e.code === "CONVERSATION_FULL" || e.code === "CONVERSATION_NOT_FOUND")) {
          conversation.current = null;
        }
        setError(e instanceof AiRejected ? e.message : "연결이 끊겼어요. 다시 해 보세요.");
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
      setWorking(null);
    }
  }

  return (
    <section className={styles.ai} aria-labelledby="ai-suggest-title" aria-busy={busy}>
      <div id="ai-suggest-title" className={styles.aiHead}>
        <SparkleIcon size={14} /> AI 추천
        {status && !enabled && <span className={styles.soon}>준비 중</span>}
      </div>
      <div className={styles.aiField}>
        <label>
          <span className="visually-hidden">AI에게 회의 조건 말하기</span>
          <input
            value={input}
            maxLength={1000}
            placeholder="예: 김민준·이서연이랑 오늘 1시간 회의"
            disabled={!enabled}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              // 이 칸은 예약 폼 안에 있어서 Enter가 예약 확정으로 가지 않게 막고 추천을 묻는다
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void ask();
              }
            }}
          />
        </label>
        <button type="button" className={styles.aiAsk} disabled={!enabled || busy || !input.trim()} onClick={() => void ask()}>
          {busy ? "찾는 중…" : "찾기"}
        </button>
      </div>
      {!enabled && (
        <p className={styles.aiNote}>
          {status ? "관리자가 AI 도우미를 켜면 참석자 일정과 빈 회의실을 보고 시간을 골라 드려요." : "확인하고 있어요…"}
        </p>
      )}
      <div aria-live="polite">
        {working && <p className={styles.aiNote}>{working}…</p>}
        {answer && <p className={styles.aiAnswer}>{answer}</p>}
        {error && (
          <p className={styles.aiError} role="alert">
            {error}
          </p>
        )}
      </div>
      {proposals.length > 0 && (
        <ul className={styles.aiPicks}>
          {proposals.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                aria-pressed={picked === p.id}
                onClick={() => {
                  setPicked(p.id);
                  onPick(p);
                }}
              >
                <strong>
                  {p.room.floor.name} {p.room.name}
                </strong>
                <span className="mono">
                  {formatShortDay(p.date)} {minToHHMM(p.start_min)}–{minToHHMM(p.end_min)}
                </span>
                {p.attendees.length > 0 && <span>{p.attendees.map((a) => a.name).join(", ")}</span>}
                {p.warnings.map((w) => (
                  <span key={w} className={styles.aiWarn}>
                    {w}
                  </span>
                ))}
                <em>{picked === p.id ? "폼에 채웠어요" : "이걸로 채우기"}</em>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
