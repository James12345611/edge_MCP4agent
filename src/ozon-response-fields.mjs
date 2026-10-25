const FIELD_NAME = /^[A-Za-z_$][A-Za-z0-9_$.-]*$/;
const TYPE_LINE = /^(?:string|boolean|integer(?:\s*<[^>]+>)?|number(?:\s*<[^>]+>)?|object|array|Array of (?:objects?|strings?|integers?|numbers?|booleans?))(?:\s*\([^)]*\))?$/i;
const SECTION_END = /^(?:REQUEST BODY SCHEMA:|HEADER PARAMETERS|PATH PARAMETERS|QUERY PARAMETERS|请求范例|回复范例|复制|收回全部)$/i;

function nextNonempty(lines, start) {
  for (let index = start; index < lines.length; index++) {
    if (lines[index].trim()) return index;
  }
  return -1;
}

function responseStatus(lines, schemaIndex) {
  for (let index = schemaIndex - 1; index >= Math.max(0, schemaIndex - 12); index--) {
    const value = lines[index].trim();
    if (/^(?:[1-5]\d\d|default)$/i.test(value)) return value.toLowerCase();
  }
  return 'unknown';
}

function fieldAt(lines, index) {
  const name = lines[index]?.trim();
  if (!name || !FIELD_NAME.test(name) || TYPE_LINE.test(name)) return null;
  let typeIndex = nextNonempty(lines, index + 1);
  if (typeIndex < 0) return null;
  if (/^(?:required|optional)$/i.test(lines[typeIndex].trim())) {
    typeIndex = nextNonempty(lines, typeIndex + 1);
  }
  if (typeIndex < 0 || !TYPE_LINE.test(lines[typeIndex].trim())) return null;
  return { name, type: lines[typeIndex].trim(), typeIndex };
}

function responseExample(content) {
  const marker = String(content || '').indexOf('回复范例');
  if (marker < 0) return null;
  const source = String(content).slice(marker);
  const start = source.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) {
      try {
        return JSON.parse(source.slice(start, index + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function exampleFieldPaths(value, prefix = '', records = []) {
  if (Array.isArray(value)) {
    if (value.length) exampleFieldPaths(value[0], `${prefix}[]`, records);
    return records;
  }
  if (!value || typeof value !== 'object') return records;
  for (const [field, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${field}` : field;
    const displayPath = Array.isArray(child) ? `${path}[]` : path;
    records.push({ field, path: displayPath });
    exampleFieldPaths(child, path, records);
  }
  return records;
}

export function parseResponseFields(content) {
  const lines = String(content || '').replace(/\r\n/g, '\n').split('\n');
  const inferredPaths = exampleFieldPaths(responseExample(content));
  const schemas = [];
  for (let schemaIndex = 0; schemaIndex < lines.length; schemaIndex++) {
    if (!/^RESPONSE SCHEMA:/i.test(lines[schemaIndex].trim())) continue;
    let end = lines.length;
    for (let index = schemaIndex + 1; index < lines.length; index++) {
      const value = lines[index].trim();
      if (/^RESPONSE SCHEMA:/i.test(value) || SECTION_END.test(value)) {
        end = index;
        break;
      }
      if (/^(?:default|错误)$/.test(value) && index > schemaIndex + 1) {
        end = index;
        break;
      }
    }

    const fields = [];
    for (let index = schemaIndex + 1; index < end; index++) {
      const field = fieldAt(lines, index);
      if (!field) continue;
      const description = [];
      let cursor = field.typeIndex + 1;
      for (; cursor < end; cursor++) {
        if (fieldAt(lines, cursor)) break;
        const value = lines[cursor].trim();
        if (value && !/^Array \(\)$/.test(value)) description.push(value);
      }
      const annotation = description.join('\n').trim();
      fields.push({
        ordinal: fields.length + 1,
        field: field.name,
        type: field.type,
        annotation_zh: annotation,
        has_chinese_annotation: /[\u3400-\u9fff]/u.test(annotation),
        paths: [...new Set(
          inferredPaths.filter(item => item.field === field.name).map(item => item.path),
        )],
      });
      index = cursor - 1;
    }
    schemas.push({
      status: responseStatus(lines, schemaIndex),
      content_type: lines[schemaIndex].trim().replace(/^RESPONSE SCHEMA:\s*/i, ''),
      fields,
    });
  }
  return schemas;
}

export function responseFieldSummary(schemas) {
  const fields = schemas.flatMap(schema => schema.fields);
  return {
    schema_count: schemas.length,
    field_count: fields.length,
    chinese_annotation_count: fields.filter(field => field.has_chinese_annotation).length,
  };
}

export function responseFieldsMarkdown(schemas) {
  if (!schemas.length) return '_No response schema found in the rendered documentation._';
  const sections = [];
  for (const schema of schemas) {
    sections.push(`### ${schema.status.toUpperCase()} - ${schema.content_type}`, '');
    if (!schema.fields.length) {
      sections.push('_No named response fields found._', '');
      continue;
    }
    sections.push('| # | Field path | Type | Chinese annotation |', '|---:|---|---|---|');
    for (const field of schema.fields) {
      const annotation = field.annotation_zh
        .replaceAll('|', '\\|')
        .replace(/\n+/g, '<br>');
      const paths = field.paths.length ? field.paths : [field.field];
      sections.push(`| ${field.ordinal} | ${paths.map(path => `\`${path}\``).join('<br>')} | \`${field.type}\` | ${annotation || '_No annotation_'} |`);
    }
    sections.push('');
  }
  return sections.join('\n').trim();
}
