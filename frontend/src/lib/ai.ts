// AI 도우미 (서버: server/app/routers/ai.py, server/app/assistant.py)
// 질문 하나를 POST /api/ai/chat 으로 보내면 답을 SSE로 조금씩 받는다: 글 조각(text), 도구를 쓰는 중(tool),
// 예약 제안(proposal), 오류(error), 끝(done). 예약 제안은 사람이 눌러야 예약된다.

import type { EmployeeHit } from "./api";

export type AiStatus =
  | { enabled: true; provider: string; label: string; model: string }
  | { enabled: false; reason: "OFF" | "UNKNOWN_PROVIDER" | "NO_KEY" };

/** AI가 고른 예약 후보 (아직 예약 안 됨) */
export type AiProposal = {
  id: string;
  room: {
    id: number;
    name: string;
    capacity: number;
    equipment: string[];
    floor: { id: number; name: string };
    site: { id: number; name: string };
  };
  date: string;
  start_min: number;
  end_min: number;
  title: string;
  attendees: EmployeeHit[]; // 예약하는 사람은 빼고
  warnings: string[];
};

export type AiEvent =
  | { type: "start"; conversation_id: number }
  | { type: "text"; text: string }
  | { type: "tool"; name: string; label: string }
  | ({ type: "proposal" } & AiProposal)
  | { type: "error"; code: string; message: string }
  | { type: "done" };

export type AiTurn = { role: "user" | "assistant"; text: string; proposals: AiProposal[] };

export type ChatRequest = {
  message: string;
  conversation_id?: number | null;
  source?: "PANEL" | "ROOMS";
  site_id?: number;
  date?: string;
};

/** 보내기 전에 서버가 거절한 이유 (HTTP 오류) → 화면에 보여 줄 말 */
const REJECTED: Record<string, string> = {
  AI_OFF: "AI 도우미가 꺼져 있어요.",
  TOO_MANY: "한 시간에 물을 수 있는 횟수를 넘었어요. 잠시 뒤에 다시 물어봐 주세요.",
  CONVERSATION_FULL: "대화가 길어졌어요. '새 대화'로 다시 시작해 주세요.",
  CONVERSATION_NOT_FOUND: "이전 대화를 찾지 못했어요. 새 대화로 다시 물어봐 주세요.",
  BUSY: "이 대화에 아직 답하는 중이에요 (다른 탭에서 물었나요?). 잠시 뒤에 다시 물어봐 주세요.",
};

export class AiRejected extends Error {
  constructor(
    public code: string,
    public status: number,
  ) {
    super(REJECTED[code] ?? (status === 401 ? "로그인이 끊겼어요." : "AI 도우미에 묻지 못했어요. 잠시 뒤에 다시 해 보세요."));
  }
}

let statusCache: Promise<AiStatus> | null = null;

/** AI를 켰는지 (한 번 읽어 둔다. 실패하면 다음에 다시 읽는다) */
export function fetchAiStatus(): Promise<AiStatus> {
  statusCache ??= fetch("/api/ai/status", { cache: "no-store" })
    .then((res) => (res.ok ? (res.json() as Promise<AiStatus>) : Promise.reject(new Error(String(res.status)))))
    .catch((error) => {
      statusCache = null;
      throw error;
    });
  return statusCache;
}

/** 질문을 보내고 이벤트를 차례로 넘겨준다. 보내기 전에 거절되면 AiRejected */
export async function askAi(request: ChatRequest, onEvent: (event: AiEvent) => void, signal?: AbortSignal) {
  const res = await fetch("/api/ai/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
    signal,
  });
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => null)) as { detail?: { code?: string } } | null;
    throw new AiRejected(body?.detail?.code ?? "", res.status);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let end = buffer.indexOf("\n\n");
    while (end >= 0) {
      const chunk = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      for (const line of chunk.split("\n")) {
        if (line.startsWith("data: ")) onEvent(JSON.parse(line.slice(6)) as AiEvent);
      }
      end = buffer.indexOf("\n\n");
    }
  }
}

export async function fetchConversation(id: number): Promise<{ id: number; full: boolean; messages: AiTurn[] } | null> {
  const res = await fetch(`/api/ai/conversations/${id}`, { cache: "no-store" });
  return res.ok ? res.json() : null;
}
