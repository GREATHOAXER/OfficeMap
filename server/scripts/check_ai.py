"""AI 도우미 연결 점검: 설정한 제공처·모델로 아주 짧은 질문을 한 번 보내 본다 (비용은 1원 안팎).

server 디렉토리에서, 또는 배포 서버에서:
    python -m scripts.check_ai
    docker compose run --rm backend python -m scripts.check_ai

막히면 무엇을 고치면 되는지(→)를 찍고 1로 끝난다. 키·비밀번호는 화면에 나오지 않는다. 설정 순서: docs/ai.md
"""

import sys

import anthropic

from app import assistant
from app.config import settings

HINTS = {
    "anthropic": {
        "auth": "API 키가 틀렸거나 지워졌어요. "
        "console.anthropic.com → API Keys에서 새로 만들어 ANTHROPIC_API_KEY에 넣으세요",
        "denied": "이 키로는 쓸 수 없는 모델이거나 작업 공간 권한이 없어요. 키를 만든 작업 공간을 확인하세요",
        "model": "모델 이름을 확인하세요 (AI_MODEL, 비우면 기본값)",
        "network": "서버에서 api.anthropic.com:443으로 나가는 연결이 막혔는지 확인하세요 (보안 그룹 아웃바운드·프록시)",
    },
    "bedrock": {
        "auth": "AWS 자격 증명을 찾지 못했거나 틀렸어요. EC2에 IAM 역할이 붙어 있는지 확인하세요 (docs/ai.md)",
        "denied": "IAM 역할에 bedrock-mantle:CreateInference 권한이 없거나, "
        "Bedrock 콘솔에서 이 모델 사용 신청(모델 액세스)이 안 됐어요 (docs/ai.md)",
        "model": "이 리전에서 쓸 수 없는 모델이에요. AI_MODEL(예: anthropic.claude-opus-5-5)과 AWS_REGION을 확인하세요",
        "network": "서버에서 bedrock-mantle.<리전>.api.aws:443으로 나가는 연결이 막혔는지 확인하세요",
    },
}


def fail(text: str, hint: str | None = None) -> None:
    print(f"  ✘ {text}")
    if hint:
        print(f"    → {hint}")
    sys.exit(1)


def main() -> None:
    status = assistant.status()
    provider = assistant.provider() or "(없음)"
    print(f"AI 도우미 점검: 제공처 {provider} · 모델 {assistant.model() or '-'}")
    if not status["enabled"]:
        reason = status["reason"]
        if reason == "OFF":
            fail("AI 도우미가 꺼져 있어요", "AI_PROVIDER를 anthropic 또는 bedrock으로 정하세요 (docs/ai.md)")
        if reason == "NO_KEY":
            fail(
                "ANTHROPIC_API_KEY가 비어 있어요",
                "Anthropic 콘솔에서 만든 API 키를 deploy/.env(또는 server/.env)에 넣으세요",
            )
        fail(f"모르는 제공처예요: {settings.ai_provider}", "AI_PROVIDER는 anthropic 또는 bedrock")
    if assistant.provider() == "bedrock":
        print(f"  리전 {settings.aws_region}")
    hints = HINTS[assistant.provider()]

    try:
        message = assistant.client_factory().messages.create(
            model=assistant.model(),
            max_tokens=2000,
            output_config={"effort": "low"},
            messages=[{"role": "user", "content": "연결 확인입니다. '확인'이라고만 답하세요."}],
        )
    except anthropic.AuthenticationError:
        fail("인증 실패 (401)", hints["auth"])
    except anthropic.PermissionDeniedError as error:
        fail(f"권한 없음 (403): {error.message}", hints["denied"])
    except anthropic.NotFoundError as error:
        fail(f"모델을 찾지 못함 (404): {error.message}", hints["model"])
    except anthropic.RateLimitError:
        fail("사용량 한도에 걸림 (429)", "잠시 뒤에 다시 하거나 한도(요금제·쿼터)를 확인하세요")
    except anthropic.APIConnectionError as error:
        fail(f"연결 실패: {error.__cause__ or error}", hints["network"])
    except anthropic.APIStatusError as error:
        fail(f"API 오류 ({error.status_code}): {error.message}")
    except Exception as error:  # AWS 자격 증명을 아예 못 찾을 때 등 (botocore)
        fail(f"{type(error).__name__}: {error}", hints["auth"])

    text = "".join(b.text for b in message.content if b.type == "text").strip()
    print(f"  ✔ 응답: {text[:60]!r} (입력 {message.usage.input_tokens} · 출력 {message.usage.output_tokens} 토큰)")
    print("AI 도우미 연결 정상")


if __name__ == "__main__":
    main()
