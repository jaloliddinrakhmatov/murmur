import type { Metadata } from "next";
import { LegalDocument } from "../../components/legal.tsx";
import { PRIVACY_DOC } from "../../content/privacy.ts";

export const metadata: Metadata = {
  title: "Privacy policy",
  description:
    "Draft Privacy policy for Murmur, written from what the app and server actually do. Not yet reviewed by a lawyer.",
};

export default function Page() {
  return <LegalDocument doc={PRIVACY_DOC} />;
}
