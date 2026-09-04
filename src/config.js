import path from 'node:path';

export const config = {
  port: Number(process.env.PORT || 3010),
  apiKey: process.env.API_KEY || '',
  codexBin: process.env.CODEX_BIN || 'codex',
  codexHome: process.env.CODEX_HOME || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.codex') : ''),
  codexModel: process.env.CODEX_MODEL || '',
  timeoutMs: Number(process.env.CODEX_TIMEOUT_MS || 600_000),
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || 'http://localhost:3010').replace(/\/$/, ''),
  dataDir: path.resolve(process.env.DATA_DIR || 'data'),
};
