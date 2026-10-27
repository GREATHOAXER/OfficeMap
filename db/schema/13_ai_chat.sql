-- 13_ai_chat.sql
-- AI 도우미 대화 (server/app/assistant.py). 08_ai.sql의 대화 기록 테이블에 모델과 주고받은 원문을 더한다.
-- 이미 돌고 있는 서버에는: python -m scripts.init_db --only 13_ai_chat.sql

-- 대화를 이어 갈 때 모델에 그대로 다시 보내야 하는 원문 (생각·도구 호출 블록 포함). content는 사람이 읽는 글만
ALTER TABLE ai_messages ADD COLUMN IF NOT EXISTS blocks jsonb;
-- 모델 응답 한 번의 토큰 수 (비용 확인용, ASSISTANT 줄만)
ALTER TABLE ai_messages ADD COLUMN IF NOT EXISTS input_tokens integer;
ALTER TABLE ai_messages ADD COLUMN IF NOT EXISTS output_tokens integer;

-- 어디서 연 대화인지 (PANEL: 자리·재실 현황의 AI 도우미, ROOMS: 회의실 예약 폼의 AI 추천)와 쓴 모델
ALTER TABLE ai_conversations ADD COLUMN IF NOT EXISTS source varchar(10) NOT NULL DEFAULT 'PANEL';
ALTER TABLE ai_conversations ADD COLUMN IF NOT EXISTS model varchar(100);
-- 답을 만드는 중이면 그때까지 (같은 대화에 두 곳에서 동시에 묻지 못하게). 서버가 중간에 꺼져도 시간이 지나면 풀린다
ALTER TABLE ai_conversations ADD COLUMN IF NOT EXISTS busy_until timestamptz;

-- 한 시간에 보낸 질문 수 세기 (사람별 한도)
CREATE INDEX IF NOT EXISTS ai_messages_user_recent_idx ON ai_messages (created_at) WHERE role = 'USER';
