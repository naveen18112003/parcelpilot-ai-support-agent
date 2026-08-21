"""
Tool 2: Structured Data Lookup & Calculation

Queries accounts, orders, and tickets from the Excel workbook.
All access is gated through the UserContext — customers can only
see their own data. Internal users see everything.

Operations:
  - get_account(account_id)
  - get_orders(account_id, order_id=None)
  - get_tickets(account_id, ticket_id=None)
  - calculate_sla_breach(ticket_id)
  - calculate_cancellation_fee(order_id)
  - get_summary_stats()   [internal only]
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta
from typing import Optional, Any

import pandas as pd

from app.data.loader import get_accounts, get_orders, get_tickets, get_snapshot_time, df_to_records
from app.data.auth import UserContext, can_access_account, is_internal


TOOL_NAME = "data_lookup"
TOOL_DESCRIPTION = (
    "Look up structured data: accounts, orders, and support tickets. "
    "Can also calculate whether an SLA has been breached, estimate cancellation fees, "
    "and return summary statistics for internal users. "
    "Access is automatically scoped to the requesting user's account."
)


class AccessDeniedError(Exception):
    pass


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _parse_snapshot() -> datetime:
    ts = get_snapshot_time()
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(ts, fmt)
        except ValueError:
            pass
    return datetime.now()


def _find_col(df: pd.DataFrame, *candidates: str) -> Optional[str]:
    """Return the first column name from candidates that exists in df."""
    cols_lower = {c.lower(): c for c in df.columns}
    for cand in candidates:
        if cand.lower() in cols_lower:
            return cols_lower[cand.lower()]
    return None


# ---------------------------------------------------------------------------
# Account lookup
# ---------------------------------------------------------------------------

def get_account(user: UserContext, account_id: str) -> dict:
    if not can_access_account(user, account_id):
        raise AccessDeniedError(f"User {user.user_id} cannot access account {account_id}")

    df = get_accounts()
    if df.empty:
        return {"error": "Account data unavailable"}

    id_col = _find_col(df, "account_id", "id", "accountid")
    if id_col is None:
        return {"error": "Account ID column not found in data"}

    mask = df[id_col].astype(str).str.upper() == account_id.upper()
    rows = df[mask]
    if rows.empty:
        return {"error": f"Account {account_id} not found"}

    return {"account": df_to_records(rows)[0]}


# ---------------------------------------------------------------------------
# Order lookup
# ---------------------------------------------------------------------------

def get_orders_for(
    user: UserContext,
    account_id: Optional[str] = None,
    order_id: Optional[str] = None,
) -> dict:
    # Determine which account to scope to
    if account_id is None:
        if user.role == "customer":
            account_id = user.account_id
        # internal user with no account_id specified → all orders

    if account_id and not can_access_account(user, account_id):
        raise AccessDeniedError(f"User {user.user_id} cannot access account {account_id}")

    df = get_orders()
    if df.empty:
        return {"orders": [], "count": 0}

    # Filter by account
    if account_id:
        acct_col = _find_col(df, "account_id", "accountid", "account")
        if acct_col:
            df = df[df[acct_col].astype(str).str.upper() == account_id.upper()]

    # Filter by order_id
    if order_id:
        ord_col = _find_col(df, "order_id", "orderid", "id")
        if ord_col:
            df = df[df[ord_col].astype(str).str.upper() == order_id.upper()]

    records = df_to_records(df)
    return {"orders": records, "count": len(records)}


# ---------------------------------------------------------------------------
# Ticket lookup
# ---------------------------------------------------------------------------

def get_tickets_for(
    user: UserContext,
    account_id: Optional[str] = None,
    ticket_id: Optional[str] = None,
) -> dict:
    if account_id is None:
        if user.role == "customer":
            account_id = user.account_id

    if account_id and not can_access_account(user, account_id):
        raise AccessDeniedError(f"User {user.user_id} cannot access account {account_id}")

    df = get_tickets()
    if df.empty:
        return {"tickets": [], "count": 0}

    if account_id:
        acct_col = _find_col(df, "account_id", "accountid", "account")
        if acct_col:
            df = df[df[acct_col].astype(str).str.upper() == account_id.upper()]

    if ticket_id:
        tkt_col = _find_col(df, "ticket_id", "ticketid", "id")
        if tkt_col:
            df = df[df[tkt_col].astype(str).str.upper() == ticket_id.upper()]

    records = df_to_records(df)
    return {"tickets": records, "count": len(records)}


# ---------------------------------------------------------------------------
# SLA breach calculation
# ---------------------------------------------------------------------------

def calculate_sla_breach(user: UserContext, ticket_id: str) -> dict:
    """
    Determines whether a ticket has breached its SLA.
    Returns breach status, hours elapsed, and hours remaining.
    """
    df = get_tickets()
    if df.empty:
        return {"error": "Ticket data unavailable"}

    tkt_col = _find_col(df, "ticket_id", "ticketid", "id")
    if tkt_col is None:
        return {"error": "Ticket ID column not found"}

    mask = df[tkt_col].astype(str).str.upper() == ticket_id.upper()
    rows = df[mask]
    if rows.empty:
        return {"error": f"Ticket {ticket_id} not found"}

    ticket = df_to_records(rows)[0]

    # Verify access
    acct_col = _find_col(df, "account_id", "accountid")
    ticket_account = ticket.get(acct_col or "account_id", "")
    if ticket_account and not can_access_account(user, str(ticket_account)):
        raise AccessDeniedError(f"User {user.user_id} cannot access ticket {ticket_id}")

    # Parse dates
    created_col = _find_col(df, "created_at", "created_date", "createdat", "date_created")
    priority_col = _find_col(df, "priority", "severity", "sla_tier")
    status_col = _find_col(df, "status", "ticket_status")
    resolved_col = _find_col(df, "resolved_at", "resolved_date", "date_resolved")

    snapshot = _parse_snapshot()

    created_raw = ticket.get(created_col) if created_col else None
    created_dt = None
    if created_raw:
        try:
            created_dt = datetime.fromisoformat(str(created_raw))
        except Exception:
            pass

    resolved_raw = ticket.get(resolved_col) if resolved_col else None
    resolved_dt = None
    if resolved_raw:
        try:
            resolved_dt = datetime.fromisoformat(str(resolved_raw))
        except Exception:
            pass

    # SLA hours by priority (defaults from Support Policy v3)
    priority = str(ticket.get(priority_col, "medium")).lower() if priority_col else "medium"
    SLA_HOURS = {"critical": 4, "high": 8, "medium": 24, "low": 48, "p1": 4, "p2": 8, "p3": 24, "p4": 48}
    sla_hours = SLA_HOURS.get(priority, 24)

    status = str(ticket.get(status_col, "open")).lower() if status_col else "open"
    reference_dt = resolved_dt if (resolved_dt and "resolved" in status) else snapshot

    result = {
        "ticket_id": ticket_id,
        "priority": priority,
        "sla_hours_target": sla_hours,
        "status": status,
        "ticket_data": ticket,
    }

    if created_dt:
        elapsed_hours = (reference_dt - created_dt).total_seconds() / 3600
        sla_deadline = created_dt + timedelta(hours=sla_hours)
        breached = elapsed_hours > sla_hours and "resolved" not in status
        result.update({
            "created_at": created_dt.isoformat(),
            "snapshot_time": snapshot.isoformat(),
            "elapsed_hours": round(elapsed_hours, 2),
            "sla_deadline": sla_deadline.isoformat(),
            "hours_remaining": round(sla_hours - elapsed_hours, 2),
            "sla_breached": breached,
            "breach_severity": (
                "critical" if elapsed_hours > sla_hours * 2
                else "warning" if elapsed_hours > sla_hours * 0.8
                else "ok"
            ),
        })
    else:
        result["note"] = "Could not parse ticket creation date for SLA calculation"

    return result


# ---------------------------------------------------------------------------
# Cancellation fee calculation
# ---------------------------------------------------------------------------

def calculate_cancellation_fee(user: UserContext, order_id: str) -> dict:
    """
    Looks up an order and determines if a cancellation fee applies,
    based on order status and carrier pick-up.
    The actual fee rules come from the SOP; this tool provides the data context.
    """
    df = get_orders()
    if df.empty:
        return {"error": "Order data unavailable"}

    ord_col = _find_col(df, "order_id", "orderid", "id")
    if ord_col is None:
        return {"error": "Order ID column not found"}

    mask = df[ord_col].astype(str).str.upper() == order_id.upper()
    rows = df[mask]
    if rows.empty:
        return {"error": f"Order {order_id} not found"}

    order = df_to_records(rows)[0]

    # Verify access
    acct_col = _find_col(df, "account_id", "accountid", "account")
    order_account = order.get(acct_col or "account_id", "")
    if order_account and not can_access_account(user, str(order_account)):
        raise AccessDeniedError(f"User {user.user_id} cannot access order {order_id}")

    # Determine pickup status from order data
    status_col = _find_col(df, "status", "order_status")
    pickup_col = _find_col(df, "pickup_status", "carrier_pickup", "pickup")
    carrier_col = _find_col(df, "carrier", "carrier_name")
    value_col = _find_col(df, "order_value", "value", "amount", "shipment_value")

    status = str(order.get(status_col, "unknown")).lower() if status_col else "unknown"
    pickup_status = str(order.get(pickup_col, "unknown")).lower() if pickup_col else "unknown"

    # Heuristics based on SOP v4 rules:
    # - No fee if carrier has not yet picked up
    # - Fee applies if already picked up (typically 15% or flat)
    # - No fee if ParcelPilot/carrier at fault
    picked_up = any(k in pickup_status for k in ["picked", "in_transit", "collected", "yes"])
    already_delivered = any(k in status for k in ["delivered", "completed"])

    result = {
        "order_id": order_id,
        "order_data": order,
        "status": status,
        "pickup_status": pickup_status,
        "picked_up": picked_up,
        "already_delivered": already_delivered,
        "note": (
            "Order already delivered — cancellation not possible."
            if already_delivered
            else (
                "Carrier has picked up — cancellation fee likely applies per SOP. "
                "Check SOP v4 and customer agreement for exact fee."
                if picked_up
                else "Carrier has not yet picked up — cancellation fee likely does not apply per SOP. "
                     "Verify with SOP v4 and customer agreement."
            )
        ),
    }

    if value_col and order.get(value_col):
        try:
            val = float(str(order[value_col]).replace(",", "").replace("$", ""))
            result["order_value"] = val
            result["estimated_fee_if_applicable"] = round(val * 0.15, 2)
        except Exception:
            pass

    return result


# ---------------------------------------------------------------------------
# Summary stats (internal only)
# ---------------------------------------------------------------------------

def get_summary_stats(user: UserContext) -> dict:
    if not is_internal(user):
        raise AccessDeniedError("Summary statistics are only available to internal users.")

    orders_df = get_orders()
    tickets_df = get_tickets()
    accounts_df = get_accounts()

    result: dict[str, Any] = {
        "snapshot_time": get_snapshot_time(),
        "total_accounts": len(accounts_df),
        "total_orders": len(orders_df),
        "total_tickets": len(tickets_df),
    }

    if not tickets_df.empty:
        status_col = _find_col(tickets_df, "status", "ticket_status")
        priority_col = _find_col(tickets_df, "priority", "severity")

        if status_col:
            result["tickets_by_status"] = tickets_df[status_col].value_counts().to_dict()
        if priority_col:
            result["tickets_by_priority"] = tickets_df[priority_col].value_counts().to_dict()

    if not orders_df.empty:
        status_col = _find_col(orders_df, "status", "order_status")
        if status_col:
            result["orders_by_status"] = orders_df[status_col].value_counts().to_dict()

    return result


# ---------------------------------------------------------------------------
# Dispatcher (called from agent)
# ---------------------------------------------------------------------------

def run(user: UserContext, operation: str, **kwargs) -> dict:
    """
    Dispatch to the appropriate data lookup function.

    Operations:
      get_account, get_orders, get_tickets,
      calculate_sla_breach, calculate_cancellation_fee, get_summary_stats
    """
    ops = {
        "get_account": lambda: get_account(user, kwargs.get("account_id", user.account_id or "")),
        "get_orders": lambda: get_orders_for(
            user,
            account_id=kwargs.get("account_id"),
            order_id=kwargs.get("order_id"),
        ),
        "get_tickets": lambda: get_tickets_for(
            user,
            account_id=kwargs.get("account_id"),
            ticket_id=kwargs.get("ticket_id"),
        ),
        "calculate_sla_breach": lambda: calculate_sla_breach(user, kwargs["ticket_id"]),
        "calculate_cancellation_fee": lambda: calculate_cancellation_fee(user, kwargs["order_id"]),
        "get_summary_stats": lambda: get_summary_stats(user),
    }

    if operation not in ops:
        return {"error": f"Unknown operation: {operation}. Valid: {list(ops.keys())}"}

    try:
        return ops[operation]()
    except AccessDeniedError as e:
        return {"error": str(e), "access_denied": True}
    except Exception as e:
        return {"error": f"Data lookup failed: {e}"}
