/**
 * The CLI's error surface. One class per thing the caller can do about it, so
 * the exit code answers "was that my fault or the machine's?" without anyone
 * having to read the message:
 *
 *   2 — bad input: a typo, a missing argument, an id that does not exist
 *   3 — environment: storage, the registry lock, a missing terminal
 *
 * Plain `Error` is the fallback and maps to 3 (unexpected, not the caller's
 * fault); code paths that know their error is input throw `CliInputError`
 * explicitly rather than relying on a message match.
 */

export class AppError extends Error {
  /** Machine-readable code, printed as `error: <code>: <message>`. */
  readonly code: string;
  /** Process exit status this error deserves. */
  readonly exitCode: number;

  constructor(message: string, code: string, exitCode: number) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.exitCode = exitCode;
  }
}

/** The caller wrote something the CLI will not guess about. Exit 2. */
export class CliInputError extends AppError {
  constructor(code: string, message: string) {
    super(message, code, 2);
  }
}

/** The caller is fine; the machine is not (store, lock, terminal, network). Exit 3. */
export class EnvironmentError extends AppError {
  constructor(code: string, message: string) {
    super(message, code, 3);
  }
}
