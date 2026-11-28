import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import notifier_mcp  # noqa: E402


class TestNotifierMcpApp(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_cfg = notifier_mcp.DEFAULT_CONFIG_PATH
        self.old_fb = notifier_mcp.FALLBACK_CONFIG_PATH
        notifier_mcp.DEFAULT_CONFIG_PATH = os.path.join(self.tmp.name, "notifier-config.json")
        notifier_mcp.FALLBACK_CONFIG_PATH = notifier_mcp.DEFAULT_CONFIG_PATH

    def tearDown(self):
        notifier_mcp.DEFAULT_CONFIG_PATH = self.old_cfg
        notifier_mcp.FALLBACK_CONFIG_PATH = self.old_fb
        self.tmp.cleanup()

    def test_entrypoint_is_global_only_and_html_reads(self):
        tlist = notifier_mcp.handle_rpc_request({"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}})
        tools = {t["name"]: t for t in tlist["result"]["tools"]}
        eps = [e["type"] for e in tools["open_panel"]["_meta"]["com.google.antigravity/ui"]["entrypoints"]]
        self.assertEqual(eps, ["global"])

        rread = notifier_mcp.handle_rpc_request(
            {"jsonrpc": "2.0", "id": 2, "method": "resources/read", "params": {"uri": "ui://notifier/app.html"}}
        )
        self.assertIn("<!doctype html>", rread["result"]["contents"][0]["text"].lower())

    def test_save_config(self):
        res = notifier_mcp.handle_rpc_request(
            {
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {"name": "app_save_config", "arguments": {"config": {"enabled": True, "provider": "wecom"}}},
            }
        )
        self.assertFalse(res["result"]["isError"])
        cfg = res["result"]["structuredContent"]["config"]
        self.assertTrue(cfg["enabled"])
        self.assertEqual(cfg["provider"], "wecom")


if __name__ == "__main__":
    unittest.main()
