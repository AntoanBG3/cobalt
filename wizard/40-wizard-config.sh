#!/bin/sh
# Writes the page's runtime config from the container environment.
set -eu
: "${API_URL:?API_URL must be set, e.g. https://dl-api.example.com/}"
API_ORIGIN=$(printf '%s' "$API_URL" | sed -E 's#^(https?://[^/]+).*#\1#')
export API_ORIGIN
printf 'window.WIZARD_CONFIG = { apiUrl: "%s" };\n' "$API_ORIGIN" > /usr/share/nginx/html/config.js
envsubst '${API_ORIGIN}' < /etc/nginx/wizard.conf.template > /etc/nginx/conf.d/default.conf
