"""
LLM Provider abstraction layer
==============================

Defines a provider-agnostic interface so the agent loop in core.py never
imports a vendor SDK directly.  Swapping the provider later means only
touching this file and the relevant concrete class — not the agent or tools.

Current providers
-----------------
  GeminiProvider  — google-genai SDK (gemini-2.5-flash by default)

Adding a new provider
---------------------
  1. Implement BaseLLMProvider (see interface below).
  2. Add it to PROVIDER_REGISTRY.
  3. Set LLM_PROVIDER=<key> in .env.

Public API consumed by the agent
---------------------------------
  provider = get_provider()          # returns the configured singleton

  # Generate a response (no tools)
  response: LLMResponse = provider.generate(
      system_prompt: str,
      history: list[ConversationTurn],
      tools: list[ToolSchema] | None,
  )

  # Check config (for health endpoint — key is NEVER returned)
  info: dict = provider.health_info()
"""

from __future__ import annotations

import logging
import os
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Optional

logger = logging.getLogger("parcelPilot.llm")

# ---------------------------------------------------------------------------
# Data-transfer objects shared across providers
# ---------------------------------------------------------------------------

@dataclass
class ToolSchema:
    """Provider-agnostic tool definition (maps to OpenAI / Gemini function schemas)."""
    name: str
    description: str
    # JSON-schema-style parameter dict, e.g.:
    # {"type": "object", "properties": {...}, "required": [...]}
    parameters: dict[str, Any]


@dataclass
class ToolCall:
    """A single tool-call instruction emitted by the LLM."""
    call_id: str        # opaque ID used to correlate the response
    tool_name: str
    args: dict[str, Any]


@dataclass
class ToolResult:
    """The result of executing a tool, returned to the LLM."""
    call_id: str        # must match ToolCall.call_id
    tool_name: str
    result: dict[str, Any]   # JSON-serialisable


@dataclass
class ConversationTurn:
    """One message in the conversation history."""
    role: str           # "user" | "assistant" | "tool"
    content: str        # text (empty string for pure tool-call turns)
    tool_calls: list[ToolCall] = field(default_factory=list)   # set when role=="assistant"
    tool_results: list[ToolResult] = field(default_factory=list)  # set when role=="tool"


@dataclass
class LLMResponse:
    """Normalised response from any provider."""
    text: str                                      # final assistant text (may be "" if only tool calls)
    tool_calls: list[ToolCall] = field(default_factory=list)
    finish_reason: str = "stop"                    # "stop" | "tool_calls" | "error"
    raw: Any = field(default=None, repr=False)     # the raw SDK response object


# ---------------------------------------------------------------------------
# Abstract base
# ---------------------------------------------------------------------------

class BaseLLMProvider(ABC):
    """
    Every provider must implement these three methods.
    The agent loop only calls generate() and health_info().
    build_tool_schemas() converts the provider-agnostic ToolSchema list into
    whatever format the vendor SDK expects — that detail stays inside the
    provider class.
    """

    @abstractmethod
    def generate(
        self,
        system_prompt: str,
        history: list[ConversationTurn],
        tools: Optional[list[ToolSchema]] = None,
    ) -> LLMResponse:
        """
        Send a single generation request to the LLM.

        - system_prompt : the static system instruction for this session
        - history       : full conversation so far (user/assistant/tool turns)
        - tools         : available tools (or None for a plain completion)
        Returns a normalised LLMResponse.
        """

    @abstractmethod
    def health_info(self) -> dict:
        """
        Return a dict suitable for the /api/llm-health endpoint.
        MUST NOT include the API key or any secret value.
        """


# ---------------------------------------------------------------------------
# Gemini provider
# ---------------------------------------------------------------------------

class GeminiProvider(BaseLLMProvider):
    """
    Google Gemini via the `google-genai` SDK (package: google-genai).

    Configuration (all via environment variables):
        GEMINI_API_KEY   — required
        GEMINI_MODEL     — default: gemini-2.5-flash
    """

    # Retry settings
    _MAX_RETRIES = 3
    _RETRY_BASE_DELAY = 2.0   # seconds; doubles each attempt

    def __init__(self) -> None:
        self._api_key: str = os.environ.get("GEMINI_API_KEY", "")
        self._model: str = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
        self._client = None   # lazy-initialised

        if not self._api_key:
            logger.error("[GeminiProvider] GEMINI_API_KEY is not set.")
        else:
            logger.info(
                "[GeminiProvider] Configured — model=%s key=***%s",
                self._model,
                self._api_key[-4:],   # only last 4 chars for confirmation
            )

    # ------------------------------------------------------------------
    # Lazy client
    # ------------------------------------------------------------------

    def _get_client(self):
        if self._client is None:
            try:
                from google import genai
                self._client = genai.Client(api_key=self._api_key)
                logger.info("[GeminiProvider] Client initialised.")
            except ImportError as e:
                raise RuntimeError(
                    "google-genai package is not installed. "
                    "Run: pip install google-genai"
                ) from e
        return self._client

    # ------------------------------------------------------------------
    # Tool schema conversion
    # ------------------------------------------------------------------

    def _build_gemini_tools(self, tools: list[ToolSchema]):
        """Convert ToolSchema list → google.genai types.Tool."""
        from google.genai import types

        declarations = []
        for t in tools:
            declarations.append(
                types.FunctionDeclaration(
                    name=t.name,
                    description=t.description,
                    parameters_json_schema=t.parameters,
                )
            )
        return [types.Tool(function_declarations=declarations)]

    # ------------------------------------------------------------------
    # History conversion
    # ------------------------------------------------------------------

    def _build_gemini_contents(
        self, history: list[ConversationTurn]
    ) -> list:
        """
        Convert ConversationTurn list → list[types.Content] for Gemini.

        Gemini's conversation format:
          - User messages       → Content(role="user",  parts=[Part.from_text(...)])
          - Assistant text      → Content(role="model", parts=[Part.from_text(...)])
          - Assistant tool call → Content(role="model", parts=[Part.from_function_call(...)])
          - Tool result         → Content(role="tool",  parts=[Part.from_function_response(...)])

        One ConversationTurn with both tool_calls AND text becomes two
        Contents (model text first, then model function calls) — but in
        practice Gemini returns them as one content with multiple parts.
        We match what the SDK expects based on what the model emitted.
        """
        from google.genai import types

        contents = []

        for turn in history:
            if turn.role == "user":
                contents.append(
                    types.Content(
                        role="user",
                        parts=[types.Part.from_text(text=turn.content)],
                    )
                )

            elif turn.role == "assistant":
                parts = []
                # Text part (may be empty when the assistant only called tools)
                if turn.content:
                    parts.append(types.Part.from_text(text=turn.content))
                # Function-call parts
                for tc in turn.tool_calls:
                    parts.append(
                        types.Part.from_function_call(
                            name=tc.tool_name,
                            args=tc.args,
                        )
                    )
                if parts:
                    contents.append(types.Content(role="model", parts=parts))

            elif turn.role == "tool":
                parts = [
                    types.Part.from_function_response(
                        name=tr.tool_name,
                        response=tr.result,
                    )
                    for tr in turn.tool_results
                ]
                if parts:
                    contents.append(types.Content(role="tool", parts=parts))

        return contents

    # ------------------------------------------------------------------
    # Core generate() with retry
    # ------------------------------------------------------------------

    def generate(
        self,
        system_prompt: str,
        history: list[ConversationTurn],
        tools: Optional[list[ToolSchema]] = None,
    ) -> LLMResponse:
        from google.genai import types, errors as genai_errors

        client = self._get_client()
        contents = self._build_gemini_contents(history)
        gemini_tools = self._build_gemini_tools(tools) if tools else None

        config_kwargs: dict[str, Any] = {
            "system_instruction": system_prompt,
            "temperature": 0.1,
        }
        if gemini_tools:
            config_kwargs["tools"] = gemini_tools
            # AUTO mode: model decides whether to call a tool or respond in text
            config_kwargs["tool_config"] = types.ToolConfig(
                function_calling_config=types.FunctionCallingConfig(mode="AUTO")
            )
            # We manage the loop ourselves — disable SDK auto-calling
            config_kwargs["automatic_function_calling"] = (
                types.AutomaticFunctionCallingConfig(disable=True)
            )

        gen_config = types.GenerateContentConfig(**config_kwargs)

        last_error: Optional[Exception] = None
        for attempt in range(self._MAX_RETRIES):
            try:
                logger.debug(
                    "[GeminiProvider] generate attempt=%d model=%s history_len=%d",
                    attempt + 1,
                    self._model,
                    len(contents),
                )
                response = client.models.generate_content(
                    model=self._model,
                    contents=contents,
                    config=gen_config,
                )
                return self._parse_response(response)

            except genai_errors.APIError as e:
                status = getattr(e, "code", None) or getattr(e, "status_code", None)
                logger.warning(
                    "[GeminiProvider] APIError attempt=%d status=%s message=%s",
                    attempt + 1,
                    status,
                    str(e)[:200],
                )
                # 429 = rate limit, 503 = overloaded → retry with backoff
                if status in (429, 503) and attempt < self._MAX_RETRIES - 1:
                    delay = self._RETRY_BASE_DELAY * (2 ** attempt)
                    logger.info("[GeminiProvider] Retrying in %.1fs…", delay)
                    time.sleep(delay)
                    last_error = e
                    continue
                raise  # non-retryable or final attempt

            except Exception as e:
                logger.error(
                    "[GeminiProvider] Unexpected error attempt=%d: %s",
                    attempt + 1,
                    type(e).__name__,
                )
                last_error = e
                if attempt < self._MAX_RETRIES - 1:
                    time.sleep(self._RETRY_BASE_DELAY)
                    continue
                raise

        # Should not reach here, but keep mypy happy
        raise RuntimeError(f"All {self._MAX_RETRIES} attempts failed") from last_error

    # ------------------------------------------------------------------
    # Response parsing
    # ------------------------------------------------------------------

    def _parse_response(self, response) -> LLMResponse:
        """Normalise a raw Gemini GenerateContentResponse → LLMResponse."""
        if not response.candidates:
            logger.warning("[GeminiProvider] Empty candidates in response.")
            return LLMResponse(
                text="",
                finish_reason="error",
                raw=response,
            )

        candidate = response.candidates[0]
        finish_reason_raw = str(
            getattr(candidate, "finish_reason", "STOP") or "STOP"
        )
        finish_reason = (
            "tool_calls"
            if "TOOL" in finish_reason_raw.upper() or "FUNCTION" in finish_reason_raw.upper()
            else "stop"
        )

        text_parts: list[str] = []
        tool_calls: list[ToolCall] = []

        if candidate.content and candidate.content.parts:
            for i, part in enumerate(candidate.content.parts):
                if part.text:
                    text_parts.append(part.text)
                elif part.function_call:
                    fc = part.function_call
                    tool_calls.append(
                        ToolCall(
                            call_id=f"call_{fc.name}_{i}",
                            tool_name=fc.name,
                            args=dict(fc.args) if fc.args else {},
                        )
                    )

        # If we have tool calls, update finish reason
        if tool_calls:
            finish_reason = "tool_calls"

        text = "".join(text_parts).strip()

        logger.debug(
            "[GeminiProvider] Response: text_len=%d tool_calls=%d finish=%s",
            len(text),
            len(tool_calls),
            finish_reason,
        )

        return LLMResponse(
            text=text,
            tool_calls=tool_calls,
            finish_reason=finish_reason,
            raw=response,
        )

    # ------------------------------------------------------------------
    # Health info
    # ------------------------------------------------------------------

    def health_info(self) -> dict:
        key_set = bool(self._api_key)
        return {
            "provider": "gemini",
            "model": self._model,
            "api_key_configured": key_set,
            # Never expose the key itself — only confirm it exists
            "api_key_hint": f"***{self._api_key[-4:]}" if key_set else None,
            "sdk_package": "google-genai",
        }


# ---------------------------------------------------------------------------
# Provider registry and factory
# ---------------------------------------------------------------------------

PROVIDER_REGISTRY: dict[str, type[BaseLLMProvider]] = {
    "gemini": GeminiProvider,
    # Future providers:
    # "openai": OpenAIProvider,
    # "anthropic": AnthropicProvider,
}

_provider_singleton: Optional[BaseLLMProvider] = None


def get_provider() -> BaseLLMProvider:
    """
    Return the configured LLM provider singleton.
    Provider is selected by the LLM_PROVIDER env var (default: "gemini").
    """
    global _provider_singleton
    if _provider_singleton is None:
        provider_name = os.environ.get("LLM_PROVIDER", "gemini").lower()
        provider_cls = PROVIDER_REGISTRY.get(provider_name)
        if provider_cls is None:
            raise ValueError(
                f"Unknown LLM_PROVIDER='{provider_name}'. "
                f"Available: {list(PROVIDER_REGISTRY.keys())}"
            )
        _provider_singleton = provider_cls()
        logger.info("[provider] Initialised LLM provider: %s", provider_name)
    return _provider_singleton


def reset_provider() -> None:
    """Force re-initialisation of the provider singleton (useful in tests)."""
    global _provider_singleton
    _provider_singleton = None
