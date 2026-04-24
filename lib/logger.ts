type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL: Level = (process.env.LOG_LEVEL as Level) ?? 'info';
const MIN_RANK = LEVEL_RANK[MIN_LEVEL] ?? LEVEL_RANK.info;

function emit(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (LEVEL_RANK[level] < MIN_RANK) return;
  const record = { ts: new Date().toISOString(), level, msg, ...fields };
  const line = JSON.stringify(record);
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

export const logger = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit('error', msg, fields),
};
