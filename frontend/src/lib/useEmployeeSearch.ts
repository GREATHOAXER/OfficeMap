import { useEffect, useState } from "react";
import type { EmployeeHit, TeamHit } from "./api";

const DEBOUNCE_MS = 200;

/** 회의 시간을 같이 넘기면 그 시간에 겹치는 회의·휴가도 알려 준다 */
export type SearchWhen = { date: string; start_min: number; end_min: number };

type Loaded<T> = { url: string; data: T | null; failed: boolean };

/**
 * 입력이 멈추고 0.2초 뒤에 url을 읽는다. url이 null이면 읽지 않는다.
 * 지금 url에 대한 결과가 아직 없으면 loading이 true다.
 */
function useDebouncedJson<T>(url: string | null) {
  const [loaded, setLoaded] = useState<Loaded<T>>({ url: "", data: null, failed: false });

  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error(String(res.status));
        setLoaded({ url, data: (await res.json()) as T, failed: false });
      } catch {
        if (!controller.signal.aborted) setLoaded({ url, data: null, failed: true });
      }
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [url]);

  const current = url !== null && loaded.url === url;
  return { data: current ? loaded.data : null, loading: url !== null && !current, failed: current && loaded.failed };
}

/** 직원 검색: 이름·사번, 또는 부서(본부)·팀 이름 (/api/employees/search) */
export function useEmployeeSearch(query: string, when?: SearchWhen | null, limit = 20, enabled = true) {
  const q = query.trim();
  const params = new URLSearchParams({ q, limit: String(limit) });
  if (when) {
    params.set("date", when.date);
    params.set("start_min", String(when.start_min));
    params.set("end_min", String(when.end_min));
  }
  const { data, loading, failed } = useDebouncedJson<{ results: EmployeeHit[] }>(
    enabled && q ? `/api/employees/search?${params}` : null,
  );
  return { results: data?.results ?? [], loading, failed };
}

/** 팀·본부 검색 (/api/employees/teams). 빈 문자열이면 전부 */
export function useTeamSearch(query: string, enabled: boolean) {
  const { data, loading, failed } = useDebouncedJson<{ teams: TeamHit[] }>(
    enabled ? `/api/employees/teams?${new URLSearchParams({ q: query.trim() })}` : null,
  );
  return { teams: data?.teams ?? [], loading, failed };
}
