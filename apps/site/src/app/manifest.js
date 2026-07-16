export const dynamic = "force-static";

export default function manifest() {
  return {
    name: "Preflight Scout",
    short_name: "Preflight Scout",
    description: "Release QA for coding agents, reviewed by humans.",
    start_url: "/",
    display: "standalone",
    background_color: "#02090c",
    theme_color: "#c7ea43",
    icons: [{ src: "/brand/preflight-scout-mark.png", sizes: "256x256", type: "image/png" }]
  };
}
