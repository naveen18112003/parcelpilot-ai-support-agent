# ParcelPilot AI Support System

A full-stack AI agent for ParcelPilot's customer support and internal operations — built for the CalQuity AI Engineer assessment.

---

## Quick Start

### 1. Prerequisites
- Python 3.10+
- A Google Gemini API key (get one free at [aistudio.google.com](https://aistudio.google.com))

### 2. Place the data files

Copy all PDF and Excel files from the candidate data pack into:
```
parcel-pilot/backend/data/
```

Expected files:
```
backend/data/
  01_Support_Policy_v3_CURRENT.pdf
  02_Support_Policy_v2_DEPRECATED.pdf
  03_Cancellation_and_Service_Credit_SOP_v4.pdf
  04_Product_Operations_Guide_and_Known_Issues.pdf
  05_Northstar_Logistics_Enterprise_Agreement.pdf
  06_LumenWorks_Service_Agreement.pdf
  ParcelPilot_Assessment_Data.xlsx
```

### 3. Install Python dependencies

```bash
cd parcel-pilot/backend
pip install -r requirements.txt
```

### 4. Configure your Gemini API key

```bash
cd parcel-pilot/backend
copy .env.example .env
# Then edit .env and set GEMINI_API_KEY=your-key-here
```

Or set it directly (Windows PowerShell):
```powershell
$env:GEMINI_API_KEY = "your-key-here"
```

### 5. Start the backend

```bash
cd parcel-pilot/backend
python3 -m uvicorn app.main:app --reload --port 8000
```

The first startup takes ~1–2 minutes to build the vector index from the PDFs.
After that the index is cached in `backend/cache/` and subsequent starts are instant.

### 6. Open the frontend

Open `parcel-pilot/frontend/index.html` in any browser — no build step needed.

### 7. Verify the server is healthy

```
GET http://localhost:8000/api/health
GET http://localhost:8000/api/llm-health
```

---

## Demo Users

| User  | Role       | Account  | Can See                           |
|-------|------------|----------|-----------------------------------|
| Alice | customer   | ACC-001  | Only Northstar Logistics data     |
| Bob   | customer   | ACC-002  | Only LumenWorks data              |
| Carol | support    | —        | All accounts and data             |
| Dave  | ops_admin  | —        | All data + Issue Detection dashboard |

---

## Example Questions to Try

**Customer (Alice / Bob)**
- Can I cancel my latest order without a fee?
- What is my SLA response time guarantee?
- Am I eligible for a service credit on a late pickup?
- Show me my open support tickets

**Internal (Carol / Dave)**
- Can Northstar cancel ORD-1001 without a cancellation fee? Explain why.
- Is TKT-001 approaching an SLA breach?
- A pickup is three hours late because of carrier fault — should the customer get a service credit?
- Show me all recurring issues across tickets (also available via the Issue Detection dashboard)

---

## Project Structure

```
parcel-pilot/
├── backend/
│   ├── app/
│   │   ├── main.py                 # FastAPI app, routes, logging
│   │   ├── llm/
│   │   │   └── provider.py         # Modular LLM layer (Gemini; swap-ready)
│   │   ├── agent/
│   │   │   ├── core.py             # Gemini function-calling agent loop
│   │   │   └── prompts.py          # System prompts (customer / internal)
│   │   ├── data/
│   │   │   ├── loader.py           # Excel data loader
│   │   │   ├── document_store.py   # PDF chunking + cosine-similarity RAG
│   │   │   └── auth.py             # Mock auth + access-control layer
│   │   └── tools/
│   │       ├── document_search.py  # Tool 1: semantic doc search
│   │       ├── data_lookup.py      # Tool 2: structured data + calculations
│   │       ├── action_tool.py      # Tool 3: staged state-changing actions
│   │       └── analytics.py        # Tool 4: proactive issue detection
│   ├── data/                       # ← place PDF + Excel files here
│   ├── cache/                      # auto-generated vector index cache
│   ├── .env.example                # copy to .env and fill in GEMINI_API_KEY
│   └── requirements.txt
├── frontend/
│   ├── index.html                  # Single-page app (no build step)
│   ├── style.css
│   └── app.js
├── ARCHITECTURE.md
└── PRODUCT.md
```

---

## API Endpoints

| Method | Path                  | Description                              |
|--------|-----------------------|------------------------------------------|
| GET    | /api/health           | Server + data health check               |
| GET    | /api/llm-health       | Gemini config check (no key exposed)     |
| GET    | /api/me               | Current user info                        |
| GET    | /api/users            | Mock user list (for login UI)            |
| POST   | /api/chat             | Main agent chat endpoint                 |
| POST   | /api/confirm-action   | Execute a staged action after confirmation |
| GET    | /api/escalations      | List escalations (scoped by role)        |
| GET    | /api/followup-tasks   | List follow-up tasks (scoped by role)    |
| GET    | /api/analytics        | Proactive issue detection (internal only)|
| GET    | /api/snapshot-time    | Dataset reference timestamp              |
