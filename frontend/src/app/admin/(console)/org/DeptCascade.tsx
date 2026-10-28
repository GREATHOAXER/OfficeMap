"use client";

import { useId } from "react";
import { ChevronRightIcon } from "@/components/icons";
import styles from "./org.module.css";

type Node = { id: number; name: string; parent_id: number | null };

/**
 * 부서 고르기를 계단식으로: 본부 → 부서 → 팀 칸을 차례로 타고 들어간다 (긴 목록을 스크롤하지 않게).
 * 어느 단계든 누른 부서가 고른 부서다. 임원은 본부, 부장은 부서에 속할 수 있어서 팀까지 내려가지 않아도 된다.
 * nodes: 고를 수 있는 부서 (조직도 순서). exclude: 고르면 안 되는 부서 (위 부서 고르기에서 자기와 그 아래)
 */
export default function DeptCascade({
  nodes,
  value,
  onChange,
  label,
  exclude,
}: {
  nodes: Node[];
  value: number | null;
  onChange: (id: number) => void;
  label: string;
  exclude?: Set<number>;
}) {
  const labelId = useId();
  const usable = nodes.filter((n) => !exclude?.has(n.id));
  const byId = new Map(usable.map((n) => [n.id, n]));
  const kids = (parent: number | null) => usable.filter((n) => (n.parent_id ?? null) === parent);
  // 고른 부서까지의 길 (최상위 → 고른 부서)
  const path: Node[] = [];
  for (let n = value !== null ? byId.get(value) : undefined; n; n = n.parent_id !== null ? byId.get(n.parent_id) : undefined)
    path.unshift(n);
  const onPath = new Set(path.map((n) => n.id));
  // 칸: 최상위, 그리고 길 위의 부서마다 아래 부서가 있으면 그 아래 부서들
  const columns: { title: string; items: Node[] }[] = [{ title: "본부", items: kids(null) }];
  for (const n of path) {
    const below = kids(n.id);
    if (below.length) columns.push({ title: `${n.name} 아래`, items: below });
  }

  return (
    <div className={styles.cascadeField}>
      <span id={labelId} className={styles.cascadeLabel}>
        {label}
      </span>
      <p className={styles.cascadePath} aria-live="polite">
        {path.length ? (
          <>
            고른 부서: <strong>{path.map((n) => n.name).join(" › ")}</strong>
          </>
        ) : (
          "부서를 고르세요"
        )}
      </p>
      <div className={styles.cascade} role="group" aria-labelledby={labelId}>
        {columns.map((col, i) => (
          <div key={i} className={styles.cascadeCol} role="group" aria-label={col.title}>
            <span className={styles.cascadeHead} aria-hidden="true">
              {col.title}
            </span>
            <ul>
              {col.items.map((n) => {
                const more = kids(n.id).length > 0;
                return (
                  <li key={n.id}>
                    <button
                      type="button"
                      className={styles.cascadeItem}
                      aria-pressed={n.id === value}
                      data-on-path={(onPath.has(n.id) && n.id !== value) || undefined}
                      onClick={() => onChange(n.id)}
                    >
                      <span>{n.name}</span>
                      {more && <ChevronRightIcon size={14} />}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
