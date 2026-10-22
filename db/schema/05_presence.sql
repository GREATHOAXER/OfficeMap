-- 05_presence.sql
-- 재실 상태와 부재 일정

-- 직원당 1행. 바꿀 때마다 덮어쓰고 이력은 남기지 않는다 (근태·위치 추적 논란 방지)
-- 자동 해제(30분, 1시간, 퇴근 시)는 expires_at으로 처리: 지난 값은 화면에서 기본 상태로 본다
CREATE TABLE presence_status (
    employee_id bigint      PRIMARY KEY REFERENCES employees(id),
    status      varchar(15) NOT NULL CHECK (status IN ('AVAILABLE', 'DO_NOT_DISTURB', 'IN_MEETING', 'AWAY')),
    message     varchar(100),                             -- 예: 15시까지 집중 업무
    expires_at  timestamptz,                              -- NULL이면 직접 바꿀 때까지 유지
    source      varchar(10) NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MANUAL', 'CALENDAR', 'ACCESS_LOG')),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

-- 상태가 바뀌면(저장·삭제 모두) API 서버에 알린다. 서버는 LISTEN presence_changed로 받아서
-- 열려 있는 화면에 바로 보낸다. 직접 SQL로 바꾸거나 나중에 일정 연동이 바꿔도 똑같이 알림이 간다
-- at: 바뀐 시각. 화면은 이보다 나중에 읽은 데이터가 있으면 그쪽을 믿는다
CREATE OR REPLACE FUNCTION notify_presence_changed() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    emp_id bigint := coalesce(NEW.employee_id, OLD.employee_id);
BEGIN
    PERFORM pg_notify('presence_changed', json_build_object(
        'emp_no', (SELECT emp_no FROM employees WHERE id = emp_id),
        'presence', CASE WHEN TG_OP <> 'DELETE' THEN json_build_object(
            'status', NEW.status, 'message', NEW.message,
            'expires_at', NEW.expires_at, 'updated_at', NEW.updated_at) END,
        'at', clock_timestamp())::text);
    RETURN NULL;
END $$;

CREATE TRIGGER presence_status_notify
    AFTER INSERT OR UPDATE OR DELETE ON presence_status
    FOR EACH ROW EXECUTE FUNCTION notify_presence_changed();

-- 휴가·외근·재택 일정 (근태 시스템 연동 후)
-- "연차 휴가 · 내일 복귀", 참석자 검색의 "이 시간 연차 예정" 표시에 쓴다
CREATE TABLE employee_absences (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    employee_id bigint      NOT NULL REFERENCES employees(id),
    kind        varchar(15) NOT NULL CHECK (kind IN ('LEAVE', 'BUSINESS_TRIP', 'REMOTE')),
    starts_at   timestamptz NOT NULL,
    ends_at     timestamptz NOT NULL,
    source      varchar(10) NOT NULL DEFAULT 'HR_API' CHECK (source IN ('HR_API', 'MANUAL')),
    external_id varchar(100),                             -- 근태 시스템 쪽 ID. 같은 일정을 두 번 받지 않게
    synced_at   timestamptz NOT NULL DEFAULT now(),
    CHECK (ends_at > starts_at),
    UNIQUE (source, external_id)
);
CREATE INDEX employee_absences_employee_idx ON employee_absences (employee_id, starts_at);
