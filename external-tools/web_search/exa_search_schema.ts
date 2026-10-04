import type { JsonValue } from '@henji/tool';

const strings = { type: 'array', items: { type: 'string' } } as const;
const nullable = (schema: JsonValue): JsonValue => ({ anyOf: [schema, { type: 'null' }] });
const retrieval = (properties: JsonValue): JsonValue => ({
  anyOf: [{ type: 'boolean' }, { type: 'object', properties }, { type: 'null' }],
});

/** Current Exa Search options. Exa owns option validation and combination constraints. */
export const EXA_SEARCH_INPUT_SCHEMA: JsonValue = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'Specific search query or research question.' },
    type: {
      type: 'string',
      enum: ['instant', 'fast', 'auto', 'deep-lite', 'deep', 'deep-reasoning'],
      description: 'Search mode; defaults to auto.',
    },
    numResults: { type: 'integer', description: 'Requested result count (1–100, mode dependent).' },
    includeDomains: { ...strings, description: 'Include domains, subdomains, or URL paths.' },
    excludeDomains: { ...strings, description: 'Exclude domains, subdomains, or URL paths.' },
    startPublishedDate: { type: 'string', description: 'Earliest publication time, ISO 8601.' },
    endPublishedDate: { type: 'string', description: 'Latest publication time, ISO 8601.' },
    category: {
      type: 'string',
      description:
        'Category hint: company, people, news, research paper, personal site, financial report, or a custom hint.',
    },
    additionalQueries: { ...strings, description: 'Alternative queries for deep search modes.' },
    userLocation: { type: 'string', description: 'Two-letter country code, such as JP.' },
    objective: { type: 'string', description: 'Broader goal and factual needs to guide ranking.' },
    moderation: { type: 'boolean' },
    compliance: { type: 'string', enum: ['hipaa'], description: 'Enterprise compliance mode.' },
    outputSchema: nullable({
      type: 'object',
      description:
        'JSON Schema for synthesized output: type string for text or type object with properties for structured output (up to 10 properties and 2 nesting levels).',
      additionalProperties: true,
    }),
    systemPrompt: { type: 'string', description: 'Additional synthesized-output instructions.' },
    contents: nullable({
      type: 'object',
      description: 'Content retrieval; defaults to highlights:true when omitted.',
      properties: {
        text: retrieval({
          maxCharacters: nullable({ type: 'integer' }),
          includeHtmlTags: nullable({ type: 'boolean' }),
          verbosity: nullable({ type: 'string', enum: ['compact', 'standard', 'full'] }),
          includeSections: nullable(strings),
          excludeSections: nullable(strings),
        }),
        highlights: retrieval({
          query: nullable({ type: 'string' }),
          maxCharacters: nullable({ type: 'integer' }),
          verbosity: nullable({
            type: 'string',
            enum: ['low', 'medium', 'high'],
            description: 'Beta length preset; incompatible with maxCharacters.',
          }),
          dynamic: nullable({
            type: 'boolean',
            description: 'Beta shared context budget; incompatible with maxCharacters.',
          }),
        }),
        summary: nullable({
          type: 'object',
          properties: {
            query: nullable({ type: 'string' }),
            schema: nullable({ type: 'object', additionalProperties: true }),
          },
        }),
        extras: nullable({
          type: 'object',
          properties: {
            links: nullable({ type: 'integer' }),
            imageLinks: nullable({ type: 'integer' }),
            richLinks: nullable({ type: 'integer' }),
            richImageLinks: nullable({ type: 'integer' }),
            codeBlocks: nullable({ type: 'integer' }),
          },
        }),
        maxAgeHours: nullable({
          type: 'integer',
          description:
            'Cache age: 0 fetches fresh content; -1 uses cache; positive values in hours.',
        }),
        livecrawlTimeout: nullable({
          type: 'integer',
          description: 'Fetch timeout in milliseconds.',
        }),
        snapshotAsOf: nullable({
          type: 'string',
          description: 'Stored version as of ISO date/time.',
        }),
        subpages: nullable({ type: 'integer' }),
        subpageTarget: { anyOf: [{ type: 'string' }, strings, { type: 'null' }] },
      },
    }),
  },
  required: ['query'],
  additionalProperties: true,
};
