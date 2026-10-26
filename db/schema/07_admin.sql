-- 07_admin.sql
-- 관리자 권한: 최종 관리자(admin) 아래 4단계(전사 → 사업장 → 층 → 구역)와 관리자 페이지 로그인 계정
-- 무엇을 관리하는지는 admin_grants, 관리자 페이지에 어떻게 들어오는지는 admin_accounts
-- 둘 다 있어야 관리자 페이지(/admin)에 로그인할 수 있다. 직원 화면에는 관리자 페이지로 가는 링크를 두지 않는다

CREATE TABLE admin_grants (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    employee_id bigint      NOT NULL REFERENCES employees(id),
    role        varchar(20) NOT NULL
                CHECK (role IN ('SUPER_ADMIN', 'COMPANY_ADMIN', 'SITE_ADMIN', 'FLOOR_ADMIN', 'ZONE_ADMIN')),
    -- 관리 범위: 역할에 맞는 칸 하나만 채운다 (최종·전사 관리자는 모두 NULL)
    site_id     bigint REFERENCES sites(id),
    floor_id    bigint REFERENCES floors(id),
    zone_id     bigint REFERENCES zones(id),
    apply_mode  varchar(15) NOT NULL DEFAULT 'IMMEDIATE'
                CHECK (apply_mode IN ('IMMEDIATE', 'NEEDS_APPROVAL')),  -- 구역 관리자의 변경 반영: 즉시 / 층 관리자 승인 후
    granted_by  bigint REFERENCES employees(id),          -- 지정한 상위 관리자 (최종 관리자는 NULL)
    granted_at  timestamptz NOT NULL DEFAULT now(),
    revoked_by  bigint REFERENCES employees(id),
    revoked_at  timestamptz,
    CHECK (
        (role IN ('SUPER_ADMIN', 'COMPANY_ADMIN')
                                AND site_id IS NULL     AND floor_id IS NULL     AND zone_id IS NULL) OR
        (role = 'SITE_ADMIN'    AND site_id IS NOT NULL AND floor_id IS NULL     AND zone_id IS NULL) OR
        (role = 'FLOOR_ADMIN'   AND site_id IS NULL     AND floor_id IS NOT NULL AND zone_id IS NULL) OR
        (role = 'ZONE_ADMIN'    AND site_id IS NULL     AND floor_id IS NULL     AND zone_id IS NOT NULL)
    )
);
CREATE INDEX admin_grants_employee_idx ON admin_grants (employee_id) WHERE revoked_at IS NULL;
-- 같은 사람에게 같은 범위의 같은 권한이 두 번 살아 있지 않게
CREATE UNIQUE INDEX admin_grants_active_unique_idx ON admin_grants
    (employee_id, role, coalesce(site_id, 0), coalesce(floor_id, 0), coalesce(zone_id, 0))
    WHERE revoked_at IS NULL;

-- 관리자 페이지 로그인 계정. 직원 로그인 비밀번호와 다른 관리자 전용 비밀번호를 쓴다
-- 로그인하려면 이 계정과 함께 살아 있는 admin_grants가 하나 이상 있어야 한다
CREATE TABLE admin_accounts (
    employee_id         bigint       PRIMARY KEY REFERENCES employees(id),
    password_hash       varchar(255) NOT NULL,
    must_change_password boolean     NOT NULL DEFAULT false,  -- 권한을 받으며 임시 비밀번호를 받은 상태
    failed_login_count  smallint     NOT NULL DEFAULT 0,  -- 직원 로그인과 따로 센다. 5회면 잠금
    locked_at           timestamptz,
    password_changed_at timestamptz,
    last_login_at       timestamptz,
    created_by          bigint REFERENCES employees(id),   -- 계정을 만든 상위 관리자
    created_at          timestamptz  NOT NULL DEFAULT now(),
    updated_at          timestamptz  NOT NULL DEFAULT now()
);

-- 최종 관리자: 사람이 아닌 시스템 계정 (관리자 ID admin). 1~4단계 관리자를 모두 지정·편집하고 모든 관리 작업을 한다.
-- 직원 화면 계정이 없고 직원 목록·조직도에 나오지 않는다. 처음 비밀번호는 officemapking
-- (저장소에 적혀 있으니 실제 서버에서는 로그인한 뒤 계정 메뉴의 "관리자 비밀번호 변경"으로 바꾼다)
INSERT INTO employees (emp_no, name, department_id, employment_status)
VALUES ('admin', '최종 관리자', NULL, 'SYSTEM');
INSERT INTO admin_grants (employee_id, role)
VALUES ((SELECT id FROM employees WHERE emp_no = 'admin'), 'SUPER_ADMIN');
INSERT INTO admin_accounts (employee_id, password_hash)
VALUES ((SELECT id FROM employees WHERE emp_no = 'admin'),
        '$2b$12$K1Pu0Vp9x3r3wZ4AdUT02ORUkx4bNL6qsmch67X8.q88VK/u6rzh6');  -- officemapking
