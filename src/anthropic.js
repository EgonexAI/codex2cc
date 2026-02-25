import { randomUUID } from "node:crypto";
import { HttpError } from "./errors.js";

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeText(value) {
  if (typeof value === "string") {
    return value;
  }
  return "";
}

function normalizeModelId(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().toLowerCase().replace(/[_\s]+/g, "-");
}

function parseRequestedModel(rawModel) {
  if (typeof rawModel !== "string") {
    return null;
  }

  const trimmed = rawModel.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveCodexModel(requestedModel, defaultCodexModel) {
  const normalized = normalizeModelId(requestedModel);

  if (!normalized) {
    return defaultCodexModel;
  }

  if (
    normalized.includes("gpt-5.3-codex") ||
    normalized.includes("gpt5.3-codex") ||
    normalized === "gpt-5.3"
  ) {
    return "gpt-5.3-codex";
  }

  if (normalized.includes("gpt-5.2") || normalized.includes("gpt5.2")) {
    return "gpt-5.2";
  }

  if (normalized.includes("opus")) {
    return "gpt-5.3-codex";
  }

  if (normalized.includes("sonnet") || normalized.includes("haiku")) {
    return "gpt-5.2";
  }

  if (normalized === "codex" || normalized === "codex-backend") {
    return defaultCodexModel;
  }

  return defaultCodexModel;
}

function contentBlockToText(block) {
  if (!isRecord(block)) {
    return "";
  }

  if (block.type === "text" && typeof block.text === "string") {
    return block.text;
  }

  if (block.type === "tool_result") {
    return extractTextContent(block.content);
  }

  return "";
}

export function extractTextContent(content) {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    const parts = content.map((part) => contentBlockToText(part)).filter((part) => part.length > 0);
    return parts.join("\n");
  }

  return "";
}

function normalizeSystem(system) {
  if (system === undefined || system === null) {
    return "";
  }

  return extractTextContent(system);
}

function estimateTokensFromText(text) {
  if (!text) {
    return 0;
  }

  // A lightweight heuristic close enough for client-side planning flows.
  return Math.max(1, Math.ceil(text.length / 4));
}

function toAnthropicUsage(usage) {
  return {
    input_tokens: usage?.inputTokens ?? 0,
    output_tokens: usage?.outputTokens ?? 0
  };
}

export function validateAnthropicRequest(payload, options = {}) {
  if (!isRecord(payload)) {
    throw new HttpError(400, "Request body must be a JSON object.");
  }

  const forceStreamFalse = options.forceStreamFalse === true;
  const defaultCodexModel =
    typeof options.defaultCodexModel === "string" && options.defaultCodexModel.trim()
      ? options.defaultCodexModel.trim()
      : "gpt-5.2";

  const stream = payload.stream === true;
  if (stream && !forceStreamFalse) {
    throw new HttpError(400, "Streaming not supported. Use stream=false.");
  }

  if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
    throw new HttpError(400, "messages must be a non-empty array.");
  }

  const messages = payload.messages.map((rawMessage, index) => {
    if (!isRecord(rawMessage)) {
      throw new HttpError(400, `messages[${index}] must be an object.`);
    }

    const role = normalizeText(rawMessage.role).trim();
    if (!role) {
      throw new HttpError(400, `messages[${index}].role is required.`);
    }

    const text = extractTextContent(rawMessage.content);
    return { role, text };
  });

  const latestUserMessage = [...messages].reverse().find((message) => message.role === "user");
  if (!latestUserMessage) {
    throw new HttpError(400, "At least one user message is required.");
  }

  const requestedModel = parseRequestedModel(payload.model);
  const codexModel = resolveCodexModel(requestedModel, defaultCodexModel);

  return {
    requestedModel,
    codexModel,
    responseModel: requestedModel ?? "codex-backend",
    maxTokens: Number.isFinite(payload.max_tokens) ? payload.max_tokens : null,
    stream,
    system: normalizeSystem(payload.system),
    messages,
    latestUserMessage
  };
}

export function buildTurnInput(validated) {
  const lines = [];

  if (validated.system.trim()) {
    lines.push("System instructions:");
    lines.push(validated.system.trim());
    lines.push("");
  }

  lines.push("Conversation transcript (Anthropic messages):");
  for (const message of validated.messages) {
    lines.push(`${message.role.toUpperCase()}:`);
    lines.push(message.text || "[empty]");
    lines.push("");
  }

  lines.push("Latest user request:");
  lines.push(validated.latestUserMessage.text || "[empty]");

  return lines.join("\n").trim();
}

export function buildAnthropicSuccessResponse(text, usage, model = "codex-backend") {
  return {
    id: `msg_${randomUUID().replace(/-/g, "")}`,
    type: "message",
    role: "assistant",
    content: [
      {
        type: "text",
        text
      }
    ],
    model,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: toAnthropicUsage(usage)
  };
}

export function buildAnthropicErrorResponse(type, message) {
  return {
    type: "error",
    error: {
      type,
      message
    }
  };
}

export function countAnthropicInputTokens(payload) {
  if (!isRecord(payload)) {
    return 0;
  }

  let total = 0;
  total += estimateTokensFromText(normalizeSystem(payload.system));

  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  for (const message of messages) {
    if (!isRecord(message)) {
      continue;
    }

    total += estimateTokensFromText(extractTextContent(message.content));
  }

  return total;
}

export function buildAnthropicModelsResponse(defaultCodexModel = "gpt-5.2") {
  const createdAt = "2026-01-01T00:00:00Z";
  const models = [
    {
      type: "model",
      id: "claude-3-opus",
      display_name: "claude-3-opus -> gpt-5.3-codex",
      created_at: createdAt
    },
    {
      type: "model",
      id: "claude-3-7-sonnet-latest",
      display_name: "claude-3-7-sonnet-latest -> gpt-5.2",
      created_at: createdAt
    },
    {
      type: "model",
      id: "claude-3-5-haiku-latest",
      display_name: "claude-3-5-haiku-latest -> gpt-5.2",
      created_at: createdAt
    },
    {
      type: "model",
      id: "gpt-5.3-codex",
      display_name: "gpt-5.3-codex",
      created_at: createdAt
    },
    {
      type: "model",
      id: "gpt-5.2",
      display_name: "gpt-5.2",
      created_at: createdAt
    },
    {
      type: "model",
      id: "codex",
      display_name: `codex -> ${defaultCodexModel}`,
      created_at: createdAt
    },
    {
      type: "model",
      id: "codex-backend",
      display_name: `codex-backend -> ${defaultCodexModel}`,
      created_at: createdAt
    }
  ];

  return {
    data: models,
    first_id: models[0].id,
    has_more: false,
    last_id: models[models.length - 1].id
  };
}
