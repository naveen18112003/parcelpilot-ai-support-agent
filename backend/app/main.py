"""
ParcelPilot AI Support — FastAPI Backend
"""

from __future__ import annotations

import logging
import logging.config
import os
from pathlib import Path
from contextlib import asynccontextmanager
from typing import Optional, Any

# Load .env from backend root before anything else reads env vars
from dotenv import load_dotenv
load_dotenv(Path(__file__).parent.parent / ".env")

from fastapi import FastAPI, HTTPException, Header, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel

from app.data.loader import load_excel_data, get_snapshot_time
from app.data.document_store import build_index
from app.data.auth import MOCK_USERS, UserContext, get_user, is_internal
from app.agent.core import chat
from app.llm.provider import get_provider
from app.tools.action_tool import execute_action, get_escalations, get_followup_tasks
from app.tools.analytics import run as run_analytics


# ---------------------------------------------------------------------------
# Logging configuration
# IMPORTANT: The API key and customer PII are never logged.
# ---------------------------------------------------------------------------

def _configure_logging() -> None:
    log_level = os.environ.get("LOG_LEVEL", "INFO").upper()
    logging.config.dictConfig(
        {
            "version": 1,
            "disable_existing_loggers": False,
            "formatters": {
                "default": {
                    "format": "%(asctime)s  %(levelname)-8s  %(name)s  %(message)s",
                    "datefmt": "%Y-%m-%d %H:%M:%S",
                },
            },
            "handlers": {
                "console": {
                    "class": "logging.StreamHandler",
                    "formatter": "default",
                },
            },
            "loggers": {
                # ParcelPilot namespaced loggers
                "parcelPilot": {"level": log_level, "handlers": ["console"], "propagate": False},
                # Suppress noisy third-party loggers
                "httpx": {"level": "WARNING"},
                "httpcore": {"level": "WARNING"},
                "google": {"level": "WARNING"},
                "sentence_transformers": {"level": "WARNING"},
                "faiss": {"level": "WARNING"},
            },
            "root": {"level": "WARNING", "handlers": ["console"]},
        }
    )


_configure_logging()
logger = logging.getLogger("parcelPilot.main")


# ---------------------------------------------------------------------------
# Startup
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("[startup] Loading Excel data…")
    load_excel_data()

    logger.info("[startup] Building document index (cached after first run)…")
    build_index()

    logger.info("[startup] Initialising LLM provider…")
    try:
        provider = get_provider()
        info = provider.health_info()
        if not info.get("api_key_configured"):
            logger.warning(
                "[startup] LLM API key is NOT configured — chat will fail. "
                "Set GEMINI_API_KEY in .env"
            )
        else:
            logger.info(
                "[startup] LLM ready: provider=%s model=%s key=%s",
                info["provider"],
                info["model"],
                info.get("api_key_hint", "***"),
            )
    except Exception as e:
        logger.error("[startup] LLM provider init error: %s", e)

    logger.info("[startup] Ready.")
    yield


app = FastAPI(
    title="ParcelPilot AI Support API",
    version="2.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],   # tighten in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Auth dependency (mock)
# ---------------------------------------------------------------------------

def get_current_user(x_user_id: str = Header(default="alice")) -> UserContext:
    user = get_user(x_user_id)
    if user is None:
        logger.warning("[auth] Unknown user_id: %s", x_user_id)
        raise HTTPException(status_code=401, detail=f"Unknown user: {x_user_id}")
    return user


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class Message(BaseModel):
    role: str       # "user" | "assistant"
    content: str


class ChatRequest(BaseModel):
    messages: list[Message]


class ChatResponse(BaseModel):
    reply: str
    tool_calls: list[dict]
    pending_action: Optional[dict] = None
    sources: list[dict]


class ConfirmActionRequest(BaseModel):
    action_type: str
    params: dict[str, Any]


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get("/api/health")
def health():
    return {"status": "ok", "snapshot_time": get_snapshot_time()}


@app.get("/api/llm-health")
def llm_health():
    """
    Confirms LLM configuration is present without exposing the API key.
    Returns provider name, model, and whether the key is set.
    """
    try:
        provider = get_provider()
        info = provider.health_info()
        # Ensure the raw key is never present in the response
        info.pop("api_key", None)
        return {"status": "ok", **info}
    except Exception as e:
        logger.error("[llm-health] Provider error: %s", e)
        return {
            "status": "error",
            "detail": str(e),
            "api_key_configured": bool(os.environ.get("GEMINI_API_KEY")),
        }


@app.get("/api/me")
def me(user: UserContext = Depends(get_current_user)):
    return {
        "user_id": user.user_id,
        "email": user.email,
        "role": user.role,
        "account_id": user.account_id,
        "display_name": user.display_name,
        "is_internal": is_internal(user),
    }


@app.get("/api/users")
def list_users():
    """Return mock users for the login selector UI."""
    return [
        {
            "user_id": uid,
            "display_name": u.display_name,
            "role": u.role,
            "account_id": u.account_id,
        }
        for uid, u in MOCK_USERS.items()
    ]


@app.post("/api/chat", response_model=ChatResponse)
def chat_endpoint(req: ChatRequest, user: UserContext = Depends(get_current_user)):
    """Main chat endpoint. Accepts conversation history and returns agent response."""
    logger.info(
        "[chat-endpoint] user=%s turns=%d", user.user_id, len(req.messages)
    )
    messages = [{"role": m.role, "content": m.content} for m in req.messages]
    result = chat(messages=messages, user=user)
    return ChatResponse(
        reply=result["reply"],
        tool_calls=result["tool_calls"],
        pending_action=result.get("pending_action"),
        sources=result["sources"],
    )


@app.post("/api/confirm-action")
def confirm_action(
    req: ConfirmActionRequest, user: UserContext = Depends(get_current_user)
):
    """Execute a previously staged action after explicit user confirmation."""
    logger.info(
        "[confirm-action] user=%s action_type=%s", user.user_id, req.action_type
    )
    result = execute_action(
        user=user, action_type=req.action_type, params=req.params
    )
    return result


@app.get("/api/escalations")
def list_escalations(user: UserContext = Depends(get_current_user)):
    return {"escalations": get_escalations(user)}


@app.get("/api/followup-tasks")
def list_followup_tasks(user: UserContext = Depends(get_current_user)):
    return {"tasks": get_followup_tasks(user)}


@app.get("/api/analytics")
def analytics_endpoint(user: UserContext = Depends(get_current_user)):
    """Proactive issue detection — internal users only."""
    if not is_internal(user):
        raise HTTPException(
            status_code=403,
            detail="Analytics are only available to internal users.",
        )
    result = run_analytics(user=user, operation="detect_issues")
    return result


@app.get("/api/snapshot-time")
def snapshot_time():
    return {"snapshot_time": get_snapshot_time()}


# ---------------------------------------------------------------------------
# Serve frontend static files
# Must be registered AFTER all /api routes so they take priority
# ---------------------------------------------------------------------------
_FRONTEND_DIR = Path(__file__).parent.parent.parent / "frontend"

if _FRONTEND_DIR.exists():
    # Serve JS/CSS as static assets under /static
    app.mount("/static", StaticFiles(directory=str(_FRONTEND_DIR)), name="static")

    @app.get("/", include_in_schema=False)
    @app.get("/{full_path:path}", include_in_schema=False)
    def serve_frontend(full_path: str = ""):
        """Catch-all: serve index.html for all non-API routes (SPA routing)."""
        index = _FRONTEND_DIR / "index.html"
        if index.exists():
            return FileResponse(str(index))
        return {"error": "Frontend not found"}
else:
    logger.warning("[startup] Frontend directory not found at %s", _FRONTEND_DIR)
