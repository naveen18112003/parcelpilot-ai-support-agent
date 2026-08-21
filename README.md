# ParcelPilot AI Support & Operations System
> **Production-grade AI agent system for B2B logistics customer support, policy reasoning, contract conflict resolution, and proactive operations telemetry.**

[![Next.js 15](https://img.shields.io/badge/Next.js-15.5-black?style=flat&logo=next.js)](https://nextjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue?style=flat&logo=typescript)](https://www.typescriptlang.org/)
[![Gemini 2.0 Flash](https://img.shields.io/badge/Google_Gemini-2.0_Flash-4285F4?style=flat&logo=google)](https://aistudio.google.com/)
[![Vercel Deployed](https://img.shields.io/badge/Vercel-Live_Deployment-000000?style=flat&logo=vercel)](https://parcelpilot-ai-support-agent.vercel.app)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

---

## 🔗 Live Links
- **🌐 Live Hosted Application:** [https://parcelpilot-ai-support-agent.vercel.app](https://parcelpilot-ai-support-agent.vercel.app)
- **💻 GitHub Code Repository:** [https://github.com/naveen18112003/parcelpilot-ai-support-agent](https://github.com/naveen18112003/parcelpilot-ai-support-agent)
- **⏱ Reference Snapshot Timestamp:** `2026-08-16 11:00 Asia/Kolkata` (used for all SLA, business-hour, and delay clocks)

---

## 📑 Table of Contents
1. [Executive Summary & Key Differentiators](#-executive-summary--key-differentiators)
2. [System Architecture](#-system-architecture)
3. [Source Reliability & Conflict Precedence Hierarchy](#-source-reliability--conflict-precedence-hierarchy)
4. [Agent Tools & Data Scoping Architecture](#-agent-tools--data-scoping-architecture)
5. [Additional Client Problems Solved](#-additional-client-problems-solved)
6. [Evaluator Test Matrix (Step-by-Step Test Guide)](#-evaluator-test-matrix)
7. [Repository File Structure](#-repository-file-structure)
8. [Local Development & Deployment Guide](#-local-development--deployment-guide)
9. [Architecture & Product Notes](#-architecture--product-notes)

---

## 🌟 Executive Summary & Key Differentiators

ParcelPilot is a high-volume B2B logistics platform. This AI support system provides **two distinct operating contexts**:
1. **Customer-Facing Self-Service Agent:** Answers account queries, checks order status, calculates cancellation fees, and determines service credit eligibility with **server-enforced tenant data isolation**.
2. **Internal Support & Ops Telemetry Board:** Empowers support staff and operations managers to triage cross-account issues, evaluate SLA breach risks, cluster complaints against known platform bugs, and safely execute staged state-changing actions.

### 🛡️ Why This Implementation Stands Out:
- **Server-Enforced RBAC Scoping:** Access control is strictly enforced at the database and tool layer (`lib/access.ts`), **not** through model prompt instructions alone.
- **Deterministic Math Engine:** Fee equations, credit caps, and SLA business-hour clocks are computed via deterministic TypeScript functions (`lib/policy.ts`) — **zero LLM arithmetic hallucinations**.
- **Cryptographic Confirm-Before-Action:** State mutations (escalations, ticket updates, tasks) issue an **HMAC-signed token** with a visual confirmation card before any execution occurs.
- **Dual-Engine Resilience:** Uses **Google Gemini 2.0 Flash function calling** with a seamless fallback to the deterministic engine if API limits or network issues arise.

---

## 🏗 System Architecture

```
                               ┌──────────────────────────────────────────────┐
                               │            Client User Interface             │
                               │  (Customer Persona vs Internal Ops Persona)  │
                               └──────────────────────┬───────────────────────┘
                                                      │ HTTP POST (SSE Stream)
                                                      ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ Next.js App Router Backend (/api/chat)                                                                      │
│                                                                                                             │
│  1. Authentication & Context: Resolves user role & account_id scope (lib/access.ts)                         │
│  2. Orchestrator Loop: Gemini 2.0 Flash Function Calling / Deterministic Heuristic Engine                   │
│                                                                                                             │
│  ┌─────────────────────────────┐  ┌─────────────────────────────┐  ┌──────────────────────────────────────┐ │
│  │   search_documents          │  │  lookup_operational_data   │  │   calculate_policy_outcome           │ │
│  │   - Hierarchical PDF RAG    │  │  - Scoped Workbook Queries  │  │   - Deterministic Fee & Credit Math  │ │
│  │   - Excludes Deprecated v2  │  │  - Tenant Isolation Layer   │  │   - IST Business-Hour SLA Clocks     │ │
│  └──────────────┬──────────────┘  └──────────────┬──────────────┘  └──────────────────┬───────────────────┘ │
│                 │                                │                                    │                     │
│                 ▼                                ▼                                    ▼                     │
│  ┌─────────────────────────────┐  ┌─────────────────────────────┐  ┌──────────────────────────────────────┐ │
│  │   Knowledge Base (PDFs)     │  │   Operational DB (JSON)     │  │   stage_support_action               │ │
│  │   - Support Policy v3 (Cur) │  │   - ACCT / ORD / TKT Data   │  │   - Issues HMAC Confirmation Token   │ │
│  │   - Cancellation SOP v4     │  │   - Snapshot: 16 Aug 2026   │  │   - Requires Explicit User Approval  │ │
│  │   - Customer Agreements     │  │   - Multi-Tenant Scoped     │  │   - Executes via /api/confirm        │ │
│  └─────────────────────────────┘  └─────────────────────────────┘  └──────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## ⚖️ Source Reliability & Conflict Precedence Hierarchy

The source base is intentionally conflicting. The agent implements a strict **4-Tier Authority Hierarchy**:

$$\mathbf{Tier\ 1:\ Signed\ Customer\ Agreement} \succ \mathbf{Tier\ 2:\ Current\ Policies\ \&\ SOPs} \succ \mathbf{Tier\ 3:\ Deprecated\ Policy\ v2} \succ \mathbf{Tier\ 4:\ Historical\ Tickets}$$

### Concrete Conflict Scenarios Handled by the System:

| Scenario | Candidate Data Conflict | Authoritative Resolution | Handled By |
| :--- | :--- | :--- | :--- |
| **Northstar Cancellation** | SOP v4 charges ₹250 after 30 mins. `TKT-450` charged ₹250. | **Northstar Enterprise Agreement §2** explicitly waives all cancellation fees on BOOKED shipments. `TKT-450` is flagged as incorrect guidance. | `calculate_policy_outcome` (`cancellation`) |
| **LumenWorks Late Pickup Credit** | SOP v4 default is 2h delay and min(₹500, 10%). | **LumenWorks Agreement §3** overrides threshold to **4 hours** and caps credit at **₹300**. A 3-hour delay is **ineligible**. | `calculate_policy_outcome` (`service_credit`) |
| **Bulk Upload Limits** | `TKT-451` resolution claimed Growth limit is 3,000 rows. | **Product Guide §1 & Known Issue KI-208** confirm limit remains **5,000 rows**; failures above 3,000 are a known platform bug with a split-file workaround. | `search_documents` |
| **SLA First-Response Clock** | Deprecated Policy v2 had slower SLA targets. | **Support Policy v3 & Customer Agreement** govern. Clocks calculate from snapshot time (`2026-08-16 11:00 IST`). | `calculate_policy_outcome` (`sla`) |

---

## 🛠 Agent Tools & Data Scoping Architecture

### 1. Distinct Server Tools:
1. `search_documents`: Lexical RAG over structured PDF chunks with trust tiering and metadata filtering (excluding deprecated policies by default).
2. `lookup_operational_data`: Scoped queries against account, order, and ticket tables enforcing tenant isolation.
3. `calculate_policy_outcome`: Deterministic computational engine for cancellation fees, late-pickup credits, and SLA clock compliance.
4. `stage_support_action`: Prepares state mutations (escalations, ticket updates, tasks) and issues a cryptographically signed HMAC token.
5. `ops_issue_detection`: Internal-only proactive analytics tool monitoring cluster patterns, SLA breach risks, and known-issue links.

### 2. Multi-Tenant Scoping Matrix:
```typescript
// Enforced in lib/access.ts
export function canAccessAccount(user: UserContext, targetAccountId: string): boolean {
  if (isInternal(user)) return true; // Support & Ops Admin have cross-account access
  return user.account_id === targetAccountId; // Customers strictly isolated to their account
}
```

---

## 🚀 Additional Client Problems Solved

### Problem 1: Proactive Issue Detection (Internal Telemetry Dashboard)
A reactive chatbot is insufficient for operations. The app provides a dedicated **Issue Detection** tab for authorized staff (`Dave Okonkwo`):
- **SLA Watch:** Real-time tracking of open tickets against contract-aware response targets (e.g. flagging `TKT-501` Northstar P1 breach).
- **Incident Clustering:** Groups recurring tickets by category (`Outages`, `Bulk CSV Uploads`, `Pickup Webhook Latency`).
- **Known Issue Linkages:** Live cross-referencing of active complaints to active platform bugs (`KI-208`, `KI-211`).

### Problem 2: Trust and Reliability
- **Mathematical Determinism:** Eliminates LLM calculation errors.
- **Historical Ticket Warning:** Historical resolutions are labeled `Context Only — Untrusted`.
- **Human-in-the-Loop Confirmation:** High-stakes actions cannot auto-execute without explicit user confirmation.

---

## 🧪 Evaluator Test Matrix

Try these test scenarios on the [Live Application](https://parcelpilot-ai-support-agent.vercel.app):

### Persona 1: Alice Chen (`CUSTOMER` · `ACCT-001 Northstar Logistics`)
| Test Query | Expected Agent Behavior | Technical Reason |
| :--- | :--- | :--- |
| `Can Northstar cancel ORD-1001 without a cancellation fee? Explain why.` | States fee is **INR 0**. Highlights that Northstar's Enterprise Agreement overrides standard ₹250 SOP fee. Flags `TKT-450` as erroneous. | Signed Agreement §2 precedence |
| `A pickup is three hours late because of carrier fault. Should I get a service credit?` | States **Eligible** under standard SOP v4 (exceeds 2-hour delay threshold). | SOP v4 failed-pickup rule |
| `What is my first-response SLA?` | Lists Northstar's custom SLA: **P1 = 15 mins (24x7)**, P2 = 1 hr, P3 = 8 business hours. | Enterprise Agreement §1 |

### Persona 2: Bob Iyer (`CUSTOMER` · `ACCT-002 LumenWorks`)
| Test Query | Expected Agent Behavior | Technical Reason |
| :--- | :--- | :--- |
| `A pickup is three hours late because of carrier fault. Should I get a service credit?` | States **NOT Eligible**. Explains that LumenWorks' agreement sets a custom **4-hour delay threshold**. | LumenWorks Agreement §3 |

### Persona 3: Carol Mendes (`SUPPORT` · `ParcelPilot Internal Staff`)
| Test Query | Expected Agent Behavior | Technical Reason |
| :--- | :--- | :--- |
| `Is TKT-501 approaching or past SLA? Escalate if needed.` | Detects **P1 15-minute SLA breach**. Stages an escalation and displays the **Confirmation Card**. Clicking confirm executes the action. | `stage_support_action` + HMAC token |

### Persona 4: Dave Okonkwo (`OPS_ADMIN` · `ParcelPilot Operations`)
| Test Action | Expected System Behavior | Technical Reason |
| :--- | :--- | :--- |
| Click **`Issue detection`** Tab | Renders real-time telemetry dashboard displaying SLA risks, complaint clusters, and `KI-208` / `KI-211` linkages. | `ops_issue_detection` endpoint |

---

## 📂 Repository File Structure

```
parcel-pilot/
├── app/
│   ├── api/
│   │   ├── analytics/     # Proactive issue detection & telemetry endpoint
│   │   ├── chat/          # SSE streaming agent function calling route
│   │   ├── confirm/       # HMAC token verification & action execution
│   │   ├── health/        # System health & diagnostic check
│   │   ├── me/            # Authenticated user context & LLM status
│   │   └── users/         # Persona switcher endpoint
│   ├── globals.css        # Modern dark-mode styling
│   ├── layout.tsx         # Root application layout
│   └── page.tsx           # Main application entry
├── components/
│   └── App.tsx            # Fullstack Chat UI & Ops Telemetry Dashboard
├── data/
│   ├── 01_Support_Policy_v3_CURRENT.pdf
│   ├── 02_Support_Policy_v2_DEPRECATED.pdf
│   ├── 03_Cancellation_and_Service_Credit_SOP_v4.pdf
│   ├── 04_Product_Operations_Guide_and_Known_Issues.pdf
│   ├── 05_Northstar_Logistics_Enterprise_Agreement.pdf
│   ├── 06_LumenWorks_Service_Agreement.pdf
│   ├── documents.json     # Pre-chunked hierarchical knowledge base
│   └── operational.json   # Scoped accounts, orders, and tickets dataset
├── lib/
│   ├── access.ts          # Server-enforced RBAC & tenant scoping
│   ├── actions.ts         # HMAC cryptographic staging & confirmation
│   ├── agent.ts           # Gemini 2.0 Flash function calling orchestrator
│   ├── analytics.ts       # SLA watchdogs & ticket clustering algorithms
│   ├── auth.ts            # User personas & authentication definitions
│   ├── data.ts            # Dataset loader & snapshot pinning
│   ├── heuristic.ts       # Resilient deterministic fallback composer
│   ├── policy.ts          # Deterministic cancellation, credit & SLA engines
│   ├── prompts.ts         # System instructions & hierarchy rules
│   ├── search.ts          # Ranked lexical RAG engine
│   ├── tools.ts           # Tool schemas & server-side execution handlers
│   └── types.ts           # TypeScript interfaces & data contracts
├── ARCHITECTURE.md        # Detailed engineering architecture document
├── PRODUCT.md             # Product decisions, roadmap & metric document
├── package.json           # Next.js 15 dependencies & scripts
├── tsconfig.json          # TypeScript compilation configuration
└── vercel.json            # Vercel deployment configuration
```

---

## 💻 Local Development & Deployment Guide

### Prerequisites
- Node.js 18+ (Node.js 20+ or 24+ recommended)
- Google AI Studio API Key (optional — deterministic fallback functions seamlessly without a key)

### Local Setup
```bash
# Clone the repository
git clone https://github.com/naveen18112003/parcelpilot-ai-support-agent.git
cd parcelpilot-ai-support-agent

# Install dependencies
npm install

# Set environment variables
cp .env.example .env.local

# Run development server
npm run dev
```
Open `http://localhost:3000` to interact with the application.

### Deploying to Vercel (1-Click)
1. Import repository on [Vercel](https://vercel.com/new).
2. Configure Environment Variables:
   - `GEMINI_API_KEY`: Your Gemini API Key from Google AI Studio.
   - `GEMINI_MODEL`: `gemini-2.0-flash`
   - `ACTION_SECRET`: Any 32-character random string.
3. Click **Deploy**.

---

## 📋 Architecture & Product Notes

- For full architectural details including tool execution traces, security scoping, and technical trade-offs, see [ARCHITECTURE.md](file:///c:/Users/navee/OneDrive/Desktop/CalQuity%20Task/parcel-pilot/ARCHITECTURE.md).
- For product strategy, roadmap prioritization, and the **Correct-Deflection Rate** metric, see [PRODUCT.md](file:///c:/Users/navee/OneDrive/Desktop/CalQuity%20Task/parcel-pilot/PRODUCT.md).

---

### Author
- **Author:** Naveen Kumar Yadav
- **Status:** Complete, Tested, and Live on Vercel.
