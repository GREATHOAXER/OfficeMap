-- 04_seating.sql
-- 좌석 배정과 배치 변경 요청·승인

CREATE EXTENSION IF NOT EXISTS btree_gist;  -- 배정 기간 겹침 방지(EXCLUDE)에 필요

-- 배치 변경 요청: 구역 관리자가 만든 변경 묶음
-- "층 관리자 승인 후 반영" 권한을 가진 구역 관리자가 쓴다. 작성 중(DRAFT) 상태가 곧 자동 저장된 미반영 변경
CREATE TABLE change_requests (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    floor_id       bigint      NOT NULL REFERENCES floors(id),
    zone_id        bigint REFERENCES zones(id),
    request_type   varchar(20) NOT NULL CHECK (request_type IN ('SEAT_ASSIGNMENT', 'ZONE_CHANGE')),  -- 좌석 배치, 구역 확장·변경
    status         varchar(10) NOT NULL DEFAULT 'DRAFT'
                   CHECK (status IN ('DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
    note           text,
    requested_by   bigint      NOT NULL REFERENCES employees(id),
    submitted_at   timestamptz,
    reviewed_by    bigint REFERENCES employees(id),
    reviewed_at    timestamptz,
    review_comment text,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX change_requests_floor_status_idx ON change_requests (floor_id, status);

-- 요청 안의 변경 1건 = 1행 (예: "이서연 → B-11", "Z-01을 B구역으로")
-- 자리 교환은 ASSIGN 2행으로 표현한다
CREATE TABLE change_request_items (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    request_id  bigint      NOT NULL REFERENCES change_requests(id) ON DELETE CASCADE,
    seat_id     bigint      NOT NULL REFERENCES seats(id),
    action      varchar(10) NOT NULL CHECK (action IN ('ASSIGN', 'UNASSIGN', 'MOVE_ZONE')),
    employee_id bigint REFERENCES employees(id),          -- ASSIGN: 앉힐 사람
    to_zone_id  bigint REFERENCES zones(id),              -- MOVE_ZONE: 옮길 구역
    CHECK ((action = 'ASSIGN' AND employee_id IS NOT NULL)
        OR (action = 'UNASSIGN')
        OR (action = 'MOVE_ZONE' AND to_zone_id IS NOT NULL))
);
CREATE INDEX change_request_items_request_idx ON change_request_items (request_id);

-- 좌석 배정. ends_at이 NULL이면 현재 배정
-- 이동·교환·해제 때 기존 행을 끝내고 새 행을 만들어서 이력이 남는다
-- FIXED: 고정석 배정, DAILY: 자율석 당일 사용
CREATE TABLE seat_assignments (
    id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    seat_id           bigint      NOT NULL REFERENCES seats(id),
    employee_id       bigint      NOT NULL REFERENCES employees(id),
    kind              varchar(10) NOT NULL DEFAULT 'FIXED' CHECK (kind IN ('FIXED', 'DAILY')),
    starts_at         timestamptz NOT NULL DEFAULT now(),
    ends_at           timestamptz,
    assigned_by       bigint REFERENCES employees(id),
    change_request_id bigint REFERENCES change_requests(id),  -- 승인을 거쳐 반영됐으면 그 요청
    created_at        timestamptz NOT NULL DEFAULT now(),
    CHECK (ends_at IS NULL OR ends_at > starts_at),
    CHECK (kind = 'FIXED' OR ends_at IS NOT NULL),            -- 당일 사용은 끝나는 시각이 있어야 한다
    -- 한 좌석에 같은 시간대 두 명 불가
    EXCLUDE USING gist (seat_id WITH =, tstzrange(starts_at, ends_at) WITH &&),
    -- 한 사람이 같은 시간대 고정석 두 개 불가
    EXCLUDE USING gist (employee_id WITH =, tstzrange(starts_at, ends_at) WITH &&) WHERE (kind = 'FIXED')
);
CREATE INDEX seat_assignments_employee_idx ON seat_assignments (employee_id);
