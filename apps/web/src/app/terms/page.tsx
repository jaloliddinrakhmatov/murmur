import type { Metadata } from "next";
import { LegalDocument } from "../../components/legal.tsx";
import { TERMS_DOC } from "../../content/terms.ts";

export const metadata: Metadata = {
  title: "Terms of service",
  description:
    "Draft Terms of service for Murmur, written from what the app and server actually do. Not yet reviewed by a lawyer.",
};

export default function Page() {
  return <LegalDocument doc={TERMS_DOC} />;
}
