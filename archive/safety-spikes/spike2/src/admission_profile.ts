import { domainDigest } from '../../spike1/src/digests.ts';

export const ADMISSION_LIMITS = Object.freeze(
  {
    canonicalCandidateSnapshotBytes: 196_608,
    admissionRequestCanonicalBytes: 512,
    admissionGrantCanonicalBytes: 4_096,
    admissionRecordCanonicalBytes: 16_384,
    trustedIdBytes: 256,
    candidateStoreEntries: 64,
    candidateStoreCanonicalBytes: 12_615_680,
    grantStoreEntries: 64,
    grantStoreCanonicalBytes: 270_336,
    registryEntries: 64,
    registryCanonicalBytes: 1_064_960,
    artifactIndexEntries: 64,
    artifactIndexCanonicalBytes: 32_768,
    sourceUtf8Bytes: 65_536,
    astNodes: 8_192,
    astDepth: 64,
    identifierOrStringBytes: 4_096,
    builderRequestBytes: 98_304,
    builderResponseBytes: 262_144,
    emittedArtifactBytes: 131_072,
    stderrBytes: 16_384,
    builderTimeoutMilliseconds: 2_000,
    concurrentBuilders: 1,
    artifactStoreEntries: 64,
    artifactStoreBytes: 8_388_608,
    ledgerEntries: 64,
    ledgerCanonicalBytes: 1_048_576,
  } as const,
);

export const COMPILER_OPTIONS_MANIFEST = Object.freeze(
  {
    schemaVersion: 'compiler-options/v1',
    target: 'ES2022',
    module: 'ES2022',
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
    newLine: 'LineFeed',
  } as const,
);

export const SUBSET_MANIFEST = Object.freeze(
  {
    schemaVersion: 'accepted-subset/v1',
    parameterName: 'input',
    parameterType: 'string',
    returnType: 'string',
    syntaxKinds: Object.freeze([
      'BinaryExpression',
      'Block',
      'CallExpression',
      'ColonToken',
      'ConditionalExpression',
      'EndOfFileToken',
      'FalseKeyword',
      'FunctionDeclaration',
      'Identifier',
      'NoSubstitutionTemplateLiteral',
      'NumericLiteral',
      'Parameter',
      'ParenthesizedExpression',
      'PrefixUnaryExpression',
      'PropertyAccessExpression',
      'QuestionToken',
      'ReturnStatement',
      'SourceFile',
      'StringKeyword',
      'StringLiteral',
      'TemplateExpression',
      'TemplateHead',
      'TemplateMiddle',
      'TemplateSpan',
      'TemplateTail',
      'TrueKeyword',
      'VariableDeclaration',
      'VariableDeclarationList',
      'VariableStatement',
    ]),
    modifiers: Object.freeze(['DefaultKeyword', 'ExportKeyword']),
    operators: Object.freeze([
      'AmpersandAmpersandToken',
      'BarBarToken',
      'EqualsEqualsEqualsToken',
      'ExclamationEqualsEqualsToken',
      'ExclamationToken',
      'MinusToken',
      'PlusToken',
    ]),
    methods: Object.freeze([
      'endsWith(string,number?):boolean',
      'includes(string,number?):boolean',
      'slice(number,number?):string',
      'startsWith(string,number?):boolean',
      'substring(number,number?):string',
      'toLowerCase():string',
      'toUpperCase():string',
      'trim():string',
    ]),
  } as const,
);

export const buildAdmissionProfile = async () => {
  const subsetManifestDigest = await domainDigest(
    'henji/spike2/subset-manifest/v1',
    SUBSET_MANIFEST,
  );
  const compilerOptionsDigest = await domainDigest(
    'henji/spike2/compiler-options/v1',
    COMPILER_OPTIONS_MANIFEST,
  );
  const profile = {
    schemaVersion: 'admission-profile/v1',
    profileVersion: 'spike2-profile-1',
    limits: ADMISSION_LIMITS,
    subsetManifestDigest,
    compilerOptionsDigest,
  } as const;
  return {
    profile,
    digest: await domainDigest('henji/spike2/admission-profile/v1', profile),
    subsetManifestDigest,
    compilerOptionsDigest,
  };
};
