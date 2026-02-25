export class HttpError extends Error {
  constructor(statusCode, message, type = "invalid_request_error") {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.type = type;
  }
}
