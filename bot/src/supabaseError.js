/**
 * A one-line version of a Supabase error message. When Supabase can't be
 * reached, Cloudflare answers with a whole HTML error page and supabase-js
 * puts all of it in error.message; keep just the page title instead.
 */
export function supabaseMessage(error) {
  const msg = String(error?.message ?? error ?? "");
  if (!/<html|<!doctype/i.test(msg)) return msg.length > 300 ? `${msg.slice(0, 300)}...` : msg;
  const title = msg.match(/<title>([^<]*)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim();
  return title ? `HTML error page: ${title}` : "HTML error page (Supabase unreachable)";
}

/**
 * SUPABASE_URL as supabase-js wants it: the project URL alone
 * (https://<ref>.supabase.co). The dashboard also shows the REST endpoint,
 * .../rest/v1/, and a pasted path makes every request fail with "Invalid
 * path specified in request URL", so only the origin is kept.
 */
export function supabaseUrl(url = process.env.SUPABASE_URL) {
  if (!url) return url;
  try {
    return new URL(url.trim()).origin;
  } catch {
    throw new Error(`SUPABASE_URL isn't a URL: use the Project URL from Supabase's settings, like https://<project-ref>.supabase.co`);
  }
}
