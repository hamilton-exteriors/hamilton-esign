# Hamilton e-Sign — DocuSeal (AGPL-3.0) with Hamilton-branded signer views.
# Only the signer-facing surface is modified; the admin UI is upstream.
# PINNED, deliberately. Every CSS selector and ERB override in brand/ is written
# against this specific build's markup — the field-marker recolor targets
# page-container, the stepper targets nav[aria-label='Form progress'], the
# completion attribution targets a docuseal.com anchor. Upstream shipped 3.1.6 on
# 2026-07-27; on :latest the next deploy would silently pull it and any markup
# change would break the branding with no error anywhere. Bump this on purpose,
# then re-verify the signer page, never by accident.
FROM docuseal/docuseal:3.1.5

COPY brand/hamilton.css            /app/app/assets/hamilton.css
COPY brand/form.html.erb           /app/app/views/layouts/form.html.erb
COPY brand/_logo.html.erb          /app/app/views/shared/_logo.html.erb
COPY brand/_powered_by.html.erb    /app/app/views/shared/_powered_by.html.erb
# Logo lockup: mark only. Upstream renders the mark AND the product name as
# text, printing the same words twice. There are TWO such partials — the signing
# view and the start view — and the start one hardcodes <h1>DocuSeal</h1>, so
# overriding only submit_form leaves the name on screen.
COPY brand/_docuseal_logo.html.erb    /app/app/views/submit_form/_docuseal_logo.html.erb
COPY brand/_start_form_logo.html.erb  /app/app/views/start_form/_docuseal_logo.html.erb

# Self-hosted fonts. The upstream CSP (style-src 'self' 'unsafe-inline') blocks
# fonts.googleapis.com, so an external font stylesheet never loads at all.
COPY brand/fonts/                  /app/public/fonts/

# Browser tab: title, meta and favicons.
COPY brand/_head_tags.html.erb     /app/app/views/layouts/_head_tags.html.erb
COPY brand/_meta.html.erb          /app/app/views/shared/_meta.html.erb
# /favicon.ico is the path browsers request by DEFAULT (no <link> needed) and
# cache hardest, so leaving it upstream means the DocuSeal mark keeps showing.
COPY brand/icons/favicon.ico       /app/public/favicon.ico
COPY brand/icons/favicon.svg       /app/public/favicon.svg
COPY brand/icons/favicon-16.png    /app/public/favicon-16x16.png
COPY brand/icons/favicon-32.png    /app/public/favicon-32x32.png
COPY brand/icons/favicon-96.png    /app/public/favicon-96x96.png
COPY brand/icons/favicon-180.png   /app/public/apple-icon-180x180.png
COPY brand/icons/favicon-180.png   /app/public/apple-touch-icon.png
COPY brand/icons/favicon-180.png   /app/public/apple-touch-icon-precomposed.png

# Product name is a Ruby constant upstream, not an env var.
RUN sed -i "s/PRODUCT_NAME = 'DocuSeal'/PRODUCT_NAME = 'Hamilton Exteriors'/" /app/lib/docuseal.rb \
 && grep -q "Hamilton Exteriors" /app/lib/docuseal.rb

# Each view hardcodes its own tab title as "<doc> | DocuSeal" via content_for,
# so the layout fallback never fires. Rewrite the suffix at the source.
RUN find /app/app/views -name '*.erb' -exec sed -i 's/ | DocuSeal"/ | Hamilton Signing"/g' {} + \
 && ! grep -rq '| DocuSeal"' /app/app/views
