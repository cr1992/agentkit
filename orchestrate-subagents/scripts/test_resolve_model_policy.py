#!/usr/bin/env python3

import argparse
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import resolve_model_policy as resolver


COMMON = {
    "schema_version": 1,
    "routes": {"scout": "mechanical", "worker": "implementation", "critic": "judgment"},
    "task_overrides": {"audit": "judgment"},
}

CODEX = {
    "schema_version": 1,
    "host": "codex",
    "effort_order": ["low", "medium", "high", "xhigh", "max", "ultra"],
    "aliases": {"primary": "gpt-sol", "economical": "gpt-terra"},
    "profiles": {
        "mechanical": {"model": "economical", "effort": "high", "channel": "spawn_agent"},
        "implementation": {"model": "primary", "effort": "medium", "channel": "spawn_agent", "dispatch": "explicit"},
        "judgment": {"model": "primary", "effort": "high", "channel": "spawn_agent", "dispatch": "explicit"},
    },
    "constraints": {
        "allowed_models": ["gpt-sol", "gpt-terra"],
        "minimum_effort": {"gpt-terra": "high"},
    },
}

CLAUDE = {
    "schema_version": 1,
    "host": "claude-code",
    "effort_order": ["low", "medium", "high", "xhigh", "max"],
    "aliases": {"primary": "claude-opus", "economical": "claude-sonnet"},
    "profiles": {
        "mechanical": {"model": "economical", "effort": "medium", "channel": "workflow"},
        "implementation": {"model": "primary", "effort": "high", "channel": "workflow"},
        "judgment": {"model": "primary", "effort": "xhigh", "channel": "workflow"},
    },
}


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def args(global_root, project_root, host="codex", role="worker", task_type=None, **overrides):
    values = dict(
        host=host,
        repo=str(project_root.parent),
        role=role,
        task_type=task_type,
        global_config_dir=str(global_root),
        project_config_dir=str(project_root),
        model=None,
        effort=None,
        available_model=[],
        available_effort=[],
        available_channel=[],
        explain=False,
    )
    values.update(overrides)
    return argparse.Namespace(**values)


class PlatformPathTest(unittest.TestCase):
    def test_windows_appdata(self):
        got = resolver.user_config_dir(
            env={"APPDATA": r"C:\Users\me\AppData\Roaming"},
            platform_name="win32",
            home=Path(r"C:\Users\me"),
        )
        expected = Path(r"C:\Users\me\AppData\Roaming") / "agent-skills" / "orchestrate-subagents"
        self.assertEqual(got, expected)

    def test_macos_application_support(self):
        got = resolver.user_config_dir(env={}, platform_name="darwin", home=Path("/Users/me"))
        self.assertEqual(got, Path("/Users/me/Library/Application Support/agent-skills/orchestrate-subagents"))

    def test_linux_xdg_and_explicit_override(self):
        self.assertEqual(
            resolver.user_config_dir(env={"XDG_CONFIG_HOME": "/cfg"}, platform_name="linux", home=Path("/home/me")),
            Path("/cfg/agent-skills/orchestrate-subagents"),
        )
        self.assertEqual(
            resolver.user_config_dir(env={"ORCHESTRATE_SUBAGENTS_CONFIG": "/custom"}, platform_name="linux"),
            Path("/custom"),
        )

    def test_project_config_uses_git_root(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / ".git").mkdir()
            nested = root / "packages" / "app"
            nested.mkdir(parents=True)
            self.assertEqual(
                resolver.project_config_dir(nested),
                root.resolve() / ".agents" / "orchestrate-subagents",
            )


class ResolutionTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.global_root = root / "global"
        self.project_root = root / "project"
        write_json(self.global_root / "policy.json", COMMON)
        write_json(self.global_root / "hosts/codex.json", CODEX)
        write_json(self.global_root / "hosts/claude-code.json", CLAUDE)

    def tearDown(self):
        self.temp.cleanup()

    def test_hosts_resolve_independently(self):
        codex = resolver.resolve(args(self.global_root, self.project_root, host="codex"))
        claude = resolver.resolve(args(self.global_root, self.project_root, host="claude-code"))
        self.assertEqual((codex["model"], codex["effort"], codex["channel"]), ("gpt-sol", "medium", "spawn_agent"))
        self.assertEqual((claude["model"], claude["effort"], claude["channel"]), ("claude-opus", "high", "workflow"))

    def test_task_override_beats_role(self):
        result = resolver.resolve(args(self.global_root, self.project_root, task_type="audit"))
        self.assertEqual((result["profile"], result["effort"]), ("judgment", "high"))

    def test_project_profile_override(self):
        write_json(
            self.project_root / "hosts/codex.json",
            {
                "schema_version": 1,
                "host": "codex",
                "profiles": {"implementation": {"model": "primary", "effort": "high"}},
            },
        )
        result = resolver.resolve(args(self.global_root, self.project_root))
        self.assertEqual(result["effort"], "high")
        self.assertEqual(result["channel"], "spawn_agent")

    def test_project_cannot_weaken_minimum_effort(self):
        write_json(self.project_root / "policy.json", {"schema_version": 1, "routes": {"worker": "mechanical"}})
        write_json(
            self.project_root / "hosts/codex.json",
            {
                "schema_version": 1,
                "host": "codex",
                "profiles": {"mechanical": {"effort": "medium"}},
                "constraints": {"minimum_effort": {"gpt-terra": "medium"}},
            },
        )
        with self.assertRaisesRegex(resolver.PolicyError, "below .* minimum"):
            resolver.resolve(args(self.global_root, self.project_root))

    def test_allowed_models_are_intersected(self):
        write_json(
            self.project_root / "hosts/codex.json",
            {
                "schema_version": 1,
                "host": "codex",
                "constraints": {"allowed_models": ["gpt-terra"]},
            },
        )
        with self.assertRaisesRegex(resolver.PolicyError, "outside allowed_models"):
            resolver.resolve(args(self.global_root, self.project_root))

    def test_live_schema_rejects_stale_model(self):
        with self.assertRaisesRegex(resolver.PolicyError, "not exposed"):
            resolver.resolve(
                args(self.global_root, self.project_root, available_model=["other"], available_effort=["medium"])
            )

    def test_live_schema_rejects_stale_channel(self):
        with self.assertRaisesRegex(resolver.PolicyError, "channel .* not exposed"):
            resolver.resolve(args(self.global_root, self.project_root, available_channel=["workflow"]))

    def test_session_override_is_auditable(self):
        result = resolver.resolve(args(self.global_root, self.project_root, model="gpt-sol", effort="high"))
        self.assertEqual(result["dispatch_provenance"], "explicit")
        self.assertEqual(result["selection_source"], "session-explicit")
        self.assertEqual(result["effort"], "high")

    def test_unknown_key_fails_fast(self):
        write_json(self.project_root / "policy.json", {"schema_version": 1, "routez": {}})
        with self.assertRaisesRegex(resolver.PolicyError, "unknown keys"):
            resolver.resolve(args(self.global_root, self.project_root))


if __name__ == "__main__":
    unittest.main()
