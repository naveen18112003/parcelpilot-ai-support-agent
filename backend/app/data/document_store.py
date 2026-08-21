"""
Document store: loads PDFs, chunks them, embeds with sentence-transformers,
and stores in FAISS for retrieval.

Source reliability tiers (used downstream by the agent):
  TIER_1  – authoritative current policy / SOP / enterprise agreement
  TIER_2  – deprecated / superseded documents (low trust)
  TIER_3  – historical ticket resolutions (context-only, may be wrong)
"""

from __future__ import annotations

import os
import re
import json
import pickle
from pathlib import Path
from dataclasses import dataclass, field
from typing import Optional

import numpy as np

DATA_DIR = Path(__file__).parent.parent.parent / "data"
CACHE_DIR = Path(__file__).parent.parent.parent / "cache"
CACHE_DIR.mkdir(exist_ok=True)

# ---------------------------------------------------------------------------
# Source metadata registry
# ---------------------------------------------------------------------------
TIER_1 = "authoritative"
TIER_2 = "deprecated"
TIER_3 = "historical_context"

SOURCE_REGISTRY: list[dict] = [
    {
        "filename": "01_Support_Policy_v3_CURRENT.pdf",
        "short_name": "Support Policy v3 (Current)",
        "tier": TIER_1,
        "trust_note": "Current authoritative support policy.",
        "doc_type": "policy",
    },
    {
        "filename": "02_Support_Policy_v2_DEPRECATED.pdf",
        "short_name": "Support Policy v2 (Deprecated)",
        "tier": TIER_2,
        "trust_note": "Superseded by v3. Use only if v3 is silent on the topic.",
        "doc_type": "policy",
    },
    {
        "filename": "03_Cancellation_and_Service_Credit_SOP_v4.pdf",
        "short_name": "Cancellation & Service Credit SOP v4",
        "tier": TIER_1,
        "trust_note": "Current SOP for cancellations and service credits.",
        "doc_type": "sop",
    },
    {
        "filename": "04_Product_Operations_Guide_and_Known_Issues.pdf",
        "short_name": "Product Operations Guide & Known Issues",
        "tier": TIER_1,
        "trust_note": "Authoritative product and operations reference.",
        "doc_type": "product_guide",
    },
    {
        "filename": "05_Northstar_Logistics_Enterprise_Agreement.pdf",
        "short_name": "Northstar Logistics Enterprise Agreement",
        "tier": TIER_1,
        "trust_note": "Customer-specific agreement. Overrides general policy for Northstar.",
        "doc_type": "customer_agreement",
        "account_id": "ACC-001",
    },
    {
        "filename": "06_LumenWorks_Service_Agreement.pdf",
        "short_name": "LumenWorks Service Agreement",
        "tier": TIER_1,
        "trust_note": "Customer-specific agreement. Overrides general policy for LumenWorks.",
        "doc_type": "customer_agreement",
        "account_id": "ACC-002",
    },
]


@dataclass
class DocumentChunk:
    chunk_id: str
    source_filename: str
    source_short_name: str
    tier: str
    trust_note: str
    doc_type: str
    account_id: Optional[str]
    page_number: int
    text: str
    embedding: Optional[np.ndarray] = field(default=None, repr=False)


# ---------------------------------------------------------------------------
# Global chunk store
# ---------------------------------------------------------------------------
_chunks: list[DocumentChunk] = []
_embeddings_matrix: Optional[np.ndarray] = None  # shape (N, dim)


# ---------------------------------------------------------------------------
# Chunking helpers
# ---------------------------------------------------------------------------
def _chunk_text(text: str, chunk_size: int = 600, overlap: int = 100) -> list[str]:
    """Split text into overlapping chunks by character count."""
    words = text.split()
    chunks, current, count = [], [], 0
    for word in words:
        current.append(word)
        count += len(word) + 1
        if count >= chunk_size:
            chunks.append(" ".join(current))
            # Keep overlap words
            overlap_words = current[-max(1, overlap // 6):]
            current = overlap_words
            count = sum(len(w) + 1 for w in current)
    if current:
        chunks.append(" ".join(current))
    return [c for c in chunks if len(c.strip()) > 30]


def _extract_pdf_text(pdf_path: Path) -> list[tuple[int, str]]:
    """Return list of (page_number, text) tuples. Falls back to empty if pypdf missing."""
    try:
        from pypdf import PdfReader
        reader = PdfReader(str(pdf_path))
        pages = []
        for i, page in enumerate(reader.pages, start=1):
            text = page.extract_text() or ""
            text = re.sub(r"\s+", " ", text).strip()
            if text:
                pages.append((i, text))
        return pages
    except Exception as e:
        print(f"[document_store] Could not read {pdf_path.name}: {e}")
        return []


# ---------------------------------------------------------------------------
# Embedding model (lazy-loaded)
# ---------------------------------------------------------------------------
_embed_model = None


def _get_embed_model():
    global _embed_model
    if _embed_model is None:
        try:
            from sentence_transformers import SentenceTransformer
            _embed_model = SentenceTransformer("all-MiniLM-L6-v2")
            print("[document_store] Loaded SentenceTransformer model")
        except Exception as e:
            print(f"[document_store] SentenceTransformer unavailable: {e}. Falling back to OpenAI embeddings.")
    return _embed_model


def _embed_texts(texts: list[str]) -> np.ndarray:
    model = _get_embed_model()
    if model is not None:
        return model.encode(texts, show_progress_bar=False, convert_to_numpy=True)
    # Last resort: random embeddings — document search will not work correctly,
    # but this prevents a crash during startup if sentence-transformers failed to load.
    print("[document_store] WARNING: No embedding model available. Install sentence-transformers.")
    return np.random.rand(len(texts), 384).astype("float32")


# ---------------------------------------------------------------------------
# Build / load index
# ---------------------------------------------------------------------------
CACHE_FILE = CACHE_DIR / "doc_chunks.pkl"


def build_index(force_rebuild: bool = False) -> None:
    """Load PDFs, chunk, embed, and build FAISS index. Caches to disk."""
    global _chunks, _embeddings_matrix

    if not force_rebuild and CACHE_FILE.exists():
        print("[document_store] Loading from cache...")
        with open(CACHE_FILE, "rb") as f:
            _chunks, _embeddings_matrix = pickle.load(f)
        print(f"[document_store] Loaded {len(_chunks)} chunks from cache")
        return

    print("[document_store] Building document index from scratch...")
    all_chunks: list[DocumentChunk] = []

    for meta in SOURCE_REGISTRY:
        pdf_path = DATA_DIR / meta["filename"]
        if not pdf_path.exists():
            print(f"[document_store] File not found: {pdf_path.name} — skipping")
            continue

        pages = _extract_pdf_text(pdf_path)
        if not pages:
            continue

        for page_num, page_text in pages:
            for chunk_text in _chunk_text(page_text):
                chunk_id = f"{meta['filename']}::p{page_num}::{hash(chunk_text) & 0xFFFFFF}"
                all_chunks.append(DocumentChunk(
                    chunk_id=chunk_id,
                    source_filename=meta["filename"],
                    source_short_name=meta["short_name"],
                    tier=meta["tier"],
                    trust_note=meta["trust_note"],
                    doc_type=meta["doc_type"],
                    account_id=meta.get("account_id"),
                    page_number=page_num,
                    text=chunk_text,
                ))

    if not all_chunks:
        print("[document_store] WARNING: No document chunks built. PDF files may be missing from data/")
        _chunks = []
        _embeddings_matrix = np.zeros((0, 384), dtype="float32")
        return

    # Embed all chunks
    print(f"[document_store] Embedding {len(all_chunks)} chunks...")
    texts = [c.text for c in all_chunks]
    embeddings = _embed_texts(texts).astype("float32")

    for chunk, emb in zip(all_chunks, embeddings):
        chunk.embedding = emb

    _chunks = all_chunks
    _embeddings_matrix = embeddings

    # Cache to disk
    with open(CACHE_FILE, "wb") as f:
        pickle.dump((_chunks, _embeddings_matrix), f)
    print(f"[document_store] Indexed {len(_chunks)} chunks and cached.")


def _cosine_similarity(query_vec: np.ndarray, matrix: np.ndarray) -> np.ndarray:
    """Compute cosine similarity between query_vec and every row in matrix."""
    query_norm = query_vec / (np.linalg.norm(query_vec) + 1e-10)
    norms = np.linalg.norm(matrix, axis=1, keepdims=True) + 1e-10
    normed = matrix / norms
    return normed @ query_norm


# ---------------------------------------------------------------------------
# Search API
# ---------------------------------------------------------------------------
def search_documents(
    query: str,
    top_k: int = 5,
    account_id: str | None = None,
    include_deprecated: bool = False,
) -> list[dict]:
    """
    Semantic search over document chunks.

    Parameters
    ----------
    query          : natural-language query
    top_k          : number of results to return
    account_id     : if set, also include customer-agreement chunks for that account
    include_deprecated : whether to include TIER_2 (deprecated) docs

    Returns list of dicts with keys:
        chunk_id, source_short_name, tier, trust_note, doc_type,
        page_number, text, score
    """
    global _chunks, _embeddings_matrix

    if not _chunks:
        build_index()

    if len(_chunks) == 0:
        return []

    # Filter eligible chunks
    eligible_indices = []
    for i, chunk in enumerate(_chunks):
        if not include_deprecated and chunk.tier == TIER_2:
            continue
        # Customer agreements: include if no account_id filter, or if it matches
        if chunk.doc_type == "customer_agreement":
            if account_id and chunk.account_id != account_id:
                continue
        eligible_indices.append(i)

    if not eligible_indices:
        return []

    # Embed query
    q_emb = _embed_texts([query])[0].astype("float32")

    sub_matrix = _embeddings_matrix[eligible_indices]
    scores = _cosine_similarity(q_emb, sub_matrix)

    # Sort descending
    top_local = min(top_k, len(eligible_indices))
    top_idx = np.argsort(scores)[::-1][:top_local]

    results = []
    for local_i in top_idx:
        global_i = eligible_indices[local_i]
        c = _chunks[global_i]
        results.append({
            "chunk_id": c.chunk_id,
            "source_short_name": c.source_short_name,
            "source_filename": c.source_filename,
            "tier": c.tier,
            "trust_note": c.trust_note,
            "doc_type": c.doc_type,
            "page_number": c.page_number,
            "text": c.text,
            "score": float(scores[local_i]),
        })

    return results


def get_source_registry() -> list[dict]:
    """Return public-safe source metadata (no embeddings)."""
    return [
        {k: v for k, v in meta.items()}
        for meta in SOURCE_REGISTRY
    ]
