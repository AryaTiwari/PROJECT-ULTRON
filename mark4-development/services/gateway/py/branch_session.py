from __future__ import annotations

import argparse
import json
from typing import Any

from hermes_state import SessionDB


def _model_config(source: dict[str, Any], source_id: str, anchor: str | None) -> dict[str, Any]:
    raw = source.get("model_config")
    if isinstance(raw, str):
        try:
            cfg = json.loads(raw)
        except Exception:
            cfg = {}
    elif isinstance(raw, dict):
        cfg = dict(raw)
    else:
        cfg = {}
    cfg["_branched_from"] = source_id
    cfg["_ultron_nested_followup"] = True
    if anchor:
        cfg["_ultron_anchor_message_id"] = anchor
    return cfg


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--child", required=True)
    parser.add_argument("--title", default="Follow-up branch")
    parser.add_argument("--anchor")
    args = parser.parse_args()

    db = SessionDB()
    created = False
    try:
        source = db.get_session(args.source)
        if not source:
            raise RuntimeError("SOURCE_SESSION_NOT_FOUND")
        if db.get_session(args.child):
            raise RuntimeError("BRANCH_SESSION_ALREADY_EXISTS")

        messages = list(db.get_messages(args.source) or [])
        if args.anchor:
            boundary = next((i for i, message in enumerate(messages) if str(message.get("id") or "") == args.anchor), None)
            if boundary is None:
                raise RuntimeError("ANCHOR_MESSAGE_NOT_FOUND")
            messages = messages[: boundary + 1]

        db.create_session(
            args.child,
            "api_server",
            model=source.get("model"),
            system_prompt=source.get("system_prompt"),
            parent_session_id=args.source,
            model_config=_model_config(source, args.source, args.anchor),
        )
        created = True
        db.replace_messages(args.child, messages)
        if args.title:
            db.set_session_title(args.child, str(args.title))

        child = db.get_session(args.child) or {"id": args.child, "parent_session_id": args.source}
        print(json.dumps({
            "ok": True,
            "session": {
                "id": child.get("id", args.child),
                "title": child.get("title"),
                "parent_session_id": child.get("parent_session_id") or args.source,
                "source": child.get("source", "api_server"),
            },
            "anchorMessageId": args.anchor,
            "copiedMessages": len(messages),
        }, separators=(",", ":")))
    except Exception as exc:
        if created:
            try:
                db.delete_session(args.child)
            except Exception:
                pass
        print(json.dumps({"ok": False, "error": str(exc)}, separators=(",", ":")))
        raise
    finally:
        try:
            db.close()
        except Exception:
            pass


if __name__ == "__main__":
    main()
