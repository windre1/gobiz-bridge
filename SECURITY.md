# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately to the maintainer through
GitHub (Security → Report a vulnerability on this repository) instead of
opening a public issue. Include the affected component and a minimal
reproduction. **Never include real credentials, session tokens, QRIS
payloads, or live transaction data in a report.**

## Operator responsibilities

- Keep `GOBIZ_*`, merchant API trios, and QRIS payloads in the Cloudflare
  secrets store / D1 only — never in source control. `wrangler.toml` and
  `.env` are git-ignored by design.
- Rotate a merchant's trio immediately if it leaks; enrolment tooling can
  issue a fresh trio per merchant.
- The bridge's callback is HMAC-signed; always verify the signature and the
  paid amount on the receiving side before fulfilling an order.
