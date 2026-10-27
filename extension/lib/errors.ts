type ErrorInput = {
  /** HTTP-style status exposed at tool boundary. */
  readonly status: number;
  /** Short failure summary safe to expose to caller. */
  readonly message: string;
  /** Concrete reason operator can investigate. */
  readonly why: string;
  /** Concrete recovery action for operator. */
  readonly fix: string;
  /** Optional link to documentation or related resources. */
  readonly link?: string;
  /** Original failure retained for server-side diagnostics. */
  readonly cause?: unknown;
};

/**
 * Create an operator-actionable error for an Eve extension boundary.
 *
 * Status and remediation fields are enumerable own properties so Eve can
 * preserve them when serializing tool failures. Cause remains attached through
 * standard `Error` options for server-side diagnostics.
 *
 * @param input - Safe caller message, HTTP-style status, reason, recovery step,
 *   and optional underlying failure.
 * @returns Error carrying `status`, `why`, and `fix` boundary metadata.
 */
export function createError({
  status,
  message,
  why,
  fix,
  link,
  cause,
}: ErrorInput) {
  const error = Object.assign(new Error(message, { cause }), { status, why, fix });
  if (link !== undefined) {
    Object.assign(error, { link });
  }
  return error;
}
