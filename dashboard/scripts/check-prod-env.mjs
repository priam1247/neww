const MIN_SECRET_LENGTH = 16;

if (process.env.NODE_ENV !== 'development' && process.env.NODE_ENV !== 'test') {
  const secret = (process.env.JWT_SECRET_KEY || '').trim();
  if (secret.length < MIN_SECRET_LENGTH) {
    console.error(
      `[ZaFar Dashboard] Refusing production start: JWT_SECRET_KEY must be set to at least ${MIN_SECRET_LENGTH} characters.`,
    );
    process.exit(1);
  }
}
