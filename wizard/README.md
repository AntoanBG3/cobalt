# wizard

Home-server additions on top of [imputnet/cobalt](https://github.com/imputnet/cobalt).
This branch (`wizard`) is not meant to be merged upstream.

## What's here

- `patches/` — fixes applied on top of upstream `main` when the API image is built.
  A patch that upstream has already merged is skipped automatically; one that no
  longer applies fails the build so it can be updated or dropped.
  Run `bash wizard/apply-patches.sh /path/to/upstream` to reproduce the build step.
  The diffs in `upstream-backports/` let the script recognize upstream changes
  already carried by the full patch stack.
- `page/` — a small Win98-style page that talks to a cobalt API (Turnstile sessions,
  tunnels, pickers). Styled with [98.css](https://github.com/jdan/98.css) (MIT).
  It replaces the stock cobalt web app, so no cobalt branding is used.
- `page.Dockerfile`, `nginx.conf.template`, `40-wizard-config.sh` — the page image.
  Set `API_URL` at runtime; it is written into `config.js` and the CSP on start.

## Download changes carried by wizard

| Upstream PR | What this fork carries |
|---|---|
| [#1611](https://github.com/imputnet/cobalt/pull/1611) | Fix rewritten HLS response headers and let downloads proceed if the optional size probe fails. |
| [#1608](https://github.com/imputnet/cobalt/pull/1608) | Download AAC-only SoundCloud tracks and stream M4A files. |
| [#1581](https://github.com/imputnet/cobalt/pull/1581) | Report empty media tunnels as errors and add the optional VISIONOS client. The default YouTube client is unchanged. Test on the deployment network before setting `CUSTOM_INNERTUBE_CLIENT=VISIONOS`. |
| [#1610](https://github.com/imputnet/cobalt/pull/1610) | Support Facebook photo links and Tumblr carousels. The page asks for Tumblr items as download attachments. |
| [#1590](https://github.com/imputnet/cobalt/pull/1590) | Download existing YouTube captions as TXT or SRT. Select **YouTube transcript** on the page. API clients can send `downloadMode: "captions"`, `captionFormat` (`txt` or `srt`), and an optional `captionLanguage`. |
| [#1533](https://github.com/imputnet/cobalt/pull/1533) | Ignore a missing (`null`) Facebook HD or SD link instead of matching another video's link further down the page. |
| [#1546](https://github.com/imputnet/cobalt/pull/1546) | Download Bluesky videos that have no audio track (the ffmpeg audio map is optional). The playlist header part is already in 0002. |
| [#1558](https://github.com/imputnet/cobalt/pull/1558) | Support Threads posts (`threads.com` and `threads.net`): videos, photos, GIFs and carousels. |

## Images

`.github/workflows/wizard.yml` builds on every push to `wizard/**`, weekly on Monday,
and on demand:

| image | contents |
|---|---|
| `ghcr.io/antoanbg3/cobalt-api:wizard` | upstream `main` + `patches/` |
| `ghcr.io/antoanbg3/cobalt-page:wizard` | `page/` on nginx |

The workflow tests both images before publishing either. Releases have a versioned
tag (`<version>-<upstream sha>-<fork sha>` for the API, the commit SHA for the page)
as well as the moving `wizard` tag. Both images include an HTTP health check.

For a rollback, set the two Compose image tags to the last working pair from an
earlier workflow run, then run `docker compose pull && docker compose up -d`
in the stack directory.

To test a local API image after applying `patches/`, run the fixture and caption
tests from the fork root. They don't contact media providers:

```sh
docker run --rm --platform linux/amd64 --network none \
  -e API_URL=http://127.0.0.1:9900/ -e API_PORT=9900 \
  -v "$PWD/wizard/tests/api.test.mjs:/app/fixture.test.mjs:ro" \
  cobalt-wizard-review-api:local \
  sh -c 'node --test --test-force-exit fixture.test.mjs src/processing/helpers/tests/captions.test.js test/*.test.js'
```

The page smoke tests serve local API fixtures and mock Turnstile. To run them
against a local page image, start it with
`docker run --rm -p 127.0.0.1:9910:80 -e API_URL=http://127.0.0.1:9911 <page-image>`.
With Playwright and Chromium installed, run `node --test wizard/tests/page.test.cjs`
from the fork root. If Playwright is installed outside the fork, set `NODE_PATH`
to its `node_modules` directory. Set `WIZARD_WEBKIT=1` to use WebKit.

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
