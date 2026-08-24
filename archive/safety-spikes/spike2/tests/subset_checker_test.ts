import { checkAcceptedSubset, PreflightError } from '../src/subset_checker.ts';
import { assert, assertEquals, assertThrows } from './test_helpers.ts';

const accepted = `export default function(input: string): string {
  const clean = input.trim();
  const present = clean.includes("x", +0);
  return present ? clean.toUpperCase() : \`${'${clean}'}!\`;
}`;

Deno.test('subset accepts the exact narrow expression grammar', () => {
  const result = checkAcceptedSubset(accepted);
  assertEquals(result.schemaVersion, 'subset-check/v1');
  assert(result.astNodeCount > 0);
  assertEquals(result.bindingCount, 2);
});

const rejected: readonly [string, string, string][] = [
  [
    'static import',
    'import x from "x"; export default function(input: string): string { return input; }',
    'dependency_forbidden',
  ],
  [
    'dynamic import',
    'export default function(input: string): string { import("x"); return input; }',
    'dependency_forbidden',
  ],
  [
    'type-only import',
    'import type { X } from "x"; export default function(input: string): string { return input; }',
    'dependency_forbidden',
  ],
  [
    'export-from',
    'export { x } from "./x.ts"; export default function(input: string): string { return input; }',
    'dependency_forbidden',
  ],
  [
    'import equals',
    'import x = require("x"); export default function(input: string): string { return input; }',
    'dependency_forbidden',
  ],
  [
    'require',
    'export default function(input: string): string { require("x"); return input; }',
    'dependency_forbidden',
  ],
  [
    'Worker',
    'export default function(input: string): string { new Worker("x"); return input; }',
    'dependency_forbidden',
  ],
  [
    'SharedWorker',
    'export default function(input: string): string { new SharedWorker("x"); return input; }',
    'dependency_forbidden',
  ],
  [
    'importScripts',
    'export default function(input: string): string { importScripts("x"); return input; }',
    'dependency_forbidden',
  ],
  [
    'source map directive',
    '//# sourceMappingURL=x\nexport default function(input: string): string { return input; }',
    'dependency_forbidden',
  ],
  [
    'AMD directive',
    '/// <amd-module name="x" />\nexport default function(input: string): string { return input; }',
    'dependency_forbidden',
  ],
  [
    'triple slash',
    '/// <reference path="x.ts" />\nexport default function(input: string): string { return input; }',
    'dependency_forbidden',
  ],
  [
    'global',
    'export default function(input: string): string { return globalThis.name; }',
    'unsupported_syntax',
  ],
  [
    'wrong return tag',
    'export default function(input: string): string { return true; }',
    'unsupported_syntax',
  ],
  [
    'loop',
    'export default function(input: string): string { while (true) {} return input; }',
    'unsupported_syntax',
  ],
  [
    'computed property',
    'export default function(input: string): string { return input["trim"](); }',
    'unsupported_syntax',
  ],
];

for (const [name, source, code] of rejected) {
  Deno.test(`subset rejects ${name}`, () => {
    const error = assertThrows(() => checkAcceptedSubset(source));
    assert(error instanceof PreflightError);
    assertEquals((error as PreflightError).code, code);
  });
}

Deno.test('dependency lookalikes in strings and benign comments are allowed', () => {
  checkAcceptedSubset(
    '/* import x from "x" */ export default function(input: string): string { return "require(\\"x\\")" + input; }',
  );
  checkAcceptedSubset(
    '/* Documentation: sourceURL=x is not a directive here. */ export default function(input: string): string { return input; }',
  );
  checkAcceptedSubset(
    'export default function(input: string): string { const requireSuffix = `import raw`; return requireSuffix + input; }',
  );
});

Deno.test('source UTF-8 budget is inclusive and rejects one byte over', () => {
  const base = 'export default function(input: string): string { return input; }';
  const padding = 65_536 - base.length - 4;
  const atLimit = `/*${'x'.repeat(padding)}*/${base}`;
  assertEquals(new TextEncoder().encode(atLimit).byteLength, 65_536);
  checkAcceptedSubset(atLimit);
  const error = assertThrows(() => checkAcceptedSubset(`${atLimit}x`));
  assert(error instanceof PreflightError);
  assertEquals((error as PreflightError).code, 'subset_budget');
});

Deno.test('AST node and depth budgets are inclusive and reject one over', () => {
  const declarations = (count: number): string =>
    Array.from({ length: count }, (_, index) => `const a${index} = "x";`).join('\n');
  const atNodeLimit = `export default function(input: string): string { ${
    declarations(1_636)
  } return a1635; }`;
  const nodeResult = checkAcceptedSubset(atNodeLimit);
  assertEquals(nodeResult.astNodeCount, 8_192);
  const nodeError = assertThrows(() =>
    checkAcceptedSubset(
      `export default function(input: string): string { ${declarations(1_637)} return a1636; }`,
    )
  );
  assert(nodeError instanceof PreflightError);
  assertEquals((nodeError as PreflightError).code, 'subset_budget');

  const parenthesized = (count: number): string =>
    `export default function(input: string): string { return ${'('.repeat(count)}input${
      ')'.repeat(count)
    }; }`;
  const atDepthLimit = checkAcceptedSubset(parenthesized(60));
  assertEquals(atDepthLimit.maximumAstDepth, 64);
  const depthError = assertThrows(() => checkAcceptedSubset(parenthesized(61)));
  assert(depthError instanceof PreflightError);
  assertEquals((depthError as PreflightError).code, 'subset_budget');
});

Deno.test('identifier and string literal budgets are inclusive and reject one byte over', () => {
  const identifierAtLimit = 'a'.repeat(64);
  checkAcceptedSubset(
    `export default function(input: string): string { const ${identifierAtLimit} = input; return ${identifierAtLimit}; }`,
  );
  const identifierError = assertThrows(() => {
    const identifier = 'a'.repeat(65);
    checkAcceptedSubset(
      `export default function(input: string): string { const ${identifier} = input; return ${identifier}; }`,
    );
  });
  assert(identifierError instanceof PreflightError);
  assertEquals((identifierError as PreflightError).code, 'unsupported_syntax');

  const stringAtLimit = 'x'.repeat(4_096);
  checkAcceptedSubset(
    `export default function(input: string): string { return "${stringAtLimit}"; }`,
  );
  const stringError = assertThrows(() =>
    checkAcceptedSubset(
      `export default function(input: string): string { return "${stringAtLimit}x"; }`,
    )
  );
  assert(stringError instanceof PreflightError);
  assertEquals((stringError as PreflightError).code, 'subset_budget');
});

for (
  const [name, expression] of [
    ['this', 'this'],
    ['super', 'super.x'],
    ['new expression', 'new String(input)'],
    ['object literal', '({ value: input })'],
    ['array literal', '[input][0]'],
    ['regular expression', '/x/.source'],
    ['bigint', '1n'],
    ['assignment', '(input = "x")'],
    ['update', 'input++'],
    ['arithmetic', '1 + 2'],
    ['relational', 'input < input ? input : input'],
    ['nullish', 'true ?? false ? input : input'],
    ['bitwise', 'true & false ? input : input'],
    ['comma', '(true, input)'],
    ['optional access', 'input?.trim()'],
    ['spread', '[...input]'],
  ] as const
) {
  Deno.test(`subset rejects forbidden AST/resource expression: ${name}`, () => {
    const error = assertThrows(() =>
      checkAcceptedSubset(
        `export default function(input: string): string { return ${expression}; }`,
      )
    );
    assert(error instanceof PreflightError);
    assertEquals((error as PreflightError).code, 'unsupported_syntax');
  });
}

for (
  const [specifier, statement] of [
    ['./relative.ts', 'import x from "./relative.ts";'],
    ['../parent.ts', 'import x from "../parent.ts";'],
    ['/absolute.ts', 'import x from "/absolute.ts";'],
    ['file URL', 'import x from "file:///tmp/module.ts";'],
    ['npm specifier', 'import x from "npm:package@1";'],
    ['jsr specifier', 'import x from "jsr:@scope/package";'],
    ['http specifier', 'import x from "https://example.test/module.ts";'],
  ] as const
) {
  Deno.test(`subset rejects dependency specifier path: ${specifier}`, () => {
    const error = assertThrows(() =>
      checkAcceptedSubset(
        `${statement} export default function(input: string): string { return input; }`,
      )
    );
    assert(error instanceof PreflightError);
    assertEquals((error as PreflightError).code, 'dependency_forbidden');
  });
}

for (
  const [method, expression] of [
    ['trim()', 'input.trim()'],
    ['toLowerCase()', 'input.toLowerCase()'],
    ['toUpperCase()', 'input.toUpperCase()'],
    ['slice(0)', 'input.slice(0)'],
    ['substring(0)', 'input.substring(0)'],
    ['includes("x")', 'input.includes("x") ? input : ""'],
    ['startsWith("x")', 'input.startsWith("x") ? input : ""'],
    ['endsWith("x")', 'input.endsWith("x") ? input : ""'],
  ]
) {
  Deno.test(`subset accepts allowed method ${method}`, () => {
    checkAcceptedSubset(
      `export default function(input: string): string { return ${expression}; }`,
    );
  });
}
