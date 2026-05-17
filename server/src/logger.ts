import winston from 'winston';

const isProduction = process.env.NODE_ENV === 'production';
const isTest = process.env.NODE_ENV === 'test';

// LOG_LEVEL takes precedence; otherwise: debug in dev, info in prod,
// warn in test (keeps the vitest output quiet).
const level =
  process.env.LOG_LEVEL ??
  (isTest ? 'warn' : isProduction ? 'info' : 'debug');

const logger = winston.createLogger({
  level,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json(),
  ),
  transports: [
    // - Write all logs with importance level of `error` or less to `error.log`
    // - Write all logs with importance level of `info` or less to `combined.log`
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' }),
  ],
});

// In non-production environments also mirror to the console so the operator
// can see what's happening as requests come in. A printf-style format reads
// far better in a terminal than the JSON we ship to file transports.
if (!isProduction) {
  logger.add(
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp({ format: 'HH:mm:ss.SSS' }),
        winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
          const metaKeys = Object.keys(meta);
          const metaStr = metaKeys.length ? ` ${JSON.stringify(meta)}` : '';
          const stackStr = stack ? `\n${stack}` : '';
          return `${timestamp} ${level} ${message}${metaStr}${stackStr}`;
        }),
      ),
    }),
  );
}

export default logger;
