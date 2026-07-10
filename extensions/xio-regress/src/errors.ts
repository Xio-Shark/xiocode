export class InvalidRegressionCaseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InvalidRegressionCaseError";
  }
}

export function invalidRegressionCase(error: unknown): InvalidRegressionCaseError {
  if (error instanceof InvalidRegressionCaseError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new InvalidRegressionCaseError(message, error instanceof Error ? { cause: error } : undefined);
}
