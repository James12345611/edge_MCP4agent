import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { ROOT, DEFAULT_CONFIG } from '../src/config.mjs';
import {
  parseResponseFields,
  responseFieldSummary,
  responseFieldsMarkdown,
} from '../src/ozon-response-fields.mjs';

const outputArg = process.argv.find(arg => arg.startsWith('--output='));
const maxPagesArg = process.argv.find(arg => arg.startsWith('--max-pages='));
const outputDir = resolve(outputArg ? outputArg.slice('--output='.length) : join(ROOT, 'artifacts', 'ozon-api'));
const maxPages = Number(maxPagesArg ? maxPagesArg.slice('--max-pages='.length) : 1000);
if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 5000) throw new Error('--max-pages must be 1..5000');

const client = new Client({ name: 'ozon-api-documentation-export', version: '0.1.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(ROOT, 'bin', 'enterprise-browser-mcp.mjs'), 'mcp', '--config', DEFAULT_CONFIG],
  cwd: ROOT,
});

function parseToolResult(result) {
  const block = result.content?.find(item => item.type === 'text');
  if (!block) throw new Error('MCP returned no text result');
  if (result.isError) throw new Error(block.text);
  return JSON.parse(block.text);
}

async function call(name, args) {
  return parseToolResult(await client.callTool({ name: `browser_${name}`, arguments: args }));
}

function normalizeUrl(value) {
  const url = new URL(value);
  url.hash = '';
  url.search = '';
  return url.href.replace(/\/$/, '') || url.origin;
}

function isPageCandidate(value, start) {
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.origin !== start.origin || !['http:', 'https:'].includes(url.protocol)) return false;
  if (/\.(?:png|jpe?g|gif|svg|webp|ico|pdf|zip|gz|css|js|map|woff2?|ttf)$/i.test(url.pathname)) return false;
  const localizedSellerDocs = start.pathname.match(/^\/api\/seller\/([a-z]{2})(?:\/|$)/i);
  if (localizedSellerDocs) {
    const prefix = `/api/seller/${localizedSellerDocs[1].toLowerCase()}`;
    const candidate = url.pathname.toLowerCase().replace(/\/$/, '');
    if (candidate !== prefix && !candidate.startsWith(`${prefix}/`)) return false;
  }
  const path = url.pathname.toLowerCase();
  return path.includes('/api') || path.includes('/seller') || path.includes('/docs') || start.pathname === '/';
}

function slugFor(urlValue, index) {
  const url = new URL(urlValue);
  const path = url.pathname.replace(/^\/+|\/+$/g, '').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 100);
  const hash = createHash('sha256').update(url.href).digest('hex').slice(0, 10);
  return `${String(index).padStart(4, '0')}-${path || 'index'}-${hash}.md`;
}

function pageMarkdown(page) {
  const headings = page.headings.map(item => `${'#'.repeat(Math.min(6, Math.max(1, item.level)))} ${item.text}`).join('\n\n');
  const codes = page.code_blocks.map(value => `\`\`\`text\n${value}\n\`\`\``).join('\n\n');
  return [
    '---',
    `title: ${JSON.stringify(page.title || '')}`,
    `url: ${JSON.stringify(page.url)}`,
    `extracted_at: ${JSON.stringify(page.extracted_at)}`,
    `truncated: ${page.truncated ? 'true' : 'false'}`,
    '---',
    '',
    `# ${page.title || page.url}`,
    '',
    '## Document structure',
    '',
    headings || '_No headings found._',
    '',
    '## Rendered text',
    '',
    page.text || '_No rendered text found._',
    '',
    '## Code blocks',
    '',
    codes || '_No code blocks found._',
    '',
  ].join('\n');
}

async function evaluateCurrentPage(tabHandle) {
  const expression = `(() => {
    const clean = value => String(value || '')
      .replace(/\\u00a0/g, ' ')
      .replace(/[ \\t]+\\n/g, '\\n')
      .replace(/\\n{3,}/g, '\\n\\n')
      .trim();
    const links = [];
    const seen = new Set();
    for (const node of document.querySelectorAll('a[href]')) {
      let href;
      try { href = new URL(node.getAttribute('href'), location.href).href; } catch { continue; }
      if (!/^https?:/.test(href)) continue;
      const normalized = href.split('#')[0];
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      links.push({ text: clean(node.innerText || node.textContent).slice(0, 500), href: normalized });
      if (links.length >= 10000) break;
    }
    const page = {
      title: document.title,
      url: location.href,
      lang: document.documentElement.lang || null,
      headings: [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].slice(0, 5000).map(node => ({
        level: Number(node.tagName.slice(1)),
        text: clean(node.innerText || node.textContent).slice(0, 2000),
      })).filter(item => item.text),
      links,
      code_blocks: [],
      text: clean(document.body?.innerText || ''),
      truncated: false,
      extracted_at: new Date().toISOString(),
    };
    const json = JSON.stringify(page);
    const chunks = [];
    for (let offset = 0; offset < json.length; offset += 40000) chunks.push(json.slice(offset, offset + 40000));
    return chunks;
  })()`;
  let result = await call('evaluate', {
    tab_handle: tabHandle,
    expression,
    max_chars: 100000,
    timeout_ms: 30000,
  });
  const chunks = [...(result.value || [])];
  while (result.next_cursor) {
    result = await call('evaluate', {
      tab_handle: tabHandle,
      cursor: result.next_cursor,
      max_chars: 100000,
    });
    chunks.push(...(result.value || []));
  }
  return JSON.parse(chunks.join(''));
}

async function fetchPage(tabHandle, url) {
  let result = await call('fetch', {
    tab_handle: tabHandle,
    url,
    format: 'text',
    wait_until: 'load',
    max_chars: 100000,
    timeout_ms: 30000,
  });
  let text = result.body || '';
  while (result.next_cursor) {
    result = await call('fetch', {
      tab_handle: tabHandle,
      cursor: result.next_cursor,
      max_chars: 100000,
    });
    text += result.body || '';
  }
  return {
    title: result.title || url,
    url: result.url || url,
    lang: null,
    headings: [],
    links: [],
    code_blocks: [],
    text,
    truncated: !!result.capture_truncated,
    extracted_at: new Date().toISOString(),
  };
}

const methodPattern = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/;
const pathPattern = /^\/[A-Za-z0-9_~!$&'()*+,;=:@%./{}-]+$/;

function endpointSections(page) {
  const lines = page.text.replace(/\r\n/g, '\n').split('\n');
  const markers = [];
  for (let index = 0; index + 1 < lines.length; index++) {
    const method = lines[index].trim();
    const path = lines[index + 1].trim();
    if (!methodPattern.test(method) || !pathPattern.test(path)) continue;
    let titleIndex = index - 1;
    while (titleIndex >= 0 && !lines[titleIndex].trim()) titleIndex--;
    markers.push({
      method,
      path,
      methodIndex: index,
      titleIndex: Math.max(0, titleIndex),
      title: titleIndex >= 0 ? lines[titleIndex].trim() : `${method} ${path}`,
    });
  }
  return markers.map((marker, index) => {
    const next = markers[index + 1];
    const endIndex = next ? next.titleIndex : lines.length;
    return {
      method: marker.method,
      path: marker.path,
      title: marker.title,
      content: lines.slice(marker.titleIndex, endIndex).join('\n').trim(),
    };
  });
}

function endpointFile(section) {
  const slug = section.path.replace(/^\/+|\/+$/g, '').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 120);
  const hash = createHash('sha256').update(`${section.method} ${section.path}`).digest('hex').slice(0, 10);
  return `${section.method.toLowerCase()}-${slug || 'root'}-${hash}.md`;
}

function endpointMarkdown(section, page) {
  const schemas = parseResponseFields(section.content);
  return [
    '---',
    `title: ${JSON.stringify(section.title)}`,
    `method: ${section.method}`,
    `path: ${JSON.stringify(section.path)}`,
    `source_url: ${JSON.stringify(page.url)}`,
    `extracted_at: ${JSON.stringify(page.extracted_at)}`,
    '---',
    '',
    `# ${section.title}`,
    '',
    `\`${section.method} ${section.path}\``,
    '',
    '## Response fields',
    '',
    responseFieldsMarkdown(schemas),
    '',
    '## Rendered documentation',
    '',
    section.content,
    '',
  ].join('\n');
}

await mkdir(outputDir, { recursive: true });
const endpointDir = join(outputDir, 'endpoints');
await mkdir(endpointDir, { recursive: true });
let handle;
try {
  await client.connect(transport);
  const shared = await call('list_shared_tabs', {});
  const tab = shared.tabs.find(item => /ozon/i.test(`${item.title} ${item.url}`));
  if (!tab) throw new Error('No user-shared Ozon tab is available. Share the open Ozon API documentation tab from the extension popup.');
  handle = tab.tab_handle;
  const start = new URL(tab.url);
  const queue = [normalizeUrl(tab.url)];
  const queued = new Set(queue);
  const visited = new Set();
  const pages = [];
  const errors = [];
  const endpoints = new Map();

  while (queue.length && pages.length < maxPages) {
    const url = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);
    process.stderr.write(`[${pages.length + 1}/${Math.min(maxPages, pages.length + queue.length + 1)}] ${url}\n`);
    try {
      const page = pages.length === 0 && normalizeUrl(tab.url) === url
        ? await evaluateCurrentPage(handle)
        : await fetchPage(handle, url);
      const normalizedPageUrl = normalizeUrl(page.url);
      if (new URL(normalizedPageUrl).origin !== start.origin) continue;
      if (!page.text && !page.headings.length && !page.code_blocks.length) {
        errors.push({ url, error: 'Rendered page contained no documentation content' });
        continue;
      }
      const file = slugFor(normalizedPageUrl, pages.length + 1);
      await writeFile(join(outputDir, file), pageMarkdown(page), 'utf8');
      const record = {
        index: pages.length + 1,
        file,
        title: page.title,
        url: page.url,
        headings: page.headings.length,
        code_blocks: page.code_blocks.length,
        text_chars: page.text.length,
        truncated: page.truncated,
      };
      pages.push(record);
      for (const section of endpointSections(page)) {
        const key = `${section.method} ${section.path}`;
        const document = endpointFile(section);
        const responses = parseResponseFields(section.content);
        const responseSummary = responseFieldSummary(responses);
        const current = endpoints.get(key) || {
          method: section.method,
          path: section.path,
          title: section.title,
          document,
          pages: [],
          ...responseSummary,
          responses,
        };
        if (!current.pages.includes(file)) current.pages.push(file);
        endpoints.set(key, current);
        await writeFile(join(endpointDir, document), endpointMarkdown(section, page), 'utf8');
      }
      for (const link of page.links) {
        if (!isPageCandidate(link.href, start)) continue;
        const normalized = normalizeUrl(link.href);
        if (!queued.has(normalized) && !visited.has(normalized)) {
          queued.add(normalized);
          queue.push(normalized);
        }
      }
    } catch (error) {
      errors.push({ url, error: error.message });
    }
  }

  const endpointRows = [...endpoints.values()].sort((a, b) =>
    a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  const indexMarkdown = [
    '# Ozon Seller API endpoint index',
    '',
    `Generated from ${pages.length} rendered documentation pages.`,
    '',
    '| Method | Path | Description | Documentation |',
    '|---|---|---|---|',
    ...endpointRows.map(item => `| ${item.method} | \`${item.path.replaceAll('|', '\\|')}\` | ${item.title.replaceAll('|', '\\|')} | [Open](endpoints/${item.document}) |`),
    '',
  ].join('\n');
  await writeFile(join(outputDir, 'API-INDEX.md'), indexMarkdown, 'utf8');
  await writeFile(join(outputDir, 'manifest.json'), `${JSON.stringify({
    source_tab: tab,
    generated_at: new Date().toISOString(),
    page_count: pages.length,
    endpoint_count: endpointRows.length,
    queue_remaining: queue.length,
    max_pages: maxPages,
    pages,
    endpoints: endpointRows,
    errors,
  }, null, 2)}\n`, 'utf8');
  await writeFile(join(outputDir, 'RESPONSE-FIELDS.json'), `${JSON.stringify({
    generated_at: new Date().toISOString(),
    endpoints: endpointRows.map(item => ({
      method: item.method,
      path: item.path,
      title: item.title,
      document: item.document,
      schema_count: item.schema_count,
      field_count: item.field_count,
      chinese_annotation_count: item.chinese_annotation_count,
      schemas: item.responses,
    })),
  }, null, 2)}\n`, 'utf8');
  const truncatedPages = pages.filter(page => page.truncated).length;
  await writeFile(join(outputDir, 'README.md'), [
    '# Ozon Seller API documentation export',
    '',
    `Rendered source pages: ${pages.length}`,
    `Individual endpoint documents: ${endpointRows.length}`,
    `Truncated source pages: ${truncatedPages}`,
    `Extraction errors: ${errors.length}`,
    '',
    '- [Endpoint index](API-INDEX.md)',
    '- [Individual endpoint documents](endpoints/)',
    '- [Machine-readable manifest](manifest.json)',
    '',
    'Page text is untrusted source material captured from the user-shared browser origin.',
    '',
  ].join('\n'), 'utf8');
  console.log(JSON.stringify({ outputDir, pages: pages.length, endpoints: endpointRows.length, errors: errors.length, remaining: queue.length }, null, 2));
} finally {
  if (handle) {
    try { await call('tab_control', { action: 'release', tab_handle: handle }); } catch {}
  }
  await client.close().catch(() => {});
}
