import type { RoomsDay } from "@/lib/api";
import { addDays } from "@/lib/dates";
import { useDebouncedJson } from "@/lib/useEmployeeSearch";
import type { Draft } from "./slots";

export type Conflict = { id: number; title: string; starts_at: string; ends_at: string; organizer: string; department: string };

/**
 * 여러 날에 걸친 예약을 고르면, 그 기간에 이 회의실에 이미 잡힌 예약을 서버에 물어본다.
 * (하루 안의 예약은 현황표로 빈 시간만 고르게 해서 물어볼 필요가 없다)
 */
export function useConflicts(day: RoomsDay, draft: Draft) {
  const ready = draft.roomId !== null && draft.start !== null && draft.end !== null && draft.endDays > 0;
  const params = ready
    ? new URLSearchParams({
        start_date: day.date,
        start_min: String(draft.start),
        end_date: addDays(day.date, draft.endDays),
        end_min: String(draft.end),
      })
    : null;
  const { data, loading } = useDebouncedJson<{ conflicts: Conflict[] }>(
    params ? `/api/rooms/${draft.roomId}/conflicts?${params}` : null,
  );
  return { conflicts: data?.conflicts ?? [], checking: loading };
}
