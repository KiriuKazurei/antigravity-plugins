import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import kb_mcp  # noqa: E402


class TestKbMcpApp(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_default = kb_mcp.DEFAULT_VAULT_PATH
        self.old_cfg = kb_mcp.DEFAULT_CONFIG_PATH
        self.old_fallback_cfg = kb_mcp.FALLBACK_CONFIG_PATH
        kb_mcp.DEFAULT_VAULT_PATH = os.path.join(self.tmp.name, "vault")
        kb_mcp.DEFAULT_CONFIG_PATH = os.path.join(self.tmp.name, "kb-config.json")
        kb_mcp.FALLBACK_CONFIG_PATH = kb_mcp.DEFAULT_CONFIG_PATH
        os.makedirs(kb_mcp.DEFAULT_VAULT_PATH, exist_ok=True)

    def tearDown(self):
        kb_mcp.DEFAULT_VAULT_PATH = self.old_default
        kb_mcp.DEFAULT_CONFIG_PATH = self.old_cfg
        kb_mcp.FALLBACK_CONFIG_PATH = self.old_fallback_cfg
        self.tmp.cleanup()

    def test_initialize_declares_resources_and_tools(self):
        resp = kb_mcp.handle_rpc_request({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})
        caps = resp["result"]["capabilities"]
        self.assertIn("tools", caps)
        self.assertIn("resources", caps)

    def test_tools_list_includes_aux_pane_entrypoint_and_app_only(self):
        resp = kb_mcp.handle_rpc_request({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
        tools = {t["name"]: t for t in resp["result"]["tools"]}
        self.assertIn("kb_open_panel", tools)
        meta = tools["kb_open_panel"]["_meta"]
        self.assertEqual(meta["ui"]["resourceUri"], "ui://kb/app.html")
        self.assertEqual(tools["kb_app_save_note"]["_meta"]["ui"]["visibility"], ["app"])

    def test_resources_list_and_read(self):
        rlist = kb_mcp.handle_rpc_request({"jsonrpc": "2.0", "id": 3, "method": "resources/list", "params": {}})
        resources = rlist["result"]["resources"]
        self.assertEqual(resources[0]["uri"], "ui://kb/app.html")
        self.assertEqual(resources[0]["mimeType"], "text/html;profile=mcp-app")

        rread = kb_mcp.handle_rpc_request(
            {"jsonrpc": "2.0", "id": 4, "method": "resources/read", "params": {"uri": "ui://kb/app.html"}}
        )
        self.assertIn("contents", rread["result"])
        html = rread["result"]["contents"][0]["text"]
        self.assertIn("<!doctype html>", html.lower())
        self.assertGreater(len(html), 1000)

    def test_open_panel_and_crud_flow(self):
        saved = kb_mcp.handle_rpc_request(
            {
                "jsonrpc": "2.0",
                "id": 5,
                "method": "tools/call",
                "params": {
                    "name": "kb_app_save_note",
                    "arguments": {"rel_path": "hello.md", "content": "# Hello\n\n- [ ] task1\n#test"},
                },
            }
        )
        self.assertFalse(saved["result"]["isError"])
        self.assertEqual(saved["result"]["structuredContent"]["totalCount"], 1)

        opened = kb_mcp.handle_rpc_request(
            {"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": {"name": "kb_open_panel", "arguments": {}}}
        )
        self.assertFalse(opened["result"]["isError"])
        sc = opened["result"]["structuredContent"]
        self.assertEqual(sc["totalCount"], 1)
        self.assertEqual(sc["initialNoteRef"], "hello.md")
        self.assertNotIn("content", sc["notes"][0])

        # Missing content must be rejected instead of overwriting with empty string
        bad_write = kb_mcp.handle_rpc_request(
            {
                "jsonrpc": "2.0",
                "id": 61,
                "method": "tools/call",
                "params": {"name": "kb_write", "arguments": {"rel_path": "hello.md"}},
            }
        )
        self.assertTrue(bad_write["result"]["isError"])

        deleted = kb_mcp.handle_rpc_request(
            {
                "jsonrpc": "2.0",
                "id": 7,
                "method": "tools/call",
                "params": {"name": "kb_app_delete_note", "arguments": {"rel_path": "hello.md"}},
            }
        )
        self.assertFalse(deleted["result"]["isError"])
        self.assertEqual(deleted["result"]["structuredContent"]["totalCount"], 0)


if __name__ == "__main__":
    unittest.main()
