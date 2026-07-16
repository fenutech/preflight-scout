import { SITE_URL } from "@/lib/site";

export const dynamic = "force-static";

export default function sitemap() {
  return ["/", "/install/", "/example-report/", "/security/"].map((path) => ({
    url: `${SITE_URL}${path}`
  }));
}
