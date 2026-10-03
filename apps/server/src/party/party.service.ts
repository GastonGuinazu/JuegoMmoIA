import { Injectable } from '@nestjs/common';
import type { CharacterClass } from '@prisma/client';
import type { WsPartyUpdatePayload } from '@aetheris/shared-types';

/** Grupo máximo: igual al tamaño usual de pack de mobs del Warden (ver `mob-ai-tick`). */
const MAX_PARTY_SIZE = 5;
/** Invitación pendiente: vence sola si nadie la acepta/rechaza en este lapso. */
const INVITE_TTL_MS = 30_000;

export type PartyMemberRecord = {
  characterId: string;
  name: string;
  characterClass: CharacterClass;
};

export type PartyRecord = {
  id: string;
  leaderId: string;
  members: PartyMemberRecord[];
};

type PendingInvite = {
  partyId: string;
  fromCharacterId: string;
  fromName: string;
  expiresAtMs: number;
};

export type PartyActionResult<T> =
  | ({ ok: true } & T)
  | { ok: false; code: string; message: string };

/**
 * The Warden: estado de grupos (Party), 100% RAM. Puramente social en esta
 * iteración — ver vida/maná de aliados, nada de reparto de exp/loot todavía
 * (eso toca `combat.service.ts`/`damage-contribution-tracker` a propósito
 * en una iteración futura, para no arriesgar el cálculo de recompensas).
 * No hay motivo para persistir en DB: un grupo no debe sobrevivir un restart
 * del server, y evitar la tabla es una query menos en el hot path de combate.
 */
@Injectable()
export class PartyService {
  private readonly parties = new Map<string, PartyRecord>();
  private readonly partyIdByCharacter = new Map<string, string>();
  /** Keyed por `targetCharacterId`: solo una invitación pendiente a la vez por destinatario. */
  private readonly pendingInvites = new Map<string, PendingInvite>();
  private nextPartyId = 1;

  getPartyIdForCharacter(characterId: string): string | undefined {
    return this.partyIdByCharacter.get(characterId);
  }

  getParty(partyId: string): PartyRecord | undefined {
    return this.parties.get(partyId);
  }

  isLeader(characterId: string): boolean {
    const partyId = this.partyIdByCharacter.get(characterId);
    if (!partyId) {
      return false;
    }
    return this.parties.get(partyId)?.leaderId === characterId;
  }

  /** Invita a `targetCharacterId`; crea grupo de 1 para el que invita si todavía no tenía. */
  createInvite(params: {
    fromCharacterId: string;
    fromName: string;
    fromClass: CharacterClass;
    targetCharacterId: string;
  }): PartyActionResult<{ partyId: string }> {
    const { fromCharacterId, fromName, fromClass, targetCharacterId } = params;
    if (fromCharacterId === targetCharacterId) {
      return { ok: false, code: 'SELF_INVITE', message: 'No podés invitarte a vos mismo' };
    }
    if (this.partyIdByCharacter.has(targetCharacterId)) {
      return { ok: false, code: 'TARGET_ALREADY_GROUPED', message: 'Ese jugador ya está en un grupo' };
    }
    let partyId = this.partyIdByCharacter.get(fromCharacterId);
    if (partyId) {
      const party = this.parties.get(partyId);
      if (!party || party.leaderId !== fromCharacterId) {
        return { ok: false, code: 'NOT_LEADER', message: 'Solo el líder puede invitar' };
      }
      if (party.members.length >= MAX_PARTY_SIZE) {
        return { ok: false, code: 'PARTY_FULL', message: 'El grupo ya está completo' };
      }
    } else {
      partyId = `party-${this.nextPartyId++}`;
      this.parties.set(partyId, {
        id: partyId,
        leaderId: fromCharacterId,
        members: [{ characterId: fromCharacterId, name: fromName, characterClass: fromClass }],
      });
      this.partyIdByCharacter.set(fromCharacterId, partyId);
    }
    this.pendingInvites.set(targetCharacterId, {
      partyId,
      fromCharacterId,
      fromName,
      expiresAtMs: Date.now() + INVITE_TTL_MS,
    });
    return { ok: true, partyId };
  }

  acceptInvite(params: {
    targetCharacterId: string;
    fromCharacterId: string;
    targetName: string;
    targetClass: CharacterClass;
  }): PartyActionResult<{ partyId: string }> {
    const { targetCharacterId, fromCharacterId, targetName, targetClass } = params;
    const invite = this.pendingInvites.get(targetCharacterId);
    if (!invite || invite.fromCharacterId !== fromCharacterId) {
      return { ok: false, code: 'NO_PENDING_INVITE', message: 'No hay invitación pendiente de ese jugador' };
    }
    this.pendingInvites.delete(targetCharacterId);
    if (Date.now() > invite.expiresAtMs) {
      this.disbandIfLonelyWithNoPendingInvites(invite.partyId);
      return { ok: false, code: 'INVITE_EXPIRED', message: 'La invitación venció' };
    }
    const party = this.parties.get(invite.partyId);
    if (!party) {
      return { ok: false, code: 'PARTY_GONE', message: 'El grupo ya no existe' };
    }
    if (this.partyIdByCharacter.has(targetCharacterId)) {
      return { ok: false, code: 'TARGET_ALREADY_GROUPED', message: 'Ya estás en un grupo' };
    }
    if (party.members.length >= MAX_PARTY_SIZE) {
      return { ok: false, code: 'PARTY_FULL', message: 'El grupo ya está completo' };
    }
    party.members.push({ characterId: targetCharacterId, name: targetName, characterClass: targetClass });
    this.partyIdByCharacter.set(targetCharacterId, party.id);
    return { ok: true, partyId: party.id };
  }

  declineInvite(targetCharacterId: string, fromCharacterId: string): boolean {
    const invite = this.pendingInvites.get(targetCharacterId);
    if (!invite || invite.fromCharacterId !== fromCharacterId) {
      return false;
    }
    this.pendingInvites.delete(targetCharacterId);
    this.disbandIfLonelyWithNoPendingInvites(invite.partyId);
    return true;
  }

  /**
   * `createInvite` crea el grupo de 1 para el que invita ANTES de saber si lo van a
   * aceptar. Si esa única invitación se rechaza o vence sin que nadie más la haya
   * recibido todavía, ese grupo fantasma quedaría en RAM para siempre — y, peor,
   * `createInvite` seguiría viendo a ese jugador como "ya agrupado" y rechazaría
   * cualquier invitación futura de otra persona hacia él. Se llama tras resolver
   * (decline/expire) cualquier invitación, y en el barrido periódico para las que
   * nadie contesta nunca.
   */
  private disbandIfLonelyWithNoPendingInvites(partyId: string): void {
    const party = this.parties.get(partyId);
    if (!party || party.members.length !== 1) {
      return;
    }
    for (const invite of this.pendingInvites.values()) {
      if (invite.partyId === partyId) {
        return;
      }
    }
    this.partyIdByCharacter.delete(party.members[0]!.characterId);
    this.parties.delete(partyId);
  }

  /** Barrido 1Hz (ver `PartyVitalsTickService`): invitaciones que nadie aceptó ni rechazó. */
  sweepExpiredInvites(nowMs: number): void {
    for (const [targetCharacterId, invite] of this.pendingInvites) {
      if (nowMs <= invite.expiresAtMs) {
        continue;
      }
      this.pendingInvites.delete(targetCharacterId);
      this.disbandIfLonelyWithNoPendingInvites(invite.partyId);
    }
  }

  /** Limpieza al desconectar: no dejar una invitación esperando a alguien que ya no está. */
  clearPendingInviteTo(targetCharacterId: string): void {
    const invite = this.pendingInvites.get(targetCharacterId);
    this.pendingInvites.delete(targetCharacterId);
    if (invite) {
      this.disbandIfLonelyWithNoPendingInvites(invite.partyId);
    }
  }

  /**
   * Sale del grupo (uso propio o tras un kick ya aplicado). Si quedan <2 miembros
   * el grupo se disuelve entero (un "grupo" de 1 no tiene sentido). Si se va el
   * líder y queda gente, promueve al miembro más antiguo restante.
   */
  leaveParty(characterId: string): { partyId: string; disbanded: boolean; affectedCharacterIds: string[] } | null {
    const partyId = this.partyIdByCharacter.get(characterId);
    if (!partyId) {
      return null;
    }
    const party = this.parties.get(partyId);
    if (!party) {
      this.partyIdByCharacter.delete(characterId);
      return null;
    }
    const leavingWasLeader = party.leaderId === characterId;
    party.members = party.members.filter((m) => m.characterId !== characterId);
    this.partyIdByCharacter.delete(characterId);

    if (party.members.length <= 1) {
      const affectedCharacterIds = [characterId, ...party.members.map((m) => m.characterId)];
      for (const m of party.members) {
        this.partyIdByCharacter.delete(m.characterId);
      }
      this.parties.delete(partyId);
      return { partyId, disbanded: true, affectedCharacterIds };
    }
    if (leavingWasLeader) {
      party.leaderId = party.members[0]!.characterId;
    }
    return { partyId, disbanded: false, affectedCharacterIds: [characterId] };
  }

  kickMember(
    leaderId: string,
    targetCharacterId: string,
  ): PartyActionResult<{ partyId: string; disbanded: boolean; affectedCharacterIds: string[] }> {
    if (leaderId === targetCharacterId) {
      return { ok: false, code: 'CANNOT_KICK_SELF', message: 'Usá "abandonar grupo" para vos mismo' };
    }
    const partyId = this.partyIdByCharacter.get(leaderId);
    const party = partyId ? this.parties.get(partyId) : undefined;
    if (!party || party.leaderId !== leaderId) {
      return { ok: false, code: 'NOT_LEADER', message: 'Solo el líder puede expulsar' };
    }
    if (!party.members.some((m) => m.characterId === targetCharacterId)) {
      return { ok: false, code: 'NOT_IN_PARTY', message: 'Ese jugador no está en tu grupo' };
    }
    const result = this.leaveParty(targetCharacterId);
    if (!result) {
      return { ok: false, code: 'NOT_IN_PARTY', message: 'Ese jugador no está en tu grupo' };
    }
    return { ok: true, ...result };
  }

  /**
   * Construye el payload de `party-update` combinando el estado puro del grupo
   * con datos externos (conexión/vitals) que `PartyService` no conoce — lo arma
   * el caller con un callback para no acoplar este servicio a `WorldPresenceService`
   * ni a `PlayerCombatRuntimeService`.
   */
  buildUpdatePayload(
    partyId: string,
    enrich: (characterId: string) => {
      online: boolean;
      currentHp: number;
      maxHp: number;
      currentMp: number;
      maxMp: number;
    },
  ): WsPartyUpdatePayload {
    const party = this.parties.get(partyId);
    if (!party) {
      return null;
    }
    return {
      partyId: party.id,
      members: party.members.map((m) => ({
        characterId: m.characterId,
        name: m.name,
        characterClass: m.characterClass,
        isLeader: m.characterId === party.leaderId,
        ...enrich(m.characterId),
      })),
    };
  }

  /** Snapshot de todos los grupos activos (para el tick periódico de vitals). */
  allPartyIds(): readonly string[] {
    return [...this.parties.keys()];
  }
}
