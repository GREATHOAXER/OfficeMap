-- 03_space.sql
-- 공간: 사업장, 층, 도면, 팀 구역, 좌석
-- 도면 위 좌표(x, y, shape)는 모두 도면 너비·높이 대비 비율(0~1)로 저장한다

CREATE TABLE sites (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind       varchar(10)  NOT NULL CHECK (kind IN ('HQ', 'CENTER')),  -- 본사, 센터
    name       varchar(100) NOT NULL UNIQUE,                            -- 예: 서울 본사
    address    varchar(255),
    sort_order integer      NOT NULL DEFAULT 0,
    is_active  boolean      NOT NULL DEFAULT true,
    created_at timestamptz  NOT NULL DEFAULT now(),
    updated_at timestamptz  NOT NULL DEFAULT now()
);

CREATE TABLE floors (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    site_id    bigint      NOT NULL REFERENCES sites(id),
    name       varchar(20) NOT NULL,                      -- 예: 7F, B1
    sort_order integer     NOT NULL,                      -- 층 버튼 순서. 이름으로 정렬하면 10F가 2F 앞에 온다
    is_active  boolean     NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (site_id, name)
);

-- 도면 버전. 층마다 게시본 1개와 작성 중인 초안 1개까지
-- MVP: 배경 이미지(PDF 변환본)만 쓰고 geometry는 비워 둔다
-- 도면 편집기 도입 후: 벽·공간·책상을 geometry(JSON)에 도면 버전 단위로 통째로 저장한다
CREATE TABLE floor_plans (
    id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    floor_id           bigint       NOT NULL REFERENCES floors(id),
    version            integer      NOT NULL,
    status             varchar(10)  NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')),
    background_file_id bigint REFERENCES files(id),       -- 원본 PDF 또는 변환 이미지
    background_opacity numeric(3,2) NOT NULL DEFAULT 1.00 CHECK (background_opacity BETWEEN 0 AND 1),
    width_m            numeric(6,2),                      -- 실제 폭·높이(m). 축척, 격자 맞춤용
    height_m           numeric(6,2),
    geometry           jsonb,
    created_by         bigint       NOT NULL REFERENCES employees(id),
    created_at         timestamptz  NOT NULL DEFAULT now(),
    updated_by         bigint       NOT NULL REFERENCES employees(id),
    updated_at         timestamptz  NOT NULL DEFAULT now(),  -- 자동 저장 시각
    published_by       bigint REFERENCES employees(id),
    published_at       timestamptz,
    UNIQUE (floor_id, version)
);
CREATE UNIQUE INDEX floor_plans_one_published_idx ON floor_plans (floor_id) WHERE status = 'PUBLISHED';
CREATE UNIQUE INDEX floor_plans_one_draft_idx ON floor_plans (floor_id) WHERE status = 'DRAFT';

-- 팀 구역: 도면 위에 색칠된 영역 (예: 재무팀 · B, 공용 자율석 · Z)
-- 색은 부서가 아니라 구역에 붙인다. 층마다 같은 색을 다른 팀이 쓰기 때문
CREATE TABLE zones (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    floor_id      bigint       NOT NULL REFERENCES floors(id),
    code          varchar(10)  NOT NULL,                  -- 예: A, B, Z
    name          varchar(100) NOT NULL,                  -- 예: 재무팀, 공용 자율석, 교육장
    department_id bigint REFERENCES departments(id),      -- 공용 구역이면 NULL
    color_key     varchar(10)  NOT NULL,                  -- 디자인의 t0~t4
    shape         jsonb        NOT NULL,                  -- {"type":"rect","x":0.1,"y":0.2,"w":0.3,"h":0.2} 또는 다각형
    sort_order    integer      NOT NULL DEFAULT 0,
    is_active     boolean      NOT NULL DEFAULT true,
    created_at    timestamptz  NOT NULL DEFAULT now(),
    updated_at    timestamptz  NOT NULL DEFAULT now(),
    UNIQUE (floor_id, code)
);
CREATE INDEX zones_department_id_idx ON zones (department_id);

-- 좌석: 층에 붙어 있어서 도면을 새 버전으로 바꿔도 좌석과 배정은 그대로 남는다
CREATE TABLE seats (
    id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    floor_id         bigint       NOT NULL REFERENCES floors(id),
    zone_id          bigint REFERENCES zones(id),
    code             varchar(20)  NOT NULL,               -- 예: A-01
    seat_type        varchar(10)  NOT NULL DEFAULT 'FIXED' CHECK (seat_type IN ('FIXED', 'FLEX')),  -- 고정석, 자율석
    x                numeric(7,6) NOT NULL CHECK (x BETWEEN 0 AND 1),
    y                numeric(7,6) NOT NULL CHECK (y BETWEEN 0 AND 1),
    rotation         smallint     NOT NULL DEFAULT 0 CHECK (rotation IN (0, 90, 180, 270)),  -- 의자(앉는 쪽) 방향
    status           varchar(15)  NOT NULL DEFAULT 'ACTIVE'
                     CHECK (status IN ('ACTIVE', 'OUT_OF_SERVICE', 'REMOVED')),  -- 사용 중, 사용 중지(고장·수리), 도면에서 빠짐
    plan_element_key varchar(50),                         -- 도면 편집기에서 이 좌석을 만든 책상의 ID
    created_at       timestamptz  NOT NULL DEFAULT now(),
    updated_at       timestamptz  NOT NULL DEFAULT now(),
    UNIQUE (floor_id, code)
);
CREATE INDEX seats_zone_id_idx ON seats (zone_id);
