"""
Authentication and access-control layer.

For the assessment, auth is mocked: the frontend sends a user object in the
request header. In production this would be replaced with real JWT verification.

Roles:
  - customer   : can only see their own account/orders/tickets
  - support    : internal ParcelPilot staff, full read access
  - ops_admin  : full read + can trigger internal analytics

Mock users (used in the demo UI):
  - alice@northstar.com    / customer   / account_id = ACC-001
  - bob@lumenworks.com     / customer   / account_id = ACC-002
  - carol@parcelpilot.com  / support
  - dave@parcelpilot.com   / ops_admin
"""

from __future__ import annotations
from dataclasses import dataclass, field
from typing import Literal

Role = Literal["customer", "support", "ops_admin"]


@dataclass
class UserContext:
    user_id: str
    email: str
    role: Role
    account_id: str | None = None   # only set for customers
    display_name: str = ""


# ---------------------------------------------------------------------------
# Mock user registry  (replace with real DB lookup / JWT decode in prod)
# ---------------------------------------------------------------------------
MOCK_USERS: dict[str, UserContext] = {
    "alice": UserContext(
        user_id="alice",
        email="alice@northstar.com",
        role="customer",
        account_id="ACC-001",
        display_name="Alice (Northstar Logistics)",
    ),
    "bob": UserContext(
        user_id="bob",
        email="bob@lumenworks.com",
        role="customer",
        account_id="ACC-002",
        display_name="Bob (LumenWorks)",
    ),
    "carol": UserContext(
        user_id="carol",
        email="carol@parcelpilot.com",
        role="support",
        display_name="Carol (Support Agent)",
    ),
    "dave": UserContext(
        user_id="dave",
        email="dave@parcelpilot.com",
        role="ops_admin",
        display_name="Dave (Ops Admin)",
    ),
}


def get_user(user_id: str) -> UserContext | None:
    return MOCK_USERS.get(user_id)


def is_internal(user: UserContext) -> bool:
    return user.role in ("support", "ops_admin")


def can_access_account(user: UserContext, account_id: str) -> bool:
    """Customers can only access their own account. Internal staff can access any."""
    if is_internal(user):
        return True
    return user.account_id == account_id


def can_access_order(user: UserContext, order_account_id: str) -> bool:
    return can_access_account(user, order_account_id)


def can_access_ticket(user: UserContext, ticket_account_id: str) -> bool:
    return can_access_account(user, ticket_account_id)
