#!/usr/bin/env python3
"""Validate, refresh, and inspect advisory host capability snapshots."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import sys
import tempfile
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, Mapping, Optional

from resolve_model_policy import project_config_dir, user_config_dir


SCHEMA_VERSION = 1
MAX_JSON_BYTES = 256 * 1024
HOST_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
KEY_PATTERN = re.compile(r"^[a-z][a-z0-9_.-]{0,63}$")
OBSERVED_KEYS = {
    "schema_version",
    "host",
    "host_version",
    "tools",
    "capabilities",
    "limits",
    "unknown",
}
TOOL_KEYS = {"name", "parameters", "returns"}
SNAPSHOT_KEYS = {
    "schema_version",
    "host",
    "host_version",
    "generated_at",
    "expires_at",
    "capability_fingerprint",
    "source",
    "observed",
}
EVENT_KEYS = {"schema_version", "category", "summary", "confidence", "evidence", "portable"}
CONFIDENCE_VALUES = {"observed-once", "reproduced", "schema-confirmed"}


class CapabilityCacheError(ValueError):
    pass


def _check_keys(value: Mapping[str, Any], allowed: set, label: str) -> None:
    unknown = sorted(set(value) - allowed)
    if unknown:
        raise CapabilityCacheError("%s has unknown keys: %s" % (label, ", ".join(unknown)))


def _host(value: str) -> str:
    if not HOST_PATTERN.fullmatch(value):
        raise CapabilityCacheError("host must match %s" % HOST_PATTERN.pattern)
    return value


def _string_list(value: Any, label: str) -> list:
    if not isinstance(value, list) or any(not isinstance(item, str) or not item for item in value):
        raise CapabilityCacheError("%s must be a string array" % label)
    return sorted(set(value))


def _flat_map(value: Any, label: str) -> Dict[str, Any]:
    if not isinstance(value, dict):
        raise CapabilityCacheError("%s must be a JSON object" % label)
    normalized: Dict[str, Any] = {}
    for key, item in value.items():
        if not isinstance(key, str) or not KEY_PATTERN.fullmatch(key):
            raise CapabilityCacheError("%s key %r is invalid" % (label, key))
        if isinstance(item, list):
            normalized[key] = _string_list(item, "%s.%s" % (label, key))
        elif isinstance(item, float) and not math.isfinite(item):
            raise CapabilityCacheError("%s.%s must be a finite number" % (label, key))
        elif isinstance(item, (str, int, float, bool)) or item is None:
            normalized[key] = item
        else:
            raise CapabilityCacheError("%s.%s must be a scalar or string array" % (label, key))
    return normalized


def normalize_observed(value: Any, expected_host: str) -> Dict[str, Any]:
    if not isinstance(value, dict):
        raise CapabilityCacheError("observed descriptor must be a JSON object")
    _check_keys(value, OBSERVED_KEYS, "observed descriptor")
    if value.get("schema_version") != SCHEMA_VERSION:
        raise CapabilityCacheError("observed descriptor must declare schema_version %s" % SCHEMA_VERSION)
    if value.get("host") != expected_host:
        raise CapabilityCacheError("observed descriptor host must be %r" % expected_host)
    host_version = value.get("host_version", "unknown")
    if not isinstance(host_version, str) or not host_version:
        raise CapabilityCacheError("observed descriptor host_version must be a string")
    tools = value.get("tools")
    if not isinstance(tools, list):
        raise CapabilityCacheError("observed descriptor tools must be an array")
    normalized_tools = []
    names = set()
    for index, raw in enumerate(tools):
        if not isinstance(raw, dict):
            raise CapabilityCacheError("tools[%s] must be a JSON object" % index)
        _check_keys(raw, TOOL_KEYS, "tools[%s]" % index)
        name = raw.get("name")
        if (
            not isinstance(name, str)
            or not name
            or len(name) > 256
            or any(ord(character) < 32 for character in name)
            or name in names
        ):
            raise CapabilityCacheError("tools[%s].name must be a unique string" % index)
        names.add(name)
        normalized_tools.append({
            "name": name,
            "parameters": _string_list(raw.get("parameters", []), "tools[%s].parameters" % index),
            "returns": _string_list(raw.get("returns", []), "tools[%s].returns" % index),
        })
    return {
        "schema_version": SCHEMA_VERSION,
        "host": expected_host,
        "host_version": host_version,
        "tools": sorted(normalized_tools, key=lambda item: item["name"]),
        "capabilities": _flat_map(value.get("capabilities", {}), "capabilities"),
        "limits": _flat_map(value.get("limits", {}), "limits"),
        "unknown": _string_list(value.get("unknown", []), "unknown"),
    }


def capability_fingerprint(observed: Mapping[str, Any]) -> str:
    # Only the canonical live interface is an objective invalidation signal.
    # capabilities/limits/unknown are advisory interpretations produced by an
    # agent and may legitimately differ between discoveries of the same schema.
    interface = {"tools": observed["tools"]}
    payload = json.dumps(interface, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def cache_root(repo: Path, scope: str, explicit: Optional[Path] = None) -> Path:
    if explicit is not None:
        return explicit.expanduser()
    return user_config_dir() if scope == "global" else project_config_dir(repo)


def snapshot_path(root: Path, host: str) -> Path:
    return root / "capabilities" / (_host(host) + ".json")


def observations_dir(root: Path, host: str) -> Path:
    return root / "observations" / _host(host)


def _read_json(path: Path) -> Any:
    def reject_constant(value: str) -> None:
        raise CapabilityCacheError("%s contains non-standard JSON value %s" % (path, value))

    try:
        if path.stat().st_size > MAX_JSON_BYTES:
            raise CapabilityCacheError("%s exceeds %s bytes" % (path, MAX_JSON_BYTES))
        return json.loads(
            path.read_text(encoding="utf-8"),
            parse_constant=reject_constant,
        )
    except CapabilityCacheError:
        raise
    except (OSError, json.JSONDecodeError) as exc:
        raise CapabilityCacheError("cannot read %s: %s" % (path, exc)) from exc


def _atomic_write(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".%s." % path.name, suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        try:
            os.chmod(temporary, 0o600)
        except OSError:
            pass
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _parse_time(value: Any, label: str) -> datetime:
    if not isinstance(value, str):
        raise CapabilityCacheError("%s must be an ISO-8601 string" % label)
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise CapabilityCacheError("%s is not valid ISO-8601" % label) from exc
    if parsed.tzinfo is None:
        raise CapabilityCacheError("%s must include a timezone" % label)
    return parsed.astimezone(timezone.utc)


def refresh_snapshot(
    root: Path,
    host: str,
    observed_value: Any,
    ttl_hours: int = 168,
    now: Optional[datetime] = None,
) -> Dict[str, Any]:
    if ttl_hours < 1 or ttl_hours > 24 * 90:
        raise CapabilityCacheError("ttl_hours must be between 1 and 2160")
    current = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    observed = normalize_observed(observed_value, _host(host))
    snapshot = {
        "schema_version": SCHEMA_VERSION,
        "host": host,
        "host_version": observed["host_version"],
        "generated_at": _iso(current),
        "expires_at": _iso(current + timedelta(hours=ttl_hours)),
        "capability_fingerprint": capability_fingerprint(observed),
        "source": "live-tool-schema",
        "observed": observed,
    }
    path = snapshot_path(root, host)
    try:
        _atomic_write(path, snapshot)
    except OSError as exc:
        return {
            "status": "write-blocked",
            "snapshot_path": str(path),
            "error": str(exc),
            "candidate_snapshot": snapshot,
        }
    return {"status": "refreshed", "snapshot_path": str(path), "snapshot": snapshot}


def inspect_snapshot(
    root: Path,
    host: str,
    observed_value: Any,
    now: Optional[datetime] = None,
) -> Dict[str, Any]:
    observed = normalize_observed(observed_value, _host(host))
    path = snapshot_path(root, host)
    base = {
        "snapshot_path": str(path),
        "observations_path": str(observations_dir(root, host)),
        "current_fingerprint": capability_fingerprint(observed),
    }
    if not path.is_file():
        return {**base, "status": "absent", "refresh_required": True, "reasons": ["snapshot-missing"]}
    current = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    try:
        snapshot = _read_json(path)
        if not isinstance(snapshot, dict):
            raise CapabilityCacheError("snapshot must be a JSON object")
        _check_keys(snapshot, SNAPSHOT_KEYS, "snapshot")
        if snapshot.get("schema_version") != SCHEMA_VERSION:
            raise CapabilityCacheError("snapshot schema_version is unsupported")
        if snapshot.get("host") != host:
            raise CapabilityCacheError("snapshot host does not match")
        cached_observed = normalize_observed(snapshot.get("observed"), host)
        if snapshot.get("host_version") != cached_observed["host_version"]:
            raise CapabilityCacheError("snapshot host_version does not match its observed descriptor")
        if snapshot.get("capability_fingerprint") != capability_fingerprint(cached_observed):
            raise CapabilityCacheError("snapshot fingerprint does not match its observed descriptor")
        if snapshot.get("source") != "live-tool-schema":
            raise CapabilityCacheError("snapshot source must be live-tool-schema")
        expires_at = _parse_time(snapshot.get("expires_at"), "snapshot.expires_at")
        generated_at = _parse_time(snapshot.get("generated_at"), "snapshot.generated_at")
        if generated_at > current + timedelta(minutes=5):
            raise CapabilityCacheError("snapshot generated_at is in the future")
        if expires_at <= generated_at or expires_at - generated_at > timedelta(hours=24 * 90):
            raise CapabilityCacheError("snapshot validity window is invalid")
    except CapabilityCacheError as exc:
        return {**base, "status": "stale", "refresh_required": True, "reasons": ["snapshot-invalid: %s" % exc]}

    reasons = []
    if current >= expires_at:
        reasons.append("snapshot-expired")
    if snapshot.get("host_version") != observed["host_version"]:
        reasons.append("host-version-changed")
    if snapshot.get("capability_fingerprint") != base["current_fingerprint"]:
        reasons.append("live-capability-fingerprint-changed")
    return {
        **base,
        "status": "stale" if reasons else "fresh",
        "refresh_required": bool(reasons),
        "reasons": reasons,
        "snapshot": snapshot,
    }


def record_observation(root: Path, host: str, value: Any, now: Optional[datetime] = None) -> Dict[str, Any]:
    if not isinstance(value, dict):
        raise CapabilityCacheError("observation must be a JSON object")
    _check_keys(value, EVENT_KEYS, "observation")
    if value.get("schema_version") != SCHEMA_VERSION:
        raise CapabilityCacheError("observation must declare schema_version %s" % SCHEMA_VERSION)
    category = value.get("category")
    if not isinstance(category, str) or not KEY_PATTERN.fullmatch(category):
        raise CapabilityCacheError("observation.category is invalid")
    summary = value.get("summary")
    if not isinstance(summary, str) or not summary.strip() or len(summary) > 2000:
        raise CapabilityCacheError("observation.summary must be 1-2000 characters")
    confidence = value.get("confidence")
    if confidence not in CONFIDENCE_VALUES:
        raise CapabilityCacheError("observation.confidence is invalid")
    evidence = _flat_map(value.get("evidence", {}), "observation.evidence")
    portable = value.get("portable", False)
    if not isinstance(portable, bool):
        raise CapabilityCacheError("observation.portable must be boolean")
    current = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    snapshot = snapshot_path(root, _host(host))
    fingerprint = None
    if snapshot.is_file():
        try:
            cached = _read_json(snapshot)
            candidate = cached.get("capability_fingerprint") if isinstance(cached, dict) else None
            if isinstance(candidate, str) and re.fullmatch(r"sha256:[0-9a-f]{64}", candidate):
                fingerprint = candidate
        except CapabilityCacheError:
            fingerprint = None
    record = {
        "schema_version": SCHEMA_VERSION,
        "host": host,
        "recorded_at": _iso(current),
        "capability_fingerprint": fingerprint,
        "event": {
            "category": category,
            "summary": summary.strip(),
            "confidence": confidence,
            "evidence": evidence,
            "portable": portable,
        },
    }
    directory = observations_dir(root, host)
    filename = "%s-%s.json" % (current.strftime("%Y%m%dT%H%M%S%fZ"), uuid.uuid4().hex)
    path = directory / filename
    try:
        _atomic_write(path, record)
    except OSError as exc:
        return {
            "status": "write-blocked",
            "observation_path": str(path),
            "error": str(exc),
            "candidate_record": record,
        }
    return {"status": "recorded", "observation_path": str(path), "record": record}


def _root_from_args(args: argparse.Namespace) -> Path:
    explicit = Path(args.config_dir) if args.config_dir else None
    return cache_root(Path(args.repo), args.scope, explicit)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    for command in ("status", "refresh", "observe"):
        child = subparsers.add_parser(command)
        child.add_argument("--host", required=True)
        child.add_argument("--repo", default=".")
        child.add_argument("--scope", choices=("global", "project"), default="global")
        child.add_argument("--config-dir")
        if command in ("status", "refresh"):
            child.add_argument("--observed", required=True)
        if command == "refresh":
            child.add_argument("--ttl-hours", type=int, default=168)
        if command == "observe":
            child.add_argument("--event", required=True)
    return parser


def main(argv: Optional[Iterable[str]] = None) -> int:
    args = _parser().parse_args(argv)
    try:
        root = _root_from_args(args)
        if args.command == "status":
            result = inspect_snapshot(root, args.host, _read_json(Path(args.observed)))
        elif args.command == "refresh":
            result = refresh_snapshot(root, args.host, _read_json(Path(args.observed)), args.ttl_hours)
        else:
            result = record_observation(root, args.host, _read_json(Path(args.event)))
    except CapabilityCacheError as exc:
        print("host capability cache error: %s" % exc, file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
