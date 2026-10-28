-- 14_presence_statuses.sql
-- 재실 상태를 더 나눈다 (05_presence.sql의 presence_status.status).
-- 자리에 있음: 재실(AVAILABLE, 예전 이름 "방문 가능") · 방해 금지 · 회의 중 · 잠시 자리 비움
-- 자리에 없음: 외근 · 출장 · 재택 · 교육 · 휴가 · 부재(그 밖의 이유)
-- 휴가·출장처럼 며칠 가는 상태는 expires_at을 마지막 날 다음 날 0시(KST)로 둔다 ("10/31(금)까지")
-- 이미 있는 테이블의 CHECK를 바꾸는 것이라 05를 고치지 않고 새 파일로 쓴다 (server/app/schema.py).
-- 이미 돌고 있는 서버에는: python -m scripts.init_db --upgrade (자동 배포는 알아서 한다)

-- 쓸 수 있는 상태 (화면 frontend/src/lib/presence.ts, API server/app/routers/presence.py와 같아야 한다)
CREATE OR REPLACE FUNCTION presence_status_valid(code text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
    SELECT code IN ('AVAILABLE', 'DO_NOT_DISTURB', 'IN_MEETING', 'STEPPED_OUT',
                    'OUTSIDE', 'BUSINESS_TRIP', 'REMOTE', 'TRAINING', 'VACATION', 'AWAY')
$$;

ALTER TABLE presence_status DROP CONSTRAINT IF EXISTS presence_status_status_check;
ALTER TABLE presence_status ADD CONSTRAINT presence_status_status_check CHECK (presence_status_valid(status));
