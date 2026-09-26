const ts = () => new Date().toISOString().slice(11, 23);

export function createLogger(scope) {
  const fmt = (level, msg, meta) => {
    const extra = meta && Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `${ts()} ${level.padEnd(5)} [${scope}] ${msg}${extra}`;
  };
  return {
    info: (msg, meta) => console.log(fmt('INFO', msg, meta)),
    warn: (msg, meta) => console.warn(fmt('WARN', msg, meta)),
    error: (msg, meta) => console.error(fmt('ERROR', msg, meta)),
    debug: (msg, meta) => process.env.DEBUG && console.log(fmt('DEBUG', msg, meta)),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}

export const silentLogger = {
  info() {}, warn() {}, error() {}, debug() {},
  child() { return silentLogger; },
};
