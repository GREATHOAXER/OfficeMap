-- 02_common.sql
-- 여러 화면이 같이 쓰는 테이블: 업로드 파일, 운영 설정값, 조직도 가져오기 기록, 관리자 작업 이력, 알림

-- 업로드 파일: 평면도 PDF, 직원 사진, 업무분장표, 조직도 엑셀
CREATE TABLE files (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    original_name varchar(255) NOT NULL,
    stored_path   varchar(500) NOT NULL UNIQUE,
    mime_type     varchar(100) NOT NULL,
    size_bytes    bigint       NOT NULL,
    uploaded_by   bigint REFERENCES employees(id),
    created_at    timestamptz  NOT NULL DEFAULT now()
);

-- 운영 정책 값. 배포 없이 관리자가 바꿀 수 있게 둔다
-- 예: room.max_minutes = 120, room.checkin_grace_minutes = 15, session.idle_minutes = 30
CREATE TABLE app_settings (
    key         varchar(100) PRIMARY KEY,
    value       jsonb        NOT NULL,
    description varchar(255),
    updated_by  bigint REFERENCES employees(id),
    updated_at  timestamptz  NOT NULL DEFAULT now()
);

-- 조직도 가져오기 1회 = 1행 (엑셀 업로드 또는 인사 시스템 연동)
CREATE TABLE org_sync_runs (
    id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source            varchar(10) NOT NULL CHECK (source IN ('EXCEL', 'HR_API')),
    file_id           bigint REFERENCES files(id),
    status            varchar(10) NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING', 'SUCCESS', 'FAILED')),
    created_count     integer     NOT NULL DEFAULT 0,
    updated_count     integer     NOT NULL DEFAULT 0,
    deactivated_count integer     NOT NULL DEFAULT 0,     -- 원본에서 빠져 퇴사·폐지 처리된 수
    error_message     text,
    run_by            bigint REFERENCES employees(id),
    started_at        timestamptz NOT NULL DEFAULT now(),
    finished_at       timestamptz
);

-- 관리자 작업 이력: 좌석 배정, 권한 부여, 도면 게시 등 누가 무엇을 바꿨는지
CREATE TABLE audit_logs (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    actor_id    bigint REFERENCES employees(id),
    action      varchar(50) NOT NULL,                     -- 예: SEAT_ASSIGN, GRANT_CREATE, PLAN_PUBLISH
    target_type varchar(50) NOT NULL,                     -- 예: seat, admin_grant, floor_plan
    target_id   bigint,
    before_data jsonb,
    after_data  jsonb,
    ip_address  inet,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_target_idx ON audit_logs (target_type, target_id);
CREATE INDEX audit_logs_created_at_idx ON audit_logs (created_at);

-- 알림 발송 기록: 회의 초대 등 (메신저 연동 이후)
CREATE TABLE notifications (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    recipient_id bigint      NOT NULL REFERENCES employees(id),
    channel      varchar(10) NOT NULL CHECK (channel IN ('MESSENGER', 'IN_APP')),
    type         varchar(50) NOT NULL,                    -- 예: RESERVATION_INVITE
    payload      jsonb       NOT NULL,
    status       varchar(10) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENT', 'FAILED')),
    sent_at      timestamptz,
    read_at      timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_recipient_idx ON notifications (recipient_id, created_at);
