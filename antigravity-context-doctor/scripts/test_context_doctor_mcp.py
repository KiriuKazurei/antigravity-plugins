import os
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import context_doctor_mcp as cd_mcp  # noqa: E402


class TestContextDoctorMcpApp(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_cfg = cd_mcp.DEFAULT_CONFIG_PATH
        self.old_fallback_cfg = cd_mcp.FALLBACK_CONFIG_PATH
        cd_mcp.DEFAULT_CONFIG_PATH = os.path.join(self.tmp.name, "cd-config.json")
        cd_mcp.FALLBACK_CONFIG_PATH = cd_mcp.DEFAULT_CONFIG_PATH
        cd_mcp._LS_UNREACHABLE_UNTIL = 0.0
        cd_mcp._LS_SCHEME_CACHE.clear()

    def tearDown(self):
        cd_mcp.DEFAULT_CONFIG_PATH = self.old_cfg
        cd_mcp.FALLBACK_CONFIG_PATH = self.old_fallback_cfg
        self.tmp.cleanup()

    def test_initialize_and_resources(self):
        init = cd_mcp.handle_rpc_request({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})
        caps = init["result"]["capabilities"]
        self.assertIn("tools", caps)
        self.assertIn("resources", caps)

        rread = cd_mcp.handle_rpc_request(
            {
                "jsonrpc": "2.0",
                "id": 2,
                "method": "resources/read",
                "params": {"uri": "ui://context-doctor/app.html"},
            }
        )
        html = rread["result"]["contents"][0]["text"]
        self.assertIn("<!doctype html>", html.lower())
        self.assertGreater(len(html), 1000)

    def test_tools_list_entrypoints(self):
        resp = cd_mcp.handle_rpc_request({"jsonrpc": "2.0", "id": 3, "method": "tools/list", "params": {}})
        tools = {t["name"]: t for t in resp["result"]["tools"]}
        self.assertIn("open_panel", tools)
        meta = tools["open_panel"]["_meta"]
        self.assertEqual(meta["ui"]["resourceUri"], "ui://context-doctor/app.html")
        self.assertNotIn("com.google.antigravity/ui", meta)
        self.assertEqual(tools["app_snapshot"]["_meta"]["ui"]["visibility"], ["app"])

    def test_open_snapshot_with_mocked_ls_rpc(self):
        def fake_ls(method, payload=None, timeout=4.0):
            if method == "GetAllCascadeTrajectories":
                return {
                    "trajectorySummaries": {
                        "cid-1": {
                            "summary": "Fix MCP App",
                            "status": "RUNNING",
                            "stepCount": 12,
                            "lastModifiedTime": "2026-11-28T03:00:00Z",
                        }
                    }
                }
            if method == "GetCascadeTrajectoryGeneratorMetadata":
                return {
                    "generatorMetadata": [
                        {
                            "chatModel": {
                                "model": "Gemini 4 Neon",
                                "usage": {"inputTokens": 100000, "cacheReadTokens": 80000, "outputTokens": 1200},
                            }
                        },
                        {"chatModel": {"model": "Gemini 4 Neon"}},  # usage-less trailing entry must be skipped
                    ]
                }
            if method == "GetCascadeTrajectory":
                return {
                    "trajectory": {
                        "trajectorySteps": [
                            {"type": "CORTEX_STEP_TYPE_USER_INPUT", "userInput": {"userResponse": "Migrate to MCP Apps"}},
                            {"type": "CORTEX_STEP_TYPE_VIEW_FILE", "viewFile": {"absolutePath": "E:/AI/Agy/README.md"}},
                        ]
                    }
                }
            return {}

        with patch.object(cd_mcp, "call_ls_rpc", side_effect=fake_ls):
            resp = cd_mcp.handle_rpc_request(
                {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "open_panel", "arguments": {}}}
            )
            self.assertFalse(resp["result"]["isError"])
            sc = resp["result"]["structuredContent"]
            self.assertEqual(sc["active"]["cascadeId"], "cid-1")
            self.assertEqual(sc["active"]["latestContextTokens"], 100000)
            self.assertEqual(sc["active"]["cacheHitPct"], 80.0)
            self.assertEqual(sc["active"]["windowLimit"], 1000000)
            self.assertEqual(len(sc["active"]["fileActivities"]), 1)
            self.assertTrue(sc["active"]["fileActivities"][0]["fileUri"].startswith("file:///"))

            saved = cd_mcp.handle_rpc_request(
                {
                    "jsonrpc": "2.0",
                    "id": 5,
                    "method": "tools/call",
                    "params": {"name": "app_save_prefs", "arguments": {"prefs": {"warnThresholdPct": 65}}},
                }
            )
            self.assertEqual(saved["result"]["structuredContent"]["prefs"]["warnThresholdPct"], 65)

    def test_offline_reports_unknown_not_ok(self):
        with patch.object(cd_mcp, "call_ls_rpc", side_effect=RuntimeError("offline")), patch.object(
            cd_mcp, "discover_local_brain_sessions", return_value=[]
        ):
            snap = cd_mcp.build_snapshot()
            self.assertEqual(snap["active"]["health"]["level"], "unknown")


if __name__ == "__main__":
    unittest.main()
