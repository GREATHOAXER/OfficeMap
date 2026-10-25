-- 01_login.sql
-- 로그인 화면(⓪)에 필요한 테이블: 부서, 직원, 로그인 계정, 세션, 로그인 기록, 공지
-- PostgreSQL 16 기준

-- 부서: 조직도 엑셀에서 가져옴. 상위 부서는 parent_id로 연결
CREATE TABLE departments (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    dept_code   varchar(20)  NOT NULL UNIQUE,            -- 인사 시스템 부서코드
    name        varchar(100) NOT NULL,                   -- 예: 재무팀
    parent_id   bigint REFERENCES departments(id),
    sort_order  integer      NOT NULL DEFAULT 0,
    is_active   boolean      NOT NULL DEFAULT true,      -- 없어진 부서는 false (삭제하지 않음)
    created_at  timestamptz  NOT NULL DEFAULT now(),
    updated_at  timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX departments_parent_id_idx ON departments (parent_id);

-- 직원: 조직도 엑셀에서 가져옴. 다시 가져올 때 덮어써도 되는 정보만 둔다
CREATE TABLE employees (
    id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    emp_no            varchar(20)  NOT NULL UNIQUE,      -- 사번
    name              varchar(50)  NOT NULL,
    department_id     bigint       NOT NULL REFERENCES departments(id),
    rank_name         varchar(30),                       -- 직급: 대리, 과장, 차장
    position_name     varchar(30),                       -- 직책: 팀장 등
    email             varchar(100),
    extension         varchar(20),                       -- 내선
    mobile            varchar(20),                       -- 화면 비노출. MVP에서는 받지 않는 것을 권장
    photo_path        varchar(255),
    employment_status varchar(10)  NOT NULL DEFAULT 'ACTIVE'
                      CHECK (employment_status IN ('ACTIVE', 'LEAVE', 'RETIRED')),
    hired_on          date,
    created_at        timestamptz  NOT NULL DEFAULT now(),
    updated_at        timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX employees_department_id_idx ON employees (department_id);
CREATE INDEX employees_name_idx ON employees (name);  -- 이름 검색, 동명이인

-- 로그인 계정: 직원 1명당 0~1개
-- 직원 정보와 분리해서, 조직도를 다시 가져와도 비밀번호·잠금 상태가 유지된다
CREATE TABLE user_accounts (
    employee_id          bigint      PRIMARY KEY REFERENCES employees(id),
    password_hash        varchar(255),                   -- SSO만 쓰는 계정은 NULL
    must_change_password boolean     NOT NULL DEFAULT true,  -- 임시 비밀번호를 받은 상태
    password_changed_at  timestamptz,
    failed_login_count   smallint    NOT NULL DEFAULT 0,     -- 5회면 잠금, 로그인 성공 시 0
    locked_at            timestamptz,                        -- NULL이 아니면 잠김. 관리자가 해제
    last_login_at        timestamptz,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now()
);

-- 로그인 세션: 30분 동안 요청이 없으면 자동 로그아웃
CREATE TABLE user_sessions (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    token_hash     char(64)    NOT NULL UNIQUE,          -- 쿠키 토큰의 SHA-256. 원문은 저장하지 않음
    employee_id    bigint      NOT NULL REFERENCES employees(id),
    kind           varchar(10) NOT NULL DEFAULT 'USER' CHECK (kind IN ('USER', 'ADMIN')),  -- 직원 화면 / 관리자 페이지
    created_at     timestamptz NOT NULL DEFAULT now(),
    last_active_at timestamptz NOT NULL DEFAULT now(),   -- 현재 시각과 30분 넘게 차이 나면 만료
    expires_at     timestamptz NOT NULL,                 -- 계속 사용 중이어도 넘을 수 없는 시각 (예: 12시간 뒤)
    revoked_at     timestamptz,                          -- 로그아웃, 강제 종료
    -- 왜 끝났는지 (로그인 화면 안내 문구): 로그아웃 / 관리자가 비밀번호 초기화 / 다른 곳에서 비밀번호 변경 / 같은 브라우저에 다른 사람 로그인
    revoked_reason varchar(20) CHECK (revoked_reason IN ('LOGOUT', 'PASSWORD_RESET', 'PASSWORD_CHANGED', 'OTHER_LOGIN')),
    ip_address     inet,
    user_agent     varchar(255)
);
CREATE INDEX user_sessions_employee_id_idx ON user_sessions (employee_id);

-- 로그인 시도 기록: 성공·실패 모두 남김 (보관 기간은 정보보호팀 기준에 따름)
CREATE TABLE login_history (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    emp_no_input varchar(20) NOT NULL,                   -- 입력한 사번 그대로 (없는 사번도 기록)
    employee_id  bigint REFERENCES employees(id),        -- 없는 사번이면 NULL
    kind         varchar(10) NOT NULL DEFAULT 'USER' CHECK (kind IN ('USER', 'ADMIN')),  -- 어느 로그인 화면인지
    result       varchar(20) NOT NULL
                 CHECK (result IN ('SUCCESS', 'WRONG_PASSWORD', 'LOCKED', 'NO_ACCOUNT', 'NOT_ACTIVE', 'NO_PERMISSION')),
    ip_address   inet,
    user_agent   varchar(255),
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_history_employee_id_created_at_idx ON login_history (employee_id, created_at);
CREATE INDEX login_history_created_at_idx ON login_history (created_at);

-- 공지: 로그인 화면 하단 공지 영역
CREATE TABLE notices (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    title         varchar(200) NOT NULL,
    body          text,
    display_from  timestamptz  NOT NULL,
    display_until timestamptz,                           -- NULL이면 내릴 때까지 계속 표시
    is_active     boolean      NOT NULL DEFAULT true,
    created_by    bigint       NOT NULL REFERENCES employees(id),
    created_at    timestamptz  NOT NULL DEFAULT now(),
    updated_at    timestamptz  NOT NULL DEFAULT now()
);
