"use client";

import type { ReactNode } from "react";
import {
  AlignIcon,
  ClipboardIcon,
  DuplicateIcon,
  RotateLeftIcon,
  RotateRightIcon,
  StraightenIcon,
  TidyIcon,
  TrashIcon,
} from "@/components/icons";
import type { PlanElement } from "@/lib/api";
import type { AlignMode } from "@/lib/planGeometry";

const ALIGN: { mode: AlignMode; label: string }[] = [
  { mode: "left", label: "왼쪽" },
  { mode: "hcenter", label: "가로 가운데" },
  { mode: "right", label: "오른쪽" },
  { mode: "top", label: "위" },
  { mode: "vcenter", label: "세로 가운데" },
  { mode: "bottom", label: "아래" },
];

type Props = {
  selected: PlanElement[];
  readOnly: boolean;
  onRotate: (clockwise: boolean) => void;
  /** 선 벽 하나를 가로·세로로 곧게 */
  onStraighten: () => void;
  /** 고른 선 벽 정리 (곧게·끝 잇기) */
  onTidy: () => void;
  onAlign: (mode: AlignMode) => void;
  onDuplicate: () => void;
  onCopy: () => void;
  onDelete: () => void;
};

/** 고른 요소 바로 위에 뜨는 도구 막대: 그 요소로 할 수 있는 것 (단축키는 단추 설명에) */
export default function SelectionToolbar(props: Props) {
  const { selected, readOnly, onRotate, onStraighten, onTidy, onAlign, onDuplicate, onCopy, onDelete } = props;
  const single = selected.length === 1 ? selected[0] : null;
  const lines = selected.filter((e) => e.type === "wall_line").length;
  const desks = selected.some((e) => e.type === "desk_group");
  if (readOnly) {
    return (
      <Btn label="복사 (Ctrl+C) · 다른 층 도면에 붙여 넣기" onClick={onCopy}>
        <ClipboardIcon size={18} />
      </Btn>
    );
  }
  // 책상은 방향(의자)이 돌고, 사각형은 폭·높이가 바뀌고, 선 벽은 가운데를 축으로 돈다
  const what = desks ? "책상 방향" : "90도";
  return (
    <>
      <Btn label={`왼쪽으로 돌리기 · ${what} (Shift+R)`} onClick={() => onRotate(false)}>
        <RotateLeftIcon size={18} />
      </Btn>
      <Btn label={`오른쪽으로 돌리기 · ${what} (R)`} onClick={() => onRotate(true)}>
        <RotateRightIcon size={18} />
      </Btn>
      {single?.type === "wall_line" && (
        <Btn label="가로·세로로 곧게" onClick={onStraighten}>
          <StraightenIcon size={18} />
        </Btn>
      )}
      {lines >= 2 && (
        <Btn label="고른 선 정리 (곧게 펴고 끝 잇기)…" onClick={onTidy}>
          <TidyIcon size={18} />
        </Btn>
      )}
      {selected.length > 1 && (
        <>
          <hr />
          {ALIGN.map((a) => (
            <Btn key={a.mode} label={`${a.label} 맞추기`} onClick={() => onAlign(a.mode)}>
              <AlignIcon mode={a.mode} size={18} />
            </Btn>
          ))}
        </>
      )}
      <hr />
      <Btn label="복제 (Ctrl+D)" onClick={onDuplicate}>
        <DuplicateIcon size={18} />
      </Btn>
      <Btn label="복사 (Ctrl+C) · 다른 층 도면에 붙여 넣기" onClick={onCopy}>
        <ClipboardIcon size={18} />
      </Btn>
      <Btn label="지우기 (Delete)" onClick={onDelete} tone="danger">
        <TrashIcon size={18} />
      </Btn>
    </>
  );
}

function Btn({
  label,
  onClick,
  tone,
  children,
}: {
  label: string;
  onClick: () => void;
  tone?: "danger";
  children: ReactNode;
}) {
  return (
    <button type="button" aria-label={label} title={label} data-tone={tone} onClick={onClick}>
      {children}
    </button>
  );
}
