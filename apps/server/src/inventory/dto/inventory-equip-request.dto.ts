import { IsOptional, IsString, IsUUID, ValidateIf } from 'class-validator';

export class InventoryEquipRequestDto {
  @IsUUID('4')
  itemId!: string;

  @ValidateIf((o) => typeof o.slot === 'string')
  @IsString()
  slot!: string | number;

  @IsOptional()
  @IsUUID('4')
  parentItemId?: string;

  @IsUUID('4')
  idempotencyKey!: string;
}
