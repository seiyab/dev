export function createTerminalState() {
  return {
    controllers: new Map<string, () => void>(),
    deleting: new Set<string>(),
    deletingSession: false,
  };
}
