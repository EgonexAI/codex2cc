import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";

function messageFromJsonRpcError(error) {
  if (!error) {
    return "Unknown JSON-RPC error";
  }

  if (typeof error === "string") {
    return error;
  }

  if (typeof error.message === "string") {
    return error.message;
  }

  return JSON.stringify(error);
}

function defaultToolAnswer(question) {
  if (Array.isArray(question.options) && question.options.length > 0) {
    return { answers: [question.options[0].label] };
  }

  return { answers: [question.isOther ? "other" : "yes"] };
}

function makeServerRequestUnsupportedError(method) {
  return {
    code: -32000,
    message: `Unsupported server request method: ${method}`
  };
}

function hasPathSeparator(command) {
  return command.includes("/") || command.includes("\\");
}

function isRunnableFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function resolveWindowsCodexCommand(command, env = process.env) {
  const pathEntries = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const hasExt = /\.[^\\/]+$/.test(command);
  const suffixes = hasExt ? [""] : [".exe", ".cmd", ".bat"];
  const basePaths = hasPathSeparator(command) ? [command] : pathEntries.map((entry) => path.join(entry, command));

  for (const basePath of basePaths) {
    for (const suffix of suffixes) {
      const candidate = `${basePath}${suffix}`;
      if (isRunnableFile(candidate)) {
        return candidate;
      }
    }
  }

  return command;
}

export class CodexAppServerClient {
  constructor(config, logger = console) {
    this.config = config;
    this.logger = logger;

    this.child = null;
    this.readline = null;
    this.pendingRequests = new Map();
    this.requestCounter = 1;
    this.notificationListeners = new Set();

    this.threadId = null;
    this.turnQueue = Promise.resolve();

    this.startPromise = null;
    this._startReject = null;
    this.isStopping = false;
  }

  async ensureReady() {
    if (this.threadId && this.child && !this.child.killed) {
      return;
    }

    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = new Promise((resolve, reject) => {
      this._startReject = reject;
      this.#startInternal().then(resolve, reject);
    });
    try {
      await this.startPromise;
    } finally {
      this._startReject = null;
      this.startPromise = null;
    }
  }

  async stop() {
    this.isStopping = true;

    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error("Codex client is shutting down."));
    }
    this.pendingRequests.clear();

    if (this.readline) {
      this.readline.close();
      this.readline = null;
    }

    if (this.child && !this.child.killed) {
      this.child.kill("SIGTERM");
    }

    this.child = null;
    this.threadId = null;
  }

  async queueTurn(inputText, timeoutMs, model) {
    const task = () => this.#runTurn(inputText, timeoutMs, model);
    const result = this.turnQueue.then(task, task);
    this.turnQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  onNotification(listener) {
    this.notificationListeners.add(listener);
    return () => {
      this.notificationListeners.delete(listener);
    };
  }

  async #startInternal() {
    if (this.isStopping) {
      throw new Error("Codex client is stopping.");
    }

    this.#spawnProcess();

    await this.#sendRequest("initialize", {
      clientInfo: {
        name: "codex-gateway",
        version: "0.1.0"
      },
      capabilities: null
    });

    this.#sendNotification("initialized");

    const threadStartResponse = await this.#sendRequest("thread/start", {
      cwd: this.config.workdir,
      approvalPolicy: this.config.autoApprove ? "never" : "on-request",
      sandbox: this.config.sandboxMode,
      experimentalRawEvents: false,
      persistExtendedHistory: false
    });

    this.threadId = threadStartResponse?.thread?.id;
    if (!this.threadId) {
      throw new Error("thread/start did not return a thread id.");
    }

    this.logger.info(`[codex] ready thread=${this.threadId}`);
  }

  #spawnProcess() {
    if (this.child && !this.child.killed) {
      return;
    }

    const rawCommand = this.config.codexPath;
    const command = process.platform === "win32" ? resolveWindowsCodexCommand(rawCommand) : rawCommand;
    const useShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(command);

    const child = spawn(command, ["app-server", "--listen", "stdio://"], {
      cwd: this.config.workdir,
      env: process.env,
      shell: useShell,
      stdio: ["pipe", "pipe", "pipe"]
    });

    this.child = child;

    this.readline = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity
    });

    this.readline.on("line", (line) => {
      this.#handleLine(line);
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8").trim();
      if (!text) {
        return;
      }
      this.logger.warn(`[codex stderr] ${text}`);
    });

    child.on("error", (error) => {
      const hint =
        error.code === "ENOENT"
          ? ` Codex CLI not found at "${rawCommand}". Install Codex or set CODEX_PATH to the full path of the codex executable.`
          : "";
      this.logger.error(`[codex] process error: ${error.message}${hint}`);
      if (this._startReject) {
        this._startReject(error);
        this._startReject = null;
      }
    });

    child.on("exit", (code, signal) => {
      this.logger.warn(`[codex] exited code=${code ?? "null"} signal=${signal ?? "null"}`);
      this.threadId = null;

      for (const pending of this.pendingRequests.values()) {
        clearTimeout(pending.timeoutId);
        pending.reject(new Error("Codex app-server exited."));
      }
      this.pendingRequests.clear();

      this.child = null;

      if (this.isStopping || !this.config.autoRestart) {
        return;
      }

      setTimeout(() => {
        this.ensureReady().catch((error) => {
          this.logger.error(`[codex] restart failed: ${error.message}`);
        });
      }, this.config.restartDelayMs);
    });
  }

  #handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      this.logger.warn(`[codex] non-json line: ${trimmed}`);
      this.#resetSession("json_parse_failure");
      return;
    }

    const hasId = Object.prototype.hasOwnProperty.call(message, "id");
    const hasMethod = typeof message.method === "string";
    const hasResult = Object.prototype.hasOwnProperty.call(message, "result");
    const hasError = Object.prototype.hasOwnProperty.call(message, "error");

    if (hasId && hasMethod && !hasResult && !hasError) {
      this.#handleServerRequest(message);
      return;
    }

    if (hasId && (hasResult || hasError) && !hasMethod) {
      this.#handleResponse(message);
      return;
    }

    if (hasMethod) {
      this.#emitNotification(message);
      return;
    }

    this.logger.warn(`[codex] ignored message: ${trimmed}`);
  }

  #resetSession(reason) {
    this.logger.warn(`[codex] resetting session due to ${reason}`);
    this.threadId = null;

    if (this.child && !this.child.killed) {
      this.child.kill("SIGTERM");
    }
  }

  #handleResponse(message) {
    const pending = this.pendingRequests.get(message.id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeoutId);
    this.pendingRequests.delete(message.id);

    if (Object.prototype.hasOwnProperty.call(message, "error")) {
      pending.reject(new Error(messageFromJsonRpcError(message.error)));
      return;
    }

    pending.resolve(message.result);
  }

  #emitNotification(message) {
    for (const listener of this.notificationListeners) {
      try {
        listener(message);
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        this.logger.warn(`[codex] notification listener error: ${text}`);
      }
    }
  }

  #handleServerRequest(message) {
    const { id, method, params } = message;

    try {
      const result = this.#buildServerRequestResult(method, params);
      this.#writeMessage({ jsonrpc: "2.0", id, result });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[codex] failed to handle server request ${method}: ${text}`);
      this.#writeMessage({ jsonrpc: "2.0", id, error: makeServerRequestUnsupportedError(method) });
    }
  }

  #buildServerRequestResult(method, params) {
    switch (method) {
      case "item/commandExecution/requestApproval":
        return { decision: "accept" };
      case "item/fileChange/requestApproval":
        return { decision: "accept" };
      case "execCommandApproval":
        return { decision: "approved" };
      case "applyPatchApproval":
        return { decision: "approved" };
      case "item/tool/requestUserInput": {
        const answers = {};
        for (const question of params?.questions ?? []) {
          answers[question.id] = defaultToolAnswer(question);
        }
        return { answers };
      }
      case "item/tool/call":
        return {
          success: false,
          contentItems: [
            {
              type: "inputText",
              text: "Dynamic tool calls are not supported by this gateway."
            }
          ]
        };
      default:
        throw new Error(`Unsupported server request: ${method}`);
    }
  }

  #writeMessage(message) {
    if (!this.child || this.child.killed || !this.child.stdin.writable) {
      throw new Error("Codex app-server stdin is not writable.");
    }

    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #sendNotification(method, params) {
    const payload = {
      jsonrpc: "2.0",
      method
    };

    if (params !== undefined) {
      payload.params = params;
    }

    this.#writeMessage(payload);
  }

  #sendRequest(method, params) {
    if (!this.child || this.child.killed) {
      throw new Error("Codex process is not running.");
    }

    const id = this.requestCounter++;
    const payload = {
      jsonrpc: "2.0",
      id,
      method,
      params
    };

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Codex request timed out for method ${method}.`));
      }, this.config.requestTimeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timeoutId });

      try {
        this.#writeMessage(payload);
      } catch (error) {
        clearTimeout(timeoutId);
        this.pendingRequests.delete(id);
        reject(error);
      }
    });
  }

  async #runTurn(inputText, timeoutMs, model) {
    await this.ensureReady();

    if (!this.threadId) {
      throw new Error("No active thread id.");
    }

    const threadId = this.threadId;
    const turnWaiter = this.#createTurnWaiter(threadId, timeoutMs);

    let turnStartResponse;
    try {
      const turnStartParams = {
        threadId,
        input: [
          {
            type: "text",
            text: inputText,
            text_elements: []
          }
        ]
      };

      if (typeof model === "string" && model.trim()) {
        turnStartParams.model = model.trim();
      }

      turnStartResponse = await this.#sendRequest("turn/start", turnStartParams);

      const turnId = turnStartResponse?.turn?.id;
      if (turnId) {
        turnWaiter.setTurnId(turnId);
      }

      return await turnWaiter.promise;
    } finally {
      turnWaiter.dispose();
    }
  }

  #createTurnWaiter(threadId, timeoutMs) {
    let turnId = null;
    let latestAgentMessage = "";
    let aggregatedAgentDeltas = "";
    let usage = null;
    let settled = false;

    let resolvePromise;
    let rejectPromise;

    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });

    const finish = (handler) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      off();
      handler();
    };

    const notificationHandler = (message) => {
      const method = message.method;
      const params = message.params ?? {};

      if (method === "item/agentMessage/delta" && params.threadId === threadId) {
        if (!turnId || params.turnId === turnId) {
          if (!turnId && params.turnId) {
            turnId = params.turnId;
          }
          aggregatedAgentDeltas += typeof params.delta === "string" ? params.delta : "";
        }
        return;
      }

      if (method === "item/completed" && params.threadId === threadId) {
        if (!turnId || params.turnId === turnId) {
          if (!turnId && params.turnId) {
            turnId = params.turnId;
          }

          if (params.item?.type === "agentMessage" && typeof params.item.text === "string") {
            latestAgentMessage = params.item.text;
          }
        }
        return;
      }

      if (method === "thread/tokenUsage/updated" && params.threadId === threadId) {
        if (!turnId || params.turnId === turnId) {
          if (!turnId && params.turnId) {
            turnId = params.turnId;
          }
          usage = {
            inputTokens: params?.tokenUsage?.last?.inputTokens ?? 0,
            outputTokens: params?.tokenUsage?.last?.outputTokens ?? 0
          };
        }
        return;
      }

      if (method === "error" && params.threadId === threadId) {
        if (!turnId || params.turnId === turnId) {
          if (!turnId && params.turnId) {
            turnId = params.turnId;
          }

          if (!params.willRetry) {
            finish(() => {
              const messageText = params?.error?.message ?? "Turn failed.";
              rejectPromise(new Error(messageText));
            });
          }
        }
        return;
      }

      if (method === "turn/completed" && params.threadId === threadId) {
        if (!turnId || params.turn?.id === turnId) {
          if (!turnId && params.turn?.id) {
            turnId = params.turn.id;
          }

          const status = params?.turn?.status;
          if (status === "completed") {
            finish(() => {
              resolvePromise({
                text: latestAgentMessage || aggregatedAgentDeltas,
                usage
              });
            });
            return;
          }

          finish(() => {
            const details = params?.turn?.error?.message || "turn did not complete";
            rejectPromise(new Error(`Turn ${status ?? "unknown"}: ${details}`));
          });
        }
      }
    };

    const off = this.onNotification(notificationHandler);

    const timeoutId = setTimeout(() => {
      finish(() => {
        rejectPromise(new Error(`Turn timed out after ${timeoutMs}ms.`));
      });
    }, timeoutMs);

    return {
      setTurnId(value) {
        turnId = value;
      },
      promise,
      dispose() {
        if (!settled) {
          clearTimeout(timeoutId);
          off();
          settled = true;
        }
      }
    };
  }
}
