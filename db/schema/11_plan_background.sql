-- 11_plan_background.sql
-- 도면 밑그림: 도면 파일(이미지·PDF 쪽·엑셀 시트)을 그림으로 바꿔 층마다 하나 둔다.
-- 도면 편집 화면에서만 요소 밑에 깔아 보고 따라 그린다 (직원 화면에는 나오지 않는다).
-- 초안이 아니라 층에 붙어 있어서, 게시한 뒤 다시 초안을 만들어도 그대로 깔린다. 보관본마다 복사하지 않는다

CREATE TABLE floor_plan_backgrounds (
    floor_id     bigint       PRIMARY KEY REFERENCES floors(id) ON DELETE CASCADE,
    image        bytea        NOT NULL CHECK (octet_length(image) <= 8000000),
    content_type varchar(20)  NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
    -- 도면 위 자리 (m). 보통 도면 전체 (0, 0, 도면 폭, 도면 높이)
    x_m          numeric(8,3) NOT NULL DEFAULT 0,
    y_m          numeric(8,3) NOT NULL DEFAULT 0,
    w_m          numeric(8,3) NOT NULL CHECK (w_m > 0),
    h_m          numeric(8,3) NOT NULL CHECK (h_m > 0),
    opacity      numeric(3,2) NOT NULL DEFAULT 0.5 CHECK (opacity BETWEEN 0.05 AND 1),
    visible      boolean      NOT NULL DEFAULT true,
    source_name  varchar(200),                         -- 올린 파일 이름과 쪽 (예: 본사도면.pdf 3쪽)
    updated_by   bigint       REFERENCES employees(id),
    updated_at   timestamptz  NOT NULL DEFAULT now()
);
