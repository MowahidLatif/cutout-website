/**
 * The site's public address. The site and the API share one origin, so this
 * one setting is used for every link we hand out: status links and image
 * links in emails, and Stripe's return URLs.
 *
 * SITE_URL is the setting; PUBLIC_API_URL (its old name) still works.
 */
function siteUrl() {
  return (process.env.SITE_URL || process.env.PUBLIC_API_URL || "http://localhost:4000").replace(/\/+$/, "");
}

module.exports = { siteUrl };
