# FocusEngine API image — V2_ADDENDUM A4.
# Slim CPython 3.12; asyncpg/cryptography ship manylinux wheels so no build
# toolchain is needed. Runs the ASGI factory via uvicorn, honoring Render's $PORT.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=8000

WORKDIR /app

# Project metadata + application package (single layer — deps are resolved from
# pyproject at install time).
COPY pyproject.toml ./
COPY app ./app

RUN pip install --upgrade pip && pip install .

EXPOSE 8000

# --factory: create_app is a factory (A4). Bind 0.0.0.0 and honor $PORT (Render
# assigns it at runtime; default 8000 for a plain `docker run`).
CMD ["sh", "-c", "uvicorn app.main:create_app --factory --host 0.0.0.0 --port ${PORT:-8000}"]
