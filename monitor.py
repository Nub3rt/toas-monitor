import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone
from html import unescape

import requests
from bs4 import BeautifulSoup


URL = "https://toas.fi/en/quickly-available/"
HEADING = "Tenancy agreement beginning immediately"
STATE_VARIABLE = "TOAS_MONITOR_STATE"

TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN")
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID")

GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN")
GITHUB_REPOSITORY = os.environ.get("GITHUB_REPOSITORY")


def normalize_text(value: str) -> str:
    """
    Normalize whitespace so insignificant HTML formatting changes
    do not count as content changes.
    """
    value = unescape(value)
    value = value.replace("\xa0", " ")
    value = re.sub(r"\s+", " ", value)
    return value.strip()


def fetch_page() -> str:
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (compatible; TOAS-availability-monitor/1.0; "
            "+https://github.com/)"
        )
    }

    response = requests.get(
        URL,
        headers=headers,
        timeout=30,
    )

    response.raise_for_status()
    return response.text


def parse_monitored_tables(html: str) -> list[dict]:
    """
    Find the heading 'Tenancy agreement beginning immediately'
    and then collect the next two tables.

    We intentionally collect TWO tables because the current TOAS page
    has a second table that appears to be empty apart from its header.
    If TOAS later populates that second table, it will automatically
    become part of the monitored state.
    """

    soup = BeautifulSoup(html, "html.parser")

    heading = None

    for tag in soup.find_all(["h1", "h2", "h3", "h4"]):
        text = normalize_text(tag.get_text(" ", strip=True))

        if text.casefold() == HEADING.casefold():
            heading = tag
            break

    if heading is None:
        raise RuntimeError(
            f"Could not find heading: {HEADING!r}"
        )

    tables = []
    current = heading.find_next("table")

    while current is not None and len(tables) < 2:
        tables.append(parse_table(current))

        current = current.find_next("table")

    if len(tables) != 2:
        raise RuntimeError(
            f"Expected 2 tables after {HEADING!r}, found {len(tables)}"
        )

    return tables


def parse_table(table) -> dict:
    """
    Convert an HTML table into a stable JSON-compatible structure.
    """

    rows = []

    for tr in table.find_all("tr"):
        cells = tr.find_all(["th", "td"])

        values = [
            normalize_text(cell.get_text(" ", strip=True))
            for cell in cells
        ]

        # Ignore completely empty rows.
        if any(values):
            rows.append(values)

    if not rows:
        return {
            "headers": [],
            "rows": [],
        }

    headers = rows[0]
    data_rows = rows[1:]

    # Give every row the same number of columns as the header.
    normalized_rows = []

    for row in data_rows:
        if len(row) < len(headers):
            row = row + [""] * (len(headers) - len(row))
        elif len(row) > len(headers):
            row = row[:len(headers)]

        normalized_rows.append(row)

    return {
        "headers": headers,
        "rows": normalized_rows,
    }


def build_state(tables: list[dict]) -> dict:
    """
    Build the exact state that we care about.

    This excludes the rest of the TOAS page, including things like
    navigation, footer, page-update timestamps, etc.
    """

    return {
        "heading": HEADING,
        "tables": tables,
    }


def state_hash(state: dict) -> str:
    serialized = json.dumps(
        state,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )

    return hashlib.sha256(
        serialized.encode("utf-8")
    ).hexdigest()


def contains_mikontalo(state: dict) -> bool:
    """
    Search the contents of both monitored tables for Mikontalo.
    """

    for table in state["tables"]:
        for row in table["rows"]:
            for cell in row:
                if "mikontalo" in cell.casefold():
                    return True

    return False


def format_table(table: dict, table_number: int) -> str:
    """
    Produce a human-readable Telegram representation.
    """

    headers = table["headers"]
    rows = table["rows"]

    if not headers:
        return f"Table {table_number}: empty"

    lines = [f"Table {table_number}:"]

    if not rows:
        lines.append(
            "  " + " | ".join(headers) + " | [no apartments]"
        )
        return "\n".join(lines)

    for row in rows:
        pairs = []

        for header, value in zip(headers, row):
            if value:
                pairs.append(f"{header}: {value}")

        lines.append("  " + " | ".join(pairs))

    return "\n".join(lines)


def format_state(state: dict) -> str:
    parts = [
        "TOAS quickly available",
        "",
        f"URL: {URL}",
        "",
    ]

    for number, table in enumerate(state["tables"], start=1):
        parts.append(format_table(table, number))
        parts.append("")

    return "\n".join(parts).strip()


def send_telegram(message: str) -> None:
    if not TELEGRAM_BOT_TOKEN:
        raise RuntimeError("TELEGRAM_BOT_TOKEN is not configured")

    if not TELEGRAM_CHAT_ID:
        raise RuntimeError("TELEGRAM_CHAT_ID is not configured")

    endpoint = (
        f"https://api.telegram.org/bot"
        f"{TELEGRAM_BOT_TOKEN}/sendMessage"
    )

    response = requests.post(
        endpoint,
        json={
            "chat_id": TELEGRAM_CHAT_ID,
            "text": message,
            "disable_web_page_preview": True,
        },
        timeout=30,
    )

    response.raise_for_status()


def github_api(method: str, endpoint: str, **kwargs):
    if not GITHUB_TOKEN:
        raise RuntimeError("GITHUB_TOKEN is not configured")

    response = requests.request(
        method,
        f"https://api.github.com{endpoint}",
        headers={
            "Authorization": f"Bearer {GITHUB_TOKEN}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2026-03-10",
        },
        timeout=30,
        **kwargs,
    )

    return response


def get_previous_state_hash():
    """
    Read TOAS_MONITOR_STATE from repository Actions variables.

    The variable contains the hash of the previously observed state.
    """

    owner, repo = GITHUB_REPOSITORY.split("/", 1)

    response = github_api(
        "GET",
        f"/repos/{owner}/{repo}/actions/variables/{STATE_VARIABLE}",
    )

    if response.status_code == 404:
        return None

    response.raise_for_status()

    data = response.json()
    return data.get("value")


def save_state_hash(new_hash: str) -> None:
    """
    Create or update the repository Actions variable.
    """

    owner, repo = GITHUB_REPOSITORY.split("/", 1)

    endpoint = (
        f"/repos/{owner}/{repo}/actions/variables/{STATE_VARIABLE}"
    )

    payload = {
        "name": STATE_VARIABLE,
        "value": new_hash,
    }

    response = github_api(
        "PATCH",
        endpoint,
        json=payload,
    )

    if response.status_code == 404:
        response = github_api(
            "POST",
            f"/repos/{owner}/{repo}/actions/variables",
            json=payload,
        )

    response.raise_for_status()


def main() -> int:
    now = datetime.now(timezone.utc).astimezone()

    print(f"Checking TOAS: {URL}")
    print(f"Time: {now.isoformat()}")

    # 1. Download page.
    html = fetch_page()

    # 2. Parse the two relevant tables.
    tables = parse_monitored_tables(html)

    # 3. Build stable state.
    state = build_state(tables)

    # 4. Calculate hash.
    current_hash = state_hash(state)

    # 5. Load previous hash.
    previous_hash = get_previous_state_hash()

    changed = (
        previous_hash is not None
        and previous_hash != current_hash
    )

    mikontalo_present = contains_mikontalo(state)

    print(f"Previous hash: {previous_hash}")
    print(f"Current hash:  {current_hash}")
    print(f"Changed:       {changed}")
    print(f"Mikontalo:     {mikontalo_present}")

    # 6. Send notification if the monitored contents changed.
    if changed:
        message = (
            "TOAS ALERT — monitored content changed\n\n"
            f"{format_state(state)}"
        )

        send_telegram(message)
        print("Sent change notification.")

        # 7. Send a notification if Mikontalo exists.
        if mikontalo_present:
            message = (
                "TOAS ALERT — MIKONTALO IS PRESENT\n\n"
                f"{format_state(state)}"
            )
    
            send_telegram(message)
            print("Sent Mikontalo notification.")

    # 8. Save current state for the next execution.
    save_state_hash(current_hash)

    return 0


if __name__ == "__main__":
    sys.exit(main())
  
