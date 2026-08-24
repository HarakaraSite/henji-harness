import ts from 'typescript';
import { domainDigest, rawDigest } from '../../spike1/src/digests.ts';
import { ADMISSION_LIMITS, buildAdmissionProfile } from '../src/admission_profile.ts';
import {
  type BuilderRejectedResponseV1,
  type BuilderResponseV1,
  decodeBuilderRequestFrame,
  encodeFrame,
} from '../src/builder_protocol.ts';
import { validateBuilderEnvironment } from '../src/builder_environment.ts';

const readBoundedStdin = async (): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of Deno.stdin.readable) {
    const remaining = ADMISSION_LIMITS.builderRequestBytes + 5 - total;
    if (remaining <= 0) break;
    const kept = chunk.subarray(0, remaining);
    chunks.push(kept);
    total += kept.byteLength;
  }
  if (total > ADMISSION_LIMITS.builderRequestBytes + 4) throw new Error('request oversize');
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
};

const base64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
};

const rejected = async (
  requestId: string,
  stage: string,
  code: string,
): Promise<BuilderRejectedResponseV1> => ({
  schemaVersion: 'builder-response/v1',
  requestId,
  status: 'rejected',
  stage,
  code,
  detailsDigest: await domainDigest('henji/spike2/rejection-details/v1', { stage, code }),
});

const processRequest = async (): Promise<BuilderResponseV1> => {
  let request;
  try {
    request = decodeBuilderRequestFrame(await readBoundedStdin());
  } catch {
    return await rejected('unbound', 'builder', 'builder_protocol');
  }
  const measuredSourceHash = await rawDigest(
    'henji/spike2/candidate-source/v1',
    new TextEncoder().encode(request.sourceText),
  );
  const profile = await buildAdmissionProfile();
  if (
    request.sourceHash !== measuredSourceHash ||
    request.compilerOptionsDigest !== profile.compilerOptionsDigest ||
    request.admissionProfileDigest !== profile.digest
  ) return await rejected(request.requestId, 'builder', 'builder_protocol');

  const output = ts.transpileModule(request.sourceText, {
    fileName: 'candidate.ts',
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
      isolatedModules: true,
      noResolve: true,
      noLib: true,
      alwaysStrict: true,
      sourceMap: false,
      inlineSourceMap: false,
      inlineSources: false,
      declaration: false,
      declarationMap: false,
      removeComments: false,
      newLine: ts.NewLineKind.LineFeed,
    },
  });
  if (output.diagnostics?.length) {
    return await rejected(request.requestId, 'builder', 'compiler_diagnostic');
  }
  const artifact = new TextEncoder().encode(output.outputText);
  if (artifact.byteLength > ADMISSION_LIMITS.emittedArtifactBytes) {
    return await rejected(request.requestId, 'builder', 'artifact_oversize');
  }
  return {
    schemaVersion: 'builder-response/v1',
    requestId: request.requestId,
    status: 'compiled',
    sourceHash: request.sourceHash,
    compilerOptionsDigest: request.compilerOptionsDigest,
    emittedMediaType: 'application/javascript+module',
    artifactBytesBase64: base64(artifact),
    artifactByteCount: artifact.byteLength,
    diagnostics: [],
    closure: { schemaVersion: 'module-closure/v1', modules: [] },
  };
};

try {
  validateBuilderEnvironment();
  const response = await processRequest();
  const frame = encodeFrame(response, ADMISSION_LIMITS.builderResponseBytes);
  await Deno.stdout.write(frame);
} catch {
  await Deno.stderr.write(new TextEncoder().encode('builder terminal failure\n'));
  Deno.exit(1);
}
