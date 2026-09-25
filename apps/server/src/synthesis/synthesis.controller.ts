import {
  Body,
  ConflictException,
  Controller,
  Headers,
  HttpCode,
  HttpException,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  parseCharacterIdHeader,
  toIdempotencyFailurePayload,
} from '../idempotency/idempotency-http.util';
import { IdempotencyService } from '../idempotency/idempotency.service';
import type { IdempotencyCachedPayload } from '../idempotency/idempotency.types';
import { SynthesisRequestDto } from './dto/synthesis-request.dto';
import type { SynthesisResponseDto } from './dto/synthesis-response.dto';
import { mapSynthesisResultToResponse } from './synthesis-response.mapper';
import { SynthesisService } from './synthesis.service';

@Controller('synthesis')
export class SynthesisController {
  constructor(
    private readonly synthesisService: SynthesisService,
    private readonly idempotencyService: IdempotencyService,
  ) {}

  @Post()
  @HttpCode(200)
  async post(
    @Headers('x-character-id') characterIdHeader: string | undefined,
    @Body() dto: SynthesisRequestDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SynthesisResponseDto | unknown> {
    const characterId = parseCharacterIdHeader(characterIdHeader);

    const gate = await this.idempotencyService.claimOrReplay(dto.idempotencyKey);

    if (gate.action === 'replay') {
      res.status(gate.statusCode);
      return gate.body;
    }

    if (gate.action === 'conflict_in_progress') {
      throw new ConflictException({
        code: 'SYNTHESIS_IDEMPOTENCY_PENDING',
        message:
          'A synthesis attempt with this idempotency key is already in progress or stalled in PENDING',
      });
    }

    try {
      const result = await this.synthesisService.performSynthesis(
        characterId,
        dto.mainItemId,
        dto.sacrificeItemId,
      );
      const body = mapSynthesisResultToResponse(result);
      await this.idempotencyService.markCompleted(dto.idempotencyKey, {
        statusCode: 200,
        body,
      });
      return body;
    } catch (e) {
      const failure = toIdempotencyFailurePayload(e);
      await this.idempotencyService.markFailed(dto.idempotencyKey, failure);
      throw new HttpException(
        failure.body as string | Record<string, unknown>,
        failure.statusCode,
      );
    }
  }
}
