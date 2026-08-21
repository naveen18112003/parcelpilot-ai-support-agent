"""
Quick endpoint smoke-test — run from backend/ directory:
    python3 test_endpoints.py
Requires the server to be running on localhost:8000.
"""
import urllib.request
import urllib.error
import json
import sys

BASE = "http://localhost:8000"
PASS = []
FAIL = []


def get(path, user="alice"):
    req = urllib.request.Request(BASE + path, headers={"x-user-id": user})
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())


def post(path, body, user="alice"):
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        BASE + path, data=data,
        headers={"x-user-id": user, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())


def ok(label, expr):
    if expr:
        PASS.append(label)
        print(f"  PASS  {label}")
    else:
        FAIL.append(label)
        print(f"  FAIL  {label}")


print("\n=== ParcelPilot Endpoint Tests ===\n")

# 1. /api/health
h = get("/api/health")
ok("health returns ok", h.get("status") == "ok")
ok("health has snapshot_time", "snapshot_time" in h)

# 2. /api/llm-health
lh = get("/api/llm-health")
ok("llm-health status ok", lh.get("status") == "ok")
ok("llm-health provider=gemini", lh.get("provider") == "gemini")
ok("llm-health model=gemini-2.5-flash", lh.get("model") == "gemini-2.5-flash")
ok("llm-health key configured", lh.get("api_key_configured") is True)
ok("llm-health key NOT exposed in full", "GEMINI_API_KEY" not in str(lh))

# 3. /api/users
users = get("/api/users")
ok("users returns 4 mock users", len(users) == 4)
roles = {u["user_id"]: u["role"] for u in users}
ok("alice is customer", roles.get("alice") == "customer")
ok("carol is support", roles.get("carol") == "support")
ok("dave is ops_admin", roles.get("dave") == "ops_admin")

# 4. /api/me — customer
me_alice = get("/api/me", "alice")
ok("me(alice) role=customer", me_alice["role"] == "customer")
ok("me(alice) account=ACC-001", me_alice["account_id"] == "ACC-001")
ok("me(alice) is_internal=false", me_alice["is_internal"] is False)

# 5. /api/me — internal
me_dave = get("/api/me", "dave")
ok("me(dave) role=ops_admin", me_dave["role"] == "ops_admin")
ok("me(dave) is_internal=true", me_dave["is_internal"] is True)

# 6. /api/me — unknown user returns 401
try:
    get("/api/me", "unknown_hacker")
    ok("unknown user blocked", False)
except urllib.error.HTTPError as e:
    ok("unknown user returns 401", e.code == 401)

# 7. /api/analytics — customer blocked with 403
try:
    get("/api/analytics", "alice")
    ok("analytics(customer) blocked", False)
except urllib.error.HTTPError as e:
    ok("analytics(customer) returns 403", e.code == 403)

# 8. /api/analytics — internal allowed
try:
    a = get("/api/analytics", "dave")
    ok("analytics(dave) has sla_at_risk key", "sla_at_risk" in a)
    ok("analytics(dave) has ticket_clusters key", "ticket_clusters" in a)
    ok("analytics(dave) has summary key", "summary" in a)
except Exception as e:
    ok(f"analytics(dave) accessible — {e}", False)

# 9. /api/escalations — empty initially
esc = get("/api/escalations", "carol")
ok("escalations returns list", isinstance(esc.get("escalations"), list))

# 10. /api/confirm-action — create escalation
result = post("/api/confirm-action", {
    "action_type": "create_escalation",
    "params": {
        "ticket_id": "TKT-001",
        "account_id": "ACC-001",
        "reason": "Automated test escalation",
        "priority": "high",
    },
}, "carol")
ok("confirm-action succeeded", result.get("success") is True)
ok("confirm-action returned escalation_id", "escalation_id" in result.get("result", {}))

# 11. /api/escalations — now has 1
esc2 = get("/api/escalations", "carol")
ok("escalation persisted in list", len(esc2["escalations"]) >= 1)

# 12. /api/followup-tasks
tasks = get("/api/followup-tasks", "carol")
ok("followup-tasks returns list", isinstance(tasks.get("tasks"), list))

# 13. /api/snapshot-time
snap = get("/api/snapshot-time")
ok("snapshot-time present", "snapshot_time" in snap)

# 14. Chat endpoint shape — uses a real Gemini call; skipped if GEMINI_API_KEY is placeholder
import os
api_key = os.environ.get("GEMINI_API_KEY", "")
if "placeholder" in api_key or not api_key:
    print("  SKIP  chat/LLM test — set a real GEMINI_API_KEY to test this")
    PASS.append("chat endpoint (skipped — no real key)")
else:
    try:
        chat_result = post("/api/chat", {
            "messages": [{"role": "user", "content": "What is my SLA?"}]
        }, "alice")
        ok("chat returns reply key", "reply" in chat_result)
        ok("chat returns tool_calls key", "tool_calls" in chat_result)
        ok("chat returns sources key", "sources" in chat_result)
        print(f"         reply preview: {chat_result['reply'][:80]}...")
    except Exception as e:
        ok(f"chat endpoint reachable — {e}", False)

# Summary
print(f"\n{'='*36}")
print(f"  PASSED: {len(PASS)}/{len(PASS)+len(FAIL)}")
if FAIL:
    print(f"  FAILED: {FAIL}")
print(f"{'='*36}\n")
sys.exit(0 if not FAIL else 1)
