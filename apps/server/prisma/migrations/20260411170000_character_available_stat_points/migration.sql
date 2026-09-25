-- Dark Knight progression v1: pending allocable stat points
ALTER TABLE "Character"
ADD COLUMN "availableStatPoints" INTEGER NOT NULL DEFAULT 0;
