// One error type for every failed API call, shaped like the contract's
// { error: { code, message } } body plus the HTTP status.
export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}
