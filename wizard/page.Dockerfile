# Win98-style downloader page for a cobalt API. Build context: repo root.
FROM node:24-alpine AS assets
WORKDIR /css
RUN npm install --no-audit --no-fund 98.css@0.1.21
COPY wizard/page/ /page/
RUN cd /page && \
    app=$(sha256sum app.js | cut -c1-12) && \
    style=$(sha256sum style.css | cut -c1-12) && \
    mv app.js "app.${app}.js" && mv style.css "style.${style}.css" && \
    sed -i "s/app\.js/app.${app}.js/; s/style\.css/style.${style}.css/" index.html

FROM nginx:1.29-alpine
COPY --from=assets /css/node_modules/98.css/dist/98.css /css/node_modules/98.css/dist/ms_sans_serif*.woff* /usr/share/nginx/html/
COPY --from=assets /page/ /usr/share/nginx/html/
COPY wizard/nginx.conf.template /etc/nginx/wizard.conf.template
COPY --chmod=755 wizard/40-wizard-config.sh /docker-entrypoint.d/40-wizard-config.sh
RUN chown -R nginx:nginx /usr/share/nginx/html /etc/nginx/conf.d
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD wget -q -O /dev/null http://127.0.0.1/config.js || exit 1
