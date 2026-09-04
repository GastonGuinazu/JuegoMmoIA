import { IsUUID } from 'class-validator';

export class InventoryUnequipRequestDto {
  @IsUUID('4')
  itemId!: string;

  @IsUUID('4')
  idempotencyKey!: string;
}
