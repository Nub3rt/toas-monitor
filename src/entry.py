import hashlib
import json
import re
import traceback
from datetime import datetime
from zoneinfo import ZoneInfo
from html import unescape

from bs4 import BeautifulSoup
from workers import WorkerEntrypoint, fetch


URL = "https://toas.fi/en/quickly-available/"
HEADING = "Tenancy agreement beginning immediately"

STATE_KEY = "state"

TELEGRAM_API = "https://api.telegram.org"

USER_AGENT = (
    "Mozilla/5.0 (compatible; TOAS-availability-monitor/1.0; "
    "+https://github.com/Nub3rt/toas-monitor)"
)


def normalize_text(value: str) -> str:
    """
    Normalize whitespace so insignificant HTML formatting changes
    do not count as content changes.
    """
    value = unescape(value)
    value = value.replace("\xa0", " ")
    value = re.sub(r"\s+", " ", value)
    return value.strip()


async def fetch_page() -> str:
    """
    Fetch the TOAS page using the Cloudflare Workers fetch API.
    """

    response = await fetch(
        URL,
        {
            "headers": {
                "User-Agent": USER_AGENT,
            }
        },
    )

    if not response.ok:
        raise RuntimeError(
            f"TOAS returned HTTP {response.status}"
        )

    return await response.text()


def parse_monitored_tables(html: str) -> list[dict]:
    """
    Find the heading 'Tenancy agreement beginning immediately'
    and then collect the next two tables.

    We intentionally collect TWO tables.

    If TOAS removes the section entirely because there are no flats,
    an empty list is returned. This preserves the behavior of the
    existing monitor.
    """

    soup = BeautifulSoup(html, "html.parser")

    heading = None

    for tag in soup.find_all(["h1", "h2", "h3", "h4"]):
        text = normalize_text(
            tag.get_text(" ", strip=True)
        )

        if text.casefold() == HEADING.casefold():
            heading = tag
            break

    if heading is None:
        # TOAS omits this section entirely when no flats are available.
        return []

    tables = []

    current = heading.find_next("table")

    while current is not None and len(tables) < 2:
        tables.append(parse_table(current))
        current = current.find_next("table")

    return tables


def parse_table(table) -> dict:
    """
    Convert an HTML table into a stable JSON-compatible structure.
    """

    rows = []

    for tr in table.find_all("tr"):
        cells = tr.find_all(["th", "td"])

        values = [
            normalize_text(
                cell.get_text(" ", strip=True)
            )
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

    normalized_rows = []

    for row in data_rows:
        if len(row) < len(headers):
            row = row + [""] * (
                len(headers) - len(row)
            )

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

    This excludes the rest of the TOAS page, including navigation,
    footer, page-update timestamps, etc.
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


def format_table(
    table: dict,
    table_number: int
) -> str:
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
            "  "
            + " | ".join(headers)
            + " | [no apartments]"
        )

        return "\n".join(lines)

    for row in rows:
        pairs = []

        for header, value in zip(headers, row):
            if value:
                pairs.append(
                    f"{header}: {value}"
                )

        lines.append(
            "  " + " | ".join(pairs)
        )

    return "\n".join(lines)


def format_state(state: dict) -> str:
    parts = [
        "TOAS quickly available",
        "",
        f"URL: {URL}",
        "",
    ]

    if not state["tables"]:
        parts.append("No flats available.")
        return "\n".join(parts).strip()

    for number, table in enumerate(
        state["tables"],
        start=1
    ):
        parts.append(
            format_table(table, number)
        )
        parts.append("")

    return "\n".join(parts).strip()


async def send_telegram(
    env,
    message: str
) -> None:
    """
    Send a Telegram message using the Bot API.
    """

    if not env.TELEGRAM_BOT_TOKEN:
        raise RuntimeError(
            "TELEGRAM_BOT_TOKEN is not configured"
        )

    if not env.TELEGRAM_CHAT_ID:
        raise RuntimeError(
            "TELEGRAM_CHAT_ID is not configured"
        )

    endpoint = (
        f"{TELEGRAM_API}/bot"
        f"{env.TELEGRAM_BOT_TOKEN}"
        f"/sendMessage"
    )

    response = await fetch(
        endpoint,
        {
            "method": "POST",
            "headers": {
                "Content-Type": "application/json",
            },
            "body": json.dumps(
                {
                    "chat_id": env.TELEGRAM_CHAT_ID,
                    "text": message,
                    "disable_web_page_preview": True,
                }
            ),
        },
    )

    if not response.ok:
        body = await response.text()

        raise RuntimeError(
            "Telegram returned HTTP "
            f"{response.status}: {body[:500]}"
        )


async def get_previous_state_hash(env):
    """
    Read the previous hash from Cloudflare KV.

    Returns None if there is no previous state.
    """

    value = await env.TOAS_STATE.get(STATE_KEY)

    if value is None:
        return None

    try:
        data = json.loads(value)
    except Exception as exc:
        raise RuntimeError(
            "Cloudflare KV contains invalid state JSON"
        ) from exc

    return data.get("value")


async def save_state_hash(
    env,
    new_hash: str
) -> None:
    """
    Save the current hash in Cloudflare KV.
    """

    await env.TOAS_STATE.put(
        STATE_KEY,
        json.dumps({
            "value": new_hash
        }),
    )


async def send_error_notification(
    env,
    error: Exception
) -> None:
    """
    Notify Telegram when the monitor itself fails.

    This intentionally does not include the full traceback in Telegram,
    to keep the message short and avoid exposing unnecessary internals.
    """

    timestamp = (
        datetime.now(ZoneInfo("Europe/Helsinki")).isoformat()
    )

    message = (
        "TOAS MONITOR ERROR\n\n"
        f"Time: {timestamp}\n"
        f"Error: {type(error).__name__}: {error}\n\n"
        "The previous saved state was NOT overwritten."
    )

    try:
        await send_telegram(
            env,
            message
        )
    except Exception as telegram_error:
        print(
            "Could not send error notification: "
            f"{type(telegram_error).__name__}: "
            f"{telegram_error}"
        )


async def check_toas(env) -> None:
    """
    Main monitoring logic.

    This preserves the logic from the current GitHub version:

    - Monitor the two tables.
    - If the monitored content changed, send Telegram.
    - If Mikontalo is present but nothing changed, DO NOT send
      another message.
    - Save the new state after a successful check.
    """

    now = (
        datetime.now(ZoneInfo("Europe/Helsinki"))
    )

    print(f"Checking TOAS: {URL}")
    print(f"Time: {now.isoformat()}")

    # 1. Download page.
    html = await fetch_page()

    # 2. Parse the two relevant tables.
    tables = parse_monitored_tables(html)

    # 3. Build stable state.
    state = build_state(tables)

    # 4. Calculate hash.
    current_hash = state_hash(state)

    # 5. Load previous hash.
    previous_hash = await get_previous_state_hash(
        env
    )

    changed = (
        previous_hash is not None
        and previous_hash != current_hash
    )

    mikontalo_present = contains_mikontalo(
        state
    )

    print(
        f"Previous hash: {previous_hash}"
    )

    print(
        f"Current hash:  {current_hash}"
    )

    print(
        f"Changed:       {changed}"
    )

    print(
        f"Mikontalo:     {mikontalo_present}"
    )

    # 6. Send Telegram alerts only when
    # monitored content changes.
    if changed:
        message = (
            "TOAS ALERT — monitored content changed"
        )

        if mikontalo_present:
            message += (
                "; Mikontalo is present"
            )

        message += (
            f"\n\n{format_state(state)}"
        )

        await send_telegram(
            env,
            message
        )

        print(
            "Sent alert notification."
        )

    else:
        message = (
            "TOAS monitor ran successfully; "
            "no changes found."
        )

        if mikontalo_present:
            message += (
                " Mikontalo is present."
            )

        print(message)

    # 7. Save current state.
    #
    # Only reached if all previous operations succeeded.
    # Therefore a broken TOAS page or Telegram failure will not
    # accidentally overwrite the previous state.
    await save_state_hash(
        env,
        current_hash
    )


class Default(WorkerEntrypoint):

    async def scheduled(
        self,
        controller,
        env,
        ctx
    ):
        """
        Called by Cloudflare's Cron Trigger.
        """

        try:
            await check_toas(env)

        except Exception as error:
            print(
                "TOAS monitor failed:"
            )

            print(
                traceback.format_exc()
            )

            # Notify Telegram, then re-raise so the
            # Cloudflare invocation is also recorded as failed.
            await send_error_notification(
                env,
                error
            )

            raise
