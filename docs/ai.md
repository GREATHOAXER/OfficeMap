# AI 도우미 (Claude)

직원이 말로 물으면 회사 데이터를 찾아 답합니다. 모델은 Anthropic의 Claude(기본 Claude Opus 5.5)이고, Anthropic API나
Amazon Bedrock 중 하나로 부릅니다.

| 어디서 | 할 수 있는 것 |
|---|---|
| 자리·재실 현황 → 머리글의 **AI 도우미** (또는 왼쪽 메뉴) | "재무팀 조시우 대리 지금 자리에 있어?", "지금 7층에서 비어 있는 회의실", "법인카드 정산 누가 해?", "내일 10시에 6명 회의할 곳 잡아줘" |
| 회의실 확인·예약 → 예약하기 → **AI 추천** | "김민준·이서연이랑 오늘 1시간 회의" → 참석자 일정과 빈 회의실을 보고 후보를 보여 주고, 누르면 폼을 채움 |

```
화면 ──질문──▶ POST /api/ai/chat (server/app/routers/ai.py)
                 └ assistant.run_turn (server/app/assistant.py) ◀──▶ Claude (Anthropic API 또는 Bedrock)
                     모델이 도구를 부르면 질문한 사람으로 DB를 읽어 돌려준다:
                     search_people · find_free_rooms · room_schedule · people_schedules · find_duty_owner
                     propose_reservation → 화면에 "예약 후보" 카드 (사람이 '예약하기'를 눌러야 예약됨)
```

- **예약을 직접 하지 않습니다.** 후보 카드만 보여 주고, 예약은 사람이 카드의 "예약하기"(또는 예약 폼의 "예약 확정")를 눌러야
  평소 예약 API로 잡힙니다.
- AI가 읽는 정보는 질문한 사람이 앱에서 이미 볼 수 있는 것뿐입니다 (사람 검색, 회의실 현황, 회의·휴가 일정, 업무분장표).
- 답은 글자가 생기는 대로 흘러나옵니다(스트리밍). 대화는 탭을 닫기 전까지 이어지고, "새 대화"로 새로 시작합니다.

## 켜기 (둘 중 하나)

AI를 켜지 않으면 화면에 "준비 중"으로 보이고 나머지 기능은 그대로 씁니다.

### A. Amazon Bedrock — 키 없이 회사 AWS 계정으로 (권장)

EC2 서버의 IAM 역할로 부르므로 비밀 키를 어디에도 저장하지 않고, 요금도 AWS 청구서에 함께 나옵니다.

1. **모델 사용 신청**: AWS 콘솔(리전 서울) → Amazon Bedrock → **모델 액세스(Model access)** → Anthropic
   **Claude Opus 5.5**가 "액세스 권한 부여됨"인지 확인. 아니면 사용 신청(처음이면 사용 목적 양식)을 냅니다.
2. **서버 역할에 권한**: EC2에 붙은 역할(자동 배포를 설정했다면 `officemap-ec2`)에
   [`deploy/aws/bedrock-claude-policy.json`](../deploy/aws/bedrock-claude-policy.json) (`bedrock-mantle:CreateInference`)을
   붙입니다. CloudShell에서:
   ```bash
   git clone --depth 1 https://github.com/GREATHOAXER/OfficeMap.git && cd OfficeMap
   aws iam put-role-policy --role-name officemap-ec2 --policy-name officemap-bedrock \
     --policy-document file://deploy/aws/bedrock-claude-policy.json
   ```
   EC2에 아직 역할이 없으면 [`deploy/aws/setup-cicd.sh`](../deploy/aws/setup-cicd.sh)가 `officemap-ec2`를 만들어 붙입니다
   ([docs/cicd.md 1](cicd.md#1-aws-쪽-만들기-cloudshell에서-스크립트-한-번)). 그 뒤 위 명령을 실행합니다.
3. **서버 설정**: `deploy/.env`에 `AI_PROVIDER=bedrock` (리전은 기본 `ap-northeast-2`).
4. 아래 "확인"으로 점검합니다.

서울 리전의 Bedrock Claude는 **글로벌 엔드포인트**로만 제공되어, 요청이 다른 나라 리전에서 처리될 수 있습니다.
국내 처리만 허용된다면 정보보호팀과 먼저 정해야 합니다.

### B. Anthropic API — API 키로

1. [console.anthropic.com](https://console.anthropic.com/) → 결제(크레딧) 등록 → **API Keys → Create Key**.
2. `deploy/.env`에:
   ```
   AI_PROVIDER=anthropic
   ANTHROPIC_API_KEY=sk-ant-...
   ```
   키는 이 파일에만 둡니다 (git·채팅·메신저에 붙여 넣지 않기). 새어 나갔으면 콘솔에서 바로 지우고 새로 만듭니다.
3. 아래 "확인"으로 점검합니다.

질문과 답에 필요한 회사 정보(이름·자리·일정)가 Anthropic(미국)으로 전송됩니다. 화면의 입력창 아래에도 그렇게 안내합니다.

### 확인

```bash
cd ~/OfficeMap/deploy
docker compose run --rm backend python -m scripts.init_db --only 13_ai_chat.sql   # 이 버전을 처음 올릴 때 한 번 (대화 기록 열)
docker compose up -d                                                              # .env를 바꿨으면 다시 띄우기
docker compose run --rm backend python -m scripts.check_ai                         # "AI 도우미 연결 정상"이 나와야 함
```

`check_ai`는 짧은 질문을 한 번 보내 보고, 막히면 고칠 곳(→)을 알려 줍니다:

| check_ai 결과 | 확인 |
|---|---|
| AI 도우미가 꺼져 있어요 | `deploy/.env`의 `AI_PROVIDER` |
| 인증 실패 (401) | Anthropic: 키가 틀림·지워짐. Bedrock: EC2에 IAM 역할이 붙어 있는지 |
| 권한 없음 (403) | Bedrock: 역할에 `bedrock-mantle:CreateInference`, 모델 액세스 신청 |
| 모델을 찾지 못함 (404) | `AI_MODEL`, Bedrock이면 `AWS_REGION` |
| `Could not resolve AWS credentials` | Bedrock: EC2 → 인스턴스 → 보안 탭에 IAM 역할이 없음 |
| 연결 실패 | 서버에서 밖(443)으로 나가는 연결 |

## 설정값 (`deploy/.env`, 로컬 개발은 `server/.env`)

| 이름 | 기본 | 뜻 |
|---|---|---|
| `AI_PROVIDER` | (비움 = 끔) | `anthropic` 또는 `bedrock` |
| `ANTHROPIC_API_KEY` | | `anthropic`일 때 API 키 |
| `AWS_REGION` | `ap-northeast-2` | `bedrock`일 때 리전 |
| `AI_MODEL` | `claude-opus-5-5` / `anthropic.claude-opus-5-5` | 모델 |
| `AI_EFFORT` | `medium` | 얼마나 꼼꼼히 생각할지: `low`(빠르고 쌈) · `medium` · `high` |
| `AI_HOURLY_LIMIT` | `60` | 한 사람이 한 시간에 보낼 수 있는 질문 수 |

## 비용

Claude Opus 5.5 기준 Anthropic API 요금은 입력 100만 토큰당 4달러, 출력 100만 토큰당 20달러입니다(Bedrock은 AWS 요금표).
질문 하나에 도구를 2~4번 쓰면 입력 1~2만 토큰(앞부분은 캐시로 싸게), 출력 수백~천여 토큰이라 **대략 질문당 50~150원**입니다.
줄이려면 `AI_EFFORT=low`, 더 줄이려면 `AI_MODEL=claude-sonnet-5-5`(Bedrock은 `anthropic.claude-sonnet-5-5`, 절반 값)를
써 보고 답 품질을 확인하세요.

쓴 양은 DB에 남습니다 (답 하나마다 토큰 수):

```sql
SELECT date_trunc('day', m.created_at) AS day, count(DISTINCT c.id) AS conversations,
       sum(m.input_tokens) AS input_tokens, sum(m.output_tokens) AS output_tokens
FROM ai_messages m JOIN ai_conversations c ON c.id = m.conversation_id
WHERE m.role = 'ASSISTANT' GROUP BY 1 ORDER BY 1 DESC LIMIT 14;
```

## 기록·보안

- 대화는 `ai_conversations`·`ai_messages`에 남습니다 (질문, 답, AI가 부른 도구와 결과). 지금은 자동으로 지우지 않으니,
  실제 데이터를 넣기 전에 보관 기간을 정보보호팀과 정합니다.
- 직원이 "내 정보"에 적은 글(하는 일 등)도 검색 결과로 모델에 들어갑니다. 그 글에 엉뚱한 지시가 섞여 있어도 AI가 할 수 있는
  일은 읽기와 후보 보여 주기뿐이라 데이터가 바뀌지는 않습니다.
- 다른 사람의 대화는 볼 수도 이어 쓸 수도 없습니다. 같은 대화에 두 탭에서 동시에 물으면 하나는 기다리게 합니다.

## 개발

- 로컬: `server/.env`에 `AI_PROVIDER=anthropic`, `ANTHROPIC_API_KEY=...` → API 서버를 다시 켭니다. `python -m scripts.check_ai`로 확인.
- 코드: 도구·지시문·대화 저장은 `server/app/assistant.py`, API는 `server/app/routers/ai.py`,
  화면은 `frontend/src/app/(app)/AiPanel.tsx`(패널)·`frontend/src/app/(app)/rooms/AiSuggest.tsx`(예약 폼)·`frontend/src/lib/ai.ts`.
- 도구를 더하려면 `assistant.py`의 `TOOLS`에 pydantic 입력 모델·함수·설명을 더합니다. 입력 스키마는 모델에서 만들어집니다.
