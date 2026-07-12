"""Intention-loop stub — ARCHITECTURE.md §6 (canned coaching, honest MVP boundary).

``ai_feedback`` is a canned string, not a model call — see the ``TODO(LLM)``
below. Still a fully server-stamped, oplog-replicated create like every other
entity write, via the same :func:`apply_op` merge path.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import CurrentUser, get_current_user, get_db, get_hlc_clock, get_notifier
from app.models.review import DailyReview as DailyReviewModel
from app.schemas.enums import EntityType, SyncOpType
from app.schemas.hlc import HybridLogicalClock
from app.schemas.review import DailyReview, DailyReviewCreate
from app.schemas.sync import SyncOp
from app.services.sync import SERVER_DEVICE_ID, SyncNotifier, apply_op, notify_user

# Router-level dependency: every insights route requires a valid bearer token (A2).
router = APIRouter(prefix="/insights", tags=["insights"], dependencies=[Depends(get_current_user)])

DbSession = Annotated[AsyncSession, Depends(get_db)]
HlcClock = Annotated[HybridLogicalClock, Depends(get_hlc_clock)]
Notifier = Annotated[SyncNotifier, Depends(get_notifier)]

# TODO(LLM): replace with a real model call once an LLM integration lands.
# A canned response keeps the intention-loop MVP fully functional offline,
# matching this deliverable's explicitly-scoped stub boundary (plan §"Not
# included by design").
_CANNED_FEEDBACK = (
    "Nice work logging today. Notice what gave you energy and what drained "
    "it, and protect tomorrow's first focus block for your highest-priority task."
)


@router.post("/daily-review", response_model=DailyReview, status_code=status.HTTP_201_CREATED)
async def create_daily_review(
    payload: DailyReviewCreate, session: DbSession, current_user: CurrentUser, hlc_clock: HlcClock, notifier: Notifier
) -> DailyReviewModel:
    """``POST /insights/daily-review``: owner-scoped create with a canned ``ai_feedback`` stub (A3)."""
    hlc = hlc_clock.tick()
    data = payload.model_dump(mode="json")
    data["ai_feedback"] = _CANNED_FEEDBACK
    op = SyncOp(
        op_id=f"{hlc}:daily_review:{data['id']}",
        entity=EntityType.DAILY_REVIEW,
        entity_id=payload.id,
        op=SyncOpType.CREATE,
        patch=data,
        hlc=hlc,
        device_id=SERVER_DEVICE_ID,
    )
    await apply_op(session, op, user_id=current_user.id, hlc_clock=hlc_clock)
    await session.commit()
    await notify_user(notifier, session, current_user.id)
    row = await session.get(DailyReviewModel, str(payload.id))
    assert row is not None  # apply_op's fresh-insert path always populates this id.
    return row
