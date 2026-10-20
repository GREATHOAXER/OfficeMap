from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    database_url: str = "postgresql://officemap:officemap@localhost:5432/officemap"
    session_cookie_name: str = "officemap_session"
    session_max_hours: int = 12  # 계속 사용 중이어도 이 시간이 지나면 다시 로그인
    cookie_secure: bool = False


settings = Settings()
