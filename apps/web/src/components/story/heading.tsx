import { Title } from "./title.tsx";

export function Heading({
  eyebrow,
  children,
  sub,
  id,
  tone = "light",
  align = "center",
}: {
  eyebrow: string;
  children: React.ReactNode;
  sub?: string;
  id?: string;
  tone?: "light" | "night";
  align?: "center" | "left";
}) {
  const night = tone === "night";
  return (
    <div
      className={`max-w-2xl ${align === "center" ? "mx-auto text-center" : ""}`}
    >
      <p className={`eyebrow ${night ? "eyebrow-night" : ""}`} data-rv>
        {eyebrow}
      </p>
      <Title
        id={id}
        className={`mt-3 text-4xl sm:text-5xl ${night ? "title-night" : ""}`}
      >
        {children}
      </Title>
      {sub && (
        <p
          className={`mt-5 text-lg leading-relaxed ${night ? "text-night-muted" : "text-muted"}`}
          data-rv
        >
          {sub}
        </p>
      )}
    </div>
  );
}
