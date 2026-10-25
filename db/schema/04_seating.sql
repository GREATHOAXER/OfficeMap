-- 04_seating.sql
-- 좌석 배정, 배치 변경 묶음(작업 묶음)·승인, 도면·배치 실시간 알림

CREATE EXTENSION IF NOT EXISTS btree_gist;  -- 배정 기간 겹침 방지(EXCLUDE)에 필요

-- 배치 변경 묶음: 관리자가 좌석 배치 화면에서 만든 변경 모음 (작성 중(DRAFT) = 자동 저장된 미반영 변경)
-- 층 관리자 이상과 "즉시 반영" 구역 관리자는 바로 반영하고(APPROVED), "층 관리자 승인 후" 구역 관리자는
-- 승인을 요청한다(PENDING → 층 관리자가 APPROVED 또는 REJECTED). 반영한 묶음도 지우지 않고 이력으로 남긴다
CREATE TABLE change_requests (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    floor_id       bigint      NOT NULL REFERENCES floors(id),
    zone_id        bigint REFERENCES zones(id),
    request_type   varchar(20) NOT NULL CHECK (request_type IN ('SEAT_ASSIGNMENT', 'ZONE_CHANGE')),  -- 좌석 배치, 구역 확장·변경
    status         varchar(10) NOT NULL DEFAULT 'DRAFT'
                   CHECK (status IN ('DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
    note           text,
    effective_at   timestamptz,                           -- 언제부터. NULL이면 반영하는 즉시. 반영하면 실제 시각이 들어간다
    requested_by   bigint      NOT NULL REFERENCES employees(id),
    submitted_at   timestamptz,
    reviewed_by    bigint REFERENCES employees(id),
    reviewed_at    timestamptz,
    review_comment text,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX change_requests_floor_status_idx ON change_requests (floor_id, status);
-- 관리자 한 명이 한 층에 진행 중인(작성 중·승인 대기) 좌석 배치 묶음은 하나
CREATE UNIQUE INDEX change_requests_one_open_idx ON change_requests (floor_id, requested_by)
    WHERE status IN ('DRAFT', 'PENDING') AND request_type = 'SEAT_ASSIGNMENT';

-- 묶음 안의 변경 1건 = 1행. 좌석마다 "반영하면 이렇게 된다"를 적는다
-- (예: "B-11 ← 이서연", "B-04 비우기", "Z-01을 B구역으로", "B-18을 자율석으로")
-- 구역 경계 변경(MOVE_ZONE)은 구역 관리자가 내면 언제나 층 관리자 승인 후 반영한다
-- 자리 교환은 ASSIGN 2행, 다른 자리로 옮기기는 ASSIGN(새 자리) + UNASSIGN(옛 자리)
CREATE TABLE change_request_items (
    id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    request_id           bigint      NOT NULL REFERENCES change_requests(id) ON DELETE CASCADE,
    seat_id              bigint      NOT NULL REFERENCES seats(id),
    action               varchar(10) NOT NULL CHECK (action IN ('ASSIGN', 'UNASSIGN', 'MOVE_ZONE', 'SET_TYPE')),
    employee_id          bigint REFERENCES employees(id),  -- ASSIGN: 앉힐 사람
    -- ASSIGN·UNASSIGN: 이 변경을 만들 때 그 좌석에 앉아 있던 사람 (NULL = 빈 자리)
    -- 반영할 때 그사이 다른 관리자가 바꿔서 지금과 다르면 그 항목은 충돌로 멈춘다
    expected_employee_id bigint REFERENCES employees(id),
    to_zone_id           bigint REFERENCES zones(id),      -- MOVE_ZONE: 옮길 구역 (NULL = 구역 없음으로 빼기)
    seat_mode            varchar(15) CHECK (seat_mode IN ('FIXED', 'FLEX', 'OUT_OF_SERVICE')),  -- SET_TYPE: 고정석·팀 내 자율석·사용 중지
    CHECK ((action = 'ASSIGN' AND employee_id IS NOT NULL)
        OR (action = 'UNASSIGN')
        OR (action = 'MOVE_ZONE')
        OR (action = 'SET_TYPE' AND seat_mode IS NOT NULL))
);
CREATE INDEX change_request_items_request_idx ON change_request_items (request_id);
-- 한 묶음 안에서 좌석마다 배정 변경·구역 변경·유형 변경이 하나씩만
CREATE UNIQUE INDEX change_request_items_one_per_seat_idx ON change_request_items
    (request_id, seat_id, (CASE WHEN action IN ('ASSIGN', 'UNASSIGN') THEN 'SEAT' ELSE action END));

-- 좌석 배정. ends_at이 NULL이면 현재 배정
-- 이동·교환·해제 때 기존 행을 끝내고 새 행을 만들어서 이력이 남는다 (끝난 지 5년 보관)
-- 날짜를 정한 묶음은 starts_at·ends_at이 미래인 행을 미리 만들어 둔다. 화면은 지금 시각에 걸친 행만 보여 준다
-- FIXED: 고정석 배정, DAILY: 자율석 당일 사용
CREATE TABLE seat_assignments (
    id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    seat_id           bigint      NOT NULL REFERENCES seats(id),
    employee_id       bigint      NOT NULL REFERENCES employees(id),
    kind              varchar(10) NOT NULL DEFAULT 'FIXED' CHECK (kind IN ('FIXED', 'DAILY')),
    starts_at         timestamptz NOT NULL DEFAULT now(),
    ends_at           timestamptz,
    assigned_by       bigint REFERENCES employees(id),
    source            varchar(15) NOT NULL DEFAULT 'MANUAL'
                      CHECK (source IN ('MANUAL', 'CHANGE_SET', 'PLAN_PUBLISH')),  -- 어떻게 생긴 배정인가
    change_request_id bigint REFERENCES change_requests(id),  -- 배치 묶음으로 만들었으면 그 묶음
    ended_by_request_id bigint REFERENCES change_requests(id),  -- 배치 묶음이 끝냈으면 그 묶음 (예정 취소 때 되살린다)
    created_at        timestamptz NOT NULL DEFAULT now(),
    CHECK (ends_at IS NULL OR ends_at > starts_at),
    CHECK (kind = 'FIXED' OR ends_at IS NOT NULL),            -- 당일 사용은 끝나는 시각이 있어야 한다
    -- 한 좌석에 같은 시간대 두 명 불가
    EXCLUDE USING gist (seat_id WITH =, tstzrange(starts_at, ends_at) WITH &&),
    -- 한 사람이 같은 시간대 고정석 두 개 불가
    EXCLUDE USING gist (employee_id WITH =, tstzrange(starts_at, ends_at) WITH &&) WHERE (kind = 'FIXED')
);
CREATE INDEX seat_assignments_employee_idx ON seat_assignments (employee_id);
CREATE INDEX seat_assignments_seat_idx ON seat_assignments (seat_id);

-- 실시간 알림 ------------------------------------------------------------------
-- 좌석·배정·구역·도면이 바뀌면 API 서버에 NOTIFY floor_changed로 알린다 (재실 상태의 presence_changed와 같은 방식)
-- 서버는 열려 있는 직원 화면·배치 화면에 보내고, 화면은 그 층을 다시 읽는다
-- NOTIFY는 커밋된 뒤에만 전달되고, 한 트랜잭션 안에서 같은 내용은 한 번만 간다 (그래서 at은 트랜잭션 시각 now())
--   kind: seats(배정·좌석) / zones(팀 구역) / plan(도면 게시) / requests(배치 묶음 승인 요청·반려 등. 배치 화면만 쓴다)
--   emp_no: 고정석 배정이 바뀐 사람 (화면이 "내 자리가 바뀌었어요"를 띄울지 정한다)
CREATE OR REPLACE FUNCTION notify_assignment_changed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP <> 'DELETE' THEN
        PERFORM pg_notify('floor_changed', json_build_object(
            'kind', 'seats', 'floor_id', s.floor_id, 'seat_id', s.id,
            'emp_no', CASE WHEN NEW.kind = 'FIXED' THEN (SELECT emp_no FROM employees WHERE id = NEW.employee_id) END,
            'at', now())::text)
        FROM seats s WHERE s.id = NEW.seat_id;
    END IF;
    IF TG_OP <> 'INSERT' THEN
        PERFORM pg_notify('floor_changed', json_build_object(
            'kind', 'seats', 'floor_id', s.floor_id, 'seat_id', s.id,
            'emp_no', CASE WHEN OLD.kind = 'FIXED' THEN (SELECT emp_no FROM employees WHERE id = OLD.employee_id) END,
            'at', now())::text)
        FROM seats s WHERE s.id = OLD.seat_id;
    END IF;
    RETURN NULL;
END $$;

CREATE TRIGGER seat_assignments_notify
    AFTER INSERT OR UPDATE OR DELETE ON seat_assignments
    FOR EACH ROW EXECUTE FUNCTION notify_assignment_changed();

-- 좌석(유형·사용 중지·구역·위치), 구역, 도면 게시
CREATE OR REPLACE FUNCTION notify_floor_row_changed() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    row_floor bigint := CASE WHEN TG_OP = 'DELETE' THEN OLD.floor_id ELSE NEW.floor_id END;
BEGIN
    IF TG_TABLE_NAME = 'floor_plans' THEN
        IF NEW.status = 'PUBLISHED' AND OLD.status IS DISTINCT FROM 'PUBLISHED' THEN
            PERFORM pg_notify('floor_changed', json_build_object(
                'kind', 'plan', 'floor_id', row_floor, 'version', NEW.version, 'at', now())::text);
        END IF;
    ELSIF TG_TABLE_NAME = 'change_requests' THEN
        IF TG_OP = 'DELETE' OR NEW.status IS DISTINCT FROM OLD.status THEN
            PERFORM pg_notify('floor_changed', json_build_object(
                'kind', 'requests', 'floor_id', row_floor, 'at', now())::text);
        END IF;
    ELSE
        PERFORM pg_notify('floor_changed', json_build_object(
            'kind', TG_TABLE_NAME, 'floor_id', row_floor, 'at', now())::text);
    END IF;
    RETURN NULL;
END $$;

CREATE TRIGGER seats_notify
    AFTER INSERT OR UPDATE OR DELETE ON seats
    FOR EACH ROW EXECUTE FUNCTION notify_floor_row_changed();
CREATE TRIGGER zones_notify
    AFTER INSERT OR UPDATE OR DELETE ON zones
    FOR EACH ROW EXECUTE FUNCTION notify_floor_row_changed();
-- INSERT도 받는다: 게시본을 바로 넣는 경우(목업·복원)도 있다. 그때 OLD는 NULL로 본다
CREATE TRIGGER floor_plans_notify
    AFTER INSERT OR UPDATE OF status ON floor_plans
    FOR EACH ROW EXECUTE FUNCTION notify_floor_row_changed();
-- 승인 요청·승인·반려·취소가 생기면 그 층 배치 화면의 요청 목록을 다시 읽게 한다 (작성 중 자동 저장은 알리지 않는다)
CREATE TRIGGER change_requests_notify
    AFTER UPDATE OF status OR DELETE ON change_requests
    FOR EACH ROW EXECUTE FUNCTION notify_floor_row_changed();

-- 조직도 변화 -------------------------------------------------------------------
-- 다른 부서로 옮기거나 퇴사하면 고정석 배정을 끝낸다. 좌석은 원래 팀 구역에 그대로 남아 빈 자리가 되고,
-- 그 사람은 새 팀의 미배치 인원으로 뜬다. 예정된(아직 시작 안 한) 배정은 지운다
-- 조직도 동기화든 직접 SQL이든 똑같이 동작하도록 트리거로 둔다. 휴직(LEAVE)은 자리를 그대로 둔다
CREATE OR REPLACE FUNCTION release_seat_on_org_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    reason text := CASE
        WHEN NEW.department_id IS DISTINCT FROM OLD.department_id THEN 'DEPARTMENT_CHANGE'
        WHEN NEW.employment_status = 'RETIRED' AND OLD.employment_status <> 'RETIRED' THEN 'RETIRED'
    END;
BEGIN
    IF reason IS NULL THEN
        RETURN NULL;
    END IF;
    INSERT INTO audit_logs (actor_id, action, target_type, target_id, before_data, after_data)
    SELECT NULL, 'SEAT_RELEASE', 'seat', a.seat_id,
           jsonb_build_object('employee', NEW.emp_no, 'starts_at', a.starts_at, 'ends_at', a.ends_at),
           jsonb_build_object('employee', NULL, 'reason', reason,
                              'from_department', (SELECT name FROM departments WHERE id = OLD.department_id),
                              'to_department', (SELECT name FROM departments WHERE id = NEW.department_id))
    FROM seat_assignments a
    WHERE a.employee_id = NEW.id AND a.kind = 'FIXED' AND (a.ends_at IS NULL OR a.ends_at > now());
    DELETE FROM seat_assignments
    WHERE employee_id = NEW.id AND kind = 'FIXED' AND starts_at >= now();
    UPDATE seat_assignments SET ends_at = now()
    WHERE employee_id = NEW.id AND kind = 'FIXED' AND starts_at < now() AND (ends_at IS NULL OR ends_at > now());
    RETURN NULL;
END $$;

CREATE TRIGGER employees_release_seat
    AFTER UPDATE OF department_id, employment_status ON employees
    FOR EACH ROW EXECUTE FUNCTION release_seat_on_org_change();
