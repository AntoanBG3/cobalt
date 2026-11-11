# Win98-style downloader page for a cobalt API. Build context: repo root.
FROM node:24-alpine AS css
WORKDIR /css
RUN npm install --no-audit --no-fund 98.css@0.1.21

FROM nginx:1.29-alpine
COPY --from=css /css/node_modules/98.css/dist/98.css /css/node_modules/98.css/dist/ms_sans_serif*.woff* /usr/share/nginx/html/
COPY wizard/page/ /usr/share/nginx/html/
COPY wizard/nginx.conf.template /etc/nginx/wizard.conf.template
COPY --chmod=755 wizard/40-wizard-config.sh /docker-entrypoint.d/40-wizard-config.sh
RUN chown -R nginx:nginx /usr/share/nginx/html /etc/nginx/conf.d
