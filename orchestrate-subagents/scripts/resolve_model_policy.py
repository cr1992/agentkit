#!/usr/bin/env python3
"""Resolve global + project, common + host-specific subagent model policy."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Tuple


SCHEMA_VERSION = 1
POLICY_KEYS = {"schema_version", "routes", "task_overrides"}
HOST_KEYS = {"schema_version", "host", "effort_order", "aliases", "profiles", "constraints"}
PROFILE_KEYS = {"model", "effort", "channel", "dispatch"}
CONSTRAINT_KEYS = {"allowed_models", "minimum_effort"}
DISPATCH_PROVENANCE = {"explicit", "inherited-controller", "host-default"}


class PolicyError(ValueError):
    pass


def user_config_dir(
    env: Optional[Mapping[str, str]] = None,
    platform_name: Optional[str] = None,
    home: Optional[Path] = None,
) -> Path:
    values = dict(os.environ if env is None else env)
    explicit = values.get("ORCHESTRATE_SUBAGENTS_CONFIG")
    if explicit:
        return Path(explicit).expanduser()

    platform_value = sys.platform if platform_name is None else platform_name
    home_path = Path.home() if home is None else home
    suffix = Path("agent-skills") / "orchestrate-subagents"
    if platform_value.startswith("win"):
        base = Path(values.get("APPDATA", str(home_path / "AppData" / "Roaming")))
    elif platform_value == "darwin":
        base = home_path / "Library" / "Application Support"
    else:
        base = Path(values.get("XDG_CONFIG_HOME", str(home_path / ".config")))
    return base / suffix


def repository_root(path: Path) -> Path:
    candidate = path.resolve()
    if candidate.is_file():
        candidate = candidate.parent
    for current in (candidate,) + tuple(candidate.parents):
        if (current / ".git").exists():
            return current
    return candidate


def project_config_dir(repo: Path) -> Path:
    return repository_root(repo) / ".agents" / "orchestrate-subagents"


def _object(value: Any, label: str) -> Dict[str, Any]:
    if not isinstance(value, dict):
        raise PolicyError("%s must be a JSON object" % label)
    return dict(value)


def _check_keys(value: Mapping[str, Any], allowed: set, label: str) -> None:
    unknown = sorted(set(value) - allowed)
    if unknown:
        raise PolicyError("%s has unknown keys: %s" % (label, ", ".join(unknown)))


def _load_json(path: Path, kind: str, host: Optional[str] = None) -> Optional[Dict[str, Any]]:
    if not path.is_file():
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise PolicyError("cannot read %s: %s" % (path, exc)) from exc
    data = _object(value, str(path))
    _check_keys(data, POLICY_KEYS if kind == "policy" else HOST_KEYS, str(path))
    if data.get("schema_version") != SCHEMA_VERSION:
        raise PolicyError("%s must declare schema_version %s" % (path, SCHEMA_VERSION))
    if kind == "host" and data.get("host") != host:
        raise PolicyError("%s host must be %r" % (path, host))
    return data


def _merge_dict(base: Mapping[str, Any], overlay: Mapping[str, Any]) -> Dict[str, Any]:
    merged = dict(base)
    for key, value in overlay.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = _merge_dict(merged[key], value)
        else:
            merged[key] = value
    return merged


def _validate_policy(data: Mapping[str, Any], label: str) -> None:
    for field in ("routes", "task_overrides"):
        values = _object(data.get(field, {}), "%s.%s" % (label, field))
        for key, profile in values.items():
            if not isinstance(key, str) or not isinstance(profile, str) or not profile:
                raise PolicyError("%s.%s entries must map strings to profiles" % (label, field))


def _validate_host(data: Mapping[str, Any], label: str) -> None:
    effort_order = data.get("effort_order")
    if effort_order is not None:
        if (
            not isinstance(effort_order, list)
            or any(not isinstance(item, str) or not item for item in effort_order)
            or len(set(effort_order)) != len(effort_order)
        ):
            raise PolicyError("%s.effort_order must be a unique string array" % label)
    aliases = _object(data.get("aliases", {}), "%s.aliases" % label)
    for key, model in aliases.items():
        if not isinstance(key, str) or not isinstance(model, str) or not model:
            raise PolicyError("%s.aliases entries must map strings to model IDs" % label)
    profiles = _object(data.get("profiles", {}), "%s.profiles" % label)
    for name, raw in profiles.items():
        profile = _object(raw, "%s.profiles.%s" % (label, name))
        _check_keys(profile, PROFILE_KEYS, "%s.profiles.%s" % (label, name))
        for key, value in profile.items():
            if not isinstance(value, str) or not value:
                raise PolicyError("%s.profiles.%s.%s must be a string" % (label, name, key))
        if "dispatch" in profile and profile["dispatch"] not in DISPATCH_PROVENANCE:
            raise PolicyError("%s.profiles.%s.dispatch is invalid" % (label, name))
    constraints = _object(data.get("constraints", {}), "%s.constraints" % label)
    _check_keys(constraints, CONSTRAINT_KEYS, "%s.constraints" % label)
    allowed = constraints.get("allowed_models", [])
    if not isinstance(allowed, list) or any(not isinstance(item, str) or not item for item in allowed):
        raise PolicyError("%s.constraints.allowed_models must be a string array" % label)
    minimum = _object(constraints.get("minimum_effort", {}), "%s.constraints.minimum_effort" % label)
    for model, effort in minimum.items():
        if not isinstance(model, str) or not isinstance(effort, str) or not effort:
            raise PolicyError("%s minimum effort for %r is invalid" % (label, model))


def _stricter_effort(first: str, second: str, effort_rank: Mapping[str, int]) -> str:
    if first not in effort_rank or second not in effort_rank:
        raise PolicyError("unknown effort while merging: %r / %r" % (first, second))
    return first if effort_rank[first] >= effort_rank[second] else second


def _merge_constraints(
    global_value: Mapping[str, Any],
    project_value: Mapping[str, Any],
    effort_rank: Mapping[str, int],
) -> Dict[str, Any]:
    result: Dict[str, Any] = {}
    global_allowed = global_value.get("allowed_models")
    project_allowed = project_value.get("allowed_models")
    if global_allowed is not None and project_allowed is not None:
        project_set = set(project_allowed)
        result["allowed_models"] = [model for model in global_allowed if model in project_set]
    elif global_allowed is not None:
        result["allowed_models"] = list(global_allowed)
    elif project_allowed is not None:
        result["allowed_models"] = list(project_allowed)

    minimum = dict(global_value.get("minimum_effort", {}))
    for model, effort in project_value.get("minimum_effort", {}).items():
        minimum[model] = _stricter_effort(minimum[model], effort, effort_rank) if model in minimum else effort
    if minimum:
        result["minimum_effort"] = minimum
    return result


def _config_paths(root: Path, host: str) -> Tuple[Path, Path]:
    return root / "policy.json", root / "hosts" / (host + ".json")


def resolve(args: argparse.Namespace) -> Dict[str, Any]:
    repo = Path(args.repo).resolve()
    global_root = Path(args.global_config_dir).expanduser() if args.global_config_dir else user_config_dir()
    project_root = Path(args.project_config_dir).expanduser() if args.project_config_dir else project_config_dir(repo)
    global_policy_path, global_host_path = _config_paths(global_root, args.host)
    project_policy_path, project_host_path = _config_paths(project_root, args.host)

    sources: List[str] = []
    policy: Dict[str, Any] = {"routes": {}, "task_overrides": {}}
    for path in (global_policy_path, project_policy_path):
        data = _load_json(path, "policy")
        if data is not None:
            _validate_policy(data, str(path))
            policy = _merge_dict(policy, {key: value for key, value in data.items() if key != "schema_version"})
            sources.append(str(path))

    global_host = _load_json(global_host_path, "host", args.host)
    project_host = _load_json(project_host_path, "host", args.host)
    for path, data in ((global_host_path, global_host), (project_host_path, project_host)):
        if data is not None:
            _validate_host(data, str(path))
            sources.append(str(path))

    host_policy = _merge_dict(global_host or {}, project_host or {})
    effort_order = host_policy.get("effort_order")
    if not isinstance(effort_order, list) or not effort_order:
        raise PolicyError("host %r must define effort_order in external config" % args.host)
    effort_rank = {name: index for index, name in enumerate(effort_order)}
    host_policy["constraints"] = _merge_constraints(
        (global_host or {}).get("constraints", {}),
        (project_host or {}).get("constraints", {}),
        effort_rank,
    )

    profile_name = policy.get("task_overrides", {}).get(args.task_type) if args.task_type else None
    if profile_name is None:
        profile_name = policy.get("routes", {}).get(args.role)
    if not profile_name:
        raise PolicyError("no profile route for role=%r task_type=%r" % (args.role, args.task_type))
    raw_profile = host_policy.get("profiles", {}).get(profile_name)
    if not isinstance(raw_profile, dict):
        raise PolicyError("host %r has no profile %r" % (args.host, profile_name))

    aliases = host_policy.get("aliases", {})
    requested_model = args.model or raw_profile.get("model")
    requested_effort = args.effort or raw_profile.get("effort")
    model = aliases.get(requested_model, requested_model)
    if not model or not requested_effort:
        raise PolicyError("profile %r must resolve model and effort" % profile_name)
    if requested_effort not in effort_rank:
        raise PolicyError("effort %r is absent from host effort_order" % requested_effort)

    constraints = host_policy.get("constraints", {})
    allowed = constraints.get("allowed_models")
    if allowed is not None and model not in allowed:
        raise PolicyError("model %r is outside allowed_models" % model)
    minimum = constraints.get("minimum_effort", {}).get(model)
    if minimum:
        if minimum not in effort_rank:
            raise PolicyError("minimum effort %r is absent from host effort_order" % minimum)
        if effort_rank[requested_effort] < effort_rank[minimum]:
            raise PolicyError("effort %r is below %s minimum %r" % (requested_effort, model, minimum))
    if args.available_model and model not in args.available_model:
        raise PolicyError("model %r is not exposed by the current host schema" % model)
    if args.available_effort and requested_effort not in args.available_effort:
        raise PolicyError("effort %r is not exposed by the current host schema" % requested_effort)
    if args.available_channel and raw_profile.get("channel") not in args.available_channel:
        raise PolicyError("channel %r is not exposed by the current host schema" % raw_profile.get("channel"))

    return {
        "schema_version": SCHEMA_VERSION,
        "host": args.host,
        "role": args.role,
        "task_type": args.task_type,
        "profile": profile_name,
        "model": model,
        "effort": requested_effort,
        "channel": raw_profile.get("channel"),
        "dispatch": raw_profile.get("dispatch"),
        "dispatch_provenance": raw_profile.get("dispatch", "host-default"),
        "selection_source": "session-explicit" if args.model or args.effort else "external-policy",
        "config_source": sources or ["skill-default"],
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", required=True)
    parser.add_argument("--repo", default=".")
    parser.add_argument("--role", default="worker")
    parser.add_argument("--task-type")
    parser.add_argument("--global-config-dir")
    parser.add_argument("--project-config-dir")
    parser.add_argument("--model")
    parser.add_argument("--effort")
    parser.add_argument("--available-model", action="append", default=[])
    parser.add_argument("--available-effort", action="append", default=[])
    parser.add_argument("--available-channel", action="append", default=[])
    parser.add_argument("--explain", action="store_true")
    return parser


def _explain(result: Mapping[str, Any]) -> str:
    lines = [
        "profile: %s" % result["profile"],
        "model: %s" % result["model"],
        "effort: %s" % result["effort"],
        "channel: %s" % (result.get("channel") or "host-default"),
        "dispatch: %s" % (result.get("dispatch") or "host-default"),
        "provenance: %s" % result["dispatch_provenance"],
        "selection: %s" % result["selection_source"],
        "source:",
    ]
    lines.extend("  - %s" % value for value in result["config_source"])
    return "\n".join(lines)


def main(argv: Optional[Iterable[str]] = None) -> int:
    args = _parser().parse_args(argv)
    try:
        result = resolve(args)
    except PolicyError as exc:
        print("model policy error: %s" % exc, file=sys.stderr)
        return 2
    print(_explain(result) if args.explain else json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
