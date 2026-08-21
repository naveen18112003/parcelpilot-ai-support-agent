"""
Data loader for ParcelPilot structured data (Excel) and unstructured documents (PDFs).
Handles parsing, normalisation, and in-memory storage.
"""

import os
import json
import hashlib
from pathlib import Path
from typing import Any
from datetime import datetime

import pandas as pd

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
DATA_DIR = Path(__file__).parent.parent.parent / "data"

# ---------------------------------------------------------------------------
# Dataset snapshot time (read from README sheet or fall back to default)
# ---------------------------------------------------------------------------
SNAPSHOT_TIME: str = "2025-06-01T00:00:00"  # overridden after Excel load


def _normalise_columns(df: pd.DataFrame) -> pd.DataFrame:
    """Lower-case, strip, and replace spaces with underscores in column names."""
    df.columns = [c.strip().lower().replace(" ", "_") for c in df.columns]
    return df


# ---------------------------------------------------------------------------
# Excel data (loaded once at startup)
# ---------------------------------------------------------------------------
_accounts_df: pd.DataFrame | None = None
_orders_df: pd.DataFrame | None = None
_tickets_df: pd.DataFrame | None = None


def load_excel_data(path: Path | None = None) -> None:
    """Load all sheets from the assessment Excel workbook into memory."""
    global _accounts_df, _orders_df, _tickets_df, SNAPSHOT_TIME

    excel_path = path or (DATA_DIR / "ParcelPilot_Assessment_Data.xlsx")
    if not excel_path.exists():
        print(f"[loader] WARNING: Excel file not found at {excel_path}. Using empty DataFrames.")
        _accounts_df = pd.DataFrame()
        _orders_df = pd.DataFrame()
        _tickets_df = pd.DataFrame()
        return

    xl = pd.ExcelFile(excel_path)
    sheet_names_lower = {s.lower(): s for s in xl.sheet_names}

    # ---- README / snapshot time ----
    readme_key = next((k for k in sheet_names_lower if "readme" in k), None)
    if readme_key:
        readme_df = xl.parse(sheet_names_lower[readme_key], header=None)
        for _, row in readme_df.iterrows():
            for cell in row:
                if isinstance(cell, str) and ("snapshot" in cell.lower() or "dataset time" in cell.lower()):
                    # Try to find the adjacent cell with the actual timestamp
                    pass
        # Try to pull a date from any cell in the README sheet
        for _, row in readme_df.iterrows():
            for cell in row:
                if isinstance(cell, (datetime,)):
                    SNAPSHOT_TIME = cell.isoformat()
                    break
                if isinstance(cell, str):
                    # Look for ISO-like date strings
                    import re
                    m = re.search(r"\d{4}-\d{2}-\d{2}", cell)
                    if m:
                        SNAPSHOT_TIME = m.group(0) + "T00:00:00"

    # ---- Accounts ----
    acct_key = next((k for k in sheet_names_lower if "account" in k), None)
    if acct_key:
        _accounts_df = _normalise_columns(xl.parse(sheet_names_lower[acct_key]))
    else:
        _accounts_df = pd.DataFrame()

    # ---- Orders ----
    order_key = next((k for k in sheet_names_lower if "order" in k), None)
    if order_key:
        _orders_df = _normalise_columns(xl.parse(sheet_names_lower[order_key]))
    else:
        _orders_df = pd.DataFrame()

    # ---- Tickets ----
    ticket_key = next((k for k in sheet_names_lower if "ticket" in k), None)
    if ticket_key:
        _tickets_df = _normalise_columns(xl.parse(sheet_names_lower[ticket_key]))
    else:
        _tickets_df = pd.DataFrame()

    print(f"[loader] Loaded: {len(_accounts_df)} accounts, {len(_orders_df)} orders, {len(_tickets_df)} tickets")
    print(f"[loader] Snapshot time: {SNAPSHOT_TIME}")


def get_accounts() -> pd.DataFrame:
    if _accounts_df is None:
        load_excel_data()
    return _accounts_df.copy()


def get_orders() -> pd.DataFrame:
    if _orders_df is None:
        load_excel_data()
    return _orders_df.copy()


def get_tickets() -> pd.DataFrame:
    if _tickets_df is None:
        load_excel_data()
    return _tickets_df.copy()


def get_snapshot_time() -> str:
    return SNAPSHOT_TIME


# ---------------------------------------------------------------------------
# Helper: serialise DataFrames to JSON-safe dicts
# ---------------------------------------------------------------------------
def df_to_records(df: pd.DataFrame) -> list[dict]:
    """Convert a DataFrame to a list of JSON-serialisable dicts."""
    records = []
    for rec in df.to_dict(orient="records"):
        clean = {}
        for k, v in rec.items():
            if pd.isna(v) if not isinstance(v, (list, dict)) else False:
                clean[k] = None
            elif isinstance(v, (pd.Timestamp, datetime)):
                clean[k] = v.isoformat()
            elif hasattr(v, "item"):  # numpy scalar
                clean[k] = v.item()
            else:
                clean[k] = v
        records.append(clean)
    return records
