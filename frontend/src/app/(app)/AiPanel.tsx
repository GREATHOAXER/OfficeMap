"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { CloseIcon, SendIcon, SparkleIcon } from "@/components/icons";
import {
  AiRejected,
  type AiProposal,
  type AiStatus,
  askAi,
  fetchAiStatus,
  fetchConversation,
} from "@/lib/ai";
import { formatShortDay, minToHHMM } from "@/lib/dates";
import { sessionEndUrl } from "@/lib/loginRedirect";
import { reservationErrorText } from "@/lib/rooms";
import { saveDraft } from "./rooms/draftStore";
import { draftFromProposal } from "./rooms/slots";
import styles from "./office.module.css";

// AI 도우미 패널: 사람·자리·재실·회의실을 물으면 서버(server/app/assistant.py)가 회사 데이터를 찾아 답한다.
// 예약은 하지 않고 후보 카드를 보여 준다. 카드의 "예약하기"를 눌러야 예약된다.

const CONVERSATION_KEY = "officemap.aiConversation"; // 이 탭에서 이어 가는 대화 (패널을 닫았다 열어도 남게)
const NARROW = "(max-width: 720px)"; // 휴대폰: 도면 화면 대신 AI 화면만 (office.module.css .page[data-ai])

const EXAMPLES = [
  "지금 7층에서 비어 있는 회의실 알려줘",
  "재무팀 조시우 대리 지금 자리에 있어?",
  "내일 10시에 6명 회의할 곳 잡아줘",
  "법인카드 정산은 누가 해?",
];

const OFF_TEXT: Record<string, string> = {
  OFF: "관리자가 AI 도우미를 아직 켜지 않았어요.",
  NO_KEY: "AI 서비스 키가 설정되지 않았어요. 관리자에게 알려 주세요.",
  UNKNOWN_PROVIDER: "AI 설정이 잘못됐어요. 관리자에게 알려 주세요.",
};

type Turn = {
  role: "user" | "assistant";
  text: string;
  proposals: AiProposal[];
  working?: string | null; // 답을 만드는 중이면 지금 하는 일
  error?: string | null;
  retry?: string | null; // 연결이 끊겨 답을 못 받았으면 다시 물을 질문 ("다시 묻기" 단추)
};

function storedConversation(): number | null {
  try {
    return Number(sessionStorage.getItem(CONVERSATION_KEY)) || null;
  } catch {
    return null;
  }
}

function storeConversation(id: number | null) {
  try {
    if (id) sessionStorage.setItem(CONVERSATION_KEY, String(id));
    else sessionStorage.removeItem(CONVERSATION_KEY);
  } catch {
    // 저장소가 막혀 있으면(사생활 보호 모드) 패널을 닫으면 대화가 새로 시작된다
  }
}

export default function AiPanel({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const closeRef = useRef<HTMLButtonElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [statusFailed, setStatusFailed] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [conversationId, setConversationId] = useState<number | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  // 열리면 패널 안으로 포커스를 옮기고, AI를 켰는지와 이어 가던 대화를 읽는다
  useEffect(() => {
    closeRef.current?.focus();
    let live = true;
    fetchAiStatus()
      .then((s) => live && setStatus(s))
      .catch(() => live && setStatusFailed(true));
    const id = storedConversation();
    if (id) {
      fetchConversation(id).then((conversation) => {
        if (!live) return;
        if (!conversation || conversation.full) return storeConversation(null);
        setConversationId(conversation.id);
        setTurns(conversation.messages);
      });
    }
    return () => {
      live = false;
      abortRef.current?.abort();
    };
  }, []);

  // 좁은 화면(휴대폰)에서는 도면 화면 대신 이 화면만 보인다 (office.module.css .page[data-ai]): 맨 위부터 보여 준다
  useEffect(() => {
    if (window.matchMedia(NARROW).matches) window.scrollTo(0, 0);
  }, []);

  // 새 글이 붙으면 맨 아래로 (좁은 화면은 대화 칸이 아니라 페이지가 스크롤된다: 입력칸이 보이게)
  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
    if (turns.length && window.matchMedia(NARROW).matches) formRef.current?.scrollIntoView({ block: "end" });
  }, [turns]);

  const enabled = status?.enabled === true;

  function updateLast(update: (turn: Turn) => Turn) {
    setTurns((all) => [...all.slice(0, -1), update(all[all.length - 1])]);
  }

  async function ask(text: string) {
    const question = text.trim();
    if (!question || busy || !enabled) return;
    setInput("");
    setTurns((all) => [
      ...all,
      { role: "user", text: question, proposals: [] },
      { role: "assistant", text: "", proposals: [], working: "생각하고 있어요" },
    ]);
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    // iPhone Safari는 다른 앱으로 옮기거나 화면을 끄면 몇 초 안에 연결을 끊는다: 그래서 끊겼는지 알려 주려고 본다
    let leftPage = document.hidden;
    const onVisibility = () => {
      if (document.hidden) leftPage = true;
    };
    document.addEventListener("visibilitychange", onVisibility);
    try {
      await askAi(
        { message: question, conversation_id: conversationId },
        (event) => {
          switch (event.type) {
            case "start":
              setConversationId(event.conversation_id);
              storeConversation(event.conversation_id);
              break;
            case "text":
              updateLast((t) => ({ ...t, text: t.text + event.text, working: null }));
              break;
            case "tool":
              updateLast((t) => ({ ...t, working: event.label || "확인하고 있어요" }));
              break;
            case "proposal":
              updateLast((t) => ({ ...t, proposals: [...t.proposals, event] }));
              break;
            case "error":
              updateLast((t) => ({ ...t, error: event.message, working: null }));
              break;
            case "done":
              updateLast((t) => ({ ...t, working: null }));
              break;
          }
        },
        controller.signal,
      );
    } catch (error) {
      if (controller.signal.aborted) {
        updateLast((t) => ({ ...t, working: null, error: t.text ? null : "멈췄어요." }));
      } else if (error instanceof AiRejected) {
        if (error.status === 401) {
          router.replace(await sessionEndUrl());
          return;
        }
        if (error.code === "CONVERSATION_FULL" || error.code === "CONVERSATION_NOT_FOUND") {
          setConversationId(null);
          storeConversation(null);
        }
        updateLast((t) => ({ ...t, working: null, error: error.message }));
      } else {
        const why = leftPage
          ? "다른 화면에 가 있는 사이 연결이 끊겨 답을 받지 못했어요."
          : "연결이 끊겨 답을 받지 못했어요.";
        updateLast((t) => ({ ...t, working: null, error: why, retry: question }));
      }
    } finally {
      document.removeEventListener("visibilitychange", onVisibility);
      abortRef.current = null;
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  function startOver() {
    abortRef.current?.abort();
    setTurns([]);
    setConversationId(null);
    storeConversation(null);
    inputRef.current?.focus();
  }

  /** 예약 화면으로 옮겨 폼을 채워서 연다 (시간·참석자를 고쳐서 예약) */
  function openInRooms(p: AiProposal) {
    saveDraft({
      date: p.date,
      siteId: p.room.site.id,
      draft: draftFromProposal(p),
      edit: null,
      notice: "AI 도우미가 고른 내용으로 채웠어요. 확인하고 예약을 확정하세요.",
    });
    router.push(`/rooms?date=${p.date}&site=${p.room.site.id}`);
  }

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
          <p>{enabled ? `Claude · ${status.label}` : status ? "준비 중" : " "}</p>
        </div>
        {turns.length > 0 && (
          <button type="button" className={styles.aiNew} onClick={startOver}>
            새 대화
          </button>
        )}
        <button ref={closeRef} type="button" className={styles.aiClose} aria-label="AI 도우미 닫기" onClick={onClose}>
          <CloseIcon size={18} />
        </button>
      </div>

      {turns.length === 0 ? (
        <div className={styles.aiBody}>
          <div className={styles.aiEmpty}>
            {enabled ? (
              <>
                <strong>무엇을 찾아 드릴까요?</strong>
                <p>사람의 자리·재실 상태, 빈 회의실, 업무 담당자를 찾고 회의할 곳과 시간을 골라 드려요.</p>
                <ul className={styles.aiExamples}>
                  {EXAMPLES.map((example) => (
                    <li key={example}>
                      <button type="button" onClick={() => void ask(example)}>
                        {example}
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <>
                <span className={styles.aiSoon}>준비 중</span>
                <strong>AI 도우미를 아직 쓸 수 없어요</strong>
                <p>
                  {statusFailed
                    ? "AI 도우미 상태를 읽지 못했어요. 잠시 뒤에 다시 열어 주세요."
                    : status && !status.enabled
                      ? OFF_TEXT[status.reason]
                      : "확인하고 있어요…"}
                </p>
                <ul>
                  {EXAMPLES.slice(0, 3).map((example) => (
                    <li key={example}>“{example}”</li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </div>
      ) : (
        <div ref={listRef} className={styles.aiLog} aria-live="polite" aria-busy={busy}>
          {turns.map((turn, i) =>
            turn.role === "user" ? (
              <p key={i} className={styles.aiQuestion}>
                {turn.text}
              </p>
            ) : (
              <div key={i} className={styles.aiAnswer}>
                {turn.text && <p>{turn.text}</p>}
                {turn.proposals.map((p) => (
                  <ProposalCard key={p.id} proposal={p} onEdit={() => openInRooms(p)} />
                ))}
                {turn.working && <p className={styles.aiWorking}>{turn.working}…</p>}
                {turn.error && (
                  <p className={styles.aiError} role="alert">
                    {turn.error}
                  </p>
                )}
                {turn.retry && i === turns.length - 1 && !busy && (
                  <button
                    type="button"
                    className={styles.aiRetry}
                    onClick={() => {
                      // 답을 못 받은 질문과 빈 답을 지우고 같은 질문을 다시 보낸다
                      setTurns((all) => all.slice(0, -2));
                      void ask(turn.retry!);
                    }}
                  >
                    다시 묻기
                  </button>
                )}
              </div>
            ),
          )}
        </div>
      )}

      <form
        ref={formRef}
        className={styles.aiForm}
        onSubmit={(event) => {
          event.preventDefault();
          void ask(input);
        }}
      >
        <label className={styles.aiInput}>
          <span className="visually-hidden">AI에게 질문</span>
          <textarea
            ref={inputRef}
            rows={2}
            maxLength={1000}
            value={input}
            placeholder={enabled ? "예: 김민준·이서연이랑 내일 1시간 회의할 곳" : "아직 질문할 수 없어요"}
            disabled={!enabled}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              // Enter로 보내고 Shift+Enter로 줄바꿈 (한글 조합 중 Enter는 글자 확정이라 보내지 않는다)
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void ask(input);
              }
            }}
          />
        </label>
        {busy ? (
          <button type="button" className={styles.aiStop} onClick={() => abortRef.current?.abort()}>
            멈추기
          </button>
        ) : (
          <button type="submit" className={styles.aiSend} aria-label="보내기" disabled={!enabled || !input.trim()}>
            <SendIcon size={18} />
          </button>
        )}
      </form>
      {enabled && (
        <p className={styles.aiPrivacy}>질문과 답에 필요한 회사 정보(이름·자리·일정)가 {status.label}로 전송돼요.</p>
      )}
    </aside>
  );
}

/** 예약 후보 카드: 바로 예약하거나 예약 화면에서 고친다 */
function ProposalCard({ proposal: p, onEdit }: { proposal: AiProposal; onEdit: () => void }) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "saving" | "done">("idle");
  const [error, setError] = useState<string | null>(null);

  async function book() {
    setState("saving");
    setError(null);
    const res = await fetch("/api/reservations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        room_id: p.room.id,
        date: p.date,
        start_min: p.start_min,
        end_min: p.end_min,
        title: p.title,
        attendees: p.attendees.map((a) => a.emp_no),
        organizer_attends: true,
        repeat: "NONE",
        notify: true,
      }),
    }).catch(() => null);
    if (res?.status === 401) {
      router.replace(await sessionEndUrl());
      return;
    }
    if (res?.ok) {
      setState("done");
      return;
    }
    const body = res ? await res.json().catch(() => null) : null;
    setError(res ? reservationErrorText(body?.detail) : "연결이 끊겨 예약하지 못했어요. 다시 눌러 주세요.");
    setState("idle");
  }

  return (
    <div className={styles.aiProposal} data-done={state === "done" || undefined}>
      <strong>
        {p.room.floor.name} {p.room.name}
        <span> · {p.room.capacity}명</span>
      </strong>
      <span className="mono">
        {formatShortDay(p.date)} {minToHHMM(p.start_min)}–{minToHHMM(p.end_min)}
      </span>
      <span>{p.title}</span>
      <span className={styles.aiProposalPeople}>
        참석: 나{p.attendees.length > 0 && `, ${p.attendees.map((a) => a.name).join(", ")}`}
      </span>
      {p.warnings.length > 0 && (
        <ul className={styles.aiWarnings}>
          {p.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      {state === "done" ? (
        <p className={styles.aiBooked} role="status">
          예약했어요. <Link href="/reservations">내 예약 보기</Link>
        </p>
      ) : (
        <div className={styles.aiProposalActions}>
          <button type="button" className={styles.aiBook} disabled={state === "saving"} onClick={() => void book()}>
            {state === "saving" ? "예약하는 중…" : "예약하기"}
          </button>
          <button type="button" className={styles.aiEdit} onClick={onEdit}>
            예약 화면에서 고치기
          </button>
        </div>
      )}
      {error && (
        <p className={styles.aiError} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
