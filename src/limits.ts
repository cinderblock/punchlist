/**
 * Input limits shared by the server's validation and the browser's form fields.
 * Must stay dependency-free: page components import it, and anything it
 * imported would be shipped to the browser.
 */
export const NAME_MAX_LENGTH = 80;
export const NICKNAME_MAX_LENGTH = 60;
export const TITLE_MAX_LENGTH = 200;
export const DETAILS_MAX_LENGTH = 10_000;
export const COMMENT_MAX_LENGTH = 4_000;
export const LOCATION_NOTE_MAX_LENGTH = 200;
export const LABEL_MAX_LENGTH = 40;
export const DEDUPE_KEY_MAX_LENGTH = 200;
export const AGENT_NAME_MAX_LENGTH = 60;
export const FEED_NAME_MAX_LENGTH = 60;
export const DEVICE_NAME_MAX_LENGTH = 40;
/** Per attachment. Cloudflare's 100 MB ceiling is far enough away that resumable uploads aren't worth having. */
export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
export const ATTACHMENTS_MAX_PER_TASK = 50;
export const TASK_LIST_DEFAULT_LIMIT = 200;
export const TASK_LIST_MAX_LIMIT = 500;
export const RECURRENCE_MAX_INTERVAL_DAYS = 3660;
export const FEEDBACK_MAX_LENGTH = 4_000;
/** Per screenshot, before it's shrunk. A phone's own screenshot is a fraction of this. */
export const FEEDBACK_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const FEEDBACK_IMAGES_MAX = 3;
