import path from "node:path";
import process from "node:process";

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

function parseBoolean(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined) {
    return defaultValue;
  }

  const normalized = raw.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) {
    return true;
  }

  if (FALSE_VALUES.has(normalized)) {
    return false;
  }

  throw new Error(`Invalid boolean for ${name}: ${raw}`);
}

function parseInteger(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined) {
    return defaultValue;
  }

  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new Error(`Invalid integer for ${name}: ${raw}`);
  }

  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid integer for ${name}: ${raw}`);
  }

  return parsed;
}

function parseString(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined) {
    return defaultValue;
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(`Invalid empty string for ${name}`);
  }

  return trimmed;
}

const SANDBOX_MODES = new Set(["read-only", "workspace-write", "danger-full-access", "seatbelt"]);

function parseSandboxMode(raw) {
  const value = (raw ?? "workspace-write").trim();
  if (SANDBOX_MODES.has(value)) {
    return value;
  }

  throw new Error(`Invalid CODEX_SANDBOX: ${value}`);
}

export function loadConfig(overrides = {}) {
  const workdir = path.resolve(overrides.workdir ?? process.env.CODEX_WORKDIR ?? process.cwd());

  return {
    codexPath: overrides.codexPath ?? process.env.CODEX_PATH ?? "codex",
    host: overrides.host ?? process.env.GATEWAY_HOST ?? "127.0.0.1",
    port: overrides.port ?? parseInteger("GATEWAY_PORT", 8080),
    workdir,
    autoApprove: overrides.autoApprove ?? parseBoolean("AUTO_APPROVE", true),
    forceStreamFalse: overrides.forceStreamFalse ?? parseBoolean("FORCE_STREAM_FALSE", true),
    autoRestart: overrides.autoRestart ?? parseBoolean("AUTO_RESTART", true),
    requestTimeoutMs: overrides.requestTimeoutMs ?? parseInteger("CODEX_REQUEST_TIMEOUT_MS", 30_000),
    turnTimeoutMs: overrides.turnTimeoutMs ?? parseInteger("CODEX_TURN_TIMEOUT_MS", 300_000),
    restartDelayMs: overrides.restartDelayMs ?? parseInteger("CODEX_RESTART_DELAY_MS", 1_000),
    maxBodyBytes: overrides.maxBodyBytes ?? parseInteger("GATEWAY_MAX_BODY_BYTES", 2 * 1024 * 1024),
    defaultCodexModel: overrides.defaultCodexModel ?? parseString("DEFAULT_CODEX_MODEL", "gpt-5.2"),
    sandboxMode: overrides.sandboxMode ?? parseSandboxMode(process.env.CODEX_SANDBOX)
  };
}
