import {
  benchmarkV6RepeatedContext,
  benchmarkV6SessionLengthDelta,
  benchmarkV6UniquePayloadScaling,
} from '../v0/agent/history/v6_history_capacity_benchmark.ts';

const root = await Deno.makeTempDir({ prefix: 'henji-history-v6-capacity-' });
const targetCumulativeTokens = Number(Deno.args[0] ?? '100000000');
const repeated = await benchmarkV6RepeatedContext({
  databasePath: `${root}/history-v6-capacity.sqlite3`,
  targetCumulativeTokens,
  tokenBytes: 4,
  fixedPrefixBytes: 65_536,
  newFactBytesPerTurn: 10_000,
});
await Deno.mkdir(`${root}/session-length`);
const sessionLength = await benchmarkV6SessionLengthDelta(
  `${root}/session-length`,
  [1_000, 10_000, 100_000],
);
await Deno.mkdir(`${root}/unique-payload`);
const uniquePayload = await benchmarkV6UniquePayloadScaling(
  `${root}/unique-payload`,
  [1_048_576, 4_194_304, 16_777_216],
);

console.log(JSON.stringify({ root, repeated, sessionLength, uniquePayload }, null, 2));
