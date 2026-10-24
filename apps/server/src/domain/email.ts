/**
 * The address a person is counted under for anti-abuse (one referral, one trial, one reward):
 * lower-case, no "+tag", and no dots in Gmail addresses (googlemail.com is gmail.com).
 * Never used to send mail or sign in; those keep the address as typed.
 */
export function canonicalEmail(email: string): string {
  const [rawLocal = "", rawDomain = ""] = email.trim().toLowerCase().split("@");
  let domain = rawDomain;
  let local = rawLocal.split("+")[0] ?? "";
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") local = local.replaceAll(".", "");
  return `${local}@${domain}`;
}
