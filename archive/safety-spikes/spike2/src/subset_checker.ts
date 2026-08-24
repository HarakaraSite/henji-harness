import ts from 'typescript';
import { ADMISSION_LIMITS, SUBSET_MANIFEST } from './admission_profile.ts';

export type PreflightCode =
  | 'syntax_invalid'
  | 'dependency_forbidden'
  | 'unsupported_syntax'
  | 'subset_budget';

export class PreflightError extends Error {
  override readonly name = 'PreflightError';
  constructor(readonly code: PreflightCode) {
    super(code);
  }
}

type Tag = 'string' | 'number' | 'boolean';
const fail = (code: PreflightCode): never => {
  throw new PreflightError(code);
};
const utf8Length = (value: string): number => new TextEncoder().encode(value).byteLength;
const bindingPattern = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const reserved = new Set([
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'let',
  'new',
  'null',
  'return',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
]);
const allowedKinds = new Set<number>(
  [...SUBSET_MANIFEST.syntaxKinds, ...SUBSET_MANIFEST.modifiers, ...SUBSET_MANIFEST.operators].map(
    (name) => ts.SyntaxKind[name as keyof typeof ts.SyntaxKind] as number,
  ),
);

const checkCommentDirectives = (source: string): void => {
  const scanner = ts.createScanner(
    ts.ScriptTarget.ES2022,
    false,
    ts.LanguageVariant.Standard,
    source,
  );
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (
      token === ts.SyntaxKind.SingleLineCommentTrivia ||
      token === ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      const comment = scanner.getTokenText();
      if (
        /^\/\/\/\s*<(?:reference\s+(?:path|types|lib)\s*=|amd-(?:module|dependency)\b)/i
          .test(comment) ||
        /^\/\/[#@]\s*source(?:Mapping)?URL\s*=/i.test(comment) ||
        /^\/\*[#@]\s*source(?:Mapping)?URL\s*=/i.test(comment)
      ) fail('dependency_forbidden');
    }
  }
};

const checkDependencyNodes = (root: ts.Node): void => {
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node) ||
      ts.isExportDeclaration(node) || ts.isExternalModuleReference(node) ||
      node.kind === ts.SyntaxKind.ImportKeyword
    ) fail('dependency_forbidden');
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) fail('dependency_forbidden');
      if (
        ts.isIdentifier(node.expression) &&
        ['require', 'Worker', 'SharedWorker', 'importScripts'].includes(node.expression.text)
      ) fail('dependency_forbidden');
    }
    if (
      ts.isNewExpression(node) && ts.isIdentifier(node.expression) &&
      ['Worker', 'SharedWorker'].includes(node.expression.text)
    ) fail('dependency_forbidden');
    ts.forEachChild(node, visit);
  };
  visit(root);
};

const countAst = (root: ts.Node): { count: number; maximumDepth: number } => {
  let count = 0;
  let maximumDepth = 0;
  const visit = (node: ts.Node, depth: number): void => {
    if (!allowedKinds.has(node.kind)) fail('unsupported_syntax');
    if (++count > ADMISSION_LIMITS.astNodes || depth > ADMISSION_LIMITS.astDepth) {
      fail('subset_budget');
    }
    maximumDepth = Math.max(maximumDepth, depth);
    ts.forEachChild(node, (child) => visit(child, depth + 1));
  };
  visit(root, 0);
  return { count, maximumDepth };
};

const expectTag = (actual: Tag, expected: Tag): void => {
  if (actual !== expected) fail('unsupported_syntax');
};

const expressionTag = (node: ts.Expression, env: ReadonlyMap<string, Tag>): Tag => {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    if (utf8Length(node.text) > ADMISSION_LIMITS.identifierOrStringBytes) fail('subset_budget');
    return 'string';
  }
  if (ts.isNumericLiteral(node)) {
    if (!Number.isFinite(Number(node.text))) fail('unsupported_syntax');
    return 'number';
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) {
    return 'boolean';
  }
  if (ts.isIdentifier(node)) {
    const tag = env.get(node.text);
    return tag ?? fail('unsupported_syntax');
  }
  if (ts.isParenthesizedExpression(node)) return expressionTag(node.expression, env);
  if (ts.isPrefixUnaryExpression(node)) {
    if (node.operator === ts.SyntaxKind.ExclamationToken) {
      expectTag(expressionTag(node.operand, env), 'boolean');
      return 'boolean';
    }
    if (node.operator === ts.SyntaxKind.PlusToken || node.operator === ts.SyntaxKind.MinusToken) {
      expectTag(expressionTag(node.operand, env), 'number');
      return 'number';
    }
    return fail('unsupported_syntax');
  }
  if (ts.isBinaryExpression(node)) {
    const left = expressionTag(node.left, env);
    const right = expressionTag(node.right, env);
    if (node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      expectTag(left, 'string');
      expectTag(right, 'string');
      return 'string';
    }
    if (
      node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
    ) {
      expectTag(right, left);
      return 'boolean';
    }
    if (
      node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      node.operatorToken.kind === ts.SyntaxKind.BarBarToken
    ) {
      expectTag(left, 'boolean');
      expectTag(right, 'boolean');
      return 'boolean';
    }
    return fail('unsupported_syntax');
  }
  if (ts.isConditionalExpression(node)) {
    expectTag(expressionTag(node.condition, env), 'boolean');
    const whenTrue = expressionTag(node.whenTrue, env);
    expectTag(expressionTag(node.whenFalse, env), whenTrue);
    return whenTrue;
  }
  if (ts.isTemplateExpression(node)) {
    if (utf8Length(node.head.text) > ADMISSION_LIMITS.identifierOrStringBytes) {
      fail('subset_budget');
    }
    for (const span of node.templateSpans) {
      expressionTag(span.expression, env);
      if (utf8Length(span.literal.text) > ADMISSION_LIMITS.identifierOrStringBytes) {
        fail('subset_budget');
      }
    }
    return 'string';
  }
  if (ts.isCallExpression(node)) {
    if (
      node.questionDotToken || node.typeArguments?.length ||
      !ts.isPropertyAccessExpression(node.expression)
    ) {
      return fail('unsupported_syntax');
    }
    const access = node.expression;
    if (access.questionDotToken) fail('unsupported_syntax');
    expectTag(expressionTag(access.expression, env), 'string');
    const method = access.name.text;
    const argumentTags = node.arguments.map((argument) => {
      if (ts.isSpreadElement(argument)) fail('unsupported_syntax');
      return expressionTag(argument, env);
    });
    if (['trim', 'toUpperCase', 'toLowerCase'].includes(method)) {
      if (argumentTags.length !== 0) fail('unsupported_syntax');
      return 'string';
    }
    if (['slice', 'substring'].includes(method)) {
      if (argumentTags.length < 1 || argumentTags.length > 2) fail('unsupported_syntax');
      argumentTags.forEach((tag) => expectTag(tag, 'number'));
      return 'string';
    }
    if (['includes', 'startsWith', 'endsWith'].includes(method)) {
      if (argumentTags.length < 1 || argumentTags.length > 2) fail('unsupported_syntax');
      expectTag(argumentTags[0], 'string');
      if (argumentTags.length === 2) expectTag(argumentTags[1], 'number');
      return 'boolean';
    }
    return fail('unsupported_syntax');
  }
  return fail('unsupported_syntax');
};

export interface SubsetCheckResultV1 {
  readonly schemaVersion: 'subset-check/v1';
  readonly astNodeCount: number;
  readonly maximumAstDepth: number;
  readonly bindingCount: number;
}

export const checkAcceptedSubset = (sourceText: string): SubsetCheckResultV1 => {
  if (new TextEncoder().encode(sourceText).byteLength > ADMISSION_LIMITS.sourceUtf8Bytes) {
    fail('subset_budget');
  }
  checkCommentDirectives(sourceText);
  const source = ts.createSourceFile(
    'candidate.ts',
    sourceText,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  const parsed = source as ts.SourceFile & { readonly parseDiagnostics: readonly ts.Diagnostic[] };
  if (parsed.parseDiagnostics.length) fail('syntax_invalid');
  checkDependencyNodes(source);
  const astMetrics = countAst(source);
  if (source.statements.length !== 1) {
    fail('unsupported_syntax');
  }
  const onlyStatement = source.statements[0];
  if (!ts.isFunctionDeclaration(onlyStatement)) fail('unsupported_syntax');
  const fn = onlyStatement as ts.FunctionDeclaration;
  const modifiers = fn.modifiers?.map((modifier) => modifier.kind) ?? [];
  if (
    modifiers.length !== 2 || modifiers[0] !== ts.SyntaxKind.ExportKeyword ||
    modifiers[1] !== ts.SyntaxKind.DefaultKeyword || fn.name || fn.asteriskToken ||
    fn.typeParameters?.length || !fn.body || fn.parameters.length !== 1
  ) fail('unsupported_syntax');
  const parameter = fn.parameters[0];
  if (
    parameter.modifiers?.length || parameter.dotDotDotToken || parameter.questionToken ||
    parameter.initializer || !ts.isIdentifier(parameter.name) || parameter.name.text !== 'input' ||
    !parameter.type || parameter.type.kind !== ts.SyntaxKind.StringKeyword ||
    !fn.type || fn.type.kind !== ts.SyntaxKind.StringKeyword
  ) fail('unsupported_syntax');

  const env = new Map<string, Tag>([['input', 'string']]);
  const statements = (fn.body as ts.Block).statements;
  if (statements.length < 1) {
    fail('unsupported_syntax');
  }
  const finalStatement = statements.at(-1);
  if (!finalStatement || !ts.isReturnStatement(finalStatement)) fail('unsupported_syntax');
  for (const statement of statements.slice(0, -1)) {
    if (!ts.isVariableStatement(statement)) fail('unsupported_syntax');
    const variableStatement = statement as ts.VariableStatement;
    if ((variableStatement.declarationList.flags & ts.NodeFlags.Const) === 0) {
      fail('unsupported_syntax');
    }
    if (variableStatement.declarationList.declarations.length !== 1) {
      fail('unsupported_syntax');
    }
    const declaration = variableStatement.declarationList.declarations[0];
    if (
      !ts.isIdentifier(declaration.name) || declaration.type || declaration.exclamationToken ||
      !declaration.initializer
    ) fail('unsupported_syntax');
    const name = (declaration.name as ts.Identifier).text;
    if (!bindingPattern.test(name) || reserved.has(name) || env.has(name)) {
      fail('unsupported_syntax');
    }
    env.set(name, expressionTag(declaration.initializer as ts.Expression, env));
  }
  const returnStatement = finalStatement as ts.ReturnStatement;
  const returnExpression = returnStatement.expression;
  if (!returnExpression) fail('unsupported_syntax');
  expectTag(expressionTag(returnExpression as ts.Expression, env), 'string');
  return {
    schemaVersion: 'subset-check/v1',
    astNodeCount: astMetrics.count,
    maximumAstDepth: astMetrics.maximumDepth,
    bindingCount: env.size - 1,
  };
};
