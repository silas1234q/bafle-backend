-- A scheduled draw time, rather than drawing the instant the pool sells out.
--
-- The draw used to run inline in the payment confirmation, which meant the
-- last buyer's webhook decided the winner before anyone could be told the
-- draw was about to happen. `drawAt` is set to DRAW_DELAY_MS after the
-- sellout and the draw becomes a scheduled job.
--
-- Nullable because it only exists once a raffle sells out. Existing rows keep
-- NULL: the raffles already DRAWN have their result, and the OPEN ones get a
-- drawAt when they sell out.

-- AlterTable
ALTER TABLE "Raffle" ADD COLUMN "drawAt" TIMESTAMP(3);

-- The sweep that catches a draw whose job was lost: SOLD_OUT raffles whose
-- scheduled time has arrived. Partial, because every other raffle state is
-- irrelevant to it.
CREATE INDEX "Raffle_draw_due_idx"
    ON "Raffle" ("drawAt")
    WHERE "status" = 'SOLD_OUT';
