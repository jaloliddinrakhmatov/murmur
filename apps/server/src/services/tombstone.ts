import { hashSecret } from "../common/crypto.ts";
import { canonicalEmail } from "../domain/email.ts";
import type { PrismaService } from "../prisma/prisma.service.ts";
import type { Prisma } from "../prisma/prisma.service.ts";

type Db = PrismaService | Prisma.TransactionClient;
export type TombstoneField = "referredAt" | "trialClaimedAt" | "rewardPaidAt";

/** Peppered hash of the normalized address: the row survives account deletion without the address. */
export function addressHash(pepper: string, email: string): string {
  return hashSecret(pepper, "address", canonicalEmail(email));
}

/**
 * Marks that this address has used `field`. Returns true only for the caller that set it first;
 * atomic, so two accounts for the same person racing each other can't both claim.
 */
export async function claimTombstone(
  db: Db,
  pepper: string,
  email: string,
  field: TombstoneField,
  at: Date,
): Promise<boolean> {
  const emailHash = addressHash(pepper, email);
  await db.emailTombstone.upsert({
    where: { emailHash },
    create: { emailHash },
    update: {},
  });
  const done = await db.emailTombstone.updateMany({
    where: { emailHash, [field]: null },
    data: { [field]: at },
  });
  return done.count === 1;
}

export async function hasTombstone(
  db: Db,
  pepper: string,
  email: string,
  field: TombstoneField,
): Promise<boolean> {
  const row = await db.emailTombstone.findUnique({
    where: { emailHash: addressHash(pepper, email) },
  });
  return !!row?.[field];
}
