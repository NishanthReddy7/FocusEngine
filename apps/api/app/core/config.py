"""Runtime settings — ARCHITECTURE.md §2, §5.4.

A single :class:`Settings` object, overridable via ``FE_*`` environment
variables (e.g. ``FE_DATABASE_URL``, ``FE_CORS_ORIGINS``). Tests construct
their own ``Settings(...)`` instances directly (bypassing :func:`get_settings`'s
process-wide cache) so each test can point at an isolated database file.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Annotated

from pydantic import field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


class Settings(BaseSettings):
    """FocusEngine backend configuration."""

    model_config = SettingsConfigDict(env_prefix="FE_", extra="ignore")

    #: SQLAlchemy async URL (V2_ADDENDUM A4). ``FE_DATABASE_URL`` overrides;
    #: defaults to aiosqlite for dev, Render injects
    #: ``postgresql+asyncpg://...``. ``app.db.engine.create_all`` runs at
    #: startup on both (Alembic still deferred — greenfield DB).
    database_url: str = "sqlite+aiosqlite:///./focusengine.db"

    #: Allowed browser origins (V2_ADDENDUM A4: ``FE_CORS_ORIGINS``). Dev
    #: default is the Next.js dev server; production is the Pages origin.
    #: ``NoDecode`` + the validator below accept a bare or comma-separated
    #: string from the environment (Render sets a single origin, not JSON).
    cors_origins: Annotated[list[str], NoDecode] = ["http://localhost:3000"]

    @field_validator("cors_origins", mode="before")
    @classmethod
    def _split_cors_origins(cls, value: object) -> object:
        """Accept ``"a,b"`` (env) or ``["a", "b"]`` (code/default) alike."""
        if isinstance(value, str):
            return [origin.strip() for origin in value.split(",") if origin.strip()]
        return value

    #: HS256 signing secret for our JWTs (V2_ADDENDUM A2: ``FE_JWT_SECRET``).
    #: The dev default keeps the app bootable locally; Render injects a
    #: generated value and tests construct their own ``Settings``.
    jwt_secret: str = "dev-insecure-secret-change-me"

    #: Google OAuth *audience* the ID token must be minted for (A2:
    #: ``FE_GOOGLE_CLIENT_ID``). Empty until the user pastes their client id;
    #: ``POST /auth/google`` then rejects every token (the boundary the tests
    #: mock so they never call Google).
    google_client_id: str = ""

    #: Access-token lifetime in days (A2: 30-day expiry).
    jwt_expiry_days: int = 30


@lru_cache
def get_settings() -> Settings:
    """Process-wide cached :class:`Settings` instance (environment read once)."""
    return Settings()
