import type { MetadataRoute } from "next";

// No sitemap yet: sitemap entries must be absolute URLs, and there is no domain (see README).
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", allow: "/", disallow: ["/r/", "/join/"] } };
}
