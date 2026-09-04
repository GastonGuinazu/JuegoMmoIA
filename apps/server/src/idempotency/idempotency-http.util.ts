import { BadRequestException, HttpException } from '@nestjs/common';
import type { IdempotencyCachedPayload } from './idempotency.types';

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseCharacterIdHeader(raw: string | undefined): string {
  const v = raw?.trim();
  if (!v || v.length !== 36 || !UUID_V4_PATTERN.test(v)) {
    throw new BadRequestException(
      'Missing or invalid x-character-id header (UUID v4)',
    );
  }
  return v;
}

export function toIdempotencyFailurePayload(
  error: unknown,
): IdempotencyCachedPayload {
  if (error instanceof HttpException) {
    const statusCode = error.getStatus();
    const res = error.getResponse();
    const body =
      typeof res === 'string'
        ? { statusCode, message: res }
        : {
            statusCode,
            ...(typeof res === 'object' && res !== null ? res : {}),
          };
    return { statusCode, body };
  }
  return {
    statusCode: 500,
    body: {
      statusCode: 500,
      message: 'Internal server error',
    },
  };
}
