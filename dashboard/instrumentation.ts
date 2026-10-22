const MIN_SECRET_LENGTH = 16;

export async function register() {
  if (
    process.env.NODE_ENV === 'production' &&
    process.env.NEXT_PHASE !== 'phase-production-build'
  ) {
    const configured = process.env.JWT_SECRET_KEY?.trim() || '';
    if (configured.length < MIN_SECRET_LENGTH) {
      throw new Error(
        `FATAL: JWT_SECRET_KEY must be set to at least ${MIN_SECRET_LENGTH} characters in production.`,
      );
    }
  }
}
