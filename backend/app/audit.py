"""Auditoría: toda edición relevante crea evento con usuario, timestamp y antes/después."""
from sqlalchemy.orm import Session
from app.models import AuditEvent


def record(db: Session, action: str, entity_type: str, entity_id: str,
           actor_id: str = "sistema", before=None, after=None, correlation_id=None):
    event = AuditEvent(
        actor_id=actor_id,
        action=action,
        entity_type=entity_type,
        entity_id=entity_id,
        before_json=before,
        after_json=after,
        correlation_id=correlation_id,
    )
    db.add(event)
    return event
