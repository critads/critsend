type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
};

const MIN_LEVEL = LOG_LEVELS[(process.env.LOG_LEVEL as LogLevel) || 'info'];

interface LogEntry {
  level: LogLevel;
  timestamp: string;
  msg: string;
  [key: string]: any;
}

function formatLog(entry: LogEntry): string {
  const { level, timestamp, msg, ...extra } = entry;
  const extraStr = Object.keys(extra).length > 0 ? ' ' + JSON.stringify(extra) : '';
  return `${timestamp} [${level.toUpperCase()}] ${msg}${extraStr}`;
}

function normalizeExtra(extra?: Record<string, any> | unknown): Record<string, any> | undefined {
  if (extra === undefined || extra === null) return undefined;
  if (typeof extra === 'object' && !Array.isArray(extra)) return extra as Record<string, any>;
  return { value: String(extra) };
}

function createLog(level: LogLevel, msg: string, extra?: Record<string, any> | unknown) {
  if (LOG_LEVELS[level] < MIN_LEVEL) return;
  
  const safeExtra = normalizeExtra(extra);
  const entry: LogEntry = {
    level,
    timestamp: new Date().toISOString(),
    msg,
    ...safeExtra,
  };
  
  const formatted = formatLog(entry);
  
  if (level === 'error' || level === 'fatal') {
    console.error(formatted);
  } else if (level === 'warn') {
    console.warn(formatted);
  } else {
    console.log(formatted);
  }
}

export const logger = {
  debug: (msg: string, extra?: Record<string, any> | unknown) => createLog('debug', msg, extra),
  info: (msg: string, extra?: Record<string, any> | unknown) => createLog('info', msg, extra),
  warn: (msg: string, extra?: Record<string, any> | unknown) => createLog('warn', msg, extra),
  error: (msg: string, extra?: Record<string, any> | unknown) => createLog('error', msg, extra),
  fatal: (msg: string, extra?: Record<string, any> | unknown) => createLog('fatal', msg, extra),
  child: (context: Record<string, any>) => ({
    debug: (msg: string, extra?: Record<string, any> | unknown) => createLog('debug', msg, { ...context, ...normalizeExtra(extra) }),
    info: (msg: string, extra?: Record<string, any> | unknown) => createLog('info', msg, { ...context, ...normalizeExtra(extra) }),
    warn: (msg: string, extra?: Record<string, any> | unknown) => createLog('warn', msg, { ...context, ...normalizeExtra(extra) }),
    error: (msg: string, extra?: Record<string, any> | unknown) => createLog('error', msg, { ...context, ...normalizeExtra(extra) }),
    fatal: (msg: string, extra?: Record<string, any> | unknown) => createLog('fatal', msg, { ...context, ...normalizeExtra(extra) }),
  }),
};
