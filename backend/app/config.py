from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    tavily_api_key: str = ""
    ollama_base_url: str = "http://localhost:11434"
    ollama_model: str = "llama3.1"
    database_url: str = "sqlite+aiosqlite:///./aichat.db"
    cors_origins: str = "http://localhost:5173"

    tesseract_cmd: str = ""  # e.g. C:\\Program Files\\Tesseract-OCR\\tesseract.exe
    ocr_languages: str = "eng+kor"
    max_upload_bytes: int = 5 * 1024 * 1024  # 5 MB
    max_attachment_chars: int = 50_000

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


settings = Settings()
