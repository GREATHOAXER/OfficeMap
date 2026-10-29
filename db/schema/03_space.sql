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
    name        varchar(20) NOT NULL,                     -- 예: 7F, B1
    description varchar(50),                              -- 사무실이 아닌 층의 용도 (예: 로비, 대강당). 층 버튼 아래 표시
    sort_order  integer     NOT NULL,                     -- 층 버튼 순서. 이름으로 정렬하면 10F가 2F 앞에 온다
    is_active  boolean     NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (site_id, name)
);

-- 도면 버전. 층마다 게시본 1개와 작성 중인 초안 1개까지, 이전 게시본은 보관본(ARCHIVED)으로 모두 남긴다
-- 벽·기둥·공간·회의실·책상 묶음을 geometry(JSON)에 버전 단위로 통째로 저장한다
--   v0 (목업): {"walls", "pillars", "spaces"} 도면 대비 비율(0~1) 좌표. 좌석·회의실은 각자 테이블에만 있다
--   v1 (도면 편집기, "schema": 1): 미터 단위 요소 목록. 책상 칸 하나가 좌석 하나 (server/app/plan_geometry.py)
-- 게시하면 v1의 책상 칸·회의실 공간으로 seats·meeting_rooms 행을 맞춘다 (plan_element_key로 연결)
CREATE TABLE floor_plans (
    id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    floor_id           bigint       NOT NULL REFERENCES floors(id),
    version            integer      NOT NULL,
    -- SCHEDULED: 게시를 예약한 초안 (effective_at에 서버가 게시한다. 예약을 취소하면 다시 DRAFT)
    status             varchar(10)  NOT NULL DEFAULT 'DRAFT'
                       CHECK (status IN ('DRAFT', 'SCHEDULED', 'PUBLISHED', 'ARCHIVED')),
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
    publish_note       varchar(200),                      -- 게시 메모 (예: 7F 리모델링 1차)
    base_plan_id       bigint REFERENCES floor_plans(id),   -- 초안이 어느 게시본(또는 보관본)에서 시작했나
    revision           integer      NOT NULL DEFAULT 1,  -- 자동 저장마다 +1. 다른 탭·사람이 먼저 저장했으면 덮어쓰지 않는다
    editing_by         bigint REFERENCES employees(id),   -- 지금 편집 중인 사람 (한 초안은 한 사람이 편집)
    editing_heartbeat_at timestamptz,                     -- 편집 화면이 30초마다 알린다. 2분 넘게 없으면 잠금이 풀린다
    effective_at       timestamptz,                       -- 게시 예약 시각 (SCHEDULED)
    publish_options    jsonb,                             -- 게시 예약 때 정한 것 {people: [{emp_no, to_key}], rooms: [...]}
    scheduled_by       bigint REFERENCES employees(id),   -- 게시를 예약한 사람 (그날 이 사람 이름으로 게시된다)
    UNIQUE (floor_id, version),
    CHECK (status <> 'SCHEDULED' OR (effective_at IS NOT NULL AND scheduled_by IS NOT NULL))
);
CREATE UNIQUE INDEX floor_plans_one_published_idx ON floor_plans (floor_id) WHERE status = 'PUBLISHED';
-- 층마다 고치는 중인 초안(게시 예약한 초안 포함)은 하나
CREATE UNIQUE INDEX floor_plans_one_draft_idx ON floor_plans (floor_id) WHERE status IN ('DRAFT', 'SCHEDULED');
CREATE INDEX floor_plans_scheduled_idx ON floor_plans (effective_at) WHERE status = 'SCHEDULED';

-- 팀 구역: 한 팀(부서)이 쓰는 좌석 묶음 + 색 (예: 재무팀 · B, 공용 자율석 · Z)
-- 구역의 원본은 "좌석 묶음"(seats.zone_id)이다. 도면에 칠하는 모양(shape)은 그 좌석들을 감싸서 자동으로 계산한
-- 값을 저장해 둔 것이라(shape_mode = AUTO), 좌석이 구역을 옮기거나 도면에서 책상이 움직이면 저절로 따라간다
-- 색은 부서가 아니라 구역에 붙인다. 층마다 같은 색을 다른 팀이 쓰기 때문
-- 구역을 없애도 행은 지우지 않고 is_active = false (이력·권한 기록이 이 행을 가리킨다)
CREATE TABLE zones (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    floor_id      bigint       NOT NULL REFERENCES floors(id),
    code          varchar(10)  NOT NULL,                  -- 예: A, B, Z
    name          varchar(100) NOT NULL,                  -- 예: 재무팀, 공용 자율석, 교육장
    name_custom   boolean      NOT NULL DEFAULT false,    -- false면 부서 이름을 따라간다 (조직도에서 이름이 바뀌면 같이)
    department_id bigint REFERENCES departments(id),      -- 공용 구역이면 NULL
    color_key     varchar(10)  NOT NULL,                  -- 기본 색 t0~t11 또는 직접 고른 색 #rrggbb (화면 lib/zoneColors.ts)
    -- {"type":"rect","x","y","w","h"} 또는 좌석 덩어리가 여럿이면 {"type":"rects","rects":[{x,y,w,h}, …]}
    -- 좌석이 하나도 없으면 NULL (그리지 않는다)
    shape         jsonb,
    shape_mode    varchar(10)  NOT NULL DEFAULT 'AUTO' CHECK (shape_mode IN ('AUTO', 'MANUAL')),  -- 자동 계산 / 손으로 그림
    sort_order    integer      NOT NULL DEFAULT 0,
    is_active     boolean      NOT NULL DEFAULT true,
    created_at    timestamptz  NOT NULL DEFAULT now(),
    updated_at    timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX zones_department_id_idx ON zones (department_id);
-- 층 안에서 살아 있는 구역끼리만 코드가 겹치지 않으면 된다 (없앤 구역의 코드는 다시 쓸 수 있다)
CREATE UNIQUE INDEX zones_floor_code_idx ON zones (floor_id, code) WHERE is_active;

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
    -- 좌석(책상)이 도면에서 차지하는 폭·높이 (도면 대비 비율, 돌린 뒤). 없으면 기본 책상 (2.665 × 1.668 m)
    w                numeric(7,6) CHECK (w > 0 AND w <= 1),
    h                numeric(7,6) CHECK (h > 0 AND h <= 1),
    status           varchar(15)  NOT NULL DEFAULT 'ACTIVE'
                     CHECK (status IN ('ACTIVE', 'OUT_OF_SERVICE', 'REMOVED')),  -- 사용 중, 사용 중지(고장·수리), 도면에서 빠짐
    plan_element_key varchar(50),                         -- 도면 편집기에서 이 좌석을 만든 책상 칸의 ID
    removed_at       timestamptz,                         -- 도면 게시로 빠진 시각 (status = REMOVED)
    removed_by_plan_id bigint REFERENCES floor_plans(id),  -- 어느 도면 게시로 빠졌나
    created_at       timestamptz  NOT NULL DEFAULT now(),
    updated_at       timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX seats_zone_id_idx ON seats (zone_id);
-- 좌석 번호는 층 안에서 살아 있는 좌석끼리만 겹치지 않으면 된다 (빠진 좌석의 번호는 새 책상이 다시 쓸 수 있다)
CREATE UNIQUE INDEX seats_floor_code_idx ON seats (floor_id, code) WHERE status <> 'REMOVED';
CREATE UNIQUE INDEX seats_floor_element_idx ON seats (floor_id, plan_element_key)
    WHERE status <> 'REMOVED' AND plan_element_key IS NOT NULL;

-- 구역 모양 자동 계산(좌석이 바뀌면 그 층 구역 모양을 다시 계산하는 트리거)은 16_zone_plan_obstacles.sql

-- 조직도 변화 → 구역 -------------------------------------------------------------
-- 부서 이름이 바뀌면 구역 이름도 따라 바꾼다 (관리자가 별칭을 정한 구역은 그대로)
-- 부서가 없어지면(is_active = false) 구역은 남기고, 화면이 "폐지된 부서의 구역"으로 경고한다
CREATE OR REPLACE FUNCTION follow_department_name() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.name IS DISTINCT FROM OLD.name THEN
        UPDATE zones SET name = NEW.name, updated_at = now()
        WHERE department_id = NEW.id AND NOT name_custom AND is_active;
    END IF;
    RETURN NULL;
END $$;

CREATE TRIGGER departments_zone_name
    AFTER UPDATE OF name ON departments
    FOR EACH ROW EXECUTE FUNCTION follow_department_name();
