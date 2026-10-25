-- 10_profile.sql
-- 내 정보: 직원이 스스로 고치는 프로필 (사진·부르는 이름·한 줄 소개·하는 일·업무 키워드).
-- 조직도(employees)를 다시 가져와도 지워지지 않게 따로 둔다. 이름·부서·직급·내선은 인사 정보 그대로다.
-- 직원 검색과 AI 도우미(담당자 찾기)가 업무분장표(duty_tasks)와 함께 "하는 일"·키워드를 본다

CREATE TABLE employee_profiles (
    employee_id  bigint      PRIMARY KEY REFERENCES employees(id),
    display_name varchar(30)
                 CHECK (display_name IS NULL OR length(btrim(display_name)) BETWEEN 1 AND 30),  -- 영문 이름·별칭
    headline     varchar(80),                          -- 한 줄 소개 (예: 결제망 API 연동 담당)
    duties       text        CHECK (duties IS NULL OR length(duties) <= 1000),  -- 하는 일 (자유롭게)
    skills       text[]      NOT NULL DEFAULT '{}'
                 CHECK (cardinality(skills) <= 15),    -- 업무 키워드 (예: {법인카드, 세금계산서})
    updated_at   timestamptz NOT NULL DEFAULT now()
);

-- 프로필 사진. 화면에서 정사각형으로 줄여(320px JPEG) 올린다. 큰 값이라 프로필과 따로 둔다
CREATE TABLE employee_photos (
    employee_id  bigint      PRIMARY KEY REFERENCES employees(id),
    image        bytea       NOT NULL CHECK (octet_length(image) <= 400000),
    content_type varchar(20) NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
    updated_at   timestamptz NOT NULL DEFAULT now()
);
