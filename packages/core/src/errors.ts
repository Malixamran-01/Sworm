/** Errors the API turns into RFC 9457 problem details (SRS 8.5). */
export class ConclaveError extends Error {
  readonly status: number;
  readonly title: string;
  readonly detail: string | undefined;
  readonly errors: string[] | undefined;

  constructor(status: number, title: string, detail?: string, errors?: string[]) {
    super(detail ? `${title}: ${detail}` : title);
    this.name = "ConclaveError";
    this.status = status;
    this.title = title;
    this.detail = detail;
    this.errors = errors;
  }
}

export const notFound = (what: string) => new ConclaveError(404, `${what} not found`);
export const invalid = (errors: string[], title = "The request is not valid") => new ConclaveError(422, title, errors.join(" "), errors);
export const conflict = (detail: string) => new ConclaveError(409, "Conflict", detail);
export const budgetBlocked = (detail: string) => new ConclaveError(402, "Budget reached", detail);

/** Who is acting. Every query is scoped to the actor's org (SRS 8.7). */
export interface Actor {
  orgId: string;
  userId: string;
}
