from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    database_url: str = "postgresql://officemap:officemap@localhost:5432/officemap"
    session_cookie_name: str = "officemap_session"
    session_max_hours: int = 12  # 계속 사용 중이어도 이 시간이 지나면 다시 로그인
    admin_cookie_name: str = "officemap_admin_session"  # 관리자 페이지 세션은 쿠키부터 따로 쓴다
    admin_session_max_hours: int = 8
    cookie_secure: bool = False
    app_env: str = "development"  # 실제 데이터가 든 서버는 production: DB를 통째로 지우는 init_db --reset을 막는다

    # AI 도우미 (app/assistant.py). ai_provider가 비면 꺼진다
    #   anthropic: Anthropic API (anthropic_api_key)
    #   bedrock:   Amazon Bedrock (서버의 IAM 역할 또는 AWS 키, aws_region)
    ai_provider: str = ""
    ai_model: str = ""  # 비우면 제공처별 기본 모델
    ai_effort: str = "medium"  # low | medium | high: 높을수록 더 꼼꼼히 생각하고 느리고 비싸다
    ai_hourly_limit: int = 60  # 한 사람이 한 시간에 보낼 수 있는 질문 수
    anthropic_api_key: str = ""
    aws_region: str = "ap-northeast-2"


settings = Settings()
