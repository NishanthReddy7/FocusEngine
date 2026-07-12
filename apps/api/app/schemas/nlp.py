"""NLP capture metadata value object — ARCHITECTURE.md §4.2."""

from __future__ import annotations

from typing import Any

from pydantic import Field

from app.schemas.base import FEBase
from app.schemas.enums import CaptureSource


class NLPMetadata(FEBase):
    """Provenance of a task captured via the quick-add / voice parser."""

    raw_input: str
    source: CaptureSource = CaptureSource.TEXT
    # e.g. {"date_text": "tomorrow at 4pm", "priority_text": "p1"}
    extracted: dict[str, Any] = Field(default_factory=dict)
    confidence: float = Field(default=1.0, ge=0.0, le=1.0)
    parser_version: str = "1.0.0"
