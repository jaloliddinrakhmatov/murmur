import Link from "next/link";
import type { ReactNode } from "react";
import {
  parseMarkdown,
  type Block,
  type Inline,
} from "../../lib/help-markdown.ts";

function renderInline(nodes: Inline[], onNavigate?: () => void): ReactNode[] {
  return nodes.map((node, i) => {
    switch (node.t) {
      case "text":
        return node.v;
      case "br":
        return <br key={i} />;
      case "code":
        return (
          <code key={i} className="help-code">
            {node.v}
          </code>
        );
      case "strong":
        return <strong key={i}>{renderInline(node.c, onNavigate)}</strong>;
      case "em":
        return <em key={i}>{renderInline(node.c, onNavigate)}</em>;
      case "link":
        return node.external ? (
          <a
            key={i}
            href={node.href}
            target="_blank"
            rel="noopener noreferrer"
            className="help-link"
          >
            {renderInline(node.c, onNavigate)}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        ) : (
          <Link
            key={i}
            href={node.href}
            onClick={onNavigate}
            className="help-link"
          >
            {renderInline(node.c, onNavigate)}
          </Link>
        );
    }
  });
}

function renderBlock(block: Block, i: number, onNavigate?: () => void) {
  switch (block.t) {
    case "p":
      return <p key={i}>{renderInline(block.c, onNavigate)}</p>;
    case "ul":
      return (
        <ul key={i}>
          {block.items.map((item, n) => (
            <li key={n}>{renderInline(item, onNavigate)}</li>
          ))}
        </ul>
      );
    case "ol":
      return (
        <ol key={i} start={block.start}>
          {block.items.map((item, n) => (
            <li key={n}>{renderInline(item, onNavigate)}</li>
          ))}
        </ol>
      );
    case "pre":
      return (
        <pre key={i} tabIndex={0} className="help-pre">
          <code>{block.v}</code>
        </pre>
      );
  }
}

/** An answer as React elements. Text is never parsed as HTML; links are checked in the parser. */
export function HelpMarkdown({
  text,
  onNavigate,
}: {
  text: string;
  onNavigate?: () => void;
}) {
  return (
    <div className="help-md">
      {parseMarkdown(text).map((block, i) => renderBlock(block, i, onNavigate))}
    </div>
  );
}
