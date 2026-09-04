import {
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';
import {
  IdempotencyOperationStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { IdempotencyCachedPayload } from './idempotency.types';

/** Validación O(1) antes de tocar la DB (UUID v4, alineado a `SynthesisRequestDto`). */
const IDEMPOTENCY_KEY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type IdempotencyGateResult =
  | { action: 'replay'; statusCode: number; body: unknown }
  | { action: 'proceed' }
  | { action: 'conflict_in_progress' };

@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  constructor(private readonly prisma: PrismaService) {}

  assertKeyFormat(key: string): void {
    if (key.length !== 36 || !IDEMPOTENCY_KEY_PATTERN.test(key)) {
      throw new BadRequestException('Invalid idempotencyKey format');
    }
  }

  /**
   * Una sola lectura indexada por `key` (unique): solo status + payload cacheado.
   */
  private async loadByKey(key: string): Promise<{
    status: IdempotencyOperationStatus;
    responsePayload: Prisma.JsonValue | null;
  } | null> {
    return this.prisma.idempotencyOperation.findUnique({
      where: { key },
      select: { status: true, responsePayload: true },
    });
  }

  private parseCachedPayload(
    raw: Prisma.JsonValue | null,
  ): IdempotencyCachedPayload | null {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return null;
    }
    const o = raw as Record<string, unknown>;
    const statusCode = o.statusCode;
    if (typeof statusCode !== 'number') {
      return null;
    }
    return { statusCode, body: o.body };
  }

  /**
   * Crea fila PENDING o devuelve replay / conflicto si la clave ya existe.
   */
  async claimOrReplay(key: string): Promise<IdempotencyGateResult> {
    this.assertKeyFormat(key);

    const existing = await this.loadByKey(key);
    const fromExisting = this.interpretExisting(existing);
    if (fromExisting) {
      return fromExisting;
    }

    try {
      await this.prisma.idempotencyOperation.create({
        data: {
          key,
          status: IdempotencyOperationStatus.PENDING,
        },
        select: { id: true },
      });
      return { action: 'proceed' };
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        const raced = await this.loadByKey(key);
        const again = this.interpretExisting(raced);
        if (again) {
          return again;
        }
        return { action: 'conflict_in_progress' };
      }
      throw e;
    }
  }

  private interpretExisting(
    row: {
      status: IdempotencyOperationStatus;
      responsePayload: Prisma.JsonValue | null;
    } | null,
  ): IdempotencyGateResult | null {
    if (!row) {
      return null;
    }
    if (row.status === IdempotencyOperationStatus.PENDING) {
      return { action: 'conflict_in_progress' };
    }
    if (
      row.status === IdempotencyOperationStatus.COMPLETED ||
      row.status === IdempotencyOperationStatus.FAILED
    ) {
      const parsed = this.parseCachedPayload(row.responsePayload);
      if (!parsed) {
        this.logger.warn(
          `Idempotency row has terminal status ${row.status} but missing/invalid responsePayload`,
        );
        return { action: 'conflict_in_progress' };
      }
      return {
        action: 'replay',
        statusCode: parsed.statusCode,
        body: parsed.body,
      };
    }
    return null;
  }

  async markCompleted(
    key: string,
    payload: IdempotencyCachedPayload,
  ): Promise<void> {
    await this.prisma.idempotencyOperation.update({
      where: { key },
      data: {
        status: IdempotencyOperationStatus.COMPLETED,
        responsePayload: payload as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
  }

  async markFailed(
    key: string,
    payload: IdempotencyCachedPayload,
  ): Promise<void> {
    try {
      await this.prisma.idempotencyOperation.update({
        where: { key },
        data: {
          status: IdempotencyOperationStatus.FAILED,
          responsePayload: payload as unknown as Prisma.InputJsonValue,
        },
        select: { id: true },
      });
    } catch (e) {
      this.logger.error(
        `Failed to persist idempotency FAILED for key ${key}`,
        e instanceof Error ? e.stack : undefined,
      );
      throw e;
    }
  }
}
