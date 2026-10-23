import { useEffect, useState } from "react";
import type { EmployeeHit } from "./api";

const DEBOUNCE_MS = 200;

/** 회의 시간을 같이 넘기면 그 시간에 겹치는 회의·휴가도 알려 준다 */
export type SearchWhen = { date: string; start_min: number; end_min: number };

type Result = { key: string; results: EmployeeHit[]; failed: boolean };

/**
 * 직원 이름·팀·사번 검색 (/api/employees/search). 입력이 멈추고 0.2초 뒤에 찾는다.
 * 지금 입력에 대한 결과가 아직 없으면 loading이 true다.
 */
export function useEmployeeSearch(query: string, when?: SearchWhen | null, limit = 20) {
  const q = query.trim();
  const params = new URLSearchParams({ q, limit: String(limit) });
  if (when) {
    params.set("date", when.date);
    params.set("start_min", String(when.start_min));
    params.set("end_min", String(when.end_min));
  }
  const key = q ? params.toString() : "";
  const [result, setResult] = useState<Result>({ key: "", results: [], failed: false });

  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/employees/search?${key}`, { signal: controller.signal });
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as { results: EmployeeHit[] };
        setResult({ key, results: data.results, failed: false });
      } catch {
        if (!controller.signal.aborted) setResult({ key, results: [], failed: true });
      }
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [key]);

  const current = key !== "" && result.key === key;
  return {
    results: current ? result.results : [],
    loading: key !== "" && !current,
    failed: current && result.failed,
  };
}
