-- Remove the commit-reveal draw proof.
--
-- The platform now selects the winner itself, so none of the published proof
-- material has a reader: no commitment is announced before sales, no seed is
-- revealed afterwards, and there is no derivation for a third party to replay.
-- Dropping the columns rather than leaving them nullable is deliberate — a
-- half-populated seed column invites code that treats a missing seed as a
-- failure, which is exactly what this change removes.
--
-- Destructive for rows that already carry proof material. Existing Draw rows
-- keep their winner, ticket count and timestamp; only the seed, commitment and
-- digest input are lost, and those are meaningless once nothing verifies them.

-- DropForeignKey
ALTER TABLE "RaffleSeed" DROP CONSTRAINT "RaffleSeed_raffleId_fkey";

-- DropTable
DROP TABLE "RaffleSeed";

-- AlterTable
ALTER TABLE "Raffle" DROP COLUMN "seedCommitment";

-- AlterTable
ALTER TABLE "Draw" DROP COLUMN "seedCommitment",
DROP COLUMN "serverSeed",
DROP COLUMN "ticketDigestInput";
