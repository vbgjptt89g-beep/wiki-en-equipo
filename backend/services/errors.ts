export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const badRequest = (message: string, details?: unknown) => new HttpError(400, "BAD_REQUEST", message, details);
export const unauthorized = (message = "Debes iniciar sesión.") => new HttpError(401, "UNAUTHORIZED", message);
export const forbidden = (message = "No tienes permiso para realizar esta acción.") => new HttpError(403, "FORBIDDEN", message);
export const notFound = (message = "No se encontró el recurso solicitado.") => new HttpError(404, "NOT_FOUND", message);
export const conflict = (message: string, details?: unknown) => new HttpError(409, "CONFLICT", message, details);
