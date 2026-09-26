export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (msg, details) => new HttpError(400, msg, details);
export const notFound = (msg = 'Audit entry not found') => new HttpError(404, msg);
export const conflict = (msg, details) => new HttpError(409, msg, details);
export const unprocessable = (msg, details) => new HttpError(422, msg, details);
