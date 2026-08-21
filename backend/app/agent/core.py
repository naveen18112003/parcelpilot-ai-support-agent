"""
ParcelPilot AI Agent Core
=========================

Orchestrates multi-step reasoning using the provider-agnostic LLM layer
(app/llm/provider.py).  The concrete LLM is Gemini-2.5-flash by default;
swapping providers requires only an environment-variable change.

What lives here
---------------
  - Tool schema definitions (ToolSchema objects, one per tool)
  - Tool dispatcher (_dispatch_tool) — the ONLY place that touches tool code
  - Agent loop (chat()) — plan → call tools → observe → respond

What does NOT live here
-----------------------
  - Any vendor SDK import (google-genai, openai, etc.) — that's in provider.py
  - RAG / vector search — that's in data/document_store.py
  - Auth / access control — that's in data/auth.py and enforced by each tool
  - Business logic / calculations — that's in tools/data_lookup.py
  - State-changing side-effects — tools stage actions; execution only after
    explicit user confirmation via /api/confirm-action

Logging
-------
  All events are logged via the "parcelPilot.agent" logger.
  The API key and customer PII are NEVER logged.
  Tool args are logged at DEBUG level with PII fields redacted.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any, Optional

from app.data.auth import UserContext, is_internal
from app.data.loader import get_snapshot_time
from app.llm.provider import (
    ConversationTurn,
    LLMResponse,
    ToolCall,
    ToolResult,
    ToolSchema,
    get_provider,
)
from app.tools import document_search, data_lookup, action_tool, analytics
from app.agent.prompts import CUSTOMER_SYSTEM_PROMPT, INTERNAL_SYSTEM_PROMPT

logger = logging.getLogger("parcelPilot.agent")

# ---------------------------------------------------------------------------
# PII fields that must never appear in logs
# ---------------------------------------------------------------------------
_PII_FIELDS = frozenset(
    {"email", "phone", "address", "name", "contact", "customer_name"}
)


def _redact(args: dict) -> dict:
    """Return a copy of args with PII field values replaced by '<redacted>'."""
    return {
        k: ("<redacted>" if k.lower() in _PII_FIELDS else v)
        for k, v in args.items()
    }


# ---------------------------------------------------------------------------
# Tool schemas (provider-agnostic ToolSchema objects)
# ---------------------------------------------------------------------------
#
# These map 1-to-1 to the four tools the assessment requires:
#   1. search_documents              → document_search tool
#   2. lookup_operational_data       → data_lookup tool  (get_account / orders / tickets)
#   3. calculate_service_credit_or_fee → data_lookup tool (calculate_* operations)
#   4. create_escalation             → action tool
#
# The agent also has an analytics tool available to internal users.
# ---------------------------------------------------------------------------

_SCHEMA_DOCUMENT_SEARCH = ToolSchema(
    name="search_documents",
    description=document_search.TOOL_DESCRIPTION,
    parameters={
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Natural-language search query for policies, SOPs, agreements, and product guides.",
            },
            "top_k": {
                "type": "integer",
                "description": "Maximum number of document chunks to return (default 5).",
            },
            "include_deprecated": {
                "type": "boolean",
                "description": "If true, also search deprecated documents (flag results clearly).",
            },
        },
        "required": ["query"],
    },
)

_SCHEMA_LOOKUP_OPERATIONAL_DATA = ToolSchema(
    name="lookup_operational_data",
    description=(
        "Look up structured operational data: accounts, orders, and support tickets. "
        "Access is automatically scoped to the authenticated user's account. "
        "Use this to retrieve order status, account details, or ticket history."
    ),
    parameters={
        "type": "object",
        "properties": {
            "operation": {
                "type": "string",
                "enum": ["get_account", "get_orders", "get_tickets"],
                "description": "Which data entity to retrieve.",
            },
            "account_id": {
                "type": "string",
                "description": "Account ID to look up (optional for customers — auto-scoped).",
            },
            "order_id": {
                "type": "string",
                "description": "Specific order ID to retrieve.",
            },
            "ticket_id": {
                "type": "string",
                "description": "Specific ticket ID to retrieve.",
            },
        },
        "required": ["operation"],
    },
)

_SCHEMA_CALCULATE = ToolSchema(
    name="calculate_service_credit_or_fee",
    description=(
        "Perform deterministic calculations using structured order and ticket data. "
        "Use 'calculate_sla_breach' to determine if a ticket has breached its SLA and by how much. "
        "Use 'calculate_cancellation_fee' to determine whether a cancellation fee applies to an order "
        "based on carrier pickup status and order state. "
        "All arithmetic is performed server-side; the LLM must NOT compute these figures itself."
    ),
    parameters={
        "type": "object",
        "properties": {
            "operation": {
                "type": "string",
                "enum": ["calculate_sla_breach", "calculate_cancellation_fee"],
                "description": "Which calculation to perform.",
            },
            "order_id": {
                "type": "string",
                "description": "Order ID (required for calculate_cancellation_fee).",
            },
            "ticket_id": {
                "type": "string",
                "description": "Ticket ID (required for calculate_sla_breach).",
            },
        },
        "required": ["operation"],
    },
)

_SCHEMA_CREATE_ESCALATION = ToolSchema(
    name="create_escalation",
    description=(
        "Stage a support escalation, ticket update, or follow-up task for user confirmation. "
        "This tool STAGES the action only — it does NOT execute it. "
        "The action will be presented to the user for explicit confirmation before anything changes."
    ),
    parameters={
        "type": "object",
        "properties": {
            "action_type": {
                "type": "string",
                "enum": ["create_escalation", "update_ticket", "create_followup"],
                "description": "The type of action to stage.",
            },
            "params": {
                "type": "object",
                "description": (
                    "Action parameters. For create_escalation: ticket_id, account_id, reason, priority, notes. "
                    "For update_ticket: ticket_id, updates (dict). "
                    "For create_followup: title, description, account_id, ticket_id, assignee, due_date."
                ),
            },
        },
        "required": ["action_type", "params"],
    },
)

_SCHEMA_ANALYTICS = ToolSchema(
    name="analytics",
    description=analytics.TOOL_DESCRIPTION,
    parameters={
        "type": "object",
        "properties": {
            "operation": {
                "type": "string",
                "enum": ["detect_issues"],
                "description": "Analytics operation (default: detect_issues).",
            },
        },
        "required": [],
    },
)

_SCHEMA_SUMMARY_STATS = ToolSchema(
    name="get_summary_stats",
    description=(
        "Return aggregate statistics across all accounts, orders, and tickets. "
        "Internal users only."
    ),
    parameters={
        "type": "object",
        "properties": {},
        "required": [],
    },
)

# Tool lists per role
_TOOLS_CUSTOMER: list[ToolSchema] = [
    _SCHEMA_DOCUMENT_SEARCH,
    _SCHEMA_LOOKUP_OPERATIONAL_DATA,
    _SCHEMA_CALCULATE,
    _SCHEMA_CREATE_ESCALATION,
]

_TOOLS_INTERNAL: list[ToolSchema] = [
    _SCHEMA_DOCUMENT_SEARCH,
    _SCHEMA_LOOKUP_OPERATIONAL_DATA,
    _SCHEMA_CALCULATE,
    _SCHEMA_CREATE_ESCALATION,
    _SCHEMA_ANALYTICS,
    _SCHEMA_SUMMARY_STATS,
]


# ---------------------------------------------------------------------------
# Tool dispatcher
# ---------------------------------------------------------------------------

def _dispatch_tool(
    tool_name: str,
    args: dict,
    user: UserContext,
) -> tuple[dict, bool]:
    """
    Execute a backend tool and return (result_dict, is_pending_action).

    is_pending_action=True means the tool staged an action that needs
    explicit user confirmation before execution — the agent loop stops
    and returns control to the frontend.

    IMPORTANT: This function is the enforcement boundary.
    - The LLM decides *which* tool to call and *what args* to pass.
    - This function decides *how* to call the backend, enforces auth,
      and ensures calculations are always done server-side.
    - Gemini never touches the database, auth layer, or calculations directly.
    """
    logger.info(
        "[dispatcher] tool=%s user=%s args=%s",
        tool_name,
        user.user_id,
        json.dumps(_redact(args)),
    )

    # ---- Tool 1: Document search ----------------------------------------
    if tool_name == "search_documents":
        result = document_search.run(
            query=args.get("query", ""),
            account_id=user.account_id,
            top_k=int(args.get("top_k", 5)),
            include_deprecated=bool(args.get("include_deprecated", False)),
        )
        logger.debug(
            "[dispatcher] search_documents → %d chunks", len(result.get("results", []))
        )
        return result, False

    # ---- Tool 2: Operational data lookup --------------------------------
    if tool_name == "lookup_operational_data":
        op = args.get("operation", "")
        kwargs = {k: v for k, v in args.items() if k != "operation"}
        result = data_lookup.run(user=user, operation=op, **kwargs)
        if "error" in result:
            logger.warning("[dispatcher] data_lookup error: %s", result["error"])
        return result, False

    # ---- Tool 3: Server-side calculations --------------------------------
    if tool_name == "calculate_service_credit_or_fee":
        op = args.get("operation", "")
        kwargs = {k: v for k, v in args.items() if k != "operation"}
        result = data_lookup.run(user=user, operation=op, **kwargs)
        if "error" in result:
            logger.warning("[dispatcher] calculation error op=%s: %s", op, result["error"])
        else:
            logger.info("[dispatcher] calculation op=%s completed", op)
        return result, False

    # ---- Tool 4: Stage a state-changing action (confirmation required) ---
    if tool_name == "create_escalation":
        action_type = args.get("action_type", "create_escalation")
        params = args.get("params", {})
        staged = action_tool.stage_action(
            user=user,
            action_type=action_type,
            params=params,
        )
        logger.info(
            "[dispatcher] action staged action_type=%s action_id=%s",
            action_type,
            staged.get("action_id"),
        )
        return staged, True  # signals the agent loop to stop and ask for confirmation

    # ---- Internal: analytics --------------------------------------------
    if tool_name == "analytics":
        result = analytics.run(
            user=user,
            operation=args.get("operation", "detect_issues"),
        )
        return result, False

    # ---- Internal: summary stats ----------------------------------------
    if tool_name == "get_summary_stats":
        result = data_lookup.run(user=user, operation="get_summary_stats")
        return result, False

    logger.error("[dispatcher] Unknown tool: %s", tool_name)
    return {"error": f"Unknown tool '{tool_name}'"}, False


# ---------------------------------------------------------------------------
# Result summariser (for UI display — no PII)
# ---------------------------------------------------------------------------

def _summarise_result(tool_name: str, result: dict) -> str:
    """Short human-readable summary of a tool result for the frontend log panel."""
    if tool_name == "search_documents":
        n = len(result.get("results", []))
        sources = {r.get("source_short_name", "") for r in result.get("results", [])}
        return f"{n} chunks from {len(sources)} source(s)"

    if tool_name in ("lookup_operational_data", "calculate_service_credit_or_fee",
                     "get_summary_stats"):
        if "error" in result:
            return f"Error: {result['error']}"
        if "orders" in result:
            return f"{result.get('count', 0)} orders"
        if "tickets" in result:
            return f"{result.get('count', 0)} tickets"
        if "account" in result:
            return "Account data retrieved"
        if "sla_breached" in result:
            return (
                f"SLA {'BREACHED' if result['sla_breached'] else 'OK'} "
                f"— {result.get('elapsed_hours', '?')}h elapsed"
            )
        if "picked_up" in result:
            return (
                f"Order status: {result.get('status', '?')} "
                f"| Carrier picked up: {result.get('picked_up', '?')}"
            )
        if "total_tickets" in result:
            return (
                f"Stats: {result.get('total_accounts')} accounts, "
                f"{result.get('total_orders')} orders, "
                f"{result.get('total_tickets')} tickets"
            )
        return "Data retrieved"

    if tool_name == "create_escalation":
        return f"Action staged: {result.get('action_type', '')} — {result.get('preview', '')[:80]}"

    if tool_name == "analytics":
        return result.get("summary", "Analytics complete")[:120]

    return "Tool executed"


# ---------------------------------------------------------------------------
# Main chat function
# ---------------------------------------------------------------------------

def chat(
    messages: list[dict],
    user: UserContext,
    max_iterations: int = 8,
) -> dict:
    """
    Run the agent loop for one user turn.

    Parameters
    ----------
    messages       : full conversation history as list of {"role": ..., "content": ...}
    user           : authenticated user context (role, account_id, etc.)
    max_iterations : safety cap on tool-call rounds

    Returns
    -------
    {
        "reply"          : str   — final assistant text
        "tool_calls"     : list  — tool calls made (for UI display)
        "pending_action" : dict|None — staged action awaiting confirmation
        "sources"        : list  — document sources cited
    }
    """
    snapshot = get_snapshot_time()
    tools = _TOOLS_INTERNAL if is_internal(user) else _TOOLS_CUSTOMER
    provider = get_provider()

    # Build system prompt
    if is_internal(user):
        system_prompt = INTERNAL_SYSTEM_PROMPT.format(
            snapshot_time=snapshot,
            user_display_name=user.display_name,
            role=user.role,
        )
    else:
        system_prompt = CUSTOMER_SYSTEM_PROMPT.format(
            snapshot_time=snapshot,
            user_display_name=user.display_name,
            account_id=user.account_id or "N/A",
        )

    # Convert incoming message dicts → ConversationTurn list
    history: list[ConversationTurn] = [
        ConversationTurn(role=m["role"], content=m.get("content", ""))
        for m in messages
    ]

    tool_calls_log: list[dict] = []
    pending_action: Optional[dict] = None
    all_sources: list[dict] = []

    logger.info(
        "[chat] START user=%s role=%s history_turns=%d",
        user.user_id,
        user.role,
        len(history),
    )

    for iteration in range(max_iterations):
        logger.debug("[chat] iteration=%d", iteration + 1)

        # ------------------------------------------------------------------
        # Call the LLM
        # ------------------------------------------------------------------
        try:
            llm_response: LLMResponse = provider.generate(
                system_prompt=system_prompt,
                history=history,
                tools=tools,
            )
        except Exception as e:
            logger.error("[chat] LLM call failed iteration=%d: %s", iteration + 1, e)
            return {
                "reply": (
                    "I'm having trouble reaching the AI service right now. "
                    "Please try again in a moment, or contact support if the issue persists."
                ),
                "tool_calls": tool_calls_log,
                "pending_action": None,
                "sources": all_sources,
            }

        # ------------------------------------------------------------------
        # No tool calls → final answer
        # ------------------------------------------------------------------
        if not llm_response.tool_calls:
            if not llm_response.text:
                logger.warning("[chat] Empty response with no tool calls at iteration=%d", iteration + 1)
                return {
                    "reply": (
                        "I wasn't able to generate a response. "
                        "Please rephrase your question or try again."
                    ),
                    "tool_calls": tool_calls_log,
                    "pending_action": pending_action,
                    "sources": all_sources,
                }
            logger.info("[chat] Final answer iteration=%d reply_len=%d", iteration + 1, len(llm_response.text))
            return {
                "reply": llm_response.text,
                "tool_calls": tool_calls_log,
                "pending_action": pending_action,
                "sources": all_sources,
            }

        # ------------------------------------------------------------------
        # Process tool calls
        # ------------------------------------------------------------------

        # Record the assistant turn (with tool calls) in history
        assistant_turn = ConversationTurn(
            role="assistant",
            content=llm_response.text,
            tool_calls=llm_response.tool_calls,
        )
        history.append(assistant_turn)

        tool_results_for_turn: list[ToolResult] = []

        for tc in llm_response.tool_calls:
            logger.info(
                "[chat] tool_call tool=%s call_id=%s", tc.tool_name, tc.call_id
            )

            # ---- Execute the tool ----------------------------------------
            try:
                result, is_pending = _dispatch_tool(tc.tool_name, tc.args, user)
            except Exception as e:
                logger.error(
                    "[chat] Tool execution error tool=%s: %s", tc.tool_name, e
                )
                result = {"error": f"Tool execution failed: {type(e).__name__}"}
                is_pending = False

            # ---- Log entry for UI ----------------------------------------
            log_entry: dict = {
                "tool": tc.tool_name,
                "args": _redact(tc.args),
                "call_id": tc.call_id,
                "result_summary": _summarise_result(tc.tool_name, result),
            }
            tool_calls_log.append(log_entry)

            # ---- Collect document sources --------------------------------
            if tc.tool_name == "search_documents":
                for r in result.get("results", []):
                    entry = {
                        "source": r["source_short_name"],
                        "tier": r["tier"],
                        "trust_note": r["trust_note"],
                        "page": r.get("page_number"),
                    }
                    if not any(s["source"] == entry["source"] for s in all_sources):
                        all_sources.append(entry)

            # ---- Pending action: stop loop and ask for confirmation -------
            if is_pending:
                pending_action = result
                # Feed the staged-action notice back to the LLM so it can
                # phrase the confirmation request naturally
                tool_results_for_turn.append(
                    ToolResult(
                        call_id=tc.call_id,
                        tool_name=tc.tool_name,
                        result={
                            "staged": True,
                            "action_id": result.get("action_id"),
                            "preview": result.get("preview"),
                            "instruction": (
                                "The action has been staged. "
                                "Tell the user exactly what will happen and ask them to confirm."
                            ),
                        },
                    )
                )
            else:
                tool_results_for_turn.append(
                    ToolResult(
                        call_id=tc.call_id,
                        tool_name=tc.tool_name,
                        result=result,
                    )
                )

        # Append the tool-response turn to history
        history.append(
            ConversationTurn(
                role="tool",
                content="",
                tool_results=tool_results_for_turn,
            )
        )

        # ------------------------------------------------------------------
        # If an action is pending, get one final LLM message then return
        # ------------------------------------------------------------------
        if pending_action:
            logger.info("[chat] Pending action — requesting confirmation message")
            try:
                final_response = provider.generate(
                    system_prompt=system_prompt,
                    history=history,
                    tools=None,   # no tools for the confirmation message
                )
                reply_text = final_response.text or (
                    "I've prepared that action. Please confirm to proceed."
                )
            except Exception as e:
                logger.error("[chat] LLM confirmation message failed: %s", e)
                reply_text = (
                    f"I've staged the following action for your confirmation: "
                    f"{pending_action.get('preview', 'the requested action')}. "
                    "Please confirm to proceed."
                )

            return {
                "reply": reply_text,
                "tool_calls": tool_calls_log,
                "pending_action": pending_action,
                "sources": all_sources,
            }

    # ------------------------------------------------------------------
    # Max iterations reached
    # ------------------------------------------------------------------
    logger.warning("[chat] Max iterations (%d) reached for user=%s", max_iterations, user.user_id)
    return {
        "reply": (
            "I've gathered information across several sources but couldn't complete "
            "the full analysis within the allowed steps. "
            "Please try a more specific question, or ask me to focus on one part at a time."
        ),
        "tool_calls": tool_calls_log,
        "pending_action": None,
        "sources": all_sources,
    }
