# wizard

Home-server additions on top of [imputnet/cobalt](https://github.com/imputnet/cobalt).
This branch (`wizard`) is not meant to be merged upstream.

## What's here

- `patches/` — fixes applied on top of upstream `main` when the API image is built.
  A patch that upstream has already merged is skipped automatically; one that no
  longer applies fails the build so it can be updated or dropped.
- `page/` — a small Win98-style page that talks to a cobalt API (Turnstile sessions,
  tunnels, pickers). Styled with [98.css](https://github.com/jdan/98.css) (MIT).
  It replaces the stock cobalt web app, so no cobalt branding is used.
- `page.Dockerfile`, `nginx.conf.template`, `40-wizard-config.sh` — the page image.
  Set `API_URL` at runtime; it is written into `config.js` and the CSP on start.

## Images

`.github/workflows/wizard.yml` builds on every push to `wizard/**`, weekly on Monday,
and on demand:

| image | contents |
|---|---|
| `ghcr.io/antoanbg3/cobalt-api:wizard` | upstream `main` + `patches/` |
| `ghcr.io/antoanbg3/cobalt-page:wizard` | `page/` on nginx |

Each build is also tagged with an immutable tag (`<version>-<upstream sha>-<fork sha>`
for the API, the commit sha for the page) for rollbacks.

## Compose sketch

```yaml
services:
  cobalt-api:
    image: ghcr.io/antoanbg3/cobalt-api:wizard
    init: true
    read_only: true
    environment:
      API_URL: https://dl-api.example.com/
      CORS_WILDCARD: "0"
      CORS_URL: https://dl.example.com
      TURNSTILE_SITEKEY: ${TURNSTILE_SITEKEY}
      TURNSTILE_SECRET: ${TURNSTILE_SECRET}
      JWT_SECRET: ${JWT_SECRET}
  cobalt-page:
    image: ghcr.io/antoanbg3/cobalt-page:wizard
    environment:
      API_URL: https://dl-api.example.com/
```

## License

cobalt's API is AGPL-3.0; changes to it live in `patches/` in this public repo.
