import ts from 'typescript';

if (ts.version !== '6.0.3') {
  throw new Error(`unexpected TypeScript version: ${ts.version}`);
}
