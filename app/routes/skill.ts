import skill from "../../skills/punchlist/SKILL.md?raw";

/** What /settings/agents' setup command downloads. Deployment-neutral, so it needs no sign-in. */
export function loader() {
  return new Response(skill, { headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "public, max-age=300" } });
}
