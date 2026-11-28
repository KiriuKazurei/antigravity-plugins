import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import snippets_mcp  # noqa: E402


class TestSnippetsMcpApp(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_store = snippets_mcp.DEFAULT_STORE_PATH
        self.old_fallback = snippets_mcp.FALLBACK_STORE_PATH
        snippets_mcp.DEFAULT_STORE_PATH = os.path.join(self.tmp.name, "snippets.json")
        snippets_mcp.FALLBACK_STORE_PATH = snippets_mcp.DEFAULT_STORE_PATH

    def tearDown(self):
        snippets_mcp.DEFAULT_STORE_PATH = self.old_store
        snippets_mcp.FALLBACK_STORE_PATH = self.old_fallback
        self.tmp.cleanup()

    def test_entrypoint_is_global_only_and_html_reads(self):
        tlist = snippets_mcp.handle_rpc_request({"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}})
        tools = {t["name"]: t for t in tlist["result"]["tools"]}
        eps = [e["type"] for e in tools["open_panel"]["_meta"]["com.google.antigravity/ui"]["entrypoints"]]
        self.assertEqual(eps, ["global"])

        rread = snippets_mcp.handle_rpc_request(
            {"jsonrpc": "2.0", "id": 2, "method": "resources/read", "params": {"uri": "ui://snippets/app.html"}}
        )
        self.assertIn("<!doctype html>", rread["result"]["contents"][0]["text"].lower())

    def test_save_and_delete(self):
        saved = snippets_mcp.handle_rpc_request(
            {
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {"name": "app_save", "arguments": {"title": "测试模板", "alias": "t1", "content": "Hello {{$cursor}}"}},
            }
        )
        self.assertFalse(saved["result"]["isError"])
        sid = saved["result"]["structuredContent"]["savedId"]
        deleted = snippets_mcp.handle_rpc_request(
            {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "app_delete", "arguments": {"id": sid}}}
        )
        self.assertFalse(deleted["result"]["isError"])
        ids = [s["id"] for s in deleted["result"]["structuredContent"]["snippets"]]
        self.assertNotIn(sid, ids)


if __name__ == "__main__":
    unittest.main()
