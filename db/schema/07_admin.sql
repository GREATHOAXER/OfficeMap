-- 07_admin.sql
-- 관리자 권한: 4단계(전사 → 사업장 → 층 → 구역)
-- MVP에서는 user_accounts.role(ADMIN/USER)만 쓰고, 2단계에서 이 테이블로 넘어온다

CREATE TABLE admin_grants (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    employee_id bigint      NOT NULL REFERENCES employees(id),
    role        varchar(20) NOT NULL
                CHECK (role IN ('COMPANY_ADMIN', 'SITE_ADMIN', 'FLOOR_ADMIN', 'ZONE_ADMIN')),
    -- 관리 범위: 역할에 맞는 칸 하나만 채운다 (전사 관리자는 모두 NULL)
    site_id     bigint REFERENCES sites(id),
    floor_id    bigint REFERENCES floors(id),
    zone_id     bigint REFERENCES zones(id),
    apply_mode  varchar(15) NOT NULL DEFAULT 'IMMEDIATE'
                CHECK (apply_mode IN ('IMMEDIATE', 'NEEDS_APPROVAL')),  -- 구역 관리자의 변경 반영: 즉시 / 층 관리자 승인 후
    granted_by  bigint REFERENCES employees(id),          -- 바로 위 단계 관리자
    granted_at  timestamptz NOT NULL DEFAULT now(),
    revoked_by  bigint REFERENCES employees(id),
    revoked_at  timestamptz,
    CHECK (
        (role = 'COMPANY_ADMIN' AND site_id IS NULL     AND floor_id IS NULL     AND zone_id IS NULL) OR
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
