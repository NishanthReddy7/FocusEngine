"""Async SQLAlchemy engine + session factory (sqlite+aiosqlite) — ARCHITECTURE.md §2."""

from __future__ import annotations

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.db.base import Base


def _normalize_async_url(database_url: str) -> str:
    """Coerce a bare Postgres URL to the asyncpg driver (V2_ADDENDUM A4).

    Render's ``fromDatabase`` injects ``postgres://`` / ``postgresql://``
    (no driver), but the async engine needs ``postgresql+asyncpg://``. SQLite
    (``sqlite+aiosqlite://``) and already-qualified URLs pass through unchanged.
    """
    for bare_prefix in ("postgres://", "postgresql://"):
        if database_url.startswith(bare_prefix):
            return "postgresql+asyncpg://" + database_url[len(bare_prefix):]
    return database_url


def create_engine(database_url: str, *, echo: bool = False) -> AsyncEngine:
    """Create the async SQLAlchemy engine for ``database_url``.

    Dev default ``sqlite+aiosqlite:///./focusengine.db``; production is the
    Render Postgres URL, normalized to the asyncpg driver (A4).
    """
    return create_async_engine(_normalize_async_url(database_url), echo=echo)


def create_session_factory(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    """Build a session factory bound to ``engine``.

    ``expire_on_commit=False`` so response schemas can read attributes off a
    session-scoped ORM instance after commit without triggering a reload.
    """
    return async_sessionmaker(engine, expire_on_commit=False)


async def create_all(engine: AsyncEngine) -> None:
    """Create every mapped table (MVP migration strategy — ARCHITECTURE §2).

    Alembic is deferred until auth/multi-tenancy lands (SYNC_STRATEGY §10);
    for the MVP, ``Base.metadata.create_all`` runs once at app startup.
    """
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
