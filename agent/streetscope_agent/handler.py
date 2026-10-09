"""AWS Lambda entry point. POST {"site": "aiims", "question": "..."} returns the checked answer."""

from __future__ import annotations

import json
import os
from pathlib import Path

from . import agent as A
from .tools import Site

_CACHE: dict[str, Site] = {}
SAFE_SITE = set("abcdefghijklmnopqrstuvwxyz0123456789_-")


def load_site(site_id: str) -> Site:
    if not site_id or set(site_id) - SAFE_SITE:
        raise ValueError("unknown site")
    if site_id in _CACHE:
        return _CACHE[site_id]
    local = Path(os.environ.get("TWIN_DIR", "/var/task/twins")) / site_id
    if not (local / "twin.json").exists():
        import boto3  # only needed when the twins live in S3

        bucket, prefix = os.environ["TWIN_BUCKET"], os.environ.get("TWIN_PREFIX", "data/")
        local = Path("/tmp/twins") / site_id
        local.mkdir(parents=True, exist_ok=True)
        s3 = boto3.client("s3")
        for f in ("twin.json", "shade.bin", "walk.bin"):
            s3.download_file(bucket, f"{prefix}{site_id}/{f}", str(local / f))
    _CACHE[site_id] = Site(local)
    return _CACHE[site_id]


def _resp(code: int, body: dict) -> dict:
    return {"statusCode": code, "headers": {"Content-Type": "application/json"}, "body": json.dumps(body)}


def lambda_handler(event, context=None):
    token = os.environ.get("ASK_TOKEN")
    headers = {k.lower(): v for k, v in (event.get("headers") or {}).items()}
    if token and headers.get("x-ask-token") != token:
        return _resp(401, {"error": "missing or wrong token"})
    try:
        body = json.loads(event.get("body") or "{}")
        question = str(body.get("question", "")).strip()[:500]
        if not question:
            return _resp(400, {"error": "ask a question"})
        site = load_site(str(body.get("site", "")))
    except ValueError as exc:
        return _resp(400, {"error": str(exc)})
    try:
        out = A.ask(site, question) if os.environ.get("USE_LLM", "1") == "1" else A.offline_answer(site, question)
    except Exception as exc:  # model or credentials problem: fall back to the deterministic answer
        out = A.offline_answer(site, question)
        out["fallback_reason"] = type(exc).__name__
    return _resp(200, out)
