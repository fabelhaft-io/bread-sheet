import winston from 'winston';

const isProduction = process.env.NODE_ENV === 'production';
const isTest = process.env.NODE_ENV === 'test';

// LOG_LEVEL takes precedence; otherwise: debug in dev, info in prod,
// warn in test (keeps the vitest output quiet).
const level =
  process.env.LOG_LEVEL ??
  (isTest ? 'warn' : isProduction ? 'info' : 'debug');

// Always log to stdout — this is a containerised app, and the runtime collector
// (ECS `awslogs` driver → CloudWatch) only ships stdout/stderr. File transports
// would write to the container's ephemeral disk where nothing reads them and the
// logs vanish on task restart. Production emits JSON (machine-parseable in
// CloudWatch); dev uses a printf format that reads better in a terminal. Either
// way the visible level is driven by LOG_LEVEL via `level` above.
const consoleFormat = isProduction
  ? winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
      winston.format.json(),
    )
  : winston.format.combine(
      winston.format.colorize(),
      winston.format.timestamp({ format: 'HH:mm:ss.SSS' }),
      winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
        const metaKeys = Object.keys(meta);
        const metaStr = metaKeys.length ? ` ${JSON.stringify(meta)}` : '';
        const stackStr = stack ? `\n${stack}` : '';
        return `${timestamp} ${level} ${message}${metaStr}${stackStr}`;
      }),
    );

const logger = winston.createLogger({
  level,
  transports: [new winston.transports.Console({ format: consoleFormat })],
});

export default logger;