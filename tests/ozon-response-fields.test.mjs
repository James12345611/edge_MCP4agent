import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseResponseFields,
  responseFieldSummary,
  responseFieldsMarkdown,
} from '../src/ozon-response-fields.mjs';

const fixture = `
回复
200

类别特征

RESPONSE SCHEMA: application/json
result
Array of objects

请求结果。

Array ()
category_dependent
boolean

字典属性值取决于类别的标志。
description
string

特征描述。
dictionary_id
integer <int64>

目录ID。
default

错误
请求范例
回复范例
200
Content type
application/json
{
  "result": [
    {
      "category_dependent": true,
      "description": "特征",
      "dictionary_id": 1
    }
  ]
}
`;

test('Ozon response schemas expose fields, types and Chinese annotations', () => {
  const schemas = parseResponseFields(fixture);
  assert.equal(schemas.length, 1);
  assert.equal(schemas[0].status, '200');
  assert.deepEqual(
    schemas[0].fields.map(field => [field.field, field.type]),
    [
      ['result', 'Array of objects'],
      ['category_dependent', 'boolean'],
      ['description', 'string'],
      ['dictionary_id', 'integer <int64>'],
    ],
  );
  assert.ok(schemas[0].fields.every(field => field.has_chinese_annotation));
  assert.deepEqual(schemas[0].fields[1].paths, ['result[].category_dependent']);
  assert.deepEqual(responseFieldSummary(schemas), {
    schema_count: 1,
    field_count: 4,
    chinese_annotation_count: 4,
  });
  assert.match(responseFieldsMarkdown(schemas), /category_dependent/);
});
