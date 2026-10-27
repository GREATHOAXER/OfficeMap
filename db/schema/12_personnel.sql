-- 12_personnel.sql
-- 인사이동: 발령 엑셀 한 장(사번·이름·현 부서·새 부서, 직급·직책은 선택)으로 여러 사람의 소속을 한 번에 바꾸고
-- 새 팀 구역의 빈 자리에 자동으로 앉힌다 (server/app/routers/personnel.py).
-- 날짜를 정하면 그날 0시(서울)에 서버 작업이 반영한다. 반영하거나 취소한 것도 지우지 않고 기록으로 남긴다

CREATE TABLE personnel_moves (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    title         varchar(100) NOT NULL,              -- 예: 2026 하반기 정기 인사 (기본은 엑셀 파일 이름)
    -- FAILED: 예약한 날 서버가 반영하다 실패함 (summary.error에 이유, 아무것도 바뀌지 않음)
    status        varchar(10)  NOT NULL CHECK (status IN ('SCHEDULED', 'APPLIED', 'CANCELLED', 'FAILED')),
    -- AUTO: 새 부서 구역의 빈 고정석에 자동 배치 (모자라면 미배치) / UNASSIGN: 모두 미배치로 (좌석 배치 화면에서 직접)
    seat_mode     varchar(10)  NOT NULL CHECK (seat_mode IN ('AUTO', 'UNASSIGN')),
    effective_at  timestamptz  NOT NULL,              -- 반영할(한) 시각. 바로 반영하면 반영한 시각
    created_by    bigint       NOT NULL REFERENCES employees(id),
    created_at    timestamptz  NOT NULL DEFAULT now(),
    applied_at    timestamptz,
    cancelled_by  bigint       REFERENCES employees(id),
    cancelled_at  timestamptz,
    -- 자동 배치로 만든 좌석 배치 묶음 (change_requests.move_group). 좌석 배치 화면의 요청 목록에 "인사이동: 제목"으로 보인다
    move_group    bigint,
    summary       jsonb                               -- 반영 결과 {moved, seated, unseated, skipped}
);
CREATE INDEX personnel_moves_due_idx ON personnel_moves (effective_at) WHERE status = 'SCHEDULED';

-- 발령 1명 = 1행 (엑셀의 한 줄)
CREATE TABLE personnel_move_items (
    id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    move_id            bigint       NOT NULL REFERENCES personnel_moves(id) ON DELETE CASCADE,
    line               integer      NOT NULL,           -- 엑셀 행 번호
    employee_id        bigint       NOT NULL REFERENCES employees(id),
    from_department_id bigint       REFERENCES departments(id),  -- 만들 때(예약이면 예약할 때)의 부서
    to_department_id   bigint       REFERENCES departments(id),  -- NULL: 부서는 그대로 (직급·직책만 바뀜)
    rank_name          varchar(30),                     -- 바꿀 직급 (NULL이면 그대로)
    position_name      varchar(30),                     -- 바꿀 직책 (NULL이면 그대로)
    status             varchar(10)  NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPLIED', 'SKIPPED')),
    -- 반영 결과: 자동 배치한 자리(지워진 좌석이면 비고 seat_label만 남는다), 미배치·건너뛴 이유
    seat_id            bigint       REFERENCES seats(id) ON DELETE SET NULL,
    seat_label         varchar(80),                     -- 예: 서울 본사 7F B-17
    note               varchar(200),
    UNIQUE (move_id, employee_id)
);
CREATE INDEX personnel_move_items_employee_idx ON personnel_move_items (employee_id);
