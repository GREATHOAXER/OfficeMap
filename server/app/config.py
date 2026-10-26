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


settings = Settings()
