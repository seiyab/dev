export const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;
export const isOid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{40}$/.test(value) &&
  !/^0+$/.test(value);
export const isRepositoryId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\/[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(value) &&
  value.length <= 200;
export interface RemoteRef {
  name: string;
  oid: string;
}
export interface PushRequest {
  ref: string;
  expectedOid: string | null;
  newOid: string;
  bundle: string;
  dryRun: boolean;
}
export class BrokerError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 401 | 403 | 409 | 413 | 502 = 400,
  ) {
    super(message);
  }
}
