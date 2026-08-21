"""
Proactive Issue Detection (Problem 1)

Analyses ticket and order data to surface:
  - Tickets approaching or breaching SLA
  - Clusters of similar issues (by keyword grouping)
  - Accounts with high open-ticket volumes
  - Unusual order patterns
  - Multi-customer impacting issues

This is an internal-only tool.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime, timedelta
from typing import Any

from app.data.loader import get_tickets, get_orders, get_snapshot_time, df_to_records
from app.data.auth import UserContext, is_internal


TOOL_NAME = "analytics"
TOOL_DESCRIPTION = (
    "Internal tool: Identifies recurring, urgent, or unusual issues across support "
    "activity. Surfaces SLA breaches, ticket clusters, anomalous patterns, and "
    "multi-customer incidents. Available to authorised ParcelPilot staff only."
)


class AccessDeniedError(Exception):
    pass


def _parse_snapshot() -> datetime:
    ts = get_snapshot_time()
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(ts, fmt)
        except ValueError:
            pass
    return datetime.now()


def _find_col(df, *candidates):
    cols_lower = {c.lower(): c for c in df.columns}
    for cand in candidates:
        if cand.lower() in cols_lower:
            return cols_lower[cand.lower()]
    return None


SLA_HOURS_MAP = {
    "critical": 4, "high": 8, "medium": 24, "low": 48,
    "p1": 4, "p2": 8, "p3": 24, "p4": 48,
}

ISSUE_KEYWORDS = {
    "carrier_delay": ["delay", "late", "pickup", "missed", "slow"],
    "billing": ["billing", "invoice", "charge", "payment", "fee", "credit"],
    "tracking": ["tracking", "track", "location", "update", "status"],
    "cancellation": ["cancel", "cancellation", "refund"],
    "delivery_failure": ["failed delivery", "undelivered", "return", "lost", "damaged"],
    "portal_issues": ["portal", "login", "access", "bug", "error", "crash", "not working"],
    "sla_complaint": ["sla", "breach", "response time", "not heard", "no reply"],
}


def detect_issues(user: UserContext) -> dict[str, Any]:
    """Main entry point for proactive issue detection."""
    if not is_internal(user):
        raise AccessDeniedError("Analytics are only available to internal ParcelPilot users.")

    snapshot = _parse_snapshot()
    tickets_df = get_tickets()
    orders_df = get_orders()

    if tickets_df.empty:
        return {"error": "No ticket data available"}

    tickets = df_to_records(tickets_df)
    orders = df_to_records(orders_df) if not orders_df.empty else []

    results = {
        "snapshot_time": snapshot.isoformat(),
        "sla_at_risk": _find_sla_at_risk(tickets, snapshot),
        "ticket_clusters": _cluster_tickets(tickets),
        "high_volume_accounts": _high_volume_accounts(tickets),
        "multi_customer_issues": _multi_customer_issues(tickets),
        "order_anomalies": _order_anomalies(orders),
        "summary": "",
    }

    # Build text summary
    summary_lines = [f"Issue Detection Report (as of {snapshot.date()})"]
    if results["sla_at_risk"]:
        summary_lines.append(f"  • {len(results['sla_at_risk'])} tickets at SLA risk or breached")
    if results["ticket_clusters"]:
        top = sorted(results["ticket_clusters"], key=lambda x: x["count"], reverse=True)[:3]
        for t in top:
            summary_lines.append(f"  • Issue cluster '{t['category']}': {t['count']} tickets")
    if results["multi_customer_issues"]:
        summary_lines.append(
            f"  • {len(results['multi_customer_issues'])} potential multi-customer issues detected"
        )
    if results["order_anomalies"]:
        summary_lines.append(f"  • {len(results['order_anomalies'])} order anomalies found")

    results["summary"] = "\n".join(summary_lines)
    return results


def _find_sla_at_risk(tickets: list[dict], snapshot: datetime) -> list[dict]:
    at_risk = []
    for t in tickets:
        # Skip resolved tickets
        status = str(t.get("status") or t.get("ticket_status") or "open").lower()
        if "resolved" in status or "closed" in status:
            continue

        priority = str(t.get("priority") or t.get("severity") or "medium").lower()
        sla_hours = SLA_HOURS_MAP.get(priority, 24)

        created_raw = t.get("created_at") or t.get("created_date") or t.get("date_created")
        if not created_raw:
            continue
        try:
            created_dt = datetime.fromisoformat(str(created_raw))
        except Exception:
            continue

        elapsed = (snapshot - created_dt).total_seconds() / 3600
        pct_used = elapsed / sla_hours if sla_hours > 0 else 0

        if pct_used >= 0.75:  # 75%+ of SLA used
            at_risk.append({
                "ticket_id": t.get("ticket_id") or t.get("id"),
                "account_id": t.get("account_id"),
                "priority": priority,
                "sla_hours": sla_hours,
                "elapsed_hours": round(elapsed, 1),
                "pct_sla_used": round(pct_used * 100, 1),
                "breached": elapsed > sla_hours,
                "status": status,
                "subject": t.get("subject") or t.get("description") or "",
            })

    # Sort: breached first, then by % used descending
    at_risk.sort(key=lambda x: (-int(x["breached"]), -x["pct_sla_used"]))
    return at_risk


def _cluster_tickets(tickets: list[dict]) -> list[dict]:
    """Group tickets by keyword category."""
    category_counts: dict[str, list] = defaultdict(list)

    for t in tickets:
        text = " ".join([
            str(t.get("subject") or ""),
            str(t.get("description") or ""),
            str(t.get("resolution") or ""),
        ]).lower()

        matched = False
        for category, keywords in ISSUE_KEYWORDS.items():
            if any(kw in text for kw in keywords):
                category_counts[category].append({
                    "ticket_id": t.get("ticket_id") or t.get("id"),
                    "account_id": t.get("account_id"),
                    "status": t.get("status"),
                    "subject": t.get("subject") or t.get("description") or "",
                })
                matched = True

        if not matched:
            category_counts["other"].append({
                "ticket_id": t.get("ticket_id") or t.get("id"),
                "account_id": t.get("account_id"),
                "status": t.get("status"),
                "subject": t.get("subject") or t.get("description") or "",
            })

    clusters = []
    for cat, items in category_counts.items():
        if len(items) >= 1:
            clusters.append({
                "category": cat,
                "count": len(items),
                "tickets": items[:10],  # cap for display
            })

    clusters.sort(key=lambda x: x["count"], reverse=True)
    return clusters


def _high_volume_accounts(tickets: list[dict]) -> list[dict]:
    """Find accounts with unusually high open ticket volumes."""
    open_counts: Counter = Counter()
    for t in tickets:
        status = str(t.get("status") or "open").lower()
        if "resolved" not in status and "closed" not in status:
            acc = t.get("account_id") or "unknown"
            open_counts[acc] += 1

    if not open_counts:
        return []

    avg = sum(open_counts.values()) / len(open_counts)
    threshold = max(avg * 1.5, 2)

    return [
        {"account_id": acc, "open_tickets": cnt, "above_avg_by": round(cnt - avg, 1)}
        for acc, cnt in open_counts.most_common()
        if cnt >= threshold
    ]


def _multi_customer_issues(tickets: list[dict]) -> list[dict]:
    """Identify issues affecting multiple accounts."""
    keyword_accounts: dict[str, set] = defaultdict(set)

    for t in tickets:
        text = " ".join([
            str(t.get("subject") or ""),
            str(t.get("description") or ""),
        ]).lower()
        acc = t.get("account_id") or "unknown"

        for category, keywords in ISSUE_KEYWORDS.items():
            if any(kw in text for kw in keywords):
                key = f"{category}"
                keyword_accounts[key].add(acc)

    multi = []
    for issue, accounts in keyword_accounts.items():
        if len(accounts) >= 2:
            multi.append({
                "issue_category": issue,
                "affected_accounts": list(accounts),
                "account_count": len(accounts),
            })

    multi.sort(key=lambda x: x["account_count"], reverse=True)
    return multi


def _order_anomalies(orders: list[dict]) -> list[dict]:
    """Find unusual order patterns (e.g., high cancellation rate, stuck orders)."""
    anomalies = []
    status_counts: Counter = Counter()

    for o in orders:
        status = str(o.get("status") or o.get("order_status") or "unknown").lower()
        status_counts[status] += 1

    total = sum(status_counts.values())
    if total == 0:
        return []

    for status, count in status_counts.items():
        rate = count / total
        if status in ("cancelled", "failed", "returned") and rate > 0.1:
            anomalies.append({
                "anomaly_type": f"High {status} rate",
                "count": count,
                "rate_pct": round(rate * 100, 1),
                "note": f"{count} orders ({rate*100:.1f}%) are in '{status}' state.",
            })

    return anomalies


def run(user: UserContext, operation: str = "detect_issues", **kwargs) -> dict:
    try:
        if operation == "detect_issues":
            return detect_issues(user)
        return {"error": f"Unknown analytics operation: {operation}"}
    except AccessDeniedError as e:
        return {"error": str(e), "access_denied": True}
    except Exception as e:
        return {"error": f"Analytics failed: {e}"}
