-- Move the unrevealed server seed out of Raffle into its own table.
--
-- Commit-reveal integrity depends on the seed existing before ticket sales
-- and not being readable until the draw. Leaving it on Raffle meant every
-- default Prisma select and every list endpoint was one careless line away
-- from publishing it early, which would let a buyer predict the winner.


-- AlterTable
ALTER TABLE "Raffle" DROP COLUMN "serverSeed";

-- CreateTable
CREATE TABLE "RaffleSeed" (
    "raffleId" TEXT NOT NULL,
    "seed" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RaffleSeed_pkey" PRIMARY KEY ("raffleId")
);

-- AddForeignKey
ALTER TABLE "RaffleSeed" ADD CONSTRAINT "RaffleSeed_raffleId_fkey" FOREIGN KEY ("raffleId") REFERENCES "Raffle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

