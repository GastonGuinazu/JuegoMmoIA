/**
 * Envelope guardado en `IdempotencyOperation.responsePayload` para replays idempotentes.
 */
export interface IdempotencyCachedPayload {
  statusCode: number;
  body: unknown;
}
