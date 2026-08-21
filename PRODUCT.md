# Product Note

## Additional client problems

**Problem 1 — Proactive issue detection** is a first-class internal view (and a staff-only tool). It ranks open tickets against contract-aware first-response clocks, clusters subjects (outage, bulk upload, pickup status, security), links live tickets to KI-208 / KI-211, and lists BOOKED / carrier-fault orders.

**Problem 2 — Trust and reliability** is treated as a product constraint, not a paragraph in the prompt. Calculations live in code. Deprecated policy is filtered out. Historical resolutions are labelled untrusted. Conflicts are returned as data. Writes require a second click. Uncertainty on carrier fault blocks credit promises.

## What I would build next

1. **Suggested replies for human agents** — policy-correct draft next to the ticket, because handle time is the scarce resource.
2. **Golden-question eval harness** — freeze ORD/TKT fixtures and score hierarchy mistakes (v2 used as current, Northstar fee, LumenWorks 4h rule). This is how you know the agent is safe to expand.
3. **Carrier status adapter** — KI-211 is unanswerable authoritatively without SwiftShip's actual pickup signal.
4. **Session + audit log** — who saw which account, which action tokens were confirmed.
5. **Contract-change alerts** — when an agreement clause moves, reopen related tickets.

## Intentionally left out

- Real identity provider and durable database
- Streaming token-by-token model text (tool events already stream)
- Training or fine-tuning on tickets
- The Python vector cache path in production

## One usefulness metric

**Correct-deflection rate:** share of customer chats that close without a human **and** that match the policy/contract fixture on a hidden eval set, with no reopen in 72 hours. Raw deflection without a correctness check rewards confident wrong answers — the failure mode ParcelPilot called out.

## AI tool usage

Cursor (Grok 4.6) was used to implement the Next.js Vercel app, tools, ACL, UI, and these notes on top of the existing repo. I specified the product behaviour (hierarchy, confirm-before-write, dual personas, ops board) and reviewed the policy calculations against the data pack.
