-- 이력 정리 (결정 7: 5년 보관)
-- 서버 작업(server/app/jobs.py)이 하루 한 번 부르고, 손으로는 `python -m scripts.purge_history`로 돌린다.
-- 지우는 것: 끝난 지 보관 기간이 지난 배정, 끝난 작업 묶음(남은 배정이 가리키지 않는 것), 지난 예약,
--           감사 기록, 알림, 로그인 기록, 인사이동 기록, 도면에서 빠진 지 오래된 좌석(아무것도 가리키지 않는 것)
-- 남기는 것: 도면 보관본(작아서 모두 남긴다), 회의실·구역 행(비활성), 지금 쓰는 데이터
CREATE OR REPLACE FUNCTION purge_history(keep interval DEFAULT interval '5 years') RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
    cutoff timestamptz := now() - keep;
    n_assignments int;
    n_requests int;
    n_reservations int;
    n_audit int;
    n_notifications int;
    n_logins int;
    n_seats int;
    n_personnel int;
    result jsonb;
BEGIN
    DELETE FROM seat_assignments WHERE ends_at < cutoff;
    GET DIAGNOSTICS n_assignments = ROW_COUNT;

    DELETE FROM change_requests c
    WHERE c.status IN ('APPROVED', 'REJECTED', 'CANCELLED') AND c.updated_at < cutoff
      AND NOT EXISTS (SELECT 1 FROM seat_assignments a
                      WHERE a.change_request_id = c.id OR a.ended_by_request_id = c.id);
    GET DIAGNOSTICS n_requests = ROW_COUNT;

    DELETE FROM reservations WHERE ends_at < cutoff;
    GET DIAGNOSTICS n_reservations = ROW_COUNT;

    DELETE FROM audit_logs WHERE created_at < cutoff;
    GET DIAGNOSTICS n_audit = ROW_COUNT;

    DELETE FROM notifications WHERE created_at < cutoff;
    GET DIAGNOSTICS n_notifications = ROW_COUNT;

    DELETE FROM login_history WHERE created_at < cutoff;
    GET DIAGNOSTICS n_logins = ROW_COUNT;

    -- 인사이동 기록 (12_personnel.sql). 예약 중인 것은 남긴다
    DELETE FROM personnel_moves WHERE status <> 'SCHEDULED' AND coalesce(applied_at, cancelled_at, created_at) < cutoff;
    GET DIAGNOSTICS n_personnel = ROW_COUNT;

    DELETE FROM seats s
    WHERE s.status = 'REMOVED' AND s.removed_at < cutoff
      AND NOT EXISTS (SELECT 1 FROM seat_assignments a WHERE a.seat_id = s.id)
      AND NOT EXISTS (SELECT 1 FROM change_request_items i WHERE i.seat_id = s.id);
    GET DIAGNOSTICS n_seats = ROW_COUNT;

    result := jsonb_build_object(
        'before', cutoff,
        'seat_assignments', n_assignments,
        'change_requests', n_requests,
        'reservations', n_reservations,
        'audit_logs', n_audit,
        'notifications', n_notifications,
        'login_history', n_logins,
        'personnel_moves', n_personnel,
        'removed_seats', n_seats);
    INSERT INTO audit_logs (actor_id, action, target_type, after_data)
    VALUES (NULL, 'HISTORY_PURGE', 'system', result);
    RETURN result;
END $$;
