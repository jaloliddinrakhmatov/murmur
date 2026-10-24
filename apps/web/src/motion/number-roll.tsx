"use client";

const CELL = "1.1em";

function Digit({ value }: { value: number }) {
  return (
    <span
      className="inline-block overflow-hidden align-bottom"
      style={{ height: CELL, lineHeight: CELL }}
    >
      <span
        className="flex flex-col text-center [font-variant-numeric:tabular-nums] motion-safe:transition-transform motion-safe:duration-[700ms] motion-safe:ease-[cubic-bezier(0.2,0.8,0.2,1)]"
        style={{ transform: `translateY(calc(${CELL} * -${value}))` }}
      >
        {Array.from({ length: 10 }, (_, d) => (
          <span key={d} style={{ height: CELL }}>
            {d}
          </span>
        ))}
      </span>
    </span>
  );
}

/**
 * NumberRoll: shows a price like "$12" and, when a digit changes, rolls it like an odometer.
 * Screen readers get the plain text; the rolling digits are decorative. Without motion the
 * digits simply switch.
 */
export function NumberRoll({
  value,
  className,
}: {
  value: string;
  className?: string;
}) {
  const chars = Array.from(value);
  return (
    <span className={className}>
      <span className="sr-only">{value}</span>
      <span aria-hidden="true" className="inline-flex">
        {chars.map((c, i) => {
          const fromEnd = chars.length - i;
          return /\d/.test(c) ? (
            <Digit key={`d${fromEnd}`} value={Number(c)} />
          ) : (
            <span key={`c${fromEnd}`}>{c}</span>
          );
        })}
      </span>
    </span>
  );
}
