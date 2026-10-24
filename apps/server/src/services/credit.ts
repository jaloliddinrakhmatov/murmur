import { grantCredit } from "../domain/plan-state.ts";
import type { Prisma } from "../prisma/prisma.service.ts";

/** Locks the user's row for the rest of the transaction so credit changes can't interleave. */
export async function lockUser(tx: Prisma.TransactionClient, userId: string) {
  await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
}

/** Adds months of Pro credit to a user (inside a transaction). */
export async function addCreditMonths(
  tx: Prisma.TransactionClient,
  userId: string,
  months: number,
  now: Date,
) {
  await lockUser(tx, userId);
  const user = await tx.user.findUnique({
    where: { id: userId },
    select: { creditMonths: true, creditAnchor: true },
  });
  if (!user) return;
  const next = grantCredit(
    { months: user.creditMonths, anchor: user.creditAnchor },
    months,
    now,
  );
  await tx.user.update({
    where: { id: userId },
    data: { creditMonths: next.months, creditAnchor: next.anchor },
  });
}
