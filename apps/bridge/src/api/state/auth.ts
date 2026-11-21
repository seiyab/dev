export function createAuthState(accessKey: string) {
  return {
    accessKey,
    sessions: new Map<string, number>(),
    sessionTtl: 12 * 60 * 60 * 1000,
    loginAttempts: [] as number[],
  };
}
