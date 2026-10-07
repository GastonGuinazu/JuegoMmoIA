/**
 * Contrato HTTP Auth (Weaver ↔ Warden): login/registro simple por cuenta.
 */

export type AuthCharacterClass = 'DARK_KNIGHT' | 'DARK_WIZARD' | 'FAIRY_ELF';

export type AuthCharacterSummaryDto = {
  id: string;
  name: string;
  level: number;
  characterClass: AuthCharacterClass;
};

export type RegisterRequestDto = {
  username: string;
  password: string;
  characterName: string;
  characterClass: AuthCharacterClass;
};

export type LoginRequestDto = {
  username: string;
  password: string;
};

export type AuthResponseDto = {
  accountId: string;
  characters: AuthCharacterSummaryDto[];
};
