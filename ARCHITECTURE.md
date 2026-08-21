# Architecture Note

## Agent Design

The system uses a **ReAct-style loop** built on Google Gemini's function-calling API (`gemini-2.5-flash`). The agent iterates up to 8 times: on each turn it decides which tool(s) to call, observes the results, and continues until it can produce a final answer — or until a state-changing action is staged, at which point the loop pauses and returns control to the user.

The LLM is accessed through a **modular provider layer** (`app/llm/provider.py`). The `BaseLLMProvider` abstract class defines the interface; `GeminiProvider` is the only concrete implementation today. Swapping to a different LLM requires implementing one class and changing one environment variable — nothing else changes.

Two agent personas share the same loop but have different system prompts and different tool sets:
- **Customer agent**: `search_documents`, `lookup_operational_data`, `calculate_service_credit_or_fee`, `create_escalation`
- **Internal agent**: same + `analytics`, `get_summary_stats`

The system prompt is dynamically composed with the user's identity, account context, and the dataset snapshot time, so the model always reasons relative to the correct reference time.

## Tool Design

| Tool | Purpose | Key decision |
|------|---------|-------------|
| `search_documents` | Semantic retrieval over PDFs | Returns results annotated with source tier + trust note so the model can reason about reliability, not just content |
| `lookup_operational_data` | Structured queries (accounts, orders, tickets) | Access-control enforced at the function level, not by model instruction. Customers literally cannot fetch another account's data. |
| `calculate_service_credit_or_fee` | SLA breach + cancellation fee calculations | All arithmetic is deterministic and server-side. Gemini is told explicitly not to compute these itself. |
| `create_escalation` | Escalations, ticket updates, follow-up tasks | **Stage-then-confirm pattern**: `stage_action()` returns a preview; `execute_action()` is only called after explicit frontend confirmation. The model never executes actions autonomously. |
| `analytics` | Proactive issue detection | Internal-only. Aggregates SLA breach risk, ticket clustering, multi-customer impact, and order anomalies from the structured data. |

## Document and Structured-Data Handling

**PDFs** are parsed with `pypdf`, split into ~600-character overlapping chunks, and embedded using `sentence-transformers/all-MiniLM-L6-v2` (local, no API cost). Embeddings are stored in a flat NumPy matrix and retrieved with cosine similarity. FAISS isn't used as an index here — the dataset is small enough that brute-force cosine is fast and avoids a FAISS build step. Results are ranked and returned with page numbers and source metadata.

**Excel data** is loaded with `pandas` at startup. All access goes through typed functions (`get_account`, `get_orders_for`, etc.) that perform column-name normalisation and type-safe filtering. Column names are lowercased and whitespace-normalised to handle real-world Excel inconsistency.

The document index is cached to disk (pickle) after the first build so subsequent restarts are fast.

## Source Reliability and Conflict Handling

Every document chunk carries a `tier` and `trust_note`:

| Tier | Documents | Weight |
|------|-----------|--------|
| `authoritative` | Support Policy v3, SOP v4, Product Guide, Customer Agreements | Highest |
| `deprecated` | Support Policy v2 | Low — excluded from search by default; flagged if used |
| `historical_context` | Past ticket resolutions | Context only — model is explicitly instructed they may be wrong |

The system prompt explicitly encodes the override hierarchy: **customer agreement > current policy > deprecated policy > historical context**. When a query concerns a specific customer, their agreement chunks are included in the retrieval scope. The model is instructed to always cite its source and flag conflicts.

Deprecated documents are excluded from search by default (`include_deprecated=False`). The agent can include them for completeness but must flag them clearly.

## Major Technical Trade-offs

**Brute-force cosine vs. FAISS index**: For ~500–2000 chunks from 6 PDFs, brute-force is milliseconds and avoids compilation complexity on Windows. FAISS would be worthwhile at 50k+ chunks.

**sentence-transformers local vs. OpenAI embeddings**: Local embeddings avoid API latency and cost on every retrieval call. There is no OpenAI fallback — if sentence-transformers is unavailable, a warning is logged and random embeddings are used as a non-crashing placeholder.

**Single-file frontend**: Chose vanilla HTML/JS over React/Vite because Node.js isn't available in this environment and a build step adds friction for reviewers. The app is fully functional and could be migrated to React trivially.

**In-memory action store**: Escalations and tasks are stored in Python lists (resets on restart). A real deployment would use PostgreSQL or similar. The interface is already abstracted so this is a one-line swap.

**Mock auth**: Auth is a header `x-user-id` checked against a dict. A production system would use JWT with proper expiry, signature verification, and a user database. The access-control logic (which data a user can see) is already enforced in the data layer and would remain correct when real auth is added.
