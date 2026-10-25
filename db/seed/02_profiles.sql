-- 02_profiles.sql
-- 목업 "내 정보" 몇 명: 직원 검색에서 하는 일·업무 키워드로 찾아 보는 용도 (사진은 비워 둔다)

INSERT INTO employee_profiles (employee_id, display_name, headline, duties, skills)
SELECT e.id, p.display_name, p.headline, p.duties, p.skills
FROM (VALUES
    ('20190005', NULL, '재무팀 경비·정산 담당',
     '법인카드 사용 내역 정산, 출장비·경비 지급, 세금계산서 발행과 수취를 맡고 있어요. 월말 결산 때 경비 마감도 합니다.',
     ARRAY['법인카드', '경비 정산', '세금계산서', '출장비']),
    ('20150004', 'Seoyeon', '재무팀 예산 담당',
     '부서 예산 편성·배정과 집행 점검, 분기 예산 보고서를 만들어요.',
     ARRAY['예산', '예산 편성', '집행 점검']),
    ('20170008', 'Minjun', '결제망 API 연동',
     '참가기관 결제망 API 연동 지원과 장애 1차 대응, 개발 서버 계정 발급을 합니다.',
     ARRAY['결제망', 'API', '장애 대응', '서버 계정']),
    ('20130003', NULL, 'IT운영팀 인프라',
     '사내 네트워크·VPN, 노트북 반출입 승인, 보안 USB 발급을 맡고 있어요.',
     ARRAY['VPN', '네트워크', '보안 USB', '노트북'])
) AS p(emp_no, display_name, headline, duties, skills)
JOIN employees e ON e.emp_no = p.emp_no;
