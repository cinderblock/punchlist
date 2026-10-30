import { handleMcp } from "../../src/mcp.ts";
import type { Route } from "./+types/mcp";

export const loader = ({ request }: Route.LoaderArgs) => handleMcp(request);
export const action = ({ request }: Route.ActionArgs) => handleMcp(request);
