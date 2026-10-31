/**
 * What must never reach a report. Run in the browser before sending and again on the
 * server, which is the one that counts. Dependency-free for that reason.
 *
 * A path can be a capability (/join/<token>, /feeds/<token>), and a query string is
 * what someone searched for. An error's text can quote either, or a token.
 */

const REDACTED = "[redacted]";
const URL_TAIL = /((?:https?:\/\/[^\s?#"'`)]+|\/[\w./-]*))[?#][^\s"'`)]*/g;
const CAPABILITY_PATH = /\/(join|feeds)\/[^\s/?#"'`)]+/g;
const BEARER = /\bBearer\s+\S+/gi;
const AGENT_TOKEN = /\bpl_[A-Za-z0-9_-]{8,}/g;
const LONG_RUN = /[A-Za-z0-9_-]{32,}/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Long and mixing letters with digits: a secret. A long kebab-case file name isn't, and a task id is fine. */
function looksSecret(run: string): boolean {
  return !UUID.test(run) && /\d/.test(run) && /[A-Za-z]/.test(run);
}

export function redactText(text: string): string {
  return text
    .replace(URL_TAIL, "$1")
    .replace(CAPABILITY_PATH, `/$1/${REDACTED}`)
    .replace(BEARER, `Bearer ${REDACTED}`)
    .replace(AGENT_TOKEN, REDACTED)
    .replace(LONG_RUN, (run) => (looksSecret(run) ? REDACTED : run));
}

/** A path to keep: no query, no fragment, no capability, and the page rather than its data request. */
export function redactPath(path: string): string {
  const bare = path.split(/[?#]/, 1)[0]!.replace(/\.data$/, "").replace(/^\/_root$/, "/");
  return redactText(bare);
}
