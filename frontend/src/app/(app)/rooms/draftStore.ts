import type { Draft } from "./slots";

// 예약을 확정하려는데 로그인이 끊겼을 때 쓰던 내용을 잠깐 맡아 둔다. 다시 로그인하고 돌아오면 폼을 그대로 채운다.
// 이 탭에서만(sessionStorage), 30분 안에 돌아왔을 때만 쓴다. 저장소가 막혀 있으면(사생활 보호 모드 등) 조용히 넘어간다

const KEY = "officemap.roomsDraft";
const KEEP_MS = 30 * 60_000;

export type SavedDraft = {
  date: string; // 보던 날 (예약 시작 날짜)
  siteId: number;
  draft: Draft;
  /** 고치던 예약 (새 예약이면 null)과 그 예약을 읽었을 때의 updated_at */
  edit: { id: number; title: string; updatedAt: string; series?: boolean } | null;
  savedAt: number;
};

export function saveDraft(saved: Omit<SavedDraft, "savedAt">) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ ...saved, savedAt: Date.now() }));
  } catch {
    // 무시
  }
}

/** 맡겨 둔 내용을 꺼낸다 (한 번 꺼내면 지운다) */
export function takeDraft(): SavedDraft | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    sessionStorage.removeItem(KEY);
    const saved = JSON.parse(raw) as SavedDraft;
    return Date.now() - saved.savedAt < KEEP_MS ? saved : null;
  } catch {
    return null;
  }
}
