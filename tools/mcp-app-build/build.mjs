import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

const APPS = [
  {
    name: 'antigravity-kb',
    title: 'Antigravity 知识库',
    entryJs: path.join(repoRoot, 'antigravity-kb', 'app', 'src', 'main.js'),
    entryCss: path.join(repoRoot, 'antigravity-kb', 'app', 'src', 'styles.css'),
    outHtml: path.join(repoRoot, 'antigravity-kb', 'app', 'dist', 'app.html'),
  },
  {
    name: 'antigravity-context-doctor',
    title: 'Antigravity 上下文洞察',
    entryJs: path.join(repoRoot, 'antigravity-context-doctor', 'app', 'src', 'main.js'),
    entryCss: path.join(repoRoot, 'antigravity-context-doctor', 'app', 'src', 'styles.css'),
    outHtml: path.join(repoRoot, 'antigravity-context-doctor', 'app', 'dist', 'app.html'),
  },
  {
    name: 'antigravity-snippets',
    title: 'Antigravity Prompt 模板库',
    entryJs: path.join(repoRoot, 'antigravity-snippets', 'app', 'src', 'main.js'),
    entryCss: path.join(repoRoot, 'antigravity-snippets', 'app', 'src', 'styles.css'),
    outHtml: path.join(repoRoot, 'antigravity-snippets', 'app', 'dist', 'app.html'),
  },
  {
    name: 'antigravity-notifier',
    title: 'Antigravity 远程推送',
    entryJs: path.join(repoRoot, 'antigravity-notifier', 'app', 'src', 'main.js'),
    entryCss: path.join(repoRoot, 'antigravity-notifier', 'app', 'src', 'styles.css'),
    outHtml: path.join(repoRoot, 'antigravity-notifier', 'app', 'dist', 'app.html'),
  },
];

function escapeInlineScript(code) {
  return code.replace(/<\/script/gi, '<\\/script');
}

function escapeInlineStyle(css) {
  return css.replace(/<\/style/gi, '<\\/style');
}

async function buildOne(spec) {
  if (!fs.existsSync(spec.entryJs)) {
    throw new Error(`Missing entry JS for ${spec.name}: ${spec.entryJs}`);
  }
  if (!fs.existsSync(spec.entryCss)) {
    throw new Error(`Missing entry CSS for ${spec.name}: ${spec.entryCss}`);
  }
  const result = await esbuild.build({
    entryPoints: [spec.entryJs],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: ['es2020', 'chrome110'],
    minify: true,
    nodePaths: [path.join(__dirname, 'node_modules')],
  });
  const jsCode = result.outputFiles[0].text;
  const cssCode = fs.readFileSync(spec.entryCss, 'utf8');

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${spec.title}</title>
<style>${escapeInlineStyle(cssCode)}</style>
</head>
<body>
<div id="app"></div>
<script>${escapeInlineScript(jsCode)}</script>
</body>
</html>
`;

  fs.mkdirSync(path.dirname(spec.outHtml), { recursive: true });
  fs.writeFileSync(spec.outHtml, html, 'utf8');
  const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1);
  console.log(`[built] ${spec.name} -> ${path.relative(repoRoot, spec.outHtml)} (${kb} KB)`);
}

const targetFilter = process.argv[2] || '';
const matched = targetFilter ? APPS.filter((s) => s.name === targetFilter) : APPS;
if (!matched.length) {
  console.error(`Unknown MCP App target: ${targetFilter}`);
  process.exit(1);
}
for (const spec of matched) {
  await buildOne(spec);
}
