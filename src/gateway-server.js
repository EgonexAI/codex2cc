import http from "node:http";
import {
  buildAnthropicErrorResponse,
  buildAnthropicModelsResponse,
  buildAnthropicSuccessResponse,
  countAnthropicInputTokens,
  buildTurnInput,
  validateAnthropicRequest
} from "./anthropic.js";
import { HttpError } from "./errors.js";

function jsonResponse(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", Buffer.byteLength(body));
  res.end(body);
}

function noContent(res, statusCode = 204) {
  res.statusCode = statusCode;
  res.end();
}

async function readJsonBody(req, maxBytes) {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new HttpError(413, `Request body exceeds ${maxBytes} bytes.`, "request_too_large");
    }
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) {
    throw new HttpError(400, "Request body is empty.");
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, "Request body is not valid JSON.");
  }
}

function mapErrorToAnthropic(error) {
  if (error instanceof HttpError) {
    return {
      status: error.statusCode,
      body: buildAnthropicErrorResponse(error.type, error.message)
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    status: 502,
    body: buildAnthropicErrorResponse("api_error", message)
  };
}

export function createGatewayServer({ config, codexClient, logger = console }) {
  return http.createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const rawUrl = req.url ?? "/";
    const requestUrl = new URL(rawUrl, "http://localhost");
    const pathname = requestUrl.pathname;
    const startedAt = Date.now();
    logger.info(`[gateway] ${method} ${rawUrl}`);

    if (method === "GET" && pathname === "/healthz") {
      jsonResponse(res, 200, {
        status: "ok"
      });
      return;
    }

    if (method === "HEAD" && pathname === "/healthz") {
      noContent(res);
      return;
    }

    if (method === "GET" && pathname === "/v1/models") {
      jsonResponse(res, 200, buildAnthropicModelsResponse(config.defaultCodexModel));
      return;
    }

    if (method === "HEAD" && pathname === "/v1/models") {
      noContent(res);
      return;
    }

    if (method === "POST" && pathname === "/v1/messages/count_tokens") {
      try {
        const payload = await readJsonBody(req, config.maxBodyBytes);
        const inputTokens = countAnthropicInputTokens(payload);
        jsonResponse(res, 200, {
          input_tokens: inputTokens
        });
      } catch (error) {
        const mapped = mapErrorToAnthropic(error);
        jsonResponse(res, mapped.status, mapped.body);
      }
      return;
    }

    if (method !== "POST" || pathname !== "/v1/messages") {
      jsonResponse(res, 404, buildAnthropicErrorResponse("not_found_error", "Not found."));
      return;
    }

    try {
      const payload = await readJsonBody(req, config.maxBodyBytes);
      logger.info(
        `[gateway] /v1/messages stream=${payload?.stream === true} requested_model=${payload?.model ?? "null"}`
      );
      const validated = validateAnthropicRequest(payload, {
        forceStreamFalse: config.forceStreamFalse,
        defaultCodexModel: config.defaultCodexModel
      });

      const turnInput = buildTurnInput(validated);
      logger.info(
        `[gateway] /v1/messages codex_model=${validated.codexModel} response_model=${validated.responseModel}`
      );
      const turnResult = await codexClient.queueTurn(turnInput, config.turnTimeoutMs, validated.codexModel);
      jsonResponse(
        res,
        200,
        buildAnthropicSuccessResponse(turnResult.text, turnResult.usage, validated.responseModel)
      );
      logger.info(`[gateway] /v1/messages status=200 latency_ms=${Date.now() - startedAt}`);
    } catch (error) {
      const mapped = mapErrorToAnthropic(error);
      if (mapped.status >= 500) {
        logger.error(`[gateway] ${mapped.body.error.message}`);
      }
      logger.info(`[gateway] /v1/messages status=${mapped.status} latency_ms=${Date.now() - startedAt}`);
      jsonResponse(res, mapped.status, mapped.body);
    }
  });
}
