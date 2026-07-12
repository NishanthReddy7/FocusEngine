"""Domain layer: pure business logic with no FastAPI/SQLAlchemy imports.

The only cross-layer coupling allowed here is to ``app.schemas`` (the wire
contract) and to abstract ports; concrete persistence lives in the service and
router layers (ARCHITECTURE §5).
"""
