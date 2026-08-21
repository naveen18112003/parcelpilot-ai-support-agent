"""
Tool 1: Document Search / Retrieval

Searches policy documents, SOPs, customer agreements, and product guides
using semantic similarity. Returns ranked, source-annotated chunks with
trust tier metadata so the agent can reason about reliability.
"""

from __future__ import annotations
from typing import Optional
from app.data.document_store import search_documents


TOOL_NAME = "document_search"
TOOL_DESCRIPTION = (
    "Search ParcelPilot's policy documents, SOPs, product guide, and customer "
    "agreements for relevant information. Use this for questions about policies, "
    "cancellation rules, SLA terms, service credits, product issues, and contract terms. "
    "Returns ranked results with source reliability tiers."
)


def run(
    query: str,
    account_id: Optional[str] = None,
    top_k: int = 5,
    include_deprecated: bool = False,
) -> dict:
    """
    Execute the document search tool.

    Parameters
    ----------
    query            : the search query
    account_id       : when set, customer-specific agreements for this account are included
    top_k            : number of results
    include_deprecated : whether to include deprecated document sources

    Returns
    -------
    dict with keys:
        results  : list of source chunks with text, source name, tier, trust note
        summary  : human-readable summary of sources found
    """
    results = search_documents(
        query=query,
        top_k=top_k,
        account_id=account_id,
        include_deprecated=include_deprecated,
    )

    if not results:
        return {
            "results": [],
            "summary": "No relevant document chunks found for this query.",
        }

    # Build a readable summary of which sources were hit
    source_summary = {}
    for r in results:
        key = r["source_short_name"]
        if key not in source_summary:
            source_summary[key] = {"tier": r["tier"], "trust_note": r["trust_note"], "count": 0}
        source_summary[key]["count"] += 1

    lines = [f"Found {len(results)} relevant chunks from {len(source_summary)} source(s):"]
    for src, info in source_summary.items():
        lines.append(f"  • {src} [{info['tier']}] — {info['trust_note']}")

    return {
        "results": results,
        "summary": "\n".join(lines),
    }
