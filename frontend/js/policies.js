/**
 * policies.html: fills in the contact email and policy numbers from
 * js/site-config.js. (A file, not an inline <script>, so the
 * Content-Security-Policy can forbid inline scripts.)
 */
(function () {
  // Contact details and policy numbers come from js/site-config.js.
  document.querySelectorAll("[data-support-email]").forEach((a) => {
    a.textContent = SITE.supportEmail;
    a.href = "mailto:" + SITE.supportEmail;
  });
  document.querySelectorAll("[data-damage-days]").forEach((el) => (el.textContent = SITE.damageClaimDays));
  document.querySelectorAll("[data-policy-version]").forEach((el) => (el.textContent = SITE.policyVersion));
})();
