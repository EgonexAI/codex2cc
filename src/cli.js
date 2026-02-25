import process from "node:process";
import { loadConfig } from "./config.js";
import { CodexAppServerClient } from "./codex-client.js";
import { createGatewayServer } from "./gateway-server.js";

function printHelp() {
  console.log(`
Codex Gateway (Anthropic Messages compatibility)

Usage:
  codex-gateway start [options]
  codex-gateway help

Options:
  --port <number>             HTTP port (default: env GATEWAY_PORT or 8080)
  --host <value>              Bind host (default: env GATEWAY_HOST or 127.0.0.1)
  --workdir <path>            Codex workdir (default: env CODEX_WORKDIR or cwd)
  --codex-path <path>         Codex CLI path (default: env CODEX_PATH or codex)
  --default-codex-model <id>  Fallback Codex model (default: env DEFAULT_CODEX_MODEL or gpt-5.2)
  --turn-timeout-ms <number>  Turn timeout in ms (default: env CODEX_TURN_TIMEOUT_MS or 300000)
  --request-timeout-ms <num>  JSON-RPC timeout in ms (default: env CODEX_REQUEST_TIMEOUT_MS or 30000)
  --help                      Show this help

Env:
  AUTO_APPROVE=true|false
  FORCE_STREAM_FALSE=true|false
  DEFAULT_CODEX_MODEL=gpt-5.2|gpt-5.3-codex|...
  CODEX_SANDBOX=read-only|workspace-write|danger-full-access|seatbelt
  AUTO_RESTART=true|false
`);
}

function parseInteger(name, raw) {
  const trimmed = String(raw ?? "").trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new Error(`Invalid value for ${name}: ${raw}`);
  }
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid value for ${name}: ${raw}`);
  }
  return value;
}

function parseCliOptions(args) {
  const options = {};

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];

    switch (token) {
      case "--port":
        options.port = parseInteger("--port", args[++index]);
        break;
      case "--host":
        options.host = args[++index];
        break;
      case "--workdir":
        options.workdir = args[++index];
        break;
      case "--codex-path":
        options.codexPath = args[++index];
        break;
      case "--default-codex-model":
        options.defaultCodexModel = args[++index];
        break;
      case "--turn-timeout-ms":
        options.turnTimeoutMs = parseInteger("--turn-timeout-ms", args[++index]);
        break;
      case "--request-timeout-ms":
        options.requestTimeoutMs = parseInteger("--request-timeout-ms", args[++index]);
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${token}`);
    }
  }

  return options;
}

export async function runCli(argv) {
  const command = argv[0] ?? "start";

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command !== "start") {
    throw new Error(`Unknown command: ${command}`);
  }

  const cliOptions = parseCliOptions(argv.slice(1));
  if (cliOptions.help) {
    printHelp();
    return;
  }

  const config = loadConfig(cliOptions);
  const codexClient = new CodexAppServerClient(config, console);

  await codexClient.ensureReady();

  const server = createGatewayServer({
    config,
    codexClient,
    logger: console
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, resolve);
  });

  console.log(`[gateway] listening on http://${config.host}:${config.port}`);
  console.log(`[gateway] codex=${config.codexPath} workdir=${config.workdir}`);
  console.log(
    `[gateway] autoApprove=${config.autoApprove} forceStreamFalse=${config.forceStreamFalse} defaultCodexModel=${config.defaultCodexModel}`
  );

  const shutdown = async () => {
    console.log("[gateway] shutting down");
    server.close();
    await codexClient.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
