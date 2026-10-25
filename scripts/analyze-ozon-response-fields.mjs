import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ROOT } from '../src/config.mjs';
import {
  parseResponseFields,
  responseFieldSummary,
  responseFieldsMarkdown,
} from '../src/ozon-response-fields.mjs';

const inputArg = process.argv.find(arg => arg.startsWith('--input='));
const positionalInput = process.argv.slice(2).find(arg => !arg.startsWith('-'));
const inputDir = resolve(
  inputArg
    ? inputArg.slice('--input='.length)
    : positionalInput || join(ROOT, 'artifacts', 'ozon-api-final'),
);
const manifest = JSON.parse(await readFile(join(inputDir, 'manifest.json'), 'utf8'));
const records = [];

for (const endpoint of manifest.endpoints || []) {
  const documentPath = join(inputDir, 'endpoints', endpoint.document);
  const content = await readFile(documentPath, 'utf8');
  const schemas = parseResponseFields(content);
  records.push({
    method: endpoint.method,
    path: endpoint.path,
    title: endpoint.title,
    document: endpoint.document,
    ...responseFieldSummary(schemas),
    schemas,
  });
}

const totals = {
  endpoint_count: records.length,
  endpoints_with_response_schema: records.filter(item => item.schema_count > 0).length,
  endpoints_with_named_response_fields: records.filter(item => item.field_count > 0).length,
  response_schema_count: records.reduce((sum, item) => sum + item.schema_count, 0),
  response_field_count: records.reduce((sum, item) => sum + item.field_count, 0),
  chinese_annotation_count: records.reduce((sum, item) => sum + item.chinese_annotation_count, 0),
};
totals.chinese_annotation_coverage = totals.response_field_count
  ? totals.chinese_annotation_count / totals.response_field_count
  : 0;

const markdown = [
  '# Ozon Seller API response fields',
  '',
  `Endpoints: ${totals.endpoint_count}`,
  `Endpoints with response schema: ${totals.endpoints_with_response_schema}`,
  `Endpoints with named response fields: ${totals.endpoints_with_named_response_fields}`,
  `Response schemas: ${totals.response_schema_count}`,
  `Response fields: ${totals.response_field_count}`,
  `Fields with Chinese annotations: ${totals.chinese_annotation_count}`,
  `Chinese annotation coverage: ${(totals.chinese_annotation_coverage * 100).toFixed(2)}%`,
  '',
];

for (const record of records) {
  markdown.push(
    `## ${record.method} ${record.path}`,
    '',
    record.title,
    '',
    `[Original endpoint documentation](endpoints/${record.document})`,
    '',
    responseFieldsMarkdown(record.schemas),
    '',
  );
}

await mkdir(inputDir, { recursive: true });
await writeFile(
  join(inputDir, 'RESPONSE-FIELDS.json'),
  `${JSON.stringify({ generated_at: new Date().toISOString(), totals, endpoints: records }, null, 2)}\n`,
  'utf8',
);
await writeFile(join(inputDir, 'RESPONSE-FIELDS.md'), markdown.join('\n'), 'utf8');
console.log(JSON.stringify({ inputDir, totals }, null, 2));
