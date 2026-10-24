// Shared sample definitions (kept separate so importing them has no side effects).
export interface Sample {
  id: string;
  set: string;
  language: "en" | "uz" | "mixed";
  path: string;
  reference: string;
  durationSec: number;
  synthetic: boolean;
  /** Written forms that must appear verbatim (technical vocabulary recall). */
  terms?: string[];
}

export const TECH_VOCABULARY = [
  "useEffect",
  "UserProfile.tsx",
  "fetchUserById",
  "kubectl",
  "nginx",
  "PostgreSQL",
  "created_at",
  "Dilnoza",
  "Jaloliddin",
  "OAuth",
  "Prisma",
  "napi-rs",
  "CGEventTap",
  "Electron",
  "Tailwind",
  "shadcn/ui",
  "NestJS",
  "JWT",
  "Grafana",
  "Redis",
];
