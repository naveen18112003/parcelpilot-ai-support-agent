"""
Tool 3: State-Changing Actions (with confirmation gate)

All actions are staged first — the agent returns a pending_action to the
frontend, which renders a confirmation dialog. Only after the user confirms
does the frontend call /api/confirm-action, which calls execute() here.

Supported actions:
  - create_escalation   : Create a support escalation ticket
  - update_ticket       : Update an existing ticket (status, notes, priority)
  - create_followup     : Create a follow-up task for the support team
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Optional

from app.data.auth import UserContext, is_internal

# ---------------------------------------------------------------------------
# In-memory "database" of actions (mocked — replace with real DB in prod)
# ---------------------------------------------------------------------------
_escalations: list[dict] = []
_followup_tasks: list[dict] = []
_ticket_updates: list[dict] = []


TOOL_NAME = "action"
TOOL_DESCRIPTION = (
    "Perform state-changing actions such as creating an escalation, updating a ticket, "
    "or creating a follow-up task. Actions require explicit user confirmation before execution."
)


# ---------------------------------------------------------------------------
# Stage (prepare) an action — returns a preview without executing
# ---------------------------------------------------------------------------

def stage_action(
    user: UserContext,
    action_type: str,
    params: dict[str, Any],
) -> dict:
    """
    Prepare an action for confirmation. Returns a pending_action dict that
    the agent includes in its response. The frontend renders a confirmation UI.
    """
    action_id = str(uuid.uuid4())[:8]
    staged = {
        "action_id": action_id,
        "action_type": action_type,
        "staged_by": user.user_id,
        "staged_at": datetime.utcnow().isoformat(),
        "params": params,
        "status": "pending_confirmation",
        "preview": _generate_preview(action_type, params, user),
    }
    return staged


def _generate_preview(action_type: str, params: dict, user: UserContext) -> str:
    if action_type == "create_escalation":
        return (
            f"Create escalation for ticket {params.get('ticket_id', 'N/A')} "
            f"(account: {params.get('account_id', 'N/A')}) "
            f"with reason: \"{params.get('reason', '')}\" "
            f"and priority: {params.get('priority', 'medium')}."
        )
    elif action_type == "update_ticket":
        changes = ", ".join(f"{k}={v}" for k, v in params.get("updates", {}).items())
        return f"Update ticket {params.get('ticket_id', 'N/A')}: {changes}."
    elif action_type == "create_followup":
        return (
            f"Create follow-up task: \"{params.get('title', '')}\" "
            f"assigned to {params.get('assignee', 'support team')} "
            f"for account {params.get('account_id', 'N/A')}."
        )
    return f"Execute {action_type} with params: {params}"


# ---------------------------------------------------------------------------
# Execute a confirmed action
# ---------------------------------------------------------------------------

def execute_action(
    user: UserContext,
    action_type: str,
    params: dict[str, Any],
) -> dict:
    """Execute the confirmed action and return result."""
    action_id = str(uuid.uuid4())[:8]
    timestamp = datetime.utcnow().isoformat()

    if action_type == "create_escalation":
        record = {
            "escalation_id": f"ESC-{action_id.upper()}",
            "ticket_id": params.get("ticket_id"),
            "account_id": params.get("account_id"),
            "reason": params.get("reason", ""),
            "priority": params.get("priority", "medium"),
            "notes": params.get("notes", ""),
            "created_by": user.user_id,
            "created_at": timestamp,
            "status": "open",
        }
        _escalations.append(record)
        return {
            "success": True,
            "action_type": "create_escalation",
            "result": record,
            "message": f"Escalation {record['escalation_id']} created successfully.",
        }

    elif action_type == "update_ticket":
        updates = params.get("updates", {})
        record = {
            "update_id": f"UPD-{action_id.upper()}",
            "ticket_id": params.get("ticket_id"),
            "updates_applied": updates,
            "updated_by": user.user_id,
            "updated_at": timestamp,
        }
        _ticket_updates.append(record)
        return {
            "success": True,
            "action_type": "update_ticket",
            "result": record,
            "message": f"Ticket {params.get('ticket_id')} updated: {updates}.",
        }

    elif action_type == "create_followup":
        record = {
            "task_id": f"TASK-{action_id.upper()}",
            "title": params.get("title", "Follow-up required"),
            "description": params.get("description", ""),
            "account_id": params.get("account_id"),
            "ticket_id": params.get("ticket_id"),
            "assignee": params.get("assignee", "support-team"),
            "due_date": params.get("due_date"),
            "created_by": user.user_id,
            "created_at": timestamp,
            "status": "open",
        }
        _followup_tasks.append(record)
        return {
            "success": True,
            "action_type": "create_followup",
            "result": record,
            "message": f"Follow-up task {record['task_id']} created: \"{record['title']}\".",
        }

    return {"success": False, "error": f"Unknown action type: {action_type}"}


# ---------------------------------------------------------------------------
# List stored actions (for internal users)
# ---------------------------------------------------------------------------

def get_escalations(user: UserContext) -> list[dict]:
    if not is_internal(user):
        return [e for e in _escalations if e.get("account_id") == user.account_id]
    return _escalations


def get_followup_tasks(user: UserContext) -> list[dict]:
    if not is_internal(user):
        return [t for t in _followup_tasks if t.get("account_id") == user.account_id]
    return _followup_tasks
