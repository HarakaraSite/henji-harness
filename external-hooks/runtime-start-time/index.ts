import type { HookHandlers } from '@henji/hooks';

const twoDigits = (value: number): string => String(value).padStart(2, '0');

const workerStartLabel = (): string => {
  const startedAt = new Date();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(startedAt);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((entry) => entry.type === type)?.value ?? '';
  const offsetMinutes = -startedAt.getTimezoneOffset();
  const offset = (offsetMinutes < 0 ? '-' : '+') +
    twoDigits(Math.floor(Math.abs(offsetMinutes) / 60)) + ':' +
    twoDigits(Math.abs(offsetMinutes) % 60);
  const localDateTime = part('year') + '-' + part('month') + '-' + part('day') + 'T' +
    part('hour') + ':' + part('minute') + ':' + part('second');
  return 'Worker started at ' + localDateTime + ' UTC' + offset + ' (' + timeZone + ')';
};

const handlers: HookHandlers = {
  runtime_start: () => ({ context: [workerStartLabel()] }),
};

export default (): HookHandlers => handlers;
