# ParcelPilot AI Support Agent

Live Next.js app for the CalQuity ParcelPilot assessment. It answers natural-language support questions from the candidate data pack, enforces account scoping in the data layer, and stages write actions until the user confirms.

## Demo users

| User | Role | Scope |
|------|------|--------|
| Alice Chen | customer | ACCT-001 Northstar Logistics |
| Bob Iyer | customer | ACCT-002 LumenWorks |
| Priya Shah | customer | ACCT-003 Beacon Retail |
| Carol Mendes | support | All accounts |
| Dave Okonkwo | ops_admin | All accounts + Issue Detection |

## What to try

- `Can Northstar cancel ORD-1001 without a cancellation fee? Explain why.`
- `A pickup is three hours late because of carrier fault. Should I get a service credit?` (as Alice vs Bob — answers differ)
- `Is TKT-501 past SLA? Escalate if needed.` then confirm the staged escalation
- Switch to Dave → **Issue Detection** for SLA watch and ticket clusters

## Run locally

```bash
npm install
copy .env.example .env.local
# set GEMINI_API_KEY (optional but recommended)
npm run dev
```

Open http://localhost:3000

Without `GEMINI_API_KEY` the app still runs: the same tools execute, and a deterministic composer writes the answer. With a key, Gemini 2.5 Flash chooses tools.

## Deploy on Vercel

1. Import this GitHub repo in Vercel (Root Directory: leave as repo root).
2. Environment variables:
   - `GEMINI_API_KEY` — from [Google AI Studio](https://aistudio.google.com)
   - `GEMINI_MODEL` — `gemini-2.5-flash` (optional)
   - `ACTION_SECRET` — any long random string (signs confirmation tokens)
3. Deploy.

## Requirements covered

1. Natural-language chatbot (customer + internal)
2. Access control in `lib/access.ts` / tools, not only in the prompt
3. Tools: document search, structured lookup + policy calculation, staged actions
4. Explicit confirmation before writes
5. Multi-step (order → account → agreement → SOP → calculate → maybe escalate)
6. Chat UI shows live tool names
7. Proactive issue detection for internal users
8. Source hierarchy: signed agreement > current policy/SOP/guide > deprecated v2 > historical tickets

## Notes

`backend/` is an earlier FastAPI prototype. The submitted, hosted system is this Next.js app.

Assessment snapshot used for all clocks: **2026-08-16 11:00 Asia/Kolkata**.
