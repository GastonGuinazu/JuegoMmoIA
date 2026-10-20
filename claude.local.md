# Pendientes

Notas locales de trabajo (no documentación del proyecto). Lista de tareas pendientes a resolver.

- [ ] **Hotbar recortado**: las habilidades se ven "cortadas" por el recuadro que las encierra, tanto en el Dark Knight como en el Dark Wizard. Revisar CSS del slot del action bar (`game-viewport.component.scss` / template).

- [ ] **Stun en PvP**: hoy `frostbind` solo stunea mobs (PvE). Falta la versión PvP — frenar movimiento y casts del jugador stuneado en el servidor (mencionado como trabajo más grande al implementar el stun de mobs, ver conversación sobre `isMobStunned`).

- [ ] **Panel de Controles (Esc) no es por clase**: hoy `control-hints.ts` siempre muestra los nombres de habilidades del Dark Wizard (Fireball/Frostbind), sin importar la clase conectada. Verificar que pase lo mismo con Dark Knight y Fairy Elf. Cada clase debería ver sus propias habilidades ahí. Evaluar si conviene hacerlo dinámico por clase (como ya es el hotbar) en vez de la lista estática actual.

- [ ] **Costo de maná de las skills del mago**: revisar que Fireball/Frostbind no se puedan spamear sin consecuencia — validar que el consumo de MP realmente limite el ritmo de casteo (cooldown + maná juntos, no solo cooldown).

- [ ] **Skin del mago**: el Dark Wizard todavía se ve en el mundo con el modelo del Dark Knight (lizard_man_warrior). Falta aplicar el modelo/skin propio del mago al personaje jugable in-game (hoy la sorceress solo está wireada en la pantalla de login, no en `EntityVisualFactoryService`).

- [ ] **Bug: dash durante chase con target para castear skill**: a veces, cuando el mago targetea un mob y lo persigue (chase) para tirarle una habilidad, y en el medio se usa el dash, se produce un bug. Reproducir y diagnosticar.

- [ ] **Bug: Fireball a veces no sale**: a veces al tirar Fireball se ve la animación de cast pero pareciera que la skill no se dispara de verdad (¿se pierde el request, rechazo silencioso, o problema de cooldown/target stale?). Reproducir y revisar logs de servidor en el momento exacto.

- [ ] **Falta `derivedMDef` (defensa mágica) en `Character`**: el schema de Prisma tiene `derivedPAtk`/`derivedMAtk`/`derivedPDef` pero no `derivedMDef`. PvE funciona porque los mobs sí tienen `mDef` en su template, pero en PvP el daño siempre usa la fórmula física (`combat.service.ts`, `attackCharacter`) sin importar la clase ni la skill — no es algo que se rompió ahora, ya estaba así desde antes de las skills nuevas. Para arreglarlo bien hace falta migración de DB + enchufarlo en `stat-engine.service.ts`. Relacionado con el ítem de "stun en PvP" de arriba (ambos tocan el mismo hueco de PvP vs mago).

- [ ] **Mago no pega auto-ataques básicos**: parece que el Dark Wizard no está conectando el ataque básico (tecla 1 / auto-ataque). Verificar `attackMob` (PvE) y el equivalente PvP — confirmar si el daño realmente se calcula con `derivedMAtk` para esta clase en ese path específico, o si el ataque básico quedó atado a una fórmula/validación que asume melee físico y nunca conecta para el wizard.

- [ ] **Nombres de clase inconsistentes entre el fondo del login y el combo de registro**: el fondo de `/login` muestra 3 héroes rotulados "Dark Knight", "Dark Wizard" y "Witch Doctor" (`HERO_SLOTS` en `login-page.component.ts`), pero el `<select>` de clase en el formulario de registro ofrece otros nombres (`CLASS_OPTIONS`: Dark Knight / Dark Wizard / Fairy Elf). "Witch Doctor" no es una clase real del juego — alinear las etiquetas (o aclarar que el tercer héroe del fondo es solo decorativo/no jugable todavía).
