# Product Note

## Which Additional Problem I Chose

I implemented **Problem 1 (Proactive Issue Detection)** as a first-class feature, not an afterthought.

The `analytics` tool and the "Issue Detection" dashboard surface five categories of insight in real time:
1. **SLA at risk / breached** — every open ticket is compared against its priority-appropriate SLA deadline. Tickets are flagged at 75% usage (warning), 90% (critical), and 100%+ (breached).
2. **Ticket clusters** — tickets are grouped by keyword category (carrier delays, billing, tracking, cancellations, portal issues, etc.) to surface recurring themes.
3. **Multi-customer issues** — when the same issue category appears across multiple accounts, it's surfaced separately as a potential systemic problem (outage, carrier-wide issue, product bug).
4. **High-volume accounts** — accounts with unusually high open ticket counts relative to average are flagged.
5. **Order anomalies** — abnormal cancellation or failure rates in order data.

I also addressed **Problem 2 (Trust and Reliability)** as a design constraint throughout:
- Source tiers are explicit and surface in every chat response as colour-coded chips.
- Deprecated documents are excluded by default.
- Historical resolutions are labelled as unreliable context in the system prompt.
- The stage-then-confirm action pattern prevents the model from executing anything autonomously.
- When the model is uncertain, the system prompt directs it to say so and offer escalation rather than guess.

## What Else I Would Build

**Ranked by impact:**

1. **Ticket auto-routing** — when a customer submits a query, automatically classify the issue type, determine urgency, and route to the right queue. This directly reduces time-to-first-response, the metric customers notice most.

2. **Suggested responses for agents** — internal agents often repeat the same responses. A "suggested reply" panel that drafts a policy-accurate response for human review before sending would cut handle time significantly.

3. **Contract diff alerting** — when a customer agreement is updated, flag which policy clauses changed and which open tickets may be affected. Prevents agents from giving advice based on a superseded contract.

4. **Conversation memory / session persistence** — currently, conversation history is in-browser memory. A proper session store (Redis + DB) would let agents pick up unfinished conversations and give the analytics layer visibility into conversation patterns.

5. **Feedback loop on agent answers** — a thumbs-up/down on each bot response, piped back into a fine-tuning or RLHF dataset. Without this, you can't measure whether the system is actually correct over time.

6. **Carrier API integration** — the biggest gap in the data model is live carrier status. Connecting to carrier APIs would let the system answer "where is my parcel right now?" authoritatively rather than from a stale snapshot.

## What I Intentionally Left Out

- **Real authentication**: JWT, OAuth, session management. The mock is correctly abstracted so real auth is a drop-in.
- **Persistent storage**: Using in-memory stores for escalations and tasks keeps the demo self-contained. A production system needs a database.
- **Rate limiting and abuse protection**: Important for a customer-facing endpoint but out of scope for a demo.
- **Evaluation harness**: A golden test set of question → expected answer pairs would be the right way to validate model accuracy at scale. I didn't build this because it requires the actual data pack to be meaningful.
- **Streaming responses**: The API returns complete responses. Streaming (`text/event-stream`) would improve perceived latency for long answers.

## One Metric to Judge Usefulness

**Deflection rate with satisfaction**: the percentage of customer queries that are resolved by the AI without human escalation, *where the customer did not subsequently re-open the issue or give negative feedback*. Raw deflection rate is easy to game (the model just refuses to escalate); pairing it with resolution quality catches that. This directly measures the product's core value proposition — saving the operations team time while keeping customers satisfied.

## AI Tools Used

- **Kiro (Claude-based)** — used to scaffold and write the full codebase, including the backend tools, agent loop, data layer, access-control logic, and frontend. I directed the architecture and reviewed/refined all decisions.
- **No other AI coding tools were used.**
