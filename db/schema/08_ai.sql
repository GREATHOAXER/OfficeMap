-- 08_ai.sql
-- AI 도우미: 업무분장표와 대화 기록
-- 담당자 찾기는 업무분장표를 업무 단위로 쪼갠 duty_tasks를 검색해서 답한다

CREATE EXTENSION IF NOT EXISTS vector;  -- pgvector. 사내 DB에서 쓸 수 없으면 embedding 컬럼을 빼고 전문 검색으로 대체

-- 업무분장표 원본 1개 = 1행 (예: 2026 업무분장표 · 재무팀, 10/01 갱신)
CREATE TABLE duty_documents (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    title          varchar(200) NOT NULL,
    department_id  bigint REFERENCES departments(id),     -- 전사 공통 문서면 NULL
    file_id        bigint REFERENCES files(id),
    effective_date date         NOT NULL,                 -- 답변의 "근거: … (10/01 갱신)"
    is_active      boolean      NOT NULL DEFAULT true,    -- 새 판이 올라오면 이전 판은 false
    uploaded_by    bigint REFERENCES employees(id),
    created_at     timestamptz  NOT NULL DEFAULT now()
);

-- 업무 1개 (예: 법인카드 정산)
CREATE TABLE duty_tasks (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    document_id   bigint       NOT NULL REFERENCES duty_documents(id) ON DELETE CASCADE,
    department_id bigint       NOT NULL REFERENCES departments(id),
    name          varchar(200) NOT NULL,
    description   text,
    keywords      text[]       NOT NULL DEFAULT '{}',     -- 예: {경비 처리, 세금계산서}
    embedding     vector,                                 -- 질문과 뜻이 가까운 업무 찾기용. 차원은 사내 모델에 맞춰 정한다
    created_at    timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX duty_tasks_document_idx ON duty_tasks (document_id);

-- 업무별 담당자: 정담당 1명 + 부담당 0~N명
CREATE TABLE duty_task_owners (
    task_id     bigint      NOT NULL REFERENCES duty_tasks(id) ON DELETE CASCADE,
    employee_id bigint      NOT NULL REFERENCES employees(id),
    role        varchar(10) NOT NULL CHECK (role IN ('PRIMARY', 'SECONDARY')),
    PRIMARY KEY (task_id, employee_id)
);
CREATE UNIQUE INDEX duty_task_owners_one_primary_idx ON duty_task_owners (task_id) WHERE role = 'PRIMARY';
CREATE INDEX duty_task_owners_employee_idx ON duty_task_owners (employee_id);

-- AI 대화 기록 (답변 품질 점검·감사용. 보관 기간은 정보보호팀 기준)
CREATE TABLE ai_conversations (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    employee_id bigint      NOT NULL REFERENCES employees(id),
    started_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_conversations_employee_idx ON ai_conversations (employee_id, started_at);

CREATE TABLE ai_messages (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    conversation_id bigint      NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
    role            varchar(10) NOT NULL CHECK (role IN ('USER', 'ASSISTANT', 'TOOL')),
    content         text        NOT NULL,
    tool_name       varchar(50),                          -- 예: find_owner, book_room, find_free_seats
    tool_args       jsonb,
    cited_task_ids  bigint[],                             -- 답변 근거로 쓴 업무
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_messages_conversation_idx ON ai_messages (conversation_id, created_at);
