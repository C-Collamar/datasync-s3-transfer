import { config, createLogger, format, transports } from 'winston';

// logs everything to file
const file = new transports.File({
  level: 'debug',
  maxsize: 25000,
  maxFiles: 3,
  filename: `verbose.log`
});

// logs only info and more critical messages to console
const console = new transports.Console({
  format: format.simple()
});

const isProd = process.env.NODE_ENV === 'production';

/**
 * Application logging service.
 */
export const logger = createLogger({
  levels: config.syslog.levels,
  transports: [file, console],
  level: isProd? 'info' : 'debug'
});