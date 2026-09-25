import { IsUUID } from 'class-validator';

/** Cuerpo POST /synthesis (personaje vía header `x-character-id`). */
export class SynthesisRequestDto {
  @IsUUID('4')
  mainItemId!: string;

  @IsUUID('4')
  sacrificeItemId!: string;

  @IsUUID('4')
  idempotencyKey!: string;
}
