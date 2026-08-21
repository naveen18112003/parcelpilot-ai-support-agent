# Architecture Note

## Agent design

The live system is a Next.js App Router app. `/api/chat` authenticates a mocked user from `x-user-id`, then runs a tool-using loop.

If `GEMINI_API_KEY` is set, Google Gemini (`gemini-2.5-flash` by default) chooses tools via function calling, up to eight rounds. If a write tool is used, the loop stops after staging and asks for confirmation. If the key is missing, a deterministic planner still calls the **same** server tools and composes an answer from their JSON. That keeps the hosted demo usable while still proving the tool and ACL layer.

Customer and internal personas share tools except `ops_issue_detection`, which is registered only for staff.

## Tool design

| Tool | Layer | Behaviour |
|------|--------|-----------|
| `search_documents` | `lib/search.ts` | Ranked lexical retrieval over chunked PDFs. Deprecated v2 is off unless requested. Other customers' agreements are stripped for customer users. |
| `lookup_operational_data` | `lib/access.ts` | Account / order / ticket reads. Customers cannot fetch another account even if they pass its id. |
| `calculate_policy_outcome` | `lib/policy.ts` | Deterministic cancellation fees, failed-pickup credits, and first-response SLA. The model is instructed not to mental-math these. |
| `stage_support_action` | `lib/actions.ts` | HMAC-signed pending action. `/api/confirm` verifies user, expiry, and signature, then mocks the write. Nothing executes from the model alone. |

Internal users also get `ops_issue_detection` (`lib/analytics.ts`) and a dedicated Issue Detection view that does not go through the LLM.

## Documents and structured data

PDFs from the pack are stored as reviewed chunks in `data/documents.json` (tier, trust note, optional `account_id`). The workbook is stored as `data/operational.json`. Reference time is the README snapshot: 2026-08-16 11:00 Asia/Kolkata. All elapsed-time math uses that instant, not wall clock.

Vercel has no persistent Python vector index, so retrieval is lexical with authority boosts rather than local sentence-transformers. For six short PDFs this is enough and avoids a native build on the serverless runtime.

## Source reliability and conflicts

Hierarchy encoded in retrieval filters, calculation code, and the system prompt:

1. Signed customer agreement for that account
2. Current policy v3, SOP v4, product guide
3. Deprecated policy v2 (labelled, excluded by default)
4. Historical ticket resolutions (context; may be wrong)

Deliberate conflict examples the tools surface:

- Northstar BOOKED cancellations: agreement waives the INR 250 SOP fee. TKT-450 said otherwise — flagged as incorrect history.
- LumenWorks credits: 4-hour threshold and INR 300 replace the SOP's 2 hours / min(500, 10% fee). A 3-hour carrier-fault delay is **not** enough for Bob, and **is** enough under default SOP for Alice.
- TKT-451 claimed Growth bulk-upload limit is 3,000 rows. Product guide + KI-208: limit is still 5,000; failures are a known bug with a split-file workaround.

SLA targets come from the matching agreement when present, else Support Policy v3. P1 24×7 clocks use calendar time; business-hour clocks skip IST weekends. The snapshot is a Sunday, so Growth/Standard business-hour SLAs may show ~0h elapsed while Northstar P1 (15 minutes, 24×7) on TKT-501 is already breached.

## Trade-offs

- **Next.js on Vercel vs FastAPI:** hosting was a stated preference. Python remains in `backend/` as the first prototype.
- **HMAC staged actions vs in-memory store:** serverless instances do not share memory. Signed tokens survive that.
- **Lexical RAG vs embeddings:** no GPU/native wheels on Vercel; the corpus is tiny.
- **Heuristic fallback:** demo stays live without a key; Gemini is still the intended production path.
- **Mock auth header:** enough to prove data-layer ACL. Production would swap in JWT without changing `canAccessAccount`.
